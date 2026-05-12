import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import Loader from "../components/Loader";

export default function AutoReplies() {
  const [autoReplies, setAutoReplies] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    client_id: "",
    trigger_text: "",
    reply_text: "",
  });
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    fetchInitial();
  }, []);

  async function fetchInitial() {
    try {
      setLoading(true);

      const [{ data: clientsData, error: clientsError }, { data: repliesData, error: repliesError }] =
        await Promise.all([
          supabase.from("clients").select("id,business_name").order("business_name"),
          supabase
            .from("auto_replies")
            .select("id,client_id,trigger_text,reply_text,is_active,created_at,clients(business_name)")
            .order("created_at", { ascending: false }),
        ]);

      if (clientsError) throw clientsError;
      if (repliesError) throw repliesError;

      setClients(clientsData || []);
      setAutoReplies(repliesData || []);
    } catch (err) {
      console.error("خطأ في جلب الردود التلقائية:", err.message);
      setError("حدث خطأ أثناء تحميل البيانات.");
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setForm({ client_id: "", trigger_text: "", reply_text: "" });
    setEditingId(null);
    setError("");
  }

  function startEdit(r) {
    setForm({
      client_id: r.client_id || "",
      trigger_text: r.trigger_text || "",
      reply_text: r.reply_text || "",
    });
    setEditingId(r.id);
  }

  async function handleSave(e) {
    e.preventDefault();

    if (!form.client_id) {
      setError("يرجى اختيار عميل.");
      return;
    }
    if (!form.trigger_text.trim()) {
      setError("نص التريجر مطلوب.");
      return;
    }
    if (!form.reply_text.trim()) {
      setError("نص الرد مطلوب.");
      return;
    }

    try {
      setSaving(true);
      setError("");

      if (editingId) {
        const { error } = await supabase
          .from("auto_replies")
          .update({
            client_id: form.client_id,
            trigger_text: form.trigger_text.trim(),
            reply_text: form.reply_text.trim(),
          })
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("auto_replies").insert([
          {
            client_id: form.client_id,
            trigger_text: form.trigger_text.trim(),
            reply_text: form.reply_text.trim(),
            is_active: true,
          },
        ]);
        if (error) throw error;
      }

      await fetchInitial();
      resetForm();
    } catch (err) {
      console.error("خطأ في حفظ الرد:", err.message);
      setError("تعذر حفظ الرد التلقائي.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(r) {
    try {
      const { error } = await supabase
        .from("auto_replies")
        .update({ is_active: !r.is_active })
        .eq("id", r.id);
      if (error) throw error;

      setAutoReplies((prev) =>
        prev.map((x) =>
          x.id === r.id ? { ...x, is_active: !r.is_active } : x
        )
      );
    } catch (err) {
      console.error("خطأ في تغيير حالة الرد:", err.message);
      alert("تعذر تغيير حالة الرد.");
    }
  }

  async function handleDelete(r) {
    if (!window.confirm(`هل أنت متأكد من حذف الرد "${r.trigger_text}"؟`))
      return;

    try {
      const { error } = await supabase
        .from("auto_replies")
        .delete()
        .eq("id", r.id);
      if (error) throw error;

      setAutoReplies((prev) => prev.filter((x) => x.id !== r.id));
    } catch (err) {
      console.error("خطأ في حذف الرد:", err.message);
      alert("تعذر حذف الرد.");
    }
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return autoReplies;

    return autoReplies.filter((r) => {
      const name = r.clients?.business_name?.toLowerCase() || "";
      const trig = r.trigger_text?.toLowerCase() || "";
      const reply = r.reply_text?.toLowerCase() || "";
      return name.includes(term) || trig.includes(term) || reply.includes(term);
    });
  }, [autoReplies, search]);

  if (loading) return <Loader message="جارِ تحميل الردود التلقائية..." />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">الردود التلقائية</h1>
      <p className="text-gray-500 mb-6">
        إدارة التريجرز والردود التلقائية لكل عميل.
      </p>

      {/* فورم */}
      <div className="bg-white rounded-xl shadow p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">
          {editingId ? "تعديل رد تلقائي" : "إضافة رد تلقائي"}
        </h2>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
            {error}
          </div>
        )}

        <form
          className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start"
          onSubmit={handleSave}
        >
          <div>
            <label className="block text-sm mb-1">العميل</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.client_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, client_id: e.target.value }))
              }
            >
              <option value="">اختر العميل</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.business_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm mb-1">نص التريجر</label>
            <input
              type="text"
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.trigger_text}
              onChange={(e) =>
                setForm((f) => ({ ...f, trigger_text: e.target.value }))
              }
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm mb-1">نص الرد</label>
            <textarea
              className="w-full border rounded-lg px-3 py-2 text-sm h-20 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.reply_text}
              onChange={(e) =>
                setForm((f) => ({ ...f, reply_text: e.target.value }))
              }
            />
          </div>

          <div className="flex gap-2 md:col-span-4">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm py-2 px-4 rounded-lg disabled:opacity-60"
            >
              {saving
                ? "جارِ الحفظ..."
                : editingId
                ? "تحديث الرد"
                : "إضافة الرد"}
            </button>

            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-sm border rounded-lg text-gray-600 hover:bg-gray-50"
              >
                إلغاء التعديل
              </button>
            )}
          </div>
        </form>
      </div>

      {/* جدول */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold">قائمة الردود</h2>
          <input
            type="text"
            placeholder="بحث باسم العميل أو التريجر أو الرد..."
            className="border rounded-lg px-3 py-2 text-sm w-full md:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400">لا توجد ردود تلقائية بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-2 text-right">العميل</th>
                  <th className="py-2 text-right">التريجر</th>
                  <th className="py-2 text-right">الرد</th>
                  <th className="py-2 text-right">الحالة</th>
                  <th className="py-2 text-right">التاريخ</th>
                  <th className="py-2 text-right">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2">
                      {r.clients?.business_name || "بدون عميل"}
                    </td>
                    <td className="py-2">{r.trigger_text}</td>
                    <td className="py-2 max-w-md truncate">{r.reply_text}</td>
                    <td className="py-2">
                      {r.is_active ? (
                        <span className="text-green-600 font-medium">
                          مفعّل
                        </span>
                      ) : (
                        <span className="text-red-500 font-medium">
                          معطّل
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-gray-500">
                      {r.created_at
                        ? new Date(r.created_at).toLocaleString("ar-EG")
                        : "-"}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => toggleActive(r)}
                          className={`px-2 py-1 rounded text-xs text-white ${
                            r.is_active
                              ? "bg-green-500 hover:bg-green-600"
                              : "bg-gray-500 hover:bg-gray-600"
                          }`}
                        >
                          {r.is_active ? "تعطيل" : "تفعيل"}
                        </button>
                        <button
                          onClick={() => startEdit(r)}
                          className="px-2 py-1 rounded text-xs bg-yellow-500 hover:bg-yellow-600 text-white"
                        >
                          تعديل
                        </button>
                        <button
                          onClick={() => handleDelete(r)}
                          className="px-2 py-1 rounded text-xs bg-red-500 hover:bg-red-600 text-white"
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
