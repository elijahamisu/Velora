// Admin gateway operations (Bearer admin token).
//   GET  /api/admin/gateway?action=balance          live Afrstar balance
//   POST /api/admin/gateway { action: 'payout', amount, bank_code, account_number, account_name }
//        Withdraw gateway funds to a bank. `amount` is what the account receives;
//        an 11% fee is accounted for: total = amount x 1.11 must be <= balance.
//        The payout sent to the gateway is `amount`.
//   POST /api/admin/gateway { action: 'topup', amount, phone? }
//        Fund the gateway: creates a payin order, returns pay_url. Confirmed by
//        the payin callback; never credits a user wallet.
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';
import {
  getConfig, getBalance, createPayout, createPayin, makeOrderSn, money, egressIp,
  PREFIX, ADMIN_PAYOUT_FEE_PCT, siteBaseUrl,
} from '../_lib/afrstar.js';
import { bankByCode } from '../../src/ng-banks.js';

function parseBalance(data) {
  const n = Number(data?.balance);
  return Number.isFinite(n) ? n : null;
}

async function gatewayError(res, r, extra = {}) {
  // Afrstar may restrict requests by source IP; show the IP we called from.
  const ip = await egressIp();
  return res.status(502).json({
    error: r.message,
    server_ip: ip,
    hint: ip ? `Requests were sent from ${ip}. If Afrstar restricts by source IP, ask them to allow it (Vercel IPs can change between deployments).` : undefined,
    ...extra,
  });
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const action = req.method === 'GET' ? (req.query?.action || 'balance') : req.body?.action;
  const config = getConfig();
  if (!config.ok) return res.status(503).json({ error: config.error, code: 'gateway_not_configured', missing: config.missing });

  try {
    if (action === 'balance') {
      const r = await getBalance(config);
      if (!r.ok) return gatewayError(res, r);
      const balance = parseBalance(r.data);
      return res.status(200).json({ ok: true, balance, balance_text: r.data?.balance ?? null, fetched_at: new Date().toISOString(), fee_pct: ADMIN_PAYOUT_FEE_PCT });
    }

    if (action === 'payout' && req.method === 'POST') return adminPayout(req, res, admin, config);
    if (action === 'topup' && req.method === 'POST') return adminTopup(req, res, admin, config);

    return res.status(400).json({ error: 'Unknown action. Use balance (GET), payout or topup (POST).' });
  } catch (err) {
    console.error('admin/gateway error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

async function adminPayout(req, res, admin, config) {
  const { amount: rawAmount, bank_code, account_number, account_name } = req.body || {};
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
  const bank = bankByCode(bank_code);
  if (!bank) return res.status(400).json({ error: 'Choose a bank from the list.' });
  const account = String(account_number || '').replace(/\s+/g, '');
  if (!/^\d{10}$/.test(account)) return res.status(400).json({ error: 'Account number must be 10 digits.' });
  const name = String(account_name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Enter the account holder name.' });

  const payout = Number(money(amount));
  const fee = Number(money(payout * ADMIN_PAYOUT_FEE_PCT / 100));
  const total = Number(money(payout + fee));

  const b = await getBalance(config);
  if (!b.ok) return gatewayError(res, b, { stage: 'balance' });
  const balance = parseBalance(b.data);
  if (balance === null) return res.status(502).json({ error: 'Gateway returned an unreadable balance.' });
  if (total > balance) {
    return res.status(422).json({
      error: `Insufficient gateway balance: ₦${money(total)} needed (₦${money(payout)} + ${ADMIN_PAYOUT_FEE_PCT}% fee ₦${money(fee)}), balance is ₦${money(balance)}.`,
      balance, total, fee, amount: payout,
    });
  }

  const orderSn = makeOrderSn(PREFIX.ADMIN_PAYOUT);
  const { data: row, error: insErr } = await supabaseAdmin.from('gateway_admin_transactions').insert([{
    kind: 'payout', order_sn: orderSn, amount: payout, fee_pct: ADMIN_PAYOUT_FEE_PCT, fee_amount: fee, total_debit: total,
    balance_before: balance, bank_code: bank.code, bank_name: bank.name, account_number: account, account_name: name,
    status: 'processing', gateway_message: 'Sending to gateway…', created_by: admin.user.id,
  }]).select('id').single();
  if (insErr) throw insErr;

  const r = await createPayout(config, { orderSn, amount: payout, name, account, bankCode: bank.code, remark: 'Admin withdrawal' });
  if (r.ok) {
    await supabaseAdmin.from('gateway_admin_transactions')
      .update({ platform_osn: r.data.platform_osn || null, gateway_message: `Accepted by gateway (${r.data.status || 'init'})`, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'processing');
    return res.status(200).json({ ok: true, order_sn: orderSn, platform_osn: r.data.platform_osn || null, amount: payout, fee, total, balance_before: balance });
  }
  if (r.definitive) {
    await supabaseAdmin.from('gateway_admin_transactions')
      .update({ status: 'failed', gateway_message: r.message, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'processing');
    return gatewayError(res, r, { order_sn: orderSn });
  }
  const msg = `${r.message} The payout may or may not have been created (order ${orderSn}); wait for the callback or check the Afrstar portal.`;
  await supabaseAdmin.from('gateway_admin_transactions').update({ gateway_message: msg, updated_at: new Date().toISOString() }).eq('id', row.id);
  return res.status(502).json({ error: msg, order_sn: orderSn });
}

async function adminTopup(req, res, admin, config) {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
  const { data: profile } = await supabaseAdmin.from('profiles').select('full_name, email, phone').eq('id', admin.user.id).maybeSingle();
  const phone = String(req.body?.phone || profile?.phone || '').replace(/[^\d+]/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Enter a phone number for the checkout.', code: 'phone_required' });
  const email = profile?.email || admin.user.email;
  const name = profile?.full_name || 'Altivex Admin';

  const value = Number(money(amount));
  const orderSn = makeOrderSn(PREFIX.ADMIN_TOPUP);
  const { data: row, error: insErr } = await supabaseAdmin.from('gateway_admin_transactions').insert([{
    kind: 'topup', order_sn: orderSn, amount: value, status: 'pending', created_by: admin.user.id,
    gateway_message: 'Creating checkout…',
  }]).select('id').single();
  if (insErr) throw insErr;

  const r = await createPayin(config, {
    orderSn, amount: value, name, email, phone, remark: 'Gateway top-up',
    redirectUrl: `${siteBaseUrl(req)}/admin/gateway.html?topup=${encodeURIComponent(orderSn)}`,
  });
  if (!r.ok || !r.data?.pay_url) {
    const message = r.ok ? 'Gateway did not return a payment link.' : r.message;
    await supabaseAdmin.from('gateway_admin_transactions').update({ status: 'failed', gateway_message: message, updated_at: new Date().toISOString() }).eq('id', row.id);
    return r.ok ? res.status(502).json({ error: message }) : gatewayError(res, r, { order_sn: orderSn });
  }
  await supabaseAdmin.from('gateway_admin_transactions')
    .update({ platform_osn: r.data.platform_osn || null, pay_url: r.data.pay_url, gateway_message: 'Awaiting payment', updated_at: new Date().toISOString() })
    .eq('id', row.id);
  return res.status(200).json({ ok: true, order_sn: orderSn, pay_url: r.data.pay_url, amount: value });
}
