import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowPathIcon,
  BuildingStorefrontIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparklesIcon,
  UserGroupIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";

const emptyForm = {
  business_name: "",
  email: "",
  password: "",
  plan_id: "",
  subscription_type: "trial",
};

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "-";
  }
}

export default function AdminClients() {
  const [clients, setClients] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [pageSize, setPageSize] = useState(10);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setMsg("");

    const { data: plansData } = await supabase
      .from("plans")
      .select("id, name, price")
      .order("price", { ascending: true });
  
	const { data: clientsData, error } = await supabase
	  .from("clients")
	  .select(`
		id,
		business_name,
		email,
		plan_id,
		is_active,
		created_at,
		subscriptions (
		  id,
		  subscription_type,
		  status,
		  start_date,
		  end_date,
		  closed_at,
		  plan_id
		)
	  `)
	  .order("created_at", { ascending: false });
  
  

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

  const getPlan = (planId) => plans.find((pl) => pl.id === planId);

  const getPlanName = (planId) => {
    const plan = getPlan(planId);
    return plan ? `${plan.name} · $${plan.price}` : "No plan";
  };
  
  const getSubscription = (client) => {
	if (!client?.subscriptions?.length) return null;

	  return (
		client.subscriptions.find(
		  (s) => s.status === "active"
		) || client.subscriptions[0]
	  );
	};

	const getDaysRemaining = (endDate) => {
	  if (!endDate) return "-";

	  const now = new Date();
	  const end = new Date(endDate);

	  const diff = Math.ceil(
		(end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
	  );

	  if (diff < 0) return "Expired";

	  return `${diff} days`;
	};

  const filteredClients = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return clients.filter((client) => {
      const matchesSearch =
        !keyword ||
        client.business_name?.toLowerCase().includes(keyword) ||
        client.email?.toLowerCase().includes(keyword);

      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && client.is_active) ||
        (statusFilter === "inactive" && !client.is_active);

      const matchesPlan = planFilter === "all" || client.plan_id === planFilter;

      return matchesSearch && matchesStatus && matchesPlan;
    });
  }, [clients, planFilter, search, statusFilter]);

  const stats = useMemo(() => {
    const active = clients.filter((client) => client.is_active).length;
    const inactive = clients.length - active;
    const withPlan = clients.filter((client) => client.plan_id).length;

    return [
      {
        label: "Total Clients",
        value: clients.length,
        hint: "كل العملاء المسجلين",
        icon: UserGroupIcon,
        accent: "bg-indigo-50 text-indigo-600 ring-indigo-100",
      },
      {
        label: "Active Clients",
        value: active,
        hint: "عملاء مفعّلين حالياً",
        icon: CheckCircleIcon,
        accent: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      },
      {
        label: "Inactive",
        value: inactive,
        hint: "بحاجة لمراجعة أو تفعيل",
        icon: ArrowPathIcon,
        accent: "bg-amber-50 text-amber-600 ring-amber-100",
      },
      {
        label: "Assigned Plans",
        value: withPlan,
        hint: "عملاء مربوطين بباقات",
        icon: SparklesIcon,
        accent: "bg-sky-50 text-sky-600 ring-sky-100",
      },
    ];
  }, [clients]);

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setForm(emptyForm);
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
let createdSubscription = null;
    
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

