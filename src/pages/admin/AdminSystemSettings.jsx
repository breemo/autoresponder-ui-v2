import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

// Kept 1:1 with the api/system-settings.js allowlist. The two *_workflow_id
// keys are the only ones consumed at runtime (parent workflows' Execute
// Workflow node); every *_url key is administration/reference only.
const EMPTY = {
  human_reply_webhook_url: "",
  ai_agent_core_workflow_url: "",
  ai_agent_core_workflow_id: "",
  inbound_media_core_workflow_url: "",
  inbound_media_core_workflow_id: "",
};

export default function AdminSystemSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  function setField(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function fetchSettings() {
    setLoading(true);
    setMsg("");
    setIsError(false);

    try {
      const response = await fetch(
        `/api/system-settings?actor_user_id=${encodeURIComponent(user?.id || "")}`
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل تحميل الإعدادات");
      }

      setSettings({ ...EMPTY, ...(data?.settings || {}) });
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل تحميل الإعدادات");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (!settings.human_reply_webhook_url.trim()) {
      setIsError(true);
      setMsg("يرجى إدخال رابط Webhook لرد الموظف");
      return;
    }

    setSaving(true);
    setMsg("");
    setIsError(false);

    try {
      const payload = { actor_user_id: user?.id };
      for (const key of Object.keys(EMPTY)) {
        payload[key] = (settings[key] || "").trim();
      }

      const response = await fetch("/api/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل حفظ الإعدادات");
      }

      setSettings({ ...EMPTY, ...(data?.settings || {}) });
      setMsg("تم حفظ الإعدادات بنجاح");
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل حفظ الإعدادات");
    } finally {
      setSaving(false);
    }
  }

  const busy = loading || saving;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">SETTINGS</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">إعدادات النظام</h2>
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

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className={`${cardClass} space-y-4 p-6`}>
          <div>
            <h3 className="text-sm font-black text-slate-900">إعدادات n8n Workflow</h3>
            <p className="mt-1 text-xs text-slate-500">
              السجل المركزي لمراجع n8n workflows. عند استيراد نسخة جديدة من أحد الـ Core
              workflows، حدّث المعرّف (Workflow ID) هنا فقط — لا حاجة لتعديل الـ parent
              workflows.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-bold">
              Human Reply - Multi Channel Media — Workflow URL
            </label>
            <input
              className={inputClass}
              value={settings.human_reply_webhook_url}
              onChange={(e) => setField("human_reply_webhook_url", e.target.value)}
              placeholder="https://n8n.../webhook/human-reply-Media"
              dir="ltr"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">
              رابط n8n Human Reply workflow المستخدم عند إرسال رد الموظف. مطلوب — رابط واحد
              مشترك بين جميع العملاء (السلوك الحالي دون تغيير).
            </p>
          </div>

          <hr className="border-slate-100" />

          <div>
            <label className="mb-1 block text-sm font-bold">AI-Agent-Core — Workflow ID</label>
            <input
              className={inputClass}
              value={settings.ai_agent_core_workflow_id}
              onChange={(e) => setField("ai_agent_core_workflow_id", e.target.value)}
              placeholder="x2T6z94nazQWk2NY"
              dir="ltr"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">
              معرّف n8n workflow — الجزء الأخير من رابط المحرّر <span dir="ltr">/workflow/&lt;id&gt;</span>.
              تستدعيه الـ parent workflows عبر Execute Workflow.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-bold">
              AI-Agent-Core — Workflow URL (مرجعي)
            </label>
            <input
              className={inputClass}
              value={settings.ai_agent_core_workflow_url}
              onChange={(e) => setField("ai_agent_core_workflow_url", e.target.value)}
              placeholder="https://n8n.../workflow/x2T6z94nazQWk2NY"
              dir="ltr"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">للإدارة والمرجع فقط — لا يُستخدم في التنفيذ.</p>
          </div>

          <hr className="border-slate-100" />

          <div>
            <label className="mb-1 block text-sm font-bold">Inbound-Media-Core — Workflow ID</label>
            <input
              className={inputClass}
              value={settings.inbound_media_core_workflow_id}
              onChange={(e) => setField("inbound_media_core_workflow_id", e.target.value)}
              placeholder="EAWx4flzCX0b7RJ6"
              dir="ltr"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">
              معرّف n8n workflow. تستدعيه الـ parent workflows عبر Execute Workflow لمعالجة
              الوسائط الواردة.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-bold">
              Inbound-Media-Core — Workflow URL (مرجعي)
            </label>
            <input
              className={inputClass}
              value={settings.inbound_media_core_workflow_url}
              onChange={(e) => setField("inbound_media_core_workflow_url", e.target.value)}
              placeholder="https://n8n.../workflow/EAWx4flzCX0b7RJ6"
              dir="ltr"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-slate-500">للإدارة والمرجع فقط — لا يُستخدم في التنفيذ.</p>
          </div>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "جارِ الحفظ..." : "حفظ الإعدادات"}
        </button>
      </form>
    </div>
  );
}
