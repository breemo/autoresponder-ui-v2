import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { Card, CardHeader, EmptyState, PageHeader, ProgressBar, Skeleton, cx, ui } from "../../components/app/primitives.jsx";
import {
  findActiveSubscription,
  formatDate,
  getRemainingDays,
  getStatusClass,
  getStatusLabel,
  getSubscriptionTypeLabel,
  getUsageLevel,
  getUsagePercent,
  remaining,
} from "./planBilling/billingUi.js";

// Plan & Billing (/client/plan-billing) — the subscription sections that used
// to sit at the bottom of the AI Agent page, moved here unchanged in data and
// rules: same subscriptions query (with the plan join), same "active" pick,
// same remaining / percent / threshold calculations. Read-only for clients;
// no payments, invoices, plan changes or new billing APIs.

const LEVEL_STYLE = {
  max: { key: "featureSettingsPage.usageStatusMax", color: "text-rose-600" },
  near: { key: "featureSettingsPage.usageStatusNear", color: "text-amber-600" },
  good: { key: "featureSettingsPage.usageStatusGood", color: "text-emerald-600" },
};

function Field({ label, value, valueClass }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2.5">
      <dt className="truncate text-xs text-slate-500">{label}</dt>
      <dd className={cx("mt-0.5 truncate text-sm font-semibold", valueClass || "text-slate-900")}>{value}</dd>
    </div>
  );
}

