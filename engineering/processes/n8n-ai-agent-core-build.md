# AI-Agent-Core — n8n UI Build (node by node)

> Companion to `n8n-ai-agent-build-spec.md`. Build this as **one new workflow named
> `AI-Agent-Core`** in the n8n editor. It is called by the channel workflows via an
> Execute Workflow node and returns the structured result contract.
>
> **Do not hand-write JSON** — the `@n8n/n8n-nodes-langchain.*` node versions for this
> instance are unknown (no langchain nodes exist in the repo snapshots). Pick nodes from
> the UI palette; this doc gives you every parameter to set.

Env vars this workflow needs (n8n → Settings → Variables, or environment):
`AI_TOOLS_SECRET`, `AI_CONTEXT_SECRET`. Credential: the existing **OpenAI** API key
credential (the one `openai_reply` uses today).

Linear data path:
`Trigger → Get AI Context → Prepare Agent Context → AI Agent → Resolve Intent → Record Intent (conditional) → Build Result`
The **AI Agent** node additionally has side-connections: one **Chat Model** and seven
**Tools**.

---

## Node 1 — `When Executed by Another Workflow`

| | |
|---|---|
| **Type** | `n8n-nodes-base.executeWorkflowTrigger` (palette: "When Executed by Another Workflow") |
| **Purpose** | Entry point. Declares the input contract. |
| **Parameters** | *Input source*: **"Define using fields below"**. Add fields (all *String*): `conversation_id`, `client_id`, `current_message`, `message_id`, `current_step`, `channel`. If your version only offers "Accept all data", that's fine — downstream reads `$json.<field>`. |
| **Note on `client_id`** | Parent-supplied, already resolved by `prepare_conversation`. Used by **exactly one** downstream node — `Get AI Context` — as the `/api/ai-context` fast-fail cross-check. It is **never** referenced by `Prepare Agent Context`, the Agent, or any tool. Do not fold it into the system message. |
| **Credentials/env** | none |
| **Incoming** | (from the calling workflow's Execute Workflow node) |
| **Outgoing** | → Node 2 `Get AI Context` |

---

## Node 2 — `Get AI Context`

| | |
|---|---|
| **Type** | `n8n-nodes-base.httpRequest` (v4.2+, same as the current `call_ai_context`) |
| **Purpose** | Fetch the authoritative system message + customer-only conversation history from the backend. |
| **Method / URL** | `POST` · `https://jawabai.vercel.app/api/ai-context` |
| **Auth** | *Generic Credential Type* → *Header Auth*, or add header manually: **`x-ai-context-secret`** = `{{ $env.AI_CONTEXT_SECRET }}` |
| **Send Body** | ON, *JSON*: |
| **JSON body** | `{{ { "conversation_id": $json.conversation_id, "client_id": $json.client_id, "current_message_text": $json.current_message } }}` |
| **Options** | *Response → Never Error* = ON (so a 4xx still flows; `Prepare Agent Context` degrades). Timeout ~15000 ms. |
| **Credentials/env** | `AI_CONTEXT_SECRET` |
| **Incoming** | ← Node 1 |
| **Outgoing** | → Node 3 `Prepare Agent Context` |

> `client_id` is **required** by `/api/ai-context` and is used there **only** as a
> fast-fail 403 cross-check against the conversation's own row — it is never used to
> select data (`api/_lib/aiContext.js`: *"never used to select data past this point"*).
> This node is the only place `client_id` is referenced. The response gives us `messages`
> (system + **customer turns only**, already assistant-filtered server-side) and a
> `context` object.

---

## Node 3 — `Prepare Agent Context`

| | |
|---|---|
| **Type** | `n8n-nodes-base.code` (v2) |
| **Purpose** | Build the Agent's `system_message` (authoritative context + operating rules + customer-only history) and pass through `current_message` + `conversation_id`. |
| **Mode** | *Run Once for All Items* |
| **Incoming** | ← Node 2 |
| **Outgoing** | → Node 4 `AI Agent` |

**Code:**

```js
const trigger = $items("When Executed by Another Workflow", 0, 0)[0].json;
const ctx = $json || {};

// messages[0] is the promptBuilder system message (business profile + LOCATIONS +
// business voice + grounding rules + output-format). messages[1..] are CUSTOMER turns
// only (assistant answers are filtered server-side — do not re-add them).
const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
const baseSystem = messages[0]?.content || "You are the customer support assistant for this business. Be helpful, accurate, and speak as the business.";
const customerTurns = messages.slice(1).filter(m => m && m.role === "user").map(m => m.content);

const currentMessage = trigger.current_message || "";
const currentStep = trigger.current_step || null;

const operatingRules = [
  "",
  "## How you operate",
  "- You have tools. Use get_business_facts for ANY question about branches, locations, address, phone, or working hours. Use search_business_knowledge for ANY question about products, menu, prices, services, policies, offers, or how things work.",
  "- NEVER state a price, product, location, opening time, policy, or availability from memory or from earlier in this chat. Get it from a tool THIS turn. If the tools don't have it, say you'll check with the team — never guess, and never say 'we don't have X' when you simply don't know.",
  "- get_business_facts returns locations_guidance. Obey it exactly. If the location list is not confirmed complete, an unlisted location is UNKNOWN — never say 'our only branch is X'.",
  "- Customer wants a human, or an unresolved complaint -> request_human_handover. Customer gives a name/phone -> save_lead. Customer wants to order -> start_order, then gather items and contact info, then save_lead + request_human_handover so a teammate finalizes it. Customer is done -> close_conversation (confirmed=false; the system will ask them to confirm).",
  "- Booking requests and requests to be sent a file/menu image: answer helpfully with what you have and offer to connect them with the team. Do not invent a booking. Do not claim a file was sent.",
  "- Reply in the customer's language (Arabic / Palestinian-Levantine colloquial / English / mixed). Speak AS the business ('we', 'our'). Never mention tools, steps, or that you are an AI.",
  "- Ask at most ONE short clarifying question, and only when genuinely ambiguous.",
  "- End every reply with a new line exactly: #intent: <one of greeting|knowledge|price|order|booking|asset_request|support|complaint|human_request|lead|closing|unknown>",
];

const historyBlock = customerTurns.length
  ? ["", "## Conversation so far (the customer's previous messages only)", ...customerTurns.map(t => "- " + t)]
  : [];

const stepHint = currentStep
  ? ["", `## Current step: ${currentStep}` + (currentStep === "waiting_for_contact" ? " — the customer was asked for their name and phone; if this message contains them, call save_lead." : "")]
  : [];

return [{
  json: {
    conversation_id: trigger.conversation_id,
    message_id: trigger.message_id || null,
    channel: trigger.channel || null,
    current_message: currentMessage,
    system_message: [baseSystem, ...operatingRules, ...historyBlock, ...stepHint].join("\n"),
  }
}];
```

---

## Node 4 — `AI Agent`

| | |
|---|---|
| **Type** | `@n8n/n8n-nodes-langchain.agent` — **Agent type: "Tools Agent"** |
| **Purpose** | Understand → choose a tool (or not) → respond. |
| **Parameters** | *Prompt (User Message) source*: **"Define below"**. *Text*: `{{ $json.current_message }}`. *System Message* (Options → System Message): `{{ $json.system_message }}`. |
| **Options** | *Max iterations*: **5**. *Return intermediate steps*: **ON** (Resolve Intent needs it — if unavailable, see the fallback in Node 13). |
| **Chat Model connection** | ← Node 5 `OpenAI Chat Model` (the `Chat Model` connector) |
| **Memory connection** | **leave empty** (history is folded into `system_message`; a buffer memory would replay assistant answers) |
| **Tool connections** | ← Nodes 6–12 (seven HTTP Request Tools, on the `Tool` connector) |
| **Incoming (main)** | ← Node 3 |
| **Outgoing (main)** | → Node 13 `Resolve Intent` |

---

## Node 5 — `OpenAI Chat Model`

| | |
|---|---|
| **Type** | `@n8n/n8n-nodes-langchain.lmChatOpenAi` |
| **Purpose** | The LLM behind the Agent. |
| **Parameters** | *Model*: `gpt-4o-mini`. *Options → Temperature*: `0.3`. (Leave response format default — the Agent framework handles tool-calling; do not force JSON mode.) |
| **Credentials** | the existing **OpenAI API** credential |
| **Connection** | → Node 4 `AI Agent` via the **`ai_languageModel`** connector (drag from this node's output dot to the Agent's "Chat Model" input) |

---

## Nodes 6–12 — Tools (HTTP Request Tool ×7)

All seven: **Type** `@n8n/n8n-nodes-langchain.toolHttpRequest`, connected to **Node 4
`AI Agent`** via the **`ai_tool`** connector. Common config:

- **Method**: `POST`
- **URL**: `https://jawabai.vercel.app/api/ai-tools`
- **Authentication**: *Generic* → *Header Auth* OR manual header
  **`x-ai-tools-secret`** = `{{ $env.AI_TOOLS_SECRET }}`
- **Send Body**: ON, **JSON**
- **`conversation_id` is ALWAYS a fixed expression**, never model-set:
  `{{ $node["When Executed by Another Workflow"].json["conversation_id"] }}`
- For model-filled params: if the node offers **"Let the model set this value"** /
  `$fromAI('paramName', 'description')`, use it. If it offers **Placeholder
  Definitions**, define each there. Descriptions below are what the model sees.

| # | Tool **Name** (shown to the model) | **Description** (shown to the model) | JSON body |
|---|---|---|---|
| 6 | `search_business_knowledge` | "Search the business knowledge base (menu, price lists, brochures, services, FAQ, policies) for information needed to answer the customer. Call this for any question about what the business offers, prices, how something works, or policies. Returns short text excerpts." | `{ "action":"search_knowledge", "conversation_id":"<fixed>", "query": <model: the customer's question, rephrased as a search query> }` |
| 7 | `get_business_facts` | "Get the authoritative current business profile and the list of physical branches/locations, with explicit guidance (locations_guidance) on whether that list is complete. Call this before answering anything about branches, locations, address, phone number, or working hours." | `{ "action":"get_business_facts", "conversation_id":"<fixed>" }` |
| 8 | `request_human_handover` | "Hand this conversation to the human team. Use when the customer explicitly asks for a person, is upset or has a complaint you cannot resolve, or an order is ready for a human to finalize. After calling, tell the customer a teammate will follow up soon (no specific time)." | `{ "action":"request_handover", "conversation_id":"<fixed>", "reason": <model: short reason, optional> }` |
| 9 | `save_lead` | "Save the customer's contact details when they provide them. Pass whatever you have. Returns whether name and phone are now both on file or which is still missing." | `{ "action":"upsert_lead", "conversation_id":"<fixed>", "name": <model: customer name, optional>, "phone": <model: customer phone, optional> }` |
| 10 | `start_order` | "Begin taking an order when the customer wants to order. Then collect items, quantities, and any delivery detail conversationally. Order capture is conversational only — a teammate finalizes it, so also call save_lead and then request_human_handover once you have the items and the customer's contact info." | `{ "action":"start_order", "conversation_id":"<fixed>", "items_summary": <model: what they want so far, optional> }` |
| 11 | `continue_order` | "Add more items or details to an order that is already in progress." | `{ "action":"continue_order", "conversation_id":"<fixed>", "items_summary": <model: updated items, optional>, "customer_note": <model: note, optional> }` |
| 12 | `close_conversation` | "Use when the customer signals they are finished (e.g. 'thanks, that's all'). Call with confirmed set to false — the system will show the customer a confirm/continue choice. Do not end the conversation yourself." | `{ "action":"close_conversation", "conversation_id":"<fixed>", "confirmed": false }` |

> Every tool response is small JSON with `ok`, an `action`, and a `note`. Tell the model
> (via the system prompt, already included) to use the `note` as private guidance, never
> read it verbatim to the customer.

---

## Node 13 — `Resolve Intent`

| | |
|---|---|
| **Type** | `n8n-nodes-base.code` (v2) |
| **Purpose** | Split the Agent's reply from the `#intent:` marker; determine whether a state tool already recorded intent (so we don't double-record). |
| **Mode** | *Run Once for All Items* |
| **Incoming** | ← Node 4 `AI Agent` |
| **Outgoing** | → Node 14 `Record Intent` |

