// src/pages/client/ClientAutoReplies.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

export default function ClientAutoReplies() {
  const { user } = useAuth();

  // client_id الصحيح
  const [clientId, setClientId] = useState(null);

  const [replies, setReplies] = useState([]);
  const [autoLimit, setAutoLimit] = useState(0);
  const [repliesCount, setRepliesCount] = useState(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    id: null,
    trigger_text: "",
    reply_text: "",
    is_active: true,
  });

  // -------------------------------------------
  // 1) جلب client_id بشكل مضمون 100%
  // -------------------------------------------
  useEffect(() => {
    async function loadClientId() {
      if (!user) return;

      // إذا موجود جاهز من الـ Auth
      if (user.client_id) {
        setClientId(user.client_id);
        return;
      }

      // جلب id عبر email
      const { data, error } = await supabase
        .from("clients")
        .select("id")
        .eq("email", user.email)
        .single();

      if (data?.id) setClientId(data.id);
    }

    loadClientId();
  }, [user]);

  // -------------------------------------------
  // 2) Load plan limit + auto replies
  // -------------------------------------------
  useEffect(() => {
    if (!clientId) return;

    async function loadData() {
      try {
        setLoading(true);
        setError("");

        // 1) Fetch client → plan
        const { data: client, error: clientErr } = await supabase
          .from("clients")
          .select("plan_id")
          .eq("id", clientId)
          .single();

        if (clientErr) throw clientErr;

        // 2) Fetch plan limits
        const { data: plan, error: planErr } = await supabase
          .from("plans")
          .select("auto_replies_limit")
          .eq("id", client.plan_id)
          .single();

        if (planErr) throw planErr;

        setAutoLimit(plan?.auto_replies_limit || 0);

        // 3) Fetch auto replies
        const { data: rData, error: rErr } = await supabase
          .from("auto_replies")
          .select("id, trigger_text, reply_text, is_active, created_at")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false });

        if (rErr) throw rErr;

        setReplies(rData || []);
        setRepliesCount((rData || []).length);
      } catch (err) {
        console.error(err);
        setError("فشل في تحميل البيانات");
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [clientId]);

  // -------------------------------------------
  // Form operations
  // -------------------------------------------
  function startEdit(r) {
    setForm({
      id: r.id,
      trigger_text: r.trigger_text,
      reply_text: r.reply_text,
      is_active: r.is_active,
    });
  }

  function resetForm() {
    setForm({
      id: null,
      trigger_text: "",
      reply_text: "",
      is_active: true,
    });
  }

  // -------------------------------------------
  // Save reply
  // -------------------------------------------
  async function saveReply() {
    if (!form.trigger_text || !form.reply_text) {
      setError("نص التريغر ونص الرد مطلوبان");
      return;
    }

    // منع الإضافة فوق الحد
    if (!form.id && repliesCount >= autoLimit) {
      setError("لقد وصلت للحد الأقصى للردود التلقائية المتاحة في خطتك");
      return;
    }

    try {
      setSaving(true);
      setError("");

      if (form.id) {
        // Update
        const { error: updError } = await supabase
          .from("auto_replies")
          .update({
            trigger_text: form.trigger_text,
            reply_text: form.reply_text,
            is_active: form.is_active,
          })
          .eq("id", form.id)
          .eq("client_id", clientId);

        if (updError) throw updError;
      } else {
        // Insert
        const { error: insError } = await supabase
          .from("auto_replies")
          .insert([
            {
              client_id: clientId,
              trigger_text: form.trigger_text,
              reply_text: form.reply_text,
              is_active: form.is_active,
            },
          ]);

        if (insError) throw insError;
      }

      resetForm();

      // Reload
      const { data: updatedReplies } = await supabase
        .from("auto_replies")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      setReplies(updatedReplies || []);
      setRepliesCount(updatedReplies?.length || 0);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في حفظ الرد التلقائي");
    } finally {
      setSaving(false);
    }
  }

  // -------------------------------------------
  // Toggle active
  // -------------------------------------------
  async function toggleActive(r) {
    try {
      const { error: updError } = await supabase
        .from("auto_replies")
        .update({ is_active: !r.is_active })
        .eq("id", r.id)
        .eq("client_id", clientId);

      if (updError) throw updError;

      setReplies((prev) =>
        prev.map((x) =>
          x.id === r.id ? { ...x, is_active: !r.is_active } : x
        )
      );
    } catch (err) {
      console.error(err);
      setError("فشل في تحديث الحالة");
    }
  }

  // -------------------------------------------
  // Delete reply
  // -------------------------------------------
  async function deleteReply(id) {
    if (!window.confirm("هل أنت متأكد من حذف هذا الرد التلقائي؟")) return;

    try {
      const { error: delErr } = await supabase
        .from("auto_replies")
        .delete()
        .eq("id", id)
        .eq("client_id", clientId);

      if (delErr) throw delErr;

      const updated = replies.filter((r) => r.id !== id);
      setReplies(updated);
      setRepliesCount(updated.length);
    } catch (err) {
      console.error(err);
      setError("فشل في حذف الرد");
    }
  }

  // -------------------------------------------
  // UI
  // -------------------------------------------
  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">الردود التلقائية</h1>
      <p className="text-gray-500 mb-6">
        يمكنك إعداد الردود التلقائية التي يردّ بها النظام على رسائل عملائك.
      </p>

      {/* Limit counter */}
      <div className="mb-4 bg-white shadow p-4 rounded-xl text-sm">
        <p>
          الردود المستخدمة:{" "}
          <span className="text-blue-600 font-bold">{repliesCount}</span>{" "}
          من{" "}
          <span className="text-green-600 font-bold">{autoLimit}</span>
        </p>

        {repliesCount >= autoLimit && (
          <p className="text-red-600 mt-1 text-xs">
            لقد وصلت إلى الحد الأقصى المسموح به في خطتك.
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Form */}
      <div className="bg-white shadow rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">
          {form.id ? "تعديل رد تلقائي" : "إضافة رد تلقائي جديد"}
        </h2>

        {/* Trigger + Active */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm">نص التريغر</label>
            <input
              type="text"
              value={form.trigger_text}
              onChange={(e) =>
                setForm((f) => ({ ...f, trigger_text: e.target.value }))
              }
              className="border rounded px-3 py-2 w-full"
            />
          </div>

          <div>
            <label className="block text-sm">الحالة</label>
            <select
              value={form.is_active ? "1" : "0"}
              onChange={(e) =>
                setForm((f) => ({ ...f, is_active: e.target.value === "1" }))
              }
              className="border rounded px-3 py-2 w-full"
            >
              <option value="1">مفعّل</option>
              <option value="0">معطّل</option>
            </select>
          </div>
        </div>

        {/* Reply text */}
        <label className="block text-sm">نص الرد التلقائي</label>
        <textarea
          value={form.reply_text}
          onChange={(e) =>
            setForm((f) => ({ ...f, reply_text: e.target.value }))
          }
          className="border rounded px-3 py-2 w-full min-h-[90px]"
        />

        <div className="flex gap-2 mt-4">
          <button
            onClick={saveReply}
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {form.id ? "حفظ التعديلات" : "إضافة الرد"}
          </button>

          {form.id && (
            <button
              onClick={resetForm}
              className="border px-4 py-2 rounded text-gray-700"
            >
              إلغاء
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="bg-white shadow rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">قائمة الردود التلقائية</h2>

        {loading ? (
          <p>جارِ التحميل...</p>
        ) : replies.length === 0 ? (
          <p className="text-gray-400">لا توجد ردود بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="py-2 text-right">التريغر</th>
                <th className="py-2 text-right">الرد</th>
                <th className="py-2 text-right">الحالة</th>
                <th className="py-2 text-right">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {replies.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="py-2 truncate">{r.trigger_text}</td>
                  <td className="py-2 truncate">{r.reply_text}</td>
                  <td className="py-2">
                    <button
                      onClick={() => toggleActive(r)}
                      className={`px-2 py-1 rounded-full text-xs ${
                        r.is_active
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-200 text-gray-600"
                      }`}
                    >
                      {r.is_active ? "مفعّل" : "معطّل"}
                    </button>
                  </td>
                  <td className="py-2">
                    <div className="flex gap-3">
                      <button
                        onClick={() => startEdit(r)}
                        className="text-blue-600 hover:underline text-xs"
                      >
                        تعديل
                      </button>
                      <button
                        onClick={() => deleteReply(r.id)}
                        className="text-red-600 hover:underline text-xs"
                      >
                        حذف
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
