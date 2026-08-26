import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  BoltIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import KnowledgeBaseSection from "../client/KnowledgeBaseSection.jsx";

function getFeatureMeta(feature, t) {
  const slug = String(feature?.slug || "").toLowerCase();
  const featureMeta = {
    telegram: {
      title: "Telegram",
      accent: "blue",
      icon: PaperAirplaneIcon,
      description: t("featureSettingsPage.metaTelegramDesc"),
    },
    facebook: {
      title: "Facebook Page",
      accent: "indigo",
      icon: LinkIcon,
      description: t("featureSettingsPage.metaFacebookDesc"),
    },
    instagram: {
      title: "Instagram",
      accent: "pink",
      icon: SparklesIcon,
      description: t("featureSettingsPage.metaInstagramDesc"),
    },
    whatsapp: {
      title: "WhatsApp Cloud API",
      accent: "emerald",
      icon: BoltIcon,
      description: t("featureSettingsPage.metaWhatsappDesc"),
    },
    ai_auto_reply: {
      title: t("replyMode.ai"),
      accent: "violet",
      icon: SparklesIcon,
      description: t("featureSettingsPage.metaAiDesc"),
    },
  };
  const fallback = {
    title: feature?.name || slug || t("featureSettingsPage.metaDefaultLabel"),
    accent: "slate",
    icon: Cog6ToothIcon,
    description: feature?.description || t("featureSettingsPage.metaDefaultDesc"),
  };
  return { ...fallback, ...(featureMeta[slug] || {}) };
}

const ACCENT_CLASSES = {
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-100",
  pink: "bg-pink-50 text-pink-700 ring-pink-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  violet: "bg-violet-50 text-violet-700 ring-violet-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
};

// Display-only translation maps — same terminology used on the Client
// Dashboard for the identical subscriptions.status / subscription_type
// values, so admins and clients see the same labels for the same data
// instead of a raw English enum on this page only.
function getStatusLabel(status, t) {
  const map = {
    active: t("common.active"),
    trial: t("common.trial"),
    expired: t("common.expired"),
    suspended: t("common.suspended"),
    cancelled: t("common.cancelled"),
    upgraded: t("common.upgraded"),
  };
  return map[status] || status;
}

function getSubscriptionTypeLabel(type, t) {
  const map = { trial: t("common.trial"), paid: t("common.paid") };
  return map[type] || type;
}

function maskSecret(value, t) {
  const text = String(value || "");
  if (!text) return t("featureSettingsPage.incomplete");
  if (text.length <= 8) return "••••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function getConfiguredCount(feature, values) {
  const fields =
    feature?.fields && typeof feature.fields === "object" && !Array.isArray(feature.fields)
      ? Object.keys(feature.fields)
      : [];

  if (!fields.length) return { done: 0, total: 0 };

  const done = fields.filter((field) => String(values?.[field] || "").trim()).length;
  return { done, total: fields.length };
}

