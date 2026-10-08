// End-to-end workflow test against a running Worker (npm run dev).
//   BASE_URL=http://127.0.0.1:8787 BOOTSTRAP_KEY=local-setup-key npm test
// Uses a FRESH local database: run `rm -rf .wrangler/state` before `npm run dev`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
    const res = await admin.post('/api/users', { username, fullName, role, password: 'Temp12345', mobile: '017' + String(Math.floor(10000000 + Math.random() * 89999999)) });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.user;
  };
  const su1 = await mk('super1', 'Super One', 'superuser');
  const su2 = await mk('super2', 'Super Two', 'superuser');
  const u1 = await mk('user1', 'User One', 'user');
  const u2 = await mk('user2', 'User Two', 'user');
  assert.match(u1.mobile, /^\+8801\d{9}$/);
  assert.equal((await admin.post('/api/users', { username: 'a2', fullName: 'A2', role: 'admin', password: 'Temp12345', mobile: '01712345678' })).status, 400, 'admin cannot create another admin');
  // Mobile number is mandatory, validated and stored in international form.
  r = await admin.post('/api/users', { username: 'nomobile', fullName: 'No Mobile', role: 'user', password: 'Temp12345' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Mobile number is required/);
  r = await admin.post('/api/users', { username: 'badmobile', fullName: 'Bad Mobile', role: 'user', password: 'Temp12345', mobile: '12345' });
  assert.equal(r.status, 400);
  r = await admin.patch(`/api/users/${u1.id}`, { mobile: '01712-345678' });
  assert.equal(r.data.user.mobile, '+8801712345678');
  assert.equal((await admin.patch(`/api/users/${u1.id}`, { mobile: '' })).status, 400, 'mobile cannot be removed');
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
  // ---- Mid User: adds categories and tags, transacts, but cannot assign limits ----------------
  const mid = await mk('mid1', 'Mid One', 'miduser');
  assert.equal(mid.role, 'miduser');
  const M1 = await signIn('mid1', 'Temp12345', 'Mid1pass1');
  assert.equal((await M1.get('/api/me')).data.user.role, 'miduser');
  assert.equal((await M1.put(`/api/users/${u2.id}/limit`, { limit: 5 })).status, 403, 'Mid User cannot assign limits');
  assert.equal((await M1.get('/api/limit-history')).status, 403);
  r = await S1.put(`/api/users/${mid.id}/limit`, { limit: 20000 });
  assert.equal(r.data.user.financialLimit, 20000, 'Super User sets a Mid User limit');
  r = await M1.post('/api/categories', { name: 'Fuel' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.settings.categories.includes('Fuel'));
  assert.equal((await M1.post('/api/categories', { name: 'fuel' })).status, 409, 'no duplicate categories');
  assert.equal((await M1.put('/api/settings', { key: 'categories', value: ['Needs review'] })).status, 403, 'Mid User cannot remove categories');
  assert.equal((await M1.post('/api/tags', { name: 'Project-A' })).status, 200);
  assert.equal((await U1.post('/api/categories', { name: 'Gifts' })).status, 403, 'User cannot add categories');
  assert.equal((await U1.post('/api/tags', { name: 'Mine' })).status, 403, 'User cannot add tags');
  // A User may use an existing tag, but not invent one.
  r = await U1.post('/api/transactions', entry({ amount: 100, description: 'Diesel for generator', category: 'Fuel', tags: ['Project-A'] }));
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  r = await U1.post('/api/transactions', entry({ amount: 101, description: 'Courier', tags: ['Brand-new-tag'] }));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /does not exist/);
  // A Mid User may create a tag while entering a transaction.
  r = await M1.post('/api/transactions', entry({ amount: 900, description: 'Site visit taxi', tags: ['Site visit'] }));
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  assert.ok((await U1.get('/api/state')).data.tags.includes('Site visit'));
  // Mid Users appear as approvers with their own role.
  const appr = (await U1.get('/api/approvers?amount=15000')).data.approvers;
  assert.equal(appr.find((a) => a.id === mid.id)?.role, 'miduser');
  assert.equal((await admin.get('/api/users')).data.users.find((u) => u.id === mid.id).role, 'miduser');
  // Role changes both ways.
  assert.equal((await admin.patch(`/api/users/${mid.id}`, { role: 'user' })).data.user.role, 'user');
  assert.equal((await admin.patch(`/api/users/${mid.id}`, { role: 'miduser' })).data.user.role, 'miduser');

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
  assert.equal(st.balances['Main Bank Account'], 8000 - 30000 + 8000 - 1000 - 100 - 900); // incl. the Mid User section's two entries

  // ---- Disabling an approver: sessions end, initiator asked to re-route ---------------------------
  r = await U1.post('/api/transactions', entry({ amount: 20000, description: 'Printer', approverId: u2.id }));
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

  // ---- Phone browser notifications (Web Push) ----------------------------------------------------------
  const vapidPub = readFileSync('.dev.vars', 'utf8').match(/^VAPID_PUBLIC_KEY=(.+)$/m)[1].trim();
  const pushed = [];
  const mock = http.createServer((req, res) => {
    pushed.push({ path: req.url, auth: req.headers.authorization || '', ttl: req.headers.ttl });
    res.writeHead(req.url.includes('gone') ? 410 : 201).end();
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  const port = mock.address().port;
  try {
    const me = (await U1.get('/api/me')).data;
    assert.equal(me.pushKey, vapidPub, 'public key offered to the browser');
    assert.equal((await U1.post('/api/push/subscribe', { endpoint: 'ftp://example.com/x' })).status, 400, 'bad endpoint refused');
    r = await S1.post('/api/push/subscribe', { endpoint: `http://127.0.0.1:${port}/push/super1`, keys: { p256dh: 'x', auth: 'y' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await S1.post('/api/push/subscribe', { endpoint: `http://127.0.0.1:${port}/push/gone-device` });
    // user1 sends an entry over their limit to super1 → super1's device is woken.
    r = await U1.post('/api/transactions', entry({ amount: 15000, description: 'Push test laptop', approverId: su1.id }));
    assert.equal(r.data.transaction.approverId, su1.id);
    const pushTx = r.data.transaction;
    for (let i = 0; i < 40 && pushed.length < 2; i++) await new Promise((ok) => setTimeout(ok, 100));
    const hit = pushed.find((p) => p.path === '/push/super1');
    assert.ok(hit, 'push reached the approver device');
    assert.equal(hit.ttl, '86400');
    // VAPID: "vapid t=<jwt>, k=<public key>", JWT signed ES256 by our key for this push service.
    const m = hit.auth.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.ok(m, hit.auth);
    assert.equal(m[2], vapidPub);
    const [h, c, sig] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.aud, `http://127.0.0.1:${port}`);
    assert.ok(claims.exp > Date.now() / 1000);
    const raw = Buffer.from(vapidPub, 'base64url');
    const pubKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature valid');
    // The device then fetches the message text over its own session.
    const latest = (await S1.get('/api/notifications/latest')).data.notification;
    assert.match(latest.title, new RegExp(`Approval required: ${pushTx.voucherNo}`));
    // Expired device (410) is removed; the delivery is logged.
    await new Promise((ok) => setTimeout(ok, 300));
    const devices = (await S1.get('/api/push/devices')).data.devices;
    assert.equal(devices.length, 1, 'expired device removed');
    const log = (await admin.get('/api/push/log')).data.log;
    const entryLog = log.find((l) => l.title.includes(pushTx.voucherNo) && l.pushStatus === 'sent');
    assert.ok(entryLog, JSON.stringify(log.slice(0, 3)));
    // A person with no device: logged as "no_device", nothing breaks.
    await S1.post(`/api/transactions/${pushTx.id}/approve`);
    await new Promise((ok) => setTimeout(ok, 500));
    const log2 = (await admin.get('/api/push/log')).data.log;
    assert.ok(log2.some((l) => l.title.startsWith('Approved') && l.pushStatus === 'no_device'), JSON.stringify(log2.slice(0, 3)));
    await U1.post(`/api/transactions/${pushTx.id}/cancel`, { remark: 'push test done' });
    // Test button: the Admin may test anyone; a User only themselves.
    assert.equal((await admin.post('/api/push/test', { userId: su1.id })).data.result.status, 'sent');
    assert.equal((await U1.post('/api/push/test', { userId: su1.id })).status, 403);
    assert.equal((await U1.post('/api/push/test', {})).data.result.status, 'no_device');
    assert.equal((await U1.get('/api/push/log')).status, 403);
    await S1.post('/api/push/unsubscribe', { endpoint: `http://127.0.0.1:${port}/push/super1` });
    assert.equal((await S1.get('/api/push/devices')).data.devices.length, 0);
  } finally {
    mock.close();
  }

  // ---- Loans to persons: paid out, recovered in parts, never income or expense ---------------------------
  const loanIn = (o) => ({ type: 'loan_recovery', date: today, account: 'Main Bank Account', ...o });
  st = (await U1.get('/api/state')).data;
  const bank0 = st.balances['Main Bank Account'];
  assert.equal(st.loanAccount, 'Loans to persons');
  assert.ok(!st.settings.accounts.includes('Loans to persons'), 'loan account is not an ordinary account');
  r = await U1.post('/api/transactions', { type: 'loan_given', date: today, amount: 5000, account: 'Main Bank Account', borrowerMobile: '01811111111' });
  assert.equal(r.status, 400, 'borrower name required');
  r = await U1.post('/api/transactions', { type: 'loan_given', date: today, amount: 5000, account: 'Main Bank Account', borrower: 'Rahim Uddin', borrowerMobile: '123' });
  assert.equal(r.status, 400, 'bad borrower mobile');
  r = await U1.post('/api/transactions', { type: 'loan_given', date: today, amount: 5000, account: 'Main Bank Account', borrower: 'Rahim Uddin', borrowerMobile: '01811111111', description: 'Medical advance' });
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  assert.equal(r.data.transaction.kind, 'loan_given');
  assert.equal(r.data.transaction.type, 'transfer', 'stored as a movement, not an expense');
  assert.equal(r.data.transaction.description, 'Loan to Rahim Uddin — Medical advance');
  assert.equal(r.data.transaction.date, today, 'dates are DD/MM/YYYY');
  assert.match(r.data.transaction.date, /^\d{2}\/\d{2}\/\d{4}$/);
  const loanPay = r.data.transaction;
  st = (await U1.get('/api/state')).data;
  let loan = st.loans.find((l) => l.borrower === 'Rahim Uddin');
  assert.equal(loan.loanNo, 'LN-0001');
  assert.equal(loan.mobile, '+8801811111111');
  assert.equal(loan.purpose, 'Medical advance');
  assert.deepEqual([loan.given, loan.recovered, loan.outstanding, loan.status], [5000, 0, 5000, 'active']);
  assert.equal(st.balances['Main Bank Account'], bank0 - 5000);
  assert.equal(st.balances['Loans to persons'], 5000);
  // Partial recovery, then more than is owed is refused.
  r = await U1.post('/api/transactions', loanIn({ amount: 2000, loanId: loan.id, description: 'First instalment' }));
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  assert.equal(r.data.transaction.kind, 'loan_recovery');
  assert.equal(r.data.transaction.toAccount, 'Main Bank Account');
  assert.equal(r.data.transaction.description, 'Loan recovery from Rahim Uddin — First instalment');
  r = await U1.post('/api/transactions', loanIn({ amount: 3500, loanId: loan.id }));
  assert.equal(r.status, 400);
  assert.equal(r.data.reason, 'exceeds_outstanding');
  assert.match(r.data.error, /Outstanding on LN-0001 is ৳ ?3,000\.00/);
  assert.equal((await U1.post('/api/transactions', loanIn({ amount: 10, loanId: 'nope' }))).status, 400, 'unknown loan');
  // Recover the rest in full: the loan closes.
  r = await U1.post('/api/transactions', loanIn({ amount: 3000, loanId: loan.id, date: today }));
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  const lastRec = r.data.transaction;
  loan = (await U1.get('/api/state')).data.loans.find((l) => l.id === loan.id);
  assert.deepEqual([loan.given, loan.recovered, loan.outstanding, loan.status], [5000, 5000, 0, 'closed']);
  r = await U1.post('/api/transactions', loanIn({ amount: 1, loanId: loan.id }));
  assert.match(r.data.error, /nothing outstanding/);
  // Reversing a recovery re-opens the loan; reversing the payment cannot exceed what is owed.
  r = await U1.post(`/api/transactions/${lastRec.id}/reverse`, {});
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  assert.equal(r.data.transaction.kind, 'loan_given');
  assert.equal(r.data.transaction.loanId, loan.id);
  loan = (await U1.get('/api/state')).data.loans.find((l) => l.id === loan.id);
  assert.deepEqual([loan.given, loan.recovered, loan.outstanding, loan.status], [5000, 2000, 3000, 'active']);
  r = await U1.post(`/api/transactions/${loanPay.id}/reverse`, {});
  assert.equal(r.status, 400, 'cannot reverse a payment that is partly recovered');
  // Over the limit: a recovery goes for approval, and pending recoveries count against what is owed.
  r = await S1.post('/api/transactions', { type: 'loan_given', date: today, amount: 50000, account: 'Main Bank Account', borrower: 'Karim Ahmed' });
  assert.equal(r.data.outcome, 'posted', JSON.stringify(r.data));
  const loan2 = (await S1.get('/api/state')).data.loans.find((l) => l.borrower === 'Karim Ahmed');
  assert.equal(loan2.loanNo, 'LN-0002');
  r = await U1.post('/api/transactions', loanIn({ amount: 30000, loanId: loan2.id }));
  assert.equal(r.data.outcome, 'submitted', JSON.stringify(r.data));
  const bigRec = r.data.transaction;
  r = await U1.post('/api/transactions', loanIn({ amount: 25000, loanId: loan2.id }));
  assert.equal(r.data.reason, 'exceeds_outstanding', 'pending 30k leaves only 20k to recover');
  assert.match(r.data.error, /already entered and awaiting posting/);
  assert.equal((await U1.get('/api/state')).data.loans.find((l) => l.id === loan2.id).pendingRecovery, 30000);
  await S1.post(`/api/transactions/${bigRec.id}/approve`);
  r = await U1.post(`/api/transactions/${bigRec.id}/post`);
  assert.equal(r.data.transaction.status, 'posted', JSON.stringify(r.data));
  // Paying more on an existing loan.
  r = await S1.post('/api/transactions', { type: 'loan_given', date: today, amount: 1000, account: 'Main Bank Account', loanId: loan2.id, description: 'Top-up' });
  assert.equal(r.data.transaction.description, 'Loan to Karim Ahmed — Top-up');
  st = (await U1.get('/api/state')).data;
  assert.equal(st.loans.find((l) => l.id === loan2.id).outstanding, 21000);
  assert.equal(st.balances['Loans to persons'], 3000 + 21000);
  assert.equal(st.balances['Main Bank Account'], bank0 - 3000 - 21000);
  assert.ok(!st.transactions.some((t) => t.loanId && t.type !== 'transfer'), 'loans never count as expense or funds received');
  // A loan from Petty Cash cannot overdraw it, and leaves no empty loan behind.
  r = await U1.post('/api/transactions', { type: 'loan_given', date: today, amount: 5000, account: 'Petty Cash', borrower: 'Nobody' });
  assert.equal(r.data.reason, 'insufficient_petty_cash');
  assert.ok(!(await S1.get('/api/state')).data.loans.some((l) => l.borrower === 'Nobody'));
  // The loan account and loan categories are reserved.
  r = await S1.put('/api/settings', { key: 'accounts', value: ['Main Bank Account', 'Loans to persons'] });
  assert.ok(!r.data.settings.accounts.includes('Loans to persons'));
  assert.equal((await S1.post('/api/categories', { name: 'Loan given' })).status, 400);
  assert.equal((await U1.post('/api/transactions', { type: 'transfer', date: today, amount: 1, description: 'x', account: 'Main Bank Account', toAccount: 'Loans to persons' })).status, 400);

  // ---- Backup / restore round trip (Super User only) -------------------------------------------------
  assert.equal((await U1.get('/api/backup')).status, 403);
  const bk = await S1.get('/api/backup');
  assert.equal(bk.status, 200);
  assert.ok(!('users' in bk.data.data), 'backup never contains users');
  const before = (await S1.get('/api/state')).data.transactions.length;
  r = await S1.post('/api/restore', { confirm: 'RESTORE LEDGER BOOK DATA', backup: bk.data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await S1.get('/api/state')).data.transactions.length, before);
  assert.equal((await S1.get('/api/state')).data.loans.find((l) => l.id === loan2.id).outstanding, 21000, 'loans survive restore');

  // ---- Audit trail ------------------------------------------------------------------------------
  const audit = (await admin.get('/api/audit')).data.entries.map((a) => a.action);
  for (const a of ['user.created', 'limit.changed', 'transaction.submitted', 'transaction.approved', 'transaction.rejected', 'transaction.posted']) {
    assert.ok(audit.includes(a), `audit has ${a}`);
  }
  assert.equal((await U1.get('/api/audit')).status, 403);
});
