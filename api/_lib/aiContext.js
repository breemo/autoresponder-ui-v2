// AI Engine V1 — Phase 3: authoritative AI Context resolution.
//
// Pure data-layer module — every Supabase query this app needs to build
// one normalized AI Context object lives here. No prompt text, no OpenAI
// call, no HTTP concerns (those belong to api/ai-context.js, the thin
// handler that wraps this) — kept separate so api/_lib/promptBuilder.js
// can consume the returned context without ever touching the database
// itself (per explicit instruction).
//
// ---------------------------------------------------------------------
// Identity validation chain — no second sender_id/channel_key resolver
// ---------------------------------------------------------------------
// conversation_id is the ONLY authoritative anchor accepted. Every other
// identifier (client_id, channel, account) is derived server-side from
// real rows, never taken independently from the caller:
//   1. conversations WHERE id = conversation_id
//   2. compare conversations.client_id to the supplied client_id — fails
//      generically (no row-existence leak) on mismatch, never used to
//      select data, only to fast-fail
//   3. channel_identity_id comes from that SAME conversations row — this
//      is DB-FK-guaranteed consistent with client_id/contact_id
//      (conversations_channel_identity_fk, see
//      20260823_conversation_model_redesign_stage_a.sql), so once step 1
//      succeeds this pairing cannot be wrong
//   4. contact_channel_identities WHERE id = channel_identity_id ->
//      platform, channel_key
//   5. the one matching channel-account row (client_whatsapp/
//      client_facebook/client_telegram/client_instagram, selected by
//      platform), scoped by BOTH channel_key AND client_id
//
// This is exactly the chain from the AI Engine V1 blueprint amendments
// (Phase 0 follow-up) — see that report for the full rationale on why a
// parallel channel+channel_key resolver is exactly the bug class being
// avoided here.

import { REPLY_MODE_VALUES } from "../../src/lib/replyMode.js";
import { retrieveRelevantKnowledgeHybrid, buildContextualRetrievalQuery, buildLexicalContextText } from "./knowledgeRetrieval.js";

// platform -> { table, legacy feature slug }. The legacy feature slug is
// what client_feature_integrations rows are actually keyed by for reply_
// mode today (confirmed from the live n8n workflow JSON:
// AutoResponder_WhatsApp_V2's client_feature node filters
// features.slug=eq.whatsapp_evolution; General-Main-Flow's client_feature
// node filters features.slug=eq.<platform> directly for every other
// channel) — NOT the same string as `platform` for WhatsApp specifically.
const PLATFORM_ACCOUNT_MAP = {
  whatsapp: { table: "client_whatsapp", legacyFeatureSlug: "whatsapp_evolution", hasReplyModeColumn: false },
  facebook: { table: "client_facebook", legacyFeatureSlug: "facebook", hasReplyModeColumn: true },
  telegram: { table: "client_telegram", legacyFeatureSlug: "telegram", hasReplyModeColumn: true },
  instagram: { table: "client_instagram", legacyFeatureSlug: "instagram", hasReplyModeColumn: true },
};

const HISTORY_LIMIT = 10; // see Phase 3 report: matches AutoResponder_WhatsApp_V2's existing limit=10,
// recommended as the one shared default over General-Main-Flow's limit=5.

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_LABELS = {
  sunday: "Sunday", monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday",
};

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

