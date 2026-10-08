import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CpuChipIcon, PencilSquareIcon, ShareIcon, SparklesIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { PERMISSIONS, hasUserPermission } from "../../lib/permissions.js";
import { collapseWebsiteChatRows, isWebsiteChatSlug } from "../../lib/websiteChatEmbed.js";
import { AppChannelTile, channelKeyFrom } from "../../components/app/Channel.jsx";
import { Card, EmptyState, Skeleton, StatusPill, cx, ui } from "../../components/app/primitives.jsx";
import KnowledgeBaseSection from "./KnowledgeBaseSection.jsx";
import AiSettingsSection from "./aiAgent/AiSettingsSection.jsx";
import useAiBehavior from "./aiAgent/useAiBehavior.js";
import { channelIntegrationStatus, sortChannelFeatures } from "./aiAgent/aiAgentUi.js";

// Client AI Agent page (/client/feature-settings). Client-only presentation;
// the Admin Portal keeps using AdminClientSettings.jsx unchanged.
//   - AI Behavior summary + in-page AI Settings (client_ai_behavior via
//     /api/client-router?resource=ai-behavior — same requests as the former
//     drawer, see ./aiAgent/useAiBehavior.js)
//   - Channel Integration Status (existing /api/client-integrations "list";
//     only for members with the INTEGRATIONS permission the API requires)
//   - Knowledge Base (existing KnowledgeBaseSection, "agent" presentation)
// Subscription / usage / history moved to Plan & Billing (/client/plan-billing).

const AI_FEATURE_SLUG = "ai_auto_reply";

