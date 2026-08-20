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
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = serviceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase server credentials are not configured");
  }

  // Diagnostic only — does not change which key gets used, preserves the
  // exact existing fallback behavior. Falling back to the anon key still
  // works for every table this app wrote to before Stage 7B (RLS is
  // disabled on all of them), so this silently "worked" for a long time.
  // It stops working the moment something actually requires service_role
  // privileges — e.g. the apply_conversation_lifecycle_action RPC's
  // EXECUTE grant is service_role-only (see supabase/migrations/
  // 20260820_conversation_lifecycle_action_rpc.sql) — where a request
  // running on this fallback fails with a Postgres "permission denied"
  // error that, before this log, was only ever visible to the browser as
  // a generic translated failure message. This makes that misconfiguration
  // immediately traceable in server logs instead.
  if (!serviceRoleKey) {
    console.warn(
      "getSupabaseServerClient: SUPABASE_SERVICE_ROLE_KEY is not set — falling back to the anon key. " +
        "Operations that require service_role (e.g. the apply_conversation_lifecycle_action RPC) will fail with a permission error."
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return client;
}
