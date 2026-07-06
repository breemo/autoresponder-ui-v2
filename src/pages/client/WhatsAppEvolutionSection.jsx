import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  PlusIcon,
  QrCodeIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-50";

function normalizeStatus(status) {
  const value = `${status || ""}`.toLowerCase();
  if (["connected", "open"].includes(value)) return "connected";
  if (["pending", "connecting", "qr", "qrcode"].includes(value)) return "pending";
  if (["error", "failed"].includes(value)) return "error";
  return "disconnected";
}

function statusMeta(status) {
  const normalized = normalizeStatus(status);

  if (normalized === "connected") {
    return {
      label: "Connected",
      dot: "bg-emerald-500",
      badge: "bg-emerald-50 text-emerald-700 border-emerald-100",
    };
  }

  if (normalized === "pending") {
    return {
      label: "Waiting QR",
      dot: "bg-amber-500",
      badge: "bg-amber-50 text-amber-700 border-amber-100",
    };
  }

  if (normalized === "error") {
    return {
      label: "Error",
      dot: "bg-rose-500",
      badge: "bg-rose-50 text-rose-700 border-rose-100",
    };
  }

  return {
    label: "Not Connected",
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

export default function WhatsAppEvolutionSection({ clientId, integration }) {
  const [instances, setInstances] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    instance_name: "",
    reply_mode: "ai",
  });

  useEffect(() => {
    if (!clientId) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const summary = useMemo(() => {
    const connected = instances.filter((item) => normalizeStatus(item.status) === "connected").length;
    const pending = instances.filter((item) => normalizeStatus(item.status) === "pending").length;
    return { total: instances.length, connected, pending };
  }, [instances]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");
      setMessage("");

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

      setInstances(whatsappRows || []);
      setServers(serverRows || []);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل تحميل أرقام واتساب.");
    } finally {
      setLoading(false);
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
    setForm({ instance_name: "", reply_mode: "ai" });
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
        `${item.display_name || item.instance_name || ""}`.toLowerCase() ===
        displayName.toLowerCase()
    );

    if (duplicate) {
      setError("اسم الرقم مستخدم مسبقاً لهذا العميل.");
      return;
    }

    const response = await fetch(
      "https://n8n-production-fcd4.up.railway.app/webhook/evolution-gateway",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "create_instance",
          client_id: clientId,
          display_name: displayName,
          reply_mode: form.reply_mode,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Failed to create WhatsApp number");
    }

    setDrawerOpen(false);

    setMessage(
      "تم إنشاء الرقم بنجاح، ويتم الآن تجهيز QR Code..."
    );

    await loadData();
  } catch (err) {
    console.error(err);
    setError(err.message || "فشل إنشاء الرقم.");
  } finally {
    setCreating(false);
  }
}

  async function deleteNumber(item) {
    if (!window.confirm(`هل تريد حذف ${item.instance_name}؟`)) return;

    try {
      setError("");
      setMessage("");

      const { error: deleteError } = await supabase
        .from("client_whatsapp")
        .delete()
        .eq("id", item.id);

      if (deleteError) throw deleteError;

      setMessage("تم حذف الرقم بنجاح.");
      await loadData();
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل حذف الرقم.");
    }
  }

  function getServerName(serverId) {
    const server = servers.find((item) => item.id === serverId);
    return server?.name || "Auto assigned";
  }

  return (
    <div className="mt-6 rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            <QrCodeIcon className="h-4 w-4" />
            WhatsApp Evolution
          </div>
          <h3 className="mt-3 text-lg font-bold text-slate-950">WhatsApp Numbers</h3>
          <p className="mt-1 text-sm text-slate-500">
            أضف أكثر من رقم واتساب حسب حدود خطتك، وسيتم اختيار السيرفر تلقائياً.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <ArrowPathIcon className="h-4 w-4" />
            Refresh
          </button>

          <button
            type="button"
            onClick={openDrawer}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            <PlusIcon className="h-4 w-4" />
            Add Number
          </button>
        </div>
      </div>

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
          <p className="text-xs text-slate-500">Total numbers</p>
          <p className="mt-1 text-2xl font-bold text-slate-950">{summary.total}</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">Connected</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600">{summary.connected}</p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-xs text-slate-500">Waiting QR</p>
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
          <p className="mt-1 text-sm text-slate-500">اضغط Add Number لإضافة أول رقم.</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {instances.map((item) => {
            const meta = statusMeta(item.status);
            const normalizedStatus = normalizeStatus(item.status);

            return (
              <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="truncate text-base font-bold text-slate-950">
                        {item.instance_name || "WhatsApp Number"}
                      </h4>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${meta.badge}`}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {item.phone || "Phone number will appear after scanning QR"}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteNumber(item)}
                      className="inline-flex items-center gap-1 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-100"
                    >
                      <TrashIcon className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_220px]">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Reply mode</p>
                      <p className="mt-1 text-sm font-bold text-slate-900">{item.reply_mode || "ai"}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Server</p>
                      <p className="mt-1 truncate text-sm font-bold text-slate-900">{getServerName(item.server_id)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Instance ID</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-700" dir="ltr">
                        {item.instance_id || "-"}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Created at</p>
                      <p className="mt-1 text-xs font-semibold text-slate-700">{formatDate(item.created_at)}</p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3 text-center">
                    {normalizedStatus === "pending" ? (
                      <>
                        <div className="flex h-36 items-center justify-center rounded-xl bg-white text-xs font-semibold text-slate-400">
                          QR will appear here
                        </div>
                        <p className="mt-2 text-xs text-slate-500">Waiting for QR scan</p>
                      </>
                    ) : normalizedStatus === "connected" ? (
                      <div className="grid h-36 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                        <div>
                          <CheckCircleIcon className="mx-auto h-8 w-8" />
                          <p className="mt-2 text-xs font-bold">Connected</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-36 items-center justify-center rounded-xl bg-white text-xs font-semibold text-slate-400">
                        No QR yet
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
                <h3 className="mt-1 text-2xl font-bold text-slate-950">Add Number</h3>
                <p className="mt-1 text-sm text-slate-500">أدخل اسم الرقم وطريقة الرد، وسيتم اختيار السيرفر تلقائياً.</p>
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
                <span className="mb-1.5 block text-xs font-bold text-slate-600">Instance Name</span>
                <input
                  className={inputClass}
                  value={form.instance_name}
                  onChange={(event) => setForm((prev) => ({ ...prev, instance_name: event.target.value }))}
                  placeholder="Reception / Sales / Support"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold text-slate-600">Reply Mode</span>
                <select
                  className={inputClass}
                  value={form.reply_mode}
                  onChange={(event) => setForm((prev) => ({ ...prev, reply_mode: event.target.value }))}
                >
                  <option value="ai">AI</option>
                  <option value="auto_reply">Auto Reply</option>
                  <option value="manual">Manual</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>

              <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-xs leading-6 text-emerald-800">
                السيرفر، API Key، Webhook، والـ QR سيتم إدارتها تلقائياً من Jawab AI. العميل لا يحتاج لإدخال أي إعدادات تقنية.
              </div>

              <button
                type="submit"
                disabled={creating}
                className="h-12 w-full rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
              >
                {creating ? "Creating..." : "Create Number"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
