#!/usr/bin/env node
// Switch on phone browser notifications for the Ledger Book.
//
//   node scripts/setup-push.mjs           # Live server (wrangler.toml)
//   node scripts/setup-push.mjs --test    # Test server (wrangler.test.toml)
//
// Creates a VAPID key pair once and keeps it in .push-keys.json (git-ignored,
// never commit or share it), then stores VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// and VAPID_SUBJECT as Worker secrets. Safe to run again: existing secrets are
// kept unless --force is given. Changing the keys later would switch
// notifications off on every phone until each person turns them on again.
import { webcrypto as crypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const test = process.argv.includes('--test');
const force = process.argv.includes('--force');
const cfgArgs = test ? ['-c', 'wrangler.test.toml'] : [];
const KEY_FILE = '.push-keys.json';
const label = test ? 'TEST server' : 'LIVE server';

if (test && !existsSync('wrangler.test.toml')) {
  console.error('✖ wrangler.test.toml not found. Run "npm.cmd run test-server" first.');
  process.exit(1);
}

const run = (args, input) =>
  spawnSync('npx', ['--yes', 'wrangler', ...args, ...cfgArgs], {
    shell: true,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
  });

const ask = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// 1. Keys: reuse the saved pair so phones that already subscribed keep working.
let keys = existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, 'utf8')) : null;
if (!keys) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  let email = await ask('Contact email for the push services (e.g. it@alidada.com): ');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) email = 'admin@alidada.example';
  keys = { publicKey, privateKey, subject: `mailto:${email}`, createdAt: new Date().toISOString() };
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2));
  console.log(`✔ New notification keys created and saved in ${KEY_FILE} (keep this file private).`);
} else {
  console.log(`✔ Using the notification keys saved in ${KEY_FILE}.`);
}

// 2. Secrets on the chosen server.
console.log(`\n▶ Checking the ${label}…`);
const list = run(['secret', 'list']);
if (list.status !== 0) {
  console.error(`✖ Could not read the ${label}'s secrets. Is it deployed, and are you signed in (npx.cmd wrangler login)?`);
  process.exit(1);
}
const existing = list.stdout || '';
for (const [name, value] of [
  ['VAPID_PUBLIC_KEY', keys.publicKey],
  ['VAPID_PRIVATE_KEY', keys.privateKey],
  ['VAPID_SUBJECT', keys.subject],
]) {
  if (!force && existing.includes(`"${name}"`)) {
    console.log(`  ${name} already set — keeping it`);
    continue;
  }
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    if (attempt > 1) console.log(`  Retrying ${name} (attempt ${attempt} of 3)…`);
    ok = run(['secret', 'put', name], value).status === 0;
  }
  if (!ok) {
    console.error(`✖ Could not set ${name} (network problem?). Run this script again — it picks up where it stopped.`);
    process.exit(1);
  }
  console.log(`  ${name} set`);
}

console.log(`\n✔ Phone notifications are switched on for the ${label}.`);
console.log('  Each person now opens Settings → Phone notifications on their phone and taps "Turn on".');
