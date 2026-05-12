import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useNavigate } from "react-router-dom";

export default function Clients() {
  const [clients, setClients] = useState([]);
  const [plans, setPlans] = useState([]);

  const [form, setForm] = useState({
    business_name: "",
    email: "",
    plan_id: "",
  });

  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editingClient, setEditingClient] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchInitial();
  }, []);

  async function fetchInitial() {
    try {
      setError("");
      // clients
      const { data: clientsData, error: clientsError } = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false });

      if (clientsError) throw clientsError;

      // plans
      const { data: plansData, error: plansError } = await supabase
        .from("plans")
        .select("*")
        .order("price", { ascending: true });

      if (plansError) throw plansError;

      setClients(clientsData || []);
      setPlans(plansData || []);
    } catch (err) {
      console.error("Error fetching clients/plans:", err);
      setError(err.message || "فشل في جلب بيانات العملاء / الباقات");
    }
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function validateForm() {
    if (!form.business_name.trim() || !form.email.trim()) {
      setError("الاسم التجاري والإيميل مطلوبان");
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email.trim())) {
      setError("الرجاء إدخال بريد إلكتروني صالح");
      return false;
    }

    return true;
  }

  async function handleSave(e) {
  e.preventDefault();
  setError("");
  setSuccess("");

  if (!validateForm()) return;

  try {
    setSaving(true);

    let client = null;

    // --------------------------
    // 🟦 1) تعديل عميل
    // --------------------------
    if (editingClient) {
      const { error: updateError } = await supabase
        .from("clients")
        .update({
          business_name: form.business_name,
          email: form.email,
          plan_id: form.plan_id || null,
        })
        .eq("id", editingClient.id);

      if (updateError) throw updateError;

      client = editingClient;

      setSuccess("تم تحديث بيانات العميل بنجاح");
      setEditingClient(null);

    } else {
      // --------------------------
      // 🟩 2) إضافة عميل جديد
      // --------------------------
      const { data: clientData, error: insertError } = await supabase
        .from("clients")
        .insert({
          business_name: form.business_name,
          email: form.email,
          plan_id: form.plan_id || null,
          is_active: true,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      client = clientData;

      // --------------------------
      // 🟨 3) إنشاء User تلقائي للعميل الجديد
      // --------------------------
      const { data: userData, error: userError } = await supabase
        .from("users")
        .insert({
          email: form.email,
          name: form.business_name,
          password: "12345", // TODO: غيرها لاحقًا + اعمل reset password
          role: "client",
          //plan_id: form.plan_id || null,
          //business_name: form.business_name,
        })
        .select()
        .single();

      if (userError) throw userError;

      // --------------------------
      // 🟧 4) ربط الـ user بالـ client
      // --------------------------
      const { error: linkError } = await supabase
        .from("client_users")
        .insert({
          client_id: client.id,
          user_id: userData.id,
        });

      if (linkError) throw linkError;

      setSuccess("تم إضافة العميل وإنشاء مستخدم وربطهما بنجاح");
    }

    // Reset
    setForm({ business_name: "", email: "", plan_id: "" });
    await fetchInitial();

  } catch (err) {
    console.error("Error saving client:", err);
    setError(err.message || "فشل في إضافة / تعديل العميل");
  } finally {
    setSaving(false);
  }
}


  async function handleToggleActive(client) {
    try {
      const newStatus = !client.is_active;

      const { error } = await supabase
        .from("clients")
        .update({ is_active: newStatus })
        .eq("id", client.id);

      if (error) throw error;

      setClients((prev) =>
        prev.map((c) =>
          c.id === client.id ? { ...c, is_active: newStatus } : c
        )
      );
    } catch (err) {
      console.error("Error toggling active:", err);
      setError(err.message || "فشل في تغيير حالة تفعيل العميل");
    }
  }

  async function handleDelete(clientId) {
    if (!window.confirm("هل أنت متأكد من حذف هذا العميل؟")) return;

    try {
      const { error } = await supabase
        .from("clients")
        .delete()
        .eq("id", clientId);

      if (error) throw error;

      setClients((prev) => prev.filter((c) => c.id !== clientId));
    } catch (err) {
      console.error("Error deleting client:", err);
      setError(err.message || "فشل في حذف العميل");
    }
  }

  function startEdit(client) {
    setEditingClient(client);
    setForm({
      business_name: client.business_name || "",
      email: client.email || "",
      plan_id: client.plan_id || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const filteredClients = clients.filter((c) => {
    const term = search.toLowerCase();
    return (
      c.business_name?.toLowerCase().includes(term) ||
      c.email?.toLowerCase().includes(term)
    );
  });

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-2">العملاء</h1>
      <p className="text-gray-500 mb-6">
        يمكنك إضافة عميل جديد، تفعيل/تعطيل، تعديل أو حذف وإعداداته.
      </p>

      {/* رسائل */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded-lg">
          {success}
        </div>
      )}

      {/* فورم إضافة/تعديل */}
      <div className="bg-white shadow rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">
          {editingClient ? "تعديل بيانات العميل" : "إضافة عميل جديد"}
        </h2>

        <form
          onSubmit={handleSave}
          className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end"
        >
          <div>
            <label className="block mb-1 text-sm text-gray-600">
              الاسم التجاري
            </label>
            <input
              type="text"
              name="business_name"
              value={form.business_name}
              onChange={handleChange}
              className="border rounded-lg w-full px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm text-gray-600">الإيميل</label>
            <input
              type="email"
              name="email"
              value={form.email}
              onChange={handleChange}
              className="border rounded-lg w-full px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm text-gray-600">الباقة</label>
            <select
              name="plan_id"
              value={form.plan_id}
              onChange={handleChange}
              className="border rounded-lg w-full px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">بدون باقة</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} - ${p.price}
                </option>
              ))}
            </select>
          </div>

          <div>
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60"
            >
              {saving
                ? "جارِ الحفظ..."
                : editingClient
                ? "حفظ التعديل"
                : "إضافة عميل"}
            </button>
          </div>
        </form>
      </div>

      {/* قائمة العملاء */}
      <div className="bg-white shadow rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">قائمة العملاء</h2>
          <input
            type="text"
            placeholder="بحث بالاسم أو الإيميل..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {filteredClients.length === 0 ? (
          <p className="text-gray-400">لا يوجد عملاء بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-gray-600">
              <tr className="text-left">
                <th className="py-2">الاسم التجاري</th>
                <th className="py-2">الإيميل</th>
                <th className="py-2">الباقة</th>
                <th className="py-2 text-center">الحالة</th>
                <th className="py-2 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((c) => {
                const plan = plans.find((p) => p.id === c.plan_id);
                return (
                  <tr key={c.id} className="border-b last:border-none">
                    <td className="py-2">{c.business_name}</td>
                    <td className="py-2">{c.email}</td>
                    <td className="py-2">
                      {plan ? `${plan.name} - $${plan.price}` : "بدون باقة"}
                    </td>
                    <td className="py-2 text-center">
                      <button
                        onClick={() => handleToggleActive(c)}
                        className={`px-3 py-1 rounded-full text-xs font-semibold ${
                          c.is_active
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {c.is_active ? "مفعّل" : "معطّل"}
                      </button>
                    </td>
                    <td className="py-2 text-center space-x-2 space-x-reverse">
                      <button
                        onClick={() => startEdit(c)}
                        className="px-3 py-1 rounded bg-yellow-100 text-yellow-800 text-xs"
                      >
                        تعديل
                      </button>
                    
                      <button
                        onClick={() => handleDelete(c.id)}
                        className="px-3 py-1 rounded bg-red-100 text-red-700 text-xs"
                      >
                        حذف
                      </button>
                    

                        <button
    onClick={() => navigate(`/admin/client-users/${c.id}`)}
    className="px-3 py-1 rounded bg-blue-100 text-blue-700 text-xs"
  >
    المستخدمين
  </button>
                      
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
