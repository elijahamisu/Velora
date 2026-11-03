// POST /api/deposits/create  { amount, phone? }  (Bearer user token)
// Gateway mode only: creates an Afrstar payin order for the signed-in user,
// stores the deposit row (method 'gateway', pending) and returns the hosted
// checkout URL. The wallet is credited only by /api/afrstar/payin-callback.
import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireUser } from '../_lib/requireUser.js';
import { getConfig, createPayin, makeOrderSn, money, PREFIX, siteBaseUrl, depositMode } from '../_lib/afrstar.js';

function cleanPhone(p) {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

// Deposit routing follows site_settings.deposit_mode (admin Gateway page):
// this endpoint only works in 'gateway' mode; manual mode uses bank transfer.
export function createHandler({ db = supabaseAdmin, authorize = requireUser, env = process.env, fetchImpl } = {}) {
  const supabaseAdmin = db;
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const auth = await authorize(req, res);
    if (!auth) return;
    const { user, profile } = auth;

    try {
      const { data: s, error: sErr } = await supabaseAdmin.from('site_settings').select('*').eq('id', 1).maybeSingle();
      if (sErr) throw sErr;
      const isAdmin = ['admin', 'super_admin'].includes(profile.role);
      if (s?.maintenance_mode && !isAdmin) return res.status(503).json({ error: s.maintenance_message || 'The site is under maintenance.' });
      if (depositMode(s) !== 'gateway') {
        return res.status(409).json({ error: 'Automatic deposits are switched off. Please use the bank transfer option.' });
      }

      const config = getConfig(env);
      if (!config.ok) return res.status(503).json({ error: config.error, code: 'gateway_not_configured' });

      const raw = Number(req.body?.amount);
      if (!Number.isFinite(raw) || raw <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
      const amount = Number(money(raw));
      const min = Number(s?.min_deposit ?? 0);
      const max = s?.max_deposit ? Number(s.max_deposit) : null;
      if (amount < min) return res.status(400).json({ error: `Minimum deposit is ₦${min.toLocaleString('en-NG')}.` });
      if (max && amount > max) return res.status(400).json({ error: `Maximum deposit is ₦${max.toLocaleString('en-NG')}.` });

      const phone = cleanPhone(req.body?.phone) || cleanPhone(profile.phone);
      if (!phone) return res.status(400).json({ error: 'Add your phone number to continue.', code: 'phone_required' });
      if (!profile.phone && cleanPhone(req.body?.phone)) {
        await supabaseAdmin.from('profiles').update({ phone }).eq('id', user.id);
      }
      const email = profile.email || user.email;
      const name = (profile.full_name || email || 'Altivex user').trim();

      const orderSn = makeOrderSn(PREFIX.USER_DEPOSIT);
      const { data: dep, error: insErr } = await supabaseAdmin.from('deposits').insert([{
        user_id: user.id,
        amount,
        method: 'gateway',
        order_sn: orderSn,
        status: 'pending',
        account_name: name,
        bank_name: 'Afrstar gateway',
      }]).select('id').single();
      if (insErr) throw insErr;

      const redirectUrl = `${siteBaseUrl(req, env)}/deposit-result.html?ref=${encodeURIComponent(orderSn)}`;
      const r = await createPayin(config, {
        orderSn, amount, name, email, phone,
        remark: `${s?.site_name || 'Altivex'} wallet deposit`,
        redirectUrl,
      }, fetchImpl ? { fetchImpl } : undefined);

      if (!r.ok || !r.data?.pay_url) {
        const message = r.ok ? 'Gateway did not return a payment link.' : r.message;
        await supabaseAdmin.from('deposits').update({ status: 'failed', gateway_message: message, processed_at: new Date().toISOString() }).eq('id', dep.id);
        console.error('payin create failed', { orderSn, message });
        return res.status(502).json({ error: `Could not start the payment. ${message}` });
      }

      await supabaseAdmin.from('deposits').update({ platform_osn: r.data.platform_osn || null, pay_url: r.data.pay_url }).eq('id', dep.id);
      return res.status(200).json({ ok: true, order_sn: orderSn, pay_url: r.data.pay_url, deposit_id: dep.id });
    } catch (err) {
      console.error('deposits/create error:', err);
      return res.status(500).json({ error: err.message || 'Internal error.' });
    }
  };
}

export default createHandler();
