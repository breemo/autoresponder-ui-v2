# n8n AI Agent — Architecture & Cutover Spec (central AI-Agent-Core)

> **Status: spec only. Nothing built in n8n yet.**
> The committed snapshots under `docs/n8n/current/` are the **rollback reference** and
> must not be edited. The backend tool layer this depends on
> (`api/ai-tools.js`, `api/_lib/aiTools.js`) and the intent migration
> (`supabase/migrations/20260828_ai_engine_v1_message_intent.sql`) are implemented on
> `develop` (not deployed, not committed).
>
> Node-by-node UI build of the sub-workflow: **`engineering/processes/n8n-ai-agent-core-build.md`**.

---

## 1. Final AI-Agent-Core architecture

**One reusable sub-workflow — `AI-Agent-Core` — is the ONLY place the AI reasoning lives.**
Every AI-enabled channel workflow calls it through an **Execute Workflow** node and
consumes a small structured result. No AI Agent nodes are duplicated per channel.

```
  AutoResponder_WhatsApp_V2                 General-Main-Flow (+ future FB / TG / IG / Web)
  ────────────────────────────             ─────────────────────────────────────────────
  Webhook → normalize → Config                 same deterministic pre-AI chain
  → client_feature → subscription/plan/credits  (normalize, resolve conversation, account,
  → resolve_conversation_v2                      integration active, subscription, plan,
  → prepare_conversation → insert message        credits, HUMAN HARD-STOP, welcome/auto)
  → check_integration_active
  → check_human_stop   ◀── hard stop stays BEFORE the AI branch, unchanged
  → welcome_only? → auto_replies? → check_need_human?
  → If reply_mode = ai → If plan_supports_ai (true)
            │                                           │
            ▼                                           ▼
   ┌────────────────────────  Execute Workflow: AI-Agent-Core  ────────────────────────┐
   │  IN  { conversation_id, current_message, message_id?, current_step?, channel? }   │
   │                                                                                  │
   │   Get AI Context (GET /api/ai-context)  →  Prepare Agent Context                  │
   │        → AI Agent (Tools Agent, gpt-4o-mini)                                       │
   │             ├─ search_business_knowledge   ┐                                       │
   │             ├─ get_business_facts          │  thin HTTP callers of                 │
   │             ├─ request_human_handover      │  POST /api/ai-tools                   │
   │             ├─ save_lead                   │  (all tenant/lifecycle logic          │
   │             ├─ start_order / continue_order│   lives in the backend, not n8n)      │
   │             └─ close_conversation          ┘                                       │
   │        → Resolve Intent → Record Intent (only if no tool already did)              │
   │        → Build Result                                                             │
   │                                                                                  │
   │  OUT { reply, intent, action, quick_reply_action, conversation_status,            │
   │        current_step }                                                             │
   └──────────────────────────────────────────────────────────────────────────────────┘
            │                                           │
            ▼                                           ▼
   normalize_core_result (Code)                normalize_core_result (Code)
   → Set Reply Source - ai → merge_for_state   → Set Reply Source - ai → merge_for_state
   → state_payload → sync_conversation_v2      → state_payload → sync_conversation_v2
   → upsert_conversation_state                 → upsert_conversation_state
   → Evolution send nodes                      → platform switch → channel send
   → insert auto reply → update_usage          → insert auto reply → update_usage
```

**Why central, not per-channel:** one Agent definition, one system prompt, one tool
set, one memory policy, one place to fix a regression. Adding Facebook / Telegram /
Instagram / Web Chat later is a ~4-node parent edit (Execute Workflow +
normalize_core_result + 2 rewires), never another Agent build.

---

## 2. Exact input contract (parent → AI-Agent-Core)

Reviewed down to what is actually needed:

