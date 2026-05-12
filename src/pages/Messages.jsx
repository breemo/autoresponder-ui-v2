import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import Loader from "../components/Loader";

export default function Messages() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState("all"); // all | in | out
  const [status, setStatus] = useState("all"); // all | delivered | failed | pending
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchMessages();
  }, []);

  async function fetchMessages() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("messages")
        .select("id,client_id,text,direction,status,created_at,clients(business_name)")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setMessages(data || []);
    } catch (err) {
      console.error("خطأ في جلب الرسائل:", err.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (direction !== "all" && m.direction !== direction) return false;
      if (status !== "all" && m.status !== status) return false;

      const term = search.trim().toLowerCase();
      if (!term) return true;

      const clientName = m.clients?.business_name?.toLowerCase() || "";
      const text = m.text?.toLowerCase() || "";
      return clientName.includes(term) || text.includes(term);
    });
  }, [messages, direction, status, search]);

  if (loading) return <Loader message="جارِ تحميل الرسائل..." />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">الرسائل</h1>
      <p className="text-gray-500 mb-6">
        عرض جميع الرسائل الواردة والصادرة المرتبطة بالعملاء.
      </p>

      {/* فلاتر */}
      <div className="bg-white rounded-xl shadow p-4 mb-6 flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div className="flex gap-3">
          <select
            className="border rounded-lg px-3 py-2 text-sm"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            <option value="all">كل الاتجاهات</option>
            <option value="in">واردة</option>
            <option value="out">صادرة</option>
          </select>

          <select
            className="border rounded-lg px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">كل الحالات</option>
            <option value="delivered">تم التسليم</option>
            <option value="failed">فشل</option>
            <option value="pending">قيد الإرسال</option>
          </select>
        </div>

        <input
          type="text"
          placeholder="بحث باسم العميل أو نص الرسالة..."
          className="border rounded-lg px-3 py-2 text-sm w-full md:w-72"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* جدول الرسائل */}
      <div className="bg-white rounded-xl shadow p-4">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400">لا توجد رسائل مطابقة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-2 text-right">العميل</th>
                  <th className="py-2 text-right">الاتجاه</th>
                  <th className="py-2 text-right">الحالة</th>
                  <th className="py-2 text-right">النص</th>
                  <th className="py-2 text-right">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="py-2">
                      {m.clients?.business_name || "بدون عميل"}
                    </td>
                    <td className="py-2">
                      {m.direction === "in" ? "واردة" : "صادرة"}
                    </td>
                    <td className="py-2">
                      {m.status === "delivered" && (
                        <span className="text-green-600 font-medium">
                          تم التسليم
                        </span>
                      )}
                      {m.status === "failed" && (
                        <span className="text-red-500 font-medium">فشل</span>
                      )}
                      {m.status === "pending" && (
                        <span className="text-yellow-600 font-medium">
                          قيد الإرسال
                        </span>
                      )}
                      {!["delivered", "failed", "pending"].includes(
                        m.status
                      ) && <span>{m.status}</span>}
                    </td>
                    <td className="py-2 max-w-xl truncate">{m.text}</td>
                    <td className="py-2 text-gray-500">
                      {m.created_at
                        ? new Date(m.created_at).toLocaleString("ar-EG")
                        : "-"}
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
