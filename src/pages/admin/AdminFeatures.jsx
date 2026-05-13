import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowPathIcon,
  BoltIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  LinkIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  return Object.entries(fields).map(([name, type]) => ({ name, type }));
}

function fieldsToJson(fields) {
  const fieldsJson = {};
  fields.forEach((field) => {
    if (field.name?.trim()) fieldsJson[field.name.trim()] = field.type || "text";
  });
  return fieldsJson;
}

function getFeatureMeta(feature) {
  const slug = `${feature?.slug || ""} ${feature?.name || ""}`.toLowerCase();
  if (slug.includes("telegram")) return { color: "from-sky-500 to-cyan-400", tone: "bg-sky-50 text-sky-700", label: "Messaging" };
  if (slug.includes("facebook")) return { color: "from-blue-600 to-indigo-500", tone: "bg-blue-50 text-blue-700", label: "Social" };
  if (slug.includes("instagram")) return { color: "from-fuchsia-500 to-rose-400", tone: "bg-fuchsia-50 text-fuchsia-700", label: "Social" };
  if (slug.includes("whatsapp")) return { color: "from-emerald-500 to-teal-400", tone: "bg-emerald-50 text-emerald-700", label: "Messaging" };
  return { color: "from-slate-700 to-slate-500", tone: "bg-slate-100 text-slate-700", label: "Feature" };
}

function EmptyForm() {
  return { name: "", slug: "", description: "", fields: [] };
}

