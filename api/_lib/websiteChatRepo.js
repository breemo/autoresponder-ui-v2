// Website Chat data access (Supabase service-role client only). The single
// place Website Chat touches the database, so the service logic in
// websiteChatService.js / websiteChatAccounts.js can be tested against an
// in-memory repository with the same method contract.
//
// Every read that could cross tenants is scoped by the ids the caller has
// already resolved server-side (integration row -> client_id); no method
// accepts browser-supplied client/conversation ids.

const INTEGRATION_COLUMNS = "id, client_id, feature_id, is_active, config, created_at";
const VISITOR_COLUMNS =
  "id, client_id, integration_id, token_hash, token_expires_at, revoked_at, key_version, origin_host, created_ip_hash, last_seen_at, created_at";

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export function createWebsiteChatRepo(supabase) {
  let featureIdCache;

  return {
    async getWebsiteChatFeatureId() {
      if (featureIdCache !== undefined) return featureIdCache;
      const row = unwrap(await supabase.from("features").select("id").eq("slug", "website_chat").maybeSingle());
      featureIdCache = row?.id || null;
      return featureIdCache;
    },

    // ---- integrations (client_feature_integrations) ----
    async findIntegrationByPublicKey(publicKey) {
      const rows = unwrap(
        await supabase.from("client_feature_integrations").select(INTEGRATION_COLUMNS).eq("config->>publicKey", publicKey).limit(2)
      );
      return rows && rows.length === 1 ? rows[0] : null; // unique index; >1 would be corrupt data -> treat as not found
    },

    async findIntegrationById(id) {
      return unwrap(await supabase.from("client_feature_integrations").select(INTEGRATION_COLUMNS).eq("id", id).maybeSingle());
    },

    async listSiteIntegrations(clientId, featureId) {
      return (
        unwrap(
          await supabase
            .from("client_feature_integrations")
            .select(INTEGRATION_COLUMNS)
            .eq("client_id", clientId)
            .eq("feature_id", featureId)
            .order("created_at", { ascending: true })
        ) || []
      );
    },

    async findOwnedIntegration(clientId, featureId, id) {
      return unwrap(
        await supabase
          .from("client_feature_integrations")
          .select(INTEGRATION_COLUMNS)
          .eq("id", id)
          .eq("client_id", clientId)
          .eq("feature_id", featureId)
          .maybeSingle()
      );
    },

    // Atomic plan-limit check + insert (RPC create_website_chat_integration).
    async createIntegration({ clientId, featureId, config, isActive }) {
      return unwrap(
        await supabase.rpc("create_website_chat_integration", {
          p_client_id: clientId,
          p_feature_id: featureId,
          p_config: config,
          p_is_active: isActive,
        })
      );
    },

    // Ownership enforced in the UPDATE's own WHERE clause.
    async updateIntegration(id, clientId, featureId, patch) {
      return unwrap(
        await supabase
          .from("client_feature_integrations")
          .update(patch)
          .eq("id", id)
          .eq("client_id", clientId)
          .eq("feature_id", featureId)
          .select(INTEGRATION_COLUMNS)
          .maybeSingle()
      );
    },

    async deleteIntegration(id, clientId, featureId) {
      const row = unwrap(
        await supabase
          .from("client_feature_integrations")
          .delete()
          .eq("id", id)
          .eq("client_id", clientId)
          .eq("feature_id", featureId)
          .select("id")
          .maybeSingle()
      );
      return row?.id || null;
    },

    // Existing setting (Human Reply webhook); only its ORIGIN is used, as the
    // fallback n8n origin for the Website Chat ingress. No new setting.
    async getHumanReplyWebhookUrl() {
      const row = unwrap(await supabase.from("system_settings").select("value").eq("key", "human_reply_webhook_url").maybeSingle());
      return row?.value || null;
    },

    async isClientSubscriptionActive(clientId) {
      const row = unwrap(
        await supabase.from("client_subscription_status").select("is_active").eq("client_id", clientId).maybeSingle()
      );
      return row?.is_active === true;
    },

    // ---- visitors ----
    async findVisitorByTokenHash(tokenHash) {
      return unwrap(await supabase.from("website_chat_visitors").select(VISITOR_COLUMNS).eq("token_hash", tokenHash).maybeSingle());
    },

    async countRecentSessions(integrationId, ipHash, sinceIso) {
      const { count, error } = await supabase
        .from("website_chat_visitors")
        .select("id", { count: "exact", head: true })
        .eq("integration_id", integrationId)
        .eq("created_ip_hash", ipHash)
        .gte("created_at", sinceIso);
      if (error) throw error;
      return count || 0;
    },

    async insertVisitor(row) {
      return unwrap(await supabase.from("website_chat_visitors").insert(row).select(VISITOR_COLUMNS).single());
    },

    async updateVisitor(id, integrationId, patch) {
      return unwrap(
        await supabase
          .from("website_chat_visitors")
          .update(patch)
          .eq("id", id)
          .eq("integration_id", integrationId)
          .select(VISITOR_COLUMNS)
          .maybeSingle()
      );
    },

    // Atomic rate window / duplicate guard (RPC website_chat_visitor_hit).
    async hitVisitor(visitorId, kind, { minuteMax, dayMax = null, clientMessageId = null }) {
      return unwrap(
        await supabase.rpc("website_chat_visitor_hit", {
          p_visitor_id: visitorId,
          p_kind: kind,
          p_minute_max: minuteMax,
          p_day_max: dayMax,
          p_client_message_id: clientMessageId,
        })
      );
    },

    // Releases the duplicate guard when a send was not delivered, so the
    // visitor can retry the same client_message_id.
    async clearClientMessageId(visitorId, clientMessageId) {
      unwrap(
        await supabase
          .from("website_chat_visitors")
          .update({ last_client_message_id: null })
          .eq("id", visitorId)
          .eq("last_client_message_id", clientMessageId)
      );
    },

    async countClientInboundSince(clientId, sinceIso) {
      const { count, error } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("channel", "website_chat")
        .eq("direction", "inbound")
        .gte("created_at", sinceIso);
      if (error) throw error;
      return count || 0;
    },

    // ---- Conversation V2 (read-only) ----
    async findChannelIdentity({ clientId, senderId, channelKey }) {
      return unwrap(
        await supabase
          .from("contact_channel_identities")
          .select("id")
          .eq("client_id", clientId)
          .eq("platform", "website_chat")
          .eq("sender_id", senderId)
          .eq("channel_key", channelKey)
          .maybeSingle()
      );
    },

    async listConversations(clientId, channelIdentityId) {
      return (
        unwrap(
          await supabase
            .from("conversations")
            .select("id, conversation_status, started_at")
            .eq("client_id", clientId)
            .eq("channel_identity_id", channelIdentityId)
            .order("started_at", { ascending: false })
            .limit(20)
        ) || []
      );
    },

    // Newest-first when no cursor (caller reverses); ascending after a cursor.
    async listMessages({ clientId, conversationIds, afterFilter, limit }) {
      let q = supabase
        .from("messages")
        .select("id, conversation_id, direction, reply_source, message, message_type, created_at")
        .eq("client_id", clientId)
        .in("conversation_id", conversationIds);
      if (afterFilter) {
        q = q.or(afterFilter).order("created_at", { ascending: true }).order("id", { ascending: true });
      } else {
        q = q.order("created_at", { ascending: false }).order("id", { ascending: false });
      }
      return unwrap(await q.limit(limit)) || [];
    },
  };
}
