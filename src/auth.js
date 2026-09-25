// Password hashing (PBKDF2-SHA256, 100k iterations) and HMAC-signed sessions.

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
export const SESSION_COOKIE = 'adl_session';
const SESSION_DAYS = 30;

const toB64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function randomSalt() {
  return toB64u(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toB64u(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, salt, expectedHash) {
  return timingSafeEqual(await hashPassword(password, salt), expectedHash);
}

export function validatePassword(password) {
  const p = String(password ?? '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must contain letters and numbers.';
  return null;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(secret, payload) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${toB64u(sig)}`;
}

export async function readSession(secret, cookieHeader) {
  const raw = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64u(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function newSessionPayload(user) {
  return { uid: user.id, sv: user.sessionVersion, exp: Date.now() + SESSION_DAYS * 86400 * 1000 };
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
