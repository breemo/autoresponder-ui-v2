// src/pages/client/ClientSettings.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

// helper بسيط لتطبيع الأسماء (للمقارنة بين label و key في config)
function normalizeName(str) {
  return (str || "").toString().toLowerCase().replace(/\s+/g, "");
}

export default function ClientSettings() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [client, setClient] = useState(null);
  const [planFeatures, setPlanFeatures] = useState([]); // كل الـ features المسموحة في الخطة
  const [integrations, setIntegrations] = useState([]); // تكاملات هذا العميل

  // نحاول نطلع clientId من المستخدم
  const clientId = user?.client_id || user?.clientId || user?.id || null;

  useEffect(() => {
    if (!clientId) return;
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function fetchData() {
    try {
      setLoading(true);
      setError("");
      setSuccess("");

      // 1) جلب بيانات العميل
      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .select("*")
        .eq("id", clientId)
        .single();

      if (clientError) throw clientError;
      setClient(clientData);

      // 2) جلب الـ features المرتبطة بخطة هذا العميل
      let featuresList = [];
      if (clientData.plan_id) {
        const { data: pf, error: pfError } = await supabase
          .from("plan_features")
          .select("feature_id")
          .eq("plan_id", clientData.plan_id);

        if (pfError) throw pfError;

        const featureIds = (pf || []).map((x) => x.feature_id);
        if (featureIds.length > 0) {
          const { data: featuresData, error: fError } = await supabase
            .from("features")
            .select("*")
            .in("id", featureIds);

          if (fError) throw fError;
          featuresList = featuresData || [];
        }
      }

      setPlanFeatures(featuresList);

      // 3) جلب التكاملات الحالية للعميل
      const { data: integrationsData, error: intError } = await supabase
        .from("client_feature_integrations")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: true });

      if (intError) throw intError;

      // نتأكد من وجود config ككائن
      const normalized = (integrationsData || []).map((row) => ({
        ...row,
        config: row.config || {},
      }));
      setIntegrations(normalized);
    } catch (err) {
      console.error("Error loading client integrations:", err);
      setError(err.message || "حدث خطأ أثناء تحميل إعدادات التكامل.");
    } finally {
      setLoading(false);
    }
  }

  // ===== Helpers لحساب القوائم =====
  function getFeatureById(featureId) {
    return planFeatures.find((f) => f.id === featureId);
  }

  const activeIntegrations = integrations;
  const availableFeatures = planFeatures.filter(
    (f) => !integrations.some((i) => i.feature_id === f.id)
  );


  const toggleActive = async (featureId, currentValue) => {
  const { error } = await supabase
    .from("client_feature_integrations")
    .update({ is_active: !currentValue })
    .eq("client_id", clientId)
    .eq("feature_id", featureId);

  if (!error) {
    // حدّث state حتى يظهر بالفوراً
    setIntegrations(prev =>
      prev.map(item =>
        item.feature_id === featureId
          ? { ...item, is_active: !currentValue }
          : item
      )
    );
  }
};


  

  // ===== Handlers =====
  function handleFieldChange(integrationId, key, value) {
    setIntegrations((prev) =>
      prev.map((intg) =>
        intg.id === integrationId
          ? {
              ...intg,
              config: {
                ...(intg.config || {}),
                [key]: value, // نخزن بالقيمة key اللي هي label نفسه (مثلاً "Page ID")
              },
            }
          : intg
      )
    );
  }

  function handleToggleActive(integrationId, value) {
    setIntegrations((prev) =>
      prev.map((intg) =>
        intg.id === integrationId ? { ...intg, is_active: value } : intg
      )
    );
  }

  async function handleSaveIntegration(integration) {
    try {
      setSavingId(integration.id);
      setError("");
      setSuccess("");

      const { error: updateError } = await supabase
        .from("client_feature_integrations")
        .update({
          is_active: integration.is_active,
          config: integration.config || {},
        })
        .eq("id", integration.id);

      if (updateError) throw updateError;
      setSuccess("تم حفظ إعدادات التكامل بنجاح ✅");
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في حفظ إعدادات التكامل.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleAddIntegration(feature) {
    try {
      setSavingId(feature.id);
      setError("");
      setSuccess("");

      const { data, error: insertError } = await supabase
        .from("client_feature_integrations")
        .insert({
          client_id: clientId,
          feature_id: feature.id,
          is_active: true,
          config: {}, // نملأه لاحقاً من الفورم
        })
        .select()
        .single();

      if (insertError) throw insertError;

      setIntegrations((prev) => [
        ...prev,
        { ...data, config: data.config || {} },
      ]);
      setSuccess("تم تفعيل التكامل بنجاح ✅");
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في تفعيل التكامل.");
    } finally {
      setSavingId(null);
    }
  }

  const displayName = client?.business_name || user?.name || "العميل";

  // ===== Render =====
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">
          إعدادات التكامل للعميل
        </h1>
        <p className="text-gray-500 text-sm">
          هنا يمكنك ربط حسابك على واتساب، فيسبوك، إنستغرام، تيليجرام وغيرها حسب
          الباقة الخاصة بك يا {displayName}.
        </p>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded-lg text-sm">
          {success}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">جارِ تحميل بيانات التكامل...</p>
      ) : (
        <>
          {/* Active integrations */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold mb-4">
              التكاملات المفعّلة حالياً
            </h2>

            {activeIntegrations.length === 0 ? (
              <p className="text-gray-400 text-sm">
                لا توجد تكاملات مفعّلة بعد. يمكنك تفعيلها من القسم أسفل 👇
              </p>
            ) : (
              <div className="space-y-4">
                {activeIntegrations.map((intg) => {
                  const feature = getFeatureById(intg.feature_id);

                  // ⬇⬇⬇ التعديل المهم هنا: تطبيع fields حسب الشكل الجديد ⬇⬇⬇
                  let fields = [];
                  if (Array.isArray(feature?.fields)) {
                    fields = feature.fields;
                  } else if (
                    feature?.fields &&
                    typeof feature.fields === "object"
                  ) {
                    // مثال: { "Page ID": "text", "Access Token": "password" }
                    fields = Object.entries(feature.fields).map(
                      ([label, type]) => ({
                        key: label, // نستخدم نفس النص كمفتاح في config
                        label,
                        type,
                      })
                    );
                  }

                  return (
                    <div
                      key={intg.id}
                      className="mb-6 border rounded-lg p-4 bg-white shadow-sm"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-gray-800">
                            {feature?.name || intg.name}
                          </h3>
                          <p className="text-xs text-gray-400">
                            {feature?.slug}
                          </p>
                        </div>

                        <label className="flex items-center gap-2 text-sm">
                  

<input
  type="checkbox"
  checked={intg.is_active}
  onChange={() => toggleActive(intg.feature_id, intg.is_active)}
/>
                          
                          <span>
                            {intg.is_active ? "مفعّل" : "معطّل"}
                          </span>
                        </label>
                      </div>

                      {/* Dynamic fields */}
                      {fields.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
                          {fields.map((field) => {
                            // نحاول نقرأ القيمة من config:
                            const cfg = intg.config || {};
                            let value = cfg[field.key];

                            // لو مش موجودة بالاسم المباشر، نجرب نطابق بالـ normalize
                            if (value === undefined) {
                              const normLabel = normalizeName(field.key);
                              const found = Object.entries(cfg).find(
                                ([k]) => normalizeName(k) === normLabel
                              );
                              if (found) {
                                value = found[1];
                              } else {
                                value = "";
                              }
                            }

                            return (
                              <div key={field.key}>
                                <label className="block text-xs text-gray-500 mb-1">
                                  {field.label || field.key}
                                </label>
                                <input
                                  type={
                                    field.type === "password"
                                      ? "password"
                                      : "text"
                                  }
                                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  value={value}
                                  onChange={(e) =>
                                    handleFieldChange(
                                      intg.id,
                                      field.key,
                                      e.target.value
                                    )
                                  }
                                  placeholder={field.placeholder || ""}
                                />
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 mb-2">
                          لا توجد حقول مخصّصة لهذا التكامل.
                        </p>
                      )}

                      <div className="flex justify-end">
                        <button
                          onClick={() => handleSaveIntegration(intg)}
                          disabled={savingId === intg.id}
                          className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                        >
                          {savingId === intg.id
                            ? "جارِ الحفظ..."
                            : "حفظ الإعدادات"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Available features */}
          <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold mb-4">
              قنوات يمكن تفعيلها من ضمن خطتك
            </h2>

            {availableFeatures.length === 0 ? (
              <p className="text-gray-400 text-sm">
                كل قنوات التكامل المتاحة في خطتك مفعّلة بالفعل ✅
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {availableFeatures.map((feature) => (
                  <div
                    key={feature.id}
                    className="border border-dashed border-gray-300 rounded-lg p-4 flex flex-col justify-between"
                  >
                    <div>
                      <h3 className="font-semibold text-gray-800 mb-1">
                        {feature.name}
                      </h3>
                      {feature.description && (
                        <p className="text-xs text-gray-500 mb-2">
                          {feature.description}
                        </p>
                      )}
                    </div>

                    <button
                      onClick={() => handleAddIntegration(feature)}
                      disabled={savingId === feature.id}
                      className="mt-3 px-3 py-2 text-sm rounded-lg bg-green-500 text-white hover:bg-green-600 disabled:opacity-60"
                    >
                      {savingId === feature.id
                        ? "جارِ التفعيل..."
                        : "تفعيل هذا التكامل"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
