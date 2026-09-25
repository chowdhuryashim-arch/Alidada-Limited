# ALIDADA Limited — Ledger Book

A private, multi-user business ledger for **ALIDADA Limited**. It has delegated financial limits and a maker-checker approval workflow. It runs on **Cloudflare Workers + D1 (+ R2)** and is built on the concepts in the *LedgerBook Master Development Prompt*: one Worker serves both the SPA and the API, auth is checked before any file is served, nothing is seeded, the dashboard and statement look the same as LedgerBook, there is a duplicate caution, Petty Cash can never be overdrawn, and backup/restore is included.

The company name is shown on every page: login, setup, app shell (sidebar and the top-bar eyebrow on every screen), every dialog, the Help manual and the printed statement. The Worker stamps it into the HTML from the `COMPANY_NAME` variable.

## Roles

| Role | Financial authority | What they do |
|---|---|---|
| **Admin** | **None** | Creates Users and Super Users, edits roles and designations, enables and disables accounts, resets passwords, views the audit trail. Cannot enter, approve or post transactions, and cannot assign limits. |
| **Super User** | Their delegated limit | Everything a User does. Also the **only role that can assign financial limits** (to Users and other Super Users, never to themselves). Also manages budgets, categories, accounts and currency, and runs backup/restore. |
| **User** | Their delegated limit | Initiates transactions, approves other people's transactions up to their own limit, and does final posting of their approved transactions. |

A new account starts with a limit of 0, so everything it initiates goes for approval until a Super User delegates a limit.

## Transaction workflow

```
User initiates (Expense / Receive Fund / Transfer)
  │
  ├─ amount ≤ own limit ──► POSTED immediately
  │
  └─ amount > own limit ──► PENDING APPROVAL, routed to an eligible approver
                             (limit ≥ amount, not the initiator; defaults to the
                              lowest sufficient limit; the initiator may pick another)
                             ✉ message to the approver: "Approval required"
                                 │
                   ┌─────────────┴─────────────┐
                 reject (reason required)    approve (optional remark)
                   │                           │
                   ▼                           ▼
                REJECTED                    APPROVED, back to the initiator
                ✉ message to initiator      ✉ message to initiator: "Ready for final posting"
                                                │
                                                ▼
                                   initiator does FINAL POSTING ──► POSTED
```

- **Messages.** Every hand-off produces an in-app message for the person who has to act next. The bell and sidebar badges show unread and pending counts, the app checks every 30 s, and "Action needed" messages clear automatically once acted on.
- The initiator can **withdraw** an unposted entry or **change the approver**. If an approver is disabled, everyone waiting on them is told to re-route.
- Posted entries are never edited or deleted. A **reversal** creates a new opposite entry that goes through the same limit rules.
- Only **posted** entries count toward totals, balances, budgets and statements.
- Terminology follows the brief: **Description** replaces *Merchant*, and **Receive Fund** replaces *Income*.

## Features

- Dashboard: period selector; funds received, expenses, net, Petty Cash and "my limit" cards; cash-flow and expense-by-category charts; account balances; approval and posting alerts
- Transactions: search and filters (status, type, account, category, period), CSV export, and a detail view with the full approval trail
- Approvals: Awaiting my approval, Ready for my final posting, My requests, and (for Super Users) everything still unposted in the company
- Financial Limits page (Super Users) with limit history
- Users page (Admin) and an Audit Trail (Admin and Super Users)
- Budgets, Documents (R2 voucher attachments), and tags, categories and accounts
- Printable **Ledger Statement** showing the company name, credit/debit/net/Petty Cash boxes (plus opening and closing balance for a single account), Debit/Credit columns, a category summary and signature lines
- Petty Cash: a protected system account whose balance comes from the ledger. It can never go negative; this is checked when an entry is made and again at final posting.
- Light and dark themes, a mobile layout with a bottom tab bar, and an in-app Help manual at `/help`

## Deploy to Cloudflare