**Code:**

```js
const agent = $json;
const raw = agent.output ?? agent.text ?? "";

// 1) pull the trailing "#intent: X" marker off the visible reply
const m = String(raw).match(/#intent:\s*([a-z_]+)\s*$/i);
let intent = m ? m[1].toLowerCase() : "unknown";
const reply = (m ? String(raw).slice(0, m.index) : String(raw)).trim();

const TAXONOMY = ["greeting","knowledge","price","order","booking","asset_request","support","complaint","human_request","lead","closing","unknown"];
if (!TAXONOMY.includes(intent)) intent = "unknown";

// 2) inspect tool calls (needs "Return intermediate steps" ON). If a STATE tool ran,
//    its backend already recorded a deterministic intent — prefer it, and skip Node 14.
const steps = Array.isArray(agent.intermediateSteps) ? agent.intermediateSteps : [];
const toolsUsed = steps.map(s => (s.action && s.action.tool) || s.tool).filter(Boolean);

let action = null;
let deterministicIntent = null;
if (toolsUsed.includes("request_human_handover")) { action = "human_handover"; deterministicIntent = "human_request"; }
else if (toolsUsed.includes("close_conversation")) { action = "close_needs_confirmation"; deterministicIntent = "closing"; }
else if (toolsUsed.includes("save_lead"))          { action = "lead_saved"; deterministicIntent = "lead"; }
else if (toolsUsed.includes("start_order") || toolsUsed.includes("continue_order")) { action = "order_in_progress"; deterministicIntent = "order"; }

const finalIntent = deterministicIntent || intent;
const alreadyRecorded = !!deterministicIntent;   // backend tool already wrote messages.intent

// 3) surface any state / quick-reply info the tools returned, for Build Result.
//    Tool observations live in steps[].observation (string JSON) in most n8n versions.
let conversation_status = null, current_step = null, quick_reply_action = null;
for (const s of steps) {
  let obs = s.observation;
  if (typeof obs === "string") { try { obs = JSON.parse(obs); } catch { obs = null; } }
  if (obs && typeof obs === "object") {
    if (obs.conversation_status) conversation_status = obs.conversation_status;
    if (obs.current_step) current_step = obs.current_step;
    if (obs.quick_reply_action) quick_reply_action = obs.quick_reply_action;
  }
}

return [{
  json: {
    conversation_id: $node["When Executed by Another Workflow"].json["conversation_id"],
    reply,
    intent: finalIntent,
    already_recorded: alreadyRecorded,
    action,
    conversation_status,
    current_step,
    quick_reply_action,
  }
}];
```

