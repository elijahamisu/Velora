// Core logic for the Afrstar payin / payout webhooks, kept free of env and
// client construction so it can be unit-tested with a stubbed Supabase client.
//
// Contract with the gateway:
//   - verify the md5 signature (payin: stored ORIGINAL order amount;
//     payout: callback amount, which must equal the stored payout amount)
//   - persist, then answer HTTP 200 with the exact body "success"
//   - be idempotent: retries / manual re-pushes must not move money twice
// Anything we cannot verify gets a non-200 status and a non-"success" body,
// so the gateway keeps retrying and nothing is credited.
//
// The money movement itself happens inside Postgres functions
// (gateway_apply_payin / gateway_apply_payout / gateway_apply_admin), which
// lock the row, check its state and apply the change in one transaction.
import { sign, safeEqual, money, orderKind, PREFIX } from './afrstar.js';

const OK = { status: 200, text: 'success' };
const fail = (status, text) => ({ status, text });

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function baseChecks(body, config) {
  if (!config || !config.ok) return { error: fail(500, 'gateway not configured') };
  const orderSn = String(body.order_sn || '').trim();
  const platformOsn = String(body.platform_osn || '').trim();
  const status = body.status === undefined || body.status === null ? '' : String(body.status).trim();
  const signature = String(body.sign || '').trim();
  if (!orderSn || !platformOsn || status === '' || !signature) return { error: fail(400, 'missing fields') };
  if (body.merchant_sn !== undefined && String(body.merchant_sn).trim() !== config.sn) return { error: fail(400, 'merchant mismatch') };
  return { orderSn, platformOsn, status, signature };
}

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/**
 * Payin (collection) callback. Routes on order_sn prefix:
 *   ALXD-  user deposit  -> credits the wallet once (gateway_apply_payin)
 *   ALXAT- admin top-up  -> marks the gateway funding row completed, no wallet
 */
export async function handlePayinCallback({ body, db, config }) {
  const base = baseChecks(body || {}, config);
  if (base.error) return base.error;
  const { orderSn, platformOsn, status, signature } = base;
  const kind = orderKind(orderSn);

  let original;
  if (kind === 'USER_DEPOSIT') {
    const { data, error } = await db.from('deposits').select('id, amount, method').eq('order_sn', orderSn).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.method !== 'gateway') return fail(404, 'order not found');
    original = data.amount;
  } else if (kind === 'ADMIN_TOPUP') {
    const { data, error } = await db.from('gateway_admin_transactions').select('id, amount, kind').eq('order_sn', orderSn).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.kind !== 'topup') return fail(404, 'order not found');
    original = data.amount;
  } else {
    return fail(404, 'order not found');
  }

  const expected = sign.payinCallback(config, platformOsn, status, original);
  if (!safeEqual(expected, signature)) return fail(401, 'invalid signature');

  const args = {
    p_order_sn: orderSn,
    p_platform_osn: platformOsn,
    p_status: Number(status),
    p_amount_paid: num(body.amount_paid) ?? num(body.amount),
    p_message: body.message ? String(body.message).slice(0, 500) : null,
    p_utr: body.utr ? String(body.utr).slice(0, 120) : (body.session_id ? String(body.session_id).slice(0, 120) : null),
    p_payload: body,
  };
  const result = kind === 'USER_DEPOSIT'
    ? await rpc(db, 'gateway_apply_payin', args)
    : await rpc(db, 'gateway_apply_admin', { ...args, p_kind: 'topup', p_amount: num(body.amount) });

  if (result === 'not_found') return fail(404, 'order not found');
  if (result === 'osn_mismatch') return fail(409, 'platform order mismatch');
  // credited | duplicate | failed_recorded | ignored | completed ...
  return { ...OK, result };
}

/**
 * Payout callback. Routes on order_sn prefix:
 *   ALXW-  user withdrawal  -> 1: completed + notify; 9: failed + refund + notify
 *   ALXAP- admin payout     -> updates gateway_admin_transactions
 */
export async function handlePayoutCallback({ body, db, config }) {
  const base = baseChecks(body || {}, config);
  if (base.error) return base.error;
  const { orderSn, platformOsn, status, signature } = base;
  const kind = orderKind(orderSn);

  if (body.amount === undefined || body.amount === null || body.amount === '') return fail(400, 'missing amount');
  let cbAmount;
  try { cbAmount = money(body.amount); } catch { return fail(400, 'bad amount'); }

  const expected = sign.payoutCallback(config, platformOsn, status, cbAmount);
  if (!safeEqual(expected, signature)) return fail(401, 'invalid signature');

  let stored;
  if (kind === 'USER_WITHDRAWAL') {
    const { data, error } = await db.from('withdrawals').select('id, payout_amount').eq('order_sn', orderSn).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(404, 'order not found');
    stored = data.payout_amount;
  } else if (kind === 'ADMIN_PAYOUT') {
    const { data, error } = await db.from('gateway_admin_transactions').select('id, amount, kind').eq('order_sn', orderSn).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.kind !== 'payout') return fail(404, 'order not found');
    stored = data.amount;
  } else {
    return fail(404, 'order not found');
  }
  if (stored === null || stored === undefined || money(stored) !== cbAmount) return fail(409, 'amount mismatch');

  const args = {
    p_order_sn: orderSn,
    p_platform_osn: platformOsn,
    p_status: Number(status),
    p_amount: Number(cbAmount),
    p_message: body.message ? String(body.message).slice(0, 500) : null,
    p_utr: body.utr ? String(body.utr).slice(0, 120) : null,
    p_payload: body,
  };
  const result = kind === 'USER_WITHDRAWAL'
    ? await rpc(db, 'gateway_apply_payout', args)
    : await rpc(db, 'gateway_apply_admin', { ...args, p_kind: 'payout', p_amount_paid: null });

  if (result === 'not_found') return fail(404, 'order not found');
  if (result === 'osn_mismatch') return fail(409, 'platform order mismatch');
  if (result === 'amount_mismatch') return fail(409, 'amount mismatch');
  return { ...OK, result };
}

export { PREFIX };
