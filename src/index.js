// ALIDADA Limited Ledger Book — Cloudflare Worker entry point.
// One Worker serves the static SPA and the JSON API. Every route except the
// login/setup pages is gated by a session check before anything is returned.
import {
  hashPassword,
  verifyPassword,
  randomSalt,
  validatePassword,
  signSession,
  readSession,
  sessionCookie,
  clearSessionCookie,
  newSessionPayload,
} from './auth.js';
import {
  ensureSchema,
  getSettings,
  putSettingStmt,
  auditStmt,
  publicUser,
  PETTY_CASH_ACCOUNT,
  SETTING_KEYS,
} from './db.js';
import {
  createTransaction,
  decideTransaction,
  postTransaction,
  cancelTransaction,
  rerouteTransaction,
  reverseTransaction,
  patchTransaction,
  transactionEvents,
  visibleTransactions,
  eligibleApprovers,
  pettyCashBalance,
  accountBalances,
  rowToTx,
} from './ledger.js';
import { listUsers, createUser, updateUser, resetPassword, setFinancialLimit, limitHistory } from './users.js';
import { HttpError, json, fail, readJson, uuid, nowISO, cleanText, parseAmount } from './util.js';

const PUBLIC_PAGES = { '/login': '/login.html', '/setup': '/setup.html' };
const PUBLIC_ASSETS = new Set(['/auth.css', '/favicon.svg']);
const PRIVATE_PAGES = { '/': '/index.html', '/help': '/help.html' };
const MAX_UPLOAD = 20 * 1024 * 1024;
const RESTORE_PHRASE = 'RESTORE LEDGER BOOK DATA';

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message, ...err.extra }, err.status);
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'Something went wrong on the server.' }, 500);
    }
  },
};

const companyName = (env) => cleanText(env.COMPANY_NAME, 80) || 'ALIDADA Limited';

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (!env.SESSION_SECRET) return json({ ok: false, error: 'SESSION_SECRET is not configured on this Worker.' }, 500);
  await ensureSchema(env.DB);

  // Mutating requests must come from our own origin (CSRF defence on top of SameSite=Lax).
  if (!['GET', 'HEAD'].includes(method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ ok: false, error: 'Cross-origin request refused.' }, 403);
  }

  // ---- Public routes ------------------------------------------------------
  if (path === '/api/meta' && method === 'GET') {
    return json({ ok: true, company: companyName(env), setupRequired: await setupRequired(env.DB) });
  }
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/setup' && method === 'POST') return setup(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }
  if (PUBLIC_PAGES[path] && method === 'GET') {
    if (path === '/setup' && !(await setupRequired(env.DB))) return Response.redirect(new URL('/login', url), 302);
    if (path === '/login' && (await setupRequired(env.DB))) return Response.redirect(new URL('/setup', url), 302);
    return servePage(env, url, PUBLIC_PAGES[path]);
  }
  if (PUBLIC_ASSETS.has(path)) return env.ASSETS.fetch(new Request(new URL(path, url), request));

  // ---- Everything else requires a valid session -----------------------------
  const user = await currentUser(request, env);
  if (!user) {
    if (path.startsWith('/api/')) return json({ ok: false, error: 'Please sign in.' }, 401);
    return Response.redirect(new URL('/login', url), 302);
  }

  if (!path.startsWith('/api/')) {
    if (PRIVATE_PAGES[path]) return servePage(env, url, PRIVATE_PAGES[path]);
    return env.ASSETS.fetch(new Request(new URL(path, url), request));
  }

  return api(request, env, user, path, method, url);
}

async function setupRequired(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return !row || row.n === 0;
}

async function currentUser(request, env) {
  const session = await readSession(env.SESSION_SECRET, request.headers.get('cookie'));
  if (!session) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.uid).first();
  if (!user || !user.active || user.sessionVersion !== session.sv) return null;
  user.financialLimit = user.role === 'admin' ? 0 : Number(user.financialLimit) || 0;
  return user;
}

// Stamp the company name into every HTML page the Worker serves.
async function servePage(env, url, assetPath) {
  const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url)));
  if (!res.ok) return res;
  const company = companyName(env);
  const out = new HTMLRewriter()
    .on('[data-company]', { element: (el) => el.setInnerContent(company) })
    .on('title[data-page]', {
      element: (el) => el.setInnerContent(`${el.getAttribute('data-page')} — ${company}`),
    })
    .transform(res);
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'same-origin');
  return new Response(out.body, { status: out.status, headers });
}