| Field | Required | Purpose | Notes |
|---|---|---|---|
| `conversation_id` | **yes** | the ONLY tenant/identity anchor for the tools | every `/api/ai-tools` call derives client_id, platform, sender, channel identity, current state from this alone |
| `current_message` | **yes** | the customer's message text | passed to `/api/ai-context` and to the Agent as the user turn |
| `client_id` | **yes** | fast-fail cross-check for `/api/ai-context` ONLY | `/api/ai-context` hard-requires it and uses it *only* to 403 if it doesn't match the conversation's own row ("never used to select data past this point" — see `api/_lib/aiContext.js`). The parent already resolved it (`prepare_conversation`). **It is never passed to the Agent, `Prepare Agent Context`, or any tool node** — only to the `Get AI Context` HTTP node. This is exactly how today's `call_ai_context` node already works. |
| `message_id` | optional | exact target for intent recording | backend currently records intent on the *latest inbound* message, which is this one — pass it for future exactness; safe to omit |
| `current_step` | optional | hint to the Agent (“we’re mid-order / mid-contact-capture”) | backend tools re-read state authoritatively; this is a prompt hint only |
| `channel` | optional | observability / logging only | **must not** drive any behaviour in AI-Agent-Core |

**Dropped from the contract:** `account_id`, `tenant`, `platform` as an input,
subscription/plan/credit fields. AI-Agent-Core never resolves client identity — it
*forwards* the parent's already-resolved `client_id` straight to the `/api/ai-context`
guard and nowhere else. `account_id` / channel identity stay entirely in the parent flow.

Parent expression for the Execute Workflow node body (WhatsApp example):
```
{
  "conversation_id": {{ $node["prepare_conversation"].json["conversation_id"] }},
  "client_id":       {{ $node["prepare_conversation"].json["client_id"] }},
  "current_message":  {{ $node["Code in JavaScript1"].json["text"] }},
  "message_id":       {{ $node["insert message"].json["id"] }},
  "current_step":     {{ $node["prepare_conversation"].json["current_step"] }},
  "channel":          "whatsapp"
}
```
(General-Main-Flow: `"channel"` from `$node["Code in JavaScript1"].json["platform"]`.)

---

## 3. Exact output contract (AI-Agent-Core → parent)

```json
{
  "reply": "text to send to the customer",
  "intent": "greeting | knowledge | price | order | booking | asset_request | support | complaint | human_request | lead | closing | unknown",
  "action": null | "human_handover" | "close_confirmed" | "order_in_progress" | "lead_saved",
  "quick_reply_action": null | "closing_confirm",
  "conversation_status": null | "active" | "waiting_human",
  "current_step": null | "waiting_for_contact" | "contact_captured" | "order_in_progress" | "closing_confirm" | "closing_confirmed"
}
```

- `reply` — always present; the customer-facing text (already stripped of any `#intent:` marker).
- `intent` — always present; the resolved taxonomy value.
- `action` — a semantic label for the parent/logging. `null` for pure Q&A turns.
- `quick_reply_action` — `"closing_confirm"` means the parent must attach the نعم / كمل
  buttons. Otherwise `null`.
- `conversation_status` / `current_step` — **the state a tool set in the DB this turn**,
  or `null` if AI-Agent-Core changed nothing. The parent forwards these (§10). `null`
  means “keep whatever `prepare_conversation` already had”.

The parent never needs any other field and never inspects Agent internals.

---

## 4. Exact Agent nodes (summary — full build in core-build.md)

| # | Node | n8n type | Role |
|---|---|---|---|
| 1 | When Executed by Another Workflow | `n8n-nodes-base.executeWorkflowTrigger` | entry; defines the input fields from §2 |
| 2 | Get AI Context | `n8n-nodes-base.httpRequest` | `GET`/`POST` `/api/ai-context` → authoritative system message + customer-only history |
| 3 | Prepare Agent Context | `n8n-nodes-base.code` | build `system_message` (context + agent operating rules + customer-only "conversation so far") and `current_message` |
| 4 | AI Agent | `@n8n/n8n-nodes-langchain.agent` | **Tools Agent**; `Return intermediate steps` = ON |
| 5 | OpenAI Chat Model | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | `gpt-4o-mini`, temperature `0.3` — `ai_languageModel` into node 4 |
| 6 | (no memory node) | — | see §6 |
| 7–13 | 7 × HTTP Request Tool | `@n8n/n8n-nodes-langchain.toolHttpRequest` | `ai_tool` into node 4; each `POST /api/ai-tools` |
| 14 | Resolve Intent | `n8n-nodes-base.code` | strip `#intent:` marker; read `intermediateSteps` for tool-derived intent |
| 15 | Record Intent | `n8n-nodes-base.httpRequest` | `POST /api/ai-tools {action:"record_intent"}` — **only when no state tool already recorded one** |
| 16 | Build Result | `n8n-nodes-base.code` | assemble the §3 output; this is the sub-workflow's returned item |

