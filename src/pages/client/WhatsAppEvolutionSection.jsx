import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  PlusIcon,
  QrCodeIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-50";

function normalizeStatus(status) {
  const value = `${status || ""}`.toLowerCase();
  if (["connected", "open"].includes(value)) return "connected";
  if (["pending", "connecting", "qr", "qrcode", "waiting_qr"].includes(value)) return "pending";
  if (["error", "failed"].includes(value)) return "error";
  return "disconnected";
}

function getInstanceStatus(item) {
  return normalizeStatus(
    item?.status ||
    item?.connection_status ||
    ""
  );
}

function statusMeta(status) {
  const normalized = normalizeStatus(status);

  if (normalized === "connected") {
    return {
      label: "متصل",
      dot: "bg-emerald-500",
      badge: "bg-emerald-50 text-emerald-700 border-emerald-100",
    };
  }

  if (normalized === "pending") {
    return {
      label: "بانتظار QR",
      dot: "bg-amber-500",
      badge: "bg-amber-50 text-amber-700 border-amber-100",
    };
  }

  if (normalized === "error") {
    return {
      label: "خطأ",
      dot: "bg-rose-500",
      badge: "bg-rose-50 text-rose-700 border-rose-100",
    };
  }

  return {
    label: "غير متصل",
    dot: "bg-slate-400",
    badge: "bg-slate-50 text-slate-600 border-slate-100",
  };
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "-";
  }
}