function buildSetupLinks({ activeFeature, featureValues }, t) {
  const slug = activeFeature?.slug;
  const channelKey = String(featureValues?.channelKey || "").trim();
  const webhookBase = String(import.meta.env.VITE_WEBHOOK_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");

  const links = [];

  if (slug && webhookBase && channelKey) {
    links.push({
      label: "Webhook URL",
      value: `${webhookBase}/${slug}/${channelKey}`,
      type: "webhook",
    });
  }

  if (slug === "telegram") {
    const botToken = String(featureValues?.["Bot Token"] || "").trim();
    const webhookUrl = links.find((item) => item.type === "webhook")?.value;

    if (botToken && webhookUrl) {
      links.push({
        label: t("featureSettingsPage.telegramActivationLinkLabel"),
        value: `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`,
        type: "activation",
      });
    }
  }

  return links;
}

function formatDate(value) {
  if (!value) return "-";

  try {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "-";
  }
}

function getRemainingDays(endDate) {
  if (!endDate) return 0;

  const now = new Date();
  const end = new Date(endDate);

  const diff = end.getTime() - now.getTime();

  return Math.max(
    0,
    Math.ceil(diff / (1000 * 60 * 60 * 24))
  );
}



function getUsagePercent(used, limit) {
  if (!limit) return 0;

  return Math.min(
    100,
    Math.round((used / limit) * 100)
  );
}

function getUsageStatus(percent, t) {
  if (percent >= 100)
    return {
      label: t("featureSettingsPage.usageStatusMax"),
      color: "text-rose-600",
    };

  if (percent >= 80)
    return {
      label: t("featureSettingsPage.usageStatusNear"),
      color: "text-amber-600",
    };

  return {
    label: t("featureSettingsPage.usageStatusGood"),
    color: "text-emerald-600",
  };
}



// AI Engine V1 — Phase 2. The ai_auto_reply feature's entire drawer body:
// personality/reply_tone/default_language/special_instructions/
// booking_instructions/escalation_instructions/forbidden_rules, bound to
// public.client_ai_behavior (via /api/client-ai-behavior), NOT to
// client_feature_integrations.config — deliberately no business-fact
// field (business_name/description/phone/working_hours) is rendered here
// at all; those live only in Account Settings now (ClientSettings.jsx).
// Reply Tone quick-select chips — stored value stays the plain lowercase
// English word (matching the legacy client_feature_integrations.config
// convention this dual-writes to, e.g. "friendly"), only the displayed
// chip label is translated. Clicking a chip sets the field; the input
// below stays fully editable for a custom tone, satisfying "predefined
// common choices plus custom option".
const REPLY_TONE_PRESETS = [
  { value: "friendly", labelKey: "aiBehaviorToneFriendly" },
  { value: "professional", labelKey: "aiBehaviorToneProfessional" },
  { value: "casual", labelKey: "aiBehaviorToneCasual" },
  { value: "formal", labelKey: "aiBehaviorToneFormal" },
  { value: "enthusiastic", labelKey: "aiBehaviorToneEnthusiastic" },
];

function AiBehaviorFormBody({
  t,
  loading,
  readOnly,
  form,
  onChange,
  newForbiddenRule,
  onNewForbiddenRuleChange,
  onAddForbiddenRule,
  onRemoveForbiddenRule,
}) {
  const fieldClass =
    "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50 disabled:opacity-60";

  if (loading) {
    return <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">{t("featureSettingsPage.loadingFeatureSettings")}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
        <p className="text-sm font-semibold text-violet-800">{t("featureSettingsPage.aiBehaviorTitle")}</p>
        <p className="mt-1 text-xs text-violet-700">{t("featureSettingsPage.aiBehaviorSubtitle")}</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorPersonality")}</label>
        <p className="mb-1.5 text-xs text-slate-500">{t("featureSettingsPage.aiBehaviorPersonalityHelp")}</p>
        <input
          type="text"
          value={form.personality}
          onChange={(e) => onChange("personality", e.target.value)}
          placeholder={t("featureSettingsPage.aiBehaviorPersonalityPlaceholder")}
          className={fieldClass}
          disabled={readOnly}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorReplyTone")}</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {REPLY_TONE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                disabled={readOnly}
                onClick={() => onChange("reply_tone", preset.value)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition disabled:opacity-60 ${
                  form.reply_tone === preset.value
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {t(`featureSettingsPage.${preset.labelKey}`)}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={form.reply_tone}
            onChange={(e) => onChange("reply_tone", e.target.value)}
            placeholder={t("featureSettingsPage.aiBehaviorReplyTonePlaceholder")}
            className={fieldClass}
            disabled={readOnly}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorLanguage")}</label>
          <select
            value={form.default_language}
            onChange={(e) => onChange("default_language", e.target.value)}
            className={fieldClass}
            disabled={readOnly}
          >
            <option value="">—</option>
            <option value="ar">{t("featureSettingsPage.aiBehaviorLanguageArabic")}</option>
            <option value="en">{t("featureSettingsPage.aiBehaviorLanguageEnglish")}</option>
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 p-4">
        <div className="mb-3">
          <h4 className="text-sm font-bold text-slate-800">{t("featureSettingsPage.aiBehaviorInstructionsGroupTitle")}</h4>
          <p className="text-xs text-slate-500">{t("featureSettingsPage.aiBehaviorInstructionsGroupSubtitle")}</p>
        </div>
        <div className="space-y-4 divide-y divide-slate-100">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorSpecialInstructions")}</label>
            <textarea
              rows={2}
              value={form.special_instructions}
              onChange={(e) => onChange("special_instructions", e.target.value)}
              placeholder={t("featureSettingsPage.aiBehaviorSpecialInstructionsPlaceholder")}
              className={fieldClass}
              disabled={readOnly}
            />
          </div>
          <div className="pt-4">
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorBookingInstructions")}</label>
            <textarea
              rows={2}
              value={form.booking_instructions}
              onChange={(e) => onChange("booking_instructions", e.target.value)}
              placeholder={t("featureSettingsPage.aiBehaviorBookingInstructionsPlaceholder")}
              className={fieldClass}
              disabled={readOnly}
            />
          </div>
          <div className="pt-4">
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorEscalationInstructions")}</label>
            <textarea
              rows={2}
              value={form.escalation_instructions}
              onChange={(e) => onChange("escalation_instructions", e.target.value)}
              placeholder={t("featureSettingsPage.aiBehaviorEscalationInstructionsPlaceholder")}
              className={fieldClass}
              disabled={readOnly}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-semibold text-slate-700">{t("featureSettingsPage.aiBehaviorForbiddenRules")}</label>
        <p className="mb-2 text-xs text-slate-500">{t("featureSettingsPage.aiBehaviorForbiddenRulesSubtitle")}</p>

        {form.forbidden_rules.length === 0 ? (
          <p className="mb-2 text-xs text-slate-400">{t("featureSettingsPage.aiBehaviorForbiddenRulesEmpty")}</p>
        ) : (
          <div className="mb-3 flex flex-wrap gap-2">
            {form.forbidden_rules.map((rule, index) => (
              <span key={index} className="inline-flex max-w-full items-center gap-2 rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-100">
                <span className="truncate">{rule}</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onRemoveForbiddenRule(index)}
                    aria-label={t("common.delete")}
                    className="shrink-0 rounded-full p-0.5 text-rose-500 hover:bg-rose-100"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {!readOnly && (
          <div className="flex gap-2">
            <input
              type="text"
              value={newForbiddenRule}
              onChange={(e) => onNewForbiddenRuleChange(e.target.value)}
              placeholder={t("featureSettingsPage.aiBehaviorForbiddenRulesPlaceholder")}
              className={`${fieldClass} flex-1`}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAddForbiddenRule();
                }
              }}
            />
            <button
              type="button"
              onClick={onAddForbiddenRule}
              className="shrink-0 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {t("featureSettingsPage.aiBehaviorForbiddenRulesAdd")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminClientSettings({ clientIdOverride }) {
  const params = useParams();
  const effectiveClientId = clientIdOverride || params.id;
  const { user } = useAuth();
  const { t } = useTranslation();

  const [client, setClient] = useState(null);
  const [plan, setPlan] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeSubscription, setActiveSubscription] = useState(null);
  
  const [plansList, setPlansList] = useState([]);

  const [subscriptionDrawerOpen, setSubscriptionDrawerOpen] = useState(false);
  const [savingSubscription, setSavingSubscription] = useState(false);

  const [subscriptionForm, setSubscriptionForm] = useState({
	  plan_id: "",
	  subscription_type: "paid",
	  duration: "1",
  });

  const [features, setFeatures] = useState([]);
  const [featureSettings, setFeatureSettings] = useState({});

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);
  const [settingsRowId, setSettingsRowId] = useState(null);
  const [featureValues, setFeatureValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [showTelegramGuide, setShowTelegramGuide] = useState(false);
  const [copiedValue, setCopiedValue] = useState("");

  // AI Engine V1 — Phase 2. ai_auto_reply's drawer content is entirely
  // separate from the generic client_feature_integrations.config field
  // loop below (see openFeatureDrawer/handleSaveFeature) — it reads/
  // writes public.client_ai_behavior via /api/client-ai-behavior instead.
  // newForbiddenRule is the draft text for the "add rule" input in the
  // Forbidden Rules list editor.
  const EMPTY_AI_BEHAVIOR_FORM = {
    personality: "",
    reply_tone: "",
    default_language: "",
    special_instructions: "",
    booking_instructions: "",
    escalation_instructions: "",
    forbidden_rules: [],
  };
  const [aiBehaviorForm, setAiBehaviorForm] = useState(EMPTY_AI_BEHAVIOR_FORM);
  const [aiBehaviorLoading, setAiBehaviorLoading] = useState(false);
  const [newForbiddenRule, setNewForbiddenRule] = useState("");

  useEffect(() => {
    if (effectiveClientId) {
      fetchClientAndFeatures(effectiveClientId);
    } else {
      setLoading(false);
      setMsg(t("featureSettingsPage.errNoClientSelected"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveClientId]);

  async function fetchClientAndFeatures(clientId) {
    setLoading(true);
    setMsg("");

    try {
      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .select("id, business_name, email, plan_id")
        .eq("id", clientId)
        .single();

      if (clientError || !clientData) {
        console.error(clientError);
        setMsg(t("featureSettingsPage.errClientNotFound"));
        setLoading(false);
        return;
      }

      setClient(clientData);

      let planData = null;
      if (clientData.plan_id) {
        const { data, error } = await supabase
          .from("plans")
          .select("id, name, allow_self_edit")
          .eq("id", clientData.plan_id)
          .maybeSingle();

        if (error) console.error(error);
        planData = data || null;
      }
      setPlan(planData);

	const { data: plansData } = await supabase
	  .from("plans")
	  .select("id,name,price")
	  .order("price", { ascending: true });

	setPlansList(plansData || []);


	const { data: subscriptionsData, error: subscriptionsError } =
	  await supabase
		.from("subscriptions")
		.select(`
		  id,
		  subscription_type,
		  status,
		  start_date,
		  end_date,
		  closed_at,
		  created_at,
		  messages_used,
		  ai_replies_used,
		  auto_replies_used,
		  plans (
			name,
			messages_limit,
			ai_replies_limit
		  )
		`)
		.eq("client_id", clientId)
		.order("created_at", { ascending: false });

	if (subscriptionsError) {
	  console.error(subscriptionsError);
	} else {
	  setSubscriptions(subscriptionsData || []);
	  
console.log("subscriptions", subscriptionsData);
	  
	  const activeSub = (subscriptionsData || []).find(
		  (s) => s.status === "active"
		);

console.log("activeSub", activeSub);

		setActiveSubscription(activeSub || null);
	}


      if (!clientData.plan_id) {
        setFeatures([]);
        setFeatureSettings({});
        setLoading(false);
        return;
      }

      const { data: pfData, error: pfError } = await supabase
        .from("plan_features")
        .select("feature_id")
        .eq("plan_id", clientData.plan_id);

      if (pfError) {
        console.error(pfError);
        setMsg(t("featureSettingsPage.errPlanFeaturesFetch"));
        setFeatures([]);
        setLoading(false);
        return;
      }

      const featureIds = (pfData || []).map((x) => x.feature_id).filter(Boolean);
      if (!featureIds.length) {
        setFeatures([]);
        setFeatureSettings({});
        setLoading(false);
        return;
      }

      const { data: featuresData, error: featuresError } = await supabase
        .from("features")
        .select("id, name, slug, description, fields")
        .in("id", featureIds);

      if (featuresError) {
        console.error(featuresError);
        setMsg(t("featureSettingsPage.errFeaturesListFetch"));
        setFeatures([]);
      } else {
        setFeatures(featuresData || []);
      }

      const { data: integrationsData, error: integrationsError } = await supabase
        .from("client_feature_integrations")
        .select("id, feature_id, is_active, config")
        .eq("client_id", clientId);

      if (integrationsError) {
        console.error(integrationsError);
        setFeatureSettings({});
      } else {
        const settingsMap = {};
        (integrationsData || []).forEach((row) => {
          settingsMap[row.feature_id] = row;
        });
        setFeatureSettings(settingsMap);
      }
    } catch (err) {
      console.error(err);
      setMsg(t("featureSettingsPage.errUnexpectedFetch"));
    }

    setLoading(false);
  }

  async function openFeatureDrawer(feature) {
    if (!effectiveClientId) return;

    setMsg("");
    setActiveFeature(feature);
    setDrawerOpen(true);
    setSaving(false);
    setShowTelegramGuide(false);
    setCopiedValue("");

    const isAdmin = user?.role === "admin";
    const clientCanEdit = plan?.allow_self_edit === true;
    setReadOnly(!isAdmin && !clientCanEdit);

    // AI Behavior — separate table (client_ai_behavior), separate API,
    // separate drawer body. Business Profile fields are no longer part of
    // this feature's drawer at all (see the render section below).
    if (feature.slug === "ai_auto_reply") {
      setAiBehaviorLoading(true);
      setNewForbiddenRule("");
      try {
        const response = await fetch(
          `/api/client-ai-behavior?actor_user_id=${encodeURIComponent(user?.id || "")}&client_id=${encodeURIComponent(effectiveClientId)}`
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.success === false) {
          throw new Error(data?.message || t("featureSettingsPage.aiBehaviorLoadFailed"));
        }
        const behavior = data.behavior || {};
        setAiBehaviorForm({
          personality: behavior.personality || "",
          reply_tone: behavior.reply_tone || "",
          default_language: behavior.default_language || "",
          special_instructions: behavior.special_instructions || "",
          booking_instructions: behavior.booking_instructions || "",
          escalation_instructions: behavior.escalation_instructions || "",
          forbidden_rules: Array.isArray(behavior.forbidden_rules) ? behavior.forbidden_rules : [],
        });
      } catch (err) {
        console.error(err);
        setMsg(t("featureSettingsPage.aiBehaviorLoadFailed"));
        setAiBehaviorForm(EMPTY_AI_BEHAVIOR_FORM);
      }
      setAiBehaviorLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("client_feature_integrations")
      .select("id, config")
      .eq("client_id", effectiveClientId)
      .eq("feature_id", feature.id)
      .maybeSingle();

    if (error) console.error(error);

    setSettingsRowId(data?.id || null);

    const fieldsDef =
      feature.fields && typeof feature.fields === "object" && !Array.isArray(feature.fields)
        ? feature.fields
        : {};

    const existingSettings = data?.config || {};

    const initialValues = {};
    Object.entries(fieldsDef).forEach(([field]) => {
      initialValues[field] = existingSettings[field] ?? "";
    });

    setFeatureValues(initialValues);
  }

  function updateAiBehaviorField(field, value) {
    setAiBehaviorForm((prev) => ({ ...prev, [field]: value }));
  }

  function addForbiddenRule() {
    const rule = newForbiddenRule.trim();
    if (!rule) return;
    setAiBehaviorForm((prev) => ({ ...prev, forbidden_rules: [...prev.forbidden_rules, rule] }));
    setNewForbiddenRule("");
  }

  function removeForbiddenRule(index) {
    setAiBehaviorForm((prev) => ({ ...prev, forbidden_rules: prev.forbidden_rules.filter((_, i) => i !== index) }));
  }

  async function handleSaveAiBehavior(e) {
    e.preventDefault();
    if (readOnly || !effectiveClientId) return;

    setSaving(true);
    setMsg("");

    try {
      const response = await fetch("/api/client-ai-behavior", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor_user_id: user?.id,
          client_id: effectiveClientId,
          ...aiBehaviorForm,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("featureSettingsPage.aiBehaviorSaveFailed"));
      }

      const behavior = data.behavior || {};
      setAiBehaviorForm({
        personality: behavior.personality || "",
        reply_tone: behavior.reply_tone || "",
        default_language: behavior.default_language || "",
        special_instructions: behavior.special_instructions || "",
        booking_instructions: behavior.booking_instructions || "",
        escalation_instructions: behavior.escalation_instructions || "",
        forbidden_rules: Array.isArray(behavior.forbidden_rules) ? behavior.forbidden_rules : [],
      });
      setMsg(t("featureSettingsPage.aiBehaviorSaved"));
    } catch (err) {
      console.error("AI behavior save error:", err);
      setMsg(t("featureSettingsPage.aiBehaviorSaveFailed"));
    }

    setSaving(false);
  }

  function closeFeatureDrawer() {
    setDrawerOpen(false);
    setActiveFeature(null);
    setFeatureValues({});
    setSettingsRowId(null);
    setSaving(false);
    setShowTelegramGuide(false);
    setCopiedValue("");
    setAiBehaviorForm(EMPTY_AI_BEHAVIOR_FORM);
    setNewForbiddenRule("");
  }

  function handleFieldChange(fieldName, value) {
    setFeatureValues((prev) => ({ ...prev, [fieldName]: value }));
  }

	function openSubscriptionDrawer() {
	  setSubscriptionForm({
		plan_id: client?.plan_id || "",
		subscription_type: "paid",
		duration: "1",
	  });

	  setSubscriptionDrawerOpen(true);
	}

	function closeSubscriptionDrawer() {
	  setSubscriptionDrawerOpen(false);
	}

async function saveSubscription() {
  if (!subscriptionForm.plan_id) {
    setMsg(t("featureSettingsPage.errChoosePlan"));
    return;
  }

  try {
    setSavingSubscription(true);

    const { data: currentSubscriptions } =
      await supabase
        .from("subscriptions")
        .select("id,status,end_date")
        .eq("client_id", effectiveClientId)
        .in("status", ["active"]);

    if (currentSubscriptions?.length) {
      const confirmReplace = window.confirm(
        t("featureSettingsPage.confirmReplaceActiveSubscription")
      );

      if (!confirmReplace) {
        setSavingSubscription(false);
        return;
      }

      await supabase
        .from("subscriptions")
        .update({
			status: "cancelled",
			closed_at: new Date().toISOString(),
        })
        .eq("client_id", effectiveClientId)
        .in("status", ["active"]);
    }

    const startDate = new Date();

    const endDate = calculateEndDate(
      subscriptionForm.subscription_type,
      subscriptionForm.duration
    );

    const { error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .insert([
          {
            client_id: effectiveClientId,
            plan_id: subscriptionForm.plan_id,
            subscription_type: subscriptionForm.subscription_type,
			status: "active",
            start_date: startDate.toISOString(),
            end_date: endDate,
          },
        ]);

    if (subscriptionError) {
      throw subscriptionError;
    }

    await supabase
      .from("clients")
      .update({
        plan_id: subscriptionForm.plan_id,
      })
      .eq("id", effectiveClientId);

    await fetchClientAndFeatures(
      effectiveClientId
    );

    closeSubscriptionDrawer();

    setMsg(t("featureSettingsPage.subscriptionCreated"));
  } catch (err) {
    console.error(err);

    setMsg(t("featureSettingsPage.errSubscriptionCreateFailed"));
  }

  setSavingSubscription(false);
}


async function cancelSubscription() {
  if (!activeSubscription) return;

  const confirmCancel = window.confirm(
    t("featureSettingsPage.confirmCancelSubscription")
  );

  if (!confirmCancel) return;

  try {
    const { error } = await supabase
      .from("subscriptions")
      .update({
        status: "cancelled",
        closed_at: new Date().toISOString(),
      })
      .eq("id", activeSubscription.id);

    if (error) throw error;

    await fetchClientAndFeatures(
      effectiveClientId
    );

    setMsg(
      t("featureSettingsPage.subscriptionCancelled")
    );
  } catch (err) {
    console.error(err);

    setMsg(
      t("featureSettingsPage.errCancelFailed")
    );
  }
}


async function renewSubscription() {
  if (!activeSubscription) return;

  const months = window.prompt(
    t("featureSettingsPage.promptRenewMonths"),
    "1"
  );

  if (!months) return;

  try {
    const currentEnd = new Date(
      activeSubscription.end_date
    );

    currentEnd.setMonth(
      currentEnd.getMonth() + Number(months)
    );

    const { error } = await supabase
      .from("subscriptions")
      .update({
        end_date: currentEnd.toISOString(),
      })
      .eq("id", activeSubscription.id);

    if (error) throw error;

    await fetchClientAndFeatures(
      effectiveClientId
    );

    setMsg(
      t("featureSettingsPage.subscriptionRenewed", { months })
    );
  } catch (err) {
    console.error(err);

    setMsg(
      t("featureSettingsPage.errRenewFailed")
    );
  }
}



	function getStatusClass(status) {
	  switch (status) {
		case "active":
		  return "bg-emerald-50 text-emerald-700 ring-emerald-100";

		case "trial":
		  return "bg-blue-50 text-blue-700 ring-blue-100";

		case "expired":
		  return "bg-rose-50 text-rose-700 ring-rose-100";

		case "suspended":
		  return "bg-amber-50 text-amber-700 ring-amber-100";
		  
		case "upgraded":
			return "bg-violet-50 text-violet-700 ring-violet-100";

		default:
		  return "bg-slate-100 text-slate-700 ring-slate-200";
	  }
	}

function calculateEndDate(subscriptionType, duration) {
  const startDate = new Date();

  if (subscriptionType === "trial") {
    startDate.setDate(startDate.getDate() + 3);
    return startDate.toISOString();
  }

  startDate.setMonth(
    startDate.getMonth() + Number(duration || 1)
  );

  return startDate.toISOString();
}


  async function copyToClipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(""), 1500);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSaveFeature(e) {
    e.preventDefault();
    if (readOnly) return;
    if (!activeFeature || !effectiveClientId) return;

    setSaving(true);
    setMsg("");

    try {
      if (settingsRowId) {
        const { error } = await supabase
          .from("client_feature_integrations")
          .update({ config: featureValues })
          .eq("id", settingsRowId);

        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("client_feature_integrations")
          .insert([
            {
              client_id: effectiveClientId,
              feature_id: activeFeature.id,
              config: featureValues,
            },
          ])
          .select("id")
          .single();

        if (error) throw error;
        setSettingsRowId(data.id);
      }

      setMsg(t("featureSettingsPage.settingsSavedSuccess"));

      const { data: refreshed, error: refError } = await supabase
        .from("client_feature_integrations")
        .select("id, feature_id, is_active, config")
        .eq("client_id", effectiveClientId)
        .eq("feature_id", activeFeature.id)
        .maybeSingle();

      if (!refError && refreshed) {
        setSettingsRowId(refreshed.id);
        setFeatureValues(refreshed.config || {});
        setFeatureSettings((prev) => ({ ...prev, [activeFeature.id]: refreshed }));
      }
    } catch (err) {
      console.error("Save Error:", err);
      setMsg(t("featureSettingsPage.errSettingsSaveFailed"));
    }

    setSaving(false);
  }

  const isAdmin = user?.role === "admin";
  const clientCanEdit = plan?.allow_self_edit === true;
  const isTelegramFeature = activeFeature?.slug === "telegram";
  const setupLinks = useMemo(
    () => buildSetupLinks({ activeFeature, featureValues }, t),
    [activeFeature, featureValues]
  );

  const configuredFeatures = features.filter((feature) => {
    const config = featureSettings[feature.id]?.config || {};
    const { done, total } = getConfiguredCount(feature, config);
    return total > 0 && done === total;
  }).length;

  const partialFeatures = features.filter((feature) => {
    const config = featureSettings[feature.id]?.config || {};
    const { done, total } = getConfiguredCount(feature, config);
    return total > 0 && done > 0 && done < total;
  }).length;

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div className="mx-auto mb-4 h-10 w-10 animate-pulse rounded-full bg-indigo-100" />
        <p className="text-sm text-slate-500">{t("featureSettingsPage.loadingFeatureSettings")}</p>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="rounded-3xl border border-red-100 bg-red-50 p-6 text-red-700">
        {msg || t("featureSettingsPage.clientNotFound")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">
            <SparklesIcon className="h-4 w-4" />
            Feature Control Center
          </div>
          <h1 className="text-2xl font-bold text-slate-950">{t("featureSettingsPage.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("featureSettingsPage.subtitleTemplate", { business: client.business_name, email: client.email, plan: plan?.name || t("featureSettingsPage.noPlanLabel") })}
          </p>
        </div>

        <button
          type="button"
          onClick={() => fetchClientAndFeatures(effectiveClientId)}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          {t("common.refresh")}
        </button>
      </div>

      {msg && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">{t("featureSettingsPage.statAvailable")}</p>
          <p className="mt-3 text-3xl font-bold text-slate-950">{features.length}</p>
          <p className="mt-1 text-xs text-slate-400">{t("featureSettingsPage.statAvailableHint")}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">{t("featureSettingsPage.statConfigured")}</p>
          <p className="mt-3 text-3xl font-bold text-emerald-600">{configuredFeatures}</p>
          <p className="mt-1 text-xs text-slate-400">{t("featureSettingsPage.statConfiguredHint")}</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">{t("featureSettingsPage.statPartial")}</p>
          <p className="mt-3 text-3xl font-bold text-amber-500">{partialFeatures}</p>
          <p className="mt-1 text-xs text-slate-400">{t("featureSettingsPage.statPartialHint")}</p>
        </div>
      </div>

      {!isAdmin && !clientCanEdit && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
          <LockClosedIcon className="mt-0.5 h-5 w-5" />
          <p>{t("featureSettingsPage.readOnlyNotice")}</p>
        </div>
      )}

      {features.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Cog6ToothIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="font-semibold text-slate-700">{t("featureSettingsPage.noFeatures")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {features.map((feature) => {
            const meta = getFeatureMeta(feature, t);
            const Icon = meta.icon;
            const config = featureSettings[feature.id]?.config || {};
            const row = featureSettings[feature.id];
            const { done, total } = getConfiguredCount(feature, config);
            const isComplete = total > 0 && done === total;
            const isPartial = total > 0 && done > 0 && done < total;
            const statusText = isComplete ? t("featureSettingsPage.statusReady") : isPartial ? t("featureSettingsPage.statusPartial") : t("featureSettingsPage.statusNotConfigured");
            const statusClass = isComplete
              ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
              : isPartial
                ? "bg-amber-50 text-amber-700 ring-amber-100"
                : "bg-slate-100 text-slate-600 ring-slate-200";

            return (
              <div key={feature.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ${ACCENT_CLASSES[meta.accent] || ACCENT_CLASSES.slate}`}>
                      <Icon className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-slate-950">{meta.title}</h3>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusClass}`}>
                          {statusText}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-500">{feature.description || meta.description}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openFeatureDrawer(feature)}
                    className="inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                    {t("common.edit")}
                  </button>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">{t("featureSettingsPage.fieldsLabel")}</p>
                    <p className="mt-1 font-bold text-slate-800">{done}/{total}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">{t("common.status")}</p>
                    <p className="mt-1 font-bold text-slate-800">{row?.is_active === false ? t("featureSettingsPage.statusDisabled") : t("featureSettingsPage.statusEnabled")}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">Channel Key</p>
                    <p className="mt-1 truncate font-bold text-slate-800">{config.channelKey || "—"}</p>
                  </div>
                </div>

                {Object.keys(config).length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {Object.entries(config).slice(0, 4).map(([key, value]) => (
                      <span key={key} className="rounded-full bg-slate-50 px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">
                        {key}: {String(key).toLowerCase().includes("token") ? maskSecret(value, t) : String(value || "—").slice(0, 24)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-6">
        <KnowledgeBaseSection clientId={effectiveClientId} actorUserId={user?.id} readOnly={!isAdmin && !clientCanEdit} />
      </div>

<div className="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
<div className="flex items-center justify-between">
  <div>
    <h3 className="text-xl font-bold text-slate-950">
      {t("featureSettingsPage.currentSubscriptionTitle")}
    </h3>

    <p className="mt-1 text-sm text-slate-500">
      {t("featureSettingsPage.currentSubscriptionSubtitle")}
    </p>
  </div>

{isAdmin &&
 activeSubscription &&
 activeSubscription.status === "active" &&(
  <div className="flex gap-2">
    <button
      type="button"
      onClick={renewSubscription}
      className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
    >
      {t("featureSettingsPage.renew")}
    </button>

    <button
      type="button"
      onClick={cancelSubscription}
      className="rounded-2xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
    >
      {t("featureSettingsPage.cancelSubscription")}
    </button>
  </div>
)}
</div>

  {!activeSubscription ? (
    <div className="mt-5 rounded-2xl border border-dashed border-slate-200 p-6 text-center text-slate-500">
      {t("featureSettingsPage.noActiveSubscription")}
    </div>
  ) : (
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.planLabel")}
        </div>

        <div className="mt-2 text-lg font-bold">
          {activeSubscription.plans?.name}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("common.type")}
        </div>

        <div className="mt-2 text-lg font-bold">
          {getSubscriptionTypeLabel(activeSubscription.subscription_type, t)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("common.status")}
        </div>

        <div className="mt-2 text-lg font-bold text-emerald-600">
          {getStatusLabel(activeSubscription.status, t)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.startDateLabel")}
        </div>

        <div className="mt-2 font-semibold">
          {formatDate(activeSubscription.start_date)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.endDateLabel")}
        </div>

        <div className="mt-2 font-semibold">
          {formatDate(activeSubscription.end_date)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.remainingLabel")}
        </div>

        <div className="mt-2 text-lg font-bold text-indigo-600">
          {t("featureSettingsPage.remainingDaysValue", { days: getRemainingDays(activeSubscription.end_date) })}
        </div>
      </div>
    </div>
  )}
</div>


{activeSubscription && (
  <div className="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <h3 className="text-xl font-bold text-slate-950">
      {t("featureSettingsPage.remainingUsageTitle")}
    </h3>

    <div className="mt-5 grid gap-4 md:grid-cols-3">

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.messagesRemainingLabel")}
        </div>

        <div className="mt-2 text-2xl font-bold text-indigo-600">
          {(activeSubscription.plans?.messages_limit || 0)
            -
            (activeSubscription.messages_used || 0)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("featureSettingsPage.aiRepliesRemainingLabel")}
        </div>

        <div className="mt-2 text-2xl font-bold text-violet-600">
          {(activeSubscription.plans?.ai_replies_limit || 0)
            -
            (activeSubscription.ai_replies_used || 0)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          {t("common.daysRemaining")}
        </div>

        <div className="mt-2 text-2xl font-bold text-emerald-600">
          {getRemainingDays(
            activeSubscription.end_date
          )}
        </div>
      </div>

    </div>
  </div>
)}


{activeSubscription && (() => {

	const msgPercent = getUsagePercent(
	activeSubscription.messages_used || 0,
	activeSubscription.plans?.messages_limit || 0);

	const aiPercent = getUsagePercent(
	activeSubscription.ai_replies_used || 0,
	activeSubscription.plans?.ai_replies_limit || 0);
	
	const messagesLeft =
	  (activeSubscription.plans?.messages_limit || 0) -
	  (activeSubscription.messages_used || 0);

	const aiLeft =
	  (activeSubscription.plans?.ai_replies_limit || 0) -
	  (activeSubscription.ai_replies_used || 0);
	  
	const status = getUsageStatus(
	Math.max(msgPercent, aiPercent), t
);

  return (
    <div className="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">

      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold">
          {t("featureSettingsPage.usageStatsTitle")}
        </h3>

        <span className={`font-semibold ${status.color}`}>
          {status.label}
        </span>
      </div>

      <div className="mt-6 space-y-6">

		{messagesLeft <= 0 && (
		  <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
			{t("featureSettingsPage.messagesFullyUsed")}
		  </div>
		)}

		{messagesLeft > 0 && msgPercent >= 80 && (
		  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-700">
			{t("featureSettingsPage.messagesNear80")}
		  </div>
		)}

		{aiLeft <= 0 && (
		  <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
			{t("featureSettingsPage.aiFullyUsed")}
		  </div>
		)}

		{aiLeft > 0 && aiPercent >= 80 && (
		  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-700">
			{t("featureSettingsPage.aiNear80")}
		  </div>
		)}

        <div>
          <div className="mb-2 flex justify-between text-sm">
            <span>{t("common.messagesLabel")}</span>

            <span>
              {activeSubscription.messages_used || 0}
              /
              {activeSubscription.plans?.messages_limit || 0}
            </span>
          </div>

          <div className="h-3 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-indigo-600"
              style={{
                width: `${msgPercent}%`,
              }}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex justify-between text-sm">
            <span>{t("featureSettingsPage.aiRepliesLabel")}</span>

            <span>
              {activeSubscription.ai_replies_used || 0}
              /
              {activeSubscription.plans?.ai_replies_limit || 0}
            </span>
          </div>

          <div className="h-3 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-violet-600"
              style={{
                width: `${aiPercent}%`,
              }}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex justify-between text-sm">
            <span>{t("featureSettingsPage.autoRepliesUsageLabel")}</span>

            <span>
              {activeSubscription.auto_replies_used || 0}
            </span>
          </div>
        </div>

      </div>
    </div>
  );
})()}



 {/* Subscription History */}
<div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div className="mb-5 flex items-center justify-between">
    <div>
      <h3 className="text-xl font-bold text-slate-950">
        {t("featureSettingsPage.historyTitle")}
      </h3>

      <p className="mt-1 text-sm text-slate-500">
        {t("featureSettingsPage.historySubtitle")}
      </p>
    </div>


  {isAdmin && (
  <button
    type="button"
    onClick={openSubscriptionDrawer}
    className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
  >
    {t("featureSettingsPage.newSubscription")}
  </button>
)}


  </div>

  {subscriptions.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
      {t("featureSettingsPage.noSubscriptions")}
    </div>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="py-3 font-semibold text-slate-500">
              {t("featureSettingsPage.planLabel")}
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  {t("common.type")}
			</th>
            <th className="py-3 font-semibold text-slate-500">
              {t("common.status")}
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  {t("featureSettingsPage.colCurrent")}
			</th>
            <th className="py-3 font-semibold text-slate-500">
              {t("featureSettingsPage.startDateLabel")}
            </th>
            <th className="py-3 font-semibold text-slate-500">
              {t("featureSettingsPage.endDateLabel")}
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  {t("featureSettingsPage.colClosedDate")}
			</th>
			<th className="py-3 font-semibold text-slate-500">
			  {t("featureSettingsPage.colCreatedDate")}
			</th>
          </tr>
        </thead>

        <tbody>
          {subscriptions.map((sub) => (
            <tr
              key={sub.id}
              className="border-b border-slate-50"
            >
              <td className="py-4 font-semibold text-slate-900">
                {sub.plans?.name || "-"}
              </td>

				<td className="py-4">
				  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
					sub.subscription_type === "trial"
					  ? "bg-blue-50 text-blue-700"
					  : "bg-violet-50 text-violet-700"
				  }`}>
					{getSubscriptionTypeLabel(sub.subscription_type, t)}
				  </span>
				</td>

              <td className="py-4">
				<span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${getStatusClass(sub.status)}`}>
				  {getStatusLabel(sub.status, t)}
				</span>
              </td>

				<td className="py-4">
				  {(sub.status === "active") ? (
					<span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
					  {t("featureSettingsPage.colCurrent")}
					</span>
				  ) : (
					"-"
				  )}
				</td>



              <td className="py-4 text-slate-600">
                {formatDate(sub.start_date)}
              </td>

              <td className="py-4 text-slate-600">
                {formatDate(sub.end_date)}
              </td>
			  <td className="py-4 text-slate-600">
				  {formatDate(sub.closed_at)}
				</td>
			  <td className="py-4 text-slate-600">
				  {formatDate(sub.created_at)}
				</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )}
</div>
 
 {isAdmin && subscriptionDrawerOpen && (
  <div className="fixed inset-0 z-40 flex">
    <div
      className="flex-1 bg-slate-950/50"
      onClick={closeSubscriptionDrawer}
    />

    <div className="w-full max-w-md bg-white shadow-2xl">
      <div className="border-b p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold">
            {t("featureSettingsPage.newSubscriptionDrawerTitle")}
          </h3>

          <button
            type="button"
            onClick={closeSubscriptionDrawer}
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div className="space-y-5 p-5">

        <div>
          <label className="mb-2 block text-sm font-semibold">
            {t("featureSettingsPage.planLabel")}
          </label>

          <select
            value={subscriptionForm.plan_id}
            onChange={(e) =>
              setSubscriptionForm((prev) => ({
                ...prev,
                plan_id: e.target.value,
              }))
            }
            className="w-full rounded-2xl border px-4 py-3"
          >
            <option value="">
              {t("featureSettingsPage.choosePlan")}
            </option>

            {plansList.map((plan) => (
              <option
                key={plan.id}
                value={plan.id}
              >
                {plan.name}
              </option>
            ))}
          </select>
        </div>

<div>
  <label className="mb-2 block text-sm font-semibold">
    {t("featureSettingsPage.subscriptionTypeLabel")}
  </label>

  <select
    value={subscriptionForm.subscription_type}
    onChange={(e) =>
      setSubscriptionForm((prev) => ({
        ...prev,
        subscription_type: e.target.value,
      }))
    }
    className="w-full rounded-2xl border px-4 py-3"
  >
    <option value="paid">
      {t("common.paid")}
    </option>

    <option value="trial">
      {t("common.trial")}
    </option>
  </select>
</div>

        {subscriptionForm.subscription_type === "paid" && (
          <div>
            <label className="mb-2 block text-sm font-semibold">
              {t("featureSettingsPage.durationLabel")}
            </label>

            <select
              value={subscriptionForm.duration}
              onChange={(e) =>
                setSubscriptionForm((prev) => ({
                  ...prev,
                  duration: e.target.value,
                }))
              }
              className="w-full rounded-2xl border px-4 py-3"
            >
              <option value="1">{t("featureSettingsPage.oneMonth")}</option>
              <option value="3">{t("featureSettingsPage.threeMonths")}</option>
              <option value="6">{t("featureSettingsPage.sixMonths")}</option>
              <option value="12">{t("featureSettingsPage.twelveMonths")}</option>
            </select>
          </div>
        )}

        <button
		  type="button"
		  onClick={saveSubscription}
		  disabled={savingSubscription}
		  className="w-full rounded-2xl bg-indigo-600 py-3 font-semibold text-white disabled:opacity-50"
		>
		  {savingSubscription
				? t("common.saving")
				: t("featureSettingsPage.saveSubscription")}
		</button>

      </div>
    </div>
  </div>
)}

      {drawerOpen && activeFeature && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-slate-950/50 backdrop-blur-sm" onClick={closeFeatureDrawer} />
          <div className="h-full w-full max-w-xl overflow-y-auto border-r border-slate-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 p-5 backdrop-blur">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Feature Settings</p>
                  <h2 className="mt-1 text-2xl font-bold text-slate-950">{activeFeature.name}</h2>
                  {activeFeature.slug && <p className="mt-1 text-sm text-slate-500">{activeFeature.slug}</p>}
                </div>
                <button
                  type="button"
                  onClick={closeFeatureDrawer}
                  className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <form onSubmit={activeFeature.slug === "ai_auto_reply" ? handleSaveAiBehavior : handleSaveFeature} className="space-y-5 p-5">
              {activeFeature.slug === "ai_auto_reply" && (
                <AiBehaviorFormBody
                  t={t}
                  loading={aiBehaviorLoading}
                  readOnly={readOnly}
                  form={aiBehaviorForm}
                  onChange={updateAiBehaviorField}
                  newForbiddenRule={newForbiddenRule}
                  onNewForbiddenRuleChange={setNewForbiddenRule}
                  onAddForbiddenRule={addForbiddenRule}
                  onRemoveForbiddenRule={removeForbiddenRule}
                />
              )}

              {activeFeature.slug !== "ai_auto_reply" && isTelegramFeature && (
                <div className="rounded-3xl border border-blue-100 bg-blue-50 p-4">
                  <button
                    type="button"
                    onClick={() => setShowTelegramGuide((prev) => !prev)}
                    className="text-sm font-semibold text-blue-700 underline"
                  >
                    {t("featureSettingsPage.telegramGuideToggle")}
                  </button>

                  {showTelegramGuide && (
                    <div className="mt-3 space-y-2 text-sm text-blue-900">
                      <p>{t("featureSettingsPage.telegramStep1")}</p>
                      <p>{t("featureSettingsPage.telegramStep2")}</p>
                      <p>{t("featureSettingsPage.telegramStep3")}</p>
                      <p>{t("featureSettingsPage.telegramStep4")}</p>
                      <p>{t("featureSettingsPage.telegramStep5")}</p>
                    </div>
                  )}
                </div>
              )}

              {activeFeature.slug !== "ai_auto_reply" && (
                activeFeature.fields && typeof activeFeature.fields === "object" && !Array.isArray(activeFeature.fields) ? (
                  <div className="grid grid-cols-1 gap-4">
                    {Object.entries(activeFeature.fields).map(([fieldName, fieldType]) => {
                      const type = fieldType === "password" || fieldType === "number" || fieldType === "url" ? fieldType : "text";
                      return (
                        <div key={fieldName}>
                          <label className="mb-1.5 block text-sm font-semibold text-slate-700">{fieldName}</label>
                          <input
                            type={type}
                            value={featureValues[fieldName] || ""}
                            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                            disabled={readOnly}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">{t("featureSettingsPage.noFieldsDefined")}</div>
                )
              )}

              {activeFeature.slug !== "ai_auto_reply" && setupLinks.length > 0 && (
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <LinkIcon className="h-5 w-5 text-indigo-600" />
                    <h3 className="font-bold text-slate-900">{t("integrationsPage.setupLinksTitle")}</h3>
                  </div>

                  <div className="space-y-3">
                    {setupLinks.map((link) => (
                      <div key={link.label} className="rounded-2xl border border-slate-200 bg-white p-3">
                        <p className="mb-1 text-xs font-semibold text-slate-500">{link.label}</p>
                        <div className="flex gap-2">
                          <div className="min-w-0 flex-1 break-all rounded-xl bg-slate-50 px-3 py-2 text-xs text-blue-700">
                            {link.value}
                          </div>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(link.value)}
                            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            {copiedValue === link.value ? t("common.done") : <ClipboardDocumentIcon className="h-4 w-4" />}
                          </button>
                          <a
                            href={link.value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                          >
                            {t("common.open")}
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 border-t border-slate-100 pt-5">
                {!readOnly && (
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <CheckCircleIcon className="h-5 w-5" />
                    {saving ? t("settings.saving") : t("settings.save")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeFeatureDrawer}
                  className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  {t("common.close")}
                </button>
              </div>

              {readOnly && (
                <div className="flex items-start gap-2 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">
                  <ExclamationTriangleIcon className="h-4 w-4" />
                  {t("featureSettingsPage.readOnlyFooterNote")}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
