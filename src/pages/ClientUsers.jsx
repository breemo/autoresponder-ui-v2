import React, { useEffect, useState } from "react"; 
import { supabase } from "../lib/supabaseClient";
import { useParams } from "react-router-dom";

export default function ClientUsers() {
  const { clientId } = useParams();
  const [client, setClient] = useState(null);
  const [users, setUsers] = useState([]);

  const [form, setForm] = useState({
    email: "",
    name: "",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);

    // 1) جلب بيانات العميل
    const { data: clientData } = await supabase
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .single();

    setClient(clientData);

    // 2) جلب المستخدمين المرتبطين
    const { data: joinData } = await supabase
      .from("client_users")
      .select("user_id, users(*)")
      .eq("client_id", clientId);

    setUsers(joinData?.map((x) => x.users) || []);
    setLoading(false);
  }

  async function addUser(e) {
    e.preventDefault();
    setSaving(true);

    try {
      // 1) إنشاء user
      const { data: newUser, error: userError } = await supabase
        .from("users")
        .insert({
          email: form.email,
          name: form.name,
          role: "client",
          password: "12345678",
        })
        .select()
        .single();

      if (userError) throw userError;

      // 2) ربطه مع العميل
      await supabase.from("client_users").insert({
        client_id: clientId,
        user_id: newUser.id,
      });

      setForm({ email: "", name: "" });
      await fetchData();
    } catch (err) {
      console.error(err);
      alert("خطأ: " + err.message);
    }

    setSaving(false);
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">
        مستخدمو العميل: {client?.business_name}
      </h1>

      <div className="bg-white shadow p-6 rounded-xl mb-8">
        <h2 className="text-lg font-semibold mb-4">إضافة مستخدم جديد</h2>

        <form onSubmit={addUser} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            type="text"
            placeholder="الاسم"
            className="border rounded px-3 py-2"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          <input
            type="email"
            placeholder="الإيميل"
            className="border rounded px-3 py-2"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />

          <button
            className="bg-blue-600 text-white rounded px-3 py-2"
            disabled={saving}
          >
            {saving ? "جاري الحفظ..." : "إضافة"}
          </button>
        </form>
      </div>

      <div className="bg-white shadow p-6 rounded-xl">
        <h2 className="text-lg font-semibold mb-4">كل المستخدمين</h2>

        {loading ? (
          <p>جارِ التحميل...</p>
        ) : users.length === 0 ? (
          <p className="text-gray-400">لا يوجد مستخدمون بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-gray-600">
              <tr>
                <th className="py-2">الاسم</th>
                <th className="py-2">الإيميل</th>
                <th className="py-2">الدور</th>
              </tr>
            </thead>

            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b">
                  <td className="py-2">{u.name}</td>
                  <td className="py-2">{u.email}</td>
                  <td className="py-2">{u.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
