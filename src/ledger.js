// Transaction workflow: initiate → (auto-post within limit | route for approval)
// → approve / reject → final posting by the initiator.
import {
  PETTY_CASH_ACCOUNT,
  getSettings,
  auditStmt,
  notifyStmt,
  resolveNotificationsStmt,
} from './db.js';
import { fail, uuid, nowISO, cleanText, cents, round2, parseAmount, parseDate, formatMoney } from './util.js';

const TYPE_LABEL = { expense: 'Expense', receive: 'Receive Fund', transfer: 'Transfer' };
const MAX_AMOUNT = 1e12;
const TX_COLUMNS = [
  'id', 'voucherNo', 'date', 'dateISO', 'description', 'category', 'amount', 'type', 'account', 'toAccount',
  'tags', 'note', 'documentId', 'reversalOf', 'source', 'fingerprint', 'status', 'autoPosted', 'initiatedBy',
  'initiatedAt', 'approverId', 'decidedBy', 'decidedAt', 'decisionRemark', 'postedBy', 'postedAt', 'updatedAt',
];

// Posted balance of Petty Cash, as a SQL expression. The account name is a
// fixed constant, never user input.
const PC = `'${PETTY_CASH_ACCOUNT}'`;
const PETTY_CASH_BALANCE_SQL = `(SELECT COALESCE(SUM(CASE
    WHEN t2.type = 'receive'  AND t2.account = ${PC}   THEN t2.amount
    WHEN t2.type = 'expense'  AND t2.account = ${PC}   THEN -t2.amount
    WHEN t2.type = 'transfer' AND t2.toAccount = ${PC} THEN t2.amount
    WHEN t2.type = 'transfer' AND t2.account = ${PC}   THEN -t2.amount
    ELSE 0 END), 0) FROM transactions t2 WHERE t2.status = 'posted')`;

const drawsPettyCash = (tx) => (tx.type === 'expense' || tx.type === 'transfer') && tx.account === PETTY_CASH_ACCOUNT;

export async function pettyCashBalance(db) {
  const row = await db.prepare(`SELECT ${PETTY_CASH_BALANCE_SQL} AS balance`).first();
  return round2(row?.balance || 0);
}

export async function accountBalances(db) {
  const { results } = await db
    .prepare(
      `SELECT account AS name, SUM(CASE WHEN type = 'receive' THEN amount ELSE -amount END) AS balance
         FROM transactions WHERE status = 'posted' GROUP BY account
       UNION ALL
       SELECT toAccount AS name, SUM(amount) AS balance
         FROM transactions WHERE status = 'posted' AND type = 'transfer' GROUP BY toAccount`,
    )
    .all();
  const out = {};
  for (const r of results) out[r.name] = round2((out[r.name] || 0) + r.balance);
  return out;
}

export function fingerprintOf(tx) {
  return [tx.dateISO, tx.description.trim().toLowerCase(), Number(tx.amount).toFixed(2), tx.account.trim().toLowerCase(), tx.type].join('|');
}

export function rowToTx(r) {
  if (!r) return null;
  let tags = [];
  try {
    tags = JSON.parse(r.tags || '[]');
  } catch {
    /* ignore */
  }
  const { fingerprint, ...rest } = r;
  return { ...rest, amount: Number(r.amount), tags, autoPosted: !!r.autoPosted };
}

async function loadTx(db, id) {
  const row = await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'Transaction not found.');
  return row;
}

async function nextVoucherNo(db) {
  const row = await db
    .prepare(
      "INSERT INTO counters (name, value) VALUES ('voucher', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value",
    )
    .first();
  return `ALD-${String(row.value).padStart(6, '0')}`;
}

export async function eligibleApprovers(db, amount, initiatorId) {
  const { results } = await db
    .prepare(
      `SELECT id, username, fullName, designation, role, financialLimit FROM users
        WHERE active = 1 AND role IN ('user', 'superuser') AND id != ? AND ROUND(financialLimit * 100) >= ?
        ORDER BY financialLimit ASC, fullName ASC`,
    )
    .bind(initiatorId, cents(amount))
    .all();
  return results.map((u) => ({ ...u, financialLimit: Number(u.financialLimit) }));
}