---

## 5. Exact Tools and wiring

All 7 tools: `@n8n/n8n-nodes-langchain.toolHttpRequest`, `ai_tool` connection into
**AI Agent**, `POST https://jawabai.vercel.app/api/ai-tools`, header
`x-ai-tools-secret: {{$env.AI_TOOLS_SECRET}}`, JSON body `{ "action": "<action>", "conversation_id": "<fixed expr>", ...agent params }`.

`conversation_id` is **always** the fixed expression
`{{ $node["When Executed by Another Workflow"].json["conversation_id"] }}` — never an
Agent-supplied value.

| Tool name (Agent sees) | action | Agent-fills | When the Agent should call it |
|---|---|---|---|
| `search_business_knowledge` | `search_knowledge` | `query` | any question about products, prices, menu, policies, hours, offerings |
| `get_business_facts` | `get_business_facts` | — | any question about branches / locations / address / phone / working hours (returns `locations_guidance` — obey it exactly) |
| `request_human_handover` | `request_handover` | `reason?` | customer wants a person; unresolved complaint; order ready for a human to finalize |
| `save_lead` | `upsert_lead` | `name?`, `phone?` | customer provided contact details |
| `start_order` | `start_order` | `items_summary?` | customer wants to place an order |
| `continue_order` | `continue_order` | `items_summary?`, `customer_note?` | customer adds to an in-progress order |
| `close_conversation` | `close_conversation` | `confirmed` (default `false`) | customer signals they are done — call with `confirmed:false`; the system asks them to confirm |

Full per-node parameters, descriptions, and `$fromAI` / placeholder wording are in
**core-build.md §Tools**.

---

## 6. Exact memory strategy

**No memory node.** n8n's Window Buffer / Simple Memory replays *both* sides of the
conversation, which is exactly the failure that caused the "our only branch is Nablus"
regression (`76218c9`).

Instead:
1. `Get AI Context` (`/api/ai-context`) already returns `messages` filtered to
   **customer turns only** (server-side, since commit `76218c9`).
2. `Prepare Agent Context` folds those into the system message as a plain
   **"Conversation so far (customer messages only):"** block. No assistant answers.
3. Session identity is `conversation_id` (implicit — each execution is one turn for one
   conversation; nothing persists between turns inside n8n).
4. Facts (prices, branches, hours, policies, availability) are **never** taken from that
   block — the system prompt forbids it and the Agent must call `get_business_facts` /
   `search_business_knowledge` every turn. Current authoritative data always wins.

If a future n8n version offers a memory node that can be restricted to `human` messages
only, it may replace the folded block — but a raw buffer memory must never be added.

---

## 7. Exact parent-flow change — AutoResponder_WhatsApp_V2

Only 2 new nodes, 3 rewires. **Nothing else in the workflow changes.**

**Add:**

- **`Execute AI-Agent-Core`** — `n8n-nodes-base.executeWorkflow`
  - Source: *Database* → select the `AI-Agent-Core` workflow (or *From list*).
  - Mode: *Run once with all items*.
  - Wait for sub-workflow completion: **ON** (default).
  - Options → *Workflow Inputs* / body: the §2 JSON.
- **`normalize_core_result`** — `n8n-nodes-base.code` (see §10 for the body).

**Rewire (in the n8n editor — drag connections):**

| From (output) | Old target | New target |
|---|---|---|
| `If plan_supports_ai` — **true** branch (index 0) | `call_ai_context` | **`Execute AI-Agent-Core`** |
| `Execute AI-Agent-Core` | — | **`normalize_core_result`** |
| `normalize_core_result` | — | **`Set Reply Source - ai`** |

**Leave connected, unchanged:** `If plan_supports_ai` — **false** branch → `default normalize`.
`Set Reply Source - ai` → `merge_for_state` → `state_payload` → `sync_conversation_v2`
→ `needs_legacy_reset` → `upsert_conversation_state` → `Get WhatsApp Number Send`
→ `Get WhatsApp Server Send` → `send auto reply Evolution` → `insert auto reply`
→ `update_usage`. And everything before `If reply_mode = ai`.