function SectionHeader({ icon: Icon, title, subtitle, action, id }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-slate-900">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export default function ClientFeatureSettings() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const clientId = user?.role === "client" ? user?.client_id || null : null;
  const canManageIntegrations = hasUserPermission(user, PERMISSIONS.INTEGRATIONS);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [plan, setPlan] = useState(null);
  const [features, setFeatures] = useState([]);
  const [integrations, setIntegrations] = useState(null); // null = not loaded / not permitted
  const [integrationsError, setIntegrationsError] = useState(false);

  const ai = useAiBehavior({ clientId, actorUserId: user?.id, t });
  const firstFieldRef = useRef(null);

  const aiFeature = useMemo(() => features.find((f) => f.slug === AI_FEATURE_SLUG) || null, [features]);
  const channelFeatures = useMemo(() => sortChannelFeatures(features.filter((f) => f.slug !== AI_FEATURE_SLUG)), [features]);
  // Same rule as before: clients may edit only when the plan allows it.
  const readOnly = plan?.allow_self_edit !== true;

  useEffect(() => {
    if (!clientId) return;
    loadPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function loadPage() {
    setLoading(true);
    setLoadError("");
    try {
      const { data: clientData, error: clientError } = await supabase.from("clients").select("id, business_name, email, plan_id").eq("id", clientId).single();
      if (clientError || !clientData) throw clientError || new Error("client");

      let planData = null;
      let featureRows = [];
      if (clientData.plan_id) {
        const { data } = await supabase.from("plans").select("id, name, allow_self_edit").eq("id", clientData.plan_id).maybeSingle();
        planData = data || null;
        const { data: pfData, error: pfError } = await supabase.from("plan_features").select("feature_id").eq("plan_id", clientData.plan_id);
        if (pfError) throw pfError;
        const featureIds = (pfData || []).map((x) => x.feature_id).filter(Boolean);
        if (featureIds.length) {
          const { data: featuresData, error: featuresError } = await supabase.from("features").select("id, name, slug, description, fields").in("id", featureIds);
          if (featuresError) throw featuresError;
          featureRows = featuresData || [];
        }
      }
      setPlan(planData);
      setFeatures(featureRows);

      if (featureRows.some((f) => f.slug === AI_FEATURE_SLUG)) ai.load();
      if (canManageIntegrations) loadIntegrations(featureRows);
    } catch (err) {
      console.error(err);
      setLoadError(t("featureSettingsPage.errUnexpectedFetch"));
    }
    setLoading(false);
  }

  // Read-only: the same "list" action the Integrations page uses.
  async function loadIntegrations(featureRows) {
    setIntegrationsError(false);
    try {
      const response = await fetch("/api/client-integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", actor_user_id: user?.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || "list failed");
      const websiteChatFeature = featureRows.find((f) => isWebsiteChatSlug(f.slug));
      setIntegrations(collapseWebsiteChatRows(data.integrations || [], websiteChatFeature?.id));
    } catch (err) {
      console.error(err);
      setIntegrations(null);
      setIntegrationsError(true);
    }
  }

  function focusSettings() {
    document.getElementById("ai-settings")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => firstFieldRef.current?.focus({ preventScroll: true }), 250);
  }

  if (!user || user.role !== "client") {
    return <p className="text-sm text-rose-600">{t("featureSettingsPage.unauthorized")}</p>;
  }
  if (!clientId) {
    return <p className="text-sm text-rose-600">{t("featureSettingsPage.noClientLinked")}</p>;
  }

  const languageLabel =
    ai.form.default_language === "ar"
      ? t("featureSettingsPage.aiBehaviorLanguageArabic")
      : ai.form.default_language === "en"
        ? t("featureSettingsPage.aiBehaviorLanguageEnglish")
        : t("aiAgent.notSet");
  const instructionsSet = ["special_instructions", "booking_instructions", "escalation_instructions"].filter((k) => ai.form[k].trim()).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-indigo-600">
            <SparklesIcon className="h-8 w-8" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 rtl:tracking-normal">{t("aiAgent.title")}</h1>
            <p className="mt-0.5 text-sm text-slate-500">{t("aiAgent.subtitle")}</p>
          </div>
        </div>
        {canManageIntegrations && (
          <Link to="/client/integrations" className={ui.btnSecondary}>
            <Squares2X2Icon className="h-4 w-4" />
            {t("aiAgent.openIntegrations")}
          </Link>
        )}
      </div>

      {loadError && <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">{loadError}</div>}

      {/* AI Behavior summary + Channel status */}
      <div className={cx("grid gap-4", canManageIntegrations && "xl:grid-cols-2")}>
        <Card as="section" aria-labelledby="ai-behavior-title">
          <SectionHeader
            id="ai-behavior-title"
            icon={CpuChipIcon}
            title={t("featureSettingsPage.aiBehaviorCardTitle")}
            subtitle={t("aiAgent.behaviorSubtitle")}
            action={
              aiFeature && (
                <button type="button" onClick={focusSettings} className={ui.btnPrimary}>
                  <PencilSquareIcon className="h-4 w-4" />
                  {readOnly ? t("aiAgent.viewSettings") : t("common.edit")}
                </button>
              )
            }
          />
          {loading || ai.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : !aiFeature ? (
            <EmptyState title={t("aiAgent.notInPlan")} className="py-5" />
          ) : (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="ai-summary">
              {[
                [t("featureSettingsPage.aiBehaviorLanguage"), languageLabel],
                [t("featureSettingsPage.aiBehaviorReplyTone"), ai.form.reply_tone || t("aiAgent.notSet")],
                [t("featureSettingsPage.aiBehaviorForbiddenRules"), String(ai.form.forbidden_rules.length)],
                [t("featureSettingsPage.aiBehaviorInstructionsGroupTitle"), t("aiAgent.instructionsSet", { count: instructionsSet, total: 3 })],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
                  <dt className="truncate text-[11px] text-slate-500">{k}</dt>
                  <dd className="mt-0.5 truncate text-[13px] font-semibold text-slate-900" dir="auto">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        {canManageIntegrations && (
          <Card as="section" aria-labelledby="ai-channels-title">
            <SectionHeader id="ai-channels-title" icon={ShareIcon} title={t("aiAgent.channelsTitle")} subtitle={t("aiAgent.channelsSubtitle")} />
            {loading || (integrations === null && !integrationsError) ? (
              <Skeleton className="h-24 w-full" />
            ) : integrationsError ? (
              <EmptyState title={t("aiAgent.channelsLoadFailed")} className="py-5" />
            ) : channelFeatures.length === 0 ? (
              <EmptyState title={t("aiAgent.noChannels")} className="py-5" />
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-5" data-testid="channel-status">
                {channelFeatures.map((feature) => {
                  const status = channelIntegrationStatus(feature, integrations);
                  return (
                    <li key={feature.id} className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl border border-slate-200/80 px-2 py-3 text-center" data-status={status}>
                      <AppChannelTile channel={channelKeyFrom(feature.slug) || feature.slug} className="h-9 w-9 rounded-xl" iconClassName="h-5 w-5" />
                      <span className="w-full truncate text-[13px] font-medium text-slate-800">{feature.name || feature.slug}</span>
                      <StatusPill tone={status === "active" ? "emerald" : status === "paused" ? "amber" : "slate"}>
                        {status === "active" ? t("common.active") : status === "paused" ? t("common.paused") : t("aiAgent.notSetUp")}
                      </StatusPill>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
      </div>

      {/* Knowledge Base */}
      <KnowledgeBaseSection clientId={clientId} actorUserId={user?.id} readOnly={readOnly} variant="agent" />

      {/* AI Settings */}
      {aiFeature && (
        <AiSettingsSection
          ref={firstFieldRef}
          t={t}
          loading={loading || ai.loading}
          readOnly={readOnly}
          saving={ai.saving}
          form={ai.form}
          onChange={ai.updateField}
          newForbiddenRule={ai.newForbiddenRule}
          onNewForbiddenRuleChange={ai.setNewForbiddenRule}
          onAddForbiddenRule={ai.addForbiddenRule}
          onRemoveForbiddenRule={ai.removeForbiddenRule}
          onSave={() => ai.save(readOnly)}
          message={ai.message}
        />
      )}
    </div>
  );
}
