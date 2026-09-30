import React, { useEffect, useMemo, useState } from "react";
import { PencilSquareIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { getReplyModeLabel, getReplyModeSelectOptions, DEFAULT_REPLY_MODE } from "../../lib/replyMode.js";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const EMPTY_FORM = {
  display_name: "",
  page_id: "",
  channel_key: "",
  page_access_token: "",
  reply_mode: DEFAULT_REPLY_MODE,
  is_active: true,
};

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "-";
  }
}

// Multi-Account Stage 2B — Facebook Page accounts. Deliberately parallel
// in responsibility to WhatsAppEvolutionSection.jsx (same list-of-
// accounts-under-one-channel pattern, same drawer-based add flow), but
// this component owns its own full data cycle end to end — including the
// plan limit (plans.facebook_accounts_limit, returned by the list
// response itself) — because client_facebook has RLS enabled with zero
// browser policies (Stage 1): every read/write here goes through
// /api/client-integrations?resource=facebook (service-role Supabase server-side), never a
// direct supabase.from("client_facebook") call. This is the one required
// architectural difference from WhatsAppEvolutionSection.jsx, which does
// still read client_whatsapp directly from the browser because that
// table has no RLS restricting it.
//
// Legacy compatibility: this component is entirely additive. It renders
// ALONGSIDE whatever ClientIntegrations.jsx already renders for the
// existing (legacy, client_feature_integrations-backed) Facebook
// integration — see the embedding note in ClientIntegrations.jsx for
// exactly how the two coexist during this dual-state period. An existing
// Facebook client whose client_facebook table is still empty simply sees
// an empty "no accounts yet" state here, with their legacy integration's
// existing config/fields still fully visible and editable in the panel
// above, completely unaffected.
export default function FacebookAccountsSection({ clientId, actorUserId, subscriptionActive = true }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState([]);
  const [planLimit, setPlanLimit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null); // null = create mode
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (!clientId) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/client-integrations?resource=facebook&actor_user_id=${encodeURIComponent(actorUserId || "")}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل في تحميل حسابات فيسبوك");
      }

      setAccounts(data.accounts || []);
      setPlanLimit(data.plan_limit ?? null);
    } catch (err) {
      console.error(err);
      setError("فشل في تحميل حسابات فيسبوك");
    } finally {
      setLoading(false);
    }
  }

  const limitReached = planLimit != null && accounts.length >= planLimit;
  const addDisabledReason = !subscriptionActive
    ? "اشتراكك غير نشط — لا يمكن إضافة صفحات جديدة"
    : limitReached
    ? `وصلت للحد الأقصى المسموح لحسابات فيسبوك ضمن خطتك (${planLimit})`
    : null;

  const usageLabel = useMemo(() => {
    if (planLimit == null) return `${accounts.length} حسابات · غير محدود`;
    return `${accounts.length} / ${planLimit}`;
  }, [accounts.length, planLimit]);

  function openCreateDrawer() {
    setError("");
    setMessage("");
    setEditingAccount(null);
    setForm(EMPTY_FORM);
    setDrawerOpen(true);
  }

  function openEditDrawer(account) {
    setError("");
    setMessage("");
    setEditingAccount(account);
    setForm({
      display_name: account.display_name || "",
      page_id: account.page_id || "",
      channel_key: account.channel_key || "",
      // Never pre-populated — the server never returns the stored token.
      // This field is purely an optional "replace it" input.
      page_access_token: "",
      reply_mode: account.reply_mode || DEFAULT_REPLY_MODE,
      is_active: account.is_active !== false,
    });
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  async function callApi(action, payload = {}) {
    const response = await fetch("/api/client-integrations?resource=facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actor_user_id: actorUserId, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.message || "فشلت العملية");
    }
    return data;
  }

  async function handleSubmit(e) {
    e.preventDefault();

    const displayName = form.display_name.trim();
    if (!displayName) {
      setError("يرجى إدخال اسم الصفحة");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const basePayload = {
        display_name: displayName,
        page_id: form.page_id.trim(),
        channel_key: form.channel_key.trim(),
        reply_mode: form.reply_mode,
        is_active: form.is_active,
      };
      // Only ever sent when the admin actually typed a replacement — an
      // empty field here must never overwrite an existing stored token.
      if (form.page_access_token.trim()) {
        basePayload.page_access_token = form.page_access_token.trim();
      }

      if (editingAccount) {
        const { account } = await callApi("update", { id: editingAccount.id, ...basePayload });
        setAccounts((prev) => prev.map((a) => (a.id === account.id ? account : a)));
        setMessage("تم تحديث صفحة فيسبوك بنجاح");
      } else {
        const { account } = await callApi("create", basePayload);
        setAccounts((prev) => [...prev, account]);
        setMessage("تمت إضافة صفحة فيسبوك بنجاح");
      }

      setDrawerOpen(false);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشلت العملية");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(account) {
    if (togglingId) return;

    setTogglingId(account.id);
    setError("");
    setMessage("");

    try {
      const { account: updated } = await callApi("set_active", { id: account.id, is_active: !account.is_active });
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل تحديث حالة التفعيل");
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteAccount(account) {
    if (deletingId || !window.confirm(`هل تريد حذف ${account.display_name}؟`)) return;

    setDeletingId(account.id);
    setError("");
    setMessage("");

    try {
      await callApi("delete", { id: account.id });
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
      setMessage("تم حذف صفحة فيسبوك بنجاح");
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في حذف صفحة فيسبوك");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">
            Facebook · Multi-Account
          </div>
          <h3 className="mt-3 text-lg font-bold text-slate-950">صفحات فيسبوك (تجريبي)</h3>
          <p className="mt-1 text-sm text-slate-500">إدارة صفحات فيسبوك المرتبطة بحسابك — كل صفحة بإعداداتها الخاصة.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">{usageLabel}</span>
          <button
            type="button"
            onClick={openCreateDrawer}
            disabled={!!addDisabledReason}
            title={addDisabledReason || undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            إضافة صفحة فيسبوك
          </button>
        </div>
      </div>

      {/* Runtime-readiness disclosure — pre-migration audit finding, fixed
          here. Always visible, not dismissible: client_facebook has no
          current runtime path to n8n at all (confirmed by Web/API
          inspection — n8n still resolves Facebook exclusively through
          client_feature_integrations, the legacy panel above this
          section). Without this notice, a client completing "Add
          Facebook Page" here would get a fully successful-looking
          response with zero actual effect on their Facebook messaging —
          a materially misleading UX. Deliberately does NOT say
          "Connected" or imply any live status; connection_status stays
          NULL end to end (see the neutral "غير متحقق" badge on each
          account card below) — this banner is the only place runtime
          state is discussed, and it says the honest thing plainly. */}
      <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm font-bold text-amber-900">قيد الربط مع التشغيل الفعلي (Pending runtime integration)</p>
        <p className="mt-1 text-xs leading-5 text-amber-800">
          الحسابات المضافة هنا إعداد تجريبي فقط حاليًا — Auto Responder لا يستقبل ولا يرسل رسائل عبرها بعد. الإعداد
          الفعّال حاليًا لفيسبوك هو القسم أعلاه (الإعدادات العامة). سيتم تفعيل هذا القسم عند اكتمال ربطه بالتشغيل
          الفعلي في مرحلة لاحقة.
        </p>
      </div>

      {addDisabledReason && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          {addDisabledReason}
        </div>
      )}

      {(error || message) && (
        <div
          className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
            error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error || message}
        </div>
      )}

      {loading ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
          جارِ تحميل صفحات فيسبوك...
        </div>
      ) : accounts.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
          <h4 className="text-base font-bold text-slate-950">لا توجد صفحات فيسبوك مضافة بعد</h4>
          <p className="mt-1 text-sm text-slate-500">
            إذا كان لديك تكامل فيسبوك قديم، سيبقى يعمل كما هو أعلاه — هذا القسم فقط لإضافة صفحات جديدة بنظام الحسابات المتعددة.
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {accounts.map((account) => (
            <div key={account.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-base font-bold text-slate-950">{account.display_name}</h4>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-bold ${
                        account.is_active
                          ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-slate-100 text-slate-500"
                      }`}
                    >
                      {account.is_active ? "مفعّلة" : "معطّلة"}
                    </span>
                    {/* No fake "Connected" value is ever rendered — a null
                        connection_status (the case for every account
                        today, since nothing writes a real health signal
                        yet) shows a neutral, honest placeholder instead. */}
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-500">
                      {account.connection_status || "غير متحقق"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-500" dir="ltr">
                    Page ID: {account.page_id || "-"}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-400" dir="ltr" title={account.channel_key || ""}>
                    Channel Key: {account.channel_key || "-"}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleActive(account)}
                    disabled={togglingId === account.id}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      account.is_active
                        ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                        : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    }`}
                  >
                    {togglingId === account.id ? "..." : account.is_active ? "تعطيل" : "تفعيل"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditDrawer(account)}
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                    تعديل
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteAccount(account)}
                    disabled={deletingId === account.id}
                    className="inline-flex items-center gap-1 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <TrashIcon className="h-4 w-4" />
                    حذف
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-xs text-slate-500">وضع الرد</p>
                  <p className="mt-1 text-sm font-bold text-slate-900">{getReplyModeLabel(account.reply_mode, t)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-xs text-slate-500">Access Token</p>
                  <p className="mt-1 text-sm font-bold text-slate-900">
                    {account.has_page_access_token ? "تم إعداد التوكن" : "غير محدد"}
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-xs text-slate-500">تاريخ الإضافة</p>
                  <p className="mt-1 text-xs font-semibold text-slate-700">{formatDate(account.created_at)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={closeDrawer}>
          <form
            onSubmit={handleSubmit}
            className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">Facebook</p>
                <h3 className="mt-1 text-2xl font-bold text-slate-950">
                  {editingAccount ? "تعديل صفحة فيسبوك" : "إضافة صفحة فيسبوك"}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="إغلاق"
                className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">اسم الصفحة</span>
                <input
                  className={inputClass}
                  value={form.display_name}
                  onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                  placeholder="مثال: صفحة المبيعات"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">Page ID</span>
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.page_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, page_id: e.target.value }))}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">Channel Key</span>
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.channel_key}
                  onChange={(e) => setForm((prev) => ({ ...prev, channel_key: e.target.value }))}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">
                  Page Access Token
                  {editingAccount?.has_page_access_token && (
                    <span className="ms-2 font-normal text-emerald-600">(تم إعداد التوكن حاليًا)</span>
                  )}
                </span>
                <input
                  className={inputClass}
                  dir="ltr"
                  type="password"
                  value={form.page_access_token}
                  onChange={(e) => setForm((prev) => ({ ...prev, page_access_token: e.target.value }))}
                  placeholder={editingAccount ? "اتركه فارغًا للاحتفاظ بالتوكن الحالي" : ""}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">وضع الرد</span>
                <select
                  className={inputClass}
                  value={form.reply_mode}
                  onChange={(e) => setForm((prev) => ({ ...prev, reply_mode: e.target.value }))}
                >
                  {getReplyModeSelectOptions(form.reply_mode, t).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4 text-sm font-bold">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                />
                مفعّلة
              </label>

              <button
                type="submit"
                disabled={saving}
                className="h-12 w-full rounded-2xl bg-indigo-600 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              >
                {saving ? "جارِ الحفظ..." : editingAccount ? "حفظ التعديلات" : "إضافة الصفحة"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
