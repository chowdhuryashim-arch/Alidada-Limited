// User administration (Admin) and financial-limit delegation (Super User).
import { hashPassword, randomSalt, validatePassword } from './auth.js';
import { auditStmt, notifyStmt, publicUser, getSettings } from './db.js';
import { fail, uuid, nowISO, cleanText, cents, parseAmount, formatMoney } from './util.js';

const ROLE_LABEL = { admin: 'Admin', superuser: 'Super User', user: 'User' };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

export async function listUsers(db) {
  const { results } = await db.prepare('SELECT * FROM users ORDER BY role, fullName').all();
  return results.map(publicUser);
}

export async function createUser(db, admin, input) {
  const username = cleanText(input.username, 32).toLowerCase();
  if (!USERNAME_RE.test(username)) fail(400, 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  const fullName = cleanText(input.fullName, 80);
  if (!fullName) fail(400, 'Full name is required.');
  const role = input.role;
  if (!['user', 'superuser'].includes(role)) fail(400, 'Admin can create a User or a Super User only.');
  const pwError = validatePassword(input.password);
  if (pwError) fail(400, pwError);
  const exists = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (exists) fail(409, 'That username is already taken.');
  const salt = randomSalt();
  const now = nowISO();
  const user = {
    id: uuid(),
    username,
    fullName,
    designation: cleanText(input.designation, 80) || null,
    role,
    passwordHash: await hashPassword(String(input.password), salt),
    passwordSalt: salt,
    createdBy: admin.id,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, username, fullName, designation, role, passwordHash, passwordSalt, financialLimit, active, mustChangePassword, sessionVersion, createdBy, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, 0, ?, ?, ?)`,
      )
      .bind(user.id, user.username, user.fullName, user.designation, user.role, user.passwordHash, user.passwordSalt, user.createdBy, now, now),
    notifyStmt(db, {
      userId: user.id,
      kind: 'info',
      title: 'Welcome to the Ledger Book',
      body: `Your ${ROLE_LABEL[role]} account was created by ${admin.fullName}. Your financial limit is not yet assigned — a Super User will delegate it. Until then every transaction you initiate is routed for approval.`,
    }),
    auditStmt(db, admin, 'user.created', `${username} (${ROLE_LABEL[role]}) — ${fullName}`),
  ]);
  return publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first());
}

export async function updateUser(db, admin, id, input) {
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) fail(404, 'User not found.');
  if (target.role === 'admin') fail(403, 'The Admin account cannot be modified here. Use Change password for your own account.');
  const sets = [];
  const binds = [];
  const notes = [];
  let bumpSessions = false;
  if (input.fullName !== undefined) {
    const v = cleanText(input.fullName, 80);
    if (!v) fail(400, 'Full name is required.');
    sets.push('fullName = ?');
    binds.push(v);
    if (v !== target.fullName) notes.push(`name → ${v}`);
  }
  if (input.designation !== undefined) {
    sets.push('designation = ?');
    binds.push(cleanText(input.designation, 80) || null);
  }
  if (input.role !== undefined && input.role !== target.role) {
    if (!['user', 'superuser'].includes(input.role)) fail(400, 'Role must be User or Super User.');
    sets.push('role = ?');
    binds.push(input.role);
    notes.push(`role ${ROLE_LABEL[target.role]} → ${ROLE_LABEL[input.role]}`);
    bumpSessions = true;
  }
  if (input.active !== undefined && !!input.active !== !!target.active) {
    sets.push('active = ?');
    binds.push(input.active ? 1 : 0);
    notes.push(input.active ? 'enabled' : 'disabled');
    if (!input.active) bumpSessions = true;
  }
  if (!sets.length) return publicUser(target);
  if (bumpSessions) sets.push('sessionVersion = sessionVersion + 1');
  const stmts = [
    db.prepare(`UPDATE users SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`).bind(...binds, nowISO(), id),
    auditStmt(db, admin, 'user.updated', `${target.username}: ${notes.join('; ') || 'details updated'}`),
  ];
  if (input.active === false && target.active) {
    // Anything waiting on this person must not silently stall: tell initiators.
    const { results } = await db
      .prepare("SELECT id, voucherNo, initiatedBy FROM transactions WHERE approverId = ? AND status = 'pending_approval'")
      .bind(id)
      .all();
    for (const t of results) {
      stmts.push(
        notifyStmt(db, {
          userId: t.initiatedBy,
          kind: 'reroute_needed',
          title: `Choose another approver: ${t.voucherNo}`,
          body: `${target.fullName}, the approver for ${t.voucherNo}, has been disabled. Open the transaction and re-route it to another approver.`,
          transactionId: t.id,
          actionable: true,
        }),
      );
    }
  }
  await db.batch(stmts);
  return publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
}

export async function resetPassword(db, admin, id, password) {
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) fail(404, 'User not found.');
  if (target.role === 'admin') fail(403, 'Use Change password for the Admin account.');
  const pwError = validatePassword(password);
  if (pwError) fail(400, pwError);
  const salt = randomSalt();
  const hash = await hashPassword(String(password), salt);
  await db.batch([
    db
      .prepare(
        'UPDATE users SET passwordHash = ?, passwordSalt = ?, mustChangePassword = 1, sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?',
      )
      .bind(hash, salt, nowISO(), id),
    auditStmt(db, admin, 'user.password_reset', target.username),
  ]);
}

// Only a Super User may delegate a financial limit, never to themselves and
// never to the Admin (who holds no financial authority).
export async function setFinancialLimit(db, superuser, id, input) {
  if (superuser.role !== 'superuser') fail(403, 'Only a Super User can assign financial limits.');
  if (id === superuser.id) fail(403, 'You cannot assign your own financial limit. Another Super User must do it.');
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) fail(404, 'User not found.');
  if (target.role === 'admin') fail(403, 'The Admin has no financial authority and cannot be given a limit.');
  if (!target.active) fail(409, 'Enable this user before assigning a limit.');
  const limit = parseAmount(input.limit);
  if (limit === null || limit < 0) fail(400, 'Enter a limit of zero or more.');
  if (limit > 1e12) fail(400, 'Limit is too large.');
  const note = cleanText(input.note, 300) || null;
  const old = Number(target.financialLimit) || 0;
  if (cents(old) === cents(limit)) return publicUser(target);
  const now = nowISO();
  const { currency: sym } = await getSettings(db);
  await db.batch([
    db.prepare('UPDATE users SET financialLimit = ?, limitSetBy = ?, limitSetAt = ?, updatedAt = ? WHERE id = ?').bind(limit, superuser.id, now, now, id),
    db
      .prepare('INSERT INTO limit_history (id, userId, oldLimit, newLimit, setBy, note, setAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uuid(), id, old, limit, superuser.id, note, now),
    notifyStmt(db, {
      userId: id,
      kind: 'limit_changed',
      title: 'Your financial limit was updated',
      body: `${superuser.fullName} changed your delegated financial limit from ${formatMoney(old, sym)} to ${formatMoney(limit, sym)}.${note ? ` Note: “${note}”.` : ''}`,
    }),
    auditStmt(db, superuser, 'limit.changed', `${target.username}: ${formatMoney(old, sym)} → ${formatMoney(limit, sym)}${note ? ` — ${note}` : ''}`),
  ]);
  return publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
}

export async function limitHistory(db) {
  const { results } = await db
    .prepare(
      `SELECT h.*, u.fullName AS userName, s.fullName AS setByName FROM limit_history h
         LEFT JOIN users u ON u.id = h.userId LEFT JOIN users s ON s.id = h.setBy
        ORDER BY h.setAt DESC LIMIT 500`,
    )
    .all();
  return results;
}