export default function WhatsAppEvolutionSection({ clientId, integration, maxConnections = null, subscriptionActive = true }) {
  const { user } = useAuth();
  const [instances, setInstances] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [connectingId, setConnectingId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const pollingBusyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    instance_name: "",
  });

  useEffect(() => {
    if (!clientId) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;

    const hasPending = instances.some(
      (item) => getInstanceStatus(item) === "pending"
    );

    if (!hasPending) return;

    const intervalId = window.setInterval(async () => {
      if (pollingBusyRef.current) return;

      pollingBusyRef.current = true;
      try {
        await loadData({
          preserveFeedback: true,
          silent: true,
        });
      } finally {
        pollingBusyRef.current = false;
      }
    }, 2500);

    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, instances]);

  const summary = useMemo(() => {
    const connected = instances.filter((item) => getInstanceStatus(item) === "connected").length;
    const pending = instances.filter((item) => getInstanceStatus(item) === "pending").length;
    return { total: instances.length, connected, pending };
  }, [instances]);

  // Plan connection limit (plan_features.max_connections) — null/undefined
  // means unlimited. Server-side enforcement is authoritative
  // (api/create-whatsapp-instance.js); this only disables the UI early with
  // a clear reason instead of letting the request fail server-side first.
  const limitReached = maxConnections != null && instances.length >= maxConnections;
  const addDisabledReason = !subscriptionActive
    ? "اشتراكك غير نشط — لا يمكن إضافة أرقام جديدة حتى تجديد الاشتراك"
    : limitReached
    ? `وصلت للحد الأقصى المسموح (${maxConnections}) لأرقام واتساب ضمن خطتك`
    : null;

  // Canonical key only — n8n reads config.reply_mode exclusively; a legacy
  // config["Reply Mode"] fallback used to exist here but that key should
  // never be read or written anywhere in the app (see ClientIntegrations.jsx
  // handleSaveIntegration, which now also strips it on save).
  const integrationReplyMode =
    integration?.config?.reply_mode ||
    integration?.config?.mode ||
    "ai";

  async function loadData(options = {}) {
    const {
      preserveFeedback = false,
      silent = false,
    } = options;

    try {
      if (!silent) {
        setLoading(true);
      }

      if (!preserveFeedback) {
        setError("");
        setMessage("");
      }

      const { data: whatsappRows, error: whatsappError } = await supabase
        .from("client_whatsapp")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: true });

      if (whatsappError) throw whatsappError;

      const { data: serverRows, error: serverError } = await supabase
        .from("whatsapp_servers")
        .select("*")
        .order("priority", { ascending: true });

      if (serverError) throw serverError;

      const freshRows = whatsappRows || [];

      setInstances((previousRows) => {
        const newlyConnected = freshRows.find((fresh) => {
          const old = previousRows.find((row) => row.id === fresh.id);
          return (
            old &&
            getInstanceStatus(old) !== "connected" &&
            getInstanceStatus(fresh) === "connected"
          );
        });

        if (newlyConnected) {
          setMessage(
            `تم ربط ${newlyConnected.display_name || newlyConnected.instance_name || "رقم واتساب"} بنجاح.`
          );
        }

        return freshRows;
      });

      setServers(serverRows || []);
    } catch (err) {
      console.error(err);
      setError("فشل تحميل أرقام واتساب.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  async function pickServer() {
    const activeServers = (servers || [])
      .filter((server) => server.is_active !== false)
      .sort((a, b) => Number(a.priority || 999) - Number(b.priority || 999));

    for (const server of activeServers) {
      const maxInstances = Number(server.max_instances || server.max_clients || 0);

      const { count, error: countError } = await supabase
        .from("client_whatsapp")
        .select("id", { count: "exact", head: true })
        .eq("server_id", server.id);

      if (countError) throw countError;

      if (!maxInstances || Number(count || 0) < maxInstances) {
        return server;
      }
    }

    return null;
  }

  function openDrawer() {
    setError("");
    setMessage("");
    setForm({ instance_name: "" });
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

async function createNumber(e) {
  e.preventDefault();

  try {
    setCreating(true);
    setError("");
    setMessage("");

    const displayName = form.instance_name.trim();

    if (!displayName) {
      setError("يرجى إدخال اسم الرقم.");
      return;
    }

    const duplicate = instances.some(
      (item) =>
        `${item.display_name || ""}`.toLowerCase() ===
        displayName.toLowerCase()
    );

    if (duplicate) {
      setError("اسم الرقم مستخدم مسبقاً.");
      return;
    }


  const response = await fetch("/api/create-whatsapp-instance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "create_instance",
      client_id: clientId,
      display_name: displayName,
      actor_user_id: user?.id,
    }),
  });

    
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Failed");
    }

    setDrawerOpen(false);

    setMessage("تم إنشاء الرقم بنجاح.");

    await loadData();

  } catch (err) {
    console.error(err);
    setError("فشل إنشاء الرقم.");
  } finally {
    setCreating(false);
  }
}
  async function connectNumber(item) {
    try {
      setConnectingId(item.id);
      setError("");
      setMessage("");

      const response = await fetch("/api/create-whatsapp-instance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "connect_instance",
          client_id: clientId,
          whatsapp_id: item.id,
          instance_name: item.instance_name,
          actor_user_id: user?.id,
        }),
      });

      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }

      if (!response.ok) {
        throw new Error(
          result?.message ||
            result?.error ||
            result?.data?.message ||
            "فشل بدء ربط رقم واتساب."
        );
      }

      const responseRow =
        Array.isArray(result)
          ? result[0] || {}
          : Array.isArray(result?.data)
            ? result.data[0] || {}
            : result?.data || result || {};

      const qrCode =
        responseRow.qr_code ||
        responseRow.qrCode ||
        responseRow.base64 ||
        result.qr_code ||
        result.qrCode ||
        result.base64 ||
        "";

      if (qrCode) {
        setInstances((current) =>
          current.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  qr_code: qrCode,
                  status: "pending",
                }
              : row
          )
        );
      }

      setMessage(
        getInstanceStatus(responseRow) === "connected"
          ? "رقم واتساب متصل بالفعل."
          : "تم بدء عملية الربط. امسح رمز QR لإكمال الاتصال."
      );

      await new Promise((resolve) => window.setTimeout(resolve, 250));
      await loadData({ preserveFeedback: true });
    } catch (err) {
      console.error(err);
      setError("فشل ربط رقم واتساب.");
    } finally {
      setConnectingId(null);
    }
  }

  async function syncNumbers() {
    try {
      setSyncing(true);
      setError("");
      setMessage("");

      const response = await fetch("/api/create-whatsapp-instance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "sync_instances",
          client_id: clientId,
          actor_user_id: user?.id,
        }),
      });

      let result = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }

      if (!response.ok) {
        throw new Error(
          result?.message ||
            result?.error ||
            "فشل مزامنة أرقام واتساب."
        );
      }

      // Give n8n/Supabase a brief moment to finish all insert/update/delete operations.
      await new Promise((resolve) => window.setTimeout(resolve, 1200));

      await loadData({
        preserveFeedback: true,
        silent: true,
      });

      setMessage("تمت مزامنة أرقام واتساب مع Evolution بنجاح.");
    } catch (err) {
      console.error(err);
      setError("فشل مزامنة أرقام واتساب.");
    } finally {
      setSyncing(false);
    }
  }

