import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowPathIcon, BoltIcon, CheckCircleIcon, InboxStackIcon, MagnifyingGlassIcon, PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { Card, EmptyState, PageHeader, Skeleton, StatTile, cx, ui } from "../../components/app/primitives.jsx";
import { Drawer, Notice } from "../../components/app/Overlay.jsx";
import { ExpandableText, ToggleSwitch, stripPlus } from "./replies/repliesUi.jsx";

const inputClass = ui.input;

// Auto Replies. Data access, validation, plan-limit rule and payloads are
// unchanged (auto_replies: trigger_text / reply_text / is_active); only the
// presentation follows the Client Portal design system.
export default function ClientAutoReplies() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [clientId, setClientId] = useState(null);
  const [replies, setReplies] = useState([]);
  const [autoLimit, setAutoLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({ id: null, trigger_text: "", reply_text: "", is_active: true });

  // client_id is resolved once at login via client_users (see Login.jsx).
  useEffect(() => {
    if (user?.client_id) setClientId(user.client_id);
  }, [user]);

  async function loadData() {
    if (!clientId) return;
    try {
      setLoading(true);
      setError("");
      const { data: client } = await supabase.from("clients").select("plan_id").eq("id", clientId).single();
      if (client?.plan_id) {
        const { data: plan } = await supabase.from("plans").select("auto_replies_limit").eq("id", client.plan_id).single();
        setAutoLimit(plan?.auto_replies_limit || 0);
      }
      const { data, error } = await supabase.from("auto_replies").select("id, trigger_text, reply_text, is_active, created_at").eq("client_id", clientId).order("created_at", { ascending: false });
      if (error) throw error;
      setReplies(data || []);
    } catch (err) {
      console.error(err);
      setError(t("autoRepliesPage.errorLoad"));
    } finally { setLoading(false); }
  }

  useEffect(() => { loadData(); }, [clientId]);

  function resetForm() { setForm({ id: null, trigger_text: "", reply_text: "", is_active: true }); }
  function openCreate() { resetForm(); setDrawerOpen(true); }
  function startEdit(r) { setForm({ id: r.id, trigger_text: r.trigger_text || "", reply_text: r.reply_text || "", is_active: r.is_active }); setDrawerOpen(true); }

  async function saveReply() {
    if (!form.trigger_text.trim() || !form.reply_text.trim()) return setError(t("autoRepliesPage.errorRequired"));
    if (!form.id && autoLimit > 0 && replies.length >= autoLimit) return setError(t("autoRepliesPage.errorLimitReached"));
    try {
      setSaving(true); setError("");
      if (form.id) {
        const { error } = await supabase.from("auto_replies").update({ trigger_text: form.trigger_text.trim(), reply_text: form.reply_text.trim(), is_active: form.is_active }).eq("id", form.id).eq("client_id", clientId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("auto_replies").insert([{ client_id: clientId, trigger_text: form.trigger_text.trim(), reply_text: form.reply_text.trim(), is_active: form.is_active }]);
        if (error) throw error;
      }
      setDrawerOpen(false); resetForm(); loadData();
    } catch (err) { console.error(err); setError(t("autoRepliesPage.errorSave")); }
    finally { setSaving(false); }
  }

  async function toggleActive(r) {
    const { error } = await supabase.from("auto_replies").update({ is_active: !r.is_active }).eq("id", r.id).eq("client_id", clientId);
    if (error) return setError(t("autoRepliesPage.errorStatusUpdate"));
    setReplies((prev) => prev.map((x) => x.id === r.id ? { ...x, is_active: !r.is_active } : x));
  }

  async function deleteReply(id) {
    if (!window.confirm(t("autoRepliesPage.confirmDelete"))) return;
    const { error } = await supabase.from("auto_replies").delete().eq("id", id).eq("client_id", clientId);
    if (error) return setError(t("autoRepliesPage.errorDelete"));
    setReplies((prev) => prev.filter((r) => r.id !== id));
  }

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return !s ? replies : replies.filter((r) => `${r.trigger_text || ""} ${r.reply_text || ""}`.toLowerCase().includes(s));
  }, [replies, search]);

  const activeCount = replies.filter((r) => r.is_active).length;
  const remaining = autoLimit ? Math.max(autoLimit - replies.length, 0) : "∞";

  const actions = (r) => (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => startEdit(r)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <PencilSquareIcon className="h-4 w-4" />
        {t("common.edit")}
      </button>
      <button type="button" onClick={() => deleteReply(r.id)} aria-label={`${t("common.delete")}: ${r.trigger_text}`} title={t("common.delete")} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("navigation.autoReplies")}
        description={t("autoRepliesPage.subtitle")}
        actions={
          <button type="button" onClick={openCreate} className={ui.btnPrimary}>
            <PlusIcon className="h-4 w-4" />
            {stripPlus(t("autoRepliesPage.addButton"))}
          </button>
        }
      />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label={t("autoRepliesPage.statUsed")} value={<>{replies.length}<span className="text-sm font-medium text-slate-400"> / {autoLimit || "∞"}</span></>} icon={InboxStackIcon} tone="indigo" loading={loading} />
        <StatTile label={t("autoRepliesPage.statActiveLabel")} value={activeCount} icon={CheckCircleIcon} tone="emerald" loading={loading} />
        <StatTile label={t("autoRepliesPage.statRemaining")} value={remaining} icon={BoltIcon} tone="violet" loading={loading} />
      </div>

      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 sm:p-4">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <MagnifyingGlassIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input type="search" className={cx(inputClass, "ps-9")} placeholder={t("autoRepliesPage.searchPlaceholder")} aria-label={t("autoRepliesPage.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button type="button" onClick={loadData} disabled={loading} className={ui.btnSecondary}>
            <ArrowPathIcon className={cx("h-4 w-4", loading && "animate-spin")} />
            {t("common.refresh")}
          </button>
        </div>

        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4"><EmptyState icon={BoltIcon} title={t("autoRepliesPage.empty")} /></div>
        ) : (
          <>
            {/* md+: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                  <tr>
                    <th className="w-[22%] px-4 py-2.5 text-start font-semibold">{t("autoRepliesPage.colTrigger")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("autoRepliesPage.colReply")}</th>
                    <th className="w-36 px-4 py-2.5 text-start font-semibold">{t("common.status")}</th>
                    <th className="w-40 px-4 py-2.5 text-start font-semibold">{t("leads.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((r) => (
                    <tr key={r.id} data-reply-id={r.id} className="align-top transition hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <span dir="auto" className="inline-block max-w-full break-words rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-100">
                          {r.trigger_text}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <ExpandableText text={r.reply_text} t={t} />
                      </td>
                      <td className="px-4 py-3">
                        <ToggleSwitch checked={r.is_active} onChange={() => toggleActive(r)} label={r.is_active ? t("common.active") : t("common.inactive")} />
                      </td>
                      <td className="px-4 py-3">{actions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* < md: cards */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {filtered.map((r) => (
                <li key={r.id} data-reply-id={r.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span dir="auto" className="min-w-0 break-words rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-100">
                      {r.trigger_text}
                    </span>
                    <ToggleSwitch checked={r.is_active} onChange={() => toggleActive(r)} label={r.is_active ? t("common.active") : t("common.inactive")} />
                  </div>
                  <div className="text-sm text-slate-700">
                    <ExpandableText text={r.reply_text} t={t} />
                  </div>
                  {actions(r)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={form.id ? t("autoRepliesPage.drawerEditTitle") : t("autoRepliesPage.drawerAddTitle")}
        closeLabel={t("common.close")}
        footer={
          <>
            <button type="button" onClick={() => setDrawerOpen(false)} className={ui.btnSecondary}>{t("common.cancel")}</button>
            <button type="button" onClick={saveReply} disabled={saving} className={ui.btnPrimary}>
              {saving ? t("common.saving") : form.id ? t("autoRepliesPage.saveEdits") : t("autoRepliesPage.addReply")}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {error && drawerOpen && <Notice tone="error">{error}</Notice>}
          <div>
            <label htmlFor="ar-trigger" className={ui.label}>{t("autoRepliesPage.colTrigger")}</label>
            <input id="ar-trigger" dir="auto" className={inputClass} value={form.trigger_text} onChange={(e) => setForm((f) => ({ ...f, trigger_text: e.target.value }))} placeholder={t("autoRepliesPage.fieldKeywordPlaceholder")} />
          </div>
          <div>
            <label htmlFor="ar-reply" className={ui.label}>{t("autoRepliesPage.fieldReplyText")}</label>
            <textarea id="ar-reply" dir="auto" className={cx(inputClass, "min-h-[180px] resize-y leading-6")} value={form.reply_text} onChange={(e) => setForm((f) => ({ ...f, reply_text: e.target.value }))} placeholder={t("autoRepliesPage.fieldReplyPlaceholder")} />
          </div>
          <div>
            <label htmlFor="ar-status" className={ui.label}>{t("common.status")}</label>
            <select id="ar-status" className={inputClass} value={form.is_active ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === "1" }))}>
              <option value="1">{t("common.active")}</option>
              <option value="0">{t("common.inactive")}</option>
            </select>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
