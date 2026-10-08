import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  ChevronDownIcon,
  LinkIcon,
  PaperAirplaneIcon,
  PlusIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import ChannelIcon from "../../lib/channelIcons.jsx";
import WhatsAppEvolutionSection from "./WhatsAppEvolutionSection";
import FacebookAccountsSection from "./FacebookAccountsSection";
import InstagramSetupSection from "./InstagramSetupSection";
import WebsiteChatSection from "./WebsiteChatSection";
import { isReplyModeKey, getReplyModeSelectOptions, getReplyModeLabel, DEFAULT_REPLY_MODE } from "../../lib/replyMode.js";
import { buildChannelSetupLinks, showsGenericSetupLinks } from "../../lib/integrationSetupLinks.js";
import TelegramActivationQr from "./TelegramActivationQr";
import { collapseWebsiteChatRows, isWebsiteChatSlug, websiteChatCard, WEBSITE_CHAT_CARD_ID } from "../../lib/websiteChatEmbed.js";
import { PageHeader, ui } from "../../components/app/primitives.jsx";

// Multi-Account Stage 2B — Facebook runtime-truth fix pass. client_facebook
// is NOT yet consumed by n8n/runtime messaging (Facebook still sends/
// receives exclusively through the legacy client_feature_integrations
// panel rendered below); exposing FacebookAccountsSection as a normal,
// always-on production surface would let a client believe a newly added
// Page is operational when it structurally cannot be yet. Preferred fix
// per instruction: hide it in production by default rather than show two
// active-looking configuration surfaces side by side, while still
// allowing it to be shown deliberately (internal preparation/testing,
// staging) via a build-time environment flag — the same
// import.meta.env.VITE_* build-flag pattern used elsewhere in the app,
// not a new architecture. Unset (the default
// everywhere this variable isn't explicitly configured, including
// production unless someone opts in) means OFF — the safe default. Also
// gates the small "current active configuration" label on the legacy
// panel, since that label only makes sense in contrast to a visible new
// section; with the new section hidden, the legacy panel is simply the
// only Facebook configuration UI shown, exactly as it always has been.
const FACEBOOK_MULTI_ACCOUNT_ENABLED =
  String(import.meta.env.VITE_FACEBOOK_MULTI_ACCOUNT_ENABLED || "").trim().toLowerCase() === "true";

function normalizeName(str) {
  return (str || "").toString().toLowerCase().replace(/\s+/g, "");
}

// AI Engine V1 — the legacy `ai_auto_reply` feature is no longer a
// communication channel. AI configuration lives in the dedicated AI area
// (client_ai_behavior + Business Context + Knowledge Base), and AI
// eligibility is driven by the channel account's own reply_mode plus the
// plan's AI allowance — never by an ai_auto_reply integration row. The
// Integrations page represents actual channels only, so this feature (and
// its client_feature_integrations row, if any) is filtered out of every
// list and count here. The DB feature/row is intentionally left in place.
const NON_CHANNEL_FEATURE_SLUGS = new Set(["ai_auto_reply"]);

function isChannelFeature(feature) {
  const slug = (feature?.slug || "").toString().toLowerCase();
  return !NON_CHANNEL_FEATURE_SLUGS.has(slug);
}

function getFeatureMeta(feature, t) {
  const slug = (feature?.slug || feature?.name || "").toLowerCase();

  if (slug.includes("telegram")) {
    return {
      label: "Telegram",
      icon: PaperAirplaneIcon,
      accent: "from-sky-500 to-cyan-400",
      soft: "bg-sky-50 text-sky-700 border-sky-100",
      description: t("integrationsPage.metaTelegramDesc"),
    };
  }

  if (slug.includes("facebook") || slug.includes("messenger")) {
    return {
      label: "Facebook Page",
      icon: BoltIcon,
      accent: "from-blue-600 to-indigo-500",
      soft: "bg-blue-50 text-blue-700 border-blue-100",
      description: t("integrationsPage.metaFacebookDesc"),
    };
  }

  if (slug.includes("instagram")) {
    return {
      label: "Instagram",
      icon: Squares2X2Icon,
      accent: "from-fuchsia-500 to-rose-400",
      soft: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100",
      description: t("integrationsPage.metaInstagramDesc"),
    };
  }

  if (slug.includes("whatsapp")) {
    return {
      label: "WhatsApp",
      icon: ShieldCheckIcon,
      accent: "from-emerald-500 to-teal-400",
      soft: "bg-emerald-50 text-emerald-700 border-emerald-100",
      description: t("integrationsPage.metaWhatsappDesc"),
    };
  }

  return {
    label: feature?.name || t("integrationsPage.metaDefaultLabel"),
    icon: LinkIcon,
    accent: "from-slate-600 to-slate-400",
    soft: "bg-slate-50 text-slate-700 border-slate-100",
    description: feature?.description || t("integrationsPage.metaDefaultDesc"),
  };
}

