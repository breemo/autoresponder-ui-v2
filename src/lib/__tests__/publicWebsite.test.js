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

test("Login page itself is untouched by the public website", () => {
  const login = read("src/pages/Login.jsx");
  assert.ok(login.includes('navigate(user.role === "admin" ? "/admin" : "/client");'));
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
