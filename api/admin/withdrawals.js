import { supabaseAdmin } from '../_lib/supabaseAdmin.js';
import { requireAdmin } from '../_lib/requireAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id, action } = req.body || {};
  if (!id || !['complete', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Body must include id and action: "complete" | "reject".' });
  }

  try {
    const { data: withdrawal, error: fetchErr } = await supabaseAdmin
      .from('withdrawals')
      .select('id, user_id, amount, status')
      .eq('id', id)
      .single();

    if (fetchErr || !withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found.' });
    }
    if (withdrawal.status !== 'pending') {
      return res.status(409).json({ error: `Withdrawal already ${withdrawal.status}.` });
    }

    if (action === 'complete') {
      // Funds were already debited from the wallet at request time
      // (see withdraw.html) — completing just flips the status.
      // NOTE: `transactions` has no `status` column in this schema, so
      // there is nothing else to update here.
      const { data: updatedRows, error } = await supabaseAdmin
        .from('withdrawals')
        .update({ status: 'completed', processed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id');
      if (error) throw error;
      if (!updatedRows || updatedRows.length === 0) {
        return res.status(409).json({ error: 'Withdrawal was already processed.' });
      }

      return res.status(200).json({ ok: true, status: 'completed' });
    }

    // action === 'reject' — reverse the earlier debit, refund the client.
    const { data: updatedRows, error: wdErr } = await supabaseAdmin
      .from('withdrawals')
      .update({ status: 'rejected', processed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
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
