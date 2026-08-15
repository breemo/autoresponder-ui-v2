// Canonical Reply Mode options — the SAME three options, in the SAME
// order, on every channel that exposes this setting (Facebook, Telegram,
// Instagram, WhatsApp Evolution, and any future feature). Single source of
// truth: ClientIntegrations.jsx and WhatsAppEvolutionSection.jsx both
// import from here rather than each defining their own copy.
//
// The stored value is always the literal English string below, in
// config.reply_mode — only the DISPLAYED label is translated (via
// labelKey + i18next, see getReplyModeLabel/getReplyModeSelectOptions
// below). Never config["Reply Mode"] (the admin-defined field label) —
// see isReplyModeKey() and ClientIntegrations.jsx's
// cleanReplyModeConfig(), which strips that legacy key on save.
export const REPLY_MODE_OPTIONS = [
  { value: "ai", labelKey: "replyMode.ai" },
  { value: "auto", labelKey: "replyMode.auto" },
  { value: "welcome_only", labelKey: "replyMode.welcomeOnly" },
];

export const REPLY_MODE_VALUES = REPLY_MODE_OPTIONS.map((opt) => opt.value);

export const DEFAULT_REPLY_MODE = "ai";

// Recognizes any reasonable admin-defined field-name spelling of "Reply
// Mode" (e.g. "Reply Mode", "reply_mode", "reply-mode", "ReplyMode",
// "REPLY_MODE") as the same canonical setting, regardless of exactly how a
// feature's `fields` definition names it. Previously there were two
// separate, slightly different checks in ClientIntegrations.jsx — the
// whatsapp_evolution-only field filter matched both "replymode" and
// "reply_mode", but the actual dropdown-vs-text-input decision only
// matched "replymode" — so a feature (any channel, including
// whatsapp_evolution itself) whose field was literally named "reply_mode"
// fell through to a plain text input instead of this dropdown. One shared
// matcher now used everywhere a reply-mode field is detected or cleaned up.
export function isReplyModeKey(key) {
  const normalized = (key || "").toString().toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "replymode";
}

// Human-readable label for a stored reply_mode value, resolved through the
// active i18next `t` function so it follows the UI language. `t` is
// optional — callers that don't pass one (or during any code path that
// runs before i18n is ready) fall back to the raw labelKey, which is still
// a stable, non-crashing string, just not translated. Unknown/legacy
// values are shown as-is rather than crashing or silently disappearing —
// same "don't lose data you don't recognize" principle as
// getReplyModeSelectOptions below.
export function getReplyModeLabel(value, t) {
  const translate = typeof t === "function" ? t : (key) => key;
  const match = REPLY_MODE_OPTIONS.find((opt) => opt.value === value);
  if (match) return translate(match.labelKey);
  if (value) return value;
  return translate(REPLY_MODE_OPTIONS.find((opt) => opt.value === DEFAULT_REPLY_MODE).labelKey);
}

// The full canonical option list for a <select> (each entry's `label`
// resolved through `t`), plus any legacy/unknown value already stored on
// this integration so it isn't silently dropped from the dropdown if saved
// without being touched (backward compatible — an unrecognized legacy
// value never crashes the UI).
export function getReplyModeSelectOptions(currentValue, t) {
  const translate = typeof t === "function" ? t : (key) => key;
  const options = REPLY_MODE_OPTIONS.map((opt) => ({ value: opt.value, label: translate(opt.labelKey) }));
  if (!currentValue || REPLY_MODE_VALUES.includes(currentValue)) return options;
  return [...options, { value: currentValue, label: currentValue }];
}
