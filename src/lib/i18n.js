import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "../locales/ar/translation.json";
import en from "../locales/en/translation.json";

// UI language only — completely separate from AI reply language, customer
// conversation language, welcome messages, Auto Reply content, or any
// other business/customer data. Never used to auto-translate that content.
//
// Resources are bundled directly (no i18next-http-backend) — this app is a
// single Vite SPA bundle, not a multi-locale-fetching site, so there's no
// benefit to a runtime fetch here. Actual language *resolution* (which of
// these two the current user/client should see) lives in
// src/context/LanguageContext.jsx, not here — this file only registers the
// two languages and wires react-i18next up; it does not decide who gets
// which one.
export const SUPPORTED_LANGUAGES = ["ar", "en"];
export const FALLBACK_LANGUAGE = "ar";

i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
    en: { translation: en },
  },
  lng: FALLBACK_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  interpolation: { escapeValue: false }, // React already escapes.
  returnEmptyString: false,
});

export default i18n;
