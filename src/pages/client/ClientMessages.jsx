import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";
import { appendUniqueMessages, prependUniqueMessages, deriveMessageCursors } from "../../lib/messagePagination.js";
import { appendOlderConversations, upsertConversations, deriveConversationCursor } from "../../lib/conversationListPagination.js";
import {
  MESSAGE_TYPES,
  formatFileSize,
  validateMediaFile,
  canSendMediaOnChannel,
  canSendMediaTypeOnChannel,
} from "../../lib/mediaMessages.js";
import { cx } from "../../components/app/primitives.jsx";
import { MEDIA_CONTROLS } from "./inbox/mediaControls.js";
import useConversationCard from "./inbox/useConversationCard.js";
import InboxConversationList from "./inbox/InboxConversationList.jsx";
import InboxConversationHeader from "./inbox/InboxConversationHeader.jsx";
import InboxMessageTimeline from "./inbox/InboxMessageTimeline.jsx";
import InboxComposer from "./inbox/InboxComposer.jsx";
import ConversationCard from "./inbox/ConversationCard.jsx";

// Client Inbox (Phase 3 redesign). This file remains the single container
// for ALL Inbox state and logic — lists, pagination, polling, lifecycle
// actions, ownership rules, sending and media upload are unchanged. Only the
// presentation moved into the ./inbox components.