function eventStmt(db, transactionId, action, actorId, remark = null) {
  return db
    .prepare('INSERT INTO transaction_events (id, transactionId, action, actorId, remark, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(uuid(), transactionId, action, actorId, remark, nowISO());
}

function describe(tx, symbol) {
  const what = TYPE_LABEL[tx.type];
  const where = tx.type === 'transfer' ? `${tx.account} → ${tx.toAccount}` : tx.account;
  return `${what} of ${formatMoney(tx.amount, symbol)} — “${tx.description}” (${where}, dated ${tx.date})`;
}

// ---- Validation -----------------------------------------------------------

async function validateInput(db, input, settings) {
  const type = input.type;
  if (!TYPE_LABEL[type]) fail(400, 'Type must be Expense, Receive Fund or Transfer.');
  const amount = parseAmount(input.amount);
  if (amount === null || cents(amount) <= 0) fail(400, 'Enter an amount greater than zero.');
  if (amount > MAX_AMOUNT) fail(400, 'Amount is too large.');
  const description = cleanText(input.description, 200);
  if (!description) fail(400, 'Description is required.');
  const dateParts = parseDate(input.date);
  if (!dateParts) fail(400, 'Enter a valid date (DD/MM/YYYY).');
  const account = cleanText(input.account, 80);
  if (!settings.accounts.includes(account)) fail(400, 'Choose a valid account.');
  let toAccount = null;
  let category;
  if (type === 'transfer') {
    toAccount = cleanText(input.toAccount, 80);
    if (!settings.accounts.includes(toAccount)) fail(400, 'Choose a valid destination account.');
    if (toAccount === account) fail(400, 'Source and destination accounts must differ.');
    category = 'Transfer';
  } else {
    category = cleanText(input.category, 80) || 'Needs review';
    if (!settings.categories.includes(category)) fail(400, 'Choose a valid category.');
  }
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => cleanText(t, 40)).filter(Boolean))].slice(0, 20)
    : [];
  const note = cleanText(input.note, 500) || null;
  let documentId = null;
  if (input.documentId) {
    const doc = await db.prepare('SELECT id FROM documents WHERE id = ?').bind(String(input.documentId)).first();
    if (!doc) fail(400, 'Attached document not found.');
    documentId = doc.id;
  }
  return { type, amount, description, ...dateParts, account, toAccount, category, tags, note, documentId };
}

// ---- Create ---------------------------------------------------------------