// ---- Auth routes ------------------------------------------------------------

async function login(request, env) {
  const db = env.DB;
  const body = await readJson(request);
  const username = cleanText(body.username, 32).toLowerCase();
  const password = String(body.password ?? '');
  if (!username || !password) fail(400, 'Enter your username and password.');

  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed' AND detail = ? AND at > ?")
    .bind(username, since)
    .first();
  if (recent.n >= 5) fail(429, 'Too many failed attempts. Please wait 15 minutes and try again.');

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  const ok = user && (await verifyPassword(password, user.passwordSalt, user.passwordHash));
  if (!ok || !user.active) {
    await auditStmt(db, null, 'login.failed', username).run();
    fail(401, !ok ? 'Incorrect username or password.' : 'This account has been disabled. Contact the Admin.');
  }
  await auditStmt(db, user, 'login.success', null).run();
  const token = await signSession(env.SESSION_SECRET, newSessionPayload(user));
  return json({ ok: true, user: publicUser(user) }, 200, { 'set-cookie': sessionCookie(token) });
}

async function setup(request, env) {
  const db = env.DB;
  if (!env.BOOTSTRAP_KEY) fail(500, 'BOOTSTRAP_KEY is not configured on this Worker.');
  if (!(await setupRequired(db))) fail(409, 'Setup has already been completed.');
  const body = await readJson(request);
  if (String(body.bootstrapKey ?? '') !== env.BOOTSTRAP_KEY) fail(403, 'Setup key is incorrect.');
  const username = cleanText(body.username, 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) fail(400, 'Username must be 3–32 letters, numbers, dot, dash or underscore.');
  const fullName = cleanText(body.fullName, 80);
  if (!fullName) fail(400, 'Full name is required.');
  const pwError = validatePassword(body.password);
  if (pwError) fail(400, pwError);
  const salt = randomSalt();
  const hash = await hashPassword(String(body.password), salt);
  const now = nowISO();
  const id = uuid();
  // Atomic: only succeeds while the users table is still empty.
  const res = await db
    .prepare(
      `INSERT INTO users (id, username, fullName, designation, role, passwordHash, passwordSalt, financialLimit, active, mustChangePassword, sessionVersion, createdAt, updatedAt)
       SELECT ?, ?, ?, 'System Administrator', 'admin', ?, ?, 0, 1, 0, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(id, username, fullName, hash, salt, now, now)
    .run();
  if (!res.meta.changes) fail(409, 'Setup has already been completed.');
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  await auditStmt(db, user, 'setup.admin_created', username).run();
  const token = await signSession(env.SESSION_SECRET, newSessionPayload(user));
  return json({ ok: true, user: publicUser(user) }, 200, { 'set-cookie': sessionCookie(token) });
}

async function changePassword(request, env, user) {
  const body = await readJson(request);
  if (!(await verifyPassword(String(body.current ?? ''), user.passwordSalt, user.passwordHash))) {
    fail(400, 'Current password is incorrect.');
  }
  const pwError = validatePassword(body.next);
  if (pwError) fail(400, pwError);
  if (String(body.next) === String(body.current)) fail(400, 'Choose a password different from the current one.');
  const salt = randomSalt();
  const hash = await hashPassword(String(body.next), salt);
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET passwordHash = ?, passwordSalt = ?, mustChangePassword = 0, sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?',
    ).bind(hash, salt, nowISO(), user.id),
    auditStmt(env.DB, user, 'user.password_changed', null),
  ]);
  const token = await signSession(env.SESSION_SECRET, newSessionPayload({ ...user, sessionVersion: user.sessionVersion + 1 }));
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) });
}

// ---- Authenticated API ----------------------------------------------------------

const isFinancial = (u) => u.role === 'user' || u.role === 'superuser';
function requireFinancial(user) {
  if (!isFinancial(user)) fail(403, 'The Admin account has no financial authority.');
}
function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) fail(403, 'You do not have permission for this action.');
}

async function api(request, env, user, path, method, url) {
  const db = env.DB;
  const seg = path.split('/').filter(Boolean).slice(1); // drop "api"

  if (path === '/api/change-password' && method === 'POST') return changePassword(request, env, user);
  if (user.mustChangePassword && path !== '/api/me') fail(403, 'Please set your own password before continuing.', { reason: 'must_change_password' });

  if (path === '/api/me' && method === 'GET') {
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM notifications WHERE userId = ?1 AND read = 0) AS unread,
           (SELECT COUNT(*) FROM transactions WHERE approverId = ?1 AND status = 'pending_approval') AS toApprove,
           (SELECT COUNT(*) FROM transactions WHERE initiatedBy = ?1 AND status = 'approved') AS toPost`,
      )
      .bind(user.id)
      .first();
    const settings = await getSettings(db);
    return json({ ok: true, company: companyName(env), user: publicUser(user), currency: settings.currency, ...counts });
  }

  // Notifications (every role)
  if (path === '/api/notifications' && method === 'GET') {
    const { results } = await db
      .prepare('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 300')
      .bind(user.id)
      .all();
    return json({ ok: true, notifications: results.map((n) => ({ ...n, read: !!n.read, actionable: !!n.actionable })) });
  }
  if (path === '/api/notifications/read' && method === 'POST') {
    const body = await readJson(request);
    if (body.all) {
      await db.prepare('UPDATE notifications SET read = 1 WHERE userId = ?').bind(user.id).run();
    } else if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.slice(0, 200).map(String);
      await db
        .prepare(`UPDATE notifications SET read = 1 WHERE userId = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .bind(user.id, ...ids)
        .run();
    }
    return json({ ok: true });
  }

  // Audit trail (Admin, Super User)
  if (path === '/api/audit' && method === 'GET') {
    requireRole(user, 'admin', 'superuser');
    const { results } = await db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT 1000').all();
    return json({ ok: true, entries: results });
  }

  // Users (Admin manages; Super User reads for limit delegation)
  if (seg[0] === 'users') {
    if (seg.length === 1 && method === 'GET') {
      requireRole(user, 'admin', 'superuser');
      return json({ ok: true, users: await listUsers(db) });
    }
    if (seg.length === 1 && method === 'POST') {
      requireRole(user, 'admin');
      return json({ ok: true, user: await createUser(db, user, await readJson(request)) });
    }
    if (seg.length === 2 && method === 'PATCH') {
      requireRole(user, 'admin');
      return json({ ok: true, user: await updateUser(db, user, seg[1], await readJson(request)) });
    }
    if (seg.length === 3 && seg[2] === 'reset-password' && method === 'POST') {
      requireRole(user, 'admin');
      await resetPassword(db, user, seg[1], (await readJson(request)).password);
      return json({ ok: true });
    }
    if (seg.length === 3 && seg[2] === 'limit' && method === 'PUT') {
      requireRole(user, 'superuser');
      return json({ ok: true, user: await setFinancialLimit(db, user, seg[1], await readJson(request)) });
    }
  }
  if (path === '/api/limit-history' && method === 'GET') {
    requireRole(user, 'superuser');
    return json({ ok: true, history: await limitHistory(db) });
  }

  // ---- Financial routes: User and Super User only ----
  requireFinancial(user);

  if (path === '/api/state' && method === 'GET') {
    const [transactions, settings, tags, docs, directory, pettyCash, balances] = await Promise.all([
      visibleTransactions(db, user),
      getSettings(db),
      db.prepare('SELECT name FROM tags ORDER BY name').all(),
      db.prepare('SELECT id, filename, mimeType, size, uploadedBy, createdAt FROM documents ORDER BY createdAt DESC').all(),
      db
        .prepare("SELECT id, username, fullName, designation, role, financialLimit, active FROM users WHERE role != 'admin' ORDER BY fullName")
        .all(),
      pettyCashBalance(db),
      accountBalances(db),
    ]);
    return json({
      ok: true,
      transactions,
      settings,
      tags: tags.results.map((t) => t.name),
      documents: docs.results,
      directory: directory.results.map((u) => ({ ...u, active: !!u.active, financialLimit: Number(u.financialLimit) })),
      pettyCash,
      balances,
      documentsEnabled: !!env.BUCKET,
    });
  }

  if (path === '/api/approvers' && method === 'GET') {
    const amount = parseAmount(url.searchParams.get('amount'));
    if (amount === null || amount <= 0) fail(400, 'Amount is required.');
    return json({ ok: true, withinLimit: Math.round(amount * 100) <= Math.round(user.financialLimit * 100), approvers: await eligibleApprovers(db, amount, user.id) });
  }

  if (seg[0] === 'transactions') {
    if (seg.length === 1 && method === 'POST') {
      const result = await createTransaction(env, user, await readJson(request));
      return json(result, result.ok ? 200 : 409);
    }
    const id = seg[1];
    if (seg.length === 2 && method === 'PATCH') {
      return json({ ok: true, transaction: await patchTransaction(env, user, id, await readJson(request)) });
    }
    if (seg.length === 3 && method === 'GET' && seg[2] === 'events') {
      const tx = await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first();
      if (!tx) fail(404, 'Transaction not found.');
      const canSee =
        user.role === 'superuser' || tx.status === 'posted' || [tx.initiatedBy, tx.approverId, tx.decidedBy].includes(user.id);
      if (!canSee) fail(403, 'You cannot view this transaction.');
      return json({ ok: true, transaction: rowToTx(tx), events: await transactionEvents(db, id) });
    }
    if (seg.length === 3 && method === 'POST') {
      const body = await readJson(request);
      switch (seg[2]) {
        case 'approve':
          return json({ ok: true, transaction: await decideTransaction(env, user, id, 'approve', body.remark) });
        case 'reject':
          return json({ ok: true, transaction: await decideTransaction(env, user, id, 'reject', body.remark) });
        case 'post':
          return json({ ok: true, transaction: await postTransaction(env, user, id) });
        case 'cancel':
          return json({ ok: true, transaction: await cancelTransaction(env, user, id, body.remark) });
        case 'reroute':
          return json({ ok: true, transaction: await rerouteTransaction(env, user, id, String(body.approverId || '')) });
        case 'reverse': {
          const result = await reverseTransaction(env, user, id, body);
          return json(result, result.ok ? 200 : 409);
        }
      }
    }
  }

  if (path === '/api/settings' && method === 'PUT') {
    requireRole(user, 'superuser');
    const body = await readJson(request);
    const value = validateSetting(body.key, body.value);
    await db.batch([putSettingStmt(db, body.key, value), auditStmt(db, user, 'settings.updated', body.key)]);
    return json({ ok: true, settings: await getSettings(db) });
  }

  if (seg[0] === 'tags') {
    if (seg.length === 1 && method === 'POST') {
      const name = cleanText((await readJson(request)).name, 40);
      if (!name) fail(400, 'Tag name is required.');
      await db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').bind(name, nowISO()).run();
      return json({ ok: true });
    }
    if (seg.length === 2 && method === 'DELETE') {
      requireRole(user, 'superuser');
      const name = decodeURIComponent(seg[1]);
      await db.batch([db.prepare('DELETE FROM tags WHERE name = ?').bind(name), auditStmt(db, user, 'tag.deleted', name)]);
      return json({ ok: true });
    }
  }

  if (seg[0] === 'documents') return documents(request, env, user, seg, method);

  if (path === '/api/backup' && method === 'GET') {
    requireRole(user, 'superuser');
    return backup(env, user);
  }
  if (path === '/api/restore' && method === 'POST') {
    requireRole(user, 'superuser');
    return restore(env, user, await readJson(request));
  }

  fail(404, 'Not found.');
}

function validateSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) fail(400, 'Unknown setting.');
  const uniqList = (arr, max) => {
    if (!Array.isArray(arr)) fail(400, 'Expected a list.');
    const out = [...new Set(arr.map((v) => cleanText(v, 80)).filter(Boolean))];
    if (out.length > max) fail(400, 'Too many entries.');
    return out;
  };
  switch (key) {
    case 'categories': {
      const list = uniqList(value, 200).filter((c) => c !== 'Transfer');
      if (!list.includes('Needs review')) list.push('Needs review');
      return list;
    }
    case 'accounts': {
      const list = uniqList(value, 100);
      if (!list.includes(PETTY_CASH_ACCOUNT)) list.push(PETTY_CASH_ACCOUNT); // protected system account
      return list;
    }
    case 'budgets': {
      if (!Array.isArray(value)) fail(400, 'Expected a list.');
      const seen = new Set();
      return value
        .map((b) => ({ category: cleanText(b?.category, 80), limit: parseAmount(b?.limit) }))
        .filter((b) => b.category && b.limit !== null && b.limit > 0 && !seen.has(b.category) && seen.add(b.category));
    }
    case 'currency': {
      const s = cleanText(value, 5);
      if (!s) fail(400, 'Currency symbol is required.');
      return s;
    }
  }
}

// ---- Documents (R2) ----------------------------------------------------------------

async function documents(request, env, user, seg, method) {
  const db = env.DB;
  if (seg.length === 1 && method === 'POST') {
    if (!env.BUCKET) fail(501, 'Document storage (R2) is not enabled on this deployment.');
    const form = await request.formData().catch(() => fail(400, 'Expected a file upload.'));
    const file = form.get('file');
    if (!file || typeof file === 'string') fail(400, 'Choose a file to upload.');
    if (file.size > MAX_UPLOAD) fail(413, 'Files are limited to 20 MB.');
    const id = uuid();
    const filename = cleanText(file.name, 150) || 'document';
    const objectKey = `documents/${id}`;
    await env.BUCKET.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
    const now = nowISO();
    await db.batch([
      db
        .prepare('INSERT INTO documents (id, filename, mimeType, size, objectKey, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, filename, file.type || null, file.size, objectKey, user.id, now),
      auditStmt(db, user, 'document.uploaded', filename),
    ]);
    return json({ ok: true, document: { id, filename, mimeType: file.type || null, size: file.size, uploadedBy: user.id, createdAt: now } });
  }
  const doc = seg[1] ? await db.prepare('SELECT * FROM documents WHERE id = ?').bind(seg[1]).first() : null;
  if (!doc) fail(404, 'Document not found.');
  if (seg.length === 3 && seg[2] === 'file' && method === 'GET') {
    if (!env.BUCKET) fail(501, 'Document storage (R2) is not enabled on this deployment.');
    const obj = await env.BUCKET.get(doc.objectKey);
    if (!obj) fail(404, 'The stored file is missing.');
    return new Response(obj.body, {
      headers: {
        'content-type': doc.mimeType || 'application/octet-stream',
        'content-disposition': `inline; filename="${doc.filename.replace(/["\\]/g, '')}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      },
    });
  }
  if (seg.length === 2 && method === 'DELETE') {
    if (doc.uploadedBy !== user.id && user.role !== 'superuser') fail(403, 'Only the uploader or a Super User can delete this document.');
    const used = await db.prepare('SELECT voucherNo FROM transactions WHERE documentId = ? LIMIT 1').bind(doc.id).first();
    if (used) fail(409, `This document is attached to ${used.voucherNo} and cannot be deleted.`);
    if (env.BUCKET) await env.BUCKET.delete(doc.objectKey);
    await db.batch([db.prepare('DELETE FROM documents WHERE id = ?').bind(doc.id), auditStmt(db, user, 'document.deleted', doc.filename)]);
    return json({ ok: true });
  }
  fail(404, 'Not found.');
}

