import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

function StatusBadge({ active, t }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{active ? t("common.active") : t("common.inactive")}</span>;
}

export default function ClientQuickReplies() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [clientId, setClientId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState("");
  const [type, setType] = useState("custom");
  const [displayOrder, setDisplayOrder] = useState(0);
  const [hideAfterPayloads, setHideAfterPayloads] = useState([]);

  useEffect(() => { if (user?.client_id) setClientId(user.client_id); }, [user]);

  const fetchData = async () => {
    if (!clientId) return;
    setLoading(true); setError("");
    const { data, error } = await supabase.from("quick_reply_templates").select("*").eq("client_id", clientId).order("display_order", { ascending: true });
    if (error) { console.error(error); setError(t("quickRepliesPage.errorLoad")); } else setItems(data || []);
    setLoading(false);
  };
  useEffect(() => { fetchData(); }, [clientId]);

  const resetForm = () => { setEditingId(null); setTitle(""); setPayload(""); setType("custom"); setDisplayOrder(0); setHideAfterPayloads([]); };
  const openCreate = () => { resetForm(); setDrawerOpen(true); };
  const handleEdit = (item) => { setEditingId(item.id); setTitle(item.title || ""); setPayload(item.payload || ""); setType(item.action_type || "custom"); setDisplayOrder(item.display_order || 0); setHideAfterPayloads(item.hide_after_payloads || []); setDrawerOpen(true); };

  const handleSave = async () => {
    setError("");
    if (!clientId) return setError(t("quickRepliesPage.errorNoClient"));
    if (!title.trim()) return setError(t("quickRepliesPage.errorEmptyText"));
    const finalPayload = payload.trim() || title.trim().replace(/\s+/g, "_").toUpperCase();
    const record = { client_id: clientId, title: title.trim(), payload: finalPayload, action_type: type, display_order: Number(displayOrder) || items.length + 1, is_active: true, hide_after_payloads: hideAfterPayloads };
    const query = editingId ? supabase.from("quick_reply_templates").update(record).eq("id", editingId).eq("client_id", clientId) : supabase.from("quick_reply_templates").insert([record]);
    const { error } = await query;
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorSave")); }
    resetForm(); setDrawerOpen(false); fetchData();
  };

  const handleToggle = async (item) => {
    const { error } = await supabase.from("quick_reply_templates").update({ is_active: !item.is_active }).eq("id", item.id).eq("client_id", clientId);
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorStatusUpdate")); }
    fetchData();
  };

  const handleDelete = async (id) => {
    if (!confirm(t("quickRepliesPage.confirmDelete"))) return;
    const { error } = await supabase.from("quick_reply_templates").delete().eq("id", id).eq("client_id", clientId);
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorDelete")); }
    fetchData();
  };

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return !s ? items : items.filter((i) => `${i.title || ""} ${i.payload || ""} ${i.action_type || ""}`.toLowerCase().includes(s));
  }, [items, search]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">QUICK REPLIES</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">{t("navigation.quickReplies")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("quickRepliesPage.subtitle")}</p>
        </div>
        <button onClick={openCreate} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">{t("quickRepliesPage.addButton")}</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">{t("quickRepliesPage.statTotal")}</p><p className="mt-2 text-3xl font-black">{items.length}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">{t("quickRepliesPage.statActive")}</p><p className="mt-2 text-3xl font-black text-emerald-600">{items.filter((i) => i.is_active).length}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">{t("quickRepliesPage.statTypes")}</p><p className="mt-2 text-3xl font-black text-indigo-600">{new Set(items.map((i) => i.action_type)).size}</p></div>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="flex items-center gap-3 border-b border-slate-100 p-4">
          <input className={`${inputClass} max-w-xl`} placeholder={t("quickRepliesPage.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={fetchData} className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">↻ {t("common.refresh")}</button>
        </div>
        {loading ? <div className="p-10 text-center text-slate-500">{t("common.loading")}</div> : filtered.length === 0 ? <div className="p-10 text-center text-slate-400">{t("quickRepliesPage.empty")}</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-4 text-right">{t("quickRepliesPage.colText")}</th><th className="px-5 py-4 text-right">Payload</th><th className="px-5 py-4 text-right">{t("common.type")}</th><th className="px-5 py-4 text-right">{t("quickRepliesPage.colHideAfter")}</th><th className="px-5 py-4 text-right">{t("quickRepliesPage.colOrder")}</th><th className="px-5 py-4 text-right">{t("common.status")}</th><th className="px-5 py-4 text-right">{t("leads.colActions")}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((item) => <tr key={item.id} className="hover:bg-slate-50/70"><td className="px-5 py-4 font-bold text-slate-900">{item.title}</td><td className="px-5 py-4"><span className="rounded-full bg-indigo-50 px-3 py-1 font-mono text-xs font-bold text-indigo-700">{item.payload}</span></td><td className="px-5 py-4 text-slate-600">{item.action_type}</td><td className="max-w-[220px] px-5 py-4 font-mono text-xs text-slate-500">{(item.hide_after_payloads || []).join(", ") || "—"}</td><td className="px-5 py-4 text-slate-600">{item.display_order}</td><td className="px-5 py-4"><button onClick={() => handleToggle(item)}><StatusBadge active={item.is_active} t={t} /></button></td><td className="px-5 py-4"><div className="flex gap-2"><button onClick={() => handleEdit(item)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">{t("common.edit")}</button><button onClick={() => handleDelete(item.id)} className="rounded-xl bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100">{t("common.delete")}</button></div></td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={() => setDrawerOpen(false)}><div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">QUICK REPLY</p><h3 className="mt-1 text-2xl font-black text-slate-950">{editingId ? t("quickRepliesPage.drawerEditTitle") : t("quickRepliesPage.drawerAddTitle")}</h3></div><button onClick={() => setDrawerOpen(false)} className="rounded-xl border px-3 py-2 text-sm">{t("common.close")}</button></div><div className="space-y-4"><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("quickRepliesPage.fieldButtonText")}</label><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("quickRepliesPage.fieldButtonTextPlaceholder")} /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("quickRepliesPage.fieldPayloadOptional")}</label><input className={inputClass} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="BOOKING" /></div><div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("common.type")}</label><select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}><option value="custom">{t("quickRepliesPage.typeCustom")}</option><option value="order">{t("quickRepliesPage.typeOrder")}</option><option value="booking">{t("quickRepliesPage.typeBooking")}</option><option value="quote">{t("quickRepliesPage.typeQuote")}</option><option value="human_request">{t("quickRepliesPage.typeHumanRequest")}</option><option value="question">{t("quickRepliesPage.typeQuestion")}</option></select></div><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("quickRepliesPage.colOrder")}</label><input type="number" className={inputClass} value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} /></div></div><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("quickRepliesPage.fieldHideAfter")}</label><select multiple className={`${inputClass} min-h-[120px]`} value={hideAfterPayloads} onChange={(e) => setHideAfterPayloads(Array.from(e.target.selectedOptions, (option) => option.value))}>{items.map((item) => <option key={item.id} value={item.payload}>{item.title} ({item.payload})</option>)}</select></div><button onClick={handleSave} className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200">{editingId ? t("quickRepliesPage.saveEdit") : t("quickRepliesPage.addOption")}</button></div></div></div>}
    </div>
  );
}
