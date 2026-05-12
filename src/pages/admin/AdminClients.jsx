import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { Link } from "react-router-dom";

export default function AdminClients() {
  const [clients, setClients] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    business_name: "",
    email: "",
    password: "",
    plan_id: "",
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setMsg("");

    const { data: plansData } = await supabase
      .from("plans")
      .select("id, name, price");

    const { data: clientsData, error } = await supabase
      .from("clients")
      .select("id, business_name, email, plan_id, is_active, created_at");

    if (error) {
      console.error(error);
      setMsg("❌ خطأ في جلب العملاء");
    }

    setPlans(plansData || []);
    setClients(clientsData || []);
    setLoading(false);
  };

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const addClient = async (e) => {
    e.preventDefault();
    setMsg("");

    if (!form.business_name || !form.email || !form.password) {
      setMsg("⚠️ يرجى إدخال الاسم التجاري والإيميل وكلمة المرور");
      return;
    }

    setSubmitting(true);

    let createdClient = null;
    let createdUser = null;

    try {
      const normalizedEmail = form.email.trim().toLowerCase();

      const { data: existingUser, error: existingUserError } = await supabase
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (existingUserError) throw existingUserError;
      if (existingUser) {
        setMsg("⚠️ هذا الإيميل مستخدم مسبقًا في جدول المستخدمين");
        return;
      }

      const { data: existingClient, error: existingClientError } = await supabase
        .from("clients")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (existingClientError) throw existingClientError;
      if (existingClient) {
        setMsg("⚠️ هذا الإيميل مستخدم مسبقًا في جدول العملاء");
        return;
      }

      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .insert([
          {
            business_name: form.business_name.trim(),
            email: normalizedEmail,
            plan_id: form.plan_id || null,
          },
        ])
        .select("id, business_name, email, plan_id, is_active, created_at")
        .single();

      if (clientError) throw clientError;
      createdClient = clientData;

      const { data: userData, error: userError } = await supabase
        .from("users")
        .insert([
          {
            email: normalizedEmail,
            name: form.business_name.trim(),
            role: "client",
            password: form.password,
          },
        ])
        .select("id")
        .single();

      if (userError) throw userError;
      createdUser = userData;

      const { error: linkError } = await supabase
        .from("client_users")
        .insert([
          {
            client_id: createdClient.id,
            user_id: createdUser.id,
          },
        ]);

      if (linkError) throw linkError;

      setMsg("✅ تم إضافة العميل والمستخدم وربطهما بنجاح");
      setForm({ business_name: "", email: "", password: "", plan_id: "" });
      fetchData();
    } catch (error) {
      console.error(error);

      if (createdUser?.id) {
        await supabase.from("users").delete().eq("id", createdUser.id);
      }

      if (createdClient?.id) {
        await supabase.from("clients").delete().eq("id", createdClient.id);
      }

      setMsg(`❌ فشل في إضافة العميل كاملًا: ${error.message || "خطأ غير معروف"}`);
    } finally {
      setSubmitting(false);
    }
  };

  async function toggleStatus(id, currentStatus) {
    const { error } = await supabase
      .from("clients")
      .update({ is_active: !currentStatus })
      .eq("id", id);

    if (error) {
      console.error(error);
      setMsg("❌ فشل في تحديث حالة العميل");
      return;
    }

    setMsg("✔️ تم تحديث حالة العميل بنجاح");

    setClients((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, is_active: !currentStatus } : c
      )
    );
  }

  const deleteClient = async (id) => {
    if (!window.confirm("هل أنت متأكد من حذف هذا العميل؟")) return;

    const targetClient = clients.find((c) => c.id === id);
    const targetEmail = targetClient?.email || null;

    try {
      if (targetEmail) {
        const { data: linkedUser } = await supabase
          .from("users")
          .select("id")
          .eq("email", targetEmail)
          .maybeSingle();

        if (linkedUser?.id) {
          await supabase.from("client_users").delete().eq("client_id", id);
          await supabase.from("users").delete().eq("id", linkedUser.id);
        }
      }

      const { error } = await supabase.from("clients").delete().eq("id", id);

      if (error) throw error;

      setMsg("🗑️ تم حذف العميل");
      fetchData();
    } catch (error) {
      console.error(error);
      setMsg("❌ فشل في حذف العميل");
    }
  };

  const getPlanName = (plan_id) => {
    const p = plans.find((pl) => pl.id === plan_id);
    return p ? `${p.name} (${p.price}$)` : "-";
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">إدارة العملاء</h1>
      <p className="text-gray-500 mb-6">
        يمكنك إضافة عميل جديد، وتفعيل/تعطيل، أو تعديل إعداداته.
      </p>

      {msg && <p className="mb-4 text-blue-700 font-semibold">{msg}</p>}

      <form
        onSubmit={addClient}
        className="bg-white shadow rounded-xl p-4 mb-8 flex flex-wrap gap-4 items-end"
      >
        <div>
          <label className="block text-sm mb-1">الاسم التجاري</label>
          <input
            type="text"
            name="business_name"
            value={form.business_name}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-64"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">البريد الإلكتروني</label>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-64"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">كلمة المرور</label>
          <input
            type="text"
            name="password"
            value={form.password}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-56"
            placeholder="مثال: 12345"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">الخطة</label>
          <select
            name="plan_id"
            value={form.plan_id}
            onChange={handleChange}
            className="border rounded px-3 py-2 w-56"
          >
            <option value="">بدون خطة</option>
            {plans.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name} - ${pl.price}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="bg-blue-600 text-white px-5 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "جارِ الإضافة..." : "إضافة عميل"}
        </button>
      </form>

      {loading ? (
        <p>جارِ تحميل العملاء...</p>
      ) : clients.length === 0 ? (
        <p className="text-gray-400">لا يوجد عملاء بعد.</p>
      ) : (
        <table className="w-full bg-white shadow rounded-xl overflow-hidden">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="p-3 text-left">الاسم التجاري</th>
              <th className="p-3 text-left">الإيميل</th>
              <th className="p-3 text-left">الخطة</th>
              <th className="p-3 text-left">الحالة</th>
              <th className="p-3 text-center">الإعدادات</th>
              <th className="p-3 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-t hover:bg-gray-50 text-sm">
                <td className="p-3">{c.business_name}</td>
                <td className="p-3">{c.email}</td>
                <td className="p-3">{getPlanName(c.plan_id)}</td>
                <td className="p-3">
                  {c.is_active ? (
                    <span className="text-green-600 font-semibold">مفعّل</span>
                  ) : (
                    <span className="text-red-500 font-semibold">معطّل</span>
                  )}
                </td>
                <td className="p-3 text-center">
                  <Link
                    to={`/admin/client/${c.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    إعدادات العميل
                  </Link>
                </td>
                <td className="p-3 text-center space-x-2 space-x-reverse">
                  <button
                    onClick={() => toggleStatus(c.id, c.is_active)}
                    className={
                      c.is_active
                        ? "bg-yellow-500 text-white px-3 py-1 rounded hover:bg-yellow-600 mx-1"
                        : "bg-gray-400 text-white px-3 py-1 rounded hover:bg-gray-500 mx-1"
                    }
                  >
                    {c.is_active ? "تعطيل" : "تفعيل"}
                  </button>
                  <button
                    onClick={() => deleteClient(c.id)}
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
