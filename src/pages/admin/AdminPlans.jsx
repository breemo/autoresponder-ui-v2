import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Link } from "react-router-dom";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function AdminPlans() {
  const [plans, setPlans] = useState([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({ name: "", price: "", description: "", allow_self_edit: false, auto_replies_limit: "", integrations_limit: "", messages_limit: "" });
  const [editingId, setEditingId] = useState(null);

  useEffect(() => { fetchPlans(); }, []);
  const fetchPlans = async () => {
    setLoading(true); setMsg("");
    const { data, error } = await supabase.from("plans").select("id, name, price, description, allow_self_edit, auto_replies_limit, integrations_limit, messages_limit").order("price", { ascending: true });
    if (error) { console.error(error); setMsg("حدث خطأ في جلب الباقات"); } else setPlans(data || []);
    setLoading(false);
  };
  const resetForm = () => { setForm({ name: "", price: "", description: "", allow_self_edit: false, auto_replies_limit: "", integrations_limit: "", messages_limit: "" }); setEditingId(null); };
  const openCreate = () => { resetForm(); setDrawerOpen(true); };
  const handleChange = (e) => setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e?.preventDefault?.(); setMsg("");
    if (!form.name.trim()) return setMsg("يرجى إدخال اسم الخطة");
    const priceNumber = form.price === "" ? 0 : Number.isNaN(Number(form.price)) ? 0 : Number(form.price);
    const payload = { name: form.name.trim(), price: priceNumber, description: form.description || null, allow_self_edit: form.allow_self_edit, auto_replies_limit: form.auto_replies_limit === "" ? null : Number(form.auto_replies_limit), integrations_limit: form.integrations_limit === "" ? null : Number(form.integrations_limit), messages_limit: form.messages_limit === "" ? null : Number(form.messages_limit) };
    try {
      const { error } = editingId ? await supabase.from("plans").update(payload).eq("id", editingId) : await supabase.from("plans").insert([payload]);
      if (error) throw error;
      setMsg(editingId ? "تم تحديث الخطة بنجاح" : "تم إضافة الخطة بنجاح");
      setDrawerOpen(false); resetForm(); fetchPlans();
    } catch (err) { console.error(err); setMsg("حدث خطأ أثناء حفظ الخطة"); }
  };
  const startEdit = (plan) => { setForm({ name: plan.name || "", price: plan.price?.toString() || "", description: plan.description || "", allow_self_edit: !!plan.allow_self_edit, auto_replies_limit: plan.auto_replies_limit ?? "", integrations_limit: plan.integrations_limit ?? "", messages_limit: plan.messages_limit ?? "" }); setEditingId(plan.id); setDrawerOpen(true); setMsg(""); };
  const deletePlan = async (id) => { if (!window.confirm("هل أنت متأكد من حذف هذه الخطة؟")) return; const { error } = await supabase.from("plans").delete().eq("id", id); if (error) setMsg("فشل في حذف الخطة"); else { setMsg("تم حذف الخطة بنجاح"); fetchPlans(); } };

  const totalMessages = plans.reduce((sum, p) => sum + Number(p.messages_limit || 0), 0);

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">PLANS</p><h2 className="mt-1 text-2xl font-black text-slate-950">الباقات</h2><p className="mt-1 text-sm text-slate-500">إدارة خطط الاشتراك والحدود المرتبطة بكل خطة.</p></div>
        <button onClick={openCreate} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">+ إضافة باقة</button>
      </div>
      {msg && <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">{msg}</div>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4"><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">إجمالي الباقات</p><p className="mt-2 text-3xl font-black">{plans.length}</p></div><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">أقل سعر</p><p className="mt-2 text-3xl font-black text-indigo-600">${plans.length ? Math.min(...plans.map((p) => Number(p.price || 0))) : 0}</p></div><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">أعلى سعر</p><p className="mt-2 text-3xl font-black text-emerald-600">${plans.length ? Math.max(...plans.map((p) => Number(p.price || 0))) : 0}</p></div><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">إجمالي حدود الرسائل</p><p className="mt-2 text-3xl font-black text-slate-900">{totalMessages}</p></div></div>
      {loading ? <div className="rounded-3xl bg-white p-10 text-center text-slate-500">جارِ تحميل الباقات...</div> : <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">{plans.map((p) => <div key={p.id} className={`${cardClass} overflow-hidden`}><div className="border-b border-slate-100 p-6"><div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-black text-slate-950">{p.name}</h3><p className="mt-1 text-sm text-slate-500">{p.description || "بدون وصف"}</p></div><span className="rounded-2xl bg-indigo-50 px-4 py-2 text-xl font-black text-indigo-700">${p.price || 0}</span></div></div><div className="space-y-3 p-6 text-sm"><div className="flex justify-between"><span className="text-slate-500">حد الردود</span><b>{p.auto_replies_limit ?? "—"}</b></div><div className="flex justify-between"><span className="text-slate-500">حد التكاملات</span><b>{p.integrations_limit ?? "—"}</b></div><div className="flex justify-between"><span className="text-slate-500">حد الرسائل</span><b>{p.messages_limit ?? "—"}</b></div><div className="flex justify-between"><span className="text-slate-500">تعديل الميزات</span><span className={`rounded-full px-3 py-1 text-xs font-bold ${p.allow_self_edit ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{p.allow_self_edit ? "مسموح" : "ممنوع"}</span></div></div><div className="flex gap-2 border-t border-slate-100 p-4"><Link to={`/admin/plan-features/${p.id}`} className="flex-1 rounded-2xl bg-indigo-50 px-3 py-2 text-center text-xs font-bold text-indigo-700 hover:bg-indigo-100">ميزات الباقة</Link><button onClick={() => startEdit(p)} className="rounded-2xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">تعديل</button><button onClick={() => deletePlan(p.id)} className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-100">حذف</button></div></div>)}</div>}
      {drawerOpen && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={() => setDrawerOpen(false)}><form onSubmit={handleSubmit} className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">PLAN</p><h3 className="mt-1 text-2xl font-black text-slate-950">{editingId ? "تعديل باقة" : "إضافة باقة"}</h3></div><button type="button" onClick={() => setDrawerOpen(false)} className="rounded-xl border px-3 py-2 text-sm">إغلاق</button></div><div className="space-y-4"><div><label className="mb-1 block text-sm font-bold">اسم الخطة</label><input className={inputClass} name="name" value={form.name} onChange={handleChange} /></div><div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-sm font-bold">السعر</label><input type="number" step="0.01" className={inputClass} name="price" value={form.price} onChange={handleChange} /></div><div><label className="mb-1 block text-sm font-bold">حد الرسائل</label><input type="number" className={inputClass} name="messages_limit" value={form.messages_limit} onChange={handleChange} /></div></div><div><label className="mb-1 block text-sm font-bold">الوصف</label><textarea className={`${inputClass} min-h-[100px]`} name="description" value={form.description} onChange={handleChange} /></div><div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-sm font-bold">حد الردود</label><input type="number" className={inputClass} name="auto_replies_limit" value={form.auto_replies_limit} onChange={handleChange} /></div><div><label className="mb-1 block text-sm font-bold">حد التكاملات</label><input type="number" className={inputClass} name="integrations_limit" value={form.integrations_limit} onChange={handleChange} /></div></div><label className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4 text-sm font-bold"><input type="checkbox" checked={form.allow_self_edit} onChange={(e) => setForm((prev) => ({ ...prev, allow_self_edit: e.target.checked }))} /> السماح للعميل بتعديل إعدادات الميزات</label><button type="submit" className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200">{editingId ? "تحديث الخطة" : "إضافة خطة"}</button></div></form></div>}
    </div>
  );
}
