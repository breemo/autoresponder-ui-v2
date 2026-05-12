import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import Loader from "../components/Loader";

export default function Settings() {
  const [settings, setSettings] = useState({
    smtp_host: "",
    smtp_port: "",
    api_key: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApi, setShowApi] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .single();

      if (error && error.code !== "PGRST116") throw error; // لا يوجد صف

      if (data) {
        setSettings({
          smtp_host: data.smtp_host || "",
          smtp_port: data.smtp_port || "",
          api_key: data.api_key || "",
        });
      }
    } catch (err) {
      console.error("خطأ في جلب الإعدادات:", err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    try {
      setSaving(true);
      const { error } = await supabase.from("settings").upsert(settings);
      if (error) throw error;
      alert("✅ تم حفظ الإعدادات بنجاح");
    } catch (err) {
      console.error("خطأ في حفظ الإعدادات:", err.message);
      alert("تعذر حفظ الإعدادات.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loader message="جارِ تحميل الإعدادات..." />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">الإعدادات</h1>
      <p className="text-gray-500 mb-6">
        إعدادات النظام العامة (SMTP لإرسال الإشعارات و API Key للتكامل مع
        منصات مثل واتساب / فيسبوك وغيرها).
      </p>

      <div className="bg-white rounded-xl shadow p-6 w-full md:w-2/3 lg:w-1/2">
        <div className="mb-4">
          <label className="block mb-1 text-sm font-medium">SMTP Host</label>
          <input
            type="text"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={settings.smtp_host}
            onChange={(e) =>
              setSettings((s) => ({ ...s, smtp_host: e.target.value }))
            }
          />
        </div>

        <div className="mb-4">
          <label className="block mb-1 text-sm font-medium">SMTP Port</label>
          <input
            type="text"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={settings.smtp_port}
            onChange={(e) =>
              setSettings((s) => ({ ...s, smtp_port: e.target.value }))
            }
          />
        </div>

        <div className="mb-6">
          <label className="block mb-1 text-sm font-medium">API Key</label>
          <div className="flex gap-2">
            <input
              type={showApi ? "text" : "password"}
              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={settings.api_key}
              onChange={(e) =>
                setSettings((s) => ({ ...s, api_key: e.target.value }))
              }
            />
            <button
              type="button"
              onClick={() => setShowApi((v) => !v)}
              className="px-3 py-2 text-sm border rounded-lg text-gray-600 hover:bg-gray-50"
            >
              {showApi ? "إخفاء" : "إظهار"}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            هذا الـ API Key هو المفتاح العام للتكامل مع منصات الإرسال
            (WhatsApp / Facebook / Telegram ... إلخ). لاحقاً ممكن نضيف
            أكثر من قناة لكل عميل.
          </p>
        </div>

        <button
          disabled={saving}
          onClick={saveSettings}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-6 py-2 rounded-lg disabled:opacity-60"
        >
          {saving ? "جارِ الحفظ..." : "حفظ الإعدادات"}
        </button>
      </div>
    </div>
  );
}
