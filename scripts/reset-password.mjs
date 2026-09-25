#!/usr/bin/env node
// Emergency password reset, run from your own computer with Cloudflare access.
// Use it when the Admin has forgotten their password (the Admin cannot be reset
// from inside the app). Works for any username.
//
//   node scripts/reset-password.mjs            # live database
//   node scripts/reset-password.mjs --local    # local dev database
//
// It asks for the username and a new password, hashes the password exactly as
// the app does (PBKDF2-SHA256, 100k iterations), updates that user in D1, and
// signs them out everywhere. The password itself is never written anywhere.
import { webcrypto as crypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const DB_NAME = 'alidada-ledger-db';
const local = process.argv.includes('--local');

// One shared reader for every question (a reader per question would swallow
// the answers still waiting in the input).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let masking = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (!masking) return write(s);
  if (s.includes('\n') || s.includes('\r')) return write('\n');
  if (s.length === 1 || /^\*+$/.test(s)) return write('*');
};
const lines = [];
let waiting = null;
rl.on('line', (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
rl.on('close', () => waiting && waiting(''));
function ask(question, hidden = false) {
  process.stdout.write(question);
  masking = hidden && process.stdin.isTTY;
  return new Promise((resolve) => {
    const done = (answer) => {
      masking = false;
      resolve(answer);
    };
    if (lines.length) done(lines.shift());
    else waiting = done;
  });
}

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return b64u(bits);
}

const username = (await ask('Username to reset [admin]: ')).trim().toLowerCase() || 'admin';
if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
  console.error('✖ That is not a valid username.');
  process.exit(1);
}
const pw = await ask('New password: ', true);
if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
  console.error('✖ Password must be at least 8 characters, with letters and numbers.');
  process.exit(1);
}
if ((await ask('Confirm new password: ', true)) !== pw) {
  console.error('✖ The passwords do not match.');
  process.exit(1);
}

rl.close();
const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
const hash = await hashPassword(pw, salt);
const now = new Date().toISOString();
// Values are base64url / ISO / validated username only, so they are safe inside SQL quotes.
const sql = `UPDATE users SET passwordHash = '${hash}', passwordSalt = '${salt}', mustChangePassword = 0, active = 1,
  sessionVersion = sessionVersion + 1, updatedAt = '${now}' WHERE username = '${username}';
INSERT INTO audit_log (id, actorId, actorName, action, detail, at)
  SELECT '${crypto.randomUUID()}', NULL, 'console', 'user.password_reset', '${username} (reset from console)', '${now}'
  WHERE EXISTS (SELECT 1 FROM users WHERE username = '${username}');
SELECT username, fullName, role, active FROM users WHERE username = '${username}';
`;

const dir = mkdtempSync(join(tmpdir(), 'adl-'));
const file = join(dir, 'reset.sql');
writeFileSync(file, sql);
console.log(`\nUpdating "${username}" in ${local ? 'the LOCAL' : 'the LIVE'} database ${DB_NAME}…`);
const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', `--file="${file}"`, '--yes'], {
  stdio: 'inherit',
  shell: true,
});
unlinkSync(file);
if (res.status !== 0) {
  console.error('\n✖ The update failed — see the message above. Nothing was changed.');
  process.exit(1);
}
console.log(`\n✔ Done. If a row for "${username}" is listed above, sign in with the new password.`);
console.log('  If no row is listed, that username does not exist — run: npx wrangler d1 execute alidada-ledger-db --remote --command "SELECT username, role FROM users"');
