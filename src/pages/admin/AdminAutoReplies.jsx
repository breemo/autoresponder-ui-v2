import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AdminAutoReplies() {
  const [replies, setReplies] = useState([]);
  const [clients, setClients] = useState([]);

  // Filters
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const [loading, setLoading] = useState(true);

  async function loadClients() {
    const { data } = await supabase
      .from("clients")
      .select("id, business_name, email")
      .order("business_name", { ascending: true });

    setClients(data || []);
  }

  async function loadReplies() {
    setLoading(true);

    let query = supabase
      .from("auto_replies")
      .select("*, clients:client_id(business_name,email)")
      .order("created_at", { ascending: false });

    // Filter by client
    if (clientFilter !== "all") {
      query = query.eq("client_id", clientFilter);
    }

    // Filter by status
    if (statusFilter !== "all") {
      query = query.eq("is_active", statusFilter === "active");
    }

    const { data, error } = await query;
    if (error) console.log(error);

    let filtered = data || [];

    // Search filter
    if (search.trim()) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.trigger_text.toLowerCase().includes(s) ||
          r.reply_text.toLowerCase().includes(s)
      );
    }

    setReplies(filtered);
    setLoading(false);
  }

  useEffect(() => {
    loadClients();
    loadReplies();
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">الردود التلقائية</h1>
      <p className="text-gray-500 mb-6">
        عرض جميع الردود التلقائية الخاصة بكل العملاء.
      </p>

      {/* Filters */}
      <div className="bg-white shadow rounded-xl p-5 mb-8">

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">

          {/* Search */}
          <input
            className="border p-2 rounded"
            placeholder="بحث..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {/* Filter by Client */}
          <select
            className="border p-2 rounded"
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
          >
            <option value="all">كل العملاء</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.business_name} ({c.email})
              </option>
            ))}
          </select>

          {/* Status */}
          <select
            className="border p-2 rounded"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">الكل</option>
            <option value="active">مفعلة</option>
            <option value="inactive">غير مفعلة</option>
          </select>

          <button
            onClick={loadReplies}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            تحديث
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white shadow rounded-xl p-5">
        {loading ? (
          <p>جاري التحميل...</p>
        ) : replies.length === 0 ? (
          <p className="text-gray-400">لا توجد ردود.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-gray-500">
              <tr>
                <th className="py-2">العميل</th>
                <th className="py-2">المحفز</th>
                <th className="py-2">الرد</th>
                <th className="py-2">الحالة</th>
              </tr>
            </thead>

            <tbody>
              {replies.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="py-2">{r.clients?.business_name || "—"}</td>
                  <td className="py-2">{r.trigger_text}</td>
                  <td className="py-2 max-w-xs truncate">{r.reply_text}</td>
                  <td className="py-2">
                    {r.is_active ? "✓ مفعلة" : "• غير مفعلة"}
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
