import React, { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";

import { supabase } from "../../lib/supabaseClient";

export default function AdminDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [stats, setStats] = useState({
    totalClients: 0,
    activeClients: 0,
    plansCount: 0,
    totalMessages: 0,
    totalAutoReplies: 0,
    recentClients: [],
  });

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    setLoading(true);
    setError("");

    try {
      // --- العملاء ---
      const { data: clients, error: clientsError } = await supabase
        .from("clients")
        .select("id, business_name, email, is_active, created_at")
        .order("created_at", { ascending: false });

      if (clientsError) throw clientsError;

      const totalClients = clients?.length || 0;

      const activeClients =
        clients?.filter((c) => c.is_active === true).length || 0;

      const recentClients = clients?.slice(0, 5) || [];

      // --- الباقات ---
      const { count: plansCount, error: plansError } = await supabase
        .from("plans")
        .select("*", { count: "exact", head: true });
      if (plansError) throw plansError;

      // --- الرسائل ---
      const { count: totalMessages, error: messagesError } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true });
      if (messagesError) throw messagesError;

      // --- الردود التلقائية ---
      const { count: totalAutoReplies, error: autoRepliesError } =
        await supabase
          .from("auto_replies")
          .select("*", { count: "exact", head: true });
      if (autoRepliesError) throw autoRepliesError;

      setStats({
        totalClients,
        activeClients,
        plansCount: plansCount || 0,
        totalMessages: totalMessages || 0,
        totalAutoReplies: totalAutoReplies || 0,
        recentClients,
      });
    } catch (err) {
      console.error("خطأ في جلب الإحصائيات:", err);
      setError(err.message || "حدث خطأ أثناء جلب البيانات");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">
            مرحباً {user?.name || "Admin User"} 👋
          </h1>
          <p className="text-gray-500">
            لوحة تحكم AutoResponder لإدارة العملاء، الباقات، الرسائل والردود
            التلقائية.
          </p>
        </div>
        <div className="text-sm text-gray-500">
          إجمالي الردود التلقائية{" "}
          <span className="font-semibold text-blue-600">
            {stats.totalAutoReplies}
          </span>
          <br />
          إجمالي الرسائل{" "}
          <span className="font-semibold text-purple-600">
            {stats.totalMessages}
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-600">جارِ تحميل البيانات...</div>
      ) : (
        <>
          {/* البطاقات */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            <div className="bg-white shadow rounded-xl p-6 text-center">
              <p className="text-gray-500 mb-2">إجمالي العملاء</p>
              <p className="text-3xl font-bold text-blue-600">
                {stats.totalClients}
              </p>
            </div>

            <div className="bg-white shadow rounded-xl p-6 text-center">
              <p className="text-gray-500 mb-2">العملاء المفعّلين</p>
              <p className="text-3xl font-bold text-green-600">
                {stats.activeClients}
              </p>
            </div>

            <div className="bg-white shadow rounded-xl p-6 text-center">
              <p className="text-gray-500 mb-2">عدد الباقات</p>
              <p className="text-3xl font-bold text-purple-600">
                {stats.plansCount}
              </p>
            </div>
          </div>

          {/* آخر العملاء */}
          <div className="bg-white shadow rounded-xl p-6">
            <h2 className="text-xl font-semibold mb-4">آخر 5 عملاء</h2>
            {stats.recentClients.length === 0 ? (
              <p className="text-gray-400">لا يوجد عملاء بعد.</p>
            ) : (
              <table className="w-full">
                <thead className="border-b">
                  <tr className="text-left text-gray-600">
                    <th className="py-2">الاسم التجاري</th>
                    <th className="py-2">الإيميل</th>
                    <th className="py-2">الحالة</th>
                    <th className="py-2">تاريخ الإنشاء</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentClients.map((c) => (
                    <tr key={c.id} className="border-b text-sm">
                      <td className="py-2">{c.business_name}</td>
                      <td className="py-2">{c.email}</td>
                      <td className="py-2">
                        {typeof c.is_active === "boolean"
                          ? c.is_active ? (
                              <span className="text-green-600">مفعّل</span>
                            ) : (
                              <span className="text-red-500">معطّل</span>
                            )
                          : c.role === "disabled" ? (
                              <span className="text-red-500">معطّل</span>
                            ) : (
                              <span className="text-green-600">مفعّل</span>
                            )}
                      </td>
                      <td className="py-2 text-gray-500">
                        {c.created_at
                          ? new Date(c.created_at).toLocaleString("ar-EG")
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
