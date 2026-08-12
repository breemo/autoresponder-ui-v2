import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

const iconBySlug = { telegram: "✈️", facebook: "f", instagram: "📷", whatsapp: "☘️", ai: "✨", email: "✉️", website: "🌐" };

export default function AdminFeatures() {
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", slug: "", description: "", fields: [] });

  useEffect(() => { fetchFeatures(); }, []);
  const fetchFeatures = async () => { setLoading(true); const { data, error } = await supabase.from("features").select("*").order("created_at", { ascending: true }); if (error) console.error(error); else setFeatures(data || []); setLoading(false); };
  const resetForm = () => { setForm({ name: "", slug: "", description: "", fields: [] }); setEditingId(null); setMsg(""); };
  const openCreate = () => { resetForm(); setDrawerOpen(true); };
  const handleFieldChange = (index, key, value) => setForm((prev) => { const fields = [...prev.fields]; fields[index][key] = value; return { ...prev, fields }; });
  const addField = () => setForm((prev) => ({ ...prev, fields: [...prev.fields, { name: "", type: "text" }] }));
  const removeField = (index) => setForm((prev) => ({ ...prev, fields: prev.fields.filter((_, i) => i !== index) }));
  const startEdit = (f) => { let parsedFields = []; if (f.fields && typeof f.fields === "object" && !Array.isArray(f.fields)) parsedFields = Object.entries(f.fields).map(([name, type]) => ({ name, type })); setEditingId(f.id); setForm({ name: f.name || "", slug: f.slug || "", description: f.description || "", fields: parsedFields }); setDrawerOpen(true); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setMsg("");
    if (!form.name || !form.slug) return setMsg("يرجى إدخال الاسم والـ slug");
    const fieldsJson = {}; form.fields.forEach((f) => { if (f.name.trim()) fieldsJson[f.name.trim()] = f.type; });
    try {
      const payload = { name: form.name.trim(), slug: form.slug.trim(), description: form.description || null, fields: fieldsJson };
      const { error } = editingId ? await supabase.from("features").update(payload).eq("id", editingId) : await supabase.from("features").insert([payload]);
      if (error) throw error;
      setMsg(editingId ? "تم تحديث الميزة بنجاح" : "تم إضافة الميزة بنجاح"); setDrawerOpen(false); resetForm(); fetchFeatures();
    } catch (err) { console.error(err); setMsg("حدث خطأ أثناء الحفظ"); }
  };
  const deleteFeature = async (id) => { if (!window.confirm("هل تريد حذف هذه الميزة؟")) return; const { error } = await supabase.from("features").delete().eq("id", id); if (error) setMsg("فشل في حذف الميزة"); else { setMsg("تم الحذف بنجاح"); fetchFeatures(); } };
  const fieldsCount = (fields) => fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields).length : 0;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">FEATURES</p><h2 className="mt-1 text-2xl font-black text-slate-950">الميزات والتكاملات</h2><p className="mt-1 text-sm text-slate-500">تعريف الميزات وحقول الإعدادات التي تظهر للعميل.</p></div><button onClick={openCreate} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">+ إضافة ميزة</button></div>
      {msg && <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">{msg}</div>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">إجمالي الميزات</p><p className="mt-2 text-3xl font-black">{features.length}</p></div><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">حقول الإعداد</p><p className="mt-2 text-3xl font-black text-indigo-600">{features.reduce((s, f) => s + fieldsCount(f.fields), 0)}</p></div><div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">جاهزة للربط بالخطط</p><p className="mt-2 text-3xl font-black text-emerald-600">{features.length}</p></div></div>
      {loading ? <div className="rounded-3xl bg-white p-10 text-center text-slate-500">جارِ التحميل...</div> : <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">{features.map((f) => { const slug = (f.slug || "").toLowerCase(); const fields = f.fields && typeof f.fields === "object" && !Array.isArray(f.fields) ? Object.entries(f.fields) : []; return <div key={f.id} className={`${cardClass} overflow-hidden`}><div className="p-6"><div className="mb-4 flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-lg font-black text-indigo-600">{iconBySlug[slug] || "🧩"}</div><div><h3 className="font-black text-slate-950">{f.name}</h3><p className="font-mono text-xs text-indigo-600">{f.slug}</p></div></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">{fields.length} حقل</span></div><p className="min-h-[42px] text-sm leading-6 text-slate-500">{f.description || "بدون وصف"}</p><div className="mt-4 flex flex-wrap gap-2">{fields.length ? fields.slice(0, 5).map(([name, type]) => <span key={name} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">{name}: {type}</span>) : <span className="text-xs text-slate-400">لا توجد حقول</span>}</div></div><div className="flex gap-2 border-t border-slate-100 p-4"><button onClick={() => startEdit(f)} className="flex-1 rounded-2xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">تعديل</button><button onClick={() => deleteFeature(f.id)} className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-100">حذف</button></div></div>; })}</div>}
      {drawerOpen && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={() => setDrawerOpen(false)}><form onSubmit={handleSubmit} className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="mb-6 flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">FEATURE</p><h3 className="mt-1 text-2xl font-black text-slate-950">{editingId ? "تعديل ميزة" : "إضافة ميزة"}</h3></div><button type="button" onClick={() => setDrawerOpen(false)} className="rounded-xl border px-3 py-2 text-sm">إغلاق</button></div><div className="space-y-4"><div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-sm font-bold">اسم الميزة</label><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div><div><label className="mb-1 block text-sm font-bold">Slug</label><input className={inputClass} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div></div><div><label className="mb-1 block text-sm font-bold">الوصف</label><textarea className={`${inputClass} min-h-[90px]`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div><div className="rounded-3xl border border-slate-200 p-4"><div className="mb-3 flex items-center justify-between"><h4 className="font-black text-slate-900">حقول الإعداد</h4><button type="button" onClick={addField} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700">+ حقل</button></div><div className="space-y-2">{form.fields.map((field, index) => <div key={index} className="grid grid-cols-[1fr_130px_auto] gap-2"><input className={inputClass} placeholder="اسم الحقل" value={field.name} onChange={(e) => handleFieldChange(index, "name", e.target.value)} /><select className={inputClass} value={field.type} onChange={(e) => handleFieldChange(index, "type", e.target.value)}><option value="text">Text</option><option value="password">Password</option><option value="number">Number</option><option value="url">URL</option></select><button type="button" onClick={() => removeField(index)} className="rounded-2xl bg-red-50 px-3 text-sm font-bold text-red-600">حذف</button></div>)}</div></div><button type="submit" className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200">{editingId ? "تحديث الميزة" : "إضافة ميزة"}</button></div></form></div>}
    </div>
  );
}
