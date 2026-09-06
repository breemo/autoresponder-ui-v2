// One place that decides how a conversation's customer is labelled, so the
// left Conversations list and the selected-conversation header never
// disagree.
//
// Conversation V2 identity: `customer_name` on a list row is the resolved
// contact / channel-profile / lead name (WhatsApp pushName, Telegram
// first_name, a Meta-permitted Facebook/Instagram Graph name, a captured
// lead name) — or null when none was ever captured. `sender_id` is the raw
// provider id / phone number and is ALWAYS available: it is the fallback
// when there is no name, and the secondary line (under the name) when
// there is one. The phone number / id must never disappear.
//
// selectedLeadName: the header can pass a freshly-fetched lead name (from
// its own /leads query) so a name captured mid-conversation shows before
// the next list poll.
export function getConversationIdentity(conv, { selectedLeadName } = {}) {
  const name = String(selectedLeadName || conv?.customer_name || conv?.lead_name || "").trim();
  const senderId = String(conv?.sender_id || conv?.sender || "").trim();
  const platform = String(conv?.channel || conv?.platform || "").toLowerCase();

  if (name) {
    return { primary: name, secondary: senderId, hasName: true, senderId, platform };
  }
  return { primary: senderId, secondary: "", hasName: false, senderId, platform };
}
