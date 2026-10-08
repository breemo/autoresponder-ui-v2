import React, { forwardRef } from "react";
import { Cog6ToothIcon, LockClosedIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Card, Skeleton, cx, ui } from "../../../components/app/primitives.jsx";

// Reply Tone quick-select chips — same values and labels as the AI Behavior
// drawer (AdminClientSettings.jsx). The stored value stays the plain
// lowercase English word; the input below stays editable for a custom tone.
export const REPLY_TONE_PRESETS = [
  { value: "friendly", labelKey: "aiBehaviorToneFriendly" },
  { value: "professional", labelKey: "aiBehaviorToneProfessional" },
  { value: "casual", labelKey: "aiBehaviorToneCasual" },
  { value: "formal", labelKey: "aiBehaviorToneFormal" },
  { value: "enthusiastic", labelKey: "aiBehaviorToneEnthusiastic" },
];

const textarea = cx(ui.input, "min-h-[84px] resize-y leading-6");
const label = "mb-1 block text-[13px] font-medium text-slate-700";
const help = "mb-1.5 text-xs text-slate-500";

// In-page AI Settings (replaces the old Edit drawer). Fields, labels,
// placeholders, input types and storage keys are the drawer's, unchanged;
// only the arrangement follows the approved two-column design.
const AiSettingsSection = forwardRef(function AiSettingsSection(
  { t, loading, readOnly, saving, form, onChange, newForbiddenRule, onNewForbiddenRuleChange, onAddForbiddenRule, onRemoveForbiddenRule, onSave, message },
  firstFieldRef
) {
  return (
    <Card id="ai-settings" as="section" className="scroll-mt-20" aria-labelledby="ai-settings-title">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100">
          <Cog6ToothIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="ai-settings-title" className="text-[15px] font-semibold text-slate-900">
            {t("aiAgent.settingsTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">{t("featureSettingsPage.aiBehaviorSubtitle")}</p>
        </div>
      </div>

      {readOnly && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t("featureSettingsPage.readOnlyNotice")}</p>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
            {/* Left column: language, personality, tone */}
            <div className="min-w-0 space-y-4">
              <div>
                <label htmlFor="ai-default-language" className={label}>
                  {t("featureSettingsPage.aiBehaviorLanguage")}
                </label>
                <select
                  id="ai-default-language"
                  ref={firstFieldRef}
                  value={form.default_language}
                  onChange={(e) => onChange("default_language", e.target.value)}
                  className={ui.input}
                  disabled={readOnly}
                >
                  <option value="">—</option>
                  <option value="ar">{t("featureSettingsPage.aiBehaviorLanguageArabic")}</option>
                  <option value="en">{t("featureSettingsPage.aiBehaviorLanguageEnglish")}</option>
                </select>
              </div>

              <div>
                <label htmlFor="ai-personality" className={label}>
                  {t("featureSettingsPage.aiBehaviorPersonality")}
                </label>
                <p className={help}>{t("featureSettingsPage.aiBehaviorPersonalityHelp")}</p>
                <input
                  id="ai-personality"
                  type="text"
                  value={form.personality}
                  onChange={(e) => onChange("personality", e.target.value)}
                  placeholder={t("featureSettingsPage.aiBehaviorPersonalityPlaceholder")}
                  className={ui.input}
                  disabled={readOnly}
                />
              </div>

              <div>
                <label htmlFor="ai-reply-tone" className={label}>
                  {t("featureSettingsPage.aiBehaviorReplyTone")}
                </label>
                <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label={t("featureSettingsPage.aiBehaviorReplyTone")}>
                  {REPLY_TONE_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={form.reply_tone === preset.value}
                      onClick={() => onChange("reply_tone", preset.value)}
                      className={cx(
                        "rounded-full px-3 py-1 text-xs font-semibold ring-1 transition disabled:opacity-60",
                        form.reply_tone === preset.value ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"
                      )}
                    >
                      {t(`featureSettingsPage.${preset.labelKey}`)}
                    </button>
                  ))}
                </div>
                <input
                  id="ai-reply-tone"
                  type="text"
                  value={form.reply_tone}
                  onChange={(e) => onChange("reply_tone", e.target.value)}
                  placeholder={t("featureSettingsPage.aiBehaviorReplyTonePlaceholder")}
                  className={ui.input}
                  disabled={readOnly}
                />
              </div>
            </div>

            {/* Right column: forbidden rules + instructions */}
            <div className="min-w-0 space-y-4">
              <div>
                <label htmlFor="ai-forbidden-new" className={label}>
                  {t("featureSettingsPage.aiBehaviorForbiddenRules")}
                </label>
                <p className={help}>{t("featureSettingsPage.aiBehaviorForbiddenRulesSubtitle")}</p>
                {form.forbidden_rules.length === 0 ? (
                  <p className="mb-2 text-xs text-slate-400">{t("featureSettingsPage.aiBehaviorForbiddenRulesEmpty")}</p>
                ) : (
                  <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t("featureSettingsPage.aiBehaviorForbiddenRules")}>
                    {form.forbidden_rules.map((rule, index) => (
                      <li key={index} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-rose-50 py-1 pe-1.5 ps-3 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-100">
                        <span className="truncate" dir="auto">
                          {rule}
                        </span>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => onRemoveForbiddenRule(index)}
                            aria-label={`${t("common.delete")}: ${rule}`}
                            className="shrink-0 rounded-full p-0.5 text-rose-500 hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!readOnly && (
                  <div className="flex gap-2">
                    <input
                      id="ai-forbidden-new"
                      type="text"
                      value={newForbiddenRule}
                      onChange={(e) => onNewForbiddenRuleChange(e.target.value)}
                      placeholder={t("featureSettingsPage.aiBehaviorForbiddenRulesPlaceholder")}
                      className={cx(ui.input, "flex-1")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onAddForbiddenRule();
                        }
                      }}
                    />
                    <button type="button" onClick={onAddForbiddenRule} className={cx(ui.btnSecondary, "shrink-0")}>
                      {t("featureSettingsPage.aiBehaviorForbiddenRulesAdd")}
                    </button>
                  </div>
                )}
              </div>

              <div role="group" aria-labelledby="ai-instructions-title" className="space-y-3 rounded-xl border border-slate-200/80 p-3">
                <div>
                  <h3 id="ai-instructions-title" className="text-[13px] font-semibold text-slate-800">{t("featureSettingsPage.aiBehaviorInstructionsGroupTitle")}</h3>
                  <p className="mt-0.5 text-xs text-slate-500">{t("featureSettingsPage.aiBehaviorInstructionsGroupSubtitle")}</p>
                </div>
                {[
                  ["special_instructions", "aiBehaviorSpecialInstructions", "aiBehaviorSpecialInstructionsPlaceholder"],
                  ["booking_instructions", "aiBehaviorBookingInstructions", "aiBehaviorBookingInstructionsPlaceholder"],
                  ["escalation_instructions", "aiBehaviorEscalationInstructions", "aiBehaviorEscalationInstructionsPlaceholder"],
                ].map(([field, labelKey, placeholderKey]) => (
                  <div key={field}>
                    <label htmlFor={`ai-${field}`} className={label}>
                      {t(`featureSettingsPage.${labelKey}`)}
                    </label>
                    <textarea
                      id={`ai-${field}`}
                      rows={2}
                      value={form[field]}
                      onChange={(e) => onChange(field, e.target.value)}
                      placeholder={t(`featureSettingsPage.${placeholderKey}`)}
                      className={textarea}
                      disabled={readOnly}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-4">
            {message?.text && (
              <p role="status" className={cx("me-auto text-sm font-medium", message.type === "error" ? "text-rose-600" : "text-emerald-600")}>
                {message.text}
              </p>
            )}
            {readOnly ? (
              <p className="text-xs text-slate-500">{t("featureSettingsPage.readOnlyFooterNote")}</p>
            ) : (
              <button type="submit" disabled={saving} className={ui.btnPrimary}>
                {saving ? t("settings.saving") : t("aiAgent.saveChanges")}
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
});

export default AiSettingsSection;
