import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPinIcon, PencilIcon, PhoneIcon, PlusIcon, StarIcon, TrashIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import { Card, Skeleton, StatusPill, cx, ui } from "../../components/app/primitives.jsx";
import { Modal, Notice, SectionHeader } from "../../components/app/Overlay.jsx";

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

const inputClass = ui.input;
const cardClass = `${ui.card} p-4`;

function emptyDraft() {
  return { location_id: null, name: "", address: "", city: "", phone: "", is_primary: false };
}

export default function LocationsSection({ clientId, actorUserId, onSummaryChange }) {
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

  // Presentation-only: report a summary to the page's setup checklist.
  useEffect(() => {
    if (!loading && typeof onSummaryChange === "function") {
      onSummaryChange({ count: locations.length, active: locations.filter((l) => l.is_active).length, complete: listComplete });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, locations, listComplete]);

  const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40";
  const addLabel = String(t("locations.addButton")).replace(/^\+\s*/, "");
  const activeCount = locations.filter((l) => l.is_active).length;

  return (
    <Card as="section" aria-labelledby="locations-title" data-section="locations">
      <SectionHeader
        id="locations-title"
        icon={MapPinIcon}
        tone="rose"
        title={t("locations.title")}
        subtitle={t("locations.subtitle")}
        action={
          canEdit &&
          !loading &&
          locations.length > 0 && (
            <button type="button" onClick={() => setDraft(emptyDraft())} className={ui.btnSecondary}>
              <PlusIcon className="h-4 w-4" />
              {addLabel}
            </button>
          )
        }
      />

      {error && <Notice tone="error" className="mb-3">{error}</Notice>}

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : (
        <>
          {locations.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatusPill tone="slate">{t("accountSettings.locationsCount", { count: locations.length })}</StatusPill>
              <StatusPill tone="emerald" dot>{t("accountSettings.activeCount", { count: activeCount })}</StatusPill>
            </div>
          )}

          {locations.length === 0 ? (
            <div className="mb-4 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center" data-testid="locations-empty">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-rose-50 text-rose-500">
                <MapPinIcon className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-slate-700">{t("locations.empty")}</p>
              {canEdit && (
                <button type="button" onClick={() => setDraft(emptyDraft())} className={cx(ui.btnPrimary, "mt-1")}>
                  <PlusIcon className="h-4 w-4" />
                  {addLabel}
                </button>
              )}
            </div>
          ) : (
            <ul className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {locations.map((loc) => (
                <li
                  key={loc.id}
                  data-location-id={loc.id}
                  className={cx(
                    "flex min-w-0 flex-col rounded-xl border p-3.5 transition",
                    loc.is_primary ? "border-amber-200 bg-amber-50/30" : "border-slate-200/80 bg-white",
                    !loc.is_active && "border-dashed bg-slate-50/60"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className={cx("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", loc.is_active ? "bg-rose-50 text-rose-500" : "bg-slate-100 text-slate-400")}>
                      {loc.is_primary ? <StarSolidIcon className="h-[18px] w-[18px] text-amber-500" /> : <MapPinIcon className="h-[18px] w-[18px]" />}
                    </span>
                    <div className={cx("min-w-0 flex-1", !loc.is_active && "opacity-70")}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate font-semibold text-slate-900" dir="auto">{loc.name || t("locations.unnamedLocation")}</p>
                        {loc.is_primary && <StatusPill tone="amber">{t("locations.primaryBadge")}</StatusPill>}
                        {!loc.is_active && <StatusPill tone="slate">{t("locations.inactiveBadge")}</StatusPill>}
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-slate-600" dir="auto">{[loc.address, loc.city].filter(Boolean).join(", ")}</p>
                      {loc.phone && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-500" dir="ltr">
                          <PhoneIcon className="h-3.5 w-3.5" />
                          {loc.phone}
                        </p>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                      <button
                        type="button"
                        disabled={busyId === loc.id}
                        onClick={() => handleToggleActive(loc)}
                        className="inline-flex h-8 items-center rounded-lg px-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                      >
                        {loc.is_active ? t("locations.actionDeactivate") : t("locations.actionActivate")}
                      </button>
                      <div className="flex items-center gap-0.5">
                        {loc.is_active && !loc.is_primary && (
                          <button type="button" disabled={busyId === loc.id} onClick={() => handleSetPrimary(loc.id)} title={t("locations.actionSetPrimary")} aria-label={t("locations.actionSetPrimary")} className={iconBtn}>
                            <StarIcon className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId === loc.id}
                          onClick={() => setDraft({ location_id: loc.id, name: loc.name || "", address: loc.address || "", city: loc.city || "", phone: loc.phone || "", is_primary: loc.is_primary })}
                          title={t("locations.actionEdit")}
                          aria-label={t("locations.actionEdit")}
                          className={iconBtn}
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                        <button type="button" disabled={busyId === loc.id} onClick={() => handleDelete(loc.id)} title={t("locations.actionDelete")} aria-label={t("locations.actionDelete")} className={cx(iconBtn, "text-rose-500 hover:bg-rose-50 hover:text-rose-600")}>
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Completeness flag — same handler; presented as a switch row */}
          <div className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-slate-50/60 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p id="locations-complete-label" className="text-[13px] font-semibold text-slate-800">{t("locations.completeToggleLabel")}</p>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">{t("locations.completeToggleHint")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={listComplete}
              aria-labelledby="locations-complete-label"
              disabled={!canEdit || completenessSaving}
              onClick={handleToggleComplete}
              data-testid="locations-complete"
              className={cx("relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50", listComplete ? "bg-emerald-500" : "bg-slate-300")}
            >
              <span className={cx("absolute h-5 w-5 rounded-full bg-white shadow transition-all", listComplete ? "start-[22px]" : "start-0.5")} />
            </button>
          </div>
        </>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        closeDisabled={saving}
        title={draft?.location_id ? t("locations.editTitle") : t("locations.addTitle")}
        closeLabel={t("locations.cancel")}
        size="max-w-lg"
        footer={
          <>
            <button type="button" onClick={() => setDraft(null)} disabled={saving} className={ui.btnSecondary}>{t("locations.cancel")}</button>
            <button type="button" onClick={handleSaveDraft} disabled={saving} className={ui.btnPrimary}>{saving ? t("settings.saving") : t("locations.save")}</button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            {error && <Notice tone="error">{error}</Notice>}
            <div>
              <label htmlFor="loc-name" className={ui.label}>{t("locations.fieldName")}</label>
              <input id="loc-name" dir="auto" className={inputClass} value={draft.name} onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))} disabled={saving} placeholder={t("locations.fieldNamePlaceholder")} />
            </div>
            <div>
              <label htmlFor="loc-address" className={ui.label}>{t("locations.fieldAddress")}</label>
              <input id="loc-address" dir="auto" className={inputClass} value={draft.address} onChange={(e) => setDraft((p) => ({ ...p, address: e.target.value }))} disabled={saving} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="loc-city" className={ui.label}>{t("locations.fieldCity")}</label>
                <input id="loc-city" dir="auto" className={inputClass} value={draft.city} onChange={(e) => setDraft((p) => ({ ...p, city: e.target.value }))} disabled={saving} />
              </div>
              <div>
                <label htmlFor="loc-phone" className={ui.label}>{t("locations.fieldPhone")}</label>
                <input id="loc-phone" dir="ltr" className={inputClass} value={draft.phone} onChange={(e) => setDraft((p) => ({ ...p, phone: e.target.value }))} disabled={saving} />
              </div>
            </div>
            {!draft.location_id && (
              <label className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[13px] font-medium text-slate-700">
                <input type="checkbox" checked={draft.is_primary} onChange={(e) => setDraft((p) => ({ ...p, is_primary: e.target.checked }))} disabled={saving} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                {t("locations.fieldIsPrimary")}
              </label>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
