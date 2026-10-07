// Phone browser notifications (Web Push, VAPID).
//
// The push carries no payload: it only wakes the device's service worker
// (public/sw.js), which then fetches the user's newest message from
// /api/notifications/latest over their own signed-in session. So message
// text never passes through the browser vendor's push service, and no
// payload encryption is needed.
//
// Keys: VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point),
// VAPID_PRIVATE_KEY (base64url, 32-byte scalar) and VAPID_SUBJECT (mailto:)
// are Worker secrets created by scripts/setup-push.mjs.
import { fail, uuid, nowISO, cleanText } from './util.js';
import { auditStmt } from './db.js';

const enc = new TextEncoder();
const toB64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export const pushConfigured = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

let signingKey = null;
async function vapidKey(env) {
  if (signingKey) return signingKey;
  const pub = fromB64u(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a valid P-256 public key.');
  signingKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: toB64u(pub.slice(1, 33)), y: toB64u(pub.slice(33, 65)), d: String(env.VAPID_PRIVATE_KEY).trim(), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return signingKey;
}

async function vapidAuthorization(env, endpoint) {
  const b64json = (o) => toB64u(enc.encode(JSON.stringify(o)));
  const header = b64json({ typ: 'JWT', alg: 'ES256' });
  const claims = b64json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: cleanText(env.VAPID_SUBJECT, 200) || 'mailto:admin@alidada.example',
  });
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(env), enc.encode(unsigned));
  return `vapid t=${unsigned}.${toB64u(sig)}, k=${String(env.VAPID_PUBLIC_KEY).trim()}`;
}

// Wake one device. Returns 'ok' | 'gone' (subscription expired) | 'error:<status>'.
async function sendPush(env, endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuthorization(env, endpoint), TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    return `error:${res.status}`;
  } catch (err) {
    return `error:${err && err.name === 'TimeoutError' ? 'timeout' : 'network'}`;
  }
}

// Send to every device a user has turned alerts on for. Expired devices are removed.
async function pushToUser(env, userId) {
  const db = env.DB;
  const { results: subs } = await db.prepare('SELECT id, endpoint FROM push_subscriptions WHERE userId = ?').bind(userId).all();
  if (!subs.length) return { status: 'no_device', detail: 'No device has phone notifications turned on.' };
  const outcomes = await Promise.all(subs.map((s) => sendPush(env, s.endpoint)));
  let ok = 0;
  const errors = [];
  const now = nowISO();
  const stmts = [];
  outcomes.forEach((o, i) => {
    if (o === 'ok') {
      ok++;
      stmts.push(db.prepare('UPDATE push_subscriptions SET lastOkAt = ? WHERE id = ?').bind(now, subs[i].id));
    } else if (o === 'gone') {
      stmts.push(db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(subs[i].id));
      errors.push('expired device removed');
    } else errors.push(o);
  });
  if (stmts.length) await db.batch(stmts);
  const detail = `${ok} of ${subs.length} device${subs.length > 1 ? 's' : ''} reached${errors.length ? ` (${errors.join(', ')})` : ''}`;
  return { status: ok ? 'sent' : 'failed', detail };
}

// Deliver phone alerts for messages created in the last hour that have not
// been pushed yet. Runs after each change (ctx.waitUntil); a row is claimed
// with a conditional UPDATE so two requests never push the same message twice.
export async function dispatchPendingPush(env) {
  const db = env.DB;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare("SELECT id, userId FROM notifications WHERE pushStatus = 'pending' AND createdAt > ? ORDER BY createdAt LIMIT 50")
    .bind(since)
    .all();
  if (!results.length) return;
  if (!pushConfigured(env)) {
    await db.batch(
      results.map((n) =>
        db.prepare("UPDATE notifications SET pushStatus = 'skipped', pushDetail = ? WHERE id = ? AND pushStatus = 'pending'").bind('Phone notifications are not set up on this server.', n.id),
      ),
    );
    return;
  }
  for (const n of results) {
    const claim = await db.prepare("UPDATE notifications SET pushStatus = 'sending' WHERE id = ? AND pushStatus = 'pending'").bind(n.id).run();
    if (!claim.meta.changes) continue;
    let out;
    try {
      out = await pushToUser(env, n.userId);
    } catch (err) {
      out = { status: 'failed', detail: String(err && err.message ? err.message : err).slice(0, 200) };
    }
    await db.prepare('UPDATE notifications SET pushStatus = ?, pushDetail = ? WHERE id = ?').bind(out.status, out.detail, n.id).run();
  }
}

