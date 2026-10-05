import React, { useState } from "react";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { getReplyModeSelectOptions, DEFAULT_REPLY_MODE } from "../../lib/replyMode.js";

// Instagram manual-setup surface (web/API only — no OAuth, no Multi-Account).
//
// Presentational: all state, persistence, and the Save/Activate/Pause
// buttons live in the parent (ClientIntegrations.jsx). This component only
// renders the Instagram-specific fields + the manual Meta setup guide, and
// reports edits up via onFieldChange(key, value).
//
// The stored config it reads is ALWAYS the redacted shape returned by
// /api/client-integrations (action "list" / "save_instagram_config"):
// verify_token and channelKey are present; the Page Access Token is never
// present — its saved/empty state is conveyed by `hasPageAccessToken`.

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-fuchsia-300 focus:ring-4 focus:ring-fuchsia-50";

function CopyButton({ value }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value || "");
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
      className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
    >
      <ClipboardDocumentIcon className="h-4 w-4" />
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

function ReadOnlyField({ label, value, hint, emptyText }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          dir="ltr"
          value={value || ""}
          placeholder={emptyText}
          className={`${inputClass} cursor-default bg-slate-50 text-left`}
        />
        <CopyButton value={value} />
      </div>
      {hint && <p className="mt-1 text-[11px] leading-5 text-slate-500">{hint}</p>}
    </label>
  );
}

export default function InstagramSetupSection({
  config = {},
  hasPageAccessToken = false,
  webhookBase = "",
  onFieldChange,
}) {
  const { t } = useTranslation();

  const channelKey = config.channelKey || "";
  const verifyToken = config.verify_token || "";
  const webhookUrl =
    webhookBase && channelKey ? `${webhookBase.replace(/\/$/, "")}/instagram/${channelKey}` : "";

  const replyModeValue = config.reply_mode || DEFAULT_REPLY_MODE;
  const replyModeOptions = getReplyModeSelectOptions(replyModeValue, t);

  const notSavedYet = !channelKey;

  return (
    <div className="mt-5 space-y-4">
      {/* ---- Manual setup guide ---- */}
      <div className="rounded-2xl border border-fuchsia-100 bg-fuchsia-50/50 p-4">
        <p className="text-sm font-bold text-slate-900">{t("instagramSetup.guideTitle")}</p>
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs leading-6 text-slate-600">
          <li>{t("instagramSetup.guideStepMetaOpen")}</li>
          <li>{t("instagramSetup.guideStepPasteWebhook")}</li>
          <li>{t("instagramSetup.guideStepPasteToken")}</li>
          <li>{t("instagramSetup.guideStepSubscribeMessages")}</li>
          <li>{t("instagramSetup.guideStepMetaSave")}</li>
        </ol>
        <p className="mt-3 text-sm font-bold text-slate-900">{t("instagramSetup.guideThenHereTitle")}</p>
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs leading-6 text-slate-600">
          <li>{t("instagramSetup.guideStepEnterAccountId")}</li>
          <li>{t("instagramSetup.guideStepEnterPageId")}</li>
          <li>{t("instagramSetup.guideStepEnterToken")}</li>
          <li>{t("instagramSetup.guideStepSaveHere")}</li>
          <li>{t("instagramSetup.guideStepActivate")}</li>
        </ol>
      </div>

      {notSavedYet && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-5 text-amber-700">
          {t("instagramSetup.saveFirstHint")}
        </div>
      )}

      {/* ---- Meta-side values (read-only, copyable) ---- */}
      <div className="grid gap-3 md:grid-cols-2">
        <ReadOnlyField
          label={t("instagramSetup.webhookUrlLabel")}
          value={webhookUrl}
          hint={t("instagramSetup.webhookUrlHint")}
          emptyText={t("instagramSetup.valueAfterSave")}
        />
        <ReadOnlyField
          label={t("instagramSetup.verifyTokenLabel")}
          value={verifyToken}
          hint={t("instagramSetup.verifyTokenHint")}
          emptyText={t("instagramSetup.valueAfterSave")}
        />
      </div>

      {/* ---- Client-entered values ---- */}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">
            {t("instagramSetup.accountIdLabel")}
          </span>
          <input
            type="text"
            dir="ltr"
            className={inputClass}
            value={config.instagram_account_id || ""}
            onChange={(e) => onFieldChange("instagram_account_id", e.target.value)}
            placeholder={t("instagramSetup.accountIdPlaceholder")}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">
            {t("instagramSetup.pageIdLabel")}
          </span>
          <input
            type="text"
            dir="ltr"
            className={inputClass}
            value={config.facebook_page_id || ""}
            onChange={(e) => onFieldChange("facebook_page_id", e.target.value)}
            placeholder={t("instagramSetup.pageIdPlaceholder")}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">
            {t("instagramSetup.tokenLabel")}
          </span>
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            className={inputClass}
            value={config.page_access_token || ""}
            onChange={(e) => onFieldChange("page_access_token", e.target.value)}
            placeholder={
              hasPageAccessToken
                ? t("instagramSetup.tokenPlaceholderSaved")
                : t("instagramSetup.tokenPlaceholderEmpty")
            }
          />
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            {hasPageAccessToken
              ? t("instagramSetup.tokenHintSaved")
              : t("instagramSetup.tokenHintEmpty")}
          </p>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">
            {t("integrationsPage.replyModeLabel")}
          </span>
          <select
            className={inputClass}
            value={replyModeValue}
            onChange={(e) => onFieldChange("reply_mode", e.target.value)}
          >
            {replyModeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