// Desktop (xl+) Conversation Card column: collapsible, remembered per
// browser. Purely a layout preference — never affects data or permissions.
const DETAILS_STORAGE_KEY = "ar.inbox.details";
function readDetailsOpen() {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function getMessageText(msg = {}) {
  return (
    msg.message ??
    msg.text ??
    msg.body ??
    msg.content ??
    msg.reply_text ??
    msg.reply ??
    msg.response ??
    msg.answer ??
    ""
  );
}


// True when a real (server) message row is the persisted form of a pending
// optimistic echo — an outbound row, at/after the echo's own timestamp,
// with the same text (or, for a media-only send, the same type + file).
// Used both to hide the echo the instant the real row arrives and to drop
// it from pendingOutbound. A 5s slack absorbs client/server clock skew.
function outboundRowMatchesPending(row = {}, pending = {}) {
  if (!["out", "outbound"].includes(row.direction)) return false;
  const rowAt = new Date(row.created_at).getTime();
  const pendAt = new Date(pending.created_at).getTime();
  if (!Number.isFinite(rowAt) || !Number.isFinite(pendAt) || rowAt < pendAt - 5000) return false;
  const rowText = (row.message_text ?? getMessageText(row) ?? "").trim();
  const pendText = (pending.message ?? "").trim();
  if (pendText) return rowText === pendText;
  return (
    row.message_type === pending.message_type &&
    (!pending.media_file_name || row.media_file_name === pending.media_file_name)
  );
}

export default function ClientMessages() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // client_id is resolved once at login via client_users (see Login.jsx).
  const clientId = user?.client_id || null;

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  // Optimistic echo of a just-sent human reply. The server (n8n) is the
  // source of truth — it delivers the message AND inserts the row — but
  // that round trip can take a few seconds, so the employee's own message
  // is shown immediately and removed again the moment the real row shows
  // up in a poll (matched by outboundRowMatchesPending). Cleared on
  // conversation switch. Never inserted into `messages`.
  const [pendingOutbound, setPendingOutbound] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  // True only when this client has more than one distinct WhatsApp
  // channel_key among its current conversations — see fetchConversations.
  // Drives the small "WhatsApp: <number/instance name>" identifier so a
  // single-WhatsApp-number client's UI stays exactly as it looks today.
  const [multipleWhatsappNumbers, setMultipleWhatsappNumbers] = useState(false);

  // Below md, which single Inbox pane is showing — "list" or "chat" —
  // deliberately kept separate from selectedConversationId (which is only
  // ever "which conversation's content is loaded", the same on every
  // viewport). Mixing the two caused mobile to open straight into Chat
  // whenever a conversation got auto-selected (initial load, a realtime
  // refetch, a filter change) — none of that is a user asking to see a
  // chat. Only an explicit tap on a conversation (or the Back button) may
  // change this; see the aside/section render below for how it gates
  // mobile-only visibility, and the click/back handlers for the only two
  // places it's ever set. Ignored entirely at md+ (see those same render
  // classes), where both panes are always visible regardless of this value.
  const [mobileInboxView, setMobileInboxView] = useState("list");

  // Conversation Card V1 — below the 2xl breakpoint the card is a
  // drawer/sheet rather than a persistent pane (see the grid/aside render
  // below); this only controls whether that drawer is open. At 2xl+ the
  // card is always visible as its own grid column and this is ignored
  // (the info button that toggles it is itself hidden at 2xl+).
  const [cardOpen, setCardOpen] = useState(false);

  // Phase 3: desktop (xl+) card column collapse state (persisted) and the
  // composer mode (reply to customer vs. internal note).
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  useEffect(() => {
    try {
      localStorage.setItem(DETAILS_STORAGE_KEY, detailsOpen ? "1" : "0");
    } catch {
      /* storage unavailable — keep the in-memory preference */
    }
  }, [detailsOpen]);
  const [composerMode, setComposerMode] = useState("reply");
  const { isRtl } = useLanguage();

  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [leadsOnly, setLeadsOnly] = useState(false);
  // Debounced copy of `search` — the input itself still updates instantly
  // (setSearch on every keystroke, for responsive typing), but the
  // server-side search request (Conversation List Pagination) only fires
  // 300ms after typing pauses, so it isn't re-sent on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Conversation List Pagination (frontend-only, additive). Initial load
  // fetches only the newest CONVERSATIONS_PAGE_SIZE conversations; older
  // pages are fetched on scroll-near-bottom and appended; the 12s poll
  // fetches ONLY conversations whose last_message_at/updated_at changed
  // since the last check and upserts them (never a full re-fetch, never
  // discards already-loaded older pages). Search/channel/status/leadsOnly
  // now run server-side (see the reset effect below) instead of a
  // client-side .filter() over the full list.
  const CONVERSATIONS_PAGE_SIZE = 30;
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  // Total conversations matching the ACTIVE search/channel/status/leadsOnly
  // criteria (server-computed, not just the loaded/rendered count) — set
  // from fetchInitialConversations' response only; a "load more" page and
  // the delta poll don't change the total, so they leave this untouched.
  // null until the first response arrives.
  const [totalConversationsCount, setTotalConversationsCount] = useState(null);
  const conversationsCursorRef = useRef(null); // {last_message_at, id} | null — oldest loaded conversation
  const conversationsWatermarkRef = useRef(null); // server_time from the last successful list fetch — the delta poll's `since`
  // A serialized signature of whichever search/channel/status/leadsOnly
  // combination is currently "active" — captured by each request at send
  // time and compared at resolve time, so a response for filters the user
  // has since changed away from is discarded rather than applied (rapid
  // filter/search changes, or a poll resolving after a filter change).
  const activeConversationFiltersRef = useRef("");
  const conversationListScrollRef = useRef(null);
  // Every distinct WhatsApp channel_key seen across any page/delta loaded
  // so far — see applyWhatsappInstanceKeys below.
  const whatsappChannelKeysRef = useRef(new Set());

  // Reply composer (Phase 2B): sends via /api/conversation (action:
  // "human_reply"), never inserts
  // into Supabase directly and never touches conversation_status/current_step.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const sendingRef = useRef(false);

  // Selected media attachment (WhatsApp Media & Attachment Support v1
  // foundation — file selection only, nothing is uploaded anywhere yet).
  // Shape: { type, file, previewUrl }. previewUrl is only set for images
  // (an object URL for the thumbnail) and is revoked below whenever it
  // changes or the component unmounts, so it never leaks memory.
  const [attachment, setAttachment] = useState(null);
  const fileInputRefs = useRef({});

  // Message pane scroll behavior: jump to the latest message when a
  // conversation is opened, but don't yank the view down if the user has
  // scrolled up to read older messages.
  const messagesScrollRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const lastLoadedConversationRef = useRef(null);
  const selectedConversationIdRef = useRef(null);

  // Message Pagination / Load Older Messages (frontend-only, additive).
  // Conversation open loads only the newest PAGE_SIZE messages; older
  // pages are fetched on demand and prepended; the 5s poll/post-send
  // follow-up fetch ONLY messages newer than the newest loaded one and
  // append them — neither ever re-fetches or discards already-loaded
  // history. oldestCursorRef/newestCursorRef always mirror the first/last
  // row of conversationMessages (kept in sync by the effect below); a
  // request captures conversationId at start and is discarded if the user
  // has since switched away (see fetchInitialMessages/loadOlderMessages/
  // fetchAndAppendNewerMessages).
  const PAGE_SIZE = 30;
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldestCursorRef = useRef(null);
  const newestCursorRef = useRef(null);
  // Set right before an older page is prepended; consumed by the
  // scroll-preserving useLayoutEffect below, then cleared. Never set for
  // the initial load or a newer/poll append — those don't need it (the
  // existing jump-to-bottom / append-at-bottom behavior already handles
  // those correctly).
  const pendingScrollRestoreRef = useRef(null);
  // Desktop hover-near-top reveal + the touch/mobile equivalent
  // (scrolled near the top of the loaded history) — see
  // handleMessagesScroll and the floating control's render below.
  const [hoveringTop, setHoveringTop] = useState(false);
  const [nearTopScroll, setNearTopScroll] = useState(false);

  // Revokes the previous attachment's object URL (if any) whenever the
  // attachment changes or the component unmounts — avoids leaking memory
  // across repeated select/remove cycles.
  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment]);

  // Conversation Model Redesign — Client Portal read-model migration,
  // server-side read path. contacts/contact_channel_identities/
  // conversations have RLS enabled with zero browser policies (this app
  // has no Supabase Auth session, so the anon-keyed browser client can
  // never read them directly — this is intentional, not a bug to route
  // around client-side). This function no longer queries conversations,
  // contact_channel_identities, or client_whatsapp directly from the
  // browser at all: /api/conversation?resource=list performs the exact same merge
  // (conversations as the source of truth, one entry per conversation
  // id, never grouped/deduplicated by sender_id — see that file for the
  // full rationale) server-side on the service-role client, scoped to
  // the authenticated actor's own membership via actor_user_id (never a
  // client_id trusted from the browser), and returns the already-merged
  // shape below unchanged. messages/leads/Storage and every other query
  // in this file are untouched — only this list-loading query moved
  // server-side.
  // `silent: true` refetches the list in the background (used by the poll
  // that stands in for browser Realtime — see the polling effect below)
  // without toggling the list spinner or the page-level error banner.
  // Conversation List Pagination — query-param builder shared by all three
  // fetch functions below. Search/channel/status/leadsOnly now run
  // server-side (api/_lib/conversationListPage.js), across the full
  // client dataset, instead of the old client-side .filter() over
  // whatever happened to already be loaded.
  function buildConversationListParams({ status: s, channel: c, leadsOnly: lo, search: q }) {
    const params = new URLSearchParams();
    params.set("resource", "list");
    params.set("actor_user_id", user?.id || "");
    if (s && s !== "all") params.set("status", s);
    if (c && c !== "all") params.set("channel", c);
    if (lo) params.set("leads_only", "1");
    if (q && q.trim()) params.set("search", q.trim());
    return params;
  }

  function currentConversationFilters() {
    return { status, channel, leadsOnly, search: debouncedSearch };
  }

  function applyWhatsappInstanceKeys(rows) {
    // Small identifier only appears once it's actually needed to
    // disambiguate — a client with a single WhatsApp number keeps exactly
    // today's appearance. Accumulated across every page/delta loaded (not
    // reset per fetch) since a second number can legitimately only exist
    // in a conversation outside the currently loaded page(s) — the count
    // of distinct numbers a client has is a client-wide fact, not a
    // per-page one.
    let added = false;
    for (const row of rows) {
      if (row.platform?.toLowerCase() === "whatsapp" && row.channel_key && !whatsappChannelKeysRef.current.has(row.channel_key)) {
        whatsappChannelKeysRef.current.add(row.channel_key);
        added = true;
      }
    }
    if (added) setMultipleWhatsappNumbers(whatsappChannelKeysRef.current.size > 1);
  }

  // Initial load, and the reset triggered by every search/filter change
  // (see the effect below): the newest CONVERSATIONS_PAGE_SIZE
  // conversations matching the active filters, replacing whatever was
  // loaded before.
  async function fetchInitialConversations() {
    if (!clientId || !user?.id) return;

    const filters = currentConversationFilters();
    const signature = JSON.stringify(filters);
    activeConversationFiltersRef.current = signature;

    setLoadingConversations(true);
    setError("");
    try {
      const params = buildConversationListParams(filters);
      params.set("limit", String(CONVERSATIONS_PAGE_SIZE));

      const response = await fetch(`/api/conversation?${params.toString()}`);
      const data = await response.json().catch(() => ({}));

      // The user may have already changed the search/filters by the time
      // this resolves — discard rather than paint the wrong list.
      if (activeConversationFiltersRef.current !== signature) return;

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorFetchConversations"));
      }

      const merged = data.conversations || [];
      applyWhatsappInstanceKeys(merged);

      setConversations(merged);
      setHasMoreConversations(!!data.has_more);
      // total_count is always returned by the paginated endpoint's
      // initial-page response (see api/_lib/conversationListPage.js); the
      // ?? guards only the legacy/unbounded response shape, which has no
      // such field.
      setTotalConversationsCount(data.total_count ?? null);
      conversationsWatermarkRef.current = data.server_time || null;
      conversationsCursorRef.current = deriveConversationCursor(merged);
      // Auto-selecting the first conversation here is safe on every
      // viewport, including mobile: selectedConversationId is purely
      // "which conversation's content is loaded" — it no longer also
      // decides which mobile pane is showing (see mobileInboxView below,
      // and the aside/section render below that reads it instead). A
      // previous version of this fix gated this fallback by viewport via
      // window.matchMedia to work around selectedConversationId still
      // doing double duty; that's no longer needed now that the two
      // concerns are separate state.
      setSelectedConversationId((current) => (current && merged.some((c) => c.conversation_id === current) ? current : merged[0]?.conversation_id || null));
    } catch (err) {
      console.error(err);
      if (activeConversationFiltersRef.current === signature) setError(t("messagesPage.errorFetchConversations"));
    } finally {
      if (activeConversationFiltersRef.current === signature) setLoadingConversations(false);
    }
  }

  // Scroll-near-bottom: the next older page, appended below what's
  // already loaded. Never replaces or discards already-loaded rows.
  async function loadMoreConversations() {
    if (!clientId || !user?.id || loadingMoreConversations || !hasMoreConversations) return;
    const cursor = conversationsCursorRef.current;
    if (!cursor) return;

    const filters = currentConversationFilters();
    const signature = JSON.stringify(filters);

    setLoadingMoreConversations(true);
    try {
      const params = buildConversationListParams(filters);
      params.set("limit", String(CONVERSATIONS_PAGE_SIZE));
      if (cursor.last_message_at) params.set("before_last_message_at", cursor.last_message_at);
      params.set("before_id", cursor.id);

      const response = await fetch(`/api/conversation?${params.toString()}`);
      const data = await response.json().catch(() => ({}));

      if (activeConversationFiltersRef.current !== signature) return; // filters changed while loading — discard

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorFetchConversations"));
      }

      const olderRows = data.conversations || [];
      applyWhatsappInstanceKeys(olderRows);

      setConversations((prev) => {
        const merged = appendOlderConversations(prev, olderRows);
        conversationsCursorRef.current = deriveConversationCursor(merged);
        return merged;
      });
      setHasMoreConversations(!!data.has_more);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  // 12s poll (unchanged cadence): only conversations whose
  // last_message_at OR updated_at changed since the last check (a
  // wall-clock watermark returned by the server on every previous
  // fetch — never the browser's own clock, and never derived from a
  // specific row, since a lifecycle-only change on an already-loaded
  // conversation can bump updated_at without last_message_at moving at
  // all). Upserts by conversation_id and re-sorts — never a full
  // re-fetch, never discards an already-loaded older page.
  async function pollConversationsDelta() {
    if (!clientId || !user?.id) return;
    const since = conversationsWatermarkRef.current;
    if (!since) return; // nothing loaded yet for the current filters

    const filters = currentConversationFilters();
    const signature = JSON.stringify(filters);

    try {
      const params = buildConversationListParams(filters);
      params.set("since", since);

      const response = await fetch(`/api/conversation?${params.toString()}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) return;
      if (activeConversationFiltersRef.current !== signature) return; // filters changed meanwhile — discard

      if (data.server_time) conversationsWatermarkRef.current = data.server_time;

      const changedRows = data.conversations || [];
      if (changedRows.length === 0) return;
      applyWhatsappInstanceKeys(changedRows);

      setConversations((prev) => {
        const merged = upsertConversations(prev, changedRows);
        conversationsCursorRef.current = deriveConversationCursor(merged);
        return merged;
      });
    } catch (err) {
      console.error(err);
    }
  }

  // Historical messages are read through the server-side, service-role
  // endpoint (Conversation Model V2 read-path cleanup) — a direct browser
  // supabase.from("messages") query here is subject to `messages` RLS on
  // the anon key and was silently returning an empty set, so the center
  // panel showed "no messages" for conversations the (service-role) list
  // endpoint had already counted correctly. client_id is derived
  // server-side from the actor's membership; conversation_id stays the V2
  // conversations.id.
  //
  // Message Pagination / Load Older Messages — three call shapes against
  // the SAME additive, opt-in ?limit= endpoint (api/_lib/
  // conversationMessagesPage.js):
  //   fetchInitialMessages       — conversation open: newest PAGE_SIZE only
  //   loadOlderMessages          — explicit "Load older" click: the next
  //                                 page strictly before the oldest loaded
  //                                 cursor, prepended
  //   fetchAndAppendNewerMessages — the 5s poll + the post-send follow-up:
  //                                 only rows strictly after the newest
  //                                 loaded cursor, appended
  // None of the three ever re-fetches or replaces the full history, so an
  // older page the user pulled in can never be discarded by a later poll.

  function mapMessageRows(rawRows) {
    return (rawRows || []).map((m) => ({ ...m, message_text: getMessageText(m) }));
  }

  // Conversation open: the newest PAGE_SIZE messages only.
  async function fetchInitialMessages(conversationId) {
    if (!conversationId || !clientId) return;

    setLoadingMessages(true);
    setError("");
    try {
      const response = await fetch(
        `/api/conversation?resource=messages&actor_user_id=${encodeURIComponent(user?.id)}` +
          `&conversation_id=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}`
      );
      const payload = await response.json().catch(() => ({}));

      // The user may have already switched to a different conversation by
      // the time this resolves — discard rather than paint the wrong chat.
      if (selectedConversationIdRef.current !== conversationId) return;

      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.message || t("messagesPage.errorFetchMessages"));
      }

      setConversationMessages(mapMessageRows(payload.messages));
      setHasMoreOlder(!!payload.has_more);
    } catch (err) {
      console.error(err);
      if (selectedConversationIdRef.current === conversationId) setError(t("messagesPage.errorFetchMessages"));
    } finally {
      if (selectedConversationIdRef.current === conversationId) setLoadingMessages(false);
    }
  }

  // "Load older": the next page strictly before the oldest loaded cursor,
  // prepended. Captures scrollHeight/scrollTop right before the state
  // update so the scroll-preserving useLayoutEffect below can restore the
  // exact visible position once the taller content is painted.
  async function loadOlderMessages() {
    const conversationId = selectedConversationIdRef.current;
    const cursor = oldestCursorRef.current;
    if (!conversationId || !cursor || loadingOlder || !hasMoreOlder) return;

    setLoadingOlder(true);
    try {
      const response = await fetch(
        `/api/conversation?resource=messages&actor_user_id=${encodeURIComponent(user?.id)}` +
          `&conversation_id=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}` +
          `&before_created_at=${encodeURIComponent(cursor.created_at)}&before_id=${encodeURIComponent(cursor.id)}`
      );
      const payload = await response.json().catch(() => ({}));

      if (selectedConversationIdRef.current !== conversationId) return; // switched away — discard

      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.message || t("messagesPage.errorFetchMessages"));
      }

      const olderRows = mapMessageRows(payload.messages);
      if (olderRows.length > 0) {
        const el = messagesScrollRef.current;
        pendingScrollRestoreRef.current = el ? { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop } : null;
        setConversationMessages((prev) => prependUniqueMessages(prev, olderRows));
      }
      setHasMoreOlder(!!payload.has_more);
    } catch (err) {
      console.error(err);
      // Silent — matches the existing poll's error handling. The control
      // stays visible/clickable so the employee can simply retry.
    } finally {
      if (selectedConversationIdRef.current === conversationId) setLoadingOlder(false);
    }
  }

  // 5s poll + post-send follow-up: only rows strictly after the newest
  // loaded cursor, appended. Returns the number of genuinely new rows
  // appended (0 for an empty/no-op result, or a stale/switched-away
  // response) so refreshMessagesAfterSend can stop its own retries early —
  // an empty result never touches state, so React renders nothing for it.
  async function fetchAndAppendNewerMessages(conversationId) {
    if (!conversationId || !clientId) return 0;
    const cursor = newestCursorRef.current;
    if (!cursor) return 0; // nothing loaded yet for this conversation — the initial fetch owns that

    try {
      const response = await fetch(
        `/api/conversation?resource=messages&actor_user_id=${encodeURIComponent(user?.id)}` +
          `&conversation_id=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}` +
          `&after_created_at=${encodeURIComponent(cursor.created_at)}&after_id=${encodeURIComponent(cursor.id)}`
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload?.success === false) return 0;
      if (selectedConversationIdRef.current !== conversationId) return 0; // switched away — discard

      const newerRows = mapMessageRows(payload.messages);
      if (newerRows.length === 0) return 0;

      let appendedCount = 0;
      setConversationMessages((prev) => {
        const merged = appendUniqueMessages(prev, newerRows);
        appendedCount = merged === prev ? 0 : merged.length - prev.length;
        return merged;
      });
      return appendedCount;
    } catch (err) {
      console.error(err);
      return 0;
    }
  }

  async function fetchSelectedLead(conversationId) {
    if (!conversationId || !clientId) {
      setSelectedLead(null);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", clientId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw error;
      setSelectedLead(data?.[0] || null);
    } catch (err) {
      console.error(err);
      setSelectedLead(null);
    }
  }

  // Shared status-update helper. Delegates to the server-authorized
  // /api/conversation endpoint rather than writing conversation_state
  // directly from the browser — this used to be a direct Supabase write
  // with no actor/permission/ownership check at all, which meant a
  // non-assigned teammate could bypass the UI's disabled Close button
  // entirely by calling Supabase from devtools. The server now re-derives
  // client_id/permission and, for `close`, verifies the actor is the
  // conversation's assigned employee whenever it's already waiting_human
  // (see api/_lib/conversationLifecycle.js). `currentStep`/`preserveStep`/
  // `clearAssignment`/`assignToActor` only shape the *local* optimistic
  // patch to match what the server is known to have done for each action
  // — they don't control server behavior.
  async function applyStatusChange(action, newStatus, { currentStep = null, preserveStep = false, clearAssignment = false, assignToActor = false } = {}) {
    if (!selectedConversationId || !clientId) return;

    try {
      setUpdatingStatus(true);
      setError("");

      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, conversation_id: selectedConversationId, actor_user_id: user?.id }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorStatusUpdate"));
      }

      const payload = { conversation_status: newStatus, updated_at: data.updated_at || new Date().toISOString() };
      if (!preserveStep) payload.current_step = currentStep;
      // Keep closed_at consistent locally so the Reopen control's 2h
      // window (see reopenWindowExpired) reflects this action without a
      // refetch. close stamps it; reopen clears it.
      if (action === "close") payload.closed_at = data.solved_at || new Date().toISOString();
      if (action === "reopen") payload.closed_at = null;
      if (clearAssignment) {
        payload.assigned_user_id = null;
        payload.assigned_at = null;
      }
      // Manual Reopen only: the employee performing the action becomes
      // both the current designated employee and the actual owner
      // immediately — there is no Smart Assignment step and no separate
      // Claim in this scenario (see reopenConversation below and
      // apply_conversation_lifecycle_action's 'reopen' action, which the
      // server has already applied identically before this response
      // returns).
      if (assignToActor) {
        const nowIso = new Date().toISOString();
        payload.assigned_user_id = user?.id || null;
        payload.assigned_at = nowIso;
        payload.system_assigned_user_id = user?.id || null;
        payload.system_assigned_at = nowIso;
      }

      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === selectedConversationId
            ? {
                ...conv,
                ...payload,
                assigned_user: clearAssignment ? null : assignToActor ? { id: user?.id, name: user?.name } : conv.assigned_user,
                system_assigned_user: assignToActor ? { id: user?.id, name: user?.name } : conv.system_assigned_user,
              }
            : conv
        )
      );
    } catch (err) {
      console.error(err);
      setError(err.message || t("messagesPage.errorStatusUpdate"));
    } finally {
      setUpdatingStatus(false);
    }
  }

  // Explicit close: conversation_status = closed, current_step = done.
  // Assignment (if any) is deliberately preserved — see applyStatusChange.
  // Server-enforced: blocked unless the actor is the assigned employee, if
  // the conversation is already waiting_human (see api/_lib/conversationLifecycle.js).
  function closeConversation() {
    return applyStatusChange("close", "closed", { currentStep: "done" });
  }

  // Explicit reopen: conversation_status = waiting_human (Human Mode),
  // current_step = null. Clicking Reopen itself means "I am reopening and
  // taking this conversation" — there is no Smart Assignment step and no
  // separate Claim afterward; the employee performing Reopen becomes both
  // system_assigned_user_id and assigned_user_id immediately (assignToActor),
  // matching apply_conversation_lifecycle_action's 'reopen' action exactly.
  // Automation stays blocked (still waiting_human, unaffected by who owns
  // it). Only ever called from a closed conversation (see the button
  // below), which has no owner-concept yet, so this stays open to any
  // Inbox-eligible teammate — whoever clicks it becomes the owner.
  function reopenConversation() {
    return applyStatusChange("reopen", "waiting_human", { currentStep: null, assignToActor: true });
  }

  // Explicit human takeover: conversation_status = waiting_human only.
  // current_step must be preserved exactly, not reset. This only opens the
  // shared queue — it does not assign anyone; see claimConversation for the
  // explicit per-employee claim step. Always called from a non-waiting_human
  // state, so there's no owner yet to check against.
  function takeoverConversation() {
    return applyStatusChange("takeover", "waiting_human", { preserveStep: true });
  }

  // Explicit claim ("استلام المحادثة"): delegates the actual assignment to
  // /api/conversation (action: "claim"), which performs a single conditional UPDATE
  // (... WHERE assigned_user_id IS NULL) so only one concurrent caller can
  // ever win — see that file for the full race-condition explanation. This
  // handler never assumes it won; it always reconciles local state with
  // whatever the API reports, whether that's success or "already claimed".
  async function claimConversation(conversationId) {
    if (!conversationId || claimingId) return;

    setClaimingId(conversationId);
    setError("");

    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", conversation_id: conversationId, actor_user_id: user?.id }),
      });

      const data = await response.json().catch(() => ({}));
      const assignment = data?.assignment || null;

      if (data?.claimed) {
        setConversations((prev) =>
          prev.map((conv) =>
            conv.conversation_id === conversationId
              ? {
                  ...conv,
                  assigned_user_id: assignment?.assigned_user_id || null,
                  assigned_at: assignment?.assigned_at || null,
                  assigned_user: assignment?.assigned_user || null,
                }
              : conv
          )
        );
        return;
      }

      // Lost the race, or the conversation left waiting_human in the
      // meantime — reconcile with the API's view instead of just failing,
      // so the button/badge reflects the real current owner immediately.
      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === conversationId
            ? {
                ...conv,
                conversation_status: assignment?.conversation_status || conv.conversation_status,
                assigned_user_id: assignment?.assigned_user_id ?? conv.assigned_user_id,
                assigned_user: assignment?.assigned_user || conv.assigned_user,
              }
            : conv
        )
      );
      setError(data?.message || t("messagesPage.errorClaimFailed"));
    } catch (err) {
      console.error(err);
      setError(t("messagesPage.errorClaimRetry"));
    } finally {
      setClaimingId(null);
    }
  }

  // After a successful send, n8n still needs to deliver through the channel
  // and insert the outbound row — poll a few times with backoff instead of
  // inserting a local fake message. Bails out early if the user has since
  // switched conversations, or as soon as the new row (or any other new
  // row) has actually been appended.
  async function refreshMessagesAfterSend(conversationId) {
    const delaysMs = [600, 1200, 2000];

    for (const delay of delaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (selectedConversationIdRef.current !== conversationId) return;

      const appended = await fetchAndAppendNewerMessages(conversationId);
      if (appended > 0) return;
    }
  }

  // Opens the hidden file input for a media control. Only reachable when
  // canSendMedia is true (see the button's own disabled state below) —
  // this function itself doesn't re-check, matching how other UI-only
  // guards in this file already work (the real enforcement, once media
  // sending exists, will live server-side).
  function handleMediaButtonClick(key) {
    fileInputRefs.current[key]?.click();
  }

  // Validates the selected file against the centralized limits (see
  // src/lib/mediaMessages.js) and stores it as the pending attachment, or
  // shows a translated error and leaves the current draft/attachment
  // untouched. Never uploads anything — there is nowhere to upload to yet.
  function handleFileSelected(type, e) {
    const file = e.target.files?.[0];
    // Reset the input's value so selecting the exact same file again later
    // (e.g. after removing it) still fires onChange.
    e.target.value = "";
    if (!file) return;

    const result = validateMediaFile(type, file);
    if (!result.valid) {
      setSendError(
        result.reason === "too_large"
          ? t("messagesPage.errorFileTooLarge", { max: formatFileSize(result.maxBytes) })
          : t("messagesPage.errorUnsupportedFileType")
      );
      return;
    }

    setSendError("");
    setAttachment({
      type,
      file,
      previewUrl: type === MESSAGE_TYPES.IMAGE ? URL.createObjectURL(file) : null,
    });
  }

  function removeAttachment() {
    setAttachment(null);
    setSendError("");
  }

  // Uploads the selected attachment directly to Supabase Storage via a
  // short-lived signed URL minted server-side (api/media.js, action: "sign_upload" —
  // this function never touches the service-role key or any Storage admin
  // credential itself). Called from sendHumanReply only when the user
  // presses Send (never on file selection), so choosing then removing an
  // attachment never leaves an orphaned object in Storage.
  //
  // Returns the attachment metadata api/_lib/humanReply.js's media payload
  // needs (media_path/media_mime_type/media_file_name/media_size_bytes —
  // same names as the messages table's media_* columns).
  async function uploadAttachmentToStorage(conversationId, pendingAttachment) {
    const { file, type } = pendingAttachment;

    const urlResponse = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sign_upload",
        conversation_id: conversationId,
        actor_user_id: user?.id,
        message_type: type,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      }),
    });

    const urlData = await urlResponse.json().catch(() => ({}));
    if (!urlResponse.ok || urlData?.success === false) {
      throw new Error(urlData?.message || t("messagesPage.errorUploadFailed"));
    }

    const { error: uploadError } = await supabase.storage
      .from(urlData.bucket)
      .uploadToSignedUrl(urlData.path, urlData.token, file);

    if (uploadError) {
      throw new Error(t("messagesPage.errorUploadFailed"));
    }

    return {
      media_path: urlData.path,
      media_mime_type: file.type,
      media_file_name: file.name,
      media_size_bytes: file.size,
    };
  }

  // Sends a human reply via the server-side proxy only. Must never insert
  // into `messages` directly and must never touch conversation_status /
  // current_step — those are owned by the explicit action buttons above.
  async function sendHumanReply() {
    const trimmed = draft.trim();
    if ((!trimmed && !attachment) || !selectedConversationId || sendingRef.current) return;
    // Mirrors the composer's own disabled state (see canSendHumanReply)
    // — belt-and-suspenders against any path that could still call this
    // directly. The server (api/_lib/humanReply.js) is the authoritative check.
    if (!canSendHumanReply) return;
    // Belt-and-suspenders mirror of the media controls' own disabled state
    // (canSendMedia — WhatsApp/Evolution only). The attachment can only be
    // selected via those controls, but api/_lib/humanReply.js is the actual
    // authoritative gate for Facebook/Telegram/unknown channels.
    if (attachment && !canSendMedia) {
      setSendError(t("messagesPage.mediaSendingUnavailable"));
      return;
    }
    // Per-channel type support (e.g. Instagram has no outbound document).
    if (attachment && !canSendMediaTypeOnChannel(selectedChannelValue, attachment.type)) {
      setSendError(t("messagesPage.mediaSendingUnavailable"));
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setSendError("");

    const conversationId = selectedConversationId;
    const pendingAttachment = attachment;

    // Optimistic echo — shown immediately, reconciled away by the poll when
    // the real n8n-inserted row arrives (or removed here on send failure).
    const echoId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const echo = {
      id: echoId,
      conversation_id: conversationId,
      direction: "outbound",
      message: trimmed,
      message_text: trimmed,
      message_type: pendingAttachment ? pendingAttachment.type : MESSAGE_TYPES.TEXT,
      media_file_name: pendingAttachment ? pendingAttachment.file.name : null,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setPendingOutbound((prev) => [...prev, echo]);

    try {
      // Upload-on-send only (never on selection) — see
      // uploadAttachmentToStorage. If /api/conversation (human_reply) then fails, the
      // uploaded object is not deleted: this app has no client-safe delete
      // permission against the private chat-media bucket (only signed
      // upload/read URLs are ever minted, both scoped and short-lived), and
      // inventing one would weaken Storage security. That upload becomes an
      // orphan in this failure case — documented, not silently hidden.
      const media = pendingAttachment ? await uploadAttachmentToStorage(conversationId, pendingAttachment) : null;

      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "human_reply",
          conversation_id: conversationId,
          message: trimmed,
          actor_user_id: user?.id,
          message_type: pendingAttachment ? pendingAttachment.type : MESSAGE_TYPES.TEXT,
          ...(media || {}),
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorSendReply"));
      }

      setDraft("");
      setAttachment(null);
      refreshMessagesAfterSend(conversationId);
    } catch (err) {
      console.error(err);
      // The send failed — drop the echo so the composer's error banner is
      // the only signal, and the employee can retry.
      setPendingOutbound((prev) => prev.filter((p) => p.id !== echoId));
      setSendError(err.message || t("messagesPage.errorSendRetry"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendHumanReply();
    }
  }

  // Initial load AND every search/channel/status/leadsOnly change: reset
  // pagination (cursor + has_more) and fetch page 1 under the new filters
  // — search/filters must never just narrow whatever happened to already
  // be loaded, and must never try to "continue" a cursor across a filter
  // change.
  useEffect(() => {
    if (!clientId) return;
    conversationsCursorRef.current = null;
    setHasMoreConversations(false);
    fetchInitialConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, debouncedSearch, channel, status, leadsOnly]);

  // New messages: lightweight background polling of the same server-side
  // endpoints the rest of this page already uses.
  //
  // Why not Supabase Realtime: this app has no Supabase Auth session — it
  // uses the anon key plus its own app-level auth (see
  // src/lib/supabaseClient.js and AuthContext), so `auth.uid()` is always
  // null for the browser client. public.messages RLS denies the anon role
  // (the same reason the historical message read had to move to the
  // service-role /api/conversation?resource=messages endpoint in commit
  // c4764e3), and Supabase Realtime `postgres_changes` only delivers a row
  // to a client that could SELECT it — so the previous
  // `.channel(...).on("postgres_changes", { table: "messages" })`
  // subscription received nothing and new messages never appeared without a
  // manual refresh. Restoring true Realtime would require either weakening
  // messages RLS for anon (a tenant-isolation regression — anyone could
  // read any client's messages) or minting per-user Supabase JWTs, neither
  // of which exists in this architecture. Polling the two service-role
  // endpoints keeps the tenant boundary intact.
  //
  // Two cadences, unchanged (5s / 12s, silent, paused while the tab is
  // hidden): the open thread reveals new inbound/outbound messages —
  // including media rows, which flow through the exact same
  // mapMessageRows mapping and MediaAttachment renderer as a historical
  // load; the list surfaces new conversations, preview text, counts and
  // lifecycle changes. What changed (Message Pagination / Load Older) is
  // ONLY the message poll's fetch scope: fetchAndAppendNewerMessages asks
  // for messages strictly newer than the newest loaded cursor and appends
  // them, instead of re-fetching (and potentially discarding already
  // loaded older pages of) the full/latest history. selectedConversationId
  // is read from its ref so the interval never appends another
  // conversation's messages into the open thread.
  useEffect(() => {
    if (!clientId || !user?.id) return;

    const pollMessages = () => {
      if (document.hidden) return;
      const convId = selectedConversationIdRef.current;
      if (convId) fetchAndAppendNewerMessages(convId);
    };
    const pollList = () => {
      if (document.hidden) return;
      pollConversationsDelta();
    };
    const onVisible = () => {
      if (document.hidden) return;
      pollMessages();
      pollList();
    };

    const messagesTimer = setInterval(pollMessages, 5000);
    const listTimer = setInterval(pollList, 12000);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(messagesTimer);
      clearInterval(listTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, user?.id]);

  // Conversation List Pagination: search/channel/status/leadsOnly are now
  // applied server-side (see fetchInitialConversations/the reset effect
  // above) across the FULL client dataset, not just whatever happened to
  // already be loaded — `conversations` already IS the filtered list.
  // Kept as its own identifier (rather than renaming every reference
  // below) purely to keep this change's diff minimal.
  const filteredConversations = conversations;

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null);
      setConversationMessages([]);
      setSelectedLead(null);
      return;
    }
    const exists = filteredConversations.some((c) => c.conversation_id === selectedConversationId);
    // Auto-selecting here (e.g. a filter change drops the current
    // selection) is safe on every viewport — see the note on
    // fetchConversations' own fallback above; this never touches
    // mobileInboxView, so it can never silently open the mobile chat pane.
    if (!exists) setSelectedConversationId(filteredConversations[0].conversation_id);
  }, [filteredConversations, selectedConversationId]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;

    // Switching conversations abandons any in-progress draft/error/
    // attachment/optimistic echo for the previous one rather than carrying
    // it over to the newly selected chat. Also resets the pagination state
    // (Message Pagination / Load Older Messages): the cursors are cleared
    // synchronously here — not left to the cursor-sync effect below, which
    // only reacts once fetchInitialMessages' new rows actually land — so a
    // poll tick firing in the brief gap before that resolves cannot use a
    // stale (previous conversation's) cursor against the newly-selected
    // conversation_id.
    setDraft("");
    setSendError("");
    setAttachment(null);
    setCardOpen(false);
    setPendingOutbound([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    oldestCursorRef.current = null;
    newestCursorRef.current = null;
    pendingScrollRestoreRef.current = null;

    if (selectedConversationId) {
      fetchInitialMessages(selectedConversationId);
      fetchSelectedLead(selectedConversationId);
    } else {
      setConversationMessages([]);
      setSelectedLead(null);
    }
  }, [selectedConversationId]);

  // Keeps oldestCursorRef/newestCursorRef in sync with whatever is
  // actually displayed — the single source of truth for both
  // loadOlderMessages' before_* cursor and fetchAndAppendNewerMessages'
  // after_* cursor, recomputed after every initial load / older-prepend /
  // newer-append. O(1) (first/last of an already-ascending array), so this
  // is not a meaningful re-render cost even for a long conversation.
  useEffect(() => {
    const { oldest, newest } = deriveMessageCursors(conversationMessages);
    oldestCursorRef.current = oldest;
    newestCursorRef.current = newest;
  }, [conversationMessages]);

  // Restores the user's exact visible scroll position after an older page
  // is prepended — runs synchronously after the DOM reflects the taller
  // content but before the browser paints, so there is no visible jump.
  // A no-op on every other conversationMessages change (initial load,
  // newer/poll append): pendingScrollRestoreRef is only ever set by
  // loadOlderMessages, right before its setConversationMessages call.
  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - pending.prevScrollHeight + pending.prevScrollTop;
  }, [conversationMessages]);

  // Reconcile optimistic echoes against what the poll actually returned:
  // drop an echo once its persisted row is in conversationMessages, and
  // expire any straggler after 45s so a silently-dropped n8n insert can
  // never leave a phantom bubble accumulating across sends.
  useEffect(() => {
    if (pendingOutbound.length === 0) return;
    const now = Date.now();
    setPendingOutbound((prev) => {
      const next = prev.filter(
        (p) =>
          !conversationMessages.some((m) => outboundRowMatchesPending(m, p)) &&
          now - new Date(p.created_at).getTime() < 45000
      );
      return next.length === prev.length ? prev : next;
    });
  }, [conversationMessages, pendingOutbound.length]);

  // What the message pane actually renders: the server rows plus any
  // still-unconfirmed echo for THIS conversation (a matched echo is hidden
  // here immediately, even in the render before the reconcile effect runs).
  const visibleMessages = useMemo(() => {
    const stillPending = pendingOutbound.filter(
      (p) =>
        p.conversation_id === selectedConversationId &&
        !conversationMessages.some((m) => outboundRowMatchesPending(m, p))
    );
    return stillPending.length ? [...conversationMessages, ...stillPending] : conversationMessages;
  }, [conversationMessages, pendingOutbound, selectedConversationId]);

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;

    // Touch/mobile equivalent of the desktop hover reveal for the
    // floating "Load older" control (no hover on touch) — reuses this
    // same, already-existing scroll handler; no new listener/library.
    // Same-value bail keeps this from forcing a re-render on every scroll
    // pixel, only when the near-top state actually flips.
    const nearTop = el.scrollTop < 80;
    setNearTopScroll((prev) => (prev === nearTop ? prev : nearTop));
  }

  // Conversation List Pagination — infinite scroll: loads the next page
  // automatically once the sidebar is scrolled near its bottom.
  // loadMoreConversations already guards on loadingMoreConversations/
  // hasMoreConversations, so repeated scroll events (and the trailing
  // event once has_more becomes false) are safe no-ops.
  function handleConversationListScroll() {
    const el = conversationListScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 150) loadMoreConversations();
  }

  // Jump to the latest message whenever a (new) conversation finishes loading.
  // If the user is mid-conversation and already scrolled near the bottom,
  // keep following new messages; if they scrolled up to read older ones,
  // leave their scroll position alone.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || visibleMessages.length === 0) return;
    const conversationChanged = lastLoadedConversationRef.current !== selectedConversationId;
    lastLoadedConversationRef.current = selectedConversationId;
    if (conversationChanged || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
    }
  }, [visibleMessages, selectedConversationId]);

  // Performance patch: this was a plain `const`, so the O(n) scan re-ran on
  // EVERY render of this page (every poll tick, every composer keystroke,
  // every sending/attachment state change) — not only when the selection
  // or the list actually changed. Memoized: identical result, computed
  // only when one of those two actually changes.
  const selectedConversation = useMemo(
    () => filteredConversations.find((c) => c.conversation_id === selectedConversationId) || null,
    [filteredConversations, selectedConversationId]
  );
  const conversationStatus = selectedConversation?.conversation_status || "active";

  // Human Takeover ownership (display/UX layer only — the authoritative
  // check is server-side in api/_lib/humanReply.js and api/_lib/conversationLifecycle.js).
  // A conversation not in the human queue has no owner concept and is
  // always controllable, matching pre-existing behavior. Once
  // waiting_human, only the assigned employee may reply/close — and if
  // nobody has claimed it yet (assigned_user_id null), that correctly
  // evaluates to "not me" for everyone, blocking the composer/Close button
  // until someone claims it. A closed conversation is always read-only for
  // everyone, regardless of who was assigned before it closed — Reopen
  // (not Send) is the only available action until an employee explicitly
  // reopens it.
  const isWaitingHuman = conversationStatus === "waiting_human";
  const isClosedConversation = conversationStatus === "closed";
  const isOwnedByMe = !!selectedConversation?.assigned_user_id && selectedConversation.assigned_user_id === user?.id;
  const canControlConversation = !isClosedConversation && (!isWaitingHuman || isOwnedByMe);

  // Human outbound (text reply + media) permission — mirrors the server
  // rule in api/_lib/conversationOwnership.js#humanTakeoverBlock exactly:
  // allowed ONLY on a waiting_human conversation this employee actually
  // owns. An active/AI-driven conversation (including one the resolver
  // auto-reopened) is NOT sendable — the employee must Transfer to Agent
  // then Claim first. system_assigned_user_id (a recommendation) is
  // deliberately NOT part of this — only assigned_user_id (isOwnedByMe).
  const canSendHumanReply = isWaitingHuman && isOwnedByMe;

  // Manual Reopen is server-enforced to only work within 2h of closed_at
  // (apply_conversation_lifecycle_action -> outcome 'expired' otherwise;
  // see supabase/migrations/20260907_manual_reopen_2h_window.sql). This is
  // the matching UI mirror: past the window the conversation is a
  // read-only archive — hide Reopen and explain why. A missing closed_at
  // on a closed row is treated as already archived.
  const REOPEN_WINDOW_MS = 2 * 60 * 60 * 1000;
  const reopenWindowExpired =
    isClosedConversation &&
    (() => {
      const closedAt = selectedConversation?.closed_at;
      if (!closedAt) return true;
      const ts = new Date(closedAt).getTime();
      if (Number.isNaN(ts)) return true;
      return Date.now() - ts >= REOPEN_WINDOW_MS;
    })();

  // Media & Attachment Support — see SUPPORTED_MEDIA_CHANNEL_VALUES in
  // src/lib/mediaMessages.js for exactly which channel values this allows
  // (whatsapp/facebook/telegram today). Any other/unknown channel value
  // stays false here.
  const canSendMedia = canSendMediaOnChannel(selectedConversation?.channel || selectedConversation?.platform);
  // Per-channel media-type support: Instagram has no outbound document
  // type (Meta), so its Document control is not rendered at all. Other
  // channels keep every control.
  const selectedChannelValue = selectedConversation?.channel || selectedConversation?.platform;
  const availableMediaControls = MEDIA_CONTROLS.filter((c) =>
    canSendMediaTypeOnChannel(selectedChannelValue, c.type)
  );

  // One shared Conversation Card data source (details + notes) for the
  // panel, the drawer and the composer's Internal Note mode — one fetch per
  // conversation, exactly the requests the previous card made.
  const cardData = useConversationCard({
    conversationId: selectedConversation?.conversation_id || null,
    actorUserId: user?.id,
    enabled: !!selectedConversation,
    t,
  });

  // A new conversation always opens in Reply mode.
  useEffect(() => {
    setComposerMode("reply");
  }, [selectedConversationId]);


  // Composer notice — identical texts/conditions to the previous composer.
  const composerNotice = !selectedConversation
    ? ""
    : isClosedConversation
      ? reopenWindowExpired
        ? t(
            "messagesPage.conversationArchivedNotice",
            "هذه المحادثة مؤرشفة (مضى أكثر من ساعتين على إغلاقها) ولا يمكن إعادة فتحها. أي رسالة جديدة من العميل ستبدأ محادثة جديدة."
          )
        : t("messagesPage.conversationClosedNotice")
      : isWaitingHuman
        ? selectedConversation.assigned_user_id
          ? t("messagesPage.claimedByNotice", { name: selectedConversation.assigned_user?.name || t("roles.agent") })
          : t("messagesPage.mustClaimFirst")
        : t(
            "messagesPage.automationHandlingNotice",
            "هذه المحادثة يديرها الرد الآلي حالياً. اضغط «تحويل إلى موظف» ثم «استلام المحادثة» للرد يدوياً."
          );

  // Details toggle: at xl+ it collapses/expands the card column; below xl
  // it opens the drawer (same component, same shared data).
  function toggleDetails() {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches) setDetailsOpen((v) => !v);
    else setCardOpen(true);
  }

  // Three-tier responsive Inbox (unchanged tiers):
  //   - < md: one pane at a time, chosen by mobileInboxView (never by
  //     selectedConversationId); Back returns to the list.
  //   - md–xl: list + chat side by side; Conversation Card is a drawer.
  //   - xl+: list | chat | collapsible Conversation Card column.
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {error && <div className="shrink-0 rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">{error}</div>}

      <div
        className={cx(
          "grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm md:grid-cols-[300px_minmax(0,1fr)]",
          detailsOpen ? "xl:grid-cols-[320px_minmax(0,1fr)_320px]" : "xl:grid-cols-[320px_minmax(0,1fr)]"
        )}
      >
        <aside className={`${mobileInboxView === "chat" ? "hidden md:flex" : "flex"} h-full min-h-0 flex-col border-e border-slate-200/80 bg-white`}>
          <InboxConversationList
            conversations={filteredConversations}
            selectedConversationId={selectedConversationId}
            onSelect={(id) => {
              // Explicit selection: the only two writers of mobileInboxView
              // are this click and the Back button — never fetches/polls.
              setSelectedConversationId(id);
              setMobileInboxView("chat");
            }}
            loading={loadingConversations}
            loadingMore={loadingMoreConversations}
            totalCount={totalConversationsCount}
            search={search}
            setSearch={setSearch}
            channel={channel}
            setChannel={setChannel}
            status={status}
            setStatus={setStatus}
            leadsOnly={leadsOnly}
            setLeadsOnly={setLeadsOnly}
            onRefresh={() => fetchInitialConversations()}
            listScrollRef={conversationListScrollRef}
            onListScroll={handleConversationListScroll}
            multipleWhatsappNumbers={multipleWhatsappNumbers}
            userId={user?.id}
            t={t}
          />
        </aside>

        <section className={`${mobileInboxView === "chat" ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-col bg-white`}>
          {!selectedConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-400">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-slate-300" />
              {t("messagesPage.selectConversationPrompt")}
            </div>
          ) : (
            <>
              <InboxConversationHeader
                conv={selectedConversation}
                selectedLead={selectedLead}
                multipleWhatsappNumbers={multipleWhatsappNumbers}
                userId={user?.id}
                conversationStatus={conversationStatus}
                canControlConversation={canControlConversation}
                reopenWindowExpired={reopenWindowExpired}
                claimingId={claimingId}
                updatingStatus={updatingStatus}
                onClaim={claimConversation}
                onTakeover={takeoverConversation}
                onClose={closeConversation}
                onReopen={reopenConversation}
                onBack={() => setMobileInboxView("list")}
                onToggleDetails={toggleDetails}
                detailsPressed={detailsOpen}
                t={t}
              />

              <InboxMessageTimeline
                messages={visibleMessages}
                events={cardData.card?.timeline}
                timelineEventLabel={cardData.timelineEventLabel}
                loadingMessages={loadingMessages}
                hasMoreOlder={hasMoreOlder}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlderMessages}
                hoveringTop={hoveringTop}
                setHoveringTop={setHoveringTop}
                nearTopScroll={nearTopScroll}
                messagesScrollRef={messagesScrollRef}
                onMessagesScroll={handleMessagesScroll}
                conversationId={selectedConversation.conversation_id}
                actorUserId={user?.id}
                actorUserName={user?.name}
                assignedUserId={selectedConversation.assigned_user_id}
                assignedUserName={selectedConversation.assigned_user?.name}
                t={t}
                lang={i18n.language}
              />

              <InboxComposer
                mode={composerMode}
                setMode={setComposerMode}
                draft={draft}
                setDraft={setDraft}
                onKeyDown={handleComposerKeyDown}
                onSend={sendHumanReply}
                sending={sending}
                sendError={sendError}
                canSendHumanReply={canSendHumanReply}
                noticeText={composerNotice}
                attachment={attachment}
                onRemoveAttachment={removeAttachment}
                mediaControls={availableMediaControls}
                canSendMedia={canSendMedia}
                fileInputRefs={fileInputRefs}
                onMediaButtonClick={handleMediaButtonClick}
                onFileSelected={handleFileSelected}
                noteDraft={cardData.noteDraft}
                setNoteDraft={cardData.setNoteDraft}
                addingNote={cardData.addingNote}
                onAddNote={cardData.handleAddNote}
                notesError={cardData.notesError}
                t={t}
              />
            </>
          )}
        </section>

        {/* Conversation Card — persistent, collapsible column at xl+. */}
        {detailsOpen && (
          <aside className="hidden h-full min-h-0 min-w-0 flex-col border-s border-slate-200/80 xl:flex">
            {selectedConversation ? (
              <ConversationCard
                conv={selectedConversation}
                data={cardData}
                selectedLead={selectedLead}
                actorUserId={user?.id}
                multipleWhatsappNumbers={multipleWhatsappNumbers}
                variant="panel"
                onClose={() => setDetailsOpen(false)}
                isRtl={isRtl}
                t={t}
                lang={i18n.language}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-slate-400">{t("messagesPage.selectConversationPrompt")}</div>
            )}
          </aside>
        )}
      </div>

      {selectedConversation && (
        <ConversationCard
          conv={selectedConversation}
          data={cardData}
          selectedLead={selectedLead}
          actorUserId={user?.id}
          multipleWhatsappNumbers={multipleWhatsappNumbers}
          variant="drawer"
          open={cardOpen}
          onClose={() => setCardOpen(false)}
          isRtl={isRtl}
          t={t}
          lang={i18n.language}
        />
      )}
    </div>
  );
}