// ---- Backup & restore ----------------------------------------------------------------
// A backup is pure financial data: it never contains users, passwords or sessions.

const BACKUP_TABLES = ['transactions', 'transaction_events', 'tags', 'settings', 'documents', 'counters', 'limit_history'];

async function backup(env, user) {
  const db = env.DB;
  const data = {};
  for (const t of BACKUP_TABLES) data[t] = (await db.prepare(`SELECT * FROM ${t}`).all()).results;
  await auditStmt(db, user, 'backup.downloaded', null).run();
  const payload = { app: 'alidada-ledger-book', version: 1, company: companyName(env), exportedAt: nowISO(), exportedBy: user.username, data };
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 1), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="alidada-ledger-backup-${day}.json"`,
      'cache-control': 'no-store',
    },
  });
}

async function restore(env, user, body) {
  const db = env.DB;
  if (body.confirm !== RESTORE_PHRASE) fail(400, `Type ${RESTORE_PHRASE} to confirm.`);
  const b = body.backup;
  if (!b || b.app !== 'alidada-ledger-book' || !b.data) fail(400, 'This is not an ALIDADA Ledger Book backup file.');
  const stmts = BACKUP_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`));
  for (const t of BACKUP_TABLES) {
    const rows = Array.isArray(b.data[t]) ? b.data[t] : [];
    const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
    for (const row of rows) {
      const use = cols.filter((c) => row[c] !== undefined);
      if (!use.length) continue;
      stmts.push(db.prepare(`INSERT OR REPLACE INTO ${t} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).bind(...use.map((c) => row[c])));
    }
  }
  stmts.push(auditStmt(db, user, 'backup.restored', `export of ${cleanText(b.exportedAt, 40)}`));
  await db.batch(stmts);
  return json({ ok: true, restored: Object.fromEntries(BACKUP_TABLES.map((t) => [t, (b.data[t] || []).length])) });
}

