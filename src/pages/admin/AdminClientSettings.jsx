import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

export default function AdminClientSettings({ clientIdOverride }) {
  const params = useParams();
  const effectiveClientId = clientIdOverride || params.id;
  const { user } = useAuth();

  const [client, setClient] = useState(null);
  const [plan, setPlan] = useState(null);
  const [features, setFeatures] = useState([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);
  const [settingsRowId, setSettingsRowId] = useState(null);
  const [featureValues, setFeatureValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [showTelegramGuide, setShowTelegramGuide] = useState(false);

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

        if (error) {
          console.error(error);
        } else {
          planData = data || null;
        }
      }
      setPlan(planData);

      if (!clientData.plan_id) {
        setFeatures([]);
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

      const featureIds = (pfData || []).map((x) => x.feature_id);
      if (featureIds.length === 0) {
        setFeatures([]);
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

    if (data) {
      setSettingsRowId(data.id);
    } else {
      setSettingsRowId(null);
    }

    const fieldsDef =
      feature.fields &&
      typeof feature.fields === "object" &&
      !Array.isArray(feature.fields)
        ? feature.fields
        : {};

    const existingSettings = (data && data.config) || {};

    const initialValues = {};
    Object.entries(fieldsDef).forEach(([f]) => {
      initialValues[f] = existingSettings[f] ?? "";
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
  }

  function handleFieldChange(fieldName, value) {
    setFeatureValues((prev) => ({
      ...prev,
      [fieldName]: value,
    }));
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
        .select("id, config")
        .eq("client_id", effectiveClientId)
        .eq("feature_id", activeFeature.id)
        .maybeSingle();

      if (!refError && refreshed) {
        setSettingsRowId(refreshed.id);
        setFeatureValues(refreshed.config || {});
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
  const telegramBotToken = (featureValues["Bot Token"] || "").trim();
  const telegramChannelKey = (featureValues["channelKey"] || "").trim();
  const telegramWebhookBase = (import.meta.env.VITE_WEBHOOK_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const telegramWebhookUrl =
    isTelegramFeature && telegramWebhookBase && telegramChannelKey
      ? `${telegramWebhookBase}/telegram/${telegramChannelKey}`
      : "";
  const telegramActivationLink =
    isTelegramFeature && telegramBotToken && telegramWebhookUrl
      ? `https://api.telegram.org/bot${telegramBotToken}/setWebhook?url=${encodeURIComponent(telegramWebhookUrl)}`
      : "";

  return (
    <div>
      {loading ? (
        <p>جارِ تحميل بيانات العميل...</p>
      ) : !client ? (
        <p className="text-red-500">{msg || "لم يتم العثور على العميل"}</p>
      ) : (
        <>
          <h1 className="text-2xl font-bold mb-2">إعدادات العميل: {client.business_name}</h1>
          <p className="text-gray-500 mb-1">{client.email}</p>
          {plan && <p className="text-gray-500 mb-4">الخطة الحالية: {plan.name}</p>}

          {msg && <p className="mb-4 text-blue-700 font-semibold">{msg}</p>}

          <div className="bg-white shadow rounded-xl p-4">
            <h2 className="text-xl font-semibold mb-3">الميزات المفعّلة لهذا العميل</h2>

            {features.length === 0 ? (
              <p className="text-gray-400 text-sm">لا توجد ميزات مفعّلة ضمن خطة هذا العميل.</p>
            ) : (
              <div className="divide-y">
                {features.map((f) => (
                  <div key={f.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="font-semibold">{f.name}</div>
                      {f.description && <div className="text-gray-500 text-sm">{f.description}</div>}
                    </div>

                    <button
                      type="button"
                      onClick={() => openFeatureDrawer(f)}
                      className="bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700 text-sm"
                    >
                      تعديل الإعدادات
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!isAdmin && !clientCanEdit && (
              <p className="mt-4 text-xs text-gray-500">
                ⚠️ لا تتيح خطتك الحالية تعديل الإعدادات بنفسك. الرجاء التواصل مع المسؤول.
              </p>
            )}
          </div>
        </>
      )}

      {drawerOpen && activeFeature && (
        <div className="fixed inset-0 z-50 flex">
          <div className="w-full max-w-md h-full bg-white shadow-xl border-r p-6 overflow-y-auto">
            <h2 className="text-xl font-bold mb-2">إعدادات: {activeFeature.name}</h2>
            {activeFeature.slug && <p className="text-gray-500 text-sm mb-4">{activeFeature.slug}</p>}

            {isTelegramFeature && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setShowTelegramGuide((prev) => !prev)}
                  className="text-blue-600 underline text-sm"
                >
                  كيف تنشئ بوت تيليجرام؟
                </button>

                {showTelegramGuide && (
                  <div className="mt-3 bg-gray-100 p-3 rounded text-sm space-y-2">
                    <p>1. افتح Telegram وابحث عن BotFather</p>
                    <p>2. اكتب /newbot</p>
                    <p>3. اختر اسمًا للبوت</p>
                    <p>4. اختر username ينتهي بـ bot</p>
                    <p>5. انسخ Bot Token</p>
                    <p>6. ضعه في الحقول بالأدنى ثم احفظ الإعدادات</p>
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSaveFeature} className="space-y-4">
              {activeFeature.fields &&
              typeof activeFeature.fields === "object" &&
              !Array.isArray(activeFeature.fields) ? (
                Object.entries(activeFeature.fields).map(([fieldName, fieldType]) => {
                  const type =
                    fieldType === "password" ||
                    fieldType === "number" ||
                    fieldType === "url"
                      ? fieldType
                      : "text";

                  return (
                    <div key={fieldName}>
                      <label className="block text-sm mb-1">{fieldName}</label>
                      <input
                        type={type}
                        value={featureValues[fieldName] || ""}
                        onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                        className="border rounded px-3 py-2 w-full"
                        disabled={readOnly}
                      />
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-gray-500">لا توجد حقول معرفة لهذه الميزة.</p>
              )}

              {isTelegramFeature && (telegramWebhookUrl || telegramActivationLink) && (
                <div className="mt-4 space-y-3">
                  {telegramWebhookUrl && (
                    <div className="bg-gray-100 rounded p-3 text-sm">
                      <p className="mb-1 font-medium">Webhook URL</p>
                      <div className="text-blue-700 break-all">{telegramWebhookUrl}</div>
                    </div>
                  )}

                  {telegramActivationLink && (
                    <div className="bg-gray-100 rounded p-3 text-sm">
                      <p className="mb-1 font-medium">رابط تفعيل تيليجرام</p>
                      <a
                        href={telegramActivationLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-700 underline break-all"
                      >
                        {telegramActivationLink}
                      </a>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 mt-6">
                {!readOnly && (
                  <button
                    type="submit"
                    disabled={saving}
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? "جاري الحفظ..." : "حفظ الإعدادات"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeFeatureDrawer}
                  className="bg-gray-300 text-gray-800 px-4 py-2 rounded hover:bg-gray-400"
                >
                  إغلاق
                </button>
              </div>

              {readOnly && (
                <p className="mt-3 text-xs text-gray-500">
                  هذه الإعدادات للعرض فقط حسب صلاحيات خطتك.
                </p>
              )}
            </form>
          </div>

          <div className="flex-1 h-full bg-black/40" onClick={closeFeatureDrawer} />
        </div>
      )}
    </div>
  );
}
