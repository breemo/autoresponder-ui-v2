// Website Chat MVP limits (approved decision D3). Kept in code — no env
// vars / DB settings — so they are easy to change in one place.
export const WEBSITE_CHAT_LIMITS = Object.freeze({
  SESSIONS_PER_IP_PER_SITE: 20, // new visitor sessions ...
  SESSION_WINDOW_SECONDS: 600, //  ... per 10 minutes, per IP hash, per website
  MESSAGES_PER_MINUTE_PER_VISITOR: 10,
  MESSAGES_PER_DAY_PER_VISITOR: 150,
  MESSAGES_PER_HOUR_PER_CLIENT: 1000,
  POLLS_PER_MINUTE_PER_VISITOR: 60,
  MESSAGE_MIN_LENGTH: 1,
  MESSAGE_MAX_LENGTH: 2000,
  MAX_ALLOWED_DOMAINS: 10,
  TOKEN_TTL_DAYS: 30, // sliding: re-issued on every session call
  MESSAGES_PAGE_LIMIT: 50,
  POLL_AFTER_MS: 3000,
});
