import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  SETTINGS_KEYS,
  WORKFLOW_PAIRS,
  computeSettingsChanges,
  extractN8nWorkflowId,
  isWorkflowPairOutOfSync,
} from "../../lib/n8nSettings.js";

// Admin → Settings → System: n8n Runtime Control Panel.
//
// Storage / API / authorization are unchanged: the 7 system_settings keys
// (SETTINGS_KEYS) via the admin-only /api/system-settings. Webhook URLs are
// edited directly; for the core workflows the admin edits ONLY the Workflow
// URL and the Workflow ID is auto-detected from it (/workflow/<id>) and
// saved together with it — the runtime still reads the *_workflow_id keys.
// Only changed keys are sent; empty values are never sent (the API never
// clears a stored value).

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";
const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left font-mono text-xs outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const smallBtn =
  "inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

const EMPTY = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, ""]));

const WEBHOOK_ROWS = [
  {
    key: "main_inbound_webhook_url",
    name: "Main Inbound Flow",
    placeholder: "https://n8n.../webhook/<webhook-id>/inbound",
    hint: "تُبنى منه روابط إعداد تيليجرام وفيسبوك وإنستغرام في صفحة التكاملات.",
    warning:
      "تغييره يغيّر روابط الإعداد التي يستخدمها العملاء في هذه البيئة. يجب أن يبدأ بـ https وأن يحتوي على /webhook/ وأن ينتهي بـ /inbound.",
  },
  {
    key: "human_reply_webhook_url",
    name: "Human Reply",
    placeholder: "https://n8n.../webhook/human-reply-Media",
    hint: "يُستدعى عند إرسال رد الموظف من صندوق المحادثات.",
    warning: "قيمة خاطئة تُفشل إرسال ردود الموظفين من صندوق المحادثات.",
  },
  {
    key: "evolution_api_gateway_workflow_url",
    name: "Evolution API Gateway",
    placeholder: "https://n8n.../webhook/evolution-api-gateway",
    hint: "يُستدعى عند إنشاء/ربط/مزامنة/حذف أرقام واتساب.",
    warning: "قيمة خاطئة تُفشل إدارة أرقام واتساب (Evolution).",
  },
];

const WORKFLOW_ROWS = [
  {
    ...WORKFLOW_PAIRS[0],
    name: "AI-Agent-Core",
    hint: "تنفّذه الـ parent workflows لكل رد ذكاء اصطناعي.",
    warning: "Workflow خاطئ يوقف ردود الذكاء الاصطناعي على كل القنوات في هذه البيئة.",
  },
  {
    ...WORKFLOW_PAIRS[1],
    name: "Inbound-Media-Core",
    hint: "تنفّذه الـ parent workflows لمعالجة الوسائط الواردة.",
    warning: "Workflow خاطئ يوقف معالجة الصور والملفات والصوت الواردة.",
  },
];

const ERROR_TEXT = {
  empty: "لا يمكن ترك القيمة فارغة — القيم الفارغة لا تُحفظ ولا تمسح القيمة الحالية.",
  invalid_url: "رابط غير صالح.",
  invalid_inbound_base: "يجب أن يبدأ بـ https وأن يحتوي على /webhook/ وأن ينتهي بـ /inbound، دون ? أو #.",
  https_required: "يجب أن يبدأ رابط الـ workflow بـ https://",
  no_workflow_path: "لم يُعثر على /workflow/<id> في الرابط. انسخ رابط المحرّر من n8n.",
  invalid_workflow_id: "تعذّر استخراج Workflow ID صالح من الرابط.",
};

const RUNTIME_KEYS = ["main_inbound_webhook_url", "human_reply_webhook_url", "evolution_api_gateway_workflow_url", "ai_agent_core_workflow_id", "inbound_media_core_workflow_id"];

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

