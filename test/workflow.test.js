// End-to-end workflow test against a running Worker (npm run dev).
//   BASE_URL=http://127.0.0.1:8787 BOOTSTRAP_KEY=local-setup-key npm test
// Uses a FRESH local database: run `rm -rf .wrangler/state` before `npm run dev`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const KEY = process.env.BOOTSTRAP_KEY || 'local-setup-key';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
}

async function signIn(username, password, newPassword) {
  const c = new Client();
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.data)}`);
  if (newPassword) {
    const blocked = await c.get('/api/state');
    assert.equal(blocked.status, 403, 'temp-password user is blocked until they change it');
    const cp = await c.post('/api/change-password', { current: password, next: newPassword });
    assert.equal(cp.status, 200, JSON.stringify(cp.data));
  }
  return c;
}

const today = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
const entry = (o) => ({ type: 'expense', date: today, category: 'Office supplies', account: 'Main Bank Account', ...o });

test('ALIDADA ledger: roles, limits, maker-checker workflow', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/state')).status, 401);
  assert.equal((await anon.get('/')).status, 302, 'app shell requires a session');

  // ---- Setup -------------------------------------------------------------
  assert.equal((await anon.post('/api/setup', { bootstrapKey: 'wrong', username: 'admin', fullName: 'System Admin', password: 'Admin12345' })).status, 403);
  const admin = new Client();
  let r = await admin.post('/api/setup', { bootstrapKey: KEY, username: 'admin', fullName: 'System Admin', password: 'Admin12345' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await anon.post('/api/setup', { bootstrapKey: KEY, username: 'x2', fullName: 'X', password: 'Admin12345' })).status, 409, 'setup only once');

  // ---- Admin creates people; has no financial authority -----------------------
  const mk = async (username, fullName, role) => {
    const res = await admin.post('/api/users', { username, fullName, role, password: 'Temp12345' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.user;
  };
  const su1 = await mk('super1', 'Super One', 'superuser');
  const su2 = await mk('super2', 'Super Two', 'superuser');
  const u1 = await mk('user1', 'User One', 'user');
  const u2 = await mk('user2', 'User Two', 'user');
  assert.equal((await admin.post('/api/users', { username: 'a2', fullName: 'A2', role: 'admin', password: 'Temp12345' })).status, 400, 'admin cannot create another admin');
  assert.equal((await admin.post('/api/transactions', entry({ amount: 1, description: 'x' }))).status, 403, 'admin has no financial authority');
  assert.equal((await admin.put(`/api/users/${u1.id}/limit`, { limit: 100 })).status, 403, 'admin cannot assign limits');
  assert.equal((await admin.get('/api/state')).status, 403);

  const S1 = await signIn('super1', 'Temp12345', 'Super1pass');
  const S2 = await signIn('super2', 'Temp12345', 'Super2pass');
  const U1 = await signIn('user1', 'Temp12345', 'User1pass');
  const U2 = await signIn('user2', 'Temp12345', 'User2pass');

  // ---- Only Super Users assign limits, never their own ---------------------------
  assert.equal((await U1.put(`/api/users/${u2.id}/limit`, { limit: 5 })).status, 403, 'users cannot assign limits');
  assert.equal((await S1.put(`/api/users/${su1.id}/limit`, { limit: 5 })).status, 403, 'no self-assignment');
  for (const [c, id, limit] of [[S1, su2.id, 1000000], [S2, su1.id, 500000], [S1, u1.id, 10000], [S1, u2.id, 50000]]) {
    r = await c.put(`/api/users/${id}/limit`, { limit, note: 'test' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const u1msgs = (await U1.get('/api/notifications')).data.notifications;
  assert.ok(u1msgs.some((n) => n.kind === 'limit_changed'), 'user is told about their new limit');

  // ---- Within limit → posted immediately --------------------------------------------
  r = await U1.post('/api/transactions', entry({ type: 'receive', amount: 8000, description: 'Cash sale', category: 'Sales' }));
  assert.equal(r.data.outcome, 'posted');
  assert.equal(r.data.transaction.status, 'posted');
  assert.match(r.data.transaction.voucherNo, /^ALD-\d{6}$/);

  // ---- Beyond limit → routed to lowest sufficient approver → approve → initiator posts --------
  r = await U1.get('/api/approvers?amount=30000');
  assert.equal(r.data.withinLimit, false);
  assert.deepEqual(r.data.approvers.map((a) => a.username), ['user2', 'super1', 'super2']);
  r = await U1.post('/api/transactions', entry({ amount: 30000, description: 'Laptop purchase' }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'submitted');
  const big = r.data.transaction;
  assert.equal(big.status, 'pending_approval');
  assert.equal(big.approverId, u2.id);
  let me2 = (await U2.get('/api/me')).data;
  assert.equal(me2.toApprove, 1);
  const n2 = (await U2.get('/api/notifications')).data.notifications.find((n) => n.transactionId === big.id);
  assert.equal(n2.kind, 'approval_request');
  assert.equal(n2.actionable, true);

  assert.equal((await U1.post(`/api/transactions/${big.id}/approve`)).status, 403, 'cannot approve own');
  assert.equal((await S1.post(`/api/transactions/${big.id}/approve`)).status, 403, 'only the assigned approver');
  assert.equal((await U1.post(`/api/transactions/${big.id}/post`)).status, 409, 'cannot post before approval');
  r = await U2.post(`/api/transactions/${big.id}/approve`, { remark: 'OK as per quotation' });
  assert.equal(r.data.transaction.status, 'approved');
  me2 = (await U2.get('/api/me')).data;
  assert.equal(me2.toApprove, 0, 'approver message resolved');
  const me1 = (await U1.get('/api/me')).data;
  assert.equal(me1.toPost, 1);
  const n1 = (await U1.get('/api/notifications')).data.notifications.find((n) => n.transactionId === big.id);
  assert.equal(n1.kind, 'ready_to_post');
  assert.equal((await U2.post(`/api/transactions/${big.id}/post`)).status, 403, 'only the initiator posts');
  r = await U1.post(`/api/transactions/${big.id}/post`);
  assert.equal(r.data.transaction.status, 'posted');
  const ev = (await U1.get(`/api/transactions/${big.id}/events`)).data.events.map((e) => e.action);
  assert.deepEqual(ev, ['initiated', 'submitted', 'approved', 'posted']);

  // ---- Reject path ------------------------------------------------------------------------
  r = await U1.post('/api/transactions', entry({ amount: 40000, description: 'Furniture' }));
  const rej = r.data.transaction;
  assert.equal((await U2.post(`/api/transactions/${rej.id}/reject`, {})).status, 400, 'reason required');
  r = await U2.post(`/api/transactions/${rej.id}/reject`, { remark: 'Not budgeted' });
  assert.equal(r.data.transaction.status, 'rejected');
  assert.ok((await U1.get('/api/notifications')).data.notifications.some((n) => n.kind === 'rejected' && n.transactionId === rej.id));

  // ---- Approver chosen by initiator; approver limit enforced ----------------------------------
  r = await U1.post('/api/transactions', entry({ amount: 200000, description: 'Generator', approverId: u2.id }));
  assert.equal(r.status, 400, 'u2 limit 50k cannot approve 200k');
  r = await U1.post('/api/transactions', entry({ amount: 200000, description: 'Generator', approverId: su2.id }));
  assert.equal(r.data.transaction.approverId, su2.id);
  const gen = r.data.transaction;

  // ---- Duplicate caution ----------------------------------------------------------------------
  r = await U1.post('/api/transactions', entry({ type: 'receive', amount: 8000, description: 'Cash sale', category: 'Sales' }));
  assert.equal(r.status, 409);
  assert.equal(r.data.reason, 'duplicate');
  r = await U1.post('/api/transactions', entry({ type: 'receive', amount: 8000, description: 'Cash sale', category: 'Sales', force: true }));
  assert.equal(r.data.outcome, 'posted');

  // ---- No approver with enough authority ------------------------------------------------------
  r = await S2.post('/api/transactions', entry({ amount: 2000000, description: 'Land' }));
  assert.equal(r.data.reason, 'no_approver');

  // ---- Petty Cash never goes negative ------------------------------------------------------------
  r = await U1.post('/api/transactions', entry({ amount: 100, description: 'Tea', account: 'Petty Cash' }));
  assert.equal(r.data.reason, 'insufficient_petty_cash');
  r = await U1.post('/api/transactions', { type: 'transfer', date: today, amount: 1000, description: 'Fund petty cash', account: 'Main Bank Account', toAccount: 'Petty Cash' });
  assert.equal(r.data.outcome, 'posted');
  r = await U1.post('/api/transactions', entry({ amount: 100, description: 'Tea', account: 'Petty Cash' }));
  assert.equal(r.data.outcome, 'posted');
  let st = (await U1.get('/api/state')).data;
  assert.equal(st.pettyCash, 900);
  assert.equal(st.balances['Main Bank Account'], 8000 - 30000 + 8000 - 1000);

  // ---- Disabling an approver: sessions end, initiator asked to re-route ---------------------------
  r = await U1.post('/api/transactions', entry({ amount: 20000, description: 'Printer' }));
  const printer = r.data.transaction;
  assert.equal(printer.approverId, u2.id);
  r = await admin.patch(`/api/users/${u2.id}`, { active: false });
  assert.equal(r.status, 200);
  assert.equal((await U2.get('/api/me')).status, 401, 'disabled user is signed out');
  assert.ok((await U1.get('/api/notifications')).data.notifications.some((n) => n.kind === 'reroute_needed' && n.transactionId === printer.id));
  r = await U1.post(`/api/transactions/${printer.id}/reroute`, { approverId: su1.id });
  assert.equal(r.data.transaction.approverId, su1.id);
  r = await S1.post(`/api/transactions/${printer.id}/approve`);
  assert.equal(r.data.transaction.status, 'approved');
  r = await U1.post(`/api/transactions/${printer.id}/cancel`, { remark: 'Bought elsewhere' });
  assert.equal(r.data.transaction.status, 'cancelled');

  // ---- Visibility: users see posted + their own; super users see all ----------------------------
  st = (await U1.get('/api/state')).data;
  assert.ok(!st.transactions.some((t) => t.id === gen.id && t.initiatedBy !== u1.id));
  const s2state = (await S2.get('/api/state')).data;
  assert.ok(s2state.transactions.some((t) => t.id === gen.id));

  // ---- Reversal follows the same rules ----------------------------------------------------------
  r = await U1.post(`/api/transactions/${big.id}/reverse`, {});
  assert.equal(r.data.outcome, 'submitted', '30k reversal exceeds u1 limit');
  assert.equal(r.data.transaction.type, 'receive');
  assert.equal((await U1.post(`/api/transactions/${big.id}/reverse`, {})).status, 409, 'only one reversal');

  // ---- Backup / restore round trip (Super User only) -------------------------------------------------
  assert.equal((await U1.get('/api/backup')).status, 403);
  const bk = await S1.get('/api/backup');
  assert.equal(bk.status, 200);
  assert.ok(!('users' in bk.data.data), 'backup never contains users');
  const before = (await S1.get('/api/state')).data.transactions.length;
  r = await S1.post('/api/restore', { confirm: 'RESTORE LEDGER BOOK DATA', backup: bk.data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await S1.get('/api/state')).data.transactions.length, before);

  // ---- Audit trail ------------------------------------------------------------------------------
  const audit = (await admin.get('/api/audit')).data.entries.map((a) => a.action);
  for (const a of ['user.created', 'limit.changed', 'transaction.submitted', 'transaction.approved', 'transaction.rejected', 'transaction.posted']) {
    assert.ok(audit.includes(a), `audit has ${a}`);
  }
  assert.equal((await U1.get('/api/audit')).status, 403);
});
