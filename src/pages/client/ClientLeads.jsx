import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import ChannelIcon from "../../lib/channelIcons.jsx";
import Pagination from "../../components/Pagination.jsx";
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  MagnifyingGlassIcon,
  PhoneIcon,
  UserGroupIcon,
  UserPlusIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";

const PAGE_SIZE = 10;

function formatDate(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(lang === "en" ? "en-US" : "ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function isToday(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function isLastSevenDays(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue).getTime();
  return Date.now() - d <= 7 * 24 * 60 * 60 * 1000;
}

export default function ClientLeads() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // client_id is resolved once at login via client_users (see Login.jsx) —
  // every user of this client shares the same client_id.
  const clientId = user?.client_id || null;

  const [leads, setLeads] = useState([]);
  // conversation_id -> platform, enriched separately since `leads` itself
  // has no channel column — read-only display enrichment, no schema change.
  const [channelByConversation, setChannelByConversation] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
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

  // Search filters the full fetched dataset (not just the current page)
  // before pagination slices it, so results aren't limited to whatever 20
  // rows happen to be showing.
  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;

    return leads.filter((lead) => {
      return `${lead.name || ""} ${lead.phone || ""} ${lead.sender_id || ""} ${lead.conversation_id || ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [leads, search]);

  // Reset to page 1 whenever the filtered set changes shape (new search).
  useEffect(() => {
    setPage(1);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedLeads = useMemo(
    () => filteredLeads.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredLeads, safePage]
  );

  const stats = useMemo(() => {
    const uniquePhones = new Set(leads.map((lead) => normalizePhone(lead.phone)).filter(Boolean));
    return {
      total: leads.length,
      unique: uniquePhones.size,
      today: leads.filter((lead) => isToday(lead.created_at)).length,
      week: leads.filter((lead) => isLastSevenDays(lead.created_at)).length,
    };
  }, [leads]);

  async function copyValue(value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(""), 1400);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">
            <UserPlusIcon className="h-4 w-4" />
            {t("navigation.leads")}
          </div>
          <h1 className="text-2xl font-bold text-slate-950">{t("navigation.leads")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("leads.subtitle")}
          </p>
        </div>

        <button
          onClick={fetchLeads}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">{t("leads.statTotal")}</p>
              <p className="mt-3 text-3xl font-bold text-slate-950">{stats.total}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
              <UserGroupIcon className="h-6 w-6" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">{t("leads.statUnique")}</p>
              <p className="mt-3 text-3xl font-bold text-emerald-600">{stats.unique}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
              <PhoneIcon className="h-6 w-6" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">{t("leads.statToday")}</p>
              <p className="mt-3 text-3xl font-bold text-blue-600">{stats.today}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 ring-1 ring-blue-100">
              <CalendarDaysIcon className="h-6 w-6" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">{t("leads.statWeek")}</p>
              <p className="mt-3 text-3xl font-bold text-violet-600">{stats.week}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-600 ring-1 ring-violet-100">
              <ChatBubbleLeftRightIcon className="h-6 w-6" />
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-950">{t("leads.listTitle")}</h2>
            <p className="text-sm text-slate-500">
              {t("leads.listCount", { shown: filteredLeads.length, total: leads.length })}
            </p>
          </div>

          <div className="relative w-full lg:w-96">
            <MagnifyingGlassIcon className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pr-11 pl-4 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50"
              placeholder={t("leads.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">{t("common.loading")}</div>
        ) : filteredLeads.length === 0 ? (
          <div className="p-10 text-center">
            <UserPlusIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
            <p className="font-semibold text-slate-700">{t("leads.emptyTitle")}</p>
            <p className="mt-1 text-sm text-slate-400">{t("leads.emptySubtitle")}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-right text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-4 font-bold">{t("leads.colClient")}</th>
                    <th className="px-5 py-4 font-bold">{t("leads.colChannel")}</th>
                    <th className="px-5 py-4 font-bold">{t("leads.colPhone")}</th>
                    <th className="px-5 py-4 font-bold">{t("leads.colConversation")}</th>
                    <th className="px-5 py-4 font-bold">{t("leads.colCapturedAt")}</th>
                    <th className="px-5 py-4 font-bold">{t("leads.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pagedLeads.map((lead) => {
                    const phone = normalizePhone(lead.phone);
                    const whatsappPhone = phone.startsWith("+") ? phone.slice(1) : phone;
                    const channel = channelByConversation[lead.conversation_id];
                    // wa.me only makes sense when the lead's actual channel is
                    // WhatsApp — previously this showed a hardcoded "WhatsApp"
                    // action for every lead with a phone number regardless of
                    // their real channel.
                    const whatsappLink = phone && channel === "whatsapp" ? `https://wa.me/${whatsappPhone}` : null;

                    return (
                      <tr key={lead.id} className="transition hover:bg-slate-50/70">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <ChannelIcon channel={channel} size="h-11 w-11" />
                            <div>
                              <p className="font-bold text-slate-950">{lead.name || t("common.noName")}</p>
                              <p className="text-xs text-slate-400">Sender: {lead.sender_id || "—"}</p>
                            </div>
                          </div>
                        </td>

                        <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                          {channel || "—"}
                        </td>

                        <td className="px-5 py-4">
                          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-bold text-emerald-700 ring-1 ring-emerald-100">
                            <PhoneIcon className="h-4 w-4" />
                            {lead.phone || "—"}
                          </div>
                        </td>

                        <td className="px-5 py-4">
                          {lead.conversation_id ? (
                            <span className="inline-flex max-w-[220px] truncate rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">
                              {lead.conversation_id}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        <td className="px-5 py-4 text-slate-600">{formatDate(lead.created_at, i18n.language)}</td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => copyValue(lead.phone)}
                              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
                            >
                              <ClipboardDocumentIcon className="h-4 w-4" />
                              {copied === lead.phone ? t("common.copied") : t("common.copy")}
                            </button>

                            {whatsappLink && (
                              <a
                                href={whatsappLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={t("leads.openWhatsappTitle")}
                                className="inline-flex items-center justify-center rounded-xl transition hover:opacity-80"
                              >
                                <ChannelIcon channel="whatsapp" size="h-9 w-9" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 sm:flex-row">
              <p className="text-xs font-semibold text-slate-500">
                {t("leads.pageSummary", { page: safePage, total: totalPages, count: filteredLeads.length })}
              </p>
              <Pagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
