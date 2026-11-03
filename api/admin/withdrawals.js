import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';
import { getConfig, createPayout, makeOrderSn, money, PREFIX } from '../_lib/afrstar.js';
import { bankByCode, guessBankCode } from '../../src/ng-banks.js';

// Withdrawals are always gateway-based (whatever the deposit mode) and every
// request needs an admin's approval first. Actions on a withdrawal:
//   send_gateway  pending -> processing: create an Afrstar payout for the net
//                 amount (amount - charge); the payout callback finalises it
//   mark_paid     pending -> approved: the admin paid it outside the gateway;
//                 no payout call, the user is notified ('complete' = alias)
//   reject        pending (or a gateway send whose outcome is unknown:
//                 processing with no platform_osn) -> rejected, full refund
// mark_paid and reject run in Postgres functions (admin_mark_withdrawal_paid /
// admin_reject_withdrawal, service role only) that lock the withdrawal and
// wallet rows, so a refund can never be lost or doubled.

export const ACTIONS = ['send_gateway', 'mark_paid', 'complete', 'reject'];

export function createHandler({ db = supabaseAdmin, authorize = requireAdmin, env = process.env, fetchImpl } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const admin = await authorize(req, res);
    if (!admin) return;

    const { id, action } = req.body || {};
    if (!id || !ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Body must include id and action: "send_gateway" | "mark_paid" | "reject".' });
    }
    if (action === 'send_gateway') return sendToGateway({ db, env, fetchImpl }, req, res, admin);

    const fn = action === 'reject' ? 'admin_reject_withdrawal' : 'admin_mark_withdrawal_paid';
    try {
      const { data, error } = await db.rpc(fn, { p_withdrawal: id, p_admin: admin.user?.id || null });
      if (error) throw error;
      const out = typeof data === 'string' ? JSON.parse(data) : (data || {});
      if (out.result === 'not_found') return res.status(404).json({ error: 'Withdrawal not found.' });
      if (out.result === 'conflict') {
        const st = out.status === 'processing'
          ? 'processing at the gateway (acknowledged). Wait for the payout callback'
          : `already ${out.status}`;
        return res.status(409).json({ error: `Withdrawal ${st}.`, status: out.status });
      }
      if (action === 'reject') {
        return res.status(200).json({ ok: true, status: 'rejected', refundedBalance: Number(out.refunded_balance) });
      }
      return res.status(200).json({ ok: true, status: 'approved', method: 'manual' });
    } catch (err) {
      console.error(`admin/withdrawals ${action} error:`, err);
      return res.status(500).json({ error: err.message || 'Internal error.' });
    }
  };
}

export default createHandler();

async function sendToGateway({ db: supabaseAdmin, env, fetchImpl }, req, res, admin) {
  const { id, bank_code: bankCodeOverride } = req.body || {};
  const config = getConfig(env);
  if (!config.ok) return res.status(503).json({ error: config.error, code: 'gateway_not_configured' });

  try {
    // Payouts do not depend on the deposit mode: withdrawals are always gateway-based.
    const { data: settings } = await supabaseAdmin.from('site_settings').select('site_name').eq('id', 1).maybeSingle();

    const { data: w, error } = await supabaseAdmin
      .from('withdrawals')
      .select('id, user_id, amount, charge, status, bank_name, bank_code, account_number, account_name')
      .eq('id', id)
      .single();
    if (error || !w) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (w.status !== 'pending') return res.status(409).json({ error: `Withdrawal already ${w.status}.` });

    const bankCode = String(bankCodeOverride || w.bank_code || guessBankCode(w.bank_name) || '').trim();
    const bank = bankByCode(bankCode);
    if (!bank) {
      return res.status(422).json({ error: `Choose the bank for "${w.bank_name || 'this account'}" before sending.`, code: 'bank_code_required' });
    }
    const account = String(w.account_number || '').replace(/\s+/g, '');
    if (!/^\d{10}$/.test(account)) {
      return res.status(422).json({ error: `Account number "${w.account_number || ''}" is not a 10-digit NUBAN. Reject the request or pay it manually.` });
    }
    const name = String(w.account_name || '').trim();
    if (!name) return res.status(422).json({ error: 'Account holder name is missing.' });

    const net = Number(money(Number(w.amount) - Number(w.charge || 0)));
    if (!(net > 0)) return res.status(422).json({ error: 'Net payout after the fee is zero.' });

    // Claim the row first (pending -> processing) so it cannot be sent twice,
    // and so a fast callback finds the order.
    const orderSn = makeOrderSn(PREFIX.USER_WITHDRAWAL);
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('withdrawals')
      .update({
        status: 'processing', method: 'gateway', order_sn: orderSn, payout_amount: net,
        bank_code: bank.code, sent_at: new Date().toISOString(), sent_by: admin.user.id,
        gateway_message: 'Sending to gateway…', gateway_status: null, platform_osn: null,
      })
      .eq('id', w.id)
      .eq('status', 'pending')
      .select('id');
    if (claimErr) throw claimErr;
    if (!claimed || claimed.length === 0) return res.status(409).json({ error: 'Withdrawal was already processed.' });

    const r = await createPayout(config, {
      orderSn, amount: net, name, account, bankCode: bank.code,
      remark: `${settings?.site_name || 'Altivex'} withdrawal`,
    }, fetchImpl ? { fetchImpl } : undefined);

    if (r.ok) {
      await supabaseAdmin.from('withdrawals')
        .update({ platform_osn: r.data.platform_osn || null, gateway_message: `Accepted by gateway (${r.data.status || 'init'})` })
        .eq('id', w.id).eq('status', 'processing');
      return res.status(200).json({ ok: true, status: 'processing', order_sn: orderSn, platform_osn: r.data.platform_osn || null, amount: money(net) });
    }

    if (r.definitive) {
      // Gateway refused the order: nothing was created there. Put the request back.
      await supabaseAdmin.from('withdrawals')
        .update({ status: 'pending', method: 'manual', order_sn: null, payout_amount: null, sent_at: null, sent_by: null, gateway_message: r.message })
        .eq('id', w.id).eq('status', 'processing');
      return res.status(502).json({ error: r.message, status: 'pending' });
    }

    // Unknown outcome (timeout / network): leave it processing for the callback.
    const msg = `${r.message} The payout may or may not have been created (order ${orderSn}). Wait for the gateway callback or check the Afrstar portal before doing anything else.`;
    await supabaseAdmin.from('withdrawals').update({ gateway_message: msg }).eq('id', w.id).eq('status', 'processing');
    return res.status(502).json({ error: msg, status: 'processing', order_sn: orderSn });
  } catch (err) {
    console.error('admin/withdrawals send_gateway error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}
