import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
  PencilSquareIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { getReplyModeLabel, getReplyModeSelectOptions, DEFAULT_REPLY_MODE } from "../../lib/replyMode.js";
import {
  buildEmbedSnippet,
  buildPreviewUrl,
  isHostListed,
  maskPublicKey,
  parseDomainsInput,
} from "../../lib/websiteChatEmbed.js";

// Website Chat — site management + install UI on the Integrations page
// (Phase U MVP). Data comes ONLY from the existing server resource
// /api/client-integrations?resource=website_chat (api/_lib/websiteChatAccounts.js),
// whose safe site shape is { id, is_active, display_name, public_key,
// key_version, allowed_domains, reply_mode, created_at }. The internal
// channelKey is server-only: never returned, never requested, never shown.
// Rotate key / Delete are supported by the API but intentionally not
// exposed in this pass.

const API = "/api/client-integrations?resource=website_chat";
const EMPTY_FORM = { display_name: "", domains: "", reply_mode: DEFAULT_REPLY_MODE, is_active: true };

function CopyButton({ value, label, copiedLabel }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!value}
      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      <ClipboardDocumentIcon className="h-4 w-4" />
      {copied ? copiedLabel : label}
    </button>
  );
}

export default function WebsiteChatSection({ actorUserId, maxConnections, subscriptionActive = true, onSitesChange }) {
  const { t, i18n } = useTranslation();
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null); // null = create
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const dashboardHost = typeof window !== "undefined" ? window.location.hostname : "";

  useEffect(() => {
    loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorUserId]);

  function applySites(next) {
    setSites(next);
    if (onSitesChange) onSitesChange(next);
  }

  async function loadSites() {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`${API}&actor_user_id=${encodeURIComponent(actorUserId || "")}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || "load failed");
      applySites(Array.isArray(data.sites) ? data.sites : []);
    } catch (err) {
      console.error(err);
      setError(t("websiteChat.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function callApi(action, payload = {}) {
    const response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actor_user_id: actorUserId, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.message || t("websiteChat.saveFailed"));
    }
    return data;
  }

  const hasLimit = maxConnections !== null && maxConnections !== undefined;
  const limitReached = hasLimit && sites.length >= maxConnections;
  const addDisabledReason = !subscriptionActive
    ? t("integrationsPage.subscriptionInactiveAddTooltip")
    : limitReached
    ? t("websiteChat.limitReached", { max: maxConnections })
    : null;
  const usageLabel = useMemo(
    () => (hasLimit ? `${sites.length} / ${maxConnections}` : t("websiteChat.countUnlimited", { count: sites.length })),
    [hasLimit, sites.length, maxConnections, t]
  );

  function openCreate() {
    setError("");
    setMessage("");
    setEditingSite(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(site) {
    setError("");
    setMessage("");
    setEditingSite(site);
    setForm({
      display_name: site.display_name || "",
      domains: (site.allowed_domains || []).join("\n"),
      reply_mode: site.reply_mode || DEFAULT_REPLY_MODE,
      is_active: site.is_active !== false,
    });
    setFormOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const displayName = form.display_name.trim();
    const domains = parseDomainsInput(form.domains);
    if (!displayName) return setError(t("websiteChat.nameRequired"));
    if (domains.length === 0) return setError(t("websiteChat.domainsRequired"));

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = { display_name: displayName, allowed_domains: domains, reply_mode: form.reply_mode };
      if (editingSite) {
        const { site } = await callApi("update", { id: editingSite.id, ...payload });
        applySites(sites.map((s) => (s.id === site.id ? site : s)));
        setMessage(t("websiteChat.updated"));
      } else {
        const { site } = await callApi("create", { ...payload, is_active: form.is_active });
        applySites([...sites, site]);
        setMessage(t("websiteChat.created"));
      }
      setFormOpen(false);
    } catch (err) {
      console.error(err);
      setError(err.message || t("websiteChat.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(site) {
    if (togglingId) return;
    setTogglingId(site.id);
    setError("");
    setMessage("");
    try {
      const { site: updated } = await callApi("set_active", { id: site.id, is_active: !site.is_active });
      applySites(sites.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      console.error(err);
      setError(err.message || t("websiteChat.saveFailed"));
    } finally {
      setTogglingId(null);
    }
  }

  const replyOptions = getReplyModeSelectOptions(form.reply_mode, t);

  return (
    <div className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{t("websiteChat.sectionTitle")}</h3>
          <p className="mt-1 text-sm text-slate-500">{t("websiteChat.sectionSubtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">{usageLabel}</span>
          <button
            type="button"
            onClick={openCreate}
            disabled={!!addDisabledReason}
            title={addDisabledReason || undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            {t("websiteChat.addWebsite")}
          </button>
        </div>
      </div>

      {(error || message) && (
        <div
          className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
            error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error || message}
        </div>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <h4 className="text-sm font-bold text-slate-900">
            {editingSite ? t("websiteChat.editWebsite") : t("websiteChat.addWebsite")}
          </h4>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">{t("websiteChat.displayName")}</span>
            <input
              value={form.display_name}
              maxLength={100}
              onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">{t("websiteChat.allowedDomains")}</span>
            <textarea
              dir="ltr"
              rows={3}
              value={form.domains}
              placeholder="example.com&#10;*.example.com"
              onChange={(e) => setForm((f) => ({ ...f, domains: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
            />
            <span className="mt-1 block text-[11px] leading-5 text-slate-500">{t("websiteChat.domainsHelp")}</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-600">{t("integrationsPage.replyModeLabel")}</span>
            <select
              value={form.reply_mode}
              onChange={(e) => setForm((f) => ({ ...f, reply_mode: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
            >
              {replyOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {!editingSite && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
              />
              {t("websiteChat.activeOnCreate")}
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {t("websiteChat.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="mt-4 space-y-4">
        {loading ? (
          <div className="rounded-2xl border border-slate-200 p-4 text-center text-sm text-slate-500">
            {t("websiteChat.loading")}
          </div>
        ) : sites.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
            {t("websiteChat.emptyState")}
          </div>
        ) : (
          sites.map((site) => {
            const snippet = buildEmbedSnippet(origin, site.public_key);
            const previewUrl = buildPreviewUrl(origin, site.public_key, i18n?.language);
            const previewHostListed = isHostListed(dashboardHost, site.allowed_domains);
            return (
              <div key={site.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
                      <GlobeAltIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-950">{site.display_name || t("websiteChat.unnamedSite")}</h4>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            site.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {site.is_active ? t("common.active") : t("websiteChat.inactive")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {t("integrationsPage.replyModeLabel")}: {getReplyModeLabel(site.reply_mode, t)}
                      </p>
                      <p dir="ltr" className="mt-1 text-xs text-slate-500">
                        {t("websiteChat.publicKey")}: {maskPublicKey(site.public_key)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(site.allowed_domains || []).map((d) => (
                          <span key={d} dir="ltr" className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(site)}
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <PencilSquareIcon className="h-4 w-4" />
                      {t("websiteChat.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(site)}
                      disabled={togglingId === site.id || (!site.is_active && !subscriptionActive)}
                      className={`rounded-xl px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                        site.is_active ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}
                    >
                      {site.is_active ? t("websiteChat.disable") : t("websiteChat.enable")}
                    </button>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold text-slate-800">{t("websiteChat.installTitle")}</p>
                      <p className="mt-1 text-[11px] leading-5 text-slate-500">{t("websiteChat.installHint")}</p>
                    </div>
                    <CopyButton value={snippet} label={t("websiteChat.copyCode")} copiedLabel={t("common.copied")} />
                  </div>
                  <pre dir="ltr" className="mt-3 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-white px-3 py-2 text-left text-xs leading-5 text-indigo-700">
                    {snippet}
                  </pre>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">{t("websiteChat.domainNote")}</p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <a
                    href={previewUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    {t("websiteChat.previewChat")}
                  </a>
                  {!previewHostListed && (
                    <p className="text-[11px] leading-5 text-amber-700">
                      {t("websiteChat.previewHostHint", { host: dashboardHost })}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
