import { Link } from "react-router-dom";
import { useEffect, useId, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

// Runtime = read by the system on every relevant request/execution (a wrong
// value breaks a live flow). Reference = stored for administrators only.
function Badge({ kind }) {
  const runtime = kind === "runtime";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${
        runtime ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-slate-100 text-slate-600 ring-slate-200"
      }`}
    >
      {runtime ? "Runtime" : "Reference"}
    </span>
  );
}

function SettingField({ label, kind, value, onChange, placeholder, disabled, children, warning }) {
  const id = useId();
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/50 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-bold text-slate-900">{label}</label>
        <Badge kind={kind} />
      </div>
      <input
        id={id}
        className={inputClass}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        dir="ltr"
        disabled={disabled}
      />
      <p className="mt-2 text-xs leading-5 text-slate-600">{children}</p>
      {warning && <p className="mt-1 text-xs font-semibold leading-5 text-amber-700">{warning}</p>}
    </div>
  );
}

// Kept 1:1 with the api/system-settings.js allowlist. human_reply_webhook_url
// and evolution_api_gateway_workflow_url are consumed at runtime directly by
// Vercel serverless functions (Vercel -> n8n fetch); the two *_workflow_id
// keys are consumed at runtime by n8n itself (parent workflows' Execute
// Workflow node); main_inbound_webhook_url is served (validated) to the
// Integrations UI to build channel setup links; every other *_url key is
// administration/reference only.
const EMPTY = {
  human_reply_webhook_url: "",
  evolution_api_gateway_workflow_url: "",
  main_inbound_webhook_url: "",
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
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs leading-6 text-indigo-800">
          إعدادات n8n Workflow — السجل المركزي لمراجع n8n. القيم <b>خاصة بكل بيئة</b> (Development / Production
          لكلٍّ منهما قاعدة بياناته وقيمه) وتُطبَّق <b>فور الحفظ</b>. القيم المعلَّمة <b>Runtime</b> يستخدمها النظام
          أثناء التشغيل وأي خطأ فيها يعطّل تدفّقاً حيّاً؛ القيم <b>Reference</b> للمرجع الإداري فقط. ترك حقل فارغاً
          لا يمسح القيمة المحفوظة.
        </div>

        <div className={`${cardClass} space-y-4 p-6`}>
          <div>
            <h3 className="text-sm font-black text-slate-900">Inbound &amp; Messaging — الاستقبال والمراسلة</h3>
            <p className="mt-1 text-xs text-slate-500">روابط Webhook يستدعيها النظام مباشرة أثناء التشغيل.</p>
          </div>

          <SettingField
            label="Main Inbound Flow — Webhook URL"
            kind="runtime"
            value={settings.main_inbound_webhook_url}
            onChange={(e) => setField("main_inbound_webhook_url", e.target.value)}
            placeholder="https://n8n.../webhook/<webhook-id>/inbound"
            disabled={busy}
            warning="تغييره يغيّر روابط الإعداد التي يستخدمها العملاء لربط قنواتهم في هذه البيئة."
          >
            رابط الـ Webhook الأساسي لـ AutoResponder_Final_V3 في هذه البيئة. تُبنى منه روابط إعداد تيليجرام وفيسبوك
            وإنستغرام في صفحة التكاملات: <span dir="ltr">&lt;URL&gt;/telegram/&lt;channelKey&gt;</span>. يجب أن يبدأ
            بـ https وأن يحتوي على <span dir="ltr">/webhook/</span> وأن ينتهي بـ <span dir="ltr">/inbound</span>.
            إذا لم يُضبط تظهر الروابط للعملاء على أنها «غير مُعدّة».
          </SettingField>

          <SettingField
            label="Human Reply — Workflow URL"
            kind="runtime"
            value={settings.human_reply_webhook_url}
            onChange={(e) => setField("human_reply_webhook_url", e.target.value)}
            placeholder="https://n8n.../webhook/human-reply-Media"
            disabled={busy}
            warning="مطلوب. قيمة خاطئة تُفشل إرسال ردود الموظفين من صندوق المحادثات."
          >
            يستدعيه النظام في كل مرة يرسل فيها موظف رداً من صندوق المحادثات (نص أو وسائط) إلى قناة العميل.
          </SettingField>

          <SettingField
            label="Evolution API Gateway — Workflow URL"
            kind="runtime"
            value={settings.evolution_api_gateway_workflow_url}
            onChange={(e) => setField("evolution_api_gateway_workflow_url", e.target.value)}
            placeholder="https://n8n.../webhook/evolution-api-gateway"
            disabled={busy}
            warning="قيمة خاطئة تُفشل إنشاء أو ربط أو مزامنة أو حذف أرقام واتساب."
          >
            يستدعيه النظام عند إنشاء/ربط/مزامنة/حذف أرقام واتساب (Evolution).
          </SettingField>
        </div>

        <div className={`${cardClass} space-y-4 p-6`}>
          <div>
            <h3 className="text-sm font-black text-slate-900">Core Workflows — الـ Workflows الأساسية</h3>
            <p className="mt-1 text-xs text-slate-500">
              عند استيراد نسخة جديدة من أحد الـ Core workflows، حدّث المعرّف (Workflow ID) هنا فقط — لا حاجة لتعديل
              الـ parent workflows.
            </p>
          </div>

          <SettingField
            label="AI-Agent-Core — Workflow ID"
            kind="runtime"
            value={settings.ai_agent_core_workflow_id}
            onChange={(e) => setField("ai_agent_core_workflow_id", e.target.value)}
            placeholder="x2T6z94nazQWk2NY"
            disabled={busy}
            warning="معرّف خاطئ يوقف ردود الذكاء الاصطناعي على كل القنوات."
          >
            معرّف n8n workflow — الجزء الأخير من رابط المحرّر <span dir="ltr">/workflow/&lt;id&gt;</span>. تنفّذه الـ
            parent workflows عبر Execute Workflow لكل رد ذكاء اصطناعي.
          </SettingField>

          <SettingField
            label="AI-Agent-Core — Workflow URL"
            kind="reference"
            value={settings.ai_agent_core_workflow_url}
            onChange={(e) => setField("ai_agent_core_workflow_url", e.target.value)}
            placeholder="https://n8n.../workflow/x2T6z94nazQWk2NY"
            disabled={busy}
          >
            للإدارة والمرجع فقط — رابط سريع لفتح الـ workflow في n8n. لا يستخدمه النظام أثناء التشغيل.
          </SettingField>

          <SettingField
            label="Inbound-Media-Core — Workflow ID"
            kind="runtime"
            value={settings.inbound_media_core_workflow_id}
            onChange={(e) => setField("inbound_media_core_workflow_id", e.target.value)}
            placeholder="EAWx4flzCX0b7RJ6"
            disabled={busy}
            warning="معرّف خاطئ يوقف معالجة الصور والملفات والصوت الواردة."
          >
            معرّف n8n workflow. تنفّذه الـ parent workflows عبر Execute Workflow لمعالجة الوسائط الواردة.
          </SettingField>

          <SettingField
            label="Inbound-Media-Core — Workflow URL"
            kind="reference"
            value={settings.inbound_media_core_workflow_url}
            onChange={(e) => setField("inbound_media_core_workflow_url", e.target.value)}
            placeholder="https://n8n.../workflow/EAWx4flzCX0b7RJ6"
            disabled={busy}
          >
            للإدارة والمرجع فقط — لا يستخدمه النظام أثناء التشغيل.
          </SettingField>
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
