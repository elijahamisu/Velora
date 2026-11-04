// POST /api/relay/afrstar  (sister-site relay, see api/_lib/relay.js)
// Body: { op: 'payin'|'payout'|'balance'|'verify', ... }  Signed with the client's relay secret.
import { getConfig, createPayin, createPayout, getBalance, sign, safeEqual, egressIp } from '../_lib/afrstar.js';
import { relayClients, hmacOk } from '../_lib/relay.js';

export const config = { api: { bodyParser: false } };
async function rawBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const raw = await rawBody(req);
  const name = String(req.headers['x-relay-client'] || '');
  const ts = String(req.headers['x-relay-ts'] || '');
  const client = (await relayClients()).find(c => c.name === name);
  if (!client || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300 || !hmacOk(client.secret, ts, raw, req.headers['x-relay-signature'])) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const cfg = getConfig();
  if (!cfg.ok) return res.status(503).json({ ok: false, definitive: true, message: cfg.error });
  let b; try { b = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
  const mine = s => String(s || '').startsWith(client.order_prefix);
  try {
    switch (b.op) {
      case 'balance': return res.status(200).json(await getBalance(cfg));
      case 'payin':
        if (!mine(b.orderSn)) return res.status(403).json({ error: 'order prefix not allowed' });
        return res.status(200).json(await createPayin(cfg, b));
      case 'payout':
        if (!mine(b.orderSn)) return res.status(403).json({ error: 'order prefix not allowed' });
        return res.status(200).json(await createPayout(cfg, b));
      case 'verify': {
        const expected = b.kind === 'payin'
          ? sign.payinCallback(cfg, String(b.platform_osn), String(b.status), b.amount)
          : sign.payoutCallback(cfg, String(b.platform_osn), String(b.status), b.amount);
        return res.status(200).json({ valid: safeEqual(expected, b.sign), merchant_ok: b.merchant_sn === undefined || String(b.merchant_sn) === cfg.sn });
      }
      case 'ip': return res.status(200).json({ ip: await egressIp() });
      default: return res.status(400).json({ error: 'unknown op' });
    }
  } catch (e) {
    console.error('relay error', e.message);
    return res.status(500).json({ ok: false, definitive: false, message: e.message });
  }
}
