// src/pages/admin/AdminPlans.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Link } from "react-router-dom";

export default function AdminPlans() {
  const [plans, setPlans] = useState([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  // form + حالة هل احنا بنضيف ولا بنعدل
  const [form, setForm] = useState({
    name: "",
    price: "",
    description: "",
    allow_self_edit: false,
    auto_replies_limit: "",
    integrations_limit: "",
    messages_limit: "",

  });
  const [editingId, setEditingId] = useState(null); // null = إضافة، غير هيك = تعديل

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    setLoading(true);
    setMsg("");

    const { data, error } = await supabase
      .from("plans")
      .select("id, name, price, description, allow_self_edit, auto_replies_limit, integrations_limit, messages_limit")

      .order("price", { ascending: true });

    if (error) {
      console.error(error);
      setMsg("❌ حدث خطأ في جلب الباقات");
    } else {
      setPlans(data || []);
    }

    setLoading(false);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const resetForm = () => {
  setForm({
      name: "",
      price: "",
      description: "",
      allow_self_edit: false,
      auto_replies_limit: "",
      integrations_limit: "",
      messages_limit: "",
    });
    setEditingId(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMsg("");

    if (!form.name) {
      setMsg("⚠️ يرجى إدخال اسم الخطة");
      return;
    }

    const priceNumber =
      form.price === "" ? 0 : Number.isNaN(Number(form.price)) ? 0 : Number(form.price);

    try {
      if (editingId) {
        // تحديث خطة
        const { error } = await supabase
          .from("plans")
          .update({
            name: form.name,
            price: priceNumber,
            description: form.description || null,
            allow_self_edit: form.allow_self_edit,
            auto_replies_limit: form.auto_replies_limit,
            integrations_limit: form.integrations_limit,
            messages_limit: form.messages_limit

          })
          .eq("id", editingId);

        if (error) throw error;
        setMsg("✅ تم تحديث الخطة بنجاح");
      } else {
        // إضافة خطة جديدة
        const { error } = await supabase.from("plans").insert([
          {
            name: form.name,
            price: priceNumber,
            description: form.description || null,
            allow_self_edit: form.allow_self_edit,
            auto_replies_limit: form.auto_replies_limit,
            integrations_limit: form.integrations_limit,
            messages_limit: form.messages_limit

          },
        ]);

        if (error) throw error;
        setMsg("✅ تم إضافة الخطة بنجاح");
      }

      resetForm();
      fetchPlans();
    } catch (err) {
      console.error(err);
      setMsg("❌ حدث خطأ أثناء حفظ الخطة");
    }
  };

  const startEdit = (plan) => {
    setForm({
      name: plan.name || "",
      price: plan.price?.toString() || "",
      description: plan.description || "",
      allow_self_edit: plan.allow_self_edit,

      auto_replies_limit: plan.auto_replies_limit,
      integrations_limit: plan.integrations_limit,
      messages_limit: plan.messages_limit
    });
    setEditingId(plan.id);
    setMsg("");
  };

  const deletePlan = async (id) => {
    if (!window.confirm("هل أنت متأكد من حذف هذه الخطة؟")) return;

    setMsg("");

    const { error } = await supabase.from("plans").delete().eq("id", id);

    if (error) {
      console.error(error);
      setMsg("❌ فشل في حذف الخطة");
    } else {
      setMsg("🗑️ تم حذف الخطة بنجاح");
      fetchPlans();
      if (editingId === id) resetForm();
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">إدارة الباقات</h1>
      <p className="text-gray-500 mb-6">
        أضف، عدّل، واحذف الباقات المتاحة لعملائك.
      </p>

      {msg && <p className="mb-4 text-blue-700 font-semibold">{msg}</p>}

      {/* فورم إضافة / تعديل خطة */}
      <form
        onSubmit={handleSubmit}
        className="bg-white shadow rounded-xl p-4 mb-8 flex flex-wrap gap-4 items-end"
      >
        <div>
          <label className="block text-sm mb-1">اسم الخطة</label>
          <input
            type="text"
            name="name"
            value={form.name}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-60"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">السعر (بالدولار)</label>
          <input
            type="number"
            step="0.01"
            name="price"
            value={form.price}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-40"
          />
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm mb-1">الوصف (اختياري)</label>
          <input
            type="text"
            name="description"
            value={form.description}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-full"
          />
        </div>
<div className="flex items-center gap-2">
  <input
    type="checkbox"
    name="allow_self_edit"
    checked={form.allow_self_edit}
    onChange={(e) => setForm(prev => ({ 
      ...prev, 
      allow_self_edit: e.target.checked 
    }))}
  />
  <label>السماح للعميل بتعديل إعدادات الميزات</label>
</div>


<div>
  <label className="block text-sm mb-1">حد الردود التلقائية</label>
  <input
    type="number"
    name="auto_replies_limit"
    value={form.auto_replies_limit}
    onChange={handleChange}
    className="border rounded px-3 py-2 w-40"
  />
</div>

<div>
  <label className="block text-sm mb-1">حد التكاملات</label>
  <input
    type="number"
    name="integrations_limit"
    value={form.integrations_limit}
    onChange={handleChange}
    className="border rounded px-3 py-2 w-40"
  />
</div>

<div>
  <label className="block text-sm mb-1">حد الرسائل</label>
  <input
    type="number"
    name="messages_limit"
    value={form.messages_limit}
    onChange={handleChange}
    className="border rounded px-3 py-2 w-40"
  />
</div>





        

        <button
          type="submit"
          className="bg-blue-600 text-white px-5 py-2 rounded hover:bg-blue-700"
        >
          {editingId ? "تحديث الخطة" : "إضافة خطة"}
        </button>

        {editingId && (
          <button
            type="button"
            onClick={resetForm}
            className="ml-2 bg-gray-300 text-gray-800 px-4 py-2 rounded hover:bg-gray-400"
          >
            إلغاء التعديل
          </button>
        )}
      </form>

      {/* جدول الباقات */}
      {loading ? (
        <p>جارِ تحميل الباقات...</p>
      ) : plans.length === 0 ? (
        <p className="text-gray-400">لا توجد باقات بعد.</p>
      ) : (
        <table className="w-full bg-white shadow rounded-xl overflow-hidden">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="p-3 text-left">اسم الخطة</th>
              <th className="p-3 text-left">السعر</th>
<th className="p-3 text-center">حد الردود</th>
<th className="p-3 text-center">حد التكاملات</th>
<th className="p-3 text-center">حد الرسائل</th>
                            
              <th className="p-3 text-center"> تعديل إعدادات الميزات</th>

              <th className="p-3 text-left">الوصف</th>
              <th className="p-3 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-t hover:bg-gray-50 text-sm">
                <td className="p-3">{p.name}</td>
                <td className="p-3">
                  {typeof p.price === "number" ? `$${p.price}` : p.price}
                </td>
<td className="p-3 text-center">{p.auto_replies_limit ?? "-"}</td>
<td className="p-3 text-center">{p.integrations_limit ?? "-"}</td>
<td className="p-3 text-center">{p.messages_limit ?? "-"}</td>

                <td className="p-3">
                  {p.allow_self_edit ? "✔ مسموح" : "✖ ممنوع"}
                </td>  
                <td className="p-3">{p.description || "-"}</td>

                <td className="p-3 text-center space-x-2 space-x-reverse">
                  <Link
                        to={`/admin/plan-features/${p.id}`}
                        className="bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700 mx-1"
                      >
                        ميزات الباقة
                  </Link>

                  <button
                    onClick={() => startEdit(p)}
                    className="bg-yellow-500 text-white px-3 py-1 rounded hover:bg-yellow-600 mx-1"
                  >
                    تعديل
                  </button>
                  <button
                    onClick={() => deletePlan(p.id)}
                    className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 mx-1"
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
  );
}