export async function createTransaction(env, user, input, { reversalOf = null, source = 'manual' } = {}) {
  const db = env.DB;
  const settings = await getSettings(db);
  const tx = await validateInput(db, input, settings);
  tx.fingerprint = fingerprintOf(tx);

  if (!input.force && !reversalOf) {
    const dup = await db
      .prepare(
        "SELECT * FROM transactions WHERE fingerprint = ? AND status NOT IN ('rejected', 'cancelled') ORDER BY initiatedAt DESC LIMIT 1",
      )
      .bind(tx.fingerprint)
      .first();
    if (dup) return { ok: false, reason: 'duplicate', existing: rowToTx(dup) };
  }

  const withinLimit = cents(tx.amount) <= cents(user.financialLimit);
  let approver = null;
  if (!withinLimit) {
    const eligible = await eligibleApprovers(db, tx.amount, user.id);
    if (!eligible.length) {
      return {
        ok: false,
        reason: 'no_approver',
        message: `No other user has a financial limit of ${formatMoney(tx.amount, settings.currency)} or more. Ask a Super User to assign a sufficient limit.`,
      };
    }
    approver = input.approverId ? eligible.find((u) => u.id === input.approverId) : eligible[0];
    if (!approver) fail(400, 'The selected approver does not have sufficient financial authority for this amount.');
  }

  if (drawsPettyCash(tx)) {
    const balance = await pettyCashBalance(db);
    if (cents(balance) < cents(tx.amount)) {
      return {
        ok: false,
        reason: 'insufficient_petty_cash',
        balance,
        shortfall: round2(tx.amount - balance),
        message: `Petty Cash balance is ${formatMoney(balance, settings.currency)} — not enough for this payment.`,
      };
    }
  }

  const now = nowISO();
  const row = {
    id: uuid(),
    voucherNo: await nextVoucherNo(db),
    date: tx.date,
    dateISO: tx.dateISO,
    description: tx.description,
    category: tx.category,
    amount: tx.amount,
    type: tx.type,
    account: tx.account,
    toAccount: tx.toAccount,
    tags: JSON.stringify(tx.tags),
    note: tx.note,
    documentId: tx.documentId,
    reversalOf,
    source,
    fingerprint: tx.fingerprint,
    status: withinLimit ? 'posted' : 'pending_approval',
    autoPosted: withinLimit ? 1 : 0,
    initiatedBy: user.id,
    initiatedAt: now,
    approverId: approver ? approver.id : null,
    decidedBy: null,
    decidedAt: null,
    decisionRemark: null,
    postedBy: withinLimit ? user.id : null,
    postedAt: withinLimit ? now : null,
    updatedAt: now,
  };

  // Posting straight away must never overdraw Petty Cash, even under a race:
  // the guard is evaluated inside the INSERT itself.
  const guard = withinLimit && drawsPettyCash(tx) ? ` WHERE ROUND(${PETTY_CASH_BALANCE_SQL} * 100) >= ?` : '';
  const binds = TX_COLUMNS.map((c) => row[c]);
  if (guard) binds.push(cents(tx.amount));
  const res = await db
    .prepare(`INSERT INTO transactions (${TX_COLUMNS.join(', ')}) SELECT ${TX_COLUMNS.map(() => '?').join(', ')}${guard}`)
    .bind(...binds)
    .run();
  if (!res.meta.changes) {
    return { ok: false, reason: 'insufficient_petty_cash', message: 'Petty Cash balance is not enough for this payment.' };
  }

  const stmts = [
    eventStmt(db, row.id, 'initiated', user.id, reversalOf ? 'Reversal entry' : null),
    ...tx.tags.map((t) => db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').bind(t, now)),
  ];
  const sym = settings.currency;
  if (withinLimit) {
    stmts.push(
      eventStmt(db, row.id, 'auto_posted', user.id, `Within own financial limit of ${formatMoney(user.financialLimit, sym)}`),
      auditStmt(db, user, 'transaction.posted', `${row.voucherNo}: ${describe(row, sym)}`),
    );
  } else {
    stmts.push(
      eventStmt(db, row.id, 'submitted', user.id, `Exceeds own limit of ${formatMoney(user.financialLimit, sym)}; routed to ${approver.fullName}`),
      notifyStmt(db, {
        userId: approver.id,
        kind: 'approval_request',
        title: `Approval required: ${row.voucherNo}`,
        body: `${user.fullName} initiated an ${describe(row, sym)}, which exceeds their financial limit of ${formatMoney(user.financialLimit, sym)}. Please review and approve or reject.`,
        transactionId: row.id,
        actionable: true,
      }),
      auditStmt(db, user, 'transaction.submitted', `${row.voucherNo} routed to ${approver.username}: ${describe(row, sym)}`),
    );
  }
  await db.batch(stmts);
  return { ok: true, outcome: withinLimit ? 'posted' : 'submitted', transaction: rowToTx(row), approver };
}

// ---- Decide (approve / reject) ---------------------------------------------

export async function decideTransaction(env, user, id, decision, remarkInput) {
  const db = env.DB;
  const remark = cleanText(remarkInput, 500) || null;
  if (decision === 'reject' && !remark) fail(400, 'Please give a reason for rejecting.');
  const tx = await loadTx(db, id);
  if (tx.status !== 'pending_approval') fail(409, 'This transaction is no longer awaiting approval.');
  if (tx.approverId !== user.id) fail(403, 'This transaction is not assigned to you for approval.');
  if (tx.initiatedBy === user.id) fail(403, 'You cannot approve your own transaction.');
  if (decision === 'approve' && cents(user.financialLimit) < cents(tx.amount)) {
    fail(403, 'This amount exceeds your current financial limit. Ask the initiator to route it to a higher authority.');
  }
  const now = nowISO();
  const newStatus = decision === 'approve' ? 'approved' : 'rejected';
  const res = await db
    .prepare(
      `UPDATE transactions SET status = ?, decidedBy = ?, decidedAt = ?, decisionRemark = ?, updatedAt = ?
        WHERE id = ? AND status = 'pending_approval' AND approverId = ?`,
    )
    .bind(newStatus, user.id, now, remark, now, id, user.id)
    .run();
  if (!res.meta.changes) fail(409, 'This transaction was changed by someone else. Refresh and try again.');

  const { currency: sym } = await getSettings(db);
  const stmts = [eventStmt(db, id, decision === 'approve' ? 'approved' : 'rejected', user.id, remark), resolveNotificationsStmt(db, user.id, id)];
  if (decision === 'approve') {
    stmts.push(
      notifyStmt(db, {
        userId: tx.initiatedBy,
        kind: 'ready_to_post',
        title: `Approved — ready for final posting: ${tx.voucherNo}`,
        body: `${user.fullName} approved your ${describe(tx, sym)}.${remark ? ` Remark: “${remark}”.` : ''} Please complete the final posting.`,
        transactionId: id,
        actionable: true,
      }),
      auditStmt(db, user, 'transaction.approved', `${tx.voucherNo}${remark ? ` — ${remark}` : ''}`),
    );
  } else {
    stmts.push(
      notifyStmt(db, {
        userId: tx.initiatedBy,
        kind: 'rejected',
        title: `Rejected: ${tx.voucherNo}`,
        body: `${user.fullName} rejected your ${describe(tx, sym)}. Reason: “${remark}”.`,
        transactionId: id,
      }),
      auditStmt(db, user, 'transaction.rejected', `${tx.voucherNo} — ${remark}`),
    );
  }
  await db.batch(stmts);
  return rowToTx(await loadTx(db, id));
}

// ---- Final posting by the initiator ------------------------------------------

export async function postTransaction(env, user, id) {
  const db = env.DB;
  const tx = await loadTx(db, id);
  if (tx.initiatedBy !== user.id) fail(403, 'Only the user who initiated this transaction can post it.');
  if (tx.status !== 'approved') fail(409, 'Only approved transactions can be posted.');
  const now = nowISO();
  const guard = drawsPettyCash(tx) ? ` AND ROUND(${PETTY_CASH_BALANCE_SQL} * 100) >= ROUND(amount * 100)` : '';
  const res = await db
    .prepare(
      `UPDATE transactions SET status = 'posted', postedBy = ?, postedAt = ?, updatedAt = ?
        WHERE id = ? AND status = 'approved' AND initiatedBy = ?${guard}`,
    )
    .bind(user.id, now, now, id, user.id)
    .run();
  const { currency: sym } = await getSettings(db);
  if (!res.meta.changes) {
    const fresh = await loadTx(db, id);
    if (fresh.status === 'approved' && drawsPettyCash(fresh)) {
      const balance = await pettyCashBalance(db);
      fail(409, `Petty Cash balance is ${formatMoney(balance, sym)} — not enough to post this payment. Fund Petty Cash first.`, {
        reason: 'insufficient_petty_cash',
        balance,
      });
    }
    fail(409, 'This transaction was changed by someone else. Refresh and try again.');
  }
  const stmts = [
    eventStmt(db, id, 'posted', user.id),
    resolveNotificationsStmt(db, user.id, id),
    auditStmt(db, user, 'transaction.posted', `${tx.voucherNo}: ${describe(tx, sym)} (after approval)`),
  ];
  if (tx.decidedBy) {
    stmts.push(
      notifyStmt(db, {
        userId: tx.decidedBy,
        kind: 'info',
        title: `Posted: ${tx.voucherNo}`,
        body: `${user.fullName} completed the final posting of the ${describe(tx, sym)} you approved.`,
        transactionId: id,
      }),
    );
  }
  await db.batch(stmts);
  return rowToTx(await loadTx(db, id));
}

// ---- Cancel (withdraw) by the initiator ----------------------------------------

export async function cancelTransaction(env, user, id, remarkInput) {
  const db = env.DB;
  const remark = cleanText(remarkInput, 500) || null;
  const tx = await loadTx(db, id);
  if (tx.initiatedBy !== user.id) fail(403, 'Only the initiator can withdraw this transaction.');
  if (!['pending_approval', 'approved'].includes(tx.status)) fail(409, 'Only unposted transactions can be withdrawn.');
  const now = nowISO();
  const res = await db
    .prepare(
      `UPDATE transactions SET status = 'cancelled', updatedAt = ? WHERE id = ? AND initiatedBy = ? AND status IN ('pending_approval', 'approved')`,
    )
    .bind(now, id, user.id)
    .run();
  if (!res.meta.changes) fail(409, 'This transaction was changed by someone else. Refresh and try again.');
  const stmts = [
    eventStmt(db, id, 'cancelled', user.id, remark),
    resolveNotificationsStmt(db, user.id, id),
    auditStmt(db, user, 'transaction.cancelled', `${tx.voucherNo}${remark ? ` — ${remark}` : ''}`),
  ];
  const other = tx.status === 'pending_approval' ? tx.approverId : tx.decidedBy;
  if (other) {
    stmts.push(
      resolveNotificationsStmt(db, other, id),
      notifyStmt(db, {
        userId: other,
        kind: 'info',
        title: `Withdrawn: ${tx.voucherNo}`,
        body: `${user.fullName} withdrew “${tx.description}”.${remark ? ` Reason: “${remark}”.` : ''} No action is needed.`,
        transactionId: id,
      }),
    );
  }
  await db.batch(stmts);
  return rowToTx(await loadTx(db, id));
}

// ---- Re-route to a different approver --------------------------------------------

export async function rerouteTransaction(env, user, id, approverId) {
  const db = env.DB;
  const tx = await loadTx(db, id);
  if (tx.initiatedBy !== user.id) fail(403, 'Only the initiator can change the approver.');
  if (tx.status !== 'pending_approval') fail(409, 'Only transactions awaiting approval can be re-routed.');
  const eligible = await eligibleApprovers(db, tx.amount, user.id);
  const approver = eligible.find((u) => u.id === approverId);
  if (!approver) fail(400, 'The selected approver does not have sufficient financial authority for this amount.');
  if (approver.id === tx.approverId) return rowToTx(tx);
  const now = nowISO();
  const res = await db
    .prepare(`UPDATE transactions SET approverId = ?, updatedAt = ? WHERE id = ? AND status = 'pending_approval' AND approverId = ?`)
    .bind(approver.id, now, id, tx.approverId)
    .run();
  if (!res.meta.changes) fail(409, 'This transaction was changed by someone else. Refresh and try again.');
  const { currency: sym } = await getSettings(db);
  await db.batch([
    eventStmt(db, id, 'rerouted', user.id, `Re-routed to ${approver.fullName}`),
    resolveNotificationsStmt(db, tx.approverId, id),
    notifyStmt(db, {
      userId: tx.approverId,
      kind: 'info',
      title: `Re-routed: ${tx.voucherNo}`,
      body: `${user.fullName} sent “${tx.description}” to another approver. No action is needed from you.`,
      transactionId: id,
    }),
    notifyStmt(db, {
      userId: approver.id,
      kind: 'approval_request',
      title: `Approval required: ${tx.voucherNo}`,
      body: `${user.fullName} initiated an ${describe(tx, sym)}, which exceeds their financial limit. Please review and approve or reject.`,
      transactionId: id,
      actionable: true,
    }),
    auditStmt(db, user, 'transaction.rerouted', `${tx.voucherNo} → ${approver.username}`),
  ]);
  return rowToTx(await loadTx(db, id));
}

// ---- Reverse a posted entry (a new entry through the same workflow) ----------------

export async function reverseTransaction(env, user, id, input = {}) {
  const db = env.DB;
  const tx = await loadTx(db, id);
  if (tx.status !== 'posted') fail(409, 'Only posted transactions can be reversed.');
  if (tx.reversalOf) fail(409, 'A reversal entry cannot itself be reversed.');
  const existing = await db
    .prepare("SELECT voucherNo FROM transactions WHERE reversalOf = ? AND status NOT IN ('rejected', 'cancelled')")
    .bind(id)
    .first();
  if (existing) fail(409, `This transaction already has a reversal entry (${existing.voucherNo}).`);
  const today = parseDate(new Date().toISOString().slice(0, 10));
  const reversed =
    tx.type === 'transfer'
      ? { type: 'transfer', account: tx.toAccount, toAccount: tx.account }
      : { type: tx.type === 'expense' ? 'receive' : 'expense', account: tx.account, category: tx.category };
  return createTransaction(
    env,
    user,
    {
      ...reversed,
      amount: tx.amount,
      date: input.date || today.date,
      description: `Reversal of ${tx.voucherNo}: ${tx.description}`.slice(0, 200),
      note: cleanText(input.note, 500) || null,
      tags: ['Reversal'],
      approverId: input.approverId,
    },
    { reversalOf: id, source: 'reversal' },
  );
}

// ---- Non-financial edits (category, tags, note) -------------------------------------

export async function patchTransaction(env, user, id, input) {
  const db = env.DB;
  const tx = await loadTx(db, id);
  const settings = await getSettings(db);
  const isOwner = tx.initiatedBy === user.id;
  if (['rejected', 'cancelled'].includes(tx.status)) fail(409, 'Closed transactions cannot be edited.');
  if (!isOwner && user.role !== 'superuser') fail(403, 'Only the initiator or a Super User can edit this transaction.');
  const sets = [];
  const binds = [];
  const changes = [];
  if (input.category !== undefined && tx.type !== 'transfer') {
    const category = cleanText(input.category, 80);
    if (!settings.categories.includes(category)) fail(400, 'Choose a valid category.');
    if (category !== tx.category) {
      sets.push('category = ?');
      binds.push(category);
      changes.push(`category ${tx.category} → ${category}`);
    }
  }
  let newTags = [];
  if (input.tags !== undefined) {
    newTags = Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => cleanText(t, 40)).filter(Boolean))].slice(0, 20) : [];
    sets.push('tags = ?');
    binds.push(JSON.stringify(newTags));
    changes.push(`tags [${newTags.join(', ')}]`);
  }
  if (input.note !== undefined) {
    sets.push('note = ?');
    binds.push(cleanText(input.note, 500) || null);
    changes.push('note updated');
  }
  if (!sets.length) return rowToTx(tx);
  const now = nowISO();
  await db.batch([
    db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`).bind(...binds, now, id),
    ...newTags.map((t) => db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').bind(t, now)),
    eventStmt(db, id, 'edited', user.id, changes.join('; ')),
  ]);
  return rowToTx(await loadTx(db, id));
}

export async function transactionEvents(db, id) {
  const { results } = await db
    .prepare(
      `SELECT e.action, e.remark, e.at, u.fullName AS actorName, u.username AS actorUsername
         FROM transaction_events e LEFT JOIN users u ON u.id = e.actorId
        WHERE e.transactionId = ? ORDER BY e.at ASC, e.rowid ASC`,
    )
    .bind(id)
    .all();
  return results;
}

// Which transactions a financial user can see: every posted entry (it is the
// company ledger), plus any unposted item they initiated, were asked to approve,
// or decided. Super Users see everything.
export async function visibleTransactions(db, user) {
  const base = 'SELECT * FROM transactions';
  const order = ' ORDER BY dateISO DESC, initiatedAt DESC LIMIT 20000';
  const stmt =
    user.role === 'superuser'
      ? db.prepare(base + order)
      : db
          .prepare(`${base} WHERE status = 'posted' OR initiatedBy = ? OR approverId = ? OR decidedBy = ?${order}`)
          .bind(user.id, user.id, user.id);
  const { results } = await stmt.all();
  return results.map(rowToTx);
}