function normalizeFields(feature) {
  if (Array.isArray(feature?.fields)) return feature.fields;
  if (feature?.fields && typeof feature.fields === "object") {
    return Object.entries(feature.fields).map(([label, type]) => ({
      key: label,
      label,
      type,
    }));
  }
  return [];
}

// Setup links come from this environment's Main Inbound Flow webhook base,
// served by the backend ("list" -> inbound_webhook_base). No fallback to
// VITE_WEBHOOK_BASE_URL: without a valid base there are no links (the panel
// shows "not configured").
function buildGeneratedLinks(feature, integration, t, inboundBase) {
  const built = buildChannelSetupLinks({
    slug: feature?.slug || feature?.name || "",
    config: integration?.config || {},
    inboundBase,
  });
  if (!built) return [];

  const links = [
    {
      label: "Webhook URL",
      hint: t("integrationsPage.webhookHint"),
      value: built.webhookUrl,
      openable: true,
    },
  ];

  if (built.activationUrl) {
    links.push({
      label: t("integrationsPage.telegramActivationLink"),
      hint: t("integrationsPage.telegramActivationHint"),
      value: built.activationUrl,
      openable: true,
      activationQr: true,
    });
  }

  return links;
}

function SetupLinkCard({ label, hint, value, openable = true, activationQr = false }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-800">{label}</p>
          {hint && <p className="mt-1 text-[11px] leading-5 text-slate-500">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copyValue}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            <ClipboardDocumentIcon className="h-4 w-4" />
            {copied ? t("common.copied") : t("common.copy")}
          </button>
          {openable && (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              title={t("common.open")}
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
      <div dir="ltr" className="mt-3 max-h-24 overflow-auto break-all rounded-xl bg-slate-50 px-3 py-2 text-left font-mono text-xs leading-5 text-indigo-700">
        {value}
      </div>
      {activationQr && <TelegramActivationQr activationUrl={value} />}
    </div>
  );
}

function StatCard({ label, value, hint, icon: Icon }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-0.5 text-xl font-bold tracking-tight text-slate-900">{value}</p>
          {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
        </div>
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-50 text-slate-600">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default function ClientIntegrations() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [client, setClient] = useState(null);
  const [planFeatures, setPlanFeatures] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState(null);
  const [showAdvancedSetup, setShowAdvancedSetup] = useState(true);
  // This environment's Main Inbound Flow webhook base (server-side
  // system_settings via "list"); null = not configured.
  const [inboundWebhookBase, setInboundWebhookBase] = useState(null);
  const [query, setQuery] = useState("");
  // Informational/UX only (mirrors SubscriptionBanner) — disables the
  // obvious "activate a new service" buttons as a hint. This is NOT an
  // authorization boundary: n8n is the authoritative source for whether
  // subscription/plan entitlement allows service actions, checked at
  // message-processing time. The API this page writes to
  // (api/client-integrations.js) intentionally does not duplicate that
  // check — see its header comment.
  const [subscriptionActive, setSubscriptionActive] = useState(true);

  // client_id is resolved once at login via client_users (see Login.jsx) —
  // never re-derived here from clients.email or user.id.
  const clientId = user?.client_id || null;

  useEffect(() => {
    if (!clientId) return;
    fetchData();
    fetchSubscriptionStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function fetchSubscriptionStatus() {
    const { data, error } = await supabase
      .from("client_subscription_status")
      .select("is_active")
      .eq("client_id", clientId)
      .maybeSingle();

    if (error) {
      console.error(error);
      return;
    }

    // No subscription row at all → treat as active/unrestricted (plans are
    // optional at client creation — see SubscriptionBanner.jsx).
    setSubscriptionActive(data ? !!data.is_active : true);
  }

  async function fetchData() {
    try {
      setLoading(true);
      setError("");
      setSuccess("");

      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .select("*")
        .eq("id", clientId)
        .single();

      if (clientError) throw clientError;
      setClient(clientData);

      let featuresList = [];
      // Feature ids that are NOT communication channels (e.g. legacy
      // ai_auto_reply) — used to keep them out of every Integrations list
      // and count below, including any existing client_feature_integrations row.
      const nonChannelFeatureIds = new Set();
      if (clientData.plan_id) {
        const { data: pf, error: pfError } = await supabase
          .from("plan_features")
          .select("feature_id, max_connections")
          .eq("plan_id", clientData.plan_id);

        if (pfError) throw pfError;

        const maxConnectionsByFeatureId = new Map(
          (pf || []).map((row) => [row.feature_id, row.max_connections])
        );

        const featureIds = (pf || []).map((x) => x.feature_id);
        if (featureIds.length > 0) {
          const { data: featuresData, error: fError } = await supabase
            .from("features")
            .select("*")
            .in("id", featureIds);

          if (fError) throw fError;
          (featuresData || []).forEach((feature) => {
            if (!isChannelFeature(feature)) nonChannelFeatureIds.add(feature.id);
          });
          // max_connections travels with the feature so WhatsAppEvolutionSection
          // can enforce/display the plan's per-channel connection limit.
          featuresList = (featuresData || [])
            .filter(isChannelFeature)
            .map((feature) => ({
              ...feature,
              max_connections: maxConnectionsByFeatureId.get(feature.id) ?? null,
            }));
        }
      }

      setPlanFeatures(featuresList);

      // Read integrations through the server, not directly from Supabase:
      // for Instagram rows the endpoint strips the Page Access Token out
      // of `config` and returns `config_flags.has_page_access_token`
      // instead. Every other channel's row is byte-for-byte identical to
      // the former direct select. See api/client-integrations.js ("list").
      const listResp = await callIntegrationAction("list");

      const normalized = (listResp.integrations || [])
        .filter(
          (row) =>
            !nonChannelFeatureIds.has(row.feature_id) &&
            !NON_CHANNEL_FEATURE_SLUGS.has((row.slug || "").toString().toLowerCase())
        )
        .map((row) => ({
          ...row,
          config: row.config || {},
        }));

      // Website Chat: N site rows -> one channel card rendering
      // WebsiteChatSection (sites managed via ?resource=website_chat).
      const websiteChatFeature = featuresList.find((f) => isWebsiteChatSlug(f.slug));
      const channels = collapseWebsiteChatRows(normalized, websiteChatFeature?.id);

      setIntegrations(channels);
      setInboundWebhookBase(typeof listResp.inbound_webhook_base === "string" ? listResp.inbound_webhook_base : null);
      setSelectedIntegrationId((prev) => prev || channels[0]?.id || null);
    } catch (err) {
      console.error("Error loading client integrations:", err);
      setError(t("integrationsPage.loadErrorGeneric"));
    } finally {
      setLoading(false);
    }
  }

  function getFeatureById(featureId) {
    return planFeatures.find((f) => f.id === featureId);
  }

  const activeIntegrations = integrations;
  const enabledIntegrations = integrations.filter((i) => i.is_active);
  const availableFeatures = planFeatures.filter(
    (f) => !integrations.some((i) => i.feature_id === f.id)
  );

  const filteredIntegrations = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return activeIntegrations;

    return activeIntegrations.filter((integration) => {
      const feature = getFeatureById(integration.feature_id);
      const text = `${feature?.name || ""} ${feature?.slug || ""} ${feature?.description || ""}`.toLowerCase();
      return text.includes(value);
    });
  }, [query, activeIntegrations, planFeatures]);

  const selectedIntegration =
    integrations.find((integration) => integration.id === selectedIntegrationId) ||
    integrations[0] ||
    null;

  const selectedFeature = selectedIntegration
    ? getFeatureById(selectedIntegration.feature_id)
    : null;
  const selectedFields = normalizeFields(selectedFeature);

  const visibleSelectedFields = useMemo(() => {
    const slug = `${selectedFeature?.slug || ""}`.toLowerCase();

    if (slug === "whatsapp_evolution") {
      return selectedFields.filter((field) => isReplyModeKey(field?.key || field?.label));
    }

    // Instagram renders its own dedicated setup surface
    // (InstagramSetupSection) — the internal channelKey stays hidden and
    // every other field, incl. reply_mode, is owned by that section.
    if (slug.includes("instagram")) {
      return [];
    }

    return selectedFields;
  }, [selectedFeature, selectedFields]);

  async function callIntegrationAction(action, payload = {}) {
    const response = await fetch("/api/client-integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actor_user_id: user?.id, ...payload }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.message || t("integrationsPage.actionFailedGeneric"));
    }
    return data;
  }

  async function toggleActive(featureId, currentValue) {
    setError("");
    setSuccess("");

    try {
      await callIntegrationAction("set_active", { feature_id: featureId, is_active: !currentValue });

      setIntegrations((prev) =>
        prev.map((item) =>
          item.feature_id === featureId ? { ...item, is_active: !currentValue } : item
        )
      );
    } catch (err) {
      setError(err.message || t("integrationsPage.statusToggleFailed"));
    }
  }

  function handleFieldChange(integrationId, key, value) {
    setIntegrations((prev) =>
      prev.map((intg) =>
        intg.id === integrationId
          ? {
              ...intg,
              config: {
                ...(intg.config || {}),
                [key]: value,
              },
            }
          : intg
      )
    );
  }

  // Drops any legacy reply-mode key (e.g. an admin-defined "Reply Mode"
  // field name that used to be written verbatim instead of the canonical
  // "reply_mode") once a real reply_mode value exists, so a saved config
  // never persists two competing keys for the same setting — n8n only ever
  // reads config.reply_mode, so a stale second key made the dropdown look
  // like it worked while runtime behavior silently kept using the old value.
  function cleanReplyModeConfig(config) {
    const source = config || {};
    if (!Object.prototype.hasOwnProperty.call(source, "reply_mode")) return source;

    const cleaned = {};
    for (const [key, value] of Object.entries(source)) {
      if (key !== "reply_mode" && isReplyModeKey(key)) continue;
      cleaned[key] = value;
    }
    return cleaned;
  }

  async function handleSaveIntegration(integration) {
    if (!integration) return;

    try {
      setSavingId(integration.id);
      setError("");
      setSuccess("");

      const feature = getFeatureById(integration.feature_id);
      const slug = `${feature?.slug || ""}`.toLowerCase();

      if (slug.includes("instagram")) {
        // Instagram save goes through its own server action: it never
        // echoes the stored Page Access Token back, generates/persists the
        // verify token once, and sets the immutable internal channelKey.
        const cfg = integration.config || {};
        const resp = await callIntegrationAction("save_instagram_config", {
          feature_id: integration.feature_id,
          instagram_account_id: cfg.instagram_account_id ?? "",
          facebook_page_id: cfg.facebook_page_id ?? "",
          reply_mode: cfg.reply_mode ?? "",
          // Only sent when the client actually typed a new value — a blank
          // field means "keep the stored token".
          ...(cfg.page_access_token ? { page_access_token: cfg.page_access_token } : {}),
        });

        setIntegrations((prev) =>
          prev.map((item) =>
            item.id === integration.id
              ? { ...item, config: resp.config || {}, config_flags: resp.config_flags || item.config_flags }
              : item
          )
        );

        setSuccess(t("integrationsPage.saveConfigSuccess"));
        return;
      }

      const cleanedConfig = cleanReplyModeConfig(integration.config);

      // is_active is persisted separately by toggleActive (an immediate,
      // subscription-gated action) — this only saves configuration, which
      // stays available as maintenance even when the subscription lapses.
      await callIntegrationAction("save_config", {
        feature_id: integration.feature_id,
        config: cleanedConfig,
      });

      setIntegrations((prev) =>
        prev.map((item) =>
          item.id === integration.id ? { ...item, config: cleanedConfig } : item
        )
      );

      setSuccess(t("integrationsPage.saveConfigSuccess"));
    } catch (err) {
      console.error(err);
      setError(err.message || t("integrationsPage.saveConfigFailed"));
    } finally {
      setSavingId(null);
    }
  }

  // Website Chat card state follows WebsiteChatSection's site list.
  function handleWebsiteChatSitesChange(sites) {
    setIntegrations((prev) =>
      prev.map((item) => (item.id === WEBSITE_CHAT_CARD_ID ? websiteChatCard(item.feature_id, sites) : item))
    );
  }

  async function handleAddIntegration(feature) {
    // Website Chat never uses the generic `add` (the server refuses it):
    // open its card; sites are created by WebsiteChatSection ("create").
    if (isWebsiteChatSlug(feature?.slug)) {
      setIntegrations((prev) =>
        prev.some((item) => item.id === WEBSITE_CHAT_CARD_ID) ? prev : [...prev, websiteChatCard(feature.id, [])]
      );
      setSelectedIntegrationId(WEBSITE_CHAT_CARD_ID);
      return;
    }

    try {
      setSavingId(feature.id);
      setError("");
      setSuccess("");

      const { integration: data } = await callIntegrationAction("add", { feature_id: feature.id });

      const normalized = { ...data, config: data.config || {} };
      setIntegrations((prev) => [...prev, normalized]);
      setSelectedIntegrationId(normalized.id);
      setSuccess(t("integrationsPage.addIntegrationSuccess"));
    } catch (err) {
      console.error(err);
      setError(err.message || t("integrationsPage.addIntegrationFailed"));
    } finally {
      setSavingId(null);
    }
  }

  const displayName = client?.business_name || user?.name || t("integrationsPage.defaultClientName");

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("integrationsPage.title")}
        description={t("integrationsPage.subtitle", { name: displayName })}
        actions={
          <button onClick={fetchData} className={ui.btnSecondary}>
            <ArrowPathIcon className="h-4 w-4" />
            {t("common.refresh")}
          </button>
        }
      />

      {(error || success) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            error
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error || success}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t("integrationsPage.statAvailable")} value={planFeatures.length} hint={t("integrationsPage.statAvailableHint")} icon={Squares2X2Icon} />
        <StatCard label={t("integrationsPage.statConnected")} value={integrations.length} hint={t("integrationsPage.statConnectedHint")} icon={LinkIcon} />
        <StatCard label={t("integrationsPage.statActiveNow")} value={enabledIntegrations.length} hint={t("integrationsPage.statActiveNowHint")} icon={CheckCircleIcon} />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-500 shadow-sm">
          {t("integrationsPage.loadingIntegrations")}
        </div>
      ) : (
        <div className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(320px,380px)_1fr]">
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-900">{t("integrationsPage.channelListTitle")}</h2>
                  <p className="mt-1 text-xs text-slate-500">{t("integrationsPage.channelListSubtitle")}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {filteredIntegrations.length}
                </span>
              </div>

              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("integrationsPage.searchPlaceholder")}
                className={`mt-3 ${ui.input} bg-slate-50 focus:bg-white`}
              />
            </div>

            <div className="max-h-[520px] space-y-2 overflow-y-auto p-3">
              {filteredIntegrations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
                  {t("integrationsPage.noChannelsActive")}
                </div>
              ) : (
                filteredIntegrations.map((intg) => {
                  const feature = getFeatureById(intg.feature_id);
                  const meta = getFeatureMeta(feature, t);
                  const isSelected = selectedIntegration?.id === intg.id;

                  return (
                    <button
                      key={intg.id}
                      onClick={() => setSelectedIntegrationId(intg.id)}
                      className={`w-full rounded-2xl border p-3 text-start transition ${
                        isSelected
                          ? "border-indigo-200 bg-indigo-50/70 shadow-sm"
                          : "border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <ChannelIcon channel={feature?.slug} size="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="truncate text-sm font-semibold text-slate-950">{feature?.name || meta.label}</h3>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                intg.is_active
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-slate-100 text-slate-500"
                              }`}
                            >
                              {intg.is_active ? t("common.active") : t("common.paused")}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-500">{feature?.slug || meta.label}</p>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {selectedIntegration && selectedFeature ? (
              <div className="flex h-full flex-col">
                {(() => {
                  const meta = getFeatureMeta(selectedFeature, t);

                  // Website Chat: its own section only — no generic toggle,
                  // save, field editor, reply-mode summary or setup links.
                  if (isWebsiteChatSlug(selectedFeature.slug)) {
                    return (
                      <>
                        <div className="flex items-center gap-3 border-b border-slate-100 p-4">
                          <ChannelIcon channel={selectedFeature?.slug} size="h-9 w-9" iconSize="h-6 w-6" />
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h2 className="text-[15px] font-semibold text-slate-900">{selectedFeature.name || meta.label}</h2>
                              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.soft}`}>
                                {selectedIntegration.is_active ? t("common.active") : t("common.paused")}
                              </span>
                            </div>
                            <p className="mt-0.5 text-sm text-slate-500">{selectedFeature.description || meta.description}</p>
                          </div>
                        </div>
                        <div className="p-4">
                          <WebsiteChatSection
                            actorUserId={user?.id}
                            maxConnections={selectedFeature.max_connections}
                            subscriptionActive={subscriptionActive}
                            onSitesChange={handleWebsiteChatSitesChange}
                          />
                        </div>
                      </>
                    );
                  }

                  return (
                    <>
                      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex min-w-0 items-center gap-3">
                          <ChannelIcon channel={selectedFeature?.slug} size="h-9 w-9" iconSize="h-6 w-6" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h2 className="text-[15px] font-semibold text-slate-900">{selectedFeature.name || meta.label}</h2>
                              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.soft}`}>
                                {selectedIntegration.is_active ? t("common.connected") : t("common.paused")}
                              </span>
                            </div>
                            <p className="mt-0.5 text-sm text-slate-500">{selectedFeature.description || meta.description}</p>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            onClick={() => toggleActive(selectedIntegration.feature_id, selectedIntegration.is_active)}
                            disabled={!selectedIntegration.is_active && !subscriptionActive}
                            title={!selectedIntegration.is_active && !subscriptionActive ? t("integrationsPage.subscriptionInactiveActivateTooltip") : undefined}
                            className={`inline-flex h-9 items-center rounded-xl px-3.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              selectedIntegration.is_active
                                ? "bg-slate-100 text-slate-700 hover:bg-slate-200"
                                : "bg-emerald-600 text-white hover:bg-emerald-700"
                            }`}
                          >
                            {selectedIntegration.is_active ? t("integrationsPage.pause") : t("common.activate")}
                          </button>
                          <button
                            onClick={() => handleSaveIntegration(selectedIntegration)}
                            disabled={savingId === selectedIntegration.id}
                            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
                          >
                            <Cog6ToothIcon className="h-4 w-4" />
                            {savingId === selectedIntegration.id ? t("common.saving") : t("common.save")}
                          </button>
                        </div>
                      </div>

                      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[1fr_280px]">
                        <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                          <h3 className="text-sm font-semibold text-slate-950">{t("navigation.settings")}</h3>
                          <p className="mt-1 text-xs text-slate-500">{t("integrationsPage.settingsSubtitle")}</p>

                          {/* Multi-Account Stage 2B — pre-migration audit
                              fix: for Facebook specifically, both this
                              legacy panel AND FacebookAccountsSection
                              (embedded further below) render on the same
                              screen during the transition period. This
                              label makes the distinction explicit without
                              touching the panel's own field-editing logic
                              (deliberately left unmodified, per
                              instruction — it remains the live source n8n
                              actually reads). Not shown for any other
                              channel, since no other channel currently has
                              a competing new-model section rendered
                              alongside it. */}
                          {FACEBOOK_MULTI_ACCOUNT_ENABLED && selectedFeature.slug === "facebook" && (
                            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
                              الإعداد الفعّال حاليًا (Current active configuration)
                            </div>
                          )}

                          {visibleSelectedFields.length > 0 ? (
                            <div className="mt-4 grid gap-3 md:grid-cols-2">
                              {visibleSelectedFields.map((field) => {
                                const cfg = selectedIntegration.config || {};

                                // reply_mode is stored as a free-form string in config (no
                                // schema change), but guided here as a dropdown so it can't
                                // be mistyped. Same dropdown, same options, same order on
                                // every channel (Facebook, Telegram, Instagram, WhatsApp
                                // Evolution) — see src/lib/replyMode.js, the single shared
                                // source for this instead of duplicating it per channel.
                                // `welcome_only` is prepared for a future reply-behavior
                                // n8n does not implement yet — selecting it only saves the
                                // config value; it does not change is_active and does not
                                // simulate any runtime behavior here.
                                const isReplyModeField = isReplyModeKey(field.key);

                                // The reply-mode field always reads/writes the canonical
                                // config.reply_mode key — never the admin-defined field
                                // label (e.g. "Reply Mode"), which is what n8n does NOT
                                // read and previously left the dropdown unable to affect
                                // runtime behavior. See handleSaveIntegration for the
                                // cleanup of any legacy "Reply Mode" key still on disk.
                                let value;
                                if (isReplyModeField) {
                                  value = cfg.reply_mode;
                                } else {
                                  value = cfg[field.key];
                                  if (value === undefined) {
                                    const normLabel = normalizeName(field.key);
                                    const found = Object.entries(cfg).find(([k]) => normalizeName(k) === normLabel);
                                    value = found ? found[1] : "";
                                  }
                                }

                                if (isReplyModeField) {
                                  const options = getReplyModeSelectOptions(value, t);

                                  return (
                                    <label key={field.key} className="block">
                                      <span className="mb-1.5 block text-xs font-semibold text-slate-600">{field.label || field.key}</span>
                                      <select
                                        className={ui.input}
                                        value={value || DEFAULT_REPLY_MODE}
                                        onChange={(e) => handleFieldChange(selectedIntegration.id, "reply_mode", e.target.value)}
                                      >
                                        {options.map((opt) => (
                                          <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                          </option>
                                        ))}
                                      </select>
                                      <p className="mt-1 text-[11px] leading-5 text-slate-500">
                                        {t("replyMode.welcomeOnlyHint")}
                                      </p>
                                    </label>
                                  );
                                }

                                return (
                                  <label key={field.key} className="block">
                                    <span className="mb-1.5 block text-xs font-semibold text-slate-600">{field.label || field.key}</span>
                                    <input
                                      type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                                      className={ui.input}
                                      value={value}
                                      onChange={(e) => handleFieldChange(selectedIntegration.id, field.key, e.target.value)}
                                      placeholder={field.placeholder || t("integrationsPage.fieldPlaceholder")}
                                    />
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-center text-sm text-slate-500">
                              {t("integrationsPage.noCustomFields")}
                            </div>
                          )}

                          {selectedFeature.slug === "whatsapp_evolution" && (
                            <WhatsAppEvolutionSection
                              clientId={clientId}
                              integration={selectedIntegration}
                              maxConnections={selectedFeature.max_connections}
                              subscriptionActive={subscriptionActive}
                            />
                          )}

                          {`${selectedFeature.slug || ""}`.toLowerCase().includes("instagram") && (
                            <InstagramSetupSection
                              config={selectedIntegration.config || {}}
                              hasPageAccessToken={
                                !!selectedIntegration.config_flags?.has_page_access_token
                              }
                              webhookBase={inboundWebhookBase || ""}
                              onFieldChange={(key, value) =>
                                handleFieldChange(selectedIntegration.id, key, value)
                              }
                            />
                          )}

                          {/* Multi-Account Stage 2B — additive, alongside
                              the legacy single-integration panel above,
                              not a replacement for it. The generic field
                              editor above this line (channelKey/reply_mode
                              etc., driven by visibleSelectedFields) still
                              reads/writes selectedIntegration.config via
                              client_feature_integrations exactly as it
                              always has -- an existing Facebook client's
                              legacy integration stays fully visible and
                              editable there, completely unaffected by
                              whether client_facebook has any rows yet.
                              FacebookAccountsSection owns its own entirely
                              separate data source (client_facebook, via
                              /api/client-facebook -- RLS-protected, never
                              queried directly from the browser) and its
                              own plan limit (plans.facebook_accounts_limit,
                              returned by that same endpoint) -- it does
                              not read selectedFeature.max_connections
                              (that's the legacy plan_features.
                              max_connections column, explicitly not used
                              for this new per-channel limit). A client
                              with zero client_facebook rows simply sees
                              this section's own empty state; nothing here
                              can make the legacy integration above
                              disappear.

                              Gated behind FACEBOOK_MULTI_ACCOUNT_ENABLED
                              (see that constant's own comment, top of
                              file) — pre-migration/pre-deploy audit
                              Priority 1 fix: hidden by default in
                              production (and anywhere the env var isn't
                              explicitly set) rather than shown as a
                              second active-looking configuration surface
                              while it has no runtime path to n8n yet. */}
                          {FACEBOOK_MULTI_ACCOUNT_ENABLED && selectedFeature.slug === "facebook" && (
                            <FacebookAccountsSection
                              clientId={clientId}
                              actorUserId={user?.id}
                              subscriptionActive={subscriptionActive}
                            />
                          )}
                        </div>

                        <aside className="space-y-3">
                          <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("common.status")}</p>
                            <div className="mt-2 flex items-start gap-2">
                              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${selectedIntegration.is_active ? "bg-emerald-500" : "bg-slate-300"}`} />
                              <span className="text-sm font-semibold text-slate-900">
                                {selectedIntegration.is_active ? t("integrationsPage.readyToReceive") : t("integrationsPage.integrationPaused")}
                              </span>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("integrationsPage.replyModeLabel")}</p>
                            <p className="mt-2 rounded-xl bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-700">
                              {getReplyModeLabel(selectedIntegration.config?.reply_mode || selectedIntegration.config?.mode, t)}
                            </p>
                          </div>

                        </aside>
                      </div>

                      {/* Automatic Setup Links — full width (was inside the 280px
                          aside): long URLs, hints and the activation QR
                          need the room. Same gate, same links, same QR. */}
                      <div className="px-4 pb-4 empty:hidden">
                          {showsGenericSetupLinks(selectedFeature.slug) && (() => {
                            const generatedLinks = buildGeneratedLinks(selectedFeature, selectedIntegration, t, inboundWebhookBase);
                            return (
                              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 shadow-sm">
                                <button
                                  type="button"
                                  onClick={() => setShowAdvancedSetup((prev) => !prev)}
                                  className="flex w-full items-center justify-between gap-3 text-start"
                                >
                                  <div>
                                    <p className="text-sm font-semibold text-slate-900">{t("integrationsPage.setupLinksTitle")}</p>
                                    <p className="mt-1 text-xs text-slate-500">{t("integrationsPage.setupLinksSubtitle")}</p>
                                  </div>
                                  <ChevronDownIcon className={`h-4 w-4 shrink-0 text-slate-500 transition ${showAdvancedSetup ? "rotate-180" : ""}`} />
                                </button>

                                {showAdvancedSetup && (
                                  <div className="mt-3 space-y-3">
                                    {generatedLinks.length > 0 ? (
                                      generatedLinks.map((link) => <SetupLinkCard key={link.label} {...link} />)
                                    ) : !inboundWebhookBase ? (
                                      <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50/60 p-4 text-xs leading-6 text-amber-800">
                                        {t("integrationsPage.inboundWebhookNotConfigured")}
                                      </div>
                                    ) : (
                                      <div className="rounded-2xl border border-dashed border-indigo-200 bg-white/70 p-4 text-xs leading-6 text-slate-500">
                                        {t("integrationsPage.setupLinksEmptyPrefix")} <span className="font-semibold text-slate-700">Channel Key</span>
                                        {`${selectedFeature?.slug || ""}`.toLowerCase().includes("telegram") ? ` ${t("integrationsPage.setupLinksEmptyAndBotToken")}` : ""}
                                        {" "}{t("integrationsPage.setupLinksEmptySuffix")}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="grid h-full min-h-[520px] place-items-center p-4 text-center">
                <div>
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
                    <LinkIcon className="h-7 w-7" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">{t("integrationsPage.noChannelSelectedTitle")}</h3>
                  <p className="mt-1 max-w-sm text-sm text-slate-500">{t("integrationsPage.noChannelSelectedSubtitle")}</p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {!loading && availableFeatures.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900">{t("integrationsPage.availableChannelsTitle")}</h2>
              <p className="mt-1 text-xs text-slate-500">{t("integrationsPage.availableChannelsSubtitle")}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {availableFeatures.map((feature) => {
              const meta = getFeatureMeta(feature, t);
              return (
                <div key={feature.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-center gap-3">
                    <ChannelIcon channel={feature?.slug} size="h-9 w-9" />
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-slate-950">{feature.name || meta.label}</h3>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{feature.slug}</p>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-xs text-slate-500">{feature.description || meta.description}</p>
                  <button
                    onClick={() => handleAddIntegration(feature)}
                    disabled={savingId === feature.id || !subscriptionActive}
                    title={!subscriptionActive ? t("integrationsPage.subscriptionInactiveAddTooltip") : undefined}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PlusIcon className="h-4 w-4" />
                    {savingId === feature.id ? t("integrationsPage.activating") : !subscriptionActive ? t("integrationsPage.subscriptionInactiveShort") : t("common.activate")}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
