import { useEffect, useRef, useState } from "react";

// Conversation Card V1 data (lifecycle/context + internal notes), lifted out
// of the card component so ONE instance serves the desktop panel, the
// tablet/mobile drawer and the composer's Internal Note tab. The fetch and
// the note add/edit/delete handlers are unchanged from the previous
// ConversationCard; the only difference is that a single instance replaces
// the two (panel + drawer) that previously each fetched on their own.
//
// `enabled`: fetch only while some surface actually needs the data. Loaded
// once per conversation (loadedForRef) — toggling visibility alone never
// refetches or clears it, so an unsaved note draft survives collapsing or
// closing the panel. Switching conversations resets everything (as before).
export default function useConversationCard({ conversationId, actorUserId, enabled, t }) {
  const [card, setCard] = useState(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState("");

  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");

  const [noteDraft, setNoteDraft] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingNoteId, setSavingNoteId] = useState(null);
  const [deletingNoteId, setDeletingNoteId] = useState(null);

  const loadedForRef = useRef(null);
  const resetForRef = useRef(null);

  useEffect(() => {
    if (!conversationId || !actorUserId) {
      setCard(null);
      setNotes([]);
      loadedForRef.current = null;
      resetForRef.current = null;
      return undefined;
    }

    // Display state resets immediately on every conversation change, even
    // while nothing needs the data yet, so nothing stale can flash later.
    if (resetForRef.current !== conversationId) {
      resetForRef.current = conversationId;
      setCard(null);
      setCardError("");
      setNotes([]);
      setNotesError("");
      setNoteDraft("");
      setEditingNoteId(null);
      setCardLoading(false);
      setNotesLoading(false);
    }

    if (!enabled || loadedForRef.current === conversationId) return undefined;

    let cancelled = false;
    let inFlight = 2;
    const settle = () => {
      inFlight -= 1;
    };
    loadedForRef.current = conversationId;
    setCardLoading(true);
    setNotesLoading(true);

    const qs = `actor_user_id=${encodeURIComponent(actorUserId)}&conversation_id=${encodeURIComponent(conversationId)}`;

    fetch(`/api/conversation?${qs}`)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return;
        if (!data?.success) throw new Error(data?.message || t("conversationCard.loadFailed"));
        setCard(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setCardError(err.message || t("conversationCard.loadFailed"));
      })
      .finally(() => {
        settle();
        if (!cancelled) setCardLoading(false);
      });

    fetch(`/api/conversation?resource=notes&${qs}`)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return;
        if (!data?.success) throw new Error(data?.message || t("conversationCard.notesLoadFailed"));
        setNotes(data.notes || []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setNotesError(err.message || t("conversationCard.notesLoadFailed"));
      })
      .finally(() => {
        settle();
        if (!cancelled) setNotesLoading(false);
      });

    return () => {
      cancelled = true;
      // Interrupted mid-flight (e.g. switched away): allow a later reload.
      // A completed load is kept, so visibility toggles never refetch.
      if (inFlight > 0 && loadedForRef.current === conversationId) loadedForRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, actorUserId, enabled]);

  async function handleAddNote() {
    const body = noteDraft.trim();
    if (!body || addingNote) return;

    setAddingNote(true);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_note", actor_user_id: actorUserId, conversation_id: conversationId, body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteAddFailed"));
      setNotes((prev) => [data.note, ...prev]);
      setNoteDraft("");
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteAddFailed"));
    } finally {
      setAddingNote(false);
    }
  }

  function startEditNote(note) {
    setEditingNoteId(note.id);
    setEditingBody(note.body);
  }

  function cancelEditNote() {
    setEditingNoteId(null);
    setEditingBody("");
  }

  async function saveEditNote(noteId) {
    const body = editingBody.trim();
    if (!body || savingNoteId) return;

    setSavingNoteId(noteId);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit_note", actor_user_id: actorUserId, note_id: noteId, body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteEditFailed"));
      setNotes((prev) => prev.map((n) => (n.id === noteId ? data.note : n)));
      cancelEditNote();
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteEditFailed"));
    } finally {
      setSavingNoteId(null);
    }
  }

  async function deleteNote(noteId) {
    if (deletingNoteId || !window.confirm(t("conversationCard.confirmDeleteNote"))) return;

    setDeletingNoteId(noteId);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_note", actor_user_id: actorUserId, note_id: noteId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteDeleteFailed"));
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteDeleteFailed"));
    } finally {
      setDeletingNoteId(null);
    }
  }

  function timelineEventLabel(event) {
    const actor = event.actor_user?.name || t("roles.agent");
    const target = event.target_user?.name || t("roles.agent");
    const translated = t(`conversationCard.event.${event.event_type}`, { actor, target, defaultValue: "" });
    return translated || event.event_type;
  }

  return {
    card,
    cardLoading,
    cardError,
    notes,
    notesLoading,
    notesError,
    noteDraft,
    setNoteDraft,
    addingNote,
    handleAddNote,
    editingNoteId,
    editingBody,
    setEditingBody,
    startEditNote,
    cancelEditNote,
    saveEditNote,
    savingNoteId,
    deleteNote,
    deletingNoteId,
    timelineEventLabel,
  };
}
