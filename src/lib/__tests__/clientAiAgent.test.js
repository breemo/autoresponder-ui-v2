import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelIntegrationStatus, sortChannelFeatures } from "../../pages/client/aiAgent/aiAgentUi.js";
import { behaviorToForm, EMPTY_AI_BEHAVIOR_FORM } from "../../pages/client/aiAgent/useAiBehavior.js";
import {
  findActiveSubscription,
  getRemainingDays,
  getUsageLevel,
  getUsagePercent,
  remaining,
} from "../../pages/client/planBilling/billingUi.js";
import { visibleUserMenu, pageTitleKey } from "../clientNav.js";

// AI Agent redesign + Plan & Billing separation (DEV).
// See engineering/reports/claude/2026-10-08-ai-agent-plan-billing.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const member = (client_role, extra = {}) => ({ role: "client", client_role, is_active: true, permissions_overrides: null, ...extra });

test("channel status: active / paused / not set up — never 'connected'", () => {
  const f = { id: "f1", slug: "telegram" };
  assert.equal(channelIntegrationStatus(f, []), "not_set_up");
  assert.equal(channelIntegrationStatus(f, [{ feature_id: "f1", is_active: true }]), "active");
  assert.equal(channelIntegrationStatus(f, [{ feature_id: "f1", is_active: false }]), "paused");
  assert.equal(channelIntegrationStatus(f, [{ feature_id: "f1" }]), "paused");
  assert.doesNotMatch(read("src/pages/client/aiAgent/aiAgentUi.js").replace(/\/\/.*$/gm, ""), /"connected"/);
});

test("channel order follows the approved design", () => {
  const order = sortChannelFeatures([{ slug: "telegram" }, { slug: "email" }, { slug: "website_chat" }, { slug: "whatsapp_evolution" }, { slug: "instagram" }, { slug: "facebook" }]).map((f) => f.slug);
  assert.deepEqual(order, ["whatsapp_evolution", "facebook", "instagram", "telegram", "website_chat", "email"]);
});

test("AI behavior mapping is the drawer's (all 7 fields, same defaults)", () => {
  assert.deepEqual(Object.keys(EMPTY_AI_BEHAVIOR_FORM).sort(), ["booking_instructions", "default_language", "escalation_instructions", "forbidden_rules", "personality", "reply_tone", "special_instructions"]);
  assert.deepEqual(behaviorToForm({ personality: "p", forbidden_rules: "x" }), { ...EMPTY_AI_BEHAVIOR_FORM, personality: "p" });
  assert.deepEqual(behaviorToForm({ forbidden_rules: ["a"] }).forbidden_rules, ["a"]);
});

test("AI behavior requests: same endpoint, same payload spread as before", () => {
  const hook = read("src/pages/client/aiAgent/useAiBehavior.js");
  assert.match(hook, /\/api\/client-router\?resource=ai-behavior&actor_user_id=/);
  assert.match(hook, /fetch\("\/api\/client-router\?resource=ai-behavior", \{\s*method: "POST"/);
  assert.match(hook, /actor_user_id: actorUserId,\s*client_id: clientId,\s*\.\.\.form,/);
  // the Admin drawer still uses the identical request
  assert.match(read("src/pages/admin/AdminClientSettings.jsx"), /actor_user_id: user\?\.id,\s*client_id: effectiveClientId,\s*\.\.\.aiBehaviorForm,/);
});

test("AI Agent page: no drawer, no reply-mode editor, no subscription UI, no Admin import", () => {
  const page = read("src/pages/client/ClientFeatureSettings.jsx");
  const settings = read("src/pages/client/aiAgent/AiSettingsSection.jsx");
  assert.doesNotMatch(page, /from "\.\.\/admin\//);
  assert.doesNotMatch(page + settings, /reply_mode|ReplyMode|replyMode/);
  assert.doesNotMatch(page, /subscriptions|currentSubscriptionTitle|historyTitle/);
  assert.doesNotMatch(page + settings, /fixed inset-0/);
  assert.match(page, /readOnly = plan\?\.allow_self_edit !== true/);
  assert.match(page, /variant="agent"/);
  assert.match(page, /\{canManageIntegrations && \(/);
});

test("Plan & Billing calculations unchanged", () => {
  assert.equal(getUsagePercent(920, 1000), 92);
  assert.equal(getUsagePercent(5, 0), 0);
  assert.equal(getUsagePercent(2000, 1000), 100);
  assert.equal(getUsageLevel(92), "near");
  assert.equal(getUsageLevel(100), "max");
  assert.equal(getUsageLevel(10), "good");
  assert.equal(remaining(1000, 920), 80);
  assert.equal(remaining(undefined, 5), -5);
  const now = new Date("2026-10-08T00:00:00Z");
  assert.equal(getRemainingDays("2026-10-28T00:00:00Z", now), 20);
  assert.equal(getRemainingDays("2026-10-01T00:00:00Z", now), 0);
  assert.equal(getRemainingDays(null, now), 0);
  assert.equal(findActiveSubscription([{ status: "cancelled" }, { id: 1, status: "active" }, { id: 2, status: "active" }]).id, 1);
  assert.equal(findActiveSubscription([]), null);
});

test("Plan & Billing: same query, read-only, route gated like before, in account menu", () => {
  const page = read("src/pages/client/ClientPlanBilling.jsx");
  assert.match(page, /\.from\("subscriptions"\)/);
  assert.match(page, /\.eq\("client_id", clientId\)\s*\.order\("created_at", \{ ascending: false \}\)/);
  assert.doesNotMatch(page, /\.(insert|update|delete)\(/);
  assert.match(read("src/App.jsx"), /path="\/client\/plan-billing"\s*element=\{<ClientRoute permission=\{PERMISSIONS\.AI_SETTINGS\}><ClientPlanBilling \/><\/ClientRoute>\}/);
  assert.ok(visibleUserMenu(member("owner")).some((i) => i.to === "/client/plan-billing"));
  assert.ok(visibleUserMenu(member("it")).some((i) => i.to === "/client/plan-billing"));
  assert.ok(!visibleUserMenu(member("agent")).some((i) => i.to === "/client/plan-billing"));
  assert.ok(!visibleUserMenu(member("owner", { must_change_password: true })).some((i) => i.to === "/client/plan-billing"));
  assert.equal(pageTitleKey("/client/plan-billing"), "shell.nav.planBilling");
});

test("Knowledge Base: Admin uses the default variant; agent variant shares handlers", () => {
  assert.match(read("src/pages/admin/AdminClientSettings.jsx"), /<KnowledgeBaseSection clientId=\{effectiveClientId\} actorUserId=\{user\?\.id\} readOnly=\{!isAdmin && !clientCanEdit\} \/>/);
  const kb = read("src/pages/client/KnowledgeBaseSection.jsx");
  assert.match(kb, /variant = "default"/);
  assert.match(kb, /if \(variant === "agent"\)/);
  assert.match(kb, /onDrop=\{handleDrop\}/);
  assert.match(kb, /accept=\{KNOWLEDGE_ACCEPT_ATTRIBUTE\}/);
});

test("new strings: EN/AR parity, 'AI Agent' terminology", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  for (const ns of ["aiAgent", "planBilling"]) assert.deepEqual(Object.keys(en[ns]).sort(), Object.keys(ar[ns]).sort(), ns);
  assert.equal(en.aiAgent.title, "AI Agent");
  assert.doesNotMatch(JSON.stringify(en.aiAgent) + JSON.stringify(en.planBilling), /assistant/i);
  assert.doesNotMatch(JSON.stringify(ar.aiAgent), /المساعد الذكي/);
});
