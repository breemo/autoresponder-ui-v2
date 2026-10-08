import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { PERMISSIONS, hasUserPermission } from "../../lib/permissions.js";
import Pagination from "../../components/Pagination.jsx";
import { AppChannelTile } from "../../components/app/Channel.jsx";
import { PageHeader, Skeleton, cx, ui } from "../../components/app/primitives.jsx";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  MagnifyingGlassIcon,
  PhoneIcon,
  UserGroupIcon,
  UserIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import {
  TIME_FILTERS,
  channelOptions,
  filterLeads,
  hasMultipleWhatsappAccounts,
  inboxConversationHref,
  isConversationUuid,
  leadChannelKey,
  leadChannelLabel,
  leadStats,
  leadsToCsv,
  normalizePhone,
  resolveLeadChannel,
  shortId,
} from "./leads/leadsUi.js";
import { fetchLeadConversations } from "./leads/leadConversations.js";

const PAGE_SIZE = 10;

function formatDay(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(lang === "en" ? "en-US" : "ar-EG", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function formatClock(value, lang) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(lang === "en" ? "en-US" : "ar-EG", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const KPI_TONES = {
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  sky: "bg-sky-50 text-sky-600 ring-sky-100",
  violet: "bg-violet-50 text-violet-600 ring-violet-100",
};

// KPI card — real calculated values only (no trend/percentage: there is no
// correct previous-period basis in the loaded data).
function KpiCard({ icon: Icon, label, value, tone, loading }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <span className={cx("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset", KPI_TONES[tone])}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-tight text-slate-500">{label}</p>
        {loading ? <Skeleton className="mt-1.5 h-6 w-12" /> : <p className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</p>}
      </div>
    </div>
  );
}

// Channel tile; unknown channels get a neutral person tile instead of initials.
function LeadTile({ channelKey, className = "h-9 w-9 rounded-xl", iconClassName = "h-[18px] w-[18px]" }) {
  if (channelKey === "unknown") {
    return (
      <span className={cx("inline-flex shrink-0 items-center justify-center bg-slate-100 text-slate-400", className)}>
        <UserIcon className={iconClassName} />
      </span>
    );
  }
  return <AppChannelTile channel={channelKey} className={cx("shrink-0", className)} iconClassName={iconClassName} />;
}

const selectClass =
  "h-9 rounded-lg border border-slate-200 bg-white pe-8 ps-3 text-[13px] text-slate-700 outline-none transition hover:bg-slate-50 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50";
const actionBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500";

export default function ClientLeads() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  // client_id is resolved once at login via client_users (see Login.jsx) —
  // every user of this client shares the same client_id.
  const clientId = user?.client_id || null;

  const [leads, setLeads] = useState([]);
  // conversation_id -> platform, enriched separately since `leads` itself
  // has no channel column — read-only display enrichment, no schema change.
  const [channelByConversation, setChannelByConversation] = useState({});
  // conversation_id -> V2 conversation identity (platform, channel_key,
  // WhatsApp account), from the authorized Inbox list endpoint. The
  // preferred channel source; also proves the conversation exists in this
  // client's Inbox (Open Conversation). Only for users with Inbox access.
  const [v2ById, setV2ById] = useState(() => new Map());
  const canOpenInbox = hasUserPermission(user, PERMISSIONS.INBOX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [time, setTime] = useState("all");
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState("");

  async function fetchLeads() {
    if (!clientId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError("");
      const v2Promise = canOpenInbox ? fetchLeadConversations(user?.id) : Promise.resolve({ status: "skipped", byId: new Map() });

      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      const rows = data || [];
      setLeads(rows);

      const conversationIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))];
      if (conversationIds.length > 0) {
        const { data: stateRows, error: stateError } = await supabase
          .from("conversation_state")
          .select("conversation_id, platform")
          .eq("client_id", clientId)
          .in("conversation_id", conversationIds);

        if (!stateError) {
          const map = {};
          (stateRows || []).forEach((s) => {
            if (s.conversation_id) map[s.conversation_id] = s.platform;
          });
          setChannelByConversation(map);
        }
      } else {
        setChannelByConversation({});
      }

      const v2 = await v2Promise;
      if (v2.status !== "ok") console.warn("leads: conversation identity lookup", v2.status);
      setV2ById(v2.byId);
    } catch (err) {
      console.error(err);
      setError(t("leads.errorFetch"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // One resolution per lead (exact conversation_id only — see
  // resolveLeadChannel for the precedence).
  const resolutionById = useMemo(() => {
    const m = new Map();
    for (const lead of leads) m.set(lead.id, resolveLeadChannel(lead, v2ById, channelByConversation));
    return m;
  }, [leads, v2ById, channelByConversation]);
  const showAccounts = useMemo(() => hasMultipleWhatsappAccounts([...resolutionById.values()]), [resolutionById]);
  const channelOf = (lead) => resolutionById.get(lead.id)?.platform || undefined;

  // Search + channel + time filter the full fetched dataset (not just the
  // current page) before pagination slices it.
  const filteredLeads = useMemo(
    () => filterLeads(leads, { search, channel, time, channelOf, t }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads, search, channel, time, resolutionById, t]
  );
  const availableChannels = useMemo(
    () => channelOptions(leads, channelOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads, resolutionById]
  );

  // Reset to page 1 whenever the filtered set changes shape.
  useEffect(() => {
    setPage(1);
  }, [search, channel, time]);

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedLeads = useMemo(
    () => filteredLeads.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredLeads, safePage]
  );

  // KPIs are always over ALL loaded leads (unchanged formulas).
  const stats = useMemo(() => leadStats(leads), [leads]);
  const filtersActive = search.trim() !== "" || channel !== "all" || time !== "all";

  async function copyValue(value, key = value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(""), 1400);
    } catch (err) {
      console.error(err);
    }
  }

  function resetFilters() {
    setSearch("");
    setChannel("all");
    setTime("all");
  }

  // Export: CSV of exactly the rows currently matched by the filters — the
  // same client-scoped records already shown on this page; nothing else is
  // requested from the server.
  function exportCsv() {
    const csv = leadsToCsv(filteredLeads, {
      channelOf,
      t,
      headers: [t("leads.colCustomer"), t("leads.colChannel"), t("leads.colPhone"), t("leads.colSender"), t("leads.colConversation"), t("leads.colCapturedAt")],
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function rowModel(lead) {
    const key = leadChannelKey(channelOf(lead));
    const phone = normalizePhone(lead.phone);
    const whatsappPhone = phone.startsWith("+") ? phone.slice(1) : phone;
    // wa.me only when the lead's actual channel is WhatsApp (unchanged rule).
    const whatsappLink = phone && channelOf(lead) === "whatsapp" ? `https://wa.me/${whatsappPhone}` : null;
    const res = resolutionById.get(lead.id);
    const account = showAccounts ? res?.account || null : null;
    // Open Conversation: only when the exact conversation was returned by
    // this user's authorized Inbox list (it exists for this client).
    const openHref = canOpenInbox && res?.inInbox && isConversationUuid(lead.conversation_id) ? inboxConversationHref(lead.conversation_id) : null;
    return { key, label: leadChannelLabel(key, t), account, whatsappLink, openHref };
  }

  const OpenConversation = ({ href }) =>
    !canOpenInbox ? null : href ? (
      <Link to={href} className={cx(actionBtn, "text-indigo-700")} data-action="open-conversation">
        <ChatBubbleOvalLeftEllipsisIcon className="h-4 w-4" />
        {t("leads.openConversation")}
      </Link>
    ) : (
      <span
        className={cx(actionBtn, "cursor-not-allowed opacity-50")}
        aria-disabled="true"
        title={t("leads.conversationUnavailable")}
        data-action="open-conversation-unavailable"
      >
        <ChatBubbleOvalLeftEllipsisIcon className="h-4 w-4" />
        {t("leads.openConversation")}
      </span>
    );

  const CopyPhoneButton = ({ lead }) => (
    <button type="button" onClick={() => copyValue(lead.phone)} disabled={!lead.phone} className={cx(actionBtn, "disabled:cursor-not-allowed disabled:opacity-50")}>
      {copied === lead.phone && lead.phone ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
      {copied === lead.phone && lead.phone ? t("common.copied") : t("common.copy")}
    </button>
  );

  const WhatsAppLink = ({ href }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" title={t("leads.openWhatsappTitle")} aria-label={t("leads.openWhatsappTitle")} className={cx(actionBtn, "px-1.5")}>
        <AppChannelTile channel="whatsapp" className="h-5 w-5 rounded-md" iconClassName="h-3 w-3" />
      </a>
    ) : null;

  const ConversationChip = ({ id }) =>
    id ? (
      <span className="inline-flex max-w-full items-center gap-1 rounded-lg bg-indigo-50/70 py-1 pe-1 ps-2 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-100" title={id}>
        <span className="truncate font-mono" dir="ltr">
          {shortId(id)}
        </span>
        <button
          type="button"
          onClick={() => copyValue(id, `conv:${id}`)}
          aria-label={t("leads.copyConversationId")}
          title={t("leads.copyConversationId")}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-indigo-500 transition hover:bg-indigo-100 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {copied === `conv:${id}` ? <CheckIcon className="h-3.5 w-3.5 text-emerald-600" /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" />}
        </button>
      </span>
    ) : (
      <span className="text-slate-400">—</span>
    );

  const PhonePill = ({ phone }) => (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50/70 px-2.5 py-1 text-[13px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-100">
      <PhoneIcon className="h-3.5 w-3.5 shrink-0" />
      <span dir="ltr">{phone || "—"}</span>
    </span>
  );

  const ChannelPill = ({ k, label }) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      <LeadTile channelKey={k} className="h-4 w-4 rounded" iconClassName="h-2.5 w-2.5" />
      {label}
    </span>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("navigation.leads")}
        description={t("leads.subtitle")}
        actions={
          <button onClick={fetchLeads} disabled={loading} className={ui.btnSecondary}>
            <ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh")}
          </button>
        }
      />

      {error && <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">{error}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={UserGroupIcon} tone="indigo" label={t("leads.statTotal")} value={stats.total} loading={loading} />
        <KpiCard icon={PhoneIcon} tone="emerald" label={t("leads.statUnique")} value={stats.unique} loading={loading} />
        <KpiCard icon={CalendarDaysIcon} tone="sky" label={t("leads.statToday")} value={stats.today} loading={loading} />
        <KpiCard icon={ChatBubbleLeftRightIcon} tone="violet" label={t("leads.statWeek")} value={stats.week} loading={loading} />
      </div>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900">{t("leads.listTitle")}</h2>
            <p className="text-xs text-slate-500" data-testid="leads-count">
              {t("leads.listCount", { shown: filteredLeads.length, total: leads.length })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-64 xl:w-80 xl:flex-none">
              <MagnifyingGlassIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                className="h-9 w-full rounded-lg border border-slate-200 bg-white pe-3 ps-9 text-[13px] outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50"
                placeholder={t("leads.searchPlaceholder")}
                aria-label={t("leads.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={cx(selectClass, "min-w-0 flex-1 basis-32 sm:flex-none sm:basis-auto")} aria-label={t("leads.colChannel")}>
              <option value="all">{t("leads.allChannels")}</option>
              {availableChannels.map((k) => (
                <option key={k} value={k}>
                  {leadChannelLabel(k, t)}
                </option>
              ))}
            </select>
            <select value={time} onChange={(e) => setTime(e.target.value)} className={cx(selectClass, "min-w-0 flex-1 basis-32 sm:flex-none sm:basis-auto")} aria-label={t("leads.timeLabel")}>
              {TIME_FILTERS.map((v) => (
                <option key={v} value={v}>
                  {t(`leads.time_${v}`)}
                </option>
              ))}
            </select>
            <button type="button" onClick={resetFilters} disabled={!filtersActive} className={cx(actionBtn, "h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50")}>
              {t("leads.reset")}
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={loading || filteredLeads.length === 0}
              title={t("leads.exportTitle")}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              {t("leads.export")}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="p-8 text-center">
            <UserPlusIcon className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">{t("leads.emptyTitle")}</p>
            <p className="mt-1 text-xs text-slate-400">{t("leads.emptySubtitle")}</p>
          </div>
        ) : (
          <>
            {/* xl+: table */}
            <div className="hidden overflow-x-auto xl:block">
              <table className="w-full min-w-[880px] text-sm">
                <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                  <tr>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("leads.colCustomer")}</th>
                    <th className="px-3 py-2.5 text-start font-semibold">{t("leads.colChannel")}</th>
                    <th className="px-3 py-2.5 text-start font-semibold">{t("leads.colPhone")}</th>
                    <th className="px-3 py-2.5 text-start font-semibold">{t("leads.colConversation")}</th>
                    <th className="px-3 py-2.5 text-start font-semibold">{t("leads.colCapturedAt")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("leads.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pagedLeads.map((lead) => {
                    const m = rowModel(lead);
                    return (
                      <tr key={lead.id} data-lead-id={lead.id} className="transition hover:bg-slate-50/70 focus-within:bg-slate-50/70">
                        <td className="px-4 py-2.5">
                          <div className="flex min-w-0 items-center gap-3">
                            <LeadTile channelKey={m.key} />
                            <div className="min-w-0">
                              <p className="max-w-[220px] truncate font-semibold text-slate-900" title={lead.sender_id ? `${t("leads.colSender")}: ${lead.sender_id}` : undefined}>
                                <bdi>{lead.name || t("common.noName")}</bdi>
                              </p>
                              <p className="truncate text-xs text-slate-400">{t("leads.capturedFrom", { channel: m.label })}
                                {m.account && <span className="text-teal-700" dir="ltr"> · {m.account}</span>}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <ChannelPill k={m.key} label={m.label} />
                        </td>
                        <td className="px-3 py-2.5">
                          <PhonePill phone={lead.phone} />
                        </td>
                        <td className="max-w-[200px] px-3 py-2.5">
                          <ConversationChip id={lead.conversation_id} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <p className="text-[13px] text-slate-700">{formatDay(lead.created_at, lang)}</p>
                          <p className="text-xs text-slate-400">{formatClock(lead.created_at, lang)}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <OpenConversation href={m.openHref} />
                            <CopyPhoneButton lead={lead} />
                            <WhatsAppLink href={m.whatsappLink} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* < xl: cards with the same information and actions (no hidden columns) */}
            <ul className="divide-y divide-slate-100 sm:grid sm:grid-cols-2 sm:gap-px sm:divide-y-0 sm:bg-slate-100 lg:grid-cols-3 xl:hidden">
              {pagedLeads.map((lead) => {
                const m = rowModel(lead);
                return (
                  <li key={lead.id} data-lead-id={lead.id} className="min-w-0 space-y-2 bg-white px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <LeadTile channelKey={m.key} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-slate-900">
                          <bdi>{lead.name || t("common.noName")}</bdi>
                        </p>
                        <p className="truncate text-xs text-slate-400">
                          {m.label}
                          {m.account && <span className="text-teal-700" dir="ltr"> · {m.account}</span>} · {formatDay(lead.created_at, lang)} {formatClock(lead.created_at, lang)}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <PhonePill phone={lead.phone} />
                      <ConversationChip id={lead.conversation_id} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <OpenConversation href={m.openHref} />
                            <CopyPhoneButton lead={lead} />
                      <WhatsAppLink href={m.whatsappLink} />
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 sm:flex-row">
              <p className="text-xs font-medium text-slate-500" data-testid="leads-page-summary">
                {t("leads.pageSummary", { page: safePage, total: totalPages, count: filteredLeads.length })}
              </p>
              <Pagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