function StatusPill({ ok }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${
        ok ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-red-50 text-red-700 ring-red-200"
      }`}
    >
      {ok ? "Configured" : "Missing"}
    </span>
  );
}

// Technical value: always LTR, isolated from the RTL page, truncated.
function TechValue({ value, empty = "—" }) {
  return (
    <bdi dir="ltr" className="block min-w-0 truncate font-mono text-xs text-slate-700" title={value || undefined}>
      {value || empty}
    </bdi>
  );
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={smallBtn}
      disabled={!value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "تم النسخ" : "نسخ"}
    </button>
  );
}

export default function AdminSystemSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(EMPTY);
  const [environment, setEnvironment] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function fetchSettings() {
    setLoading(true);
    setMsg("");
    setIsError(false);
    try {
      const response = await fetch(`/api/system-settings?actor_user_id=${encodeURIComponent(user?.id || "")}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || "فشل تحميل الإعدادات");
      setSettings({ ...EMPTY, ...(data?.settings || {}) });
      setEnvironment(typeof data?.environment === "string" ? data.environment : null);
      setDrafts({});
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل تحميل الإعدادات");
    } finally {
      setLoading(false);
    }
  }

  const { changes, errors } = useMemo(() => computeSettingsChanges(settings, drafts), [settings, drafts]);
  const changeCount = Object.keys(changes).length;
  const hasErrors = Object.keys(errors).length > 0;
  const hasUnsaved =
    changeCount > 0 || hasErrors || Object.entries(drafts).some(([k, v]) => String(v ?? "").trim() !== String(settings[k] || "").trim());
  const busy = loading || saving;
  const runtimeConfigured = RUNTIME_KEYS.filter((k) => String(settings[k] || "").trim()).length;

  function startEdit(key) {
    setDrafts((prev) => (prev[key] !== undefined ? prev : { ...prev, [key]: settings[key] || "" }));
    setMsg("");
  }

  function cancelAll() {
    setDrafts({});
    setMsg("");
    setIsError(false);
  }

  async function handleSave() {
    if (!changeCount || hasErrors) return;
    setSaving(true);
    setMsg("");
    setIsError(false);
    try {
      const response = await fetch("/api/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_user_id: user?.id, ...changes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || "فشل حفظ الإعدادات");
      setSettings({ ...EMPTY, ...(data?.settings || {}) });
      setDrafts({});
      setMsg("تم حفظ الإعدادات بنجاح");
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل حفظ الإعدادات");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 pb-24" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">SETTINGS</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">إعدادات النظام</h2>
        </div>
        <Link
          to="/admin/settings"
          className="inline-flex h-10 items-center rounded-2xl border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          رجوع
        </Link>
      </div>

      {/* Summary */}
      <div className={`${cardClass} flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between`}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-black text-slate-950">
              <bdi dir="ltr">n8n Runtime Configuration</bdi>
            </h3>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-black ring-1 ${
                environment === "PROD"
                  ? "bg-red-50 text-red-700 ring-red-200"
                  : environment
                    ? "bg-sky-50 text-sky-700 ring-sky-200"
                    : "bg-slate-100 text-slate-500 ring-slate-200"
              }`}
              title="Vercel environment of this deployment"
            >
              <bdi dir="ltr">{environment || "Environment unknown"}</bdi>
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
              <bdi dir="ltr">{`Runtime ${runtimeConfigured}/${RUNTIME_KEYS.length} configured`}</bdi>
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">أي تغيير يُطبَّق فوراً على هذه البيئة فقط (لكل بيئة قيمها الخاصة).</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <Badge kind="runtime" /> يستخدمه النظام أثناء التشغيل
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Badge kind="reference" /> للمرجع الإداري فقط
          </span>
        </div>
      </div>

      {msg && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
            isError ? "border-red-100 bg-red-50 text-red-700" : "border-indigo-100 bg-indigo-50 text-indigo-700"
          }`}
        >
          {msg}
        </div>
      )}

      {/* Inbound & Messaging */}
      <section className={`${cardClass} p-5`}>
        <h3 className="mb-3 text-sm font-black text-slate-900">
          <bdi dir="ltr">Inbound &amp; Messaging</bdi> — الاستقبال والمراسلة
        </h3>
        <div className="divide-y divide-slate-100">
          {WEBHOOK_ROWS.map((row) => {
            const value = settings[row.key] || "";
            const editing = drafts[row.key] !== undefined;
            const error = errors[row.key];
            return (
              <div key={row.key} className="py-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="flex min-w-[220px] flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">
                      <bdi dir="ltr">{row.name}</bdi>
                    </span>
                    <Badge kind="runtime" />
                    <StatusPill ok={!!value.trim()} />
                  </div>
                  <div className="min-w-0 flex-1">
                    {!editing && <TechValue value={value} />}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <CopyButton value={value} />
                    {!editing && (
                      <button type="button" className={smallBtn} onClick={() => startEdit(row.key)} disabled={busy}>
                        تعديل
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{row.hint}</p>
                {editing && (
                  <div className="mt-2 space-y-1.5 rounded-2xl border border-amber-100 bg-amber-50/40 p-3">
                    <input
                      dir="ltr"
                      aria-label={`${row.name} URL`}
                      className={inputClass}
                      value={drafts[row.key]}
                      placeholder={row.placeholder}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      disabled={busy}
                    />
                    <p className="text-[11px] font-semibold leading-5 text-amber-800">{row.warning}</p>
                    {error && <p className="text-[11px] font-bold text-red-700">{ERROR_TEXT[error] || error}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Core Workflows */}
      <section className={`${cardClass} p-5`}>
        <h3 className="text-sm font-black text-slate-900">
          <bdi dir="ltr">Core Workflows</bdi> — الـ Workflows الأساسية
        </h3>
        <p className="mb-3 mt-1 text-xs text-slate-500">
          أدخل رابط المحرّر في n8n فقط؛ يُستخرج الـ Workflow ID تلقائياً ويُحفظ معه.
        </p>
        <div className="divide-y divide-slate-100">
          {WORKFLOW_ROWS.map((row) => {
            const url = settings[row.urlKey] || "";
            const id = settings[row.idKey] || "";
            const editing = drafts[row.urlKey] !== undefined;
            const draftEx = editing ? extractN8nWorkflowId(String(drafts[row.urlKey] || "")) : null;
            const shownId = editing ? (draftEx.ok ? draftEx.id : "") : id;
            const error = errors[row.urlKey];
            const outOfSync = !editing && isWorkflowPairOutOfSync(settings, row);
            return (
              <div key={row.urlKey} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">
                    <bdi dir="ltr">{row.name}</bdi>
                  </span>
                  <Badge kind="runtime" />
                  <StatusPill ok={!!id.trim()} />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{row.hint}</p>

                <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
                  <div className="min-w-0 rounded-2xl border border-slate-100 bg-slate-50/60 p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-slate-500">
                        <bdi dir="ltr">Workflow URL</bdi>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <CopyButton value={url} />
                        <a
                          href={url || undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-disabled={!url}
                          className={`${smallBtn} ${url ? "" : "pointer-events-none opacity-50"}`}
                        >
                          فتح في n8n
                        </a>
                        {!editing && (
                          <button type="button" className={smallBtn} onClick={() => startEdit(row.urlKey)} disabled={busy}>
                            تعديل
                          </button>
                        )}
                      </div>
                    </div>
                    {editing ? (
                      <input
                        dir="ltr"
                        aria-label={`${row.name} Workflow URL`}
                        className={inputClass}
                        value={drafts[row.urlKey]}
                        placeholder="https://n8n.../workflow/<workflow-id>"
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [row.urlKey]: e.target.value }))}
                        disabled={busy}
                      />
                    ) : (
                      <TechValue value={url} />
                    )}
                  </div>

                  <div className="min-w-0 rounded-2xl border border-slate-100 bg-white p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-slate-500">
                        <bdi dir="ltr">Workflow ID</bdi>
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                        <bdi dir="ltr">🔒 Auto-detected</bdi>
                      </span>
                    </div>
                    <input
                      dir="ltr"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      aria-label={`${row.name} Workflow ID (auto-detected)`}
                      className={`${inputClass} cursor-not-allowed bg-slate-50 text-slate-600`}
                      value={shownId || ""}
                      placeholder="—"
                    />
                  </div>
                </div>

                {editing && (
                  <div className="mt-2 space-y-1 rounded-2xl border border-amber-100 bg-amber-50/40 p-3">
                    <p className="text-[11px] font-semibold leading-5 text-amber-800">{row.warning}</p>
                    {error && <p className="text-[11px] font-bold text-red-700">{ERROR_TEXT[error] || error}</p>}
                  </div>
                )}
                {outOfSync && (
                  <p className="mt-2 text-[11px] font-bold text-amber-700">
                    الرابط المحفوظ لا يطابق الـ Workflow ID المحفوظ — عدّل الرابط واحفظه لمزامنتهما.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Save bar */}
      <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <p className={`text-xs font-bold ${hasUnsaved ? "text-amber-700" : "text-slate-400"}`}>
          {hasErrors ? "يوجد أخطاء يجب تصحيحها قبل الحفظ" : hasUnsaved ? `تغييرات غير محفوظة (${changeCount})` : "لا توجد تغييرات"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelAll}
            disabled={busy || !Object.keys(drafts).length}
            className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !changeCount || hasErrors}
            className="h-10 rounded-xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "جارِ الحفظ..." : "حفظ التغييرات"}
          </button>
        </div>
      </div>
    </div>
  );
}
