import { useState } from "react";

// AI Engine V1 — Phase 2 AI Behavior state, used by the Client AI Agent page.
// The load/save requests, payload and response mapping are the SAME as the
// AI Behavior drawer in src/pages/admin/AdminClientSettings.jsx (which still
// owns the Admin Portal and is not modified): public.client_ai_behavior via
// /api/client-router?resource=ai-behavior. The server keeps enforcing
// AI_SETTINGS + plan.allow_self_edit; readOnly here only mirrors that.

export const EMPTY_AI_BEHAVIOR_FORM = {
  personality: "",
  reply_tone: "",
  default_language: "",
  special_instructions: "",
  booking_instructions: "",
  escalation_instructions: "",
  forbidden_rules: [],
};

export function behaviorToForm(behavior = {}) {
  return {
    personality: behavior.personality || "",
    reply_tone: behavior.reply_tone || "",
    default_language: behavior.default_language || "",
    special_instructions: behavior.special_instructions || "",
    booking_instructions: behavior.booking_instructions || "",
    escalation_instructions: behavior.escalation_instructions || "",
    forbidden_rules: Array.isArray(behavior.forbidden_rules) ? behavior.forbidden_rules : [],
  };
}

export default function useAiBehavior({ clientId, actorUserId, t }) {
  const [form, setForm] = useState(EMPTY_AI_BEHAVIOR_FORM);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [newForbiddenRule, setNewForbiddenRule] = useState("");

  async function load() {
    if (!clientId) return;
    setLoading(true);
    setNewForbiddenRule("");
    try {
      const response = await fetch(
        `/api/client-router?resource=ai-behavior&actor_user_id=${encodeURIComponent(actorUserId || "")}&client_id=${encodeURIComponent(clientId)}`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("featureSettingsPage.aiBehaviorLoadFailed"));
      }
      setForm(behaviorToForm(data.behavior || {}));
      setLoaded(true);
    } catch (err) {
      console.error(err);
      setMessage({ type: "error", text: t("featureSettingsPage.aiBehaviorLoadFailed") });
      setForm(EMPTY_AI_BEHAVIOR_FORM);
    }
    setLoading(false);
  }

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function addForbiddenRule() {
    const rule = newForbiddenRule.trim();
    if (!rule) return;
    setForm((prev) => ({ ...prev, forbidden_rules: [...prev.forbidden_rules, rule] }));
    setNewForbiddenRule("");
  }

  function removeForbiddenRule(index) {
    setForm((prev) => ({ ...prev, forbidden_rules: prev.forbidden_rules.filter((_, i) => i !== index) }));
  }

  async function save(readOnly) {
    if (readOnly || !clientId) return;
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await fetch("/api/client-router?resource=ai-behavior", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor_user_id: actorUserId,
          client_id: clientId,
          ...form,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("featureSettingsPage.aiBehaviorSaveFailed"));
      }
      setForm(behaviorToForm(data.behavior || {}));
      setMessage({ type: "success", text: t("featureSettingsPage.aiBehaviorSaved") });
    } catch (err) {
      console.error("AI behavior save error:", err);
      setMessage({ type: "error", text: t("featureSettingsPage.aiBehaviorSaveFailed") });
    }
    setSaving(false);
  }

  return {
    form,
    loading,
    loaded,
    saving,
    message,
    setMessage,
    newForbiddenRule,
    setNewForbiddenRule,
    load,
    updateField,
    addForbiddenRule,
    removeForbiddenRule,
    save,
  };
}
