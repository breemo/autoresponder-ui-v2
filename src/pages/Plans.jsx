// src/pages/Plans.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import FeatureSelector from "../components/FeatureSelector";

export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [planFeatures, setPlanFeatures] = useState({}); // {planId: [{id,name}]}

  const [allFeatures, setAllFeatures] = useState([]);
  const [newFeatureName, setNewFeatureName] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // فورم الباقة
  const [form, setForm] = useState({
    name: "",
    price: "",
    max_messages: "",
    allow_login: true,
    allow_edit_replies: true,
    allow_settings: true,
    featureIds: [], // هنا بنحفظ IDs من جدول features
  });

  // --------- جلب البيانات من Supabase ---------

  async function fetchFeatures() {
    const { data, error } = await supabase
      .from("features")
      .select("id, name")
      .order("name", { ascending: true });

    if (error) throw error;
    setAllFeatures(data || []);
  }

  async function fetchPlansAndRelations() {
    setLoading(true);
    setError("");
    try {
      // الباقات
      const { data: plansData, error: plansError } = await supabase
        .from("plans")
        .select("*")
        .order("price", { ascending: true });

      if (plansError) throw plansError;

      // الربط بين الباقات والميزات
      const { data: pfData, error: pfError } = await supabase
        .from("plans_features")
        .select("plan_id, feature_id, features(name)");

      if (pfError) throw pfError;

      const map = {};
      (pfData || []).forEach((row) => {
        const feat = {
          id: row.feature_id,
          name: row.features?.name || "",
        };
        if (!map[row.plan_id]) map[row.plan_id] = [];
        map[row.plan_id].push(feat);
      });

      setPlanFeatures(map);
      setPlans(plansData || []);
    } catch (err) {
      console.error("Error fetching plans:", err.message);
      setError("حدث خطأ أثناء جلب الباقات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        await fetchFeatures();
        await fetchPlansAndRelations();
      } catch (err) {
        console.error(err);
        setError("حدث خطأ أثناء تحميل البيانات");
      }
    })();
  }, []);

  // --------- Helpers للفورم ---------

  function handleChange(e) {
    const { name, value, type, checked } = e.target;

    if (type === "checkbox") {
      setForm((prev) => ({ ...prev, [name]: checked }));
    } else {
      setForm((prev) => ({ ...prev, [name]: value }));
    }
  }

  function resetForm() {
    setForm({
      name: "",
      price: "",
      max_messages: "",
      allow_login: true,
      allow_edit_replies: true,
      allow_settings: true,
      featureIds: [],
    });
    setIsEditing(false);
    setEditingId(null);
  }

  function startEdit(plan) {
    setIsEditing(true);
    setEditingId(plan.id);
    setError("");
    setSuccess("");

    const featsForPlan = planFeatures[plan.id] || [];

    setForm({
      name: plan.name || "",
      price: plan.price ?? "",
      max_messages: plan.max_messages ?? "",
      allow_login: plan.allow_login ?? true,
      allow_edit_replies: plan.allow_edit_replies ?? true,
      allow_settings: plan.allow_settings ?? true,
      featureIds: featsForPlan.map((f) => f.id),
    });
  }

  async function savePlanFeatures(planId, featureIds) {
    // نمسح القديم
    const { error: delError } = await supabase
      .from("plans_features")
      .delete()
      .eq("plan_id", planId);

    if (delError) throw delError;

    if (!featureIds || featureIds.length === 0) return;

    const rows = featureIds.map((fid) => ({
      plan_id: planId,
      feature_id: fid,
    }));

    const { error: insError } = await supabase
      .from("plans_features")
      .insert(rows);

    if (insError) throw insError;
  }

  // --------- حفظ الباقة (إضافة / تعديل) ---------

  async function savePlan(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      if (!form.name) {
        setError("الرجاء إدخال اسم الباقة");
        return;
      }

      const payload = {
        name: form.name,
        price: form.price === "" ? null : Number(form.price),
        max_messages:
          form.max_messages === "" ? null : Number(form.max_messages),
        allow_login: form.allow_login,
        allow_edit_replies: form.allow_edit_replies,
        allow_settings: form.allow_settings,
      };

      let planId = editingId;

      if (isEditing && editingId) {
        const { error } = await supabase
          .from("plans")
          .update(payload)
          .eq("id", editingId);

        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("plans")
          .insert(payload)
          .select("id")
          .single();

        if (error) throw error;
        planId = data.id;
      }

      // حفظ الربط مع الميزات
      await savePlanFeatures(planId, form.featureIds);

      setSuccess(
        isEditing
          ? "✅ تم تعديل الباقة بنجاح"
          : "✅ تم إضافة الباقة بنجاح"
      );

      await fetchPlansAndRelations();
      resetForm();
    } catch (err) {
      console.error("Error saving plan:", err.message);
      setError("حدث خطأ أثناء حفظ الباقة");
    } finally {
      setSaving(false);
    }
  }

  // --------- حذف باقة ---------

  async function deletePlan(id) {
    if (!window.confirm("هل أنت متأكد من حذف هذه الباقة؟")) return;

    setError("");
    setSuccess("");

    try {
      const { error } = await supabase.from("plans").delete().eq("id", id);
      if (error) throw error;

      setSuccess("🗑️ تم حذف الباقة بنجاح");
      await fetchPlansAndRelations();
    } catch (err) {
      console.error("Error deleting plan:", err.message);
      setError("حدث خطأ أثناء حذف الباقة");
    }
  }

  // --------- إدارة قائمة الميزات نفسها (features) ---------

  async function addFeature() {
    if (!newFeatureName.trim()) return;
    setError("");
    setSuccess("");
    try {
      const { error } = await supabase
        .from("features")
        .insert({ name: newFeatureName.trim() });

      if (error) throw error;
      setNewFeatureName("");
      await fetchFeatures();
      setSuccess("✅ تم إضافة الميزة");
    } catch (err) {
      if (err.message?.includes("duplicate")) {
        setError("هذه الميزة موجودة مسبقًا");
      } else {
        setError("حدث خطأ أثناء إضافة الميزة");
      }
      console.error(err);
    }
  }

  async function deleteFeature(id) {
    if (!window.confirm("حذف هذه الميزة؟ لن تظهر في الباقات بعد ذلك.")) return;
    setError("");
    setSuccess("");
    try {
      const { error } = await supabase
        .from("features")
        .delete()
        .eq("id", id);

      if (error) throw error;
      await fetchFeatures();
      await fetchPlansAndRelations();
      setSuccess("🗑️ تم حذف الميزة");
    } catch (err) {
      console.error(err);
      setError("حدث خطأ أثناء حذف الميزة");
    }
  }

  // --------- JSX ---------

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">الباقات</h1>
      <p className="text-gray-500 mb-6">
        إدارة خطط الاشتراك، الصلاحيات، وعدد الرسائل والميزات المتاحة لكل باقة.
      </p>

      {error && (
        <div className="mb-4 bg-red-100 text-red-700 px-4 py-2 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 bg-green-100 text-green-700 px-4 py-2 rounded">
          {success}
        </div>
      )}

      {/* فورم الباقة */}
      <div className="bg-white shadow rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">
          {isEditing ? "تعديل الباقة" : "إضافة باقة جديدة"}
        </h2>

        <form
          onSubmit={savePlan}
          className="grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          <div>
            <label className="block mb-1 text-sm text-gray-600">
              اسم الباقة
            </label>
            <input
              type="text"
              name="name"
              className="w-full border rounded px-3 py-2"
              value={form.name}
              onChange={handleChange}
              placeholder="مثال: Free, Pro, Business"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm text-gray-600">السعر</label>
            <input
              type="number"
              name="price"
              className="w-full border rounded px-3 py-2"
              value={form.price}
              onChange={handleChange}
              placeholder="0 لو مجانية"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm text-gray-600">
              الحد الأقصى للرسائل
            </label>
            <input
              type="number"
              name="max_messages"
              className="w-full border rounded px-3 py-2"
              value={form.max_messages}
              onChange={handleChange}
              placeholder="مثال: 1000"
            />
          </div>

          {/* الصلاحيات */}
          <div className="flex flex-col gap-2 mt-2">
            <label className="text-sm text-gray-600 mb-1">
              الصلاحيات (Permissions)
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allow_login"
                checked={form.allow_login}
                onChange={handleChange}
              />
              <span>السماح بدخول لوحة التحكم</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allow_edit_replies"
                checked={form.allow_edit_replies}
                onChange={handleChange}
              />
              <span>السماح بتعديل الردود التلقائية</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allow_settings"
                checked={form.allow_settings}
                onChange={handleChange}
              />
              <span>السماح بالدخول لإعدادات الـ API</span>
            </label>
          </div>

          {/* الميزات */}
          <div className="md:col-span-2">
            <label className="block mb-1 text-sm text-gray-600">
              الميزات (Features)
            </label>

            <FeatureSelector
              allFeatures={allFeatures}
              selectedIds={form.featureIds}
              onChange={(ids) =>
                setForm((prev) => ({ ...prev, featureIds: ids }))
              }
            />
          </div>

          <div className="md:col-span-2 flex gap-3 mt-4">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
            >
              {saving
                ? "جاري الحفظ..."
                : isEditing
                ? "حفظ التعديلات"
                : "إضافة الباقة"}
            </button>
            {isEditing && (
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 border rounded text-gray-700 hover:bg-gray-100"
              >
                إلغاء التعديل
              </button>
            )}
          </div>
        </form>
      </div>

      {/* جدول الباقات */}
      <div className="bg-white shadow rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">كل الباقات</h2>

        {loading ? (
          <p className="text-gray-500">جارِ تحميل الباقات...</p>
        ) : plans.length === 0 ? (
          <p className="text-gray-400">لا توجد باقات حالياً.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr className="text-left text-gray-600">
                <th className="py-2 px-2">الاسم</th>
                <th className="py-2 px-2">السعر</th>
                <th className="py-2 px-2">الرسائل</th>
                <th className="py-2 px-2">الصلاحيات</th>
                <th className="py-2 px-2">الميزات</th>
                <th className="py-2 px-2 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const feats = planFeatures[plan.id] || [];
                return (
                  <tr key={plan.id} className="border-b hover:bg-gray-50">
                    <td className="py-2 px-2">{plan.name}</td>
                    <td className="py-2 px-2">
                      {plan.price == null ? "مجانية" : `${plan.price} $`}
                    </td>
                    <td className="py-2 px-2">
                      {plan.max_messages == null
                        ? "غير محدد"
                        : plan.max_messages}
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-col text-xs gap-1">
                        <span>
                          دخول:{" "}
                          {plan.allow_login ? (
                            <span className="text-green-600">مسموح</span>
                          ) : (
                            <span className="text-red-500">ممنوع</span>
                          )}
                        </span>
                        <span>
                          تعديل الردود:{" "}
                          {plan.allow_edit_replies ? (
                            <span className="text-green-600">مسموح</span>
                          ) : (
                            <span className="text-red-500">ممنوع</span>
                          )}
                        </span>
                        <span>
                          إعدادات API:{" "}
                          {plan.allow_settings ? (
                            <span className="text-green-600">مسموح</span>
                          ) : (
                            <span className="text-red-500">ممنوع</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      {feats.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {feats.map((f) => (
                            <span
                              key={f.id}
                              className="bg-gray-100 text-gray-700 px-2 py-1 rounded-full text-xs"
                            >
                              {f.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">
                          لا توجد ميزات
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-center">
                      <div className="flex justify-center gap-2">
                        <button
                          onClick={() => startEdit(plan)}
                          className="px-3 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600"
                        >
                          تعديل
                        </button>
                        <button
                          onClick={() => deletePlan(plan.id)}
                          className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
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

      {/* إدارة قائمة الميزات نفسها */}
      <div className="bg-white shadow rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">
          إدارة قائمة الميزات الأساسية
        </h2>

        <div className="flex flex-col md:flex-row gap-3 mb-4">
          <input
            type="text"
            className="border rounded px-3 py-2 w-full md:w-1/3"
            placeholder="اسم ميزة جديدة (مثال: WhatsApp)"
            value={newFeatureName}
            onChange={(e) => setNewFeatureName(e.target.value)}
          />
          <button
            type="button"
            onClick={addFeature}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            إضافة ميزة
          </button>
        </div>

        {allFeatures.length === 0 ? (
          <p className="text-gray-400 text-sm">لا توجد ميزات حالياً.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {allFeatures.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between border-b pb-1"
              >
                <span>{f.name}</span>
                <button
                  type="button"
                  onClick={() => deleteFeature(f.id)}
                  className="text-red-600 hover:text-red-800 text-xs"
                >
                  حذف
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
