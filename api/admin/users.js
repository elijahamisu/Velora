import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';

const ACTIONS = ['add_funds', 'remove_funds', 'assign_plan', 'delete_user'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { action, userId } = req.body || {};
  if (!userId || !ACTIONS.includes(action)) {
    return res.status(400).json({ error: `Body must include userId and action: ${ACTIONS.join(' | ')}.` });
  }

  try {
    if (action === 'add_funds' || action === 'remove_funds') {
      return await handleFundsAdjustment(req, res, userId, action);
    }
    if (action === 'assign_plan') {
      return await handleAssignPlan(req, res, userId);
    }
    if (action === 'delete_user') {
      return await handleDeleteUser(req, res, userId);
    }
  } catch (err) {
    console.error('admin/users error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

async function handleFundsAdjustment(req, res, userId, action) {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  const { data: wallet, error: walletFetchErr } = await supabaseAdmin
    .from('wallets')
    .select('available_balance')
    .eq('user_id', userId)
    .single();
  if (walletFetchErr) throw walletFetchErr;

  const current = Number(wallet?.available_balance || 0);
  const isAdd = action === 'add_funds';

  if (!isAdd && amount > current) {
    return res.status(400).json({ error: `Cannot remove ₦${amount.toLocaleString()} — wallet only has ₦${current.toLocaleString()}.` });
  }

  const newBalance = isAdd ? current + amount : current - amount;

  const { error: walletErr } = await supabaseAdmin
    .from('wallets')
    .update({ available_balance: newBalance })
    .eq('user_id', userId);
  if (walletErr) throw walletErr;

  // transactions table has no `status` column in this schema.
  await supabaseAdmin.from('transactions').insert([{
    user_id: userId,
    amount,
    type: isAdd ? 'admin_credit' : 'admin_debit',
    description: isAdd ? 'Funds added by admin' : 'Funds removed by admin',
  }]);

  await supabaseAdmin.from('notifications').insert([{
    user_id: userId,
    title: isAdd ? 'Funds Added' : 'Funds Removed',
    message: isAdd
      ? `₦${amount.toLocaleString()} was added to your wallet by an administrator.`
      : `₦${amount.toLocaleString()} was removed from your wallet by an administrator.`,
  }]);

  return res.status(200).json({ ok: true, newBalance });
}

async function handleAssignPlan(req, res, userId) {
  const planId = req.body.planId;
  if (!planId) {
    return res.status(400).json({ error: 'planId is required.' });
  }

  const { data: plan, error: planErr } = await supabaseAdmin
    .from('investment_plans')
    .select('id, name, price, daily_roi_pct, duration_days')
    .eq('id', planId)
    .single();
  if (planErr || !plan) {
    return res.status(404).json({ error: 'Plan not found.' });
  }

  const amount = Number(plan.price);
  const dailyEarningAmount = (amount * Number(plan.daily_roi_pct)) / 100;

  // Admin-granted plans do NOT debit the client's wallet — this is a manual
  // enrollment (bonus/compensation/promo), not a purchase the client paid
  // for. Use "Remove Funds" separately if a debit is also intended.
  const { data: investment, error: investErr } = await supabaseAdmin
    .from('investments')
    .insert([{
      user_id: userId,
      plan_id: plan.id,
      amount_invested: amount,
      daily_earning_amount: dailyEarningAmount,
      remaining_days: plan.duration_days,
      status: 'active',
    }])
    .select()
    .single();
  if (investErr) throw investErr;

  await supabaseAdmin.from('transactions').insert([{
    user_id: userId,
    amount,
    type: 'investment',
    description: `${plan.name} plan granted by admin`,
  }]);

  await supabaseAdmin.from('notifications').insert([{
    user_id: userId,
    title: 'Plan Assigned',
    message: `An administrator enrolled you in the ${plan.name} plan.`,
  }]);

  return res.status(200).json({ ok: true, investment });
}

async function handleDeleteUser(req, res, userId) {
  // Best-effort cleanup of app-level rows first (in case foreign keys aren't
  // set to cascade), then delete the actual auth user, which is what
  // actually prevents them from logging in again.
  const tables = ['investments', 'deposits', 'withdrawals', 'transactions', 'notifications', 'wallets'];
  for (const table of tables) {
    await supabaseAdmin.from(table).delete().eq('user_id', userId);
  }
  await supabaseAdmin.from('profiles').delete().eq('id', userId);

  const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (authErr) throw authErr;

  return res.status(200).json({ ok: true });
}
