import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'POST') {
    return savePlan(req, res);
  }
  if (req.method === 'DELETE') {
    return deletePlan(req, res);
  }
  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function savePlan(req, res) {
  const { id, name, category, price, multiplier, durationDays, sortOrder, isPopular, isActive } = req.body || {};

  if (!name) return res.status(400).json({ error: 'Plan name is required.' });
  const priceNum = Number(price);
  const multiplierNum = Number(multiplier);
  const durationNum = Number(durationDays);
  if (!priceNum || priceNum <= 0) return res.status(400).json({ error: 'Please provide a valid price.' });
  if (!multiplierNum || multiplierNum <= 0) return res.status(400).json({ error: 'Please provide a valid rate multiplier.' });
  if (!durationNum || durationNum <= 0) return res.status(400).json({ error: 'Please provide a valid duration in days.' });

  // Same derivation as the client: multiplier * price = total income,
  // spread across duration to get daily_roi_pct.
  const totalIncome = priceNum * multiplierNum;
  const dailyProfit = totalIncome / durationNum;
  const dailyRatePercent = (dailyProfit / priceNum) * 100;

  const payload = {
    name,
    category: category || 'starter',
    price: priceNum,
    daily_roi_pct: dailyRatePercent,
    duration_days: durationNum,
    sort_order: Number(sortOrder) || 0,
    is_popular: !!isPopular,
    is_active: isActive !== false,
  };

  try {
    if (id) {
      const { data, error } = await supabaseAdmin.from('investment_plans').update(payload).eq('id', id).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, plan: data });
    } else {
      const { data, error } = await supabaseAdmin.from('investment_plans').insert([payload]).select().single();
      if (error) throw error;
      return res.status(200).json({ ok: true, plan: data });
    }
  } catch (err) {
    console.error('admin/plans save error:', err);
    return res.status(500).json({ error: err.message || 'Could not save plan.' });
  }
}

async function deletePlan(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });

  try {
    // Deleting a plan does not touch existing `investments` rows — those
    // already store their own amount + daily_earning_amount independent of
    // this plan, so investors already in are unaffected either way.
    const { error } = await supabaseAdmin.from('investment_plans').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin/plans delete error:', err);
    return res.status(500).json({ error: err.message || 'Could not delete plan.' });
  }
}
