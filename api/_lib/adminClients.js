// Security C2.1 — Admin client create/delete, moved server-side from
// src/pages/admin/AdminClients.jsx so the browser no longer reads, inserts
// or deletes `users` rows with the public anon key.
//
// Behavior is a 1:1 port of the previous browser flows (same queries, same
// order, same validation, same rollback, same email-matching delete). It is
// a security refactor only, not a lifecycle redesign.
//
// Dispatched from api/system-settings.js (POST ?resource=clients) AFTER its
// resolveActingAdmin() gate — no new Vercel Function.
//
// TRUST NOTE: the admin gate still trusts the client-supplied
// `actor_user_id` (role re-read server-side). That id is not verified until
// S3 (verified sessions). This is no weaker than before — the browser could
// already perform every one of these writes with the anon key and no check
// at all — but it is NOT authentication.
//
//   POST /api/system-settings?resource=clients
//     { actor_user_id, action: "create", business_name, email, password, plan_id?, subscription_type? }
//       200 { success, client_id } | 400 invalid_request | 409 email_in_use_users |
//       409 email_in_use_clients | 500 create_failed | 503 server_unavailable
//     { actor_user_id, action: "delete", client_id }
//       200 { success } | 400 invalid_request | 500 delete_failed | 503 server_unavailable

export const ADMIN_CLIENTS_ERROR = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  EMAIL_IN_USE_USERS: "email_in_use_users",
  EMAIL_IN_USE_CLIENTS: "email_in_use_clients",
  CREATE_FAILED: "create_failed",
  DELETE_FAILED: "delete_failed",
  SERVER_UNAVAILABLE: "server_unavailable",
});

// The only values the Admin Clients form offers.
const SUBSCRIPTION_TYPES = new Set(["trial", "paid"]);
const MAX_TEXT = 320;
const MAX_PASSWORD = 1024;

function fail(res, status, code) {
  return res.status(status).json({ success: false, code });
}

// Logs only the failing step and the Postgres/PostgREST error code — never
// the request body, email, password or the raw error object.
function logStep(step, error) {
  console.error(`admin clients: ${step} failed`, error?.code || error?.name || "");
}

const isFilledString = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

// Same date math as the previous browser code: trial = +3 days, otherwise
// +1 month, from "now".
export function subscriptionPeriod(subscriptionType, now = new Date()) {
  const startDate = new Date(now.getTime());
  const endDate = new Date(now.getTime());
  if (subscriptionType === "trial") {
    endDate.setDate(endDate.getDate() + 3);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }
  return { start_date: startDate.toISOString(), end_date: endDate.toISOString() };
}