export default function ClientPlanBilling() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const clientId = user?.client_id || null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subscriptions, setSubscriptions] = useState([]);
  const [active, setActive] = useState(null);

  useEffect(() => {
    if (clientId) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function load() {
    setLoading(true);
    setError("");
    const { data, error: subscriptionsError } = await supabase
      .from("subscriptions")
      .select(
        `
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
      `
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    if (subscriptionsError) {
      console.error(subscriptionsError);
      setError(t("planBilling.loadFailed"));
      setSubscriptions([]);
      setActive(null);
    } else {
      setSubscriptions(data || []);
      setActive(findActiveSubscription(data));
    }
    setLoading(false);
  }

  const messagesLimit = active?.plans?.messages_limit || 0;
  const aiLimit = active?.plans?.ai_replies_limit || 0;
  const msgPercent = active ? getUsagePercent(active.messages_used || 0, messagesLimit) : 0;
  const aiPercent = active ? getUsagePercent(active.ai_replies_used || 0, aiLimit) : 0;
  const messagesLeft = active ? remaining(messagesLimit, active.messages_used) : 0;
  const aiLeft = active ? remaining(aiLimit, active.ai_replies_used) : 0;
  const level = LEVEL_STYLE[getUsageLevel(Math.max(msgPercent, aiPercent))];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("planBilling.title")}
        description={t("planBilling.subtitle")}
        actions={
          <button type="button" onClick={load} disabled={loading} className={ui.btnSecondary}>
            <ArrowPathIcon className={cx("h-4 w-4", loading && "animate-spin")} />
            {t("common.refresh")}
          </button>
        }
      />

      {error && <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">{error}</div>}

      {/* Current Subscription */}
      <Card as="section" data-testid="current-subscription">
        <CardHeader title={t("featureSettingsPage.currentSubscriptionTitle")} subtitle={t("featureSettingsPage.currentSubscriptionSubtitle")} />
        {loading ? (
          <Skeleton className="h-28 w-full" />
        ) : !active ? (
          <EmptyState title={t("featureSettingsPage.noActiveSubscription")} />
        ) : (
          <dl className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Field label={t("featureSettingsPage.planLabel")} value={active.plans?.name || "-"} />
            <Field label={t("common.type")} value={getSubscriptionTypeLabel(active.subscription_type, t)} />
            <Field label={t("common.status")} value={getStatusLabel(active.status, t)} valueClass="text-emerald-600" />
            <Field label={t("featureSettingsPage.startDateLabel")} value={formatDate(active.start_date)} />
            <Field label={t("featureSettingsPage.endDateLabel")} value={formatDate(active.end_date)} />
            <Field label={t("featureSettingsPage.remainingLabel")} value={t("featureSettingsPage.remainingDaysValue", { days: getRemainingDays(active.end_date) })} valueClass="text-indigo-600" />
          </dl>
        )}
      </Card>

      {!loading && active && (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* Remaining Usage */}
          <Card as="section" data-testid="remaining-usage">
            <CardHeader title={t("featureSettingsPage.remainingUsageTitle")} />
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label={t("featureSettingsPage.messagesRemainingLabel")} value={messagesLeft} valueClass="text-lg text-indigo-600" />
              <Field label={t("featureSettingsPage.aiRepliesRemainingLabel")} value={aiLeft} valueClass="text-lg text-violet-600" />
              <Field label={t("common.daysRemaining")} value={getRemainingDays(active.end_date)} valueClass="text-lg text-emerald-600" />
            </dl>
          </Card>

          {/* Usage Statistics */}
          <Card as="section" data-testid="usage-stats">
            <CardHeader title={t("featureSettingsPage.usageStatsTitle")} action={<span className={cx("text-xs font-semibold", level.color)}>{t(level.key)}</span>} />
            <div className="space-y-3">
              {messagesLeft <= 0 && <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{t("featureSettingsPage.messagesFullyUsed")}</p>}
              {messagesLeft > 0 && msgPercent >= 80 && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{t("featureSettingsPage.messagesNear80")}</p>}
              {aiLeft <= 0 && <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{t("featureSettingsPage.aiFullyUsed")}</p>}
              {aiLeft > 0 && aiPercent >= 80 && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{t("featureSettingsPage.aiNear80")}</p>}

              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-slate-600">{t("common.messagesLabel")}</span>
                  <span className="tabular-nums text-slate-900">
                    {active.messages_used || 0} / {messagesLimit}
                  </span>
                </div>
                <ProgressBar percent={msgPercent} tone="bg-indigo-600" />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-slate-600">{t("featureSettingsPage.aiRepliesLabel")}</span>
                  <span className="tabular-nums text-slate-900">
                    {active.ai_replies_used || 0} / {aiLimit}
                  </span>
                </div>
                <ProgressBar percent={aiPercent} tone="bg-violet-600" />
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-600">{t("featureSettingsPage.autoRepliesUsageLabel")}</span>
                <span className="tabular-nums text-slate-900">{active.auto_replies_used || 0}</span>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Subscription History */}
      <Card as="section" padded={false} data-testid="subscription-history">
        <div className="p-4 pb-0">
          <CardHeader title={t("featureSettingsPage.historyTitle")} subtitle={t("featureSettingsPage.historySubtitle")} />
        </div>
        {loading ? (
          <div className="p-4 pt-0">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="p-4 pt-0">
            <EmptyState title={t("featureSettingsPage.noSubscriptions")} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                <tr>
                  {[
                    t("featureSettingsPage.planLabel"),
                    t("common.type"),
                    t("common.status"),
                    t("featureSettingsPage.colCurrent"),
                    t("featureSettingsPage.startDateLabel"),
                    t("featureSettingsPage.endDateLabel"),
                    t("featureSettingsPage.colClosedDate"),
                    t("featureSettingsPage.colCreatedDate"),
                  ].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-start font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subscriptions.map((sub) => (
                  <tr key={sub.id} data-sub-id={sub.id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{sub.plans?.name || "-"}</td>
                    <td className="px-4 py-2.5">
                      <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-semibold", sub.subscription_type === "trial" ? "bg-blue-50 text-blue-700" : "bg-violet-50 text-violet-700")}>
                        {getSubscriptionTypeLabel(sub.subscription_type, t)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", getStatusClass(sub.status))}>{getStatusLabel(sub.status, t)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {sub.status === "active" ? (
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">{t("featureSettingsPage.colCurrent")}</span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{formatDate(sub.start_date)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{formatDate(sub.end_date)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{formatDate(sub.closed_at)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{formatDate(sub.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
