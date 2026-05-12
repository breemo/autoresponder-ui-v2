// src/pages/ClientDashboard.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../App";

// ===== Graph Library =====
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

export default function ClientDashboard() {
  const { user } = useAuth();

  const [stats, setStats] = useState({
    totalMessages: 0,
    autoRepliesCount: 0,
    planName: "",
    maxMessages: null,
  });

  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // ------------------------ FETCH STATS ------------------------
  useEffect(() => {
    if (!user?.id) return;
    fetchStats();
    fetchChart();
  }, [user?.id]);

  async function fetchStats() {
    try {
      setLoading(true);
      setError("");

      const clientId = user.id;

      // إجمالي الرسائل
      const { count: totalMessages, error: msgError } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId);

      if (msgError) throw msgError;

      // عدد الردود التلقائية
      const { count: autoRepliesCount, error: arError } = await supabase
        .from("auto_replies")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId);

      if (arError) throw arError;

      // بيانات الخطة
      let planName = "";
      let maxMessages = null;

      if (user.plan_id) {
        const { data: plan, error: planError } = await supabase
          .from("plans")
          .select("name, max_messages")
          .eq("id", user.plan_id)
          .single();

        if (planError && planError.code !== "PGRST116") throw planError;

        if (plan) {
          planName = plan.name;
          maxMessages = plan.max_messages;
        }
      }

      setStats({
        totalMessages,
        autoRepliesCount,
        planName,
        maxMessages,
      });
    } catch (err) {
      console.error(err);
      setError("حدث خطأ أثناء جلب بيانات لوحة التحكم.");
    } finally {
      setLoading(false);
    }
  }

  // ------------------------ FETCH CHART DATA ------------------------
  async function fetchChart() {
    try {
      const clientId = user.id;

      const { data, error } = await supabase
        .from("messages")
        .select("created_at")
        .eq("client_id", clientId)
        .gte(
          "created_at",
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        );

      if (error) throw error;

      // تجهيز هيكل الأيام
      const days = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);

        const key = d.toLocaleDateString("ar-EG", { weekday: "short" });
        days[key] = 0;
      }

      // العدّ
      data.forEach((msg) => {
        const day = new Date(msg.created_at).toLocaleDateString("ar-EG", {
          weekday: "short",
        });
        if (days[day] !== undefined) days[day]++;
      });

      // تحويله لآري جاهز للـ chart
      const formatted = Object.keys(days).map((day) => ({
        day,
        messages: days[day],
      }));

      setChartData(formatted);
    } catch (err) {
      console.log("Chart error:", err.message);
    }
  }

  const displayName = user?.business_name || user?.name || "عميلنا الكريم";

  return (
    <div className="p-8">

      {/* ===== HEADER ===== */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-800 mb-1">
          مرحباً {displayName} 👋
        </h1>
        <p className="text-gray-500 text-sm">
          تابع نشاط حسابك، الرسائل، الردود التلقائية والباقات.
        </p>
      </div>

      {/* ===== ERROR ===== */}
      {error && (
        <div className="mb-4 bg-red-50 text-red-700 px-4 py-2 rounded border border-red-200 text-sm">
          {error}
        </div>
      )}

      {/* ===== LOADING ===== */}
      {loading ? (
        <p className="text-gray-500">جارِ تحميل البيانات...</p>
      ) : (
        <>
          {/* ===== CARDS ===== */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">

            <div className="bg-white border shadow-sm rounded-xl p-6 text-center">
              <p className="text-gray-500">إجمالي الرسائل</p>
              <p className="text-4xl font-extrabold text-blue-600 mt-2">
                {stats.totalMessages}
              </p>
            </div>

            <div className="bg-white border shadow-sm rounded-xl p-6 text-center">
              <p className="text-gray-500">عدد الردود التلقائية</p>
              <p className="text-4xl font-extrabold text-green-600 mt-2">
                {stats.autoRepliesCount}
              </p>
            </div>

            <div className="bg-white border shadow-sm rounded-xl p-6 text-center">
              <p className="text-gray-500">الخطة الحالية</p>
              <p className="text-2xl font-bold text-purple-600 mt-2">
                {stats.planName || "غير محددة"}
              </p>
              {stats.maxMessages !== null && (
                <p className="text-xs text-gray-400 mt-1">
                  الحد الأقصى للرسائل: {stats.maxMessages}
                </p>
              )}
            </div>

          </div>

          {/* ===== GRAPH ===== */}
          <div className="bg-white border shadow-sm rounded-xl p-6 mt-10">
            <h3 className="text-lg font-semibold mb-4">
              إحصائيات الرسائل خلال آخر 7 أيام
            </h3>

            {chartData.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-gray-400">
                لا توجد بيانات لعرض الرسم البياني 📭
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="day" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="messages"
                    stroke="#4F46E5"
                    strokeWidth={3}
                    dot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}
    </div>
  );
}
