import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOGIN_PATH,
  NAV_ITEMS,
  PUBLIC_HOME_PATH,
  SECTION_IDS,
  TRIAL_PATH,
  appHomePath,
} from "../publicSite.js";

// Public website entry: "/" = landing page, "/login" = existing Login,
// protected app unchanged (unauthenticated users go to Login).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const APP = read("src/App.jsx");
const LANDING = read("src/pages/public/LandingPage.jsx");
const TRIAL = read("src/pages/public/StartTrial.jsx");
const PREVIEWS = read("src/components/public/ProductPreviews.jsx");
const NAV = read("src/components/public/PublicNav.jsx");
const FOOTER = read("src/components/public/PublicFooter.jsx");
const LAYOUT = read("src/layouts/SharedDashboardLayout.jsx");
const VITE = read("vite.config.js");
const PUBLIC_SOURCES = [LANDING, TRIAL, PREVIEWS, NAV, FOOTER];

test("route contract: landing at /, Login at /login, trial placeholder", () => {
  assert.equal(PUBLIC_HOME_PATH, "/");
  assert.equal(LOGIN_PATH, "/login");
  assert.equal(TRIAL_PATH, "/start-trial");
  assert.ok(APP.includes("<Route path={PUBLIC_HOME_PATH} element={<LandingPage />} />"));
  assert.ok(APP.includes("<Route path={LOGIN_PATH} element={<Login />} />"));
  assert.ok(APP.includes("<Route path={TRIAL_PATH} element={<StartTrial />} />"));
  assert.equal(APP.includes('<Route path="/" element={<Login />} />'), false);
});

test("protected routes send unauthenticated users to Login, not the public site", () => {
  assert.equal((APP.match(/<Navigate to=\{LOGIN_PATH\} replace \/>/g) || []).length, 2);
  assert.equal(APP.includes('if (!user || user.role !== "admin") return <Navigate to="/" replace />;'), false);
  assert.equal(APP.includes('if (!user || user.role !== "client") return <Navigate to="/" replace />;'), false);
});

test("logout and the installed PWA land on Login", () => {
  assert.ok(LAYOUT.includes('navigate("/login");'));
  assert.ok(VITE.includes("start_url: '/login'"));
});