**Disconnect (do NOT delete — see §9):** `call_ai_context`, `openai_reply`,
`extract_ai_reply`, `normalize_reply`, `If lead`, `insert_lead`,
`restore_reply_after_lead`. These form a now-orphaned chain that stays in the canvas for
rollback.

> `If lead` / `insert_lead` are bypassed because `save_lead` (the tool) already writes the
> lead. The `waiting_for_contact` name/phone parsing that `normalize_reply` did is now the
> Agent's job (it gets `current_step` as a hint and calls `save_lead`).

---

## 8. Exact parent-flow change — General-Main-Flow

**Identical to §7.** Same 2 nodes, same 3 rewires, same splice point
(`If plan_supports_ai` true → `Execute AI-Agent-Core` → `normalize_core_result` →
`Set Reply Source - ai`). The only differences are downstream of `merge_for_state` and
already exist today (the `platform` switch → Telegram / WhatsApp / Facebook send). Do not
touch them.

Also here: `message_decision` is already an orphan node (no connections) — you may delete
it now or leave it; it is unrelated to this change.

`channel` in the input body comes from `{{ $node["Code in JavaScript1"].json["platform"] }}`.

---

## 9. Old nodes to disable after pilot

After the pilot (§13.G) passes, **deactivate** (right-click → Deactivate) — do **not**
delete — in each parent workflow:

| Node | Why it's now dead on the AI path |
|---|---|
| `call_ai_context` | AI-Agent-Core calls `/api/ai-context` itself |
| `openai_reply` | replaced by the AI Agent + OpenAI Chat Model sub-nodes |
| `extract_ai_reply` | Agent output is structured; `Resolve Intent` + `Build Result` replace it |
| `normalize_reply` | the intent×step switch, thank-you/keyword detection, and `aiReplyAsksForContact` guard all move to tools + the Agent |
| `If lead` | `save_lead` tool already writes the lead |
| `insert_lead` | same |
| `restore_reply_after_lead` | same |
| `check_need_human` | **keep active** — cheap keyword pre-filter that can route an obvious handshake to `human_reply` without an AI call; the Agent also covers handover via `request_handover`. Remove only in a later, separate cleanup. |
| `message_decision` (General-Main-Flow) | already orphaned |

**Rollback:** reconnect `If plan_supports_ai` (true) → `call_ai_context`, reactivate
`openai_reply` / `extract_ai_reply` / `normalize_reply` / `If lead` / `insert_lead` /
`restore_reply_after_lead`, reconnect `normalize_reply` → `If lead` and both `If lead`
outputs, then deactivate `Execute AI-Agent-Core` + `normalize_core_result`. The
`docs/n8n/current/*.json` snapshots remain the clean pre-change reference.

---

## 10. State rollback protection (critical)

### The risk, traced through the real nodes

After AI-Agent-Core returns, the item flows:
`normalize_core_result → Set Reply Source - ai → merge_for_state → state_payload → sync_conversation_v2 (+ upsert_conversation_state)`.

- **`merge_for_state`** builds `conversation_status: norm.conversation_status || "active"`,
  `current_step: norm.current_step || null` — where `norm` is the item from
  `Set Reply Source - ai` (i.e. from `normalize_core_result`).
- **`state_payload`** builds `status = $json.conversation_status ?? "active"`,
  `step = $json.current_step ?? null`.
- **`sync_conversation_v2`** PATCHes `public.conversations` with
  `conversation_status = (state.conversation_status === "waiting_human" ? "waiting_human"
  : state.conversation_status === "closed" ? "closed" : "active")` and
  `current_step = state.current_step || null`.
- **`upsert_conversation_state`** POSTs `public.conversation_state` with the same.

⇒ **If `normalize_core_result` does not carry the status/step forward, these nodes write
`active` / `null` and silently undo a handover, a closing_confirm, contact_captured, or
order_in_progress that a tool just committed to the DB.**

### The fix — `normalize_core_result` (Code node) body

