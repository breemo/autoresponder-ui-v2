// Server-side Supabase client for Vercel serverless functions under api/.
// Prefixed folder (_lib) is excluded from Vercel's filesystem routing.
//
// Prefers a service-role key (server-only secret, bypasses RLS) so admin
// operations on system_settings work regardless of RLS policy state.
// Falls back to the anon key so the endpoint still works if a service key
// hasn't been provisioned yet.
import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabaseServerClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase server credentials are not configured");
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return client;
}