// Renders clients.working_hours (the structured jsonb — untouched, still
// available on the returned client object) into the clean textual form
// the Prompt Builder actually uses, so the model is never handed raw
// JSON to interpret itself. Groups consecutive days sharing an identical
// schedule (same algorithm as the Account Settings UI's summary, re-
// implemented here without any UI/i18n dependency — this module must
// stay pure server-side JS).
export function formatWorkingHoursText(workingHours) {
  if (!workingHours || typeof workingHours !== "object") return null;

  const hasDayData = workingHours.days && typeof workingHours.days === "object" && Object.keys(workingHours.days).length > 0;
  if (!workingHours.timezone && !hasDayData) return null; // genuinely nothing set — never render "Closed" for data that was never configured

  const days = hasDayData ? workingHours.days : {};
  const lines = [];
  if (workingHours.timezone) lines.push(`Timezone: ${workingHours.timezone}`);

  const scheduleKey = (periods) => {
    if (!Array.isArray(periods) || periods.length === 0) return "closed";
    return periods.map((p) => `${p?.open || ""}-${p?.close || ""}`).join(",");
  };
  const periodsText = (periods) => {
    if (!Array.isArray(periods) || periods.length === 0) return "Closed";
    return periods.map((p) => `${p.open}–${p.close}`).join(", ");
  };

  const groups = [];
  let current = null;
  for (const day of DAY_KEYS) {
    const key = scheduleKey(days[day]);
    if (current && current.key === key) current.days.push(day);
    else { current = { key, days: [day] }; groups.push(current); }
  }

  for (const group of groups) {
    const label = group.days.length > 1
      ? `${DAY_LABELS[group.days[0]]}–${DAY_LABELS[group.days[group.days.length - 1]]}`
      : DAY_LABELS[group.days[0]];
    lines.push(`${label}: ${periodsText(days[group.days[0]])}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

// Non-secret projection only — every column list below was chosen by
// hand to exclude page_access_token/bot_token/any credential column. See
// the Phase 3 report's "Account Resolution" section for the exact
// per-table column lists and why.
const ACCOUNT_COLUMNS = {
  client_whatsapp: "id, client_id, channel_key, display_name, phone, is_active",
  client_facebook: "id, client_id, channel_key, display_name, reply_mode, is_active, connection_status",
  client_telegram: "id, client_id, channel_key, display_name, reply_mode, is_active, connection_status",
  client_instagram: "id, client_id, channel_key, display_name, reply_mode, is_active, connection_status",
};

// Resolves the one channel-account row for this exact conversation.
// Scoped by channel_key AND client_id together whenever channel_key is
// present (the common, correct case). If channel_key is null (a contact_
// channel_identities row created before that field was populated for
// this channel), falls back to client_id + platform alone — but ONLY
// when that resolves to exactly one row; more than one is reported as
// "ambiguous" rather than guessed, and zero as "not_found". This is the
// exact non-determinism class the earlier audit found and fixed
// elsewhere in this project — this resolver never repeats it.
async function resolveChannelAccount(supabase, { clientId, platform, channelKey }) {
  const mapping = PLATFORM_ACCOUNT_MAP[platform];
  if (!mapping) return { account: null, table: null, resolution: "unsupported_platform" };

  const columns = ACCOUNT_COLUMNS[mapping.table];

  if (channelKey) {
    const { data, error } = await supabase
      .from(mapping.table)
      .select(columns)
      .eq("client_id", clientId)
      .eq("channel_key", channelKey)
      .maybeSingle();
    if (error) throw error;
    return { account: data || null, table: mapping.table, mapping, resolution: data ? "matched_channel_key" : "not_found" };
  }

  const { data, error } = await supabase
    .from(mapping.table)
    .select(columns)
    .eq("client_id", clientId);
  if (error) throw error;
  const rows = data || [];
  if (rows.length === 1) return { account: rows[0], table: mapping.table, mapping, resolution: "matched_single_account" };
  if (rows.length === 0) return { account: null, table: mapping.table, mapping, resolution: "not_found" };
  return { account: null, table: mapping.table, mapping, resolution: "ambiguous" };
}

// reply_mode: prefer the resolved account row's own column when that
// table actually has one AND it's populated; otherwise the ONE permitted
// legacy read in this whole module — client_feature_integrations.config.
// reply_mode for the platform's legacy feature slug. Every other field in
// this module (Business Profile, AI Behavior) never touches that table
// at all, per the hard architectural rule in the Phase 3 spec.
async function resolveReplyMode(supabase, { clientId, platform, mapping, accountRow }) {
  if (mapping?.hasReplyModeColumn && accountRow?.reply_mode && REPLY_MODE_VALUES.includes(accountRow.reply_mode)) {
    return { reply_mode: accountRow.reply_mode, reply_mode_source: "account" };
  }

  const legacySlug = mapping?.legacyFeatureSlug || platform;
  const { data: featureRow, error: featureError } = await supabase
    .from("features")
    .select("id")
    .eq("slug", legacySlug)
    .maybeSingle();
  if (featureError || !featureRow) return { reply_mode: null, reply_mode_source: null };

  const { data: integrationRow, error: integrationError } = await supabase
    .from("client_feature_integrations")
    .select("config")
    .eq("client_id", clientId)
    .eq("feature_id", featureRow.id)
    .maybeSingle();
  if (integrationError || !integrationRow) return { reply_mode: null, reply_mode_source: null };

  const legacyReplyMode = integrationRow.config?.reply_mode;
  if (legacyReplyMode && REPLY_MODE_VALUES.includes(legacyReplyMode)) {
    return { reply_mode: legacyReplyMode, reply_mode_source: "legacy" };
  }
  return { reply_mode: null, reply_mode_source: null };
}

// role-normalized, ascending chronological order, bounded to
// HISTORY_LIMIT, blank messages dropped. direction 'inbound' -> "user",
// 'outbound' -> "assistant" — messages is the only table this reads;
// conversation_notes (a separate table entirely) is never queried here,
// so "internal notes" are structurally excluded, not filtered out.
async function loadHistory(supabase, { clientId, conversationId }) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, message, direction, reply_source, created_at")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;

  return (data || [])
    .filter((row) => (row.message || "").trim() !== "")
    .reverse()
    .map((row) => ({ role: row.direction === "outbound" ? "assistant" : "user", content: row.message.trim() }));
}

// Phase 4B: semantic Knowledge Base retrieval — wrapped so a Knowledge
// Base problem (missing OPENAI_API_KEY, an OpenAI outage, an RPC error)
// can NEVER fail the whole AI Context request. Every failure path here
// degrades to an empty array and a single safe server-side warning (no
// vectors, no document content, no secrets in the log) — Business
// Profile, AI Behavior, and Conversation context are already fully
// resolved by the time this runs and are completely unaffected by
// whatever happens in here.
//
// Phase 1 — Context-Aware Knowledge Retrieval: `history` (already
// resolved above by loadHistory, the same array the Prompt Builder sees)
// is used ONLY to build a better retrieval query via the pure, network-
// free buildContextualRetrievalQuery(). Building the contextual query is
// wrapped in its own try/catch, separate from the retrieval call's own,
// so a failure in that step alone can never block retrieval — it just
// falls back to today's exact behavior (the raw current message).
//
// Phase 2 — Hybrid Knowledge Retrieval: retrieveRelevantKnowledgeHybrid()
// (vector + lexical, RRF-fused) replaces the Phase 1 vector-only
// retrieveRelevantKnowledge() call here — see knowledgeRetrieval.js for
// the fusion itself.
//
// Phase 2B: also passes currentMessageText/contextText (built via the
// same buildLexicalContextText helper, sharing follow-up detection with
// buildContextualRetrievalQuery so the two can never disagree) so the
// lexical path can prioritize the current message's own tokens ahead of
// prepended context — see knowledgeRetrieval.js's buildLexicalTsQuery for
// the confirmed bug this fixes. `queryText` (the Phase-1 contextual
// string) still goes to vector embedding exactly as before Phase 2B.
//
// TEMPORARY DIAGNOSTIC: `logTag` (conversationId + a short per-call
// suffix) is passed through so every knowledgeRetrieval[DIAGNOSTIC] line
// for one customer message can be correlated together in the log viewer
// — see knowledgeRetrieval.js's own comment on retrieveRelevantKnowledgeHybrid.
// Purely additive metadata, never branched on.
async function retrieveKnowledgeSafely(supabase, { clientId, conversationId, queryText, history }) {
  const trimmedQuery = (queryText || "").trim();
  if (!trimmedQuery) return [];

  const logTag = `${conversationId || "no-conv"}:${Date.now().toString(36)}`;

  let effectiveQuery = trimmedQuery;
  let lexicalContextText = "";
  try {
    effectiveQuery = buildContextualRetrievalQuery(trimmedQuery, history) || trimmedQuery;
    lexicalContextText = buildLexicalContextText(trimmedQuery, history) || "";
  } catch (error) {
    effectiveQuery = trimmedQuery;
    lexicalContextText = "";
  }

  try {
    const result = await retrieveRelevantKnowledgeHybrid(supabase, {
      clientId,
      queryText: effectiveQuery,
      currentMessageText: trimmedQuery,
      contextText: lexicalContextText,
      logTag,
    });
    if (!result.ok) {
      console.warn("aiContext: knowledge retrieval unavailable, continuing with relevant_knowledge: []", {
        clientId,
        conversationId,
        logTag,
        reason: result.reason,
      });
      return [];
    }
    console.info("aiContext: knowledge retrieval complete", {
      clientId,
      conversationId,
      logTag,
      resultCount: result.results.length,
      queryContextualized: effectiveQuery !== trimmedQuery,
    });
    return result.results;
  } catch (error) {
    console.warn("aiContext: knowledge retrieval threw, continuing with relevant_knowledge: []", {
      clientId,
      conversationId,
      logTag,
      message: error?.message,
    });
    return [];
  }
}

// Business Voice + Authoritative Locations — wrapped so a not-yet-applied
// migration (client_locations / clients.locations_list_complete) can
// NEVER fail the whole AI Context request, exactly matching
// retrieveKnowledgeSafely's own degrade-safely discipline just above.
// Degrades to "no locations configured, completeness unknown" — the
// exact same safe state as a client who genuinely has zero locations
// configured (see the migration's own header comment for why
// locations_list_complete defaults to false: silence must never be
// read as a negative fact). Deliberately does NOT touch clients.address/
// business_name/phone/working_hours — those are fetched separately,
// below, by the REQUIRED (non-degrading) clients query, so a missing
// locations migration can never affect the rest of the Business Profile.
async function loadLocationsSafely(supabase, clientId) {
  try {
    const [{ data: locationRows, error: locationsError }, { data: clientRow, error: clientError }] = await Promise.all([
      supabase
        .from("client_locations")
        .select("name, address, city, phone, working_hours, is_primary")
        .eq("client_id", clientId)
        .eq("is_active", true)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      supabase.from("clients").select("locations_list_complete").eq("id", clientId).maybeSingle(),
    ]);

    if (locationsError || clientError) {
      console.warn("aiContext: locations lookup unavailable, continuing with locations: []", {
        clientId,
        message: locationsError?.message || clientError?.message,
      });
      return { locations: [], locationsListComplete: false };
    }

    const locations = (locationRows || []).map((row) => ({
      name: row.name || null,
      address: row.address,
      city: row.city || null,
      phone: row.phone || null,
      working_hours_text: formatWorkingHoursText(row.working_hours),
      is_primary: row.is_primary === true,
    }));

    return { locations, locationsListComplete: clientRow?.locations_list_complete === true };
  } catch (error) {
    console.warn("aiContext: locations lookup threw, continuing with locations: []", { clientId, message: error?.message });
    return { locations: [], locationsListComplete: false };
  }
}

export async function resolveAiContext(supabase, { conversationId, clientId, currentMessageText }) {
  if (!conversationId || !clientId) {
    return fail(400, "missing_input", "conversation_id and client_id are required");
  }

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, client_id, contact_id, channel_identity_id, platform, conversation_status, current_step")
    .eq("id", conversationId)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) return fail(404, "conversation_not_found", "Conversation not found");

  // Fast-fail only — never used to select data past this point. See the
  // module header comment for why a mismatch here is rejected generically
  // rather than distinguished from "not found" (avoids leaking whether a
  // conversation exists for a different client).
  if (conversation.client_id !== clientId) {
    return fail(403, "client_mismatch", "Context unavailable for this conversation/client combination");
  }

  const { data: channelIdentity, error: identityError } = await supabase
    .from("contact_channel_identities")
    .select("id, platform, channel_key, display_name")
    .eq("id", conversation.channel_identity_id)
    .maybeSingle();
  if (identityError) throw identityError;
  if (!channelIdentity) return fail(404, "channel_identity_not_found", "Channel identity not found");

  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select("id, business_name, business_description, phone, address, website, timezone, working_hours")
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!clientRow) return fail(404, "client_not_found", "Client not found");

  const { data: behaviorRow, error: behaviorError } = await supabase
    .from("client_ai_behavior")
    .select("personality, reply_tone, default_language, forbidden_rules, special_instructions, booking_instructions, escalation_instructions")
    .eq("client_id", clientId)
    .maybeSingle();
  if (behaviorError) throw behaviorError;

  const { account, table, mapping, resolution } = await resolveChannelAccount(supabase, {
    clientId,
    platform: channelIdentity.platform,
    channelKey: channelIdentity.channel_key,
  });

  const { reply_mode, reply_mode_source } = await resolveReplyMode(supabase, {
    clientId,
    platform: channelIdentity.platform,
    mapping,
    accountRow: account,
  });

  const history = await loadHistory(supabase, { clientId, conversationId });
  const relevantKnowledge = await retrieveKnowledgeSafely(supabase, { clientId, conversationId, queryText: currentMessageText, history });
  const { locations, locationsListComplete } = await loadLocationsSafely(supabase, clientId);

  const context = {
    client: {
      id: clientRow.id,
      business_name: clientRow.business_name || null,
      business_description: clientRow.business_description || null,
      phone: clientRow.phone || null,
      address: clientRow.address || null,
      website: clientRow.website || null,
      timezone: clientRow.timezone || null,
      working_hours: clientRow.working_hours || null,
      working_hours_text: formatWorkingHoursText(clientRow.working_hours),
      // Business Voice + Authoritative Locations — additive alongside the
      // fields above (which remain exactly as before for every client,
      // including one with zero client_locations rows). `locations` is
      // always an array (possibly empty); `locations_list_complete` is
      // only ever true when the client/admin has explicitly asserted it
      // — see the migration's header comment. promptBuilder.js is what
      // turns this into the actual TRUE/FALSE/UNKNOWN grounding instruction.
      locations,
      locations_list_complete: locationsListComplete,
    },
    account: {
      platform: channelIdentity.platform,
      channel_key: channelIdentity.channel_key || null,
      display_name: account?.display_name || channelIdentity.display_name || null,
      reply_mode,
      reply_mode_source,
      is_active: account?.is_active ?? null,
      resolution_table: table,
      resolution_status: resolution,
    },
    ai_behavior: {
      personality: behaviorRow?.personality || null,
      reply_tone: behaviorRow?.reply_tone || null,
      default_language: behaviorRow?.default_language || null,
      forbidden_rules: Array.isArray(behaviorRow?.forbidden_rules) ? behaviorRow.forbidden_rules : [],
      special_instructions: behaviorRow?.special_instructions || null,
      booking_instructions: behaviorRow?.booking_instructions || null,
      escalation_instructions: behaviorRow?.escalation_instructions || null,
    },
    conversation: {
      id: conversation.id,
      status: conversation.conversation_status,
      current_step: conversation.current_step,
      history,
      current_message_text: currentMessageText || "",
    },
    relevant_knowledge: relevantKnowledge, // always an array — [] on any retrieval problem, never thrown (see retrieveKnowledgeSafely above).
  };

  return { ok: true, context };
}
