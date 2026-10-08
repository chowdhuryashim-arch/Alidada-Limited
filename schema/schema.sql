-- ALIDADA Limited Ledger Book — D1 schema.
-- Idempotent: safe to run on a fresh database or re-run on an existing one.
-- Never seeds financial records. The same DDL is embedded in src/schema.js and
-- applied automatically on first request, so running this file is optional.

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  fullName           TEXT NOT NULL,
  designation        TEXT,
  mobile             TEXT,                         -- E.164, e.g. +8801712345678
  role               TEXT NOT NULL CHECK (role IN ('admin', 'superuser', 'user')),
  tier               TEXT,                         -- 'mid' = Mid User (stored with role 'user')
  passwordHash       TEXT NOT NULL,
  passwordSalt       TEXT NOT NULL,
  financialLimit     REAL NOT NULL DEFAULT 0,      -- 0 = no financial authority
  limitSetBy         TEXT,
  limitSetAt         TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  mustChangePassword INTEGER NOT NULL DEFAULT 0,
  sessionVersion     INTEGER NOT NULL DEFAULT 0,   -- bumped to invalidate sessions
  createdBy          TEXT,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS limit_history (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  oldLimit  REAL NOT NULL,
  newLimit  REAL NOT NULL,
  setBy     TEXT NOT NULL,
  note      TEXT,
  setAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limit_history_user ON limit_history (userId, setAt);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  voucherNo      TEXT NOT NULL UNIQUE,
  date           TEXT NOT NULL,                 -- DD/MM/YYYY, as displayed
  dateISO        TEXT NOT NULL,                 -- YYYY-MM-DD, for sorting / periods
  description    TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'Needs review',
  amount         REAL NOT NULL,                 -- positive magnitude
  type           TEXT NOT NULL CHECK (type IN ('expense', 'receive', 'transfer')),
  account        TEXT NOT NULL,                 -- for transfers: the source account
  toAccount      TEXT,                          -- transfers only
  tags           TEXT NOT NULL DEFAULT '[]',
  note           TEXT,
  documentId     TEXT,
  reversalOf     TEXT,
  loanId         TEXT,                          -- loans to persons: the loan this entry belongs to
  source         TEXT NOT NULL DEFAULT 'manual',
  fingerprint    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'posted', 'rejected', 'cancelled')),
  autoPosted     INTEGER NOT NULL DEFAULT 0,
  initiatedBy    TEXT NOT NULL,
  initiatedAt    TEXT NOT NULL,
  approverId     TEXT,
  decidedBy      TEXT,
  decidedAt      TEXT,
  decisionRemark TEXT,
  postedBy       TEXT,
  postedAt       TEXT,
  updatedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_status_date ON transactions (status, dateISO);
CREATE INDEX IF NOT EXISTS idx_tx_fingerprint ON transactions (fingerprint);
CREATE INDEX IF NOT EXISTS idx_tx_approver ON transactions (approverId, status);
CREATE INDEX IF NOT EXISTS idx_tx_initiator ON transactions (initiatedBy, status);

-- Loans to persons. Money paid out and recovered is held in the protected
-- "Loans to persons" account (as a movement between accounts), so it is never
-- counted as an expense or as funds received. Amounts live in transactions.
CREATE TABLE IF NOT EXISTS loans (
  id        TEXT PRIMARY KEY,
  loanNo    TEXT NOT NULL UNIQUE,                -- LN-0001
  borrower  TEXT NOT NULL,
  mobile    TEXT,
  purpose   TEXT,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_events (
  id            TEXT PRIMARY KEY,
  transactionId TEXT NOT NULL,
  action        TEXT NOT NULL,
  actorId       TEXT NOT NULL,
  remark        TEXT,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_events_tx ON transaction_events (transactionId, at);

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  userId        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  transactionId TEXT,
  actionable    INTEGER NOT NULL DEFAULT 0,
  read          INTEGER NOT NULL DEFAULT 0,
  pushStatus    TEXT,                            -- pending | sent | no_device | failed | skipped
  pushDetail    TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (userId, read, createdAt);

-- Phone browser notifications (Web Push): one row per signed-in device that
-- turned alerts on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  endpoint  TEXT NOT NULL UNIQUE,
  p256dh    TEXT,
  auth      TEXT,
  device    TEXT,
  createdAt TEXT NOT NULL,
  lastOkAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (userId);

CREATE TABLE IF NOT EXISTS tags (
  name      TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  mimeType   TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  objectKey  TEXT NOT NULL,
  uploadedBy TEXT NOT NULL,
  createdAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        TEXT PRIMARY KEY,
  actorId   TEXT,
  actorName TEXT,
  action    TEXT NOT NULL,
  detail    TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
