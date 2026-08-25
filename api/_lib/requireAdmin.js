import { supabaseAdmin } from './supabaseAdmin.js';

const ADMIN_ROLES = ['admin', 'super_admin'];

/**
 * Verifies the request carries a valid Supabase access token belonging to
 * an admin/super_admin profile. Returns { user, role } on success, or
 * writes a 401/403 response and returns null on failure.
 *
 * Usage inside a handler:
 *   const admin = await requireAdmin(req, res);
 *   if (!admin) return; // response already sent
 */
export async function requireAdmin(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return null;
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return null;
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role, full_name')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !profile || !ADMIN_ROLES.includes(profile.role)) {
    res.status(403).json({ error: 'Admin privileges required.' });
    return null;
  }

  return { user: userData.user, role: profile.role, fullName: profile.full_name };
}
