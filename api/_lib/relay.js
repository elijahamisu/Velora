// Afrstar relay for sister sites that share this Afrstar merchant account (e.g. TOP).
// A client signs each request with
// HMAC-SHA256(secret, `${ts}.${rawBody}`) in X-Relay-Signature, X-Relay-Ts and X-Relay-Client.
// Callbacks for orders starting with a client's order_prefix are forwarded to its
// callback_url, signed the same way, and the client's plain-text reply is returned to Afrstar.
import crypto from 'node:crypto';
// Clients come from the env var AFRSTAR_RELAY_CLIENTS, a JSON array of
// { name, secret, order_prefix, callback_url } (kept out of the database so the
// relay works even when this site's Supabase project is paused).
export async function relayClients() {
  // AFRSTAR_RELAY_CLIENTS (e.g. TOP) plus AFRSTAR_RELAY_CLIENTS_EXTRA (e.g. Amisytech), both JSON arrays.
  const read = (key) => {
    try { const rows = JSON.parse(process.env[key] || '[]'); return Array.isArray(rows) ? rows : []; }
    catch { console.error(key + ' is not valid JSON'); return []; }
  };
  return [...read('AFRSTAR_RELAY_CLIENTS'), ...read('AFRSTAR_RELAY_CLIENTS_EXTRA')]
    .filter(r => r && r.name && r.secret && r.order_prefix && r.callback_url && r.active !== false);
}
export const hmac = (secret, ts, raw) => crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
export function hmacOk(secret, ts, raw, sig) {
  const a = Buffer.from(hmac(secret, ts, raw)), b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export async function clientForOrder(orderSn) {
  const s = String(orderSn || '');
  return (await relayClients()).find(c => c.order_prefix && s.startsWith(c.order_prefix)) || null;
}
/** Forward a raw callback to the client. Returns { status, text }. */
export async function forwardCallback(client, kind, body) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const url = `${client.callback_url}${client.callback_url.includes('?') ? '&' : '?'}type=${kind}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Ts': ts, 'X-Relay-Signature': hmac(client.secret, ts, raw) },
      body: raw, signal: AbortSignal.timeout(4500),
    });
    const text = (await r.text()).trim();
    return { status: r.status, text: r.status === 200 && /^success$/i.test(text) ? 'success' : (text || 'error') };
  } catch (e) {
    console.error('relay forward failed', client.name, e.message);
    return { status: 502, text: 'relay error' };
  }
}
