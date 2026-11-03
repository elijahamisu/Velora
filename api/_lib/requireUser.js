import { supabaseAdmin } from './supabaseAdmin.js';

/**
 * Verifies the bearer token belongs to a signed-in, active user.
 * Returns { user, profile } or writes a 401/403 response and returns null.
 */
export async function requireUser(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return null;
  }
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    return null;
  }
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, phone, role, status')
    .eq('id', userData.user.id)
    .single();
  if (profileErr || !profile) {
    res.status(403).json({ error: 'Account profile not found.' });
    return null;
  }
  if (profile.status && profile.status !== 'active' && !['admin', 'super_admin'].includes(profile.role)) {
    res.status(403).json({ error: 'Your account is not active.' });
    return null;
  }
  return { user: userData.user, profile };
}
