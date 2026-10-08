// Database bootstrap and small shared data helpers (settings, audit, messages).
import SCHEMA_SQL from '../schema/schema.sql';
import { uuid, nowISO } from './util.js';

export const PETTY_CASH_ACCOUNT = 'Petty Cash';

// Starter lookup configuration only — never financial records or balances.
export const DEFAULT_SETTINGS = {
  categories: [
    'Sales',
    'Service income',
    'Capital introduced',
    'Loan received',
    'Purchases',
    'Salaries & wages',
    'Rent',
    'Utilities',
    'Office supplies',
    'Transport & conveyance',
    'Repairs & maintenance',
    'Professional fees',
    'Bank charges',
    'Taxes & VAT',
    'Marketing',
    'Travel',
    'Entertainment',
    'Miscellaneous',
    'Needs review',
  ],
  accounts: ['Main Bank Account', PETTY_CASH_ACCOUNT],
  budgets: [], // [{ category, limit }]
  currency: '৳',
};
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  const statements = SCHEMA_SQL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
  // Additive migrations for databases created before these columns existed.
  // Never drops or renames anything.
  for (const [table, column, type] of ADDED_COLUMNS) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!results.some((c) => c.name === column)) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  }
  schemaReady = true;
}

const ADDED_COLUMNS = [
  ['users', 'mobile', 'TEXT'],
  ['users', 'tier', 'TEXT'],
  ['notifications', 'pushStatus', 'TEXT'],
  ['notifications', 'pushDetail', 'TEXT'],
];

// Messages that are worth a phone alert: the ones asking someone to act, or
// telling them a decision about their own entry or authority.
export const PUSH_KINDS = new Set(['approval_request', 'ready_to_post', 'rejected', 'reroute_needed', 'limit_changed']);

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of results) {
    if (!SETTING_KEYS.includes(row.key)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* keep default */
    }
  }
  if (!out.accounts.includes(PETTY_CASH_ACCOUNT)) out.accounts.push(PETTY_CASH_ACCOUNT);
  return out;
}

export function putSettingStmt(db, key, value) {
  return db
    .prepare(
      'INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
    )
    .bind(key, JSON.stringify(value), nowISO());
}

export function auditStmt(db, actor, action, detail) {
  return db
    .prepare('INSERT INTO audit_log (id, actorId, actorName, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(uuid(), actor?.id ?? null, actor ? actor.username : null, action, detail ?? null, nowISO());
}

export function notifyStmt(db, { userId, kind, title, body, transactionId = null, actionable = false }) {
  return db
    .prepare(
      'INSERT INTO notifications (id, userId, kind, title, body, transactionId, actionable, read, pushStatus, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    )
    .bind(uuid(), userId, kind, title, body ?? null, transactionId, actionable ? 1 : 0, PUSH_KINDS.has(kind) ? 'pending' : null, nowISO());
}

// When a user acts on a transaction, the message that asked them to act is done.
export function resolveNotificationsStmt(db, userId, transactionId) {
  return db
    .prepare('UPDATE notifications SET actionable = 0, read = 1 WHERE userId = ? AND transactionId = ? AND actionable = 1')
    .bind(userId, transactionId);
}

// A Mid User is stored as role 'user' with tier 'mid' (the role column's
// CHECK constraint predates the Mid User and SQLite cannot alter it in place).
export const effectiveRole = (u) => (u.role === 'user' && u.tier === 'mid' ? 'miduser' : u.role);
export const storedRole = (role) => (role === 'miduser' ? { role: 'user', tier: 'mid' } : { role, tier: null });
// Mid Users and Super Users may add categories and tags; Users only pick existing ones.
export const canManageLists = (u) => u.role === 'superuser' || u.role === 'miduser';

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    designation: u.designation || '',
    mobile: u.mobile || '',
    role: effectiveRole(u),
    financialLimit: u.role === 'admin' ? 0 : Number(u.financialLimit) || 0,
    limitSetBy: u.limitSetBy || null,
    limitSetAt: u.limitSetAt || null,
    active: !!u.active,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
  };
}
