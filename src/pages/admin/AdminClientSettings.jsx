import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  BoltIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

const FEATURE_META = {
  telegram: {
    title: "Telegram",
    accent: "blue",
    icon: PaperAirplaneIcon,
    description: "ربط بوت تيليجرام واستقبال الرسائل عبر Webhook.",
  },
  facebook: {
    title: "Facebook Page",
    accent: "indigo",
    icon: LinkIcon,
    description: "ربط صفحة فيسبوك والرد على رسائل Messenger.",
  },
  instagram: {
    title: "Instagram",
    accent: "pink",
    icon: SparklesIcon,
    description: "تجهيز ربط Instagram Business والرسائل لاحقاً.",
  },
  whatsapp: {
    title: "WhatsApp Cloud API",
    accent: "emerald",
    icon: BoltIcon,
    description: "ربط WhatsApp Cloud API لإدارة الرسائل والردود.",
  },
  ai_auto_reply: {
    title: "AI Auto Reply",
    accent: "violet",
    icon: SparklesIcon,
    description: "إعدادات الرد الذكي ونبرة الرد ومعلومات النشاط.",
  },
};

const ACCENT_CLASSES = {
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-100",
  pink: "bg-pink-50 text-pink-700 ring-pink-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  violet: "bg-violet-50 text-violet-700 ring-violet-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
};

function getFeatureMeta(feature) {
  const slug = String(feature?.slug || "").toLowerCase();
  const fallback = {
    title: feature?.name || slug || "Feature",
    accent: "slate",
    icon: Cog6ToothIcon,
    description: feature?.description || "إعدادات هذه الميزة للعميل.",
  };
  return { ...fallback, ...(FEATURE_META[slug] || {}) };
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "غير مكتمل";
  if (text.length <= 8) return "••••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function getConfiguredCount(feature, values) {
  const fields =
    feature?.fields && typeof feature.fields === "object" && !Array.isArray(feature.fields)
      ? Object.keys(feature.fields)
      : [];

  if (!fields.length) return { done: 0, total: 0 };

  const done = fields.filter((field) => String(values?.[field] || "").trim()).length;
  return { done, total: fields.length };
}