```js
// item in: the AI-Agent-Core result (from Execute AI-Agent-Core, first item)
const core = $json;
const prep = $items("prepare_conversation", 0, 0)[0].json;
const base = $items("Code in JavaScript1", 0, 0)[0].json;
const integration = $items("client_feature", 0, 0)[0].json;

// State: a value the Agent's tools set THIS turn wins; otherwise KEEP the
// conversation's existing state (prepare_conversation), NEVER a hardcoded default.
const conversation_status = core.conversation_status || prep.conversation_status || "active";
const current_step = (core.current_step !== undefined && core.current_step !== null)
  ? core.current_step
  : (prep.current_step ?? null);

// Quick replies: the Agent asked to close -> render the same buttons the old
// closing_confirm path used. Deterministic, stays in the parent.
let quick_replies = null;
if (core.quick_reply_action === "closing_confirm") {
  quick_replies = [
    { content_type: "text", title: "نعم", payload: "CLOSE_CONVERSATION" },
    { content_type: "text", title: "كمل المحادثة", payload: "CONTINUE_CONVERSATION" },
  ];
}

const reply = (core.reply && String(core.reply).trim())
  ? core.reply
  : (integration.clients?.default_reply || integration.default_reply || "شكراً لتواصلك معنا 🙏 سيتم الرد عليك بأقرب وقت ممكن");

return [{
  json: {
    platform: base.platform,
    channelKey: base.channelKey,
    text: base.text,
    sender_id: base.sender_id,
    client_id: integration.client_id,
    config: integration.config || {},
    conversation_id: prep.conversation_id,

    reply,
    intent: core.intent || "unknown",
    action: core.action || null,

    conversation_status,
    current_step,
    next_step: current_step,      // merge_for_state / older nodes read either
    quick_replies,

    reply_source: "ai",
    lead_name: null,              // lead already handled by the save_lead tool -> keep If-lead path bypassed
    lead_phone: null,
  }
}];
```

### Protected transitions

| Set by tool (in DB) | Carried by `normalize_core_result` | Result |
|---|---|---|
| `request_handover` → `conversations.conversation_status='waiting_human'` | `core.conversation_status='waiting_human'` → forwarded | `sync_conversation_v2` re-writes the **same** `waiting_human` (idempotent). Next inbound hits `check_human_stop`. |
| `close_conversation(confirmed:true)` → `waiting_human` + `closing_confirmed` | forwarded | idempotent re-write |
| `close_conversation(confirmed:false)` → `current_step='closing_confirm'` | `core.current_step='closing_confirm'` + `quick_reply_action` | step preserved, buttons rendered |
| `save_lead` (both fields) → `current_step='contact_captured'` | forwarded | preserved |
| `start_order` → `current_step='order_in_progress'` | forwarded | preserved |
| pure Q&A (no tool state change) | `core.conversation_status=null` → falls back to `prep.conversation_status` | existing state preserved, never reset to `active` |

Because the tools ALSO wrote `conversations` + `conversation_state` directly, the
downstream `sync_conversation_v2` / `upsert_conversation_state` are writing the same
values a second time — **idempotent, not a conflict.** The only thing that must not
happen is the parent computing a *stale* value, which the code above prevents.

---

## 11. Required env / credentials

| Where | Name | Value |
|---|---|---|
| Vercel (deployment behind `jawabai.vercel.app`) | `AI_TOOLS_SECRET` | fresh random secret (new) |
| Vercel | `AI_CONTEXT_SECRET` | already set (unchanged) |
| n8n (Railway) | `AI_TOOLS_SECRET` env var | **same value** as Vercel's |
| n8n | `AI_CONTEXT_SECRET` env var | already used by `call_ai_context` today — reuse for AI-Agent-Core's `Get AI Context` node |
| n8n | OpenAI credential | existing OpenAI API key credential (the one `openai_reply` uses today) — attach to the **OpenAI Chat Model** sub-node |

No Supabase credential is added to AI-Agent-Core — it never touches Supabase directly.

---

## 12. Required Supabase migration

`supabase/migrations/20260828_ai_engine_v1_message_intent.sql` — adds
`messages.intent`, `messages.intent_confidence`, `messages.intent_metadata` + CHECK
constraints. **Apply manually in the Supabase SQL editor before the pilot.** Not
executed by this repo.

---

## 13. Exact live build sequence — tonight