export default function AdminFeatures() {
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(EmptyForm());

  useEffect(() => {
    fetchFeatures();
  }, []);

  async function fetchFeatures() {
    setLoading(true);
    const { data, error } = await supabase
      .from("features")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      console.error(error);
      setMsg("فشل تحميل الميزات.");
    } else {
      setFeatures(data || []);
    }
    setLoading(false);
  }

  const filteredFeatures = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return features;
    return features.filter((feature) =>
      `${feature.name || ""} ${feature.slug || ""} ${feature.description || ""}`.toLowerCase().includes(value)
    );
  }, [features, query]);

  function resetForm() {
    setForm(EmptyForm());
    setEditingId(null);
    setMsg("");
  }

  function openCreate() {
    resetForm();
    setDrawerOpen(true);
  }

  function startEdit(feature) {
    setEditingId(feature.id);
    setForm({
      name: feature.name || "",
      slug: feature.slug || "",
      description: feature.description || "",
      fields: normalizeFields(feature.fields),
    });
    setDrawerOpen(true);
  }

  function handleFieldChange(index, key, value) {
    setForm((prev) => {
      const newFields = [...prev.fields];
      newFields[index] = { ...newFields[index], [key]: value };
      return { ...prev, fields: newFields };
    });
  }

  function addField() {
    setForm((prev) => ({ ...prev, fields: [...prev.fields, { name: "", type: "text" }] }));
  }

  function removeField(index) {
    setForm((prev) => ({ ...prev, fields: prev.fields.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg("");

    if (!form.name || !form.slug) {
      setMsg("يرجى إدخال الاسم والـ slug.");
      return;
    }

    try {
      const payload = {
        name: form.name,
        slug: form.slug,
        description: form.description || null,
        fields: fieldsToJson(form.fields),
      };

      if (editingId) {
        const { error } = await supabase.from("features").update(payload).eq("id", editingId);
        if (error) throw error;
        setMsg("تم تحديث الميزة بنجاح.");
      } else {
        const { error } = await supabase.from("features").insert([payload]);
        if (error) throw error;
        setMsg("تم إضافة الميزة بنجاح.");
      }

      setDrawerOpen(false);
      resetForm();
      fetchFeatures();
    } catch (err) {
      console.error(err);
      setMsg("حدث خطأ أثناء الحفظ.");
    }
  }

  async function deleteFeature(id) {
    if (!window.confirm("هل تريد حذف هذه الميزة؟")) return;
    const { error } = await supabase.from("features").delete().eq("id", id);
    if (error) {
      console.error(error);
      setMsg("فشل في حذف الميزة.");
    } else {
      setMsg("تم الحذف بنجاح.");
      fetchFeatures();
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              <Cog6ToothIcon className="h-4 w-4" />
              Features & Integrations
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">إدارة الميزات وقنوات الربط</h1>
            <p className="mt-1 text-sm text-slate-500">تعريف قنوات الربط والحقول التي تظهر للعميل عند الإعداد.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={fetchFeatures} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              <ArrowPathIcon className="h-4 w-4" /> Refresh
            </button>
            <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
              <PlusIcon className="h-4 w-4" /> Add Feature
            </button>
          </div>
        </div>
      </div>

      {msg && <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700">{msg}</div>}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Total features</p>
          <p className="mt-1 text-2xl font-semibold text-slate-950">{features.length}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">With fields</p>
          <p className="mt-1 text-2xl font-semibold text-slate-950">{features.filter((f) => normalizeFields(f.fields).length > 0).length}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Ready channels</p>
          <p className="mt-1 text-2xl font-semibold text-slate-950">{features.filter((f) => /(telegram|facebook|instagram|whatsapp)/i.test(`${f.slug} ${f.name}`)).length}</p>
        </div>
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Features list</h2>
            <p className="mt-1 text-xs text-slate-500">كل ميزة تظهر كقناة أو capability داخل خطط العملاء.</p>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search feature..."
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50 lg:w-80"
          />
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جارِ تحميل الميزات...</div>
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredFeatures.map((feature) => {
              const meta = getFeatureMeta(feature);
              const fields = normalizeFields(feature.fields);
              return (
                <div key={feature.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className={`grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br ${meta.color} text-white shadow-sm`}>
                        <LinkIcon className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-950">{feature.name}</h3>
                        <p className="mt-0.5 text-xs text-slate-500">{feature.slug}</p>
                      </div>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.tone}`}>{meta.label}</span>
                  </div>

                  <p className="mt-3 line-clamp-2 min-h-[36px] text-sm text-slate-500">{feature.description || "No description added yet."}</p>

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {fields.length === 0 ? (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">No fields</span>
                    ) : (
                      fields.slice(0, 4).map((field) => (
                        <span key={field.name} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                          {field.name} · {field.type}
                        </span>
                      ))
                    )}
                    {fields.length > 4 && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">+{fields.length - 4}</span>}
                  </div>

                  <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                    <button onClick={() => startEdit(feature)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                      <PencilSquareIcon className="h-4 w-4" /> Edit
                    </button>
                    <button onClick={() => deleteFeature(feature.id)} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100">
                      <TrashIcon className="h-4 w-4" /> Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30 backdrop-blur-sm">
          <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-slate-950">{editingId ? "Edit feature" : "Add new feature"}</h2>
                <p className="text-xs text-slate-500">عرّف الحقول التي سيستخدمها العميل عند إعداد القناة.</p>
              </div>
              <button onClick={() => setDrawerOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 p-5">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-600">Feature name</span>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-600">Slug</span>
                  <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50" />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-600">Description</span>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50" />
              </label>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950">Configuration fields</h3>
                    <p className="text-xs text-slate-500">مثال: Bot Token, Page ID, Access Token.</p>
                  </div>
                  <button type="button" onClick={addField} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                    <PlusIcon className="h-4 w-4" /> Field
                  </button>
                </div>

                <div className="space-y-2">
                  {form.fields.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-center text-sm text-slate-500">لا توجد حقول بعد.</div>
                  ) : (
                    form.fields.map((field, index) => (
                      <div key={index} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_140px_auto]">
                        <input placeholder="field name" value={field.name} onChange={(e) => handleFieldChange(index, "name", e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300" />
                        <select value={field.type} onChange={(e) => handleFieldChange(index, "type", e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300">
                          <option value="text">Text</option>
                          <option value="password">Password</option>
                          <option value="number">Number</option>
                          <option value="url">URL</option>
                        </select>
                        <button type="button" onClick={() => removeField(index)} className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100">Remove</button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">{editingId ? "Update feature" : "Create feature"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
