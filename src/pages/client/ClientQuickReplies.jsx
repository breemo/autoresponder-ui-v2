import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext";

export default function ClientQuickReplies() {
  const { user } = useAuth();

  const [clientId, setClientId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState("");
  const [type, setType] = useState("custom");
  const [displayOrder, setDisplayOrder] = useState(0);
  const [hideAfterPayloads, setHideAfterPayloads] = useState([]);

  useEffect(() => {
    if (user?.client_id) setClientId(user.client_id);
  }, [user]);

  const fetchData = async () => {
    if (!clientId) return;

    setLoading(true);
    setError("");

    const { data, error } = await supabase
      .from("quick_reply_templates")
      .select("*")
      .eq("client_id", clientId)
      .order("display_order", { ascending: true });

    if (error) setError(error.message);
    else setItems(data || []);

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [clientId]);

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
    setPayload("");
    setType("custom");
    setDisplayOrder(0);
    setHideAfterPayloads([]);
  };

  const handleSave = async () => {
    setError("");

    if (!clientId) return alert("client_id مش موجود ❌");
    if (!title.trim()) return alert("اكتب النص أول ❌");

    const finalPayload =
      payload.trim() || title.trim().replace(/\s+/g, "_").toUpperCase();

    const record = {
      client_id: clientId,
      title: title.trim(),
      payload: finalPayload,
      action_type: type,
      display_order: Number(displayOrder) || items.length + 1,
      is_active: true,
      hide_after_payloads: hideAfterPayloads,
    };

    const query = editingId
      ? supabase
          .from("quick_reply_templates")
          .update(record)
          .eq("id", editingId)
          .eq("client_id", clientId)
      : supabase.from("quick_reply_templates").insert([record]);

    const { error } = await query;

    if (error) return alert(error.message);

    resetForm();
    fetchData();
  };

  const handleEdit = (item) => {
    setEditingId(item.id);
    setTitle(item.title || "");
    setPayload(item.payload || "");
    setType(item.action_type || "custom");
    setDisplayOrder(item.display_order || 0);
    setHideAfterPayloads(item.hide_after_payloads || []);
  };

  const handleToggle = async (item) => {
    const { error } = await supabase
      .from("quick_reply_templates")
      .update({ is_active: !item.is_active })
      .eq("id", item.id)
      .eq("client_id", clientId);

    if (error) return alert(error.message);

    fetchData();
  };

  const handleDelete = async (id) => {
    if (!confirm("هل أنت متأكد من حذف هذا الخيار؟")) return;

    const { error } = await supabase
      .from("quick_reply_templates")
      .delete()
      .eq("id", id)
      .eq("client_id", clientId);

    if (error) return alert(error.message);

    fetchData();
  };

  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">الخيارات السريعة</h1>
        <p className="text-sm text-gray-500 mt-1">
          أزرار تظهر للزبائن داخل المحادثة لتسهيل الاختيار.
        </p>
      </div>

      {error && (
        <div className="bg-red-100 text-red-700 border border-red-200 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        <h2 className="font-semibold mb-4">
          {editingId ? "تعديل خيار سريع" : "إضافة خيار سريع جديد"}
        </h2>

        <div className="flex flex-wrap gap-3 items-end">
          <input
            type="text"
            placeholder="النص"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="border px-3 py-2 rounded-lg w-56"
          />

          <input
            type="text"
            placeholder="Payload (اختياري)"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            className="border px-3 py-2 rounded-lg w-56"
          />

          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="border px-3 py-2 rounded-lg w-48"
          >
            <option value="custom">مخصص</option>
            <option value="order">طلب</option>
            <option value="booking">حجز موعد</option>
            <option value="quote">عرض سعر</option>
            <option value="human_request">تواصل مع موظف</option>
            <option value="question">استفسار</option>
          </select>

          <input
            type="number"
            placeholder="الترتيب"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(e.target.value)}
            className="border px-3 py-2 rounded-lg w-28"
          />

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              إخفاء بعد اختيار
            </label>
            <select
              multiple
              value={hideAfterPayloads}
              onChange={(e) =>
                setHideAfterPayloads(
                  Array.from(e.target.selectedOptions, (option) => option.value)
                )
              }
              className="border px-3 py-2 rounded-lg w-64 h-28"
            >
              {items.map((item) => (
                <option key={item.id} value={item.payload}>
                  {item.title} ({item.payload})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleSave}
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg"
          >
            {editingId ? "حفظ التعديل" : "إضافة"}
          </button>

          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-5 py-2 rounded-lg"
            >
              إلغاء
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        <h2 className="font-semibold mb-4">قائمة الخيارات السريعة</h2>

        {loading ? (
          <p className="text-gray-500">جاري التحميل...</p>
        ) : items.length === 0 ? (
          <p className="text-gray-500">لا توجد خيارات سريعة بعد.</p>
        ) : (
          <table className="w-full text-sm border-t">
            <thead>
              <tr className="text-gray-600 border-b bg-gray-50">
                <th className="py-3 px-2 text-right">النص</th>
                <th className="py-3 px-2 text-right">Payload</th>
                <th className="py-3 px-2 text-right">Type</th>
                <th className="py-3 px-2 text-right">إخفاء بعد</th>
                <th className="py-3 px-2 text-right">الترتيب</th>
                <th className="py-3 px-2 text-right">الحالة</th>
                <th className="py-3 px-2 text-right">إجراءات</th>
              </tr>
            </thead>

            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-b-0">
                  <td className="py-3 px-2">{item.title}</td>
                  <td className="py-3 px-2 font-mono">{item.payload}</td>
                  <td className="py-3 px-2">{item.action_type}</td>
                  <td className="py-3 px-2 font-mono text-xs">
                    {(item.hide_after_payloads || []).join(", ")}
                  </td>
                  <td className="py-3 px-2">{item.display_order}</td>
                  <td className="py-3 px-2">
                    <button
                      type="button"
                      onClick={() => handleToggle(item)}
                      className={`px-3 py-1 rounded-full text-xs ${
                        item.is_active
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-200 text-gray-700"
                      }`}
                    >
                      {item.is_active ? "مفعل" : "معطل"}
                    </button>
                  </td>
                  <td className="py-3 px-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleEdit(item)}
                      className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-lg hover:bg-yellow-200"
                    >
                      تعديل
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="bg-red-100 text-red-700 px-3 py-1 rounded-lg hover:bg-red-200"
                    >
                      حذف
                    </button>
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
