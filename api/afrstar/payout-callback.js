// Afrstar payout webhook: POST https://altivex-invest.vercel.app/api/afrstar/payout-callback
// Set this URL as the Payout callback URL in the Afrstar merchant portal.
// Replies HTTP 200 with the exact plain-text body "success" once the result is
// verified and stored; anything unverifiable gets a non-200, non-"success"
// reply so nothing is applied and the gateway retries.
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { getConfig, parseCallbackBody, replyText } from '../_lib/afrstar.js';
import { clientForOrder, forwardCallback } from '../_lib/relay.js';
import { handlePayoutCallback } from '../_lib/afrstar-callbacks.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return replyText(res, 405, 'method not allowed');
  }
  const config = getConfig();
  if (!config.ok) {
    console.error('afrstar payout-callback: gateway env vars missing:', config.missing.join(', '));
    return replyText(res, 500, 'gateway not configured');
  }
  let body;
  try { body = parseCallbackBody(req); } catch { return replyText(res, 400, 'bad body'); }
  // Orders of a sister site sharing this merchant (e.g. TOP) are forwarded to it.
  const relayTo = await clientForOrder(body?.order_sn).catch(() => null);
  if (relayTo) {
    const out = await forwardCallback(relayTo, 'payout', body);
    console.log('afrstar payout-callback relayed', { client: relayTo.name, order_sn: body?.order_sn, status: out.status });
    return replyText(res, out.status, out.text);
  }
  try {
    const out = await handlePayoutCallback({ body, db: supabaseAdmin, config });
    if (out.status !== 200) {
      console.warn('afrstar payout-callback rejected', { order_sn: body?.order_sn, platform_osn: body?.platform_osn, status: body?.status, reason: out.text });
    } else {
      console.log('afrstar payout-callback', { order_sn: body?.order_sn, status: body?.status, result: out.result });
    }
    return replyText(res, out.status, out.text);
  } catch (err) {
    console.error('afrstar payout-callback error', { order_sn: body?.order_sn, error: err.message });
    return replyText(res, 500, 'error');
  }
}
