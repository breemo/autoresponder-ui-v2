import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { XMarkIcon, StarIcon, PencilIcon, TrashIcon } from "@heroicons/react/24/outline";

// AI Engine V1 — Business Voice + Authoritative Locations.
//
// Self-contained card, same pattern as KnowledgeBaseSection.jsx: owns its
// own fetch/state, talks only to /api/client-router?resource=locations
// (api/_lib/clientLocations.js — RLS-locked table, no direct browser
// Supabase access). Smallest usable interface per the approved scope: add/
// edit/activate/deactivate/set-primary, plus the ONE explicit completeness
// toggle that api/_lib/promptBuilder.js's TRUE/FALSE/UNKNOWN rule and
// api/_lib/aiContext.js's loadLocationsSafely both key off (clients.
// locations_list_complete — client-level, not per-row; see the migration's
// header comment for why).
//
// Deliberately does NOT touch or replace the existing "Address" field in
// ClientSettings.jsx's Business Information card — that field remains the
// backward-compatible single known/primary address for every client,
// completely unaffected by whether any client_locations rows exist.

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";
const cardClass = "rounded-3xl border border-slate-200 bg-white p-6 shadow-sm";

function emptyDraft() {
  return { location_id: null, name: "", address: "", city: "", phone: "", is_primary: false };
}

