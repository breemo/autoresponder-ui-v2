import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowPathIcon, CheckCircleIcon, CursorArrowRaysIcon, MagnifyingGlassIcon, PencilSquareIcon, PlusIcon, Squares2X2Icon, TrashIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { Card, EmptyState, PageHeader, Skeleton, StatTile, cx, ui } from "../../components/app/primitives.jsx";
import { Drawer, Notice } from "../../components/app/Overlay.jsx";
import { CheckboxMultiSelect, ToggleSwitch, stripPlus } from "./replies/repliesUi.jsx";

const inputClass = ui.input;

// Quick Replies. Data access, payload fallback, ordering rule and the
// hide_after_payloads array are unchanged (quick_reply_templates); only the
// presentation follows the Client Portal design system.
export default function ClientQuickReplies() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [clientId, setClientId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState("");
  const [type, setType] = useState("custom");
  const [displayOrder, setDisplayOrder] = useState(0);
  const [hideAfterPayloads, setHideAfterPayloads] = useState([]);

  useEffect(() => { if (user?.client_id) setClientId(user.client_id); }, [user]);

  const fetchData = async () => {
    if (!clientId) return;
    setLoading(true); setError("");
    const { data, error } = await supabase.from("quick_reply_templates").select("*").eq("client_id", clientId).order("display_order", { ascending: true });
    if (error) { console.error(error); setError(t("quickRepliesPage.errorLoad")); } else setItems(data || []);
    setLoading(false);
  };
  useEffect(() => { fetchData(); }, [clientId]);

  const resetForm = () => { setEditingId(null); setTitle(""); setPayload(""); setType("custom"); setDisplayOrder(0); setHideAfterPayloads([]); };
  const openCreate = () => { resetForm(); setDrawerOpen(true); };
  const handleEdit = (item) => { setEditingId(item.id); setTitle(item.title || ""); setPayload(item.payload || ""); setType(item.action_type || "custom"); setDisplayOrder(item.display_order || 0); setHideAfterPayloads(item.hide_after_payloads || []); setDrawerOpen(true); };

  const handleSave = async () => {
    setError("");
    if (!clientId) return setError(t("quickRepliesPage.errorNoClient"));
    if (!title.trim()) return setError(t("quickRepliesPage.errorEmptyText"));
    const finalPayload = payload.trim() || title.trim().replace(/\s+/g, "_").toUpperCase();
    const record = { client_id: clientId, title: title.trim(), payload: finalPayload, action_type: type, display_order: Number(displayOrder) || items.length + 1, is_active: true, hide_after_payloads: hideAfterPayloads };
    const query = editingId ? supabase.from("quick_reply_templates").update(record).eq("id", editingId).eq("client_id", clientId) : supabase.from("quick_reply_templates").insert([record]);
    const { error } = await query;
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorSave")); }
    resetForm(); setDrawerOpen(false); fetchData();
  };

  const handleToggle = async (item) => {
    const { error } = await supabase.from("quick_reply_templates").update({ is_active: !item.is_active }).eq("id", item.id).eq("client_id", clientId);
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorStatusUpdate")); }
    fetchData();
  };

  const handleDelete = async (id) => {
    if (!confirm(t("quickRepliesPage.confirmDelete"))) return;
    const { error } = await supabase.from("quick_reply_templates").delete().eq("id", id).eq("client_id", clientId);
    if (error) { console.error(error); return setError(t("quickRepliesPage.errorDelete")); }
    fetchData();
  };

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return !s ? items : items.filter((i) => `${i.title || ""} ${i.payload || ""} ${i.action_type || ""}`.toLowerCase().includes(s));
  }, [items, search]);

  const TYPE_LABELS = {
    custom: t("quickRepliesPage.typeCustom"),
    order: t("quickRepliesPage.typeOrder"),
    booking: t("quickRepliesPage.typeBooking"),
    quote: t("quickRepliesPage.typeQuote"),
    human_request: t("quickRepliesPage.typeHumanRequest"),
    question: t("quickRepliesPage.typeQuestion"),
  };
  // Same option list as the former <select multiple>: every item, value = payload.
  const hideAfterOptions = items.map((item) => ({ key: item.id, value: item.payload, label: item.title }));

  const actions = (item) => (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => handleEdit(item)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <PencilSquareIcon className="h-4 w-4" />
        {t("common.edit")}
      </button>
      <button type="button" onClick={() => handleDelete(item.id)} aria-label={`${t("common.delete")}: ${item.title}`} title={t("common.delete")} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
  const payloadChip = (value) => <code dir="ltr" className="inline-block max-w-full truncate rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-100">{value}</code>;
  const hideAfterCell = (item) =>
    (item.hide_after_payloads || []).length ? (
      <div className="flex flex-wrap gap-1">
        {item.hide_after_payloads.map((p, i) => (
          <code key={`${p}-${i}`} dir="ltr" className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{p}</code>
        ))}
      </div>
    ) : (
      <span className="text-slate-400">—</span>
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("navigation.quickReplies")}
        description={t("quickRepliesPage.subtitle")}
        actions={
          <button type="button" onClick={openCreate} className={ui.btnPrimary}>
            <PlusIcon className="h-4 w-4" />
            {stripPlus(t("quickRepliesPage.addButton"))}
          </button>
        }
      />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label={t("quickRepliesPage.statTotal")} value={items.length} icon={CursorArrowRaysIcon} tone="indigo" loading={loading && !items.length} />
        <StatTile label={t("quickRepliesPage.statActive")} value={items.filter((i) => i.is_active).length} icon={CheckCircleIcon} tone="emerald" loading={loading && !items.length} />
        <StatTile label={t("quickRepliesPage.statTypes")} value={new Set(items.map((i) => i.action_type)).size} icon={Squares2X2Icon} tone="violet" loading={loading && !items.length} />
      </div>

      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 sm:p-4">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <MagnifyingGlassIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input type="search" className={cx(inputClass, "ps-9")} placeholder={t("quickRepliesPage.searchPlaceholder")} aria-label={t("quickRepliesPage.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button type="button" onClick={fetchData} disabled={loading} className={ui.btnSecondary}>
            <ArrowPathIcon className={cx("h-4 w-4", loading && "animate-spin")} />
            {t("common.refresh")}
          </button>
        </div>

        {loading && !items.length ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4"><EmptyState icon={CursorArrowRaysIcon} title={t("quickRepliesPage.empty")} /></div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                  <tr>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("quickRepliesPage.colText")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">Payload</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("common.type")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("quickRepliesPage.colHideAfter")}</th>
                    <th className="w-20 px-4 py-2.5 text-start font-semibold">{t("quickRepliesPage.colOrder")}</th>
                    <th className="w-36 px-4 py-2.5 text-start font-semibold">{t("common.status")}</th>
                    <th className="w-40 px-4 py-2.5 text-start font-semibold">{t("leads.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((item) => (
                    <tr key={item.id} data-qr-id={item.id} className="align-middle transition hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-semibold text-slate-900"><span dir="auto" className="break-words">{item.title}</span></td>
                      <td className="max-w-[200px] px-4 py-3">{payloadChip(item.payload)}</td>
                      <td className="px-4 py-3 text-slate-600">{TYPE_LABELS[item.action_type] || item.action_type}</td>
                      <td className="max-w-[240px] px-4 py-3">{hideAfterCell(item)}</td>
                      <td className="px-4 py-3 tabular-nums text-slate-600">{item.display_order}</td>
                      <td className="px-4 py-3"><ToggleSwitch checked={item.is_active} onChange={() => handleToggle(item)} label={item.is_active ? t("common.active") : t("common.inactive")} /></td>
                      <td className="px-4 py-3">{actions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-slate-100 lg:hidden">
              {filtered.map((item) => (
                <li key={item.id} data-qr-id={item.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p dir="auto" className="break-words font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{TYPE_LABELS[item.action_type] || item.action_type} · {t("quickRepliesPage.colOrder")} {item.display_order}</p>
                    </div>
                    <ToggleSwitch checked={item.is_active} onChange={() => handleToggle(item)} label={item.is_active ? t("common.active") : t("common.inactive")} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">{payloadChip(item.payload)}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    <span>{t("quickRepliesPage.colHideAfter")}:</span>
                    {hideAfterCell(item)}
                  </div>
                  {actions(item)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editingId ? t("quickRepliesPage.drawerEditTitle") : t("quickRepliesPage.drawerAddTitle")}
        closeLabel={t("common.close")}
        footer={
          <>
            <button type="button" onClick={() => setDrawerOpen(false)} className={ui.btnSecondary}>{t("common.cancel")}</button>
            <button type="button" onClick={handleSave} className={ui.btnPrimary}>{editingId ? t("quickRepliesPage.saveEdit") : t("quickRepliesPage.addOption")}</button>
          </>
        }
      >
        <div className="space-y-4">
          {error && drawerOpen && <Notice tone="error">{error}</Notice>}
          <div>
            <label htmlFor="qr-title" className={ui.label}>{t("quickRepliesPage.fieldButtonText")}</label>
            <input id="qr-title" dir="auto" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("quickRepliesPage.fieldButtonTextPlaceholder")} />
          </div>
          <div>
            <label htmlFor="qr-payload" className={ui.label}>{t("quickRepliesPage.fieldPayloadOptional")}</label>
            <input id="qr-payload" dir="ltr" className={cx(inputClass, "font-mono")} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="BOOKING" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="qr-type" className={ui.label}>{t("common.type")}</label>
              <select id="qr-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="custom">{t("quickRepliesPage.typeCustom")}</option>
                <option value="order">{t("quickRepliesPage.typeOrder")}</option>
                <option value="booking">{t("quickRepliesPage.typeBooking")}</option>
                <option value="quote">{t("quickRepliesPage.typeQuote")}</option>
                <option value="human_request">{t("quickRepliesPage.typeHumanRequest")}</option>
                <option value="question">{t("quickRepliesPage.typeQuestion")}</option>
              </select>
            </div>
            <div>
              <label htmlFor="qr-order" className={ui.label}>{t("quickRepliesPage.colOrder")}</label>
              <input id="qr-order" type="number" className={inputClass} value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
            </div>
          </div>
          <div>
            <p id="qr-hide-label" className={ui.label}>{t("quickRepliesPage.fieldHideAfter")}</p>
            <div aria-labelledby="qr-hide-label">
              <CheckboxMultiSelect id="qr-hide-after" options={hideAfterOptions} value={hideAfterPayloads} onChange={setHideAfterPayloads} emptyText={t("quickRepliesPage.empty")} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{t("replies.hideAfterHint")}</p>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
