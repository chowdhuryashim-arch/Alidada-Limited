// Shared helpers: responses, errors, ids, dates, money.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function fail(status, message, extra = {}) {
  throw new HttpError(status, message, extra);
}

export async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) fail(415, 'Expected a JSON request body.');
  try {
    return (await request.json()) ?? {};
  } catch {
    fail(400, 'Malformed JSON body.');
  }
}

export const uuid = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();

export function cleanText(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// ---- Money --------------------------------------------------------------
// Amounts are stored as REAL rounded to 2dp. All comparisons go through
// integer minor units so 0.1 + 0.2 style drift can never flip an approval.
export const cents = (n) => Math.round(Number(n) * 100);
export const round2 = (n) => cents(n) / 100;

export function parseAmount(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

export function formatMoney(amount, symbol = '৳') {
  const n = Number(amount) || 0;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol} ${s}`;
}

// ---- Dates --------------------------------------------------------------
// Accepts DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD. Returns { date, dateISO } or null.
export function parseDate(value) {
  const s = cleanText(value, 20);
  let d, m, y;
  let match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) [, d, m, y] = match;
  else if ((match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [, y, m, d] = match;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return { date: `${dd}-${mm}-${y}`, dateISO: `${y}-${mm}-${dd}` };
}

export function todayParts() {
  return parseDate(new Date().toISOString().slice(0, 10));
}
