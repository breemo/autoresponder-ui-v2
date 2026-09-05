import { getSupabaseServerClient } from "./supabaseServer.js";

// Customer profile-name enrichment for Facebook Messenger & Instagram.
//
// ---------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------
// A Meta webhook event carries only `sender.id` (a PSID / IGSID) — never
// the person's name. So Conversation V2's contact_channel_identities.display_name
// and contacts.display_name are always NULL for these channels, and the
// Inbox shows a raw numeric id ("6229396837110469") instead of a name.
// The only way to get the name is a Graph profile lookup with the page /
// Instagram access token of the SAME channel account the message came
// through — which lives server-side, never in the browser.
//
// This handler is called server-to-server by AutoResponder_Final's
// `enrich_contact_name` node, fire-and-forget, AFTER the customer's reply
// has already been sent (so it never adds latency to a reply). It:
//   1. skips the Graph call entirely once a name is stored (so it is a
//      cheap no-op on every message after the first from a given sender),
//   2. resolves the access token from the identity's OWN channel account
//      (tenant isolation — never another client's token),
//   3. persists the name onto the V2 identity (and onto the contact, only
//      while that is still empty).
//
// Trust model: one shared secret, no actor_user_id — identical to
// api/ai-tools.js / api/media.js (sign_inbound_upload). Reuses
// AI_TOOLS_SECRET (the credential n8n already holds) so no new config is
// required.

const FB_GRAPH = "https://graph.facebook.com/v21.0";
const IG_GRAPH = "https://graph.instagram.com/v21.0";
const ENRICHABLE = new Set(["facebook", "instagram"]);

function pageTokenFromConfig(config) {
  if (!config || typeof config !== "object") return "";
  return String(config.page_access_token || config["Page Access Token"] || "").trim();
}

async function fetchMetaProfileName(platform, senderId, token) {
  try {
    let url;
    let init;
    if (platform === "facebook") {
      url = `${FB_GRAPH}/${encodeURIComponent(senderId)}?fields=first_name,last_name&access_token=${encodeURIComponent(token)}`;
      init = undefined;
    } else {
      // Instagram: the messaging-scoped IGSID is looked up on the
      // Instagram Graph host with a Bearer token (same host/auth style as
      // the outbound IG send path).
      url = `${IG_GRAPH}/${encodeURIComponent(senderId)}?fields=name,username`;
      init = { headers: { Authorization: `Bearer ${token}` } };
    }
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { name: "", error: j?.error?.message || j?.error || `HTTP ${r.status}` };
    }
    const name =
      platform === "facebook"
        ? [j.first_name, j.last_name].filter(Boolean).join(" ").trim()
        : String(j.name || j.username || "").trim();
    return { name };
  } catch (e) {
    return { name: "", error: String(e?.message || e) };
  }
}

export async function handleContactEnrich(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const provided = req.headers["x-contact-enrich-secret"] || req.headers["x-ai-tools-secret"];
  const expected = process.env.CONTACT_ENRICH_SECRET || process.env.MEDIA_INGEST_SECRET || process.env.AI_TOOLS_SECRET;
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const channelIdentityId =
    typeof req.body?.channel_identity_id === "string" ? req.body.channel_identity_id.trim() : "";
  if (!channelIdentityId) {
    return res.status(400).json({ success: false, message: "channel_identity_id is required" });
  }

  const { data: identity, error: idErr } = await supabase
    .from("contact_channel_identities")
    .select("id, client_id, contact_id, platform, sender_id, channel_key, display_name")
    .eq("id", channelIdentityId)
    .maybeSingle();
  if (idErr) {
    return res.status(500).json({ success: false, message: "identity lookup failed" });
  }
  if (!identity) {
    return res.status(404).json({ success: false, message: "identity not found" });
  }

  const platform = String(identity.platform || "").toLowerCase();
  if (!ENRICHABLE.has(platform)) {
    return res.status(200).json({ success: true, enriched: false, reason: "platform_not_supported" });
  }
  if (typeof identity.display_name === "string" && identity.display_name.trim() !== "") {
    return res.status(200).json({ success: true, enriched: false, reason: "already_set" });
  }
  const senderId = String(identity.sender_id || "").trim();
  if (!senderId) {
    return res.status(200).json({ success: true, enriched: false, reason: "no_sender_id" });
  }

  // Access token from THIS identity's own channel account. Facebook keys
  // its integration on config->>pageId, Instagram on
  // config->>instagram_account_id — the same values channel_key holds for
  // these platforms (see the inbound `client_feature` lookup).
  const keyCol = platform === "facebook" ? "pageId" : "instagram_account_id";
  let query = supabase
    .from("client_feature_integrations")
    .select("config, features!inner(slug)")
    .eq("client_id", identity.client_id)
    .eq("features.slug", platform)
    .limit(1);
  if (identity.channel_key) {
    query = query.eq(`config->>${keyCol}`, identity.channel_key);
  }
  const { data: integrations, error: integErr } = await query;
  if (integErr) {
    return res.status(500).json({ success: false, message: "integration lookup failed" });
  }
  const token = pageTokenFromConfig(integrations?.[0]?.config);
  if (!token) {
    return res.status(200).json({ success: true, enriched: false, reason: "no_access_token" });
  }

  const { name, error: graphError } = await fetchMetaProfileName(platform, senderId, token);
  if (!name) {
    return res.status(200).json({
      success: true,
      enriched: false,
      reason: "no_name",
      graph_error: graphError || null,
    });
  }

  const clean = name.replace(/\s+/g, " ").trim().slice(0, 200);
  const now = new Date().toISOString();

  const { error: identityWriteErr } = await supabase
    .from("contact_channel_identities")
    .update({ display_name: clean, updated_at: now })
    .eq("id", identity.id)
    .eq("client_id", identity.client_id);
  if (identityWriteErr) {
    return res.status(500).json({ success: false, message: "persist failed" });
  }

  // Only fill the contact-level name while it is still blank — a name set
  // elsewhere (a lead capture, a manual edit) is more authoritative.
  if (identity.contact_id) {
    await supabase
      .from("contacts")
      .update({ display_name: clean, updated_at: now })
      .eq("id", identity.contact_id)
      .eq("client_id", identity.client_id)
      .is("display_name", null);
  }

  return res.status(200).json({ success: true, enriched: true, name: clean, platform });
}
