import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import i18n, { SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE } from "../lib/i18n.js";
import { useAuth } from "./AuthContext.jsx";
import { supabase } from "../lib/supabaseClient";

export const LanguageContext = createContext(null);
export function useLanguage() {
  return useContext(LanguageContext);
}

// UX-only local cache — NOT the source of truth. Used only (a) before a
// user has ever logged in / while the account's DB values aren't known
// yet, and (b) as a fallback if a DB write fails (e.g. the language
// migration hasn't been applied to this environment yet), so switching the
// language still visibly works for the current browser even when it can't
// be persisted server-side yet.
const LOCAL_CACHE_KEY = "ui_language_cache";

function readLocalCache() {
  try {
    const cached = localStorage.getItem(LOCAL_CACHE_KEY);
    return SUPPORTED_LANGUAGES.includes(cached) ? cached : null;
  } catch {
    return null;
  }
}

function writeLocalCache(lang) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, lang);
  } catch {
    // Best-effort only.
  }
}

function applyDocumentDirection(lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
}

// Resolution order (per the multilingual foundation spec):
//   1. The user's own personal preference (client_users.language), if set.
//   2. The client's default_language, if set.
//   3. System fallback = ar.
// Both DB-backed values are attached to the stored `user` object at login
// (see Login.jsx's best-effort language fetch) as `ui_language_user` /
// `ui_language_client` — read-only mirrors of the DB columns, not a
// separate source of truth. If neither is available (no user yet, or the
// migration hasn't been applied so both stayed null), falls through to the
// local cache, then the hard system fallback.
function resolveLanguage(user) {
  if (user?.ui_language_user && SUPPORTED_LANGUAGES.includes(user.ui_language_user)) {
    return user.ui_language_user;
  }
  if (user?.ui_language_client && SUPPORTED_LANGUAGES.includes(user.ui_language_client)) {
    return user.ui_language_client;
  }
  const cached = readLocalCache();
  if (cached) return cached;
  return FALLBACK_LANGUAGE;
}

export function LanguageProvider({ children }) {
  const auth = useAuth();
  const user = auth?.user;

  const resolved = resolveLanguage(user);

  useEffect(() => {
    if (i18n.language !== resolved) i18n.changeLanguage(resolved);
    applyDocumentDirection(resolved);
    writeLocalCache(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  // Changes the CURRENT USER's own preference (My Account page). Applied
  // to the live UI immediately regardless of whether the DB write
  // succeeds — the database is the source of truth when reachable, but a
  // not-yet-applied migration must never block the language from actually
  // switching for the person using it right now.
  const setUserLanguage = useCallback(
    async (lang) => {
      if (!SUPPORTED_LANGUAGES.includes(lang)) return { success: false };

      i18n.changeLanguage(lang);
      applyDocumentDirection(lang);
      writeLocalCache(lang);

      if (!user?.id) return { success: false, persisted: false };

      // Admin accounts have no client_users row at all (see Login.jsx —
      // the client_users membership lookup, and this same ui_language_user
      // fetch, only ever run for role === "client"), so there is no DB row
      // for the write below to ever match. Rather than issue a request
      // that's silently a no-op against the wrong table, stop here: the
      // language has already changed live (i18n.changeLanguage above) and
      // is already cached (writeLocalCache above, plus mirrored onto the
      // stored user object here) — same local persistence the anonymous/
      // pre-login state already relies on (see readLocalCache/
      // LOCAL_CACHE_KEY), just also attached to this account's cached
      // user object so resolveLanguage picks it up first on the next load
      // without a network round trip. No new DB column, no migration —
      // this is the existing frontend persistence mechanism, reused as-is.
      if (user.role !== "client") {
        const updatedUser = { ...user, ui_language_user: lang };
        localStorage.setItem("user", JSON.stringify(updatedUser));
        auth?.setUser?.(updatedUser);
        return { success: true, persisted: false };
      }

      try {
        const { error } = await supabase.from("client_users").update({ language: lang }).eq("user_id", user.id);
        if (error) throw error;

        const updatedUser = { ...user, ui_language_user: lang };
        localStorage.setItem("user", JSON.stringify(updatedUser));
        auth?.setUser?.(updatedUser);
        return { success: true, persisted: true };
      } catch (err) {
        console.error("Failed to persist user language preference (column may not exist yet):", err);
        return { success: true, persisted: false };
      }
    },
    [user, auth]
  );

  // Clears the user's own preference so they fall back to the client
  // default again.
  const clearUserLanguage = useCallback(async () => {
    if (!user?.id) return { success: false };

    try {
      const { error } = await supabase.from("client_users").update({ language: null }).eq("user_id", user.id);
      if (error) throw error;

      const updatedUser = { ...user, ui_language_user: null };
      localStorage.setItem("user", JSON.stringify(updatedUser));
      auth?.setUser?.(updatedUser);

      const next = resolveLanguage(updatedUser);
      i18n.changeLanguage(next);
      applyDocumentDirection(next);
      writeLocalCache(next);
      return { success: true, persisted: true };
    } catch (err) {
      console.error("Failed to clear user language preference:", err);
      return { success: false };
    }
  }, [user, auth]);

  // Changes the CLIENT's default language (Settings page — affects any
  // teammate without their own personal preference). Permission gating
  // (settings permission / owner) stays in the calling page, same as every
  // other client-settings mutation in this app.
  const setClientDefaultLanguage = useCallback(
    async (lang) => {
      if (!SUPPORTED_LANGUAGES.includes(lang) || !user?.client_id) return { success: false };

      try {
        const { error } = await supabase.from("clients").update({ default_language: lang }).eq("id", user.client_id);
        if (error) throw error;

        const updatedUser = { ...user, ui_language_client: lang };
        localStorage.setItem("user", JSON.stringify(updatedUser));
        auth?.setUser?.(updatedUser);

        // Only the current tab's live language changes if this user has no
        // personal override — otherwise their own preference still wins,
        // matching the resolution order.
        if (!user.ui_language_user) {
          i18n.changeLanguage(lang);
          applyDocumentDirection(lang);
          writeLocalCache(lang);
        }
        return { success: true, persisted: true };
      } catch (err) {
        console.error("Failed to persist client default language (column may not exist yet):", err);
        return { success: false, persisted: false };
      }
    },
    [user, auth]
  );

  const value = useMemo(
    () => ({
      language: resolved,
      supportedLanguages: SUPPORTED_LANGUAGES,
      isRtl: resolved !== "en",
      setUserLanguage,
      clearUserLanguage,
      setClientDefaultLanguage,
    }),
    [resolved, setUserLanguage, clearUserLanguage, setClientDefaultLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
