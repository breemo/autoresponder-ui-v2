import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

export default function ClientLeads() {
  const { user } = useAuth();
  const clientId = user?.client_id || user?.id;

  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  async function fetchLeads() {
    try {
      setLoading(true);
      setError("");

      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setLeads(data || []);
    } catch (err) {
      console.error(err);
      setError("فشل في جلب البيانات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (clientId) fetchLeads();
  }, [clientId]);

  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      if (!search.trim()) return true;
      return `${lead.name || ""} ${lead.phone || ""}`
        .toLowerCase()
        .includes(search.toLowerCase());
    });
  }, [leads, search]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">أرقام التواصل للزبائن</h1>
        <p className="text-gray-500">قائمة العملاء الذين تم جمع بياناتهم.</p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 p-4 rounded-xl">{error}</div>
      )}

      <div className="bg-white shadow rounded-xl p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
          <input
            className="border p-2 rounded md:w-80"
            placeholder="بحث بالاسم أو الرقم..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <button
            onClick={fetchLeads}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 md:w-32"
          >
            تحديث
          </button>
        </div>

        {loading ? (
          <p className="text-gray-500 text-center py-8">جارِ التحميل...</p>
        ) : filteredLeads.length === 0 ? (
          <p className="text-gray-400 text-center py-8">لا يوجد Leads</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-3">الاسم</th>
                  <th className="py-3">الرقم</th>
                  <th className="py-3">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead) => (
                  <tr key={lead.id} className="border-b last:border-b-0">
                    <td className="py-3">{lead.name || "—"}</td>
                    <td className="py-3">{lead.phone || "—"}</td>
                    <td className="py-3">
                      {lead.created_at
                        ? new Date(lead.created_at).toLocaleString("ar-EG")
                        : "—"}
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