**A. Backend / migration prerequisites**
1. Apply `20260828_ai_engine_v1_message_intent.sql` in Supabase. Verify the 3 columns + 2 CHECK constraints.
2. Set `AI_TOOLS_SECRET` in Vercel; deploy `api/ai-tools.js` + `api/_lib/aiTools.js` (same promotion path as prior AI Engine deploys).
3. Smoke-test the endpoint from a shell:
   `curl -sS -X POST https://jawabai.vercel.app/api/ai-tools -H "x-ai-tools-secret: $AI_TOOLS_SECRET" -H 'content-type: application/json' -d '{"action":"get_business_facts","conversation_id":"<a real conv id>"}'`
   → expect `{"ok":true,"business":{...},"locations":[...],"locations_guidance":"..."}`.

**B. Build `AI-Agent-Core`** (new workflow) — follow `n8n-ai-agent-core-build.md` node by node.
   - Set `AI_TOOLS_SECRET` + `AI_CONTEXT_SECRET` as n8n env vars.
   - Attach the existing OpenAI credential to the Chat Model node.
   - Save. Do **not** activate it (sub-workflows called via Execute Workflow don't need to be active, but activating is harmless).

**C. Test `AI-Agent-Core` independently**
   - Use the workflow's **manual "Test workflow"** with pinned input:
     `{ "conversation_id": "<real active conv>", "current_message": "مرحبا" }`
   - Then `"كم سعر الوجبة؟"`, `"عندكم فرع برام الله؟"`, `"بدي أطلب"`, `"بدي أحكي مع موظف"`, `"شكراً"`.
   - Verify each returns the §3 shape and that the intended tool fired (check the Agent
     node's execution data + `messages.intent` in Supabase + `conversations.conversation_status`).

**D. Clone ONE parent workflow** — duplicate `General-Main-Flow` as
   `General-Main-Flow (AI-Agent pilot)`. Leave the original untouched and active.

**E. Connect clone → AI-Agent-Core** — apply §8 (2 nodes, 3 rewires, disconnect the old
   AI chain) in the clone only.

**F. Test with one test client / account** — point one test WhatsApp/Telegram/FB test
   account's inbound at the pilot clone (or flip that client's `reply_mode` and route).
   Keep it to a client you control.

**G. Validate** — run the §14 checklist end to end.

**H. Replicate** — once G passes, apply the same tiny §7 change to
   `AutoResponder_WhatsApp_V2` and the real `General-Main-Flow`, pointing both at the
   same `AI-Agent-Core`. Deactivate the old AI nodes (§9). Export all changed workflows
   and update `docs/n8n/current/*.json` in a dedicated commit.

---

## 14. Exact pilot test checklist

Send as a customer on the pilot account. Check: reply text, `messages.intent`,
`conversations.conversation_status` / `current_step`, and which tool fired.

| # | Message | Expect intent | Expect behaviour |
|---|---|---|---|
| 1 | `مرحبا` | `greeting` | friendly greeting, **no tool call** |
| 2 | `كم سعر الوجبة العائلية؟` | `price` | `search_business_knowledge`; price only if found, else "let me check with the team" |
| 3 | `عندكم توصيل؟` | `knowledge` | `search_business_knowledge` |
| 4 | `عندكم فرع برام الله؟` (client `locations_list_complete=false`) | `knowledge` | `get_business_facts`; answers **UNKNOWN**, offers to check — never "only Nablus" |
| 5 | same, `locations_list_complete=true`, only Nablus configured | `knowledge` | `get_business_facts`; may answer "no branch in Ramallah" |
| 6 | `بدي أطلب` / `طلب وجبة` / `حابب أطلب أكل` / `I want to order` | `order` | `start_order`; `current_step='order_in_progress'`; asks what they'd like |
| 7 | `بدي أحكي مع موظف` / `بدي أحكي مع حدا` | `human_request` | `request_human_handover`; `conversation_status='waiting_human'`; tells customer a teammate will follow up |
| 8 | `عندي شكوى` | `complaint` | tries to help; `request_human_handover` if unresolved |
| 9 | `عندي مشكلة ومحتاج مساعدة` | `support` or `complaint` | helps or hands over |
| 10 | `بدي أحجز بكرة` | `booking` | recognized; replies per current capability; **no fake booking** |
| 11 | `ابعتلي المنيو` | `asset_request` | recognized; does **not** claim a file was sent; offers info / handover |
| 12 | `شكراً` / `خلص شكراً` | `closing` | `close_conversation(confirmed:false)`; `current_step='closing_confirm'`; نعم / كمل buttons rendered |
| 13 | tap **نعم** button | — | deterministic parent path (quick-reply payload, never the Agent) → `closing_confirmed` + `waiting_human` |
| 14 | `قديش سعرها؟` right after asking about a named product | `price` | resolves "her/its" against the prior **customer** turn |
| 15 | mixed AR/EN question | topic-appropriate | handled naturally |

**State / safety checks:**
- After #7, send another message → it must hit `check_human_stop` and **not** reach AI-Agent-Core.
- After #4 answer, toggle the client's completeness / change a price in the portal, ask again → answer reflects the change immediately.
- AUTO reply match (a configured `auto_replies` trigger) → never reaches AI-Agent-Core.
- WELCOME_ONLY mode client → never reaches AI-Agent-Core.
- Confirm no tool call ever includes a `client_id`, WhatsApp number, page id, or recipient.
- Confirm the outbound is sent from the same account as today (parent send nodes unchanged).

---

## 15. Anything uncertain because live n8n is unavailable

Repository evidence (`docs/n8n/current/*.json`): base nodes are
`httpRequest@4.2/4.4`, `if@2.3`, `set@3.4`, `code@2`, `switch@3.4`, `webhook@2.1`,
`respondToWebhook@1.5` — a modern n8n (≈1.4x–1.7x). **There are zero
`@n8n/n8n-nodes-langchain.*` nodes anywhere** — the AI Agent stack has never been used
here, so its exact `typeVersion`s and wiring **cannot be derived from the repo.**

Therefore, decide in the UI (do not hand-write JSON):

| Thing | What to pick in the UI |
|---|---|
| Agent node | Add node → **AI Agent**. Agent type: **Tools Agent** (not the deprecated "Conversational Agent"). |
| Model wiring | The AI Agent node shows a **Chat Model** connector — add **OpenAI Chat Model** there. |
| Memory | Leave the **Memory** connector **empty** (§6). |
| Tools | Add **HTTP Request Tool** on the Agent's **Tool** connector, one per §5 tool. |
| Tool parameters | If the HTTP Request Tool shows a **"Let the model set this"** toggle / `$fromAI(...)` — use it for `query`, `name`, `phone`, `reason`, `items_summary`, `customer_note`, `confirmed`. If it shows **"Placeholder Definitions"** instead (older) — define each param there. Either way `conversation_id` stays a **fixed expression**, never model-set. |
| Return intermediate steps | AI Agent node → **Options → Return intermediate steps = ON** (needed by `Resolve Intent`). If your version lacks it, use the `#intent:` marker fallback in core-build.md and always call `Record Intent` (accepting that a tool-turn intent may be re-set to the Agent's classification — still valid). |
| Execute Workflow node | `executeWorkflow` — pick the newest version offered; **"Wait for sub-workflow to finish" = ON**; pass inputs as JSON (§2). |
| Sub-workflow trigger | **"When Executed by Another Workflow"**; input source **"Define using fields below"** with the §2 field names, or **"Accept all data"** and read `$json`. |
| OpenAI credential | reuse the existing credential that `openai_reply` uses. |

No fake JSON has been produced. A standalone `AI-Agent-Core.json` is **not** provided
because the langchain node versions/shapes for this specific n8n instance are unknown and
guessing them would create a non-importable file.

---

## 16. Files changed

| File | Change |
|---|---|
| `engineering/processes/n8n-ai-agent-build-spec.md` | **rewritten** — central AI-Agent-Core architecture, contracts, parent changes, state-rollback protection, cutover, pilot |
| `engineering/processes/n8n-ai-agent-core-build.md` | **new** — node-by-node UI build of the AI-Agent-Core sub-workflow |

No code, SQL, workflow snapshot, or backend file touched by this task.

---

## 17. git status

Branch `develop` @ `7919b02` (unchanged, nothing committed).

New/modified by this task: the two docs above.
Untracked from the prior (accepted) backend task, still present: `api/ai-tools.js`,
`api/_lib/aiTools.js`, `api/_lib/__tests__/aiTools.test.js`,
`supabase/migrations/20260828_ai_engine_v1_message_intent.sql`.
Everything else untracked/modified is the pre-existing, unrelated Facebook multi-account
workstream (present since session start).
