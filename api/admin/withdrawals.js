import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';
import { getConfig, createPayout, makeOrderSn, money, PREFIX } from '../_lib/afrstar.js';
import { bankByCode, guessBankCode } from '../../src/ng-banks.js';

// Actions:
//   complete      manual mode: mark a pending withdrawal paid
//   reject        refund a pending withdrawal (or a gateway one whose send
//                 never reached the gateway: processing with no platform_osn)
//   send_gateway  gateway mode: create an Afrstar payout for the net amount
//                 (amount - charge); the payout callback finalises it

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id, action } = req.body || {};
  if (!id || !['complete', 'reject', 'send_gateway'].includes(action)) {
    return res.status(400).json({ error: 'Body must include id and action: "complete" | "reject" | "send_gateway".' });
  }
  if (action === 'send_gateway') return sendToGateway(req, res, admin);

  try {
    const { data: withdrawal, error: fetchErr } = await supabaseAdmin
      .from('withdrawals')
      .select('id, user_id, amount, status, platform_osn, order_sn')
      .eq('id', id)
      .single();

    if (fetchErr || !withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found.' });
    }
    // A gateway send whose outcome is unknown (processing, never acknowledged
    // with a platform order number) may be rejected after checking the portal.
    const stuckGateway = action === 'reject' && withdrawal.status === 'processing' && !withdrawal.platform_osn;
    if (withdrawal.status !== 'pending' && !stuckGateway) {
      return res.status(409).json({ error: `Withdrawal already ${withdrawal.status}.` });
    }

    if (action === 'complete') {
      // Funds were already debited from the wallet at request time
      // (see withdraw.html) — completing just flips the status.
      // NOTE: withdrawals_status_check only permits 'pending' | 'approved'
      // | 'rejected' — there is no 'completed' value in this schema.
      // NOTE: `transactions` has no `status` column in this schema, so
      // there is nothing else to update here.
      const { data: updatedRows, error } = await supabaseAdmin
        .from('withdrawals')
        .update({ status: 'approved', processed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id');
      if (error) throw error;
      if (!updatedRows || updatedRows.length === 0) {
        return res.status(409).json({ error: 'Withdrawal was already processed.' });
      }

      return res.status(200).json({ ok: true, status: 'approved' });
    }

    // action === 'reject' — reverse the earlier debit, refund the client.
    const { data: updatedRows, error: wdErr } = await supabaseAdmin
      .from('withdrawals')
      .update({ status: 'rejected', processed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', withdrawal.status)
      .is('platform_osn', null)
      .select('id');
    if (wdErr) throw wdErr;
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ error: 'Withdrawal was already processed.' });
    }

    const { data: wallet, error: walletFetchErr } = await supabaseAdmin
      .from('wallets')
      .select('available_balance')
      .eq('user_id', withdrawal.user_id)
      .single();
    if (walletFetchErr) throw walletFetchErr;

    const refundedBalance = Number(wallet?.available_balance || 0) + Number(withdrawal.amount);
    const { error: walletErr } = await supabaseAdmin
      .from('wallets')
      .update({ available_balance: refundedBalance })
      .eq('user_id', withdrawal.user_id);
    if (walletErr) throw walletErr;

    await supabaseAdmin.from('notifications').insert([{
      user_id: withdrawal.user_id,
      title: 'Withdrawal Rejected',
      message: `Your withdrawal of ₦${Number(withdrawal.amount).toLocaleString()} was rejected and refunded to your wallet.`,
    }]);

    return res.status(200).json({ ok: true, status: 'rejected', refundedBalance });
  } catch (err) {
    console.error('admin/withdrawals error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

async function sendToGateway(req, res, admin) {
  const { id, bank_code: bankCodeOverride } = req.body || {};
  const config = getConfig();
  if (!config.ok) return res.status(503).json({ error: config.error, code: 'gateway_not_configured' });

  try {
    const { data: settings } = await supabaseAdmin.from('site_settings').select('payment_mode, site_name').eq('id', 1).maybeSingle();
    if ((settings?.payment_mode || 'manual') !== 'gateway') {
      return res.status(409).json({ error: 'Payment mode is Manual. Switch to Gateway in Settings to send payouts automatically.' });
    }

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
    });

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