> **Fallback if "Return intermediate steps" is NOT available in this n8n version:**
> `steps` will be empty → `action`/`conversation_status`/`current_step`/`quick_reply_action`
> stay null and `already_recorded` is false. In that case: (a) always run Node 14, and
> (b) in `normalize_core_result` (parent) rely on the DB values the tools wrote — you can
> add a tiny `GET`/re-read of `conversations` there, OR accept that the parent forwards
> `prep` state and the tool's own `conversations` write is authoritative anyway (the
> deterministic tail re-writing `active` is the risk — so in this fallback, have
> `normalize_core_result` map `core.action`/`core.intent` to status: `human_request` →
> `waiting_human`, `closing` → keep `closing_confirm`). Prefer enabling the option.

---

## Node 14 — `Record Intent` (conditional)

| | |
|---|---|
| **Type** | `n8n-nodes-base.if` (v2.3) → then `n8n-nodes-base.httpRequest` |
| **Purpose** | Store the classification for non-tool turns. Tool turns already recorded intent server-side. |

**14a — `If intent not already recorded`** (`n8n-nodes-base.if`)
- Condition (Boolean, is true): `{{ $json.already_recorded === false }}`
- **true** → Node 14b. **false** → Node 15 (skip recording).

**14b — `POST record_intent`** (`n8n-nodes-base.httpRequest`)
- `POST https://jawabai.vercel.app/api/ai-tools`
- Header `x-ai-tools-secret` = `{{ $env.AI_TOOLS_SECRET }}`
- Body JSON:
  `{{ { "action":"record_intent", "conversation_id": $json.conversation_id, "intent": $json.intent, "confidence": 0.7, "metadata": { "source":"agent_classification" } } }}`
