import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "../../context/AuthContext.jsx";

// Auto Responder ADMIN Overview — the platform operator's dashboard.
//
// Answers SaaS-operator questions (how many clients, how many active
// subscriptions, how much platform usage, which clients consume the most,
// how are clients distributed across plans/channels, what needs
// attention) — NOT client-style "my integrations / my automation".
//
// All numbers come from the server-side, admin-only aggregate endpoint
// (GET /api/system-settings?resource=overview — verifies users.role ===
// "admin" server-side, service-role DB access, platform-wide). The browser
// cannot obtain platform-wide data on its own. No fake/demo fallback data
// anywhere in this file.

const CHANNEL_META = {
  whatsapp: { label: "WhatsApp", tone: "bg-emerald-50 text-emerald-600 border-emerald-100" },
  facebook: { label: "Facebook", tone: "bg-blue-50 text-blue-600 border-blue-100" },
  instagram: { label: "Instagram", tone: "bg-pink-50 text-pink-600 border-pink-100" },
  telegram: { label: "Telegram", tone: "bg-sky-50 text-sky-600 border-sky-100" },
};

function StatCard({ title, value, subtitle, tone = "indigo", icon = "•" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
  };
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-xl ${tones[tone]}`}>{icon}</div>
      <p className="mt-5 text-sm font-medium text-slate-500">{title}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
      {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
    </div>
  );
}

function Card({ title, subtitle, action, children }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-950">{title}</h2>
          {subtitle ? <p className="text-xs text-slate-400">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyBox({ children }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-center text-sm text-slate-400">{children}</div>;
}

function num(n) {
  return Number(n || 0).toLocaleString();
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function weekdayLabel(isoDay) {
  try {
    return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("ar-EG", { weekday: "short" });
  } catch {
    return isoDay;
  }
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    fetchOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchOverview() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/system-settings?resource=overview&actor_user_id=${encodeURIComponent(user?.id || "")}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false || !data?.overview) {
        throw new Error(data?.message || "فشل تحميل بيانات المنصة");
      }
      setOverview(data.overview);
    } catch (err) {
      console.error(err);
      setOverview(null);
      setError(err.message || "فشل تحميل بيانات المنصة");
    } finally {
      setLoading(false);
    }
  }

  const o = overview;
  const chartData = (o?.message_activity?.days || []).map((d) => ({
    day: weekdayLabel(d.day),
    inbound: d.inbound || 0,
    outbound: d.outbound || 0,
  }));
  const channelData = (o?.channel_distribution || []).map((c) => ({
    name: CHANNEL_META[c.channel]?.label || c.channel,
    value: c.active || 0,
  }));
  const attentionCount =
    (o?.attention?.expiring_soon?.length || 0) + (o?.attention?.expired_active?.length || 0);

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-950">نظرة عامة على المنصة</h1>
          <p className="text-sm text-slate-500">مؤشرات تشغيل Auto Responder عبر جميع العملاء</p>
        </div>
        <button
          onClick={fetchOverview}
          disabled={loading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          ↻ تحديث
        </button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      {loading ? (
        <EmptyBox>جارِ تحميل بيانات المنصة...</EmptyBox>
      ) : !o ? (
        <EmptyBox>لا تتوفر بيانات المنصة حالياً.</EmptyBox>
      ) : (
        <>
          {/* ---- KPI cards ---- */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title="إجمالي العملاء"
              value={num(o.clients.total)}
              subtitle={`${num(o.clients.active)} مفعّل · ${num(o.clients.inactive)} موقوف`}
              icon="👥"
            />
            <StatCard
              title="الاشتراكات النشطة"
              value={num(o.subscriptions.active)}
              subtitle={o.subscriptions.expiring_soon ? `${num(o.subscriptions.expiring_soon)} تنتهي خلال 7 أيام` : "لا اشتراكات قريبة الانتهاء"}
              tone="emerald"
              icon="✅"
            />
            <StatCard
              title="المحادثات المفتوحة"
              value={num(o.conversations.open)}
              subtitle={`${num(o.conversations.waiting_human)} بانتظار موظف`}
              tone="sky"
              icon="💬"
            />
            <StatCard
              title="رسائل اليوم"
              value={num(o.messages.today)}
              subtitle={`${num(o.messages.last_7_days)} خلال آخر 7 أيام`}
              tone="amber"
              icon="✉️"
            />
          </div>

          {/* ---- Activity + Channels ---- */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.7fr_1fr]">
            <Card title="نشاط الرسائل عبر المنصة" subtitle="الوارد والصادر خلال آخر 7 أيام (بتوقيت UTC)">
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="adminInbound" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#4f46e5" stopOpacity={0.18} /><stop offset="95%" stopColor="#4f46e5" stopOpacity={0} /></linearGradient>
                      <linearGradient id="adminOutbound" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.16} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                    <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="inbound" name="وارد" stroke="#4f46e5" strokeWidth={2.5} fill="url(#adminInbound)" />
                    <Area type="monotone" dataKey="outbound" name="صادر" stroke="#10b981" strokeWidth={2.5} fill="url(#adminOutbound)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="توزيع القنوات" subtitle="حسابات القنوات المتصلة لدى العملاء">
              {channelData.every((c) => !c.value) ? (
                <EmptyBox>لا توجد حسابات قنوات متصلة بعد.</EmptyBox>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={channelData} layout="vertical" margin={{ left: 12, right: 20, top: 10, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                      <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                      <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} width={78} tick={{ fill: "#475569", fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="value" name="حسابات" fill="#4f46e5" radius={[0, 8, 8, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {(o.channel_distribution || []).map((c) => (
                  <div key={c.channel} className={`flex items-center justify-between rounded-xl border px-3 py-2 ${CHANNEL_META[c.channel]?.tone || "border-slate-100 bg-slate-50 text-slate-600"}`}>
                    <span className="font-bold">{CHANNEL_META[c.channel]?.label || c.channel}</span>
                    <span className="font-black">{num(c.active)}{c.total !== c.active ? ` / ${num(c.total)}` : ""}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* ---- Top clients + Plan distribution ---- */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card
              title="أكثر العملاء استهلاكاً"
              subtitle={`حسب عدد الرسائل خلال آخر ${o.top_clients.window_days} يوماً`}
              action={<Link to="/admin/clients" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">كل العملاء</Link>}
            >
              {(o.top_clients.clients || []).length === 0 ? (
                <EmptyBox>لا توجد رسائل خلال هذه الفترة.</EmptyBox>
              ) : (
                <div className="space-y-2">
                  {o.top_clients.clients.map((c, i) => (
                    <div key={c.client_id} className="flex items-center gap-3 rounded-2xl border border-slate-100 p-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-xs font-black text-indigo-600">{i + 1}</div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900">{c.client_name || "عميل غير مُسمّى"}</p>
                        <p className="text-xs text-slate-400">{num(c.ai_messages)} رد بالذكاء الاصطناعي</p>
                      </div>
                      <span className="text-sm font-black text-slate-950">{num(c.messages)}</span>
                    </div>
                  ))}
                  {o.top_clients.truncated && (
                    <p className="pt-1 text-[11px] text-slate-400">* الترتيب مبني على عيّنة كبيرة من الرسائل وقد لا يشمل كامل الحجم.</p>
                  )}
                </div>
              )}
            </Card>

            <Card title="توزيع الباقات" subtitle="عدد العملاء في كل باقة" action={<Link to="/admin/plans" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">الباقات</Link>}>
              {(o.plan_distribution || []).length === 0 ? (
                <EmptyBox>لا يوجد عملاء بعد.</EmptyBox>
              ) : (
                <div className="space-y-2">
                  {o.plan_distribution.map((p) => {
                    const max = Math.max(...o.plan_distribution.map((x) => x.clients), 1);
                    const pct = Math.round((p.clients / max) * 100);
                    return (
                      <div key={p.plan || "__none__"}>
                        <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-600">
                          <span>{p.plan || "بدون باقة"}</span>
                          <span>{num(p.clients)}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-indigo-600" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* ---- Recent clients + Attention ---- */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card title="أحدث العملاء" subtitle="آخر الحسابات المُنشأة" action={<Link to="/admin/clients" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">عرض الكل</Link>}>
              {(o.recent_clients || []).length === 0 ? (
                <EmptyBox>لا يوجد عملاء بعد.</EmptyBox>
              ) : (
                <div className="space-y-2">
                  {o.recent_clients.map((c) => (
                    <div key={c.client_id} className="flex items-center gap-3 rounded-2xl border border-slate-100 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900">{c.business_name || c.email || "عميل غير مُسمّى"}</p>
                        <p className="truncate text-xs text-slate-400">
                          {c.plan || "بدون باقة"}
                          {c.subscription_status ? ` · ${c.subscription_status}` : ""}
                          {` · ${formatDate(c.created_at)}`}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${c.is_active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                        {c.is_active ? "مفعّل" : "موقوف"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="يتطلب انتباهاً" subtitle="اشتراكات تحتاج مراجعة من مشغّل المنصة">
              {attentionCount === 0 ? (
                <EmptyBox>لا يوجد ما يتطلب انتباهاً حالياً.</EmptyBox>
              ) : (
                <div className="space-y-2">
                  {(o.attention.expired_active || []).map((s) => (
                    <div key={`exp-${s.client_id}-${s.end_date}`} className="flex items-center gap-3 rounded-2xl border border-rose-100 bg-rose-50/50 p-3">
                      <span className="rounded-lg bg-rose-100 px-2 py-1 text-[11px] font-black text-rose-700">منتهٍ</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900">{s.client_name || "عميل غير مُسمّى"}</p>
                        <p className="text-xs text-slate-500">اشتراك نشط لكنه تجاوز تاريخ الانتهاء بـ {num(s.days_overdue)} يوم</p>
                      </div>
                      <span className="text-xs text-slate-400">{formatDate(s.end_date)}</span>
                    </div>
                  ))}
                  {(o.attention.expiring_soon || []).map((s) => (
                    <div key={`soon-${s.client_id}-${s.end_date}`} className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50/50 p-3">
                      <span className="rounded-lg bg-amber-100 px-2 py-1 text-[11px] font-black text-amber-700">قريب الانتهاء</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900">{s.client_name || "عميل غير مُسمّى"}</p>
                        <p className="text-xs text-slate-500">ينتهي خلال {num(s.days_left)} يوم</p>
                      </div>
                      <span className="text-xs text-slate-400">{formatDate(s.end_date)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
