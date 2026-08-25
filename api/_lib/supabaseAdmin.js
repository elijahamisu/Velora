import { createClient } from '@supabase/supabase-js';

// Server-only client. Uses the SERVICE ROLE key, which bypasses RLS —
// this file must never be imported by anything that ships to the browser.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set as plain (non-VITE_) env
// vars in Vercel so Vite never bundles the service key into client code.
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