async function deleteNumber(item) {
  if (!window.confirm(`هل تريد حذف ${item.display_name}؟`)) return;

  try {
    setError("");
    setMessage("");

    const response = await fetch("/api/create-whatsapp-instance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "delete_instance",
        client_id: clientId,
        whatsapp_id: item.id,
        instance_name: item.instance_name,
        actor_user_id: user?.id,
      }),
    });

    let result = {};

    try {
      result = await response.json();
    } catch {
      result = {};
    }

    if (!response.ok) {
      throw new Error(
        result?.message ||
        result?.error ||
        "فشل حذف رقم واتساب."
      );
    }

    // Remove the deleted card immediately from the UI.
    setInstances((current) =>
      current.filter((row) => row.id !== item.id)
    );

    setMessage("تم حذف الرقم من Evolution والبورتال بنجاح.");

    // Verify quietly after the backend delete settles.
    window.setTimeout(() => {
      loadData({
        preserveFeedback: true,
        silent: true,
      });
    }, 1500);
        
  } catch (err) {
    console.error(err);
    setError("فشل حذف رقم واتساب.");
  }
}

  function getServerName(serverId) {
    const server = servers.find((item) => item.id === serverId);
    return server?.name || "يُحدد تلقائياً";
  }

  return (
    <div className="mt-6 rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            <QrCodeIcon className="h-4 w-4" />
            WhatsApp Evolution
          </div>
          <h3 className="mt-3 text-lg font-bold text-slate-950">أرقام WhatsApp</h3>
          <p className="mt-1 text-sm text-slate-500">
            أضف أكثر من رقم واتساب حسب حدود خطتك، وسيتم اختيار السيرفر تلقائياً.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={syncNumbers}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ArrowPathIcon className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "جارٍ المزامنة..." : "تحديث"}
          </button>

          <button
            type="button"
            onClick={openDrawer}
            disabled={!!addDisabledReason}
            title={addDisabledReason || undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            إضافة رقم
          </button>
        </div>
      </div>

      {addDisabledReason && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          {addDisabledReason}
        </div>
      )}

      {(error || message) && (
        <div
          className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
            error
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">إجمالي الأرقام</p>
          <p className="mt-1 text-2xl font-bold text-slate-950">{summary.total}</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">متصلة</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600">{summary.connected}</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">بانتظار QR</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{summary.pending}</p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
          جارِ تحميل أرقام واتساب...
        </div>
      ) : instances.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-slate-500 shadow-sm">
            <QrCodeIcon className="h-6 w-6" />
          </div>
          <h4 className="mt-3 text-base font-bold text-slate-950">لا يوجد أرقام واتساب بعد</h4>
          <p className="mt-1 text-sm text-slate-500">اضغط إضافة رقم لإضافة أول رقم.</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {instances.map((item) => {
            const normalizedStatus = getInstanceStatus(item);
            const meta = statusMeta(normalizedStatus);

            return (
              <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="truncate text-base font-bold text-slate-950">
                        {item.display_name || item.instance_name || "رقم WhatsApp"}
                      </h4>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${meta.badge}`}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-500" dir="ltr">
                      {item.phone || "سيظهر رقم الهاتف بعد مسح رمز QR"}
                    </p>
                    <p className="mt-1 truncate text-xs text-slate-400" dir="ltr" title={item.instance_name || ""}>
                      {item.instance_name || "-"}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {normalizedStatus !== "connected" && (
                      <button
                        type="button"
                        onClick={() => connectNumber(item)}
                        disabled={connectingId === item.id || !subscriptionActive}
                        title={!subscriptionActive ? "اشتراكك غير نشط — لا يمكن ربط الأرقام حتى تجديد الاشتراك" : undefined}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {connectingId === item.id ? "جارٍ الربط..." : "ربط"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteNumber(item)}
                      className="inline-flex items-center gap-1 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-100"
                    >
                      <TrashIcon className="h-4 w-4" />
                      حذف
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_380px]">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">رقم الهاتف</p>
                      <p className="mt-1 truncate text-sm font-bold text-slate-900" dir="ltr" title={item.phone || ""}>
                        {item.phone || "غير متصل بعد"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">السيرفر</p>
                      <p className="mt-1 truncate text-sm font-bold text-slate-900">
                        {getServerName(item.server_id)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">الحالة</p>
                      <p className="mt-1 text-sm font-bold text-slate-900">
                        {item.status || item.connection_status || "-"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">اسم Instance</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-700" dir="ltr" title={item.instance_name || ""}>
                        {item.instance_name || "-"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">معرّف Instance</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-700" dir="ltr" title={item.instance_id || ""}>
                        {item.instance_id || "-"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Channel Key</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-700" dir="ltr" title={item.channel_key || ""}>
                        {item.channel_key || "-"}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">تاريخ الإنشاء</p>
                      <p className="mt-1 text-xs font-semibold text-slate-700">
                        {formatDate(item.created_at)}
                      </p>
                    </div>

                  </div>

                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3 text-center">
                       {normalizedStatus === "pending" ? (
                          <>
                            <div className="flex min-h-[360px] items-center justify-center rounded-xl bg-white p-4">
                              {item.qr_code ? (
                                <img
                                  key={`${item.id}-${item.updated_at || item.qr_code?.slice(-24) || "qr"}`}
                                  src={item.qr_code}
                                  alt="WhatsApp QR"
                                  className="h-[320px] w-[320px] max-w-full object-contain"
                                  style={{ imageRendering: "pixelated" }}
                                />
                              ) : (
                                <span className="text-xs font-semibold text-slate-400">
                                  سيظهر رمز QR هنا
                                </span>
                              )}
                            </div>
                            <p className="mt-2 text-xs text-slate-500">بانتظار مسح رمز QR</p>
                          </>
                        ) : normalizedStatus === "connected" ? (
                      <div className="grid min-h-[360px] place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                        <div>
                          <CheckCircleIcon className="mx-auto h-8 w-8" />
                          <p className="mt-2 text-xs font-bold">متصل</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-[360px] items-center justify-center rounded-xl bg-white text-xs font-semibold text-slate-400">
                        لا يوجد QR بعد
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={closeDrawer}>
          <form
            onSubmit={createNumber}
            className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-600">WhatsApp</p>
                <h3 className="mt-1 text-2xl font-bold text-slate-950">إضافة رقم</h3>
                <p className="mt-1 text-sm text-slate-500">أدخل اسم الرقم، وسيتم اختيار السيرفر وإنشاء الـ Instance تلقائياً.</p>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">اسم الرقم</span>
                <input
                  className={inputClass}
                  value={form.instance_name}
                  onChange={(event) => setForm((prev) => ({ ...prev, instance_name: event.target.value }))}
                  placeholder="استقبال / مبيعات / دعم"
                />
              </label>

              <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-xs leading-6 text-emerald-800">
                السيرفر، API Key، Webhook، Channel Key، والـ QR سيتم إدارتها تلقائياً من AutoResponder.
                وضع الرد الحالي للتكامل هو: <strong>{integrationReplyMode}</strong>.
              </div>

              <button
                type="submit"
                disabled={creating}
                className="h-12 w-full rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
              >
                {creating ? "جارٍ الإنشاء..." : "إنشاء الرقم"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