export default function LocationsSection({ clientId, actorUserId }) {
  const { t } = useTranslation();
  const [locations, setLocations] = useState([]);
  const [listComplete, setListComplete] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null); // non-null while the add/edit modal is open
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [completenessSaving, setCompletenessSaving] = useState(false);

  useEffect(() => {
    if (clientId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/client-router?resource=locations&actor_user_id=${encodeURIComponent(actorUserId || "")}&client_id=${encodeURIComponent(clientId || "")}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.message || t("locations.errLoadFailed"));
      setLocations(data.locations || []);
      setListComplete(data.locations_list_complete === true);
      setCanEdit(data.can_edit !== false);
    } catch (err) {
      console.error(err);
      setError(t("locations.errLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function callApi(action, payload = {}) {
    const res = await fetch("/api/client-router?resource=locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actor_user_id: actorUserId, client_id: clientId, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) throw new Error(data?.message);
    return data;
  }

  async function handleSaveDraft() {
    if (!draft.address.trim()) {
      setError(t("locations.errAddressRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (draft.location_id) {
        const result = await callApi("update", { location_id: draft.location_id, name: draft.name, address: draft.address, city: draft.city, phone: draft.phone });
        setLocations((prev) => prev.map((l) => (l.id === draft.location_id ? result.location : l)));
      } else {
        const result = await callApi("add", { name: draft.name, address: draft.address, city: draft.city, phone: draft.phone, is_primary: draft.is_primary });
        setLocations((prev) => [...prev.map((l) => (draft.is_primary ? { ...l, is_primary: false } : l)), result.location]);
      }
      setDraft(null);
    } catch (err) {
      console.error(err);
      setError(err.message || t("locations.errSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetPrimary(id) {
    setBusyId(id);
    setError("");
    try {
      await callApi("set_primary", { location_id: id });
      setLocations((prev) => prev.map((l) => ({ ...l, is_primary: l.id === id })));
    } catch (err) {
      console.error(err);
      setError(err.message || t("locations.errActionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleActive(loc) {
    setBusyId(loc.id);
    setError("");
    try {
      const result = await callApi("set_active", { location_id: loc.id, is_active: !loc.is_active });
      setLocations((prev) => prev.map((l) => (l.id === loc.id ? result.location : l)));
    } catch (err) {
      console.error(err);
      setError(err.message || t("locations.errActionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm(t("locations.confirmDelete"))) return;
    setBusyId(id);
    setError("");
    try {
      await callApi("delete", { location_id: id });
      setLocations((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      console.error(err);
      setError(err.message || t("locations.errActionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleComplete() {
    const next = !listComplete;
    setCompletenessSaving(true);
    setError("");
    try {
      await callApi("set_list_complete", { is_complete: next });
      setListComplete(next);
    } catch (err) {
      console.error(err);
      setError(err.message || t("locations.errActionFailed"));
    } finally {
      setCompletenessSaving(false);
    }
  }

  return (
    <div className={cardClass}>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-xl">📍</div>
        <div>
          <h3 className="font-black text-slate-950">{t("locations.title")}</h3>
          <p className="text-xs text-slate-500">{t("locations.subtitle")}</p>
        </div>
      </div>

      {error && <div className="mb-4 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      {loading ? (
        <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">{t("common.loading")}</div>
      ) : (
        <>
          {locations.length === 0 ? (
            <p className="mb-4 text-sm text-slate-400">{t("locations.empty")}</p>
          ) : (
            <div className="mb-4 space-y-2">
              {locations.map((loc) => (
                <div key={loc.id} className={`rounded-2xl border p-3 ${loc.is_active ? "border-slate-200" : "border-slate-100 bg-slate-50 opacity-60"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {loc.is_primary && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">{t("locations.primaryBadge")}</span>}
                        <p className="font-semibold text-slate-800">{loc.name || t("locations.unnamedLocation")}</p>
                        {!loc.is_active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">{t("locations.inactiveBadge")}</span>}
                      </div>
                      <p className="text-xs text-slate-500">{[loc.address, loc.city].filter(Boolean).join(", ")}</p>
                      {loc.phone && <p className="text-xs text-slate-400">{loc.phone}</p>}
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-1.5">
                        {loc.is_active && !loc.is_primary && (
                          <button type="button" disabled={busyId === loc.id} onClick={() => handleSetPrimary(loc.id)} title={t("locations.actionSetPrimary")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                            <StarIcon className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId === loc.id}
                          onClick={() => setDraft({ location_id: loc.id, name: loc.name || "", address: loc.address || "", city: loc.city || "", phone: loc.phone || "", is_primary: loc.is_primary })}
                          title={t("locations.actionEdit")}
                          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                        <button type="button" disabled={busyId === loc.id} onClick={() => handleToggleActive(loc)} className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                          {loc.is_active ? t("locations.actionDeactivate") : t("locations.actionActivate")}
                        </button>
                        <button type="button" disabled={busyId === loc.id} onClick={() => handleDelete(loc.id)} title={t("locations.actionDelete")} className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 disabled:opacity-40">
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <button type="button" onClick={() => setDraft(emptyDraft())} className="mb-5 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50">
              {t("locations.addButton")}
            </button>
          )}

          <div className="border-t border-slate-100 pt-4">
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={listComplete} disabled={!canEdit || completenessSaving} onChange={handleToggleComplete} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <span className="block text-sm font-bold text-slate-700">{t("locations.completeToggleLabel")}</span>
                <span className="block text-xs text-slate-400">{t("locations.completeToggleHint")}</span>
              </span>
            </label>
          </div>
        </>
      )}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h4 className="font-bold text-slate-900">{draft.location_id ? t("locations.editTitle") : t("locations.addTitle")}</h4>
              <button type="button" onClick={() => setDraft(null)}>
                <XMarkIcon className="h-5 w-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("locations.fieldName")}</label>
                <input className={inputClass} value={draft.name} onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))} disabled={saving} placeholder={t("locations.fieldNamePlaceholder")} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("locations.fieldAddress")}</label>
                <input className={inputClass} value={draft.address} onChange={(e) => setDraft((p) => ({ ...p, address: e.target.value }))} disabled={saving} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("locations.fieldCity")}</label>
                <input className={inputClass} value={draft.city} onChange={(e) => setDraft((p) => ({ ...p, city: e.target.value }))} disabled={saving} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("locations.fieldPhone")}</label>
                <input className={inputClass} value={draft.phone} onChange={(e) => setDraft((p) => ({ ...p, phone: e.target.value }))} disabled={saving} />
              </div>
              {!draft.location_id && (
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={draft.is_primary} onChange={(e) => setDraft((p) => ({ ...p, is_primary: e.target.checked }))} disabled={saving} className="h-4 w-4 rounded border-slate-300" />
                  {t("locations.fieldIsPrimary")}
                </label>
              )}
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={handleSaveDraft} disabled={saving} className="flex-1 rounded-2xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-60">
                {saving ? t("settings.saving") : t("locations.save")}
              </button>
              <button type="button" onClick={() => setDraft(null)} disabled={saving} className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
                {t("locations.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