test("redesigned Login keeps the existing authentication flow", () => {
  const login = read("src/pages/Login.jsx");
  // Security C2: credentials are verified server-side; the browser never
  // queries `users` (and never filters on the password column) any more.
  assert.equal(/\.from\("users"\)/.test(login), false);
  assert.equal(/\.eq\("password"/.test(login), false);
  assert.ok(login.includes('fetch("/api/client-router?resource=login"'));
  assert.ok(login.includes("body: JSON.stringify({ email, password })"));
  // Same storage (sanitized, Security C1), session and destinations.
  assert.ok(login.includes("const storedUser = writeStoredUser(user);"));
  assert.ok(login.includes("writeSessionExpiry();"));
  assert.ok(login.includes("setUser(storedUser);"));
  assert.ok(login.includes('navigate(user.role === "admin" ? "/admin" : "/client");'));
  // Existing messages are reused for every server error code.
  for (const key of ["errorInvalidCredentials", "errorNoMembership", "errorAccountDisabled", "errorRateLimited", "errorGeneric"]) {
    assert.ok(login.includes(`"login.${key}"`), key);
  }
  // No registration / password-reset / Supabase Auth was introduced.
  assert.equal(/supabase\.auth|signUp|resetPassword|\.insert\(/.test(login), false);
});

test("Login links back to the public site and to the trial entry", () => {
  const login = read("src/pages/Login.jsx");
  assert.ok(login.includes("to={PUBLIC_HOME_PATH}"));
  assert.ok(login.includes("to={TRIAL_PATH}"));
  assert.ok(login.includes('autoComplete="email"'));
  assert.ok(login.includes('autoComplete="current-password"'));
  for (const lng of ["en", "ar"]) {
    const keys = JSON.parse(read(`src/locales/${lng}/translation.json`)).login;
    for (const k of ["welcomeTitle", "welcomeSubtitle", "emailLabel", "passwordLabel", "newHere", "startTrial", "backToHome", "errorGeneric"]) {
      assert.ok(keys[k], `${lng}.login.${k}`);
    }
  }
});

test("appHomePath routes signed-in users to their portal", () => {
  assert.equal(appHomePath(null), null);
  assert.equal(appHomePath({ role: "admin" }), "/admin");
  assert.equal(appHomePath({ role: "client" }), "/client");
  assert.equal(appHomePath({ role: "other" }), null);
});

test("every navigation section exists on the landing page", () => {
  const sections = NAV_ITEMS.flatMap((i) => (i.children ? i.children : [i])).map((i) => i.section);
  for (const s of sections) assert.ok(Object.values(SECTION_IDS).includes(s), s);
  for (const key of Object.keys(SECTION_IDS)) {
    assert.ok(LANDING.includes(`SECTION_IDS.${key}`), `landing renders section ${key}`);
  }
});

test("public pages are static: no Supabase, no API calls, no forms", () => {
  for (const src of PUBLIC_SOURCES) {
    assert.equal(/supabase/i.test(src), false);
    assert.equal(/\bfetch\(/.test(src), false);
    assert.equal(/<form\b/.test(src), false);
  }
});

test("no fabricated commercial claims: no prices, testimonials or social profiles", () => {
  for (const src of PUBLIC_SOURCES) {
    assert.equal(/\$\s?\d/.test(src), false, "no hard-coded prices");
    assert.equal(/testimonial/i.test(src), false);
    assert.equal(/(twitter|x\.com|linkedin|facebook\.com|instagram\.com|youtube)/i.test(src), false);
  }
  assert.ok(PREVIEWS.includes("sample data"));
  assert.ok(LANDING.includes("Live Monitoring is coming soon."));
});

test("trial CTAs never imply self-service sign-up works (not implemented yet)", () => {
  const site = read("src/lib/publicSite.js");
  assert.match(site, /export const TRIAL_CTA_LABEL = "Free Trial — Coming Soon";/);
  for (const src of [LANDING, NAV, FOOTER, TRIAL]) {
    assert.equal(/Start Free Trial|Start your \S+ free trial|shown when you sign up|Try the (AI Agent|shared inbox)|Start capturing leads/.test(src), false);
    // every trial link still goes to the coming-soon page, never to a form/API
    assert.equal(/fetch\(|supabase|<form/.test(src), false);
  }
  assert.ok(TRIAL.includes("is not available yet"));
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  assert.match(en.login.startTrial, /coming soon/i);
  assert.match(ar.login.startTrial, /قريباً/);
});

test("language context follows the live i18next language (no stale label/dir after a signed-out switch)", () => {
  const ctx = read("src/context/LanguageContext.jsx");
  assert.ok(ctx.includes('i18n.on("languageChanged", onChange);'));
  assert.ok(ctx.includes('i18n.off("languageChanged", onChange)'));
  assert.ok(ctx.includes("language: activeLanguage,"));
  assert.ok(ctx.includes('isRtl: activeLanguage !== "en",'));
  const login = read("src/pages/Login.jsx");
  assert.ok(login.includes('{lang?.language === "ar" ? "English" : "العربية"}'));
  assert.ok(login.includes('dir={isRtl ? "rtl" : "ltr"}'));
});

test('public website and auth copy never say "AI Assistant"', () => {
  for (const src of [...PUBLIC_SOURCES, read("src/pages/Login.jsx")]) {
    assert.equal(/ai assistant/i.test(src), false);
  }
  for (const lng of ["en", "ar"]) {
    const login = JSON.stringify(JSON.parse(read(`src/locales/${lng}/translation.json`)).login);
    assert.equal(/ai assistant/i.test(login), false);
  }
});
