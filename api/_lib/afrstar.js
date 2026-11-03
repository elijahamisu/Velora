// Afrstar Nigeria Payment API v2 client (server only).
//
// Credentials come from Vercel env vars AFRSTAR_MERCHANT_SN / _AK / _SK and
// never leave the server: nothing here is imported by browser code, and no
// function returns or logs a key.
//
// Signing: md5 of the parameter values concatenated in the endpoint's exact
// order, no separators, 32-char lowercase hex. Amounts are always two-decimal
// strings ("500.00").
import crypto from 'node:crypto';

export const AFRSTAR_BASE = 'https://ngn.afrstar.com';

// Merchant order-number prefixes. Callbacks route on these.
export const PREFIX = {
  USER_DEPOSIT: 'ALXD',      // user wallet deposit (payin)   -> deposits
  ADMIN_TOPUP: 'ALXAT',      // admin funds the gateway (payin) -> gateway_admin_transactions
  USER_WITHDRAWAL: 'ALXW',   // user withdrawal (payout)       -> withdrawals
  ADMIN_PAYOUT: 'ALXAP',     // admin withdraws gateway funds -> gateway_admin_transactions
};

// Fee the admin accounts for when withdrawing gateway funds to a bank.
export const ADMIN_PAYOUT_FEE_PCT = 11;

const ENV_KEYS = ['AFRSTAR_MERCHANT_SN', 'AFRSTAR_MERCHANT_AK', 'AFRSTAR_MERCHANT_SK'];

/** Reads the merchant config. Never throws; reports missing names only. */
export function getConfig(env = process.env) {
  const missing = ENV_KEYS.filter(k => !String(env[k] || '').trim());
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: `Payment gateway is not configured: missing ${missing.join(', ')} in the server environment.`,
    };
  }
  return {
    ok: true,
    sn: String(env.AFRSTAR_MERCHANT_SN).trim(),
    ak: String(env.AFRSTAR_MERCHANT_AK).trim(),
    sk: String(env.AFRSTAR_MERCHANT_SK).trim(),
  };
}

/** Two-decimal string for a money value ("500" -> "500.00"). Throws on junk. */
/** Deposit mode from a site_settings row: 'manual' | 'gateway'.
 *  deposit_mode is the switch on admin/gateway.html; payment_mode is the
 *  legacy column (kept in sync by a DB trigger) used only as a fallback. */
export function depositMode(settings) {
  const m = settings?.deposit_mode ?? settings?.payment_mode;
  return m === 'gateway' ? 'gateway' : 'manual';
}

