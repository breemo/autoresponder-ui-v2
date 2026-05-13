import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function ClientSettings() {
  const { user } = useAuth();
  const clientId = user?.client_id || user?.id;
  const [form, setForm] = useState({ business_name: "", email: "", phone: "", address: "", business_description: "", welcome_message: "", default_reply: "", closing_message: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { if (clientId) loadClient(); }, [clientId]);

  async function loadClient() {
    const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (error) return console.error("Error loading client settings:", error);
    if (data) setForm({ business_name: data.business_name || "", email: data.email || "", phone: data.phone || "", address: data.address || "", business_description: data.business_description || "", welcome_message: data.welcome_message || "", default_reply: data.default_reply || "", closing_message: data.closing_message || "", password: "" });
  }

  async function handleSave() {
    try {
      setLoading(true); setMsg("");
      const { error: clientError } = await supabase.from("clients").update({ business_name: form.business_name, phone: form.phone, address: form.address, business_description: form.business_description, welcome_message: form.welcome_message, default_reply: form.default_reply, closing_message: form.closing_message }).eq("id", clientId);
      if (clientError) throw clientError;
      if (form.password) {
        const { error: userError } = await supabase.from("users").update({ password: form.password }).eq("id", user.id);
        if (userError) throw userError;
      }
      setMsg("تم حفظ الإعدادات بنجاح");
      setForm((prev) => ({ ...prev, password: "" }));
    } catch (err) {
      console.error(err); setMsg("حدث خطأ أثناء حفظ الإعدادات");
    } finally { setLoading(false); }
  }

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">SETTINGS</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">إعدادات الحساب</h2>
          <p className="mt-1 text-sm text-slate-500">إعدادات النشاط والرسائل الأساسية والرد الافتراضي.</p>
        </div>
        <button onClick={handleSave} disabled={loading} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 disabled:opacity-60">{loading ? "جارٍ الحفظ..." : "حفظ الإعدادات"}</button>
      </div>

      {msg && <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${msg.includes("خطأ") ? "border-red-100 bg-red-50 text-red-700" : "border-emerald-100 bg-emerald-50 text-emerald-700"}`}>{msg}</div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.2fr]">
        <div className={`${cardClass} p-6`}>
          <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl">🏢</div><div><h3 className="font-black text-slate-950">بيانات النشاط</h3><p className="text-xs text-slate-500">المعلومات الأساسية التي يستخدمها النظام</p></div></div>
          <div className="space-y-4">
            <div><label className="mb-1 block text-sm font-bold text-slate-700">اسم النشاط</label><input className={inputClass} value={form.business_name} onChange={(e) => update("business_name", e.target.value)} /></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">البريد الإلكتروني</label><input className={inputClass} value={form.email} disabled /><p className="mt-1 text-xs text-slate-400">لتعديل البريد الإلكتروني يرجى التواصل مع الإدارة</p></div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2"><div><label className="mb-1 block text-sm font-bold text-slate-700">رقم الهاتف</label><input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">العنوان</label><input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} /></div></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">نبذة عن النشاط</label><textarea rows={5} className={inputClass} value={form.business_description} onChange={(e) => update("business_description", e.target.value)} /></div>
          </div>
        </div>

        <div className="space-y-5">
          <div className={`${cardClass} p-6`}>
            <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-xl">💬</div><div><h3 className="font-black text-slate-950">رسائل المحادثة</h3><p className="text-xs text-slate-500">الرسائل العامة المستخدمة في بداية ونهاية المحادثة</p></div></div>
            <div className="space-y-4">
              <div><label className="mb-1 block text-sm font-bold text-slate-700">رسالة الترحيب</label><textarea rows={4} className={inputClass} value={form.welcome_message} onChange={(e) => update("welcome_message", e.target.value)} placeholder="أهلاً وسهلاً بك..." /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">الرد الافتراضي</label><textarea rows={4} className={inputClass} value={form.default_reply} onChange={(e) => update("default_reply", e.target.value)} placeholder="شكراً لتواصلك معنا..." /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">رسالة الإغلاق</label><textarea rows={3} className={inputClass} value={form.closing_message} onChange={(e) => update("closing_message", e.target.value)} placeholder="سعدنا بخدمتك..." /></div>
            </div>
          </div>

          <div className={`${cardClass} p-6`}>
            <div className="mb-4 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-xl">🔐</div><div><h3 className="font-black text-slate-950">الأمان</h3><p className="text-xs text-slate-500">اترك كلمة المرور فارغة إذا لا تريد تغييرها</p></div></div>
            <input type="password" className={inputClass} placeholder="كلمة مرور جديدة" value={form.password} onChange={(e) => update("password", e.target.value)} />
          </div>
        </div>
      </div>
    </div>
  );
}