- **Options → Never Error = ON.** Never branch on the response — a failure must not stop the flow.
- Outgoing → Node 15.

*(If your n8n makes a diamond merge awkward: instead of the IF, always call 14b but pass
`"skip_if_set": true` — NOT supported by the current backend, so use the IF. Or simply
always call record_intent and accept that a tool turn's already-correct intent gets
re-written to the same/close value. Low harm; refine later.)*

**Incoming** ← Node 13. **Outgoing** → Node 15.

---

## Node 15 — `Build Result`

| | |
|---|---|
| **Type** | `n8n-nodes-base.code` (v2) |
| **Purpose** | Emit the output contract. This node's output is what the sub-workflow returns to the caller. |
| **Mode** | *Run Once for All Items* |
| **Incoming** | ← Node 14 (both IF branches merge here) |
| **Outgoing** | (none — last node; its JSON is the sub-workflow return value) |

**Code:**

```js
const r = $items("Resolve Intent", 0, 0)[0].json;

return [{
  json: {
    reply: r.reply || "",
    intent: r.intent || "unknown",
    action: r.action || null,
    quick_reply_action: r.quick_reply_action || null,
    conversation_status: r.conversation_status || null,   // null => parent keeps existing state
    current_step: r.current_step || null,
  }
}];
```