export async function createClient(supabase, body, res, { now } = {}) {
  const { business_name, email, password } = body;
  const planId = body.plan_id || null;
  const subscriptionType = body.subscription_type ?? "trial";

  // Same required fields as the form check (non-empty), plus type/size limits.
  if (!isFilledString(business_name, MAX_TEXT) || !isFilledString(email, MAX_TEXT) || !isFilledString(password, MAX_PASSWORD)) {
    return fail(res, 400, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);
  }
  if (planId !== null && typeof planId !== "string") return fail(res, 400, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);
  if (!SUBSCRIPTION_TYPES.has(subscriptionType)) return fail(res, 400, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);

  let createdClient = null;
  let createdUser = null;
  let createdSubscription = null;
  let step = "users lookup";

  try {
    const normalizedEmail = email.trim().toLowerCase();

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (existingUserError) throw existingUserError;
    if (existingUser) return fail(res, 409, ADMIN_CLIENTS_ERROR.EMAIL_IN_USE_USERS);

    step = "clients lookup";
    const { data: existingClient, error: existingClientError } = await supabase
      .from("clients")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (existingClientError) throw existingClientError;
    if (existingClient) return fail(res, 409, ADMIN_CLIENTS_ERROR.EMAIL_IN_USE_CLIENTS);

    step = "clients insert";
    const { data: clientData, error: clientError } = await supabase
      .from("clients")
      .insert([{ business_name: business_name.trim(), email: normalizedEmail, plan_id: planId }])
      .select("id, business_name, email, plan_id, is_active, created_at")
      .single();
    if (clientError) throw clientError;
    createdClient = clientData;

    if (planId) {
      step = "subscriptions insert";
      const { data: subscriptionData, error: subscriptionError } = await supabase
        .from("subscriptions")
        .insert([
          {
            client_id: createdClient.id,
            plan_id: planId,
            subscription_type: subscriptionType,
            status: "active",
            ...subscriptionPeriod(subscriptionType, now ? now() : new Date()),
          },
        ])
        .select()
        .single();
      if (subscriptionError) throw subscriptionError;
      createdSubscription = subscriptionData;
    }

    step = "users insert";
    const { data: userData, error: userError } = await supabase
      .from("users")
      .insert([
        {
          email: normalizedEmail,
          name: business_name.trim(),
          role: "client",
          // Admin-entered initial password, stored as before (legacy
          // plaintext column — SEC-3). The Owner must change it on first
          // login (ClientRoute's mandatory-change gate).
          password,
          must_change_password: true,
        },
      ])
      .select("id")
      .single();
    if (userError) throw userError;
    createdUser = userData;

    step = "client_users insert";
    const { error: linkError } = await supabase
      .from("client_users")
      .insert([{ client_id: createdClient.id, user_id: createdUser.id, role: "owner" }]);
    if (linkError) throw linkError;

    return res.status(200).json({ success: true, client_id: createdClient.id });
  } catch (error) {
    logStep(step, error);

    // Same compensating rollback, same order, results ignored — as before.
    const rollback = async (table, id) => {
      try {
        await supabase.from(table).delete().eq("id", id);
      } catch {
        // best-effort, as before
      }
    };
    if (createdUser?.id) await rollback("users", createdUser.id);
    if (createdSubscription?.id) await rollback("subscriptions", createdSubscription.id);
    if (createdClient?.id) await rollback("clients", createdClient.id);

    return fail(res, 500, ADMIN_CLIENTS_ERROR.CREATE_FAILED);
  }
}

export async function deleteClient(supabase, body, res) {
  const clientId = body.client_id;
  if (!isFilledString(clientId, MAX_TEXT)) return fail(res, 400, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);

  try {
    // The browser used the email of the client row it had loaded. The
    // server re-reads it by id so a caller cannot target an arbitrary
    // email. A missing client behaves as before (no user lookup; the
    // clients delete matches nothing and succeeds).
    const { data: client, error: clientLookupError } = await supabase
      .from("clients")
      .select("id, email")
      .eq("id", clientId)
      .maybeSingle();
    if (clientLookupError) {
      logStep("clients lookup", clientLookupError);
      return fail(res, 500, ADMIN_CLIENTS_ERROR.DELETE_FAILED);
    }

    const targetEmail = client?.email || null;

    // Existing semantics, unchanged: only the user whose email equals the
    // client's email is deleted, and only then are this client's
    // client_users rows removed. Errors on these three calls were ignored
    // before and still are.
    if (targetEmail) {
      const { data: linkedUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", targetEmail)
        .maybeSingle();

      if (linkedUser?.id) {
        await supabase.from("client_users").delete().eq("client_id", clientId);
        await supabase.from("users").delete().eq("id", linkedUser.id);
      }
    }

    const { error } = await supabase.from("clients").delete().eq("id", clientId);
    if (error) {
      logStep("clients delete", error);
      return fail(res, 500, ADMIN_CLIENTS_ERROR.DELETE_FAILED);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    logStep("delete", error);
    return fail(res, 500, ADMIN_CLIENTS_ERROR.DELETE_FAILED);
  }
}

// Must only be called after the platform-admin gate.
export async function handleAdminClients(req, res, { supabase, env = process.env, now } = {}) {
  // Fail closed: these writes must run with the service role, never with
  // supabaseServer.js's anon-key fallback.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("admin clients: SUPABASE_SERVICE_ROLE_KEY is not set — refusing");
    return fail(res, 503, ADMIN_CLIENTS_ERROR.SERVER_UNAVAILABLE);
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (body.action === "create") return createClient(supabase, body, res, { now });
  if (body.action === "delete") return deleteClient(supabase, body, res);
  return fail(res, 400, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);
}