export function money(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${value}`);
  // Round half away from zero at the cent, avoiding binary float drift.
  const cents = Math.round((Math.abs(n) + Number.EPSILON) * 100) * Math.sign(n);
  return (cents / 100).toFixed(2);
}

/** Round to cents as a number. */
export function cents(value) {
  return Number(money(value));
}

export function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

/** md5 of values concatenated in order (null/undefined become ''). */
export function signValues(...values) {
  return md5(values.map(v => (v === null || v === undefined ? '' : String(v))).join(''));
}

export const sign = {
  payin: (c, orderSn, amount) => signValues(c.ak, orderSn, money(amount), c.sk),
  payout: (c, orderSn, account, upiHandle, amount) => signValues(c.ak, orderSn, account, upiHandle ?? '', money(amount), c.sk),
  balance: (c) => signValues(c.ak, c.sk),
  payinCallback: (c, platformOsn, status, originalAmount) => signValues(c.ak, platformOsn, status, money(originalAmount), c.sk),
  payoutCallback: (c, platformOsn, status, amount) => signValues(c.ak, platformOsn, status, money(amount), c.sk),
};

/** Constant-time compare of two hex signatures. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '').toLowerCase());
  const y = Buffer.from(String(b || '').toLowerCase());
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Unique merchant order number (<= 64 chars), e.g. ALXD-20261103085412-9F3A1C7B. */
export function makeOrderSn(prefix, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${prefix}-${ts}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Which flow an order number belongs to, from its prefix. */
export function orderKind(orderSn) {
  const s = String(orderSn || '');
  // Longest prefixes first (ALXAT/ALXAP before ALXD/ALXW is fine since they differ at char 4).
  for (const [kind, prefix] of Object.entries(PREFIX)) {
    if (s.startsWith(prefix + '-')) return kind;
  }
  return null;
}

/**
 * POST JSON to the gateway. Resolves (never rejects) to
 *   { ok: true, data }                         on code 0
 *   { ok: false, definitive: true, message }   gateway answered with an error
 *   { ok: false, definitive: false, message }  no usable answer (timeout, network, non-JSON)
 * `definitive: false` on a payout means the order may or may not exist.
 */
export async function post(path, body, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetchImpl(`${AFRSTAR_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
    return { ok: false, definitive: false, message: aborted ? `No response from the gateway within ${Math.round(timeoutMs / 1000)}s.` : `Could not reach the gateway: ${err.message}` };
  }
  clearTimeout(timer);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json || typeof json !== 'object') {
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // A 4xx with a body is the gateway refusing us (e.g. IP not whitelisted).
    const definitive = res.status >= 400 && res.status < 500;
    return { ok: false, definitive, httpStatus: res.status, message: `Gateway returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}` };
  }
  if (Number(json.code) === 0) return { ok: true, data: json.data || {}, message: json.message };
  return {
    ok: false,
    definitive: true,
    httpStatus: res.status,
    code: json.code,
    message: `Gateway error${json.code !== undefined ? ` ${json.code}` : ''}: ${json.message || json.msg || 'request refused'}`,
  };
}

export async function createPayin(c, { orderSn, amount, name, email, phone, remark, redirectUrl }, opts) {
  const body = {
    merchant_sn: c.sn,
    order_sn: orderSn,
    amount: money(amount),
    name: String(name || '').slice(0, 100),
    email: String(email || ''),
    phone: String(phone || ''),
    remark: String(remark || 'Payment').slice(0, 100),
    redirect_url: redirectUrl,
  };
  body.sign = sign.payin(c, orderSn, body.amount);
  return post('/gateway/payin/', body, opts);
}

export async function createPayout(c, { orderSn, amount, name, account, bankCode, remark }, opts) {
  const body = {
    merchant_sn: c.sn,
    order_sn: orderSn,
    amount: money(amount),
    type: 'bank',
    name: String(name || '').slice(0, 100),
    account: String(account || ''),
    ifsc: String(bankCode || ''),
    upi_handle: '',
    remark: String(remark || 'Payout').slice(0, 100),
  };
  body.sign = sign.payout(c, orderSn, body.account, body.upi_handle, body.amount);
  return post('/gateway/payout/', body, opts);
}

export async function getBalance(c, opts) {
  return post('/gateway/balance/', { merchant_sn: c.sn, sign: sign.balance(c) }, opts);
}

/** Best-effort public egress IP of this function (helps whitelisting with Afrstar). */
export async function egressIp({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetchImpl('https://api.ipify.org?format=json', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j.ip || null;
  } catch { return null; }
}

/** Callback bodies are JSON, but tolerate form-encoded or raw strings. */
export function parseCallbackBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    const s = b.trim();
    try { return JSON.parse(s); } catch { /* fall through */ }
    return Object.fromEntries(new URLSearchParams(s));
  }
  return b && typeof b === 'object' ? b : {};
}

/** Plain-text reply with no trailing newline (gateway wants exactly "success"). */
export function replyText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/** Public base URL for redirect links. */
export function siteBaseUrl(req, env = process.env) {
  if (env.PUBLIC_SITE_URL) return String(env.PUBLIC_SITE_URL).replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'altivex-invest.vercel.app';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}
