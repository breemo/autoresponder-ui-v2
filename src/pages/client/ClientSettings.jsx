import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

export default function ClientSettings() {
  const { user } = useAuth();
  const clientId = user?.client_id || user?.id;

  const [form, setForm] = useState({
    business_name: "",
    email: "",
    phone: "",
    address: "",
    business_description: "",
    welcome_message: "",
    default_reply: "",
    password: ""
  });

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (clientId) loadClient();
  }, [clientId]);

  async function loadClient() {
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .single();

    if (error) {
      console.error("Error loading client settings:", error);
      return;
    }

    if (data) {
      setForm({
        business_name: data.business_name || "",
        email: data.email || "",
        phone: data.phone || "",
        address: data.address || "",
        business_description: data.business_description || "",
        welcome_message: data.welcome_message || "",
        default_reply: data.default_reply || "",
        password: ""
      });
    }
  }

  async function handleSave() {
    try {
      setLoading(true);

      const { error: clientError } = await supabase
        .from("clients")
        .update({
          business_name: form.business_name,
          phone: form.phone,
          address: form.address,
          business_description: form.business_description,
          welcome_message: form.welcome_message,
          default_reply: form.default_reply
        })
        .eq("id", clientId);

      if (clientError) throw clientError;

      // تحديث كلمة المرور إذا تم إدخالها
      if (form.password) {
        const { error: userError } = await supabase
          .from("users")
          .update({ password: form.password })
          .eq("id", user.id);

        if (userError) throw userError;
      }

      alert("تم حفظ الإعدادات بنجاح ✅");
    } catch (err) {
      console.error("Error saving client settings:", err);
      alert("حدث خطأ أثناء حفظ الإعدادات");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">إعدادات الحساب</h1>

      <div className="bg-white p-6 rounded shadow space-y-4">
        {/* الاسم */}
        <div>
          <label className="block mb-1">اسم النشاط</label>
          <input
            value={form.business_name}
            onChange={(e) =>
              setForm({ ...form, business_name: e.target.value })
            }
            className="w-full border p-2 rounded"
          />
        </div>

        {/* الايميل (disabled) */}
        <div>
          <label className="block mb-1">البريد الإلكتروني</label>
          <input
            value={form.email}
            disabled
            className="w-full border p-2 rounded bg-gray-100"
          />
          <p className="text-xs text-gray-500 mt-1">
            لتعديل البريد الإلكتروني يرجى التواصل مع الإدارة
          </p>
        </div>

        {/* الهاتف */}
        <div>
          <label className="block mb-1">رقم الهاتف</label>
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full border p-2 rounded"
          />
        </div>

        {/* العنوان */}
        <div>
          <label className="block mb-1">العنوان</label>
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="w-full border p-2 rounded"
          />
        </div>

        {/* الوصف */}
        <div>
          <label className="block mb-1">نبذة عن النشاط</label>
          <textarea
            rows={3}
            value={form.business_description}
            onChange={(e) =>
              setForm({ ...form, business_description: e.target.value })
            }
            className="w-full border p-2 rounded"
          />
        </div>

        {/* رسالة الترحيب */}
        <div>
          <label className="block mb-1">رسالة الترحيب</label>
          <textarea
            rows={4}
            value={form.welcome_message}
            onChange={(e) =>
              setForm({ ...form, welcome_message: e.target.value })
            }
            className="w-full border p-2 rounded"
            placeholder="أهلاً وسهلاً بك..."
          />
          <p className="text-xs text-gray-500 mt-1">
            تظهر للزبون عند بداية محادثة جديدة.
          </p>
        </div>

        {/* الرد الافتراضي */}
        <div>
          <label className="block mb-1">الرد الافتراضي</label>
          <textarea
            rows={4}
            value={form.default_reply}
            onChange={(e) =>
              setForm({ ...form, default_reply: e.target.value })
            }
            className="w-full border p-2 rounded"
            placeholder="شكراً لتواصلك معنا، سيتم الرد عليك بأقرب وقت ممكن."
          />
          <p className="text-xs text-gray-500 mt-1">
            يستخدم إذا لم يوجد رد تلقائي ولم يتم استخدام الذكاء الاصطناعي.
          </p>
        </div>

        {/* الباسورد */}
        <div>
          <label className="block mb-1">كلمة المرور</label>
          <input
            type="password"
            placeholder="اتركه فارغ إذا لا تريد تغييره"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full border p-2 rounded"
          />
        </div>

        {/* زر الحفظ */}
        <button
          onClick={handleSave}
          disabled={loading}
          className="bg-blue-600 text-white px-6 py-2 rounded disabled:opacity-60"
        >
          {loading ? "جارٍ الحفظ..." : "حفظ الإعدادات"}
        </button>
      </div>
    </div>
  );
}