if (form.plan_id) {
  const startDate = new Date();

  const endDate = new Date();

  if (form.subscription_type === "trial") {
    endDate.setDate(endDate.getDate() + 3);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }

const { data: subscriptionData, error: subscriptionError } = await supabase
  .from("subscriptions")
  .insert([
    {
      client_id: createdClient.id,
      plan_id: form.plan_id,
      subscription_type: form.subscription_type,
		status: "active",
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
    },
  ])
  .select()
  .single();

if (subscriptionError) throw subscriptionError;

createdSubscription = subscriptionData;
}
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

  setMsg(
  form.plan_id
    ? "✅ تم إنشاء العميل والمستخدم والاشتراك بنجاح"
    : "✅ تم إنشاء العميل والمستخدم بنجاح"
);
  
      setForm(emptyForm);
      setIsDrawerOpen(false);
      fetchData();
    } catch (error) {
      console.error(error);

      if (createdUser?.id) {
        await supabase.from("users").delete().eq("id", createdUser.id);
      }

if (createdSubscription?.id) {
  await supabase
    .from("subscriptions")
    .delete()
    .eq("id", createdSubscription.id);
}

      if (createdClient?.id) {
  await supabase
    .from("clients")
    .delete()
    .eq("id", createdClient.id);
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
      prev.map((c) => (c.id === id ? { ...c, is_active: !currentStatus } : c))
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Clients</h1>
          <p className="mt-2 text-sm text-slate-500">إدارة العملاء، الباقات، حالة التفعيل، والمنصات المرتبطة.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={fetchData} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50">
            <ArrowPathIcon className="h-5 w-5" /> تحديث
          </button>
          <button type="button" onClick={() => setIsDrawerOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:bg-indigo-700">
            <PlusIcon className="h-5 w-5" /> إضافة عميل
          </button>
        </div>
      </div>

      {msg && (
        <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-800">
          {msg}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-500">{item.label}</p>
                  <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                    {item.value}
                  </p>
                </div>
                <div className={`rounded-2xl p-3 ring-1 ${item.accent}`}>
                  <Icon className="h-6 w-6" />
                </div>
              </div>
              <p className="mt-4 text-sm text-slate-500">{item.hint}</p>
            </div>
          );
        })}
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-5 md:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">قائمة العملاء</h2>
              <p className="mt-1 text-sm text-slate-500">
                {filteredClients.length} من أصل {clients.length} عميل ظاهر حالياً
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(260px,1fr)_150px_160px_110px] xl:w-[820px]">
              <div className="relative">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="بحث باسم العميل أو الإيميل..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-indigo-200 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                />
              </div>

              <div className="relative">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-12 w-full appearance-none rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                >
                  <option value="all">كل الحالات</option>
                  <option value="active">مفعّل</option>
                  <option value="inactive">معطّل</option>
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>

              <div className="relative">
                <select
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  className="h-12 w-full appearance-none rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                >
                  <option value="all">كل الباقات</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>

              <div className="relative">
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="h-12 w-full appearance-none rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                >
                  <option value={5}>إظهار 5</option>
                  <option value={10}>إظهار 10</option>
                  <option value={20}>إظهار 20</option>
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center text-sm font-medium text-slate-500">
              جارِ تحميل العملاء...
            </div>
          ) : filteredClients.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center">
              <div className="rounded-3xl bg-slate-50 p-5 ring-1 ring-slate-100">
                <UserGroupIcon className="h-10 w-10 text-slate-400" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-slate-950">لا يوجد عملاء مطابقين</h3>
              <p className="mt-2 max-w-md text-sm text-slate-500">
                جرّب تعديل البحث أو الفلاتر، أو أضف عميل جديد من زر إضافة عميل.
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-xs uppercase tracking-[0.08em] text-slate-500">
                  <th className="px-6 py-4 font-semibold">Client</th>
                  <th className="px-6 py-4 font-semibold">Plan</th>
				  <th className="px-6 py-4 font-semibold">Subscription</th>
				  <th className="px-6 py-4 font-semibold">Expiry</th>
				  <th className="px-6 py-4 font-semibold">Remaining</th>
                  <th className="px-6 py-4 font-semibold">Platforms</th>
                  <th className="px-6 py-4 font-semibold">Status</th>
                  <th className="px-6 py-4 font-semibold">Created</th>
                  <th className="px-6 py-4 font-semibold">Last Active</th>
                  <th className="px-6 py-4 text-center font-semibold">Settings</th>
                  <th className="px-6 py-4 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredClients.slice(0, pageSize).map((client, index) => {
					  const initials = (client.business_name || client.email || "C")
						.slice(0, 2)
						.toUpperCase();

					  const subscription = getSubscription(client);

					  const currentPlanId =
						subscription?.plan_id || client.plan_id;

					  return (
                    <tr key={client.id} className="group transition hover:bg-slate-50/80">
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-sm font-bold text-white shadow-sm">
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-950">
                              {client.business_name || "Unnamed Client"}
                            </p>
                            <p className="mt-1 truncate text-sm text-slate-500">{client.email}</p>
                          </div>
                        </div>
                      </td>

                      <td className="px-6 py-5">
                        <span className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                          {getPlanName(currentPlanId)}
                        </span>
                      </td>

						<td className="px-6 py-5">
						  {subscription ? (
							<span className="inline-flex rounded-full border px-3 py-1 text-xs font-semibold">
							  {subscription?.subscription_type || "-"}
							</span>
						  ) : (
							"-"
						  )}
						</td>

						<td className="px-6 py-5 text-slate-500">
						  {subscription?.end_date
							? formatDate(subscription.end_date)
							: "-"}
						</td>

						<td className="px-6 py-5 text-slate-500">
						  {subscription?.end_date
							? getDaysRemaining(subscription.end_date)
							: "-"}
						</td>


                      <td className="px-6 py-5">
                        <div className="flex gap-2">
                          {(["✈️", "☘", "◎", "f"].slice(index % 3, index % 3 + 2)).map((icon, i) => (
                            <span key={i} className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-xs font-bold text-slate-600">{icon}</span>
                          ))}
                        </div>
                      </td>

                      <td className="px-6 py-5">
                        <button
                          onClick={() => toggleStatus(client.id, client.is_active)}
                          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold transition ${
                            client.is_active
                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 hover:bg-emerald-100"
                              : "bg-rose-50 text-rose-700 ring-1 ring-rose-100 hover:bg-rose-100"
                          }`}
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${
                              client.is_active ? "bg-emerald-500" : "bg-rose-500"
                            }`}
                          />
                          {client.is_active ? "Active" : "Inactive"}
                        </button>
												  
                      </td>

                      <td className="px-6 py-5 text-slate-500">{formatDate(client.created_at)}</td>

                      <td className="px-6 py-5 text-slate-500">منذ {index + 1} يوم</td>

                      <td className="px-6 py-5 text-center">
                        <Link
                          to={`/admin/client/${client.id}`}
                          className="inline-flex items-center justify-center rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100"
                        >
                          إعدادات العميل
                        </Link>
                      </td>

                      <td className="px-6 py-5 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => deleteClient(client.id)}
                            className="rounded-full border border-rose-100 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100"
                          >
                            حذف
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {isDrawerOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm" onClick={closeDrawer} />

          <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">
                    New Client
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold text-slate-950">إضافة عميل جديد</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    أدخل بيانات العميل الأساسية، وسيتم إنشاء مستخدم وربطه تلقائياً.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <form onSubmit={addClient} className="flex flex-1 flex-col overflow-y-auto">
              <div className="flex-1 space-y-5 px-6 py-6">
                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl bg-indigo-600 p-2 text-white">
                      <SparklesIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-950">Client onboarding</p>
                      <p className="mt-1 text-sm leading-6 text-slate-500">
                        بعد الإضافة، تقدر تدخل على إعدادات العميل لتفعيل المنصات والميزات.
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">الاسم التجاري</label>
                  <input
                    type="text"
                    name="business_name"
                    value={form.business_name}
                    onChange={handleChange}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50"
                    placeholder="مثال: شركة المستقبل للتشطيبات"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">البريد الإلكتروني</label>
                  <input
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={handleChange}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50"
                    placeholder="client@example.com"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">كلمة المرور الأولية</label>
                  <input
                    type="text"
                    name="password"
                    value={form.password}
                    onChange={handleChange}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50"
                    placeholder="مثال: 12345"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">الخطة</label>
                  <select
                    name="plan_id"
                    value={form.plan_id}
                    onChange={handleChange}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50"
                  >
                    <option value="">بدون خطة</option>
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name} - ${plan.price}
                    </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700"> نوع الاشتراك</label>
				  <select
					name="subscription_status"
					value={form.subscription_status}
					onChange={handleChange}
					className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50">

					<option value="trial">Trial</option>
					<option value="paid">Paid</option>
				  </select>              
				</div>
			  </div>
              
              <div className="border-t border-slate-100 bg-white px-6 py-5">
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={closeDrawer}
                    className="rounded-2xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PlusIcon className="h-5 w-5" />
                    {submitting ? "جارِ الإضافة..." : "إضافة العميل"}
                  </button>
                </div>
              </div>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