**One command:** with `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit, Account Settings:Read) and `CLOUDFLARE_ACCOUNT_ID` set, or after `npx wrangler login`, run:

```bash
./scripts/deploy.sh
```

It creates or reuses the D1 database, writes its id into `wrangler.toml`, applies the schema, creates the R2 bucket (and deploys without documents if R2 is unavailable), deploys the Worker, and sets `SESSION_SECRET` and `BOOTSTRAP_KEY`. These come from the environment if set; otherwise they are generated and saved to the git-ignored `.deploy-secrets`. It is safe to re-run.

**Manual steps**, if you prefer:

```bash
npm install
npx wrangler login
npx wrangler d1 create alidada-ledger-db        # copy the database_id into wrangler.toml
npx wrangler r2 bucket create alidada-ledger-docs  # optional; remove the [[r2_buckets]] block if R2 is not enabled
npx wrangler secret put SESSION_SECRET           # a long random string
npx wrangler secret put BOOTSTRAP_KEY            # the one-time key used on /setup
npm run deploy
```

The Worker is named `alidada`, so it is served at `https://alidada.<your-account-subdomain>.workers.dev` (for this account, `https://alidada.ashimchy.workers.dev`). To use your own domain instead (e.g. `ledger.alidada.com`), add the domain to Cloudflare and then attach it under Workers → alidada → Settings → Domains & Routes.

Then open the Worker URL. You will be sent to **/setup**. Enter the `BOOTSTRAP_KEY` and create the Admin. Setup works only while no account exists.

After that, the Admin creates at least two Super Users, so they can assign each other's limits, and then the Users. Each person sets their own password at first sign-in.

The schema is created automatically on first request. `npm run db:init:remote` applies `schema/schema.sql` explicitly if you prefer.

## Test server

A separate copy of the app for trying things out, with its **own address** (`https://alidada-test.<subdomain>.workers.dev`), its **own empty database** (`alidada-ledger-test-db`) and document bucket, and an orange **TEST SERVER** banner on every page. The company name reads "ALIDADA Limited (TEST)" on screens and printed statements. Nothing here touches the live server or live data.

On Windows (PowerShell), from the project folder:

```
npm run test-server          # create or update the test server (safe to repeat)
npm run test-server:reset    # delete ALL test data and start again from /setup
```

The script creates the test database, writes a git-ignored `wrangler.test.toml`, creates the tables, deploys `alidada-test`, and sets its keys. It prints the test setup key, which is also saved in the git-ignored `.test-secrets`. After changing code, run `npm run test-server` again to put the new version on the test server first. When it looks right, run `npx wrangler deploy` to update live.

## Local development and tests

```bash
cp .dev.vars.example .dev.vars    # set BOOTSTRAP_KEY=local-setup-key for the test
rm -rf .wrangler/state            # the workflow test expects a fresh database
npm run dev                       # http://127.0.0.1:8787
npm test                          # in another terminal
```

`test/workflow.test.js` runs through the whole business process against the running Worker:
- setup, roles and permissions, and limit delegation rules
- auto-posting, routing, approve/reject, and initiator-only final posting
- messages, duplicate caution, the no-approver case, and Petty Cash overdraft protection
- disabling a user and re-routing, visibility rules, reversals, backup/restore, and the audit trail

## Layout

```
src/index.js     Worker entry: routing, auth gate, HTML company-name stamping, settings, documents, backup
src/auth.js      PBKDF2 password hashing, HMAC-signed session cookies
src/ledger.js    Transaction workflow: limits, routing, approve/reject/post/withdraw/reroute/reverse
src/users.js     Admin user management; Super User limit delegation
src/db.js        Schema bootstrap, settings, audit and message helpers
schema/schema.sql
public/          index.html + app.js + app.css (SPA), login.html, setup.html, help.html
test/            End-to-end workflow test
```

## Security notes

- Passwords are stored as PBKDF2-SHA256 hashes (100k iterations). Sessions are HMAC-signed, HttpOnly, Secure, SameSite=Lax cookies that last 30 days. Every request re-checks the user in D1, so disabling a user, resetting their password or changing their role takes effect immediately.
- Five failed sign-ins in 15 minutes lock that username for 15 minutes. Cross-origin writes are refused.
- Every state change in the workflow is a single conditional SQL statement, for example `UPDATE … WHERE status = 'pending_approval' AND approverId = ?`, so two people acting at the same moment cannot both succeed. The Petty Cash balance check runs inside the same statement that posts.
- Backups contain ledger data only. Users and passwords are never included.

## Differences from the LedgerBook master prompt

- **One shared company ledger** instead of a separate database per user. A business book must be common to everyone who records in it, so users are separated by role and financial limit rather than by database.
- Personal-finance features (Goals, Recurring and Subscription detection, Net worth) and the Google Drive daily import and backup automations are not included in this first version. They can be added later on the same architecture.
- Backups include document *records* but not the R2 file bytes.
- Messages are in-app. E-mail or SMS alerts could be added later through a mail provider.
