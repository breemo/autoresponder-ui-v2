import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function AdminSystemSettings() {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    fetchSetting();
  }, []);

  async function fetchSetting() {
    setLoading(true);
    setMsg("");
    setIsError(false);

    try {
      const response = await fetch("/api/system-settings");
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل تحميل الإعداد");
      }

      setValue(data?.human_reply_webhook_url || "");
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل تحميل الإعداد");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    const trimmed = value.trim();
    if (!trimmed) {
      setIsError(true);
      setMsg("يرجى إدخال Human Reply Webhook URL");
      return;
    }

    setSaving(true);
    setMsg("");
    setIsError(false);

    try {
      const response = await fetch("/api/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_reply_webhook_url: trimmed }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل حفظ الإعداد");
      }

      setValue(data?.human_reply_webhook_url ?? trimmed);
      setMsg("تم حفظ الإعداد بنجاح");
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل حفظ الإعداد");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">
            SETTINGS
          </p>

          <h2 className="mt-1 text-2xl font-black text-slate-950">
            إعدادات النظام
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            إعدادات عامة على مستوى المنصة، مشتركة بين جميع العملاء.
          </p>
        </div>

        <Link
          to="/admin/settings"
          className="inline-flex h-10 items-center rounded-2xl border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          رجوع
        </Link>
      </div>

      {msg && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
            isError
              ? "border-red-100 bg-red-50 text-red-700"
              : "border-indigo-100 bg-indigo-50 text-indigo-700"
          }`}
        >
          {msg}
        </div>
      )}

      <form onSubmit={handleSubmit} className={`${cardClass} space-y-4 p-6`}>
        <div>
          <label className="mb-1 block text-sm font-bold">
            Human Reply Webhook URL
          </label>

          <input
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://n8n.../webhook/human-reply"
            dir="ltr"
            disabled={loading || saving}
          />

          <p className="mt-1 text-xs text-slate-500">
            رابط n8n Human Reply workflow المستخدم عند إرسال رد بشري من صندوق
            الوارد الخاص بالعميل. رابط واحد مشترك بين جميع العملاء.
          </p>
        </div>

        <button
          type="submit"
          disabled={loading || saving}
          className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "جارِ الحفظ..." : "حفظ الإعداد"}
        </button>
      </form>
    </div>
  );
}