function buildSetupLinks({ activeFeature, featureValues }) {
  const slug = activeFeature?.slug;
  const channelKey = String(featureValues?.channelKey || "").trim();
  const webhookBase = String(import.meta.env.VITE_WEBHOOK_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");

  const links = [];

  if (slug && webhookBase && channelKey) {
    links.push({
      label: "Webhook URL",
      value: `${webhookBase}/${slug}/${channelKey}`,
      type: "webhook",
    });
  }

  if (slug === "telegram") {
    const botToken = String(featureValues?.["Bot Token"] || "").trim();
    const webhookUrl = links.find((item) => item.type === "webhook")?.value;

    if (botToken && webhookUrl) {
      links.push({
        label: "رابط تفعيل Telegram Webhook",
        value: `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`,
        type: "activation",
      });
    }
  }

  return links;
}

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

function getRemainingDays(endDate) {
  if (!endDate) return 0;

  const now = new Date();
  const end = new Date(endDate);

  const diff = end.getTime() - now.getTime();

  return Math.max(
    0,
    Math.ceil(diff / (1000 * 60 * 60 * 24))
  );
}

export default function AdminClientSettings({ clientIdOverride }) {
  const params = useParams();
  const effectiveClientId = clientIdOverride || params.id;
  const { user } = useAuth();

  const [client, setClient] = useState(null);
  const [plan, setPlan] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeSubscription, setActiveSubscription] = useState(null);
  
  const [plansList, setPlansList] = useState([]);

  const [subscriptionDrawerOpen, setSubscriptionDrawerOpen] = useState(false);
  const [savingSubscription, setSavingSubscription] = useState(false);

  const [subscriptionForm, setSubscriptionForm] = useState({
	  plan_id: "",
	  subscription_type: "paid",
	  duration: "1",
  });

  const [features, setFeatures] = useState([]);
  const [featureSettings, setFeatureSettings] = useState({});

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);
  const [settingsRowId, setSettingsRowId] = useState(null);
  const [featureValues, setFeatureValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [showTelegramGuide, setShowTelegramGuide] = useState(false);
  const [copiedValue, setCopiedValue] = useState("");

  useEffect(() => {
    if (effectiveClientId) {
      fetchClientAndFeatures(effectiveClientId);
    } else {
      setLoading(false);
      setMsg("❌ لم يتم تحديد العميل");
    }
  }, [effectiveClientId]);

  async function fetchClientAndFeatures(clientId) {
    setLoading(true);
    setMsg("");

    try {
      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .select("id, business_name, email, plan_id")
        .eq("id", clientId)
        .single();

      if (clientError || !clientData) {
        console.error(clientError);
        setMsg("❌ لم يتم العثور على هذا العميل");
        setLoading(false);
        return;
      }

      setClient(clientData);

      let planData = null;
      if (clientData.plan_id) {
        const { data, error } = await supabase
          .from("plans")
          .select("id, name, allow_self_edit")
          .eq("id", clientData.plan_id)
          .maybeSingle();

        if (error) console.error(error);
        planData = data || null;
      }
      setPlan(planData);

	const { data: plansData } = await supabase
	  .from("plans")
	  .select("id,name,price")
	  .order("price", { ascending: true });

	setPlansList(plansData || []);


	const { data: subscriptionsData, error: subscriptionsError } =
	  await supabase
		.from("subscriptions")
		.select(`
		 id,
		  subscription_type,
		  status,
		  start_date,
		  end_date,
		  closed_at,
		  created_at,
		  plans (
			name
		  )
		`)
		.eq("client_id", clientId)
		.order("created_at", { ascending: false });

	if (subscriptionsError) {
	  console.error(subscriptionsError);
	} else {
	  setSubscriptions(subscriptionsData || []);
	  
	  const activeSub = (subscriptionsData || []).find(
		  (s) => s.status === "active"
		);

		setActiveSubscription(activeSub || null);
	}


      if (!clientData.plan_id) {
        setFeatures([]);
        setFeatureSettings({});
        setLoading(false);
        return;
      }

      const { data: pfData, error: pfError } = await supabase
        .from("plan_features")
        .select("feature_id")
        .eq("plan_id", clientData.plan_id);

      if (pfError) {
        console.error(pfError);
        setMsg("⚠️ تعذر جلب ميزات الخطة");
        setFeatures([]);
        setLoading(false);
        return;
      }

      const featureIds = (pfData || []).map((x) => x.feature_id).filter(Boolean);
      if (!featureIds.length) {
        setFeatures([]);
        setFeatureSettings({});
        setLoading(false);
        return;
      }

      const { data: featuresData, error: featuresError } = await supabase
        .from("features")
        .select("id, name, slug, description, fields")
        .in("id", featureIds);

      if (featuresError) {
        console.error(featuresError);
        setMsg("⚠️ تعذر جلب قائمة الميزات");
        setFeatures([]);
      } else {
        setFeatures(featuresData || []);
      }

      const { data: integrationsData, error: integrationsError } = await supabase
        .from("client_feature_integrations")
        .select("id, feature_id, is_active, config")
        .eq("client_id", clientId);

      if (integrationsError) {
        console.error(integrationsError);
        setFeatureSettings({});
      } else {
        const settingsMap = {};
        (integrationsData || []).forEach((row) => {
          settingsMap[row.feature_id] = row;
        });
        setFeatureSettings(settingsMap);
      }
    } catch (err) {
      console.error(err);
      setMsg("❌ حدث خطأ غير متوقع أثناء جلب البيانات");
    }

    setLoading(false);
  }

  async function openFeatureDrawer(feature) {
    if (!effectiveClientId) return;

    setMsg("");
    setActiveFeature(feature);
    setDrawerOpen(true);
    setSaving(false);
    setShowTelegramGuide(false);
    setCopiedValue("");

    const isAdmin = user?.role === "admin";
    const clientCanEdit = plan?.allow_self_edit === true;
    setReadOnly(!isAdmin && !clientCanEdit);

    const { data, error } = await supabase
      .from("client_feature_integrations")
      .select("id, config")
      .eq("client_id", effectiveClientId)
      .eq("feature_id", feature.id)
      .maybeSingle();

    if (error) console.error(error);

    setSettingsRowId(data?.id || null);

    const fieldsDef =
      feature.fields && typeof feature.fields === "object" && !Array.isArray(feature.fields)
        ? feature.fields
        : {};

    const existingSettings = data?.config || {};

    const initialValues = {};
    Object.entries(fieldsDef).forEach(([field]) => {
      initialValues[field] = existingSettings[field] ?? "";
    });

    setFeatureValues(initialValues);
  }

  function closeFeatureDrawer() {
    setDrawerOpen(false);
    setActiveFeature(null);
    setFeatureValues({});
    setSettingsRowId(null);
    setSaving(false);
    setShowTelegramGuide(false);
    setCopiedValue("");
  }

  function handleFieldChange(fieldName, value) {
    setFeatureValues((prev) => ({ ...prev, [fieldName]: value }));
  }

	function openSubscriptionDrawer() {
	  setSubscriptionForm({
		plan_id: client?.plan_id || "",
		subscription_type: "paid",
		duration: "1",
	  });

	  setSubscriptionDrawerOpen(true);
	}

	function closeSubscriptionDrawer() {
	  setSubscriptionDrawerOpen(false);
	}

async function saveSubscription() {
  if (!subscriptionForm.plan_id) {
    setMsg("⚠️ يرجى اختيار الخطة");
    return;
  }

  try {
    setSavingSubscription(true);

    const { data: currentSubscriptions } =
      await supabase
        .from("subscriptions")
        .select("id,status,end_date")
        .eq("client_id", effectiveClientId)
        .in("status", ["active", "trial"]);

    if (currentSubscriptions?.length) {
      const confirmReplace = window.confirm(
        "يوجد اشتراك فعال حالياً، هل تريد استبداله؟"
      );

      if (!confirmReplace) {
        setSavingSubscription(false);
        return;
      }

      await supabase
        .from("subscriptions")
        .update({
			status: "cancelled",
			closed_at: new Date().toISOString(),
        })
        .eq("client_id", effectiveClientId)
        .in("status", ["active", "trial"]);
    }

    const startDate = new Date();

    const endDate = calculateEndDate(
      subscriptionForm.subscription_type,
      subscriptionForm.duration
    );

    const { error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .insert([
          {
            client_id: effectiveClientId,
            plan_id: subscriptionForm.plan_id,
            subscription_type: subscriptionForm.subscription_type,
			status: "active",
            start_date: startDate.toISOString(),
            end_date: endDate,
          },
        ]);

    if (subscriptionError) {
      throw subscriptionError;
    }

    await supabase
      .from("clients")
      .update({
        plan_id: subscriptionForm.plan_id,
      })
      .eq("id", effectiveClientId);

    await fetchClientAndFeatures(
      effectiveClientId
    );

    closeSubscriptionDrawer();

    setMsg("✅ تم إنشاء الاشتراك بنجاح");
  } catch (err) {
    console.error(err);

    setMsg(
      "❌ فشل إنشاء الاشتراك: " +
      (err?.message || "Unknown Error")
    );
  }

  setSavingSubscription(false);
}


	function getStatusClass(status) {
	  switch (status) {
		case "active":
		  return "bg-emerald-50 text-emerald-700 ring-emerald-100";

		case "trial":
		  return "bg-blue-50 text-blue-700 ring-blue-100";

		case "expired":
		  return "bg-rose-50 text-rose-700 ring-rose-100";

		case "suspended":
		  return "bg-amber-50 text-amber-700 ring-amber-100";

		default:
		  return "bg-slate-100 text-slate-700 ring-slate-200";
	  }
	}

function calculateEndDate(status, duration) {
  const startDate = new Date();

  if (subscriptionType === "trial") {
    startDate.setDate(startDate.getDate() + 3);
    return startDate.toISOString();
  }

  startDate.setMonth(
    startDate.getMonth() + Number(duration || 1)
  );

  return startDate.toISOString();
}


  async function copyToClipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(""), 1500);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSaveFeature(e) {
    e.preventDefault();
    if (readOnly) return;
    if (!activeFeature || !effectiveClientId) return;

    setSaving(true);
    setMsg("");

    try {
      if (settingsRowId) {
        const { error } = await supabase
          .from("client_feature_integrations")
          .update({ config: featureValues })
          .eq("id", settingsRowId);

        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("client_feature_integrations")
          .insert([
            {
              client_id: effectiveClientId,
              feature_id: activeFeature.id,
              config: featureValues,
            },
          ])
          .select("id")
          .single();

        if (error) throw error;
        setSettingsRowId(data.id);
      }

      setMsg("✅ تم حفظ الإعدادات بنجاح");

      const { data: refreshed, error: refError } = await supabase
        .from("client_feature_integrations")
        .select("id, feature_id, is_active, config")
        .eq("client_id", effectiveClientId)
        .eq("feature_id", activeFeature.id)
        .maybeSingle();

      if (!refError && refreshed) {
        setSettingsRowId(refreshed.id);
        setFeatureValues(refreshed.config || {});
        setFeatureSettings((prev) => ({ ...prev, [activeFeature.id]: refreshed }));
      }
    } catch (err) {
      console.error("Save Error:", err);
      setMsg("❌ خطأ أثناء حفظ الإعدادات: " + (err?.message || "غير معروف"));
    }

    setSaving(false);
  }

  const isAdmin = user?.role === "admin";
  const clientCanEdit = plan?.allow_self_edit === true;
  const isTelegramFeature = activeFeature?.slug === "telegram";
  const setupLinks = useMemo(
    () => buildSetupLinks({ activeFeature, featureValues }),
    [activeFeature, featureValues]
  );

  const configuredFeatures = features.filter((feature) => {
    const config = featureSettings[feature.id]?.config || {};
    const { done, total } = getConfiguredCount(feature, config);
    return total > 0 && done === total;
  }).length;

  const partialFeatures = features.filter((feature) => {
    const config = featureSettings[feature.id]?.config || {};
    const { done, total } = getConfiguredCount(feature, config);
    return total > 0 && done > 0 && done < total;
  }).length;

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div className="mx-auto mb-4 h-10 w-10 animate-pulse rounded-full bg-indigo-100" />
        <p className="text-sm text-slate-500">جارِ تحميل إعدادات الميزات...</p>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="rounded-3xl border border-red-100 bg-red-50 p-6 text-red-700">
        {msg || "لم يتم العثور على العميل"}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">
            <SparklesIcon className="h-4 w-4" />
            Feature Control Center
          </div>
          <h1 className="text-2xl font-bold text-slate-950">إعدادات ميزات العميل</h1>
          <p className="mt-1 text-sm text-slate-500">
            {client.business_name} • {client.email} • الخطة: {plan?.name || "بدون خطة"}
          </p>
        </div>

        <button
          type="button"
          onClick={() => fetchClientAndFeatures(effectiveClientId)}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          تحديث
        </button>
      </div>

      {msg && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">الميزات المتاحة</p>
          <p className="mt-3 text-3xl font-bold text-slate-950">{features.length}</p>
          <p className="mt-1 text-xs text-slate-400">حسب خطة العميل الحالية</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">إعدادات مكتملة</p>
          <p className="mt-3 text-3xl font-bold text-emerald-600">{configuredFeatures}</p>
          <p className="mt-1 text-xs text-slate-400">ميزات جاهزة للاستخدام</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">بحاجة استكمال</p>
          <p className="mt-3 text-3xl font-bold text-amber-500">{partialFeatures}</p>
          <p className="mt-1 text-xs text-slate-400">فيها بيانات ناقصة</p>
        </div>
      </div>

      {!isAdmin && !clientCanEdit && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
          <LockClosedIcon className="mt-0.5 h-5 w-5" />
          <p>لا تتيح خطتك الحالية تعديل الإعدادات بنفسك. الرجاء التواصل مع المسؤول.</p>
        </div>
      )}

      {features.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Cog6ToothIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="font-semibold text-slate-700">لا توجد ميزات مفعّلة ضمن خطة هذا العميل.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {features.map((feature) => {
            const meta = getFeatureMeta(feature);
            const Icon = meta.icon;
            const config = featureSettings[feature.id]?.config || {};
            const row = featureSettings[feature.id];
            const { done, total } = getConfiguredCount(feature, config);
            const isComplete = total > 0 && done === total;
            const isPartial = total > 0 && done > 0 && done < total;
            const statusText = isComplete ? "جاهزة" : isPartial ? "ناقصة" : "غير مهيأة";
            const statusClass = isComplete
              ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
              : isPartial
                ? "bg-amber-50 text-amber-700 ring-amber-100"
                : "bg-slate-100 text-slate-600 ring-slate-200";

            return (
              <div key={feature.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ${ACCENT_CLASSES[meta.accent] || ACCENT_CLASSES.slate}`}>
                      <Icon className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-slate-950">{meta.title}</h3>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusClass}`}>
                          {statusText}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-500">{feature.description || meta.description}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openFeatureDrawer(feature)}
                    className="inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                    تعديل
                  </button>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">الحقول</p>
                    <p className="mt-1 font-bold text-slate-800">{done}/{total}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">الحالة</p>
                    <p className="mt-1 font-bold text-slate-800">{row?.is_active === false ? "معطلة" : "مفعلة"}</p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">Channel Key</p>
                    <p className="mt-1 truncate font-bold text-slate-800">{config.channelKey || "—"}</p>
                  </div>
                </div>

                {Object.keys(config).length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {Object.entries(config).slice(0, 4).map(([key, value]) => (
                      <span key={key} className="rounded-full bg-slate-50 px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">
                        {key}: {String(key).toLowerCase().includes("token") ? maskSecret(value) : String(value || "—").slice(0, 24)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

<div className="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div className="flex items-center justify-between">
    <div>
      <h3 className="text-xl font-bold text-slate-950">
        Current Subscription
      </h3>

      <p className="mt-1 text-sm text-slate-500">
        الاشتراك الحالي للعميل
      </p>
    </div>
  </div>

  {!activeSubscription ? (
    <div className="mt-5 rounded-2xl border border-dashed border-slate-200 p-6 text-center text-slate-500">
      لا يوجد اشتراك فعال حالياً
    </div>
  ) : (
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          Plan
        </div>

        <div className="mt-2 text-lg font-bold">
          {activeSubscription.plans?.name}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          Type
        </div>

        <div className="mt-2 text-lg font-bold">
          {activeSubscription.subscription_type}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          Status
        </div>

        <div className="mt-2 text-lg font-bold text-emerald-600">
          {activeSubscription.status}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          Start Date
        </div>

        <div className="mt-2 font-semibold">
          {formatDate(activeSubscription.start_date)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          End Date
        </div>

        <div className="mt-2 font-semibold">
          {formatDate(activeSubscription.end_date)}
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <div className="text-xs text-slate-500">
          Remaining
        </div>

        <div className="mt-2 text-lg font-bold text-indigo-600">
          {getRemainingDays(
            activeSubscription.end_date
          )} Days
        </div>
      </div>
    </div>
  )}
</div>

 {/* Subscription History */}
<div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div className="mb-5 flex items-center justify-between">
    <div>
      <h3 className="text-xl font-bold text-slate-950">
        Subscription History
      </h3>

      <p className="mt-1 text-sm text-slate-500">
        سجل جميع اشتراكات العميل الحالية والسابقة
      </p>
    </div>
	
 
  {isAdmin && (
  <button
    type="button"
    onClick={openSubscriptionDrawer}
    className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
  >
    + New Subscription
  </button>
)}


  </div>

  {subscriptions.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
      لا يوجد اشتراكات لهذا العميل
    </div>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="py-3 font-semibold text-slate-500">
              Plan
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  Type
			</th>
            <th className="py-3 font-semibold text-slate-500">
              Status
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  Current
			</th>
            <th className="py-3 font-semibold text-slate-500">
              Start Date
            </th>
            <th className="py-3 font-semibold text-slate-500">
              End Date
            </th>
			<th className="py-3 font-semibold text-slate-500">
			  Closed
			</th>
			<th className="py-3 font-semibold text-slate-500">
			  Created
			</th>
          </tr>
        </thead>

        <tbody>
          {subscriptions.map((sub) => (
            <tr
              key={sub.id}
              className="border-b border-slate-50"
            >
              <td className="py-4 font-semibold text-slate-900">
                {sub.plans?.name || "-"}
              </td>

				<td className="py-4">
				  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
					sub.subscription_type === "trial"
					  ? "bg-blue-50 text-blue-700"
					  : "bg-violet-50 text-violet-700"
				  }`}>
					{sub.subscription_type}
				  </span>
				</td>

              <td className="py-4">
				<span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${getStatusClass(sub.status)}`}>
				  {sub.status}
				</span>
              </td>

				<td className="py-4">
				  {(sub.status === "active" || sub.status === "trial") ? (
					<span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
					  Current
					</span>
				  ) : (
					"-"
				  )}
				</td>



              <td className="py-4 text-slate-600">
                {formatDate(sub.start_date)}
              </td>

              <td className="py-4 text-slate-600">
                {formatDate(sub.end_date)}
              </td>
			  <td className="py-4 text-slate-600">
				  {formatDate(sub.closed_at)}
				</td>
			  <td className="py-4 text-slate-600">
				  {formatDate(sub.created_at)}
				</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )}
</div>
 
 {isAdmin && subscriptionDrawerOpen && (
  <div className="fixed inset-0 z-40 flex">
    <div
      className="flex-1 bg-slate-950/50"
      onClick={closeSubscriptionDrawer}
    />

    <div className="w-full max-w-md bg-white shadow-2xl">
      <div className="border-b p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold">
            New Subscription
          </h3>

          <button
            type="button"
            onClick={closeSubscriptionDrawer}
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div className="space-y-5 p-5">

        <div>
          <label className="mb-2 block text-sm font-semibold">
            Plan
          </label>

          <select
            value={subscriptionForm.plan_id}
            onChange={(e) =>
              setSubscriptionForm((prev) => ({
                ...prev,
                plan_id: e.target.value,
              }))
            }
            className="w-full rounded-2xl border px-4 py-3"
          >
            <option value="">
              Select Plan
            </option>

            {plansList.map((plan) => (
              <option
                key={plan.id}
                value={plan.id}
              >
                {plan.name}
              </option>
            ))}
          </select>
        </div>

<div>
  <label className="mb-2 block text-sm font-semibold">
    Subscription Type
  </label>

  <select
    value={subscriptionForm.subscription_type}
    onChange={(e) =>
      setSubscriptionForm((prev) => ({
        ...prev,
        subscription_type: e.target.value,
      }))
    }
    className="w-full rounded-2xl border px-4 py-3"
  >
    <option value="paid">
      Paid
    </option>

    <option value="trial">
      Trial
    </option>
  </select>
</div>

        {subscriptionForm.subscription_type === "paid" && (
          <div>
            <label className="mb-2 block text-sm font-semibold">
              Duration
            </label>

            <select
              value={subscriptionForm.duration}
              onChange={(e) =>
                setSubscriptionForm((prev) => ({
                  ...prev,
                  duration: e.target.value,
                }))
              }
              className="w-full rounded-2xl border px-4 py-3"
            >
              <option value="1">1 Month</option>
              <option value="3">3 Months</option>
              <option value="6">6 Months</option>
              <option value="12">12 Months</option>
            </select>
          </div>
        )}

        <button
		  type="button"
		  onClick={saveSubscription}
		  disabled={savingSubscription}
		  className="w-full rounded-2xl bg-indigo-600 py-3 font-semibold text-white disabled:opacity-50"
		>
		  {savingSubscription
			? "Saving..."
			: "Save Subscription"}
		</button>

      </div>
    </div>
  </div>
)}

      {drawerOpen && activeFeature && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-slate-950/50 backdrop-blur-sm" onClick={closeFeatureDrawer} />
          <div className="h-full w-full max-w-xl overflow-y-auto border-r border-slate-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 p-5 backdrop-blur">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Feature Settings</p>
                  <h2 className="mt-1 text-2xl font-bold text-slate-950">{activeFeature.name}</h2>
                  {activeFeature.slug && <p className="mt-1 text-sm text-slate-500">{activeFeature.slug}</p>}
                </div>
                <button
                  type="button"
                  onClick={closeFeatureDrawer}
                  className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <form onSubmit={handleSaveFeature} className="space-y-5 p-5">
              {isTelegramFeature && (
                <div className="rounded-3xl border border-blue-100 bg-blue-50 p-4">
                  <button
                    type="button"
                    onClick={() => setShowTelegramGuide((prev) => !prev)}
                    className="text-sm font-semibold text-blue-700 underline"
                  >
                    كيف تنشئ بوت تيليجرام؟
                  </button>

                  {showTelegramGuide && (
                    <div className="mt-3 space-y-2 text-sm text-blue-900">
                      <p>1. افتح Telegram وابحث عن BotFather</p>
                      <p>2. اكتب /newbot</p>
                      <p>3. اختر اسمًا للبوت</p>
                      <p>4. اختر username ينتهي بـ bot</p>
                      <p>5. انسخ Bot Token وضعه هنا</p>
                    </div>
                  )}
                </div>
              )}

              {activeFeature.fields && typeof activeFeature.fields === "object" && !Array.isArray(activeFeature.fields) ? (
                <div className="grid grid-cols-1 gap-4">
                  {Object.entries(activeFeature.fields).map(([fieldName, fieldType]) => {
                    const type = fieldType === "password" || fieldType === "number" || fieldType === "url" ? fieldType : "text";
                    return (
                      <div key={fieldName}>
                        <label className="mb-1.5 block text-sm font-semibold text-slate-700">{fieldName}</label>
                        <input
                          type={type}
                          value={featureValues[fieldName] || ""}
                          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                          className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                          disabled={readOnly}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">لا توجد حقول معرفة لهذه الميزة.</div>
              )}

              {setupLinks.length > 0 && (
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <LinkIcon className="h-5 w-5 text-indigo-600" />
                    <h3 className="font-bold text-slate-900">روابط الإعداد التلقائية</h3>
                  </div>

                  <div className="space-y-3">
                    {setupLinks.map((link) => (
                      <div key={link.label} className="rounded-2xl border border-slate-200 bg-white p-3">
                        <p className="mb-1 text-xs font-semibold text-slate-500">{link.label}</p>
                        <div className="flex gap-2">
                          <div className="min-w-0 flex-1 break-all rounded-xl bg-slate-50 px-3 py-2 text-xs text-blue-700">
                            {link.value}
                          </div>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(link.value)}
                            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            {copiedValue === link.value ? "تم" : <ClipboardDocumentIcon className="h-4 w-4" />}
                          </button>
                          <a
                            href={link.value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                          >
                            فتح
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 border-t border-slate-100 pt-5">
                {!readOnly && (
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <CheckCircleIcon className="h-5 w-5" />
                    {saving ? "جاري الحفظ..." : "حفظ الإعدادات"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeFeatureDrawer}
                  className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  إغلاق
                </button>
              </div>

              {readOnly && (
                <div className="flex items-start gap-2 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">
                  <ExclamationTriangleIcon className="h-4 w-4" />
                  هذه الإعدادات للعرض فقط حسب صلاحيات خطتك.
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