// ---- API handlers -----------------------------------------------------------------

export function pushPublicKey(env) {
  return pushConfigured(env) ? String(env.VAPID_PUBLIC_KEY).trim() : null;
}

export async function subscribe(env, user, body, userAgent) {
  if (!pushConfigured(env)) fail(501, 'Phone notifications are not set up on this server yet.');
  const endpoint = cleanText(body?.endpoint, 1000);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail(400, 'Invalid push subscription.');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && env.APP_ENV !== 'production' && env.ALLOW_LOCAL_PUSH === 'true')) {
    fail(400, 'Invalid push subscription.');
  }
  const device = describeDevice(userAgent);
  const now = nowISO();
  // The same endpoint signing in as someone else moves to that person.
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO push_subscriptions (id, userId, endpoint, p256dh, auth, device, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET userId = excluded.userId, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`,
      )
      .bind(uuid(), user.id, endpoint, cleanText(body?.keys?.p256dh, 200) || null, cleanText(body?.keys?.auth, 100) || null, device, now),
    auditStmt(env.DB, user, 'push.enabled', device),
  ]);
  return { device };
}

export async function unsubscribe(env, user, body) {
  const endpoint = cleanText(body?.endpoint, 1000);
  if (endpoint) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND userId = ?').bind(endpoint, user.id).run();
}

export async function myDevices(env, user) {
  const { results } = await env.DB
    .prepare('SELECT id, device, createdAt, lastOkAt FROM push_subscriptions WHERE userId = ? ORDER BY createdAt DESC')
    .bind(user.id)
    .all();
  return results;
}

// What the service worker shows when woken: the user's newest unread message.
export async function latestForDevice(env, user) {
  const n = await env.DB
    .prepare('SELECT id, title, body, transactionId FROM notifications WHERE userId = ? AND read = 0 ORDER BY createdAt DESC LIMIT 1')
    .bind(user.id)
    .first();
  if (!n) return null;
  const body = String(n.body || '');
  return { tag: n.id, title: n.title, body: body.length > 220 ? `${body.slice(0, 217)}…` : body, url: '/#/messages' };
}

// Admin / user check: push straight away to one person's devices.
export async function sendTest(env, actor, userId) {
  if (!pushConfigured(env)) fail(501, 'Phone notifications are not set up on this server yet.');
  const target = await env.DB.prepare('SELECT id, fullName FROM users WHERE id = ?').bind(userId).first();
  if (!target) fail(404, 'User not found.');
  const now = nowISO();
  const id = uuid();
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO notifications (id, userId, kind, title, body, actionable, read, pushStatus, createdAt) VALUES (?, ?, 'info', ?, ?, 0, 0, 'sending', ?)",
      )
      .bind(id, target.id, 'Test notification', `Phone notifications are working. Sent by ${actor.fullName}.`, now),
    auditStmt(env.DB, actor, 'push.test', target.fullName),
  ]);
  const out = await pushToUser(env, target.id);
  await env.DB.prepare('UPDATE notifications SET pushStatus = ?, pushDetail = ? WHERE id = ?').bind(out.status, out.detail, id).run();
  return out;
}

export async function deliveryLog(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT n.createdAt, n.title, n.pushStatus, n.pushDetail, u.fullName AS userName FROM notifications n
         LEFT JOIN users u ON u.id = n.userId WHERE n.pushStatus IS NOT NULL ORDER BY n.createdAt DESC LIMIT 50`,
    )
    .all();
  const { results: devices } = await env.DB
    .prepare('SELECT u.fullName AS userName, COUNT(p.id) AS devices FROM users u LEFT JOIN push_subscriptions p ON p.userId = u.id WHERE u.active = 1 GROUP BY u.id ORDER BY u.fullName')
    .all();
  return { log: results, devices };
}

function describeDevice(ua = '') {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}
