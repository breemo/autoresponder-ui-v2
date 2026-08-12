import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const inputClass = "h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

function StatusBadge({ active }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
      <span className={`h-2 w-2 rounded-full ${active ? "bg-emerald-500" : "bg-slate-400"}`} />
      {active ? "مفعّل" : "معطّل"}
    </span>
  );
}

export default function AdminAutoReplies() {
  const [replies, setReplies] = useState([]);
  const [clients, setClients] = useState([]);
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

    if (clientFilter !== "all") query = query.eq("client_id", clientFilter);
    if (statusFilter !== "all") query = query.eq("is_active", statusFilter === "active");

    const { data, error } = await query;
    if (error) console.log(error);
    setReplies(data || []);
    setLoading(false);
  }

  useEffect(() => { loadClients(); }, []);
  useEffect(() => { loadReplies(); }, [clientFilter, statusFilter]);

  const filteredReplies = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return replies;
    return replies.filter((r) =>
      `${r.trigger_text || ""} ${r.reply_text || ""} ${r.clients?.business_name || ""} ${r.clients?.email || ""}`.toLowerCase().includes(s)
    );
  }, [replies, search]);

  const activeCount = replies.filter((r) => r.is_active).length;
  const inactiveCount = replies.length - activeCount;
  const uniqueClients = new Set(replies.map((r) => r.client_id).filter(Boolean)).size;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">AUTO REPLIES</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">الردود التلقائية</h2>
          <p className="mt-1 text-sm text-slate-500">إدارة كل الردود المعرّفة للعملاء من مكان واحد.</p>
        </div>
        <button onClick={loadReplies} className="h-10 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ تحديث</button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">إجمالي الردود</p><p className="mt-2 text-3xl font-black">{replies.length}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">مفعّلة</p><p className="mt-2 text-3xl font-black text-emerald-600">{activeCount}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">معطّلة</p><p className="mt-2 text-3xl font-black text-amber-600">{inactiveCount}</p></div>
        <div className={`${cardClass} p-5`}><p className="text-sm text-slate-500">عملاء لديهم ردود</p><p className="mt-2 text-3xl font-black text-indigo-600">{uniqueClients}</p></div>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <input className={`${inputClass} min-w-[260px] flex-1`} placeholder="ابحث بالعميل، الكلمة المفتاحية، أو نص الرد..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className={`${inputClass} min-w-[220px]`} value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
            <option value="all">كل العملاء</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.business_name} - {c.email}</option>)}
          </select>
          <select className={`${inputClass} min-w-[150px]`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">كل الحالات</option>
            <option value="active">مفعّلة</option>
            <option value="inactive">معطّلة</option>
          </select>
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-500">جارِ التحميل...</div>
        ) : filteredReplies.length === 0 ? (
          <div className="p-10 text-center text-slate-400">لا توجد ردود مطابقة.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-4 text-right">العميل</th>
                  <th className="px-5 py-4 text-right">الكلمة المفتاحية</th>
                  <th className="px-5 py-4 text-right">الرد</th>
                  <th className="px-5 py-4 text-right">الحالة</th>
                  <th className="px-5 py-4 text-right">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredReplies.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70">
                    <td className="px-5 py-4"><p className="font-bold text-slate-900">{r.clients?.business_name || "—"}</p><p className="text-xs text-slate-500">{r.clients?.email || ""}</p></td>
                    <td className="px-5 py-4"><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">{r.trigger_text || "—"}</span></td>
                    <td className="max-w-[420px] px-5 py-4 text-slate-600"><p className="line-clamp-2">{r.reply_text || "—"}</p></td>
                    <td className="px-5 py-4"><StatusBadge active={r.is_active} /></td>
                    <td className="px-5 py-4 text-slate-500">{r.created_at ? new Date(r.created_at).toLocaleDateString("ar") : "—"}</td>
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