---

## Connection summary

```
When Executed by Another Workflow ──main──▶ Get AI Context ──main──▶ Prepare Agent Context ──main──▶ AI Agent
                                                                                                      │
  OpenAI Chat Model ──ai_languageModel──▶ AI Agent                                                     │
  search_business_knowledge ─┐                                                                         │
  get_business_facts         │                                                                         │
  request_human_handover     ├── ai_tool ──▶ AI Agent                                                  │
  save_lead                  │                                                                         │
  start_order                │                                                                         │
  continue_order             │                                                                         │
  close_conversation ────────┘                                                                         │
                                                                                                      ▼
                            AI Agent ──main──▶ Resolve Intent ──main──▶ If intent not already recorded
                                                                          ├─true──▶ POST record_intent ──▶ Build Result
                                                                          └─false─────────────────────────▶ Build Result
```

---

## Independent test (before touching any parent workflow)

n8n editor → open `AI-Agent-Core` → **Test workflow**, with pinned trigger input:

```json
{ "conversation_id": "<a real, active conversation id from Supabase>", "current_message": "مرحبا" }
```

Repeat for: `كم سعر الوجبة؟` · `عندكم فرع برام الله؟` · `بدي أطلب` · `بدي أحكي مع موظف`
· `شكراً`.

For each run, check:
- `Build Result` output matches the contract shape.
- The expected tool fired (open the `AI Agent` node's execution → tool calls).
- `messages.intent` updated in Supabase for that conversation's latest inbound row.
- For handover/closing: `conversations.conversation_status` / `current_step` changed as expected.
- The reply is in the customer's language, speaks as the business, and contains **no**
  `#intent:` text and **no** tool/architecture mentions.
