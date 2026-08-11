import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

function StatusBadge({ active }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{active ? "مفعّل" : "معطّل"}</span>;
}

export default function ClientAutoReplies() {
  const { user } = useAuth();
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
      setError("فشل في تحميل البيانات");
    } finally { setLoading(false); }
  }

  useEffect(() => { loadData(); }, [clientId]);

  function resetForm() { setForm({ id: null, trigger_text: "", reply_text: "", is_active: true }); }
  function openCreate() { resetForm(); setDrawerOpen(true); }
  function startEdit(r) { setForm({ id: r.id, trigger_text: r.trigger_text || "", reply_text: r.reply_text || "", is_active: r.is_active }); setDrawerOpen(true); }

  async function saveReply() {
    if (!form.trigger_text.trim() || !form.reply_text.trim()) return setError("نص التريغر ونص الرد مطلوبان");
    if (!form.id && autoLimit > 0 && replies.length >= autoLimit) return setError("لقد وصلت للحد الأقصى للردود التلقائية المتاحة في خطتك");
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
    } catch (err) { console.error(err); setError(err.message || "فشل في حفظ الرد التلقائي"); }
    finally { setSaving(false); }
  }

  async function toggleActive(r) {
    const { error } = await supabase.from("auto_replies").update({ is_active: !r.is_active }).eq("id", r.id).eq("client_id", clientId);
    if (error) return setError("فشل في تحديث الحالة");
    setReplies((prev) => prev.map((x) => x.id === r.id ? { ...x, is_active: !r.is_active } : x));
  }

  async function deleteReply(id) {
    if (!window.confirm("هل أنت متأكد من حذف هذا الرد التلقائي؟")) return;
    const { error } = await supabase.from("auto_replies").delete().eq("id", id).eq("client_id", clientId);
    if (error) return setError("فشل في حذف الرد");
    setReplies((prev) => prev.filter((r) => r.id !== id));
  }

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return !s ? replies : replies.filter((r) => `${r.trigger_text || ""} ${r.reply_text || ""}`.toLowerCase().includes(s));
  }, [replies, search]);

  const activeCount = replies.filter((r) => r.is_active).length;
  const remaining = autoLimit ? Math.max(autoLimit - replies.length, 0) : "∞";

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">AUTO REPLIES</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">الردود التلقائية</h2>
          <p className="mt-1 text-sm text-slate-500">عرّف كلمات trigger وردود جاهزة تظهر تلقائياً للزبائن.</p>
        </div>
        <button onClick={openCreate} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">+ إضافة رد</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">الردود المستخدمة</p><p className="mt-2 text-3xl font-black">{replies.length}<span className="text-base text-slate-400"> / {autoLimit || "∞"}</span></p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">مفعّلة</p><p className="mt-2 text-3xl font-black text-emerald-600">{activeCount}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">المتبقي بالخطة</p><p className="mt-2 text-3xl font-black text-indigo-600">{remaining}</p></div>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="flex items-center gap-3 border-b border-slate-100 p-4">
          <input className={`${inputClass} max-w-xl`} placeholder="ابحث في التريغر أو الرد..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={loadData} className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">↻ تحديث</button>
        </div>
        {loading ? <div className="p-10 text-center text-slate-500">جاري التحميل...</div> : filtered.length === 0 ? <div className="p-10 text-center text-slate-400">لا توجد ردود بعد.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-4 text-right">Trigger</th><th className="px-5 py-4 text-right">نص الرد</th><th className="px-5 py-4 text-right">الحالة</th><th className="px-5 py-4 text-right">إجراءات</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => <tr key={r.id} className="hover:bg-slate-50/70"><td className="px-5 py-4"><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">{r.trigger_text}</span></td><td className="max-w-xl px-5 py-4 text-slate-600"><p className="line-clamp-2">{r.reply_text}</p></td><td className="px-5 py-4"><button onClick={() => toggleActive(r)}><StatusBadge active={r.is_active} /></button></td><td className="px-5 py-4"><div className="flex gap-2"><button onClick={() => startEdit(r)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">تعديل</button><button onClick={() => deleteReply(r.id)} className="rounded-xl bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100">حذف</button></div></td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={() => setDrawerOpen(false)}><div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">AUTO REPLY</p><h3 className="mt-1 text-2xl font-black text-slate-950">{form.id ? "تعديل رد" : "إضافة رد جديد"}</h3></div><button onClick={() => setDrawerOpen(false)} className="rounded-xl border px-3 py-2 text-sm">إغلاق</button></div><div className="space-y-4"><div><label className="mb-1 block text-sm font-bold text-slate-700">نص التريغر</label><input className={inputClass} value={form.trigger_text} onChange={(e) => setForm((f) => ({ ...f, trigger_text: e.target.value }))} placeholder="مثال: السعر" /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">نص الرد</label><textarea className={`${inputClass} min-h-[170px]`} value={form.reply_text} onChange={(e) => setForm((f) => ({ ...f, reply_text: e.target.value }))} placeholder="اكتب الرد الذي سيرسله النظام..." /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">الحالة</label><select className={inputClass} value={form.is_active ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === "1" }))}><option value="1">مفعّل</option><option value="0">معطّل</option></select></div><button onClick={saveReply} disabled={saving} className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 disabled:opacity-60">{saving ? "جارٍ الحفظ..." : form.id ? "حفظ التعديلات" : "إضافة الرد"}</button></div></div></div>}
    </div>
  );
}
