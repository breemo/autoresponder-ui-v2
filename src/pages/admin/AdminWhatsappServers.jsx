import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass =
  "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function AdminWhatsappServers() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const [msg, setMsg] = useState("");

  const [form, setForm] = useState({
    name: "",
    base_url: "",
    api_key: "",
    priority: 1,
    max_clients: "",
    is_active: true,
  });

  useEffect(() => {
    fetchServers();
  }, []);

  async function fetchServers() {
    setLoading(true);

    const { data, error } = await supabase
      .from("whatsapp_servers")
      .select("*")
      .order("priority", { ascending: true });

    if (error) {
      console.error(error);
    } else {
      setServers(data || []);
    }

    setLoading(false);
  }

  function resetForm() {
    setEditingId(null);

    setForm({
      name: "",
      base_url: "",
      api_key: "",
      priority: 1,
      max_clients: "",
      is_active: true,
    });

    setMsg("");
  }

  function openCreate() {
    resetForm();
    setDrawerOpen(true);
  }

  function startEdit(server) {
    setEditingId(server.id);

    setForm({
      name: server.name || "",
      base_url: server.base_url || "",
      api_key: server.api_key || "",
      priority: server.priority || 1,
      max_clients: server.max_clients || "",
      is_active: server.is_active,
    });

    setDrawerOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();

    setMsg("");

    const payload = {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      priority: Number(form.priority),
      max_clients: form.max_clients ? Number(form.max_clients) : null,
      is_active: form.is_active,
    };

    let error;

    if (editingId) {
      ({ error } = await supabase
        .from("whatsapp_servers")
        .update(payload)
        .eq("id", editingId));
    } else {
      ({ error } = await supabase
        .from("whatsapp_servers")
        .insert([payload]));
    }

    if (error) {
      console.error(error);
      setMsg("حدث خطأ أثناء الحفظ");
      return;
    }

    setDrawerOpen(false);
    resetForm();
    fetchServers();

    setMsg(
      editingId
        ? "تم تحديث السيرفر بنجاح"
        : "تمت إضافة السيرفر بنجاح"
    );
  }

  async function deleteServer(id) {
    if (!window.confirm("هل تريد حذف هذا السيرفر؟")) return;

    const { error } = await supabase
      .from("whatsapp_servers")
      .delete()
      .eq("id", id);

    if (error) {
      setMsg("فشل حذف السيرفر");
      return;
    }

    fetchServers();

    setMsg("تم حذف السيرفر");
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">
            WHATSAPP
          </p>

          <h2 className="mt-1 text-2xl font-black text-slate-950">
            WhatsApp Connection Servers
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            إدارة سيرفرات Evolution API المستخدمة لربط العملاء.
          </p>
        </div>

        <button
          onClick={() => {
              alert("clicked");
              openCreate();
            }}
          className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700"
        >
          + Add Server
        </button>
      </div>

      {msg && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">إجمالي السيرفرات</p>
          <p className="mt-2 text-3xl font-black">{servers.length}</p>
        </div>

        <div className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">السيرفرات النشطة</p>
          <p className="mt-2 text-3xl font-black text-emerald-600">
            {servers.filter((s) => s.is_active).length}
          </p>
        </div>

        <div className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">السيرفرات المعطلة</p>
          <p className="mt-2 text-3xl font-black text-red-600">
            {servers.filter((s) => !s.is_active).length}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl bg-white p-10 text-center text-slate-500">
          جارِ التحميل...
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {servers.map((server) => (
            <div key={server.id} className={`${cardClass} overflow-hidden`}>
              <div className="p-6">

                <div className="mb-4 flex items-start justify-between">

                  <div>
                    <h3 className="text-lg font-black text-slate-900">
                      {server.name}
                    </h3>

                    <p className="mt-1 text-xs text-slate-500">
                      {server.base_url}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${
                      server.is_active
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {server.is_active ? "Active" : "Disabled"}
                  </span>

                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">

                  <div>
                    <p className="text-slate-500">
                      Priority
                    </p>

                    <p className="font-black">
                      {server.priority}
                    </p>
                  </div>

                  <div>
                    <p className="text-slate-500">
                      Max Clients
                    </p>

                    <p className="font-black">
                      {server.max_clients || "-"}
                    </p>
                  </div>

                </div>

              </div>

              <div className="flex gap-2 border-t border-slate-100 p-4">

                <button
                  onClick={() => startEdit(server)}
                  className="flex-1 rounded-2xl border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50"
                >
                  تعديل
                </button>

                <button
                  onClick={() => deleteServer(server.id)}
                  className="rounded-2xl bg-red-50 px-4 py-2 text-xs font-bold text-red-600 hover:bg-red-100"
                >
                  حذف
                </button>

              </div>

            </div>
          ))}
        </div>
      )}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/40"
          onClick={() => setDrawerOpen(false)}
        >
          <form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl"
          >
            <div className="mb-6 flex items-start justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">
                  SERVER
                </p>

                <h3 className="mt-1 text-2xl font-black text-slate-950">
                  {editingId ? "تعديل السيرفر" : "إضافة سيرفر"}
                </h3>
              </div>

              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                إغلاق
              </button>
            </div>

            <div className="space-y-4">

              <div>
                <label className="mb-1 block text-sm font-bold">
                  اسم السيرفر
                </label>

                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">
                  Base URL
                </label>

                <input
                  className={inputClass}
                  value={form.base_url}
                  onChange={(e) =>
                    setForm({ ...form, base_url: e.target.value })
                  }
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">
                  API Key
                </label>

                <input
                  className={inputClass}
                  value={form.api_key}
                  onChange={(e) =>
                    setForm({ ...form, api_key: e.target.value })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-3">

                <div>
                  <label className="mb-1 block text-sm font-bold">
                    Priority
                  </label>

                  <input
                    type="number"
                    className={inputClass}
                    value={form.priority}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        priority: e.target.value,
                      })
                    }
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-bold">
                    Max Clients
                  </label>

                  <input
                    type="number"
                    className={inputClass}
                    value={form.max_clients}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_clients: e.target.value,
                      })
                    }
                  />
                </div>

              </div>

              <label className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4">

                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      is_active: e.target.checked,
                    })
                  }
                />

                <span className="font-bold">
                  السيرفر فعال
                </span>

              </label>

              <button
                type="submit"
                className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700"
              >
                {editingId ? "تحديث السيرفر" : "إضافة السيرفر"}
              </button>

            </div>
          </form>
        </div>
      )}
    </div>
  );
}


      
