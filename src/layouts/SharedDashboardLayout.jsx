import React, { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLanguage } from "../context/LanguageContext.jsx";
import {
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  HomeIcon,
  PuzzlePieceIcon,
  Squares2X2Icon,
  UserCircleIcon,
  UserGroupIcon,
  UsersIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../context/AuthContext.jsx";
import { PERMISSIONS, hasUserPermission } from "../lib/permissions.js";
import { clearSessionExpiry } from "../lib/session.js";
import SubscriptionBanner from "../components/SubscriptionBanner.jsx";
import RouteErrorBoundary from "../components/RouteErrorBoundary.jsx";

// label/description are translation keys, not literal text — resolved via
// t() at render time (see the nav loop below) so the sidebar follows the
// active UI language. Routes/icons/permissions are structural and don't
// change with language.
const adminItems = [
  { to: "/admin", labelKey: "navigation.overview", descKey: "navigation.descriptions.overviewAdmin", icon: HomeIcon, end: true },
  { to: "/admin/clients", labelKey: "navigation.clients", descKey: "navigation.descriptions.clients", icon: UsersIcon },
  { to: "/admin/messages", labelKey: "navigation.messages", descKey: "navigation.descriptions.messages", icon: ChatBubbleLeftRightIcon },
  { to: "/admin/auto-replies", labelKey: "navigation.autoReplies", descKey: "navigation.descriptions.autoReplies", icon: BoltIcon },
  { to: "/admin/plans", labelKey: "navigation.plans", descKey: "navigation.descriptions.plans", icon: CreditCardIcon },
  { to: "/admin/features", labelKey: "navigation.features", descKey: "navigation.descriptions.features", icon: PuzzlePieceIcon },
  { to: "/admin/settings", labelKey: "navigation.settings", descKey: "navigation.descriptions.settings", icon: Cog6ToothIcon },
];

const clientItems = [
  { to: "/client", labelKey: "navigation.overview", descKey: "navigation.descriptions.overviewClient", icon: HomeIcon, end: true, permission: PERMISSIONS.DASHBOARD },
  { to: "/client/messages", labelKey: "navigation.conversations", descKey: "navigation.descriptions.conversations", icon: ChatBubbleLeftRightIcon, permission: PERMISSIONS.INBOX },
  { to: "/client/leads", labelKey: "navigation.leads", descKey: "navigation.descriptions.leads", icon: ChartBarIcon, permission: PERMISSIONS.LEADS },
  { to: "/client/auto-replies", labelKey: "navigation.autoReplies", descKey: "navigation.descriptions.autoReplies", icon: BoltIcon, permission: PERMISSIONS.AUTO_REPLIES },
  { to: "/client/quick-replies", labelKey: "navigation.quickReplies", descKey: "navigation.descriptions.quickReplies", icon: ChatBubbleOvalLeftEllipsisIcon, permission: PERMISSIONS.AUTO_REPLIES },
  { to: "/client/integrations", labelKey: "navigation.integrations", descKey: "navigation.descriptions.integrations", icon: Squares2X2Icon, permission: PERMISSIONS.INTEGRATIONS },
  { to: "/client/feature-settings", labelKey: "navigation.featureSettings", descKey: "navigation.descriptions.featureSettings", icon: PuzzlePieceIcon, permission: PERMISSIONS.AI_SETTINGS },
  { to: "/client/team", labelKey: "navigation.team", descKey: "navigation.descriptions.team", icon: UserGroupIcon, permission: PERMISSIONS.TEAM_MANAGEMENT },
  { to: "/client/settings", labelKey: "navigation.settings", descKey: "navigation.descriptions.settings", icon: Cog6ToothIcon, permission: PERMISSIONS.SETTINGS },
  { to: "/client/account", labelKey: "navigation.myAccount", descKey: "navigation.descriptions.myAccount", icon: UserCircleIcon },
];

const PAGE_TITLE_KEYS = {
  "/admin": "pageTitles.admin.overview",
  "/admin/clients": "pageTitles.admin.clients",
  "/admin/messages": "pageTitles.admin.messages",
  "/admin/auto-replies": "pageTitles.admin.autoReplies",
  "/admin/plans": "pageTitles.admin.plans",
  "/admin/features": "pageTitles.admin.features",
  "/admin/settings": "pageTitles.admin.settings",
  "/client": "pageTitles.client.overview",
  "/client/messages": "pageTitles.client.messages",
  "/client/leads": "pageTitles.client.leads",
  "/client/auto-replies": "pageTitles.client.autoReplies",
  "/client/quick-replies": "pageTitles.client.quickReplies",
  "/client/integrations": "pageTitles.client.integrations",
  "/client/feature-settings": "pageTitles.client.featureSettings",
  "/client/team": "pageTitles.client.team",
  "/client/settings": "pageTitles.client.settings",
  "/client/account": "pageTitles.client.account",
};

// Returns [title, subtitle] resolved from the translation resources for
// the current pathname/panel — same lookup shape as before, just sourced
// from t() instead of a hardcoded object.
function getPageMeta(t, pathname, panel) {
  if (PAGE_TITLE_KEYS[pathname]) return t(PAGE_TITLE_KEYS[pathname], { returnObjects: true });
  if (pathname.startsWith("/admin/client/")) return t("pageTitles.fallback.adminClientDetail", { returnObjects: true });
  if (pathname.startsWith("/admin/plan-features/")) return t("pageTitles.fallback.planFeatures", { returnObjects: true });
  return t(panel === "admin" ? "pageTitles.fallback.adminPanel" : "pageTitles.fallback.clientPanel", { returnObjects: true });
}

// Pages listed here get a viewport-bound height (instead of the default
// natural page scroll) so they can manage their own internal scroll areas
// (e.g. the Inbox's conversation list / message pane). Opt-in by route only
// — every other page keeps the existing scroll behavior untouched.
const FULL_HEIGHT_ROUTES = ["/client/messages", "/admin/messages"];

export default function SharedDashboardLayout({ children, panel = "client" }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  // Personal UI language toggle (client portal only — see the header
  // button below). Reuses LanguageContext's existing setUserLanguage,
  // the same centralized function My Account uses, so this is the one
  // and only place personal-language persistence logic lives. It writes
  // client_users.language exclusively — never clients.default_language.
  const { language, setUserLanguage, isRtl } = useLanguage();
  const [switchingLanguage, setSwitchingLanguage] = useState(false);
  // Mobile/tablet drawer nav (below the lg breakpoint the sidebar is
  // off-canvas by default — see the <aside> below). Desktop is unaffected;
  // this state simply never gets read there.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isAdmin = panel === "admin";
  // Admin nav is unfiltered (unchanged). Client nav items with a
  // `permission` are hidden for members who don't have it — this is
  // presentation only, the actual enforcement is the route guard in
  // App.jsx (a hidden link is not a security boundary by itself). While a
  // mandatory password change is pending, every other item collapses away
  // so the sidebar doesn't show links that would just redirect back.
  const navItems = isAdmin
    ? adminItems
    : user?.must_change_password
    ? clientItems.filter((item) => item.to === "/client/account")
    : clientItems.filter((item) => !item.permission || hasUserPermission(user, item.permission));
  const displayName = user?.business_name || user?.name || (isAdmin ? "Admin" : "Client");
  const [title, subtitle] = getPageMeta(t, location.pathname, panel);
  const fullHeight = FULL_HEIGHT_ROUTES.includes(location.pathname);

  // Navigating anywhere should close a currently-open mobile drawer rather
  // than leaving it open over the newly-loaded page.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  function logout() {
    localStorage.removeItem("user");
    clearSessionExpiry();
    setUser(null);
    navigate("/");
  }

  async function toggleLanguage() {
    if (switchingLanguage) return;
    setSwitchingLanguage(true);
    await setUserLanguage(language === "en" ? "ar" : "en");
    setSwitchingLanguage(false);
  }

  return (
    <div className={`bg-[#F5F7FB] text-slate-900 ${fullHeight ? "h-screen overflow-hidden" : "min-h-screen"}`}>
      {/* Mobile/tablet drawer backdrop. lg:hidden is a belt-and-suspenders
          guard — the trigger button that sets mobileNavOpen is itself
          lg:hidden, so this should never render at lg+ in practice. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* start-0 / border-e (logical) instead of left-0 / border-r
          (physical): in LTR that resolves to left/right exactly as
          before; in RTL it resolves to right/left, so the sidebar sits on
          the right with its divider on its left — no JS direction checks
          needed for POSITION, this follows the document's dir
          automatically.
          Below lg the sidebar is a fixed drawer, translated fully
          off-canvas (off the start edge) until mobileNavOpen; at lg+ it's
          always in place (lg:translate-x-0), matching the original
          always-visible desktop sidebar exactly.
          The off-canvas TRANSFORM direction, unlike position/border above,
          is resolved in JS via isRtl rather than Tailwind's rtl: variant:
          Tailwind compiles rtl: variants to rules placed AFTER the lg:
          breakpoint block in the stylesheet, so at equal specificity
          `rtl:translate-x-full` was winning over `lg:translate-x-0` by
          plain source order — permanently hiding the sidebar off-canvas
          for Arabic at every viewport width, including desktop. Computing
          the closed-state class in JS means only one base transform class
          is ever present, so lg: reliably overrides it at lg+ exactly as
          it does for English. */}
      <aside
        className={`fixed start-0 top-0 z-50 flex h-screen w-72 flex-col border-e border-slate-800/80 bg-[#0F172A] text-slate-100 transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : isRtl ? "translate-x-full" : "-translate-x-full"
        }`}
      >
        <div className="flex h-20 items-center gap-3 border-b border-slate-800 px-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-950/30">
            <ChatBubbleLeftRightIcon className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">{t("brand.name")}</h1>
            <p className="truncate text-xs text-slate-400">{isAdmin ? t("brand.adminConsole") : t("brand.clientWorkspace")}</p>
          </div>
          {/* Close affordance for the mobile drawer only — the desktop
              sidebar has nothing to "close", it's simply always visible. */}
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="shrink-0 rounded-xl p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white lg:hidden"
            aria-label={t("common.closeMenu")}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-slate-800 px-5 py-4">
          <div className="rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/5">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{t("brand.workspace")}</p>
            <p className="mt-2 truncate text-sm font-semibold text-white">{displayName}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{user?.email || t("brand.fallbackDomain")}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `group flex items-center gap-3 rounded-2xl px-3 py-3 text-sm transition-all duration-200 ${
                    isActive
                      ? "bg-white text-slate-950 shadow-sm"
                      : "text-slate-400 hover:bg-slate-800/80 hover:text-white"
                  }`
                }
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-300 transition group-hover:bg-slate-700 group-hover:text-white">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium leading-5">{t(item.labelKey)}</span>
                  <span className="block truncate text-xs text-slate-500 group-hover:text-slate-300">{t(item.descKey)}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <button
            onClick={logout}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-200"
          >
            <ArrowRightOnRectangleIcon className="h-5 w-5" />
            {t("auth.logout")}
          </button>
        </div>
      </aside>

      <div className={`lg:ps-72 ${fullHeight ? "flex h-full flex-col" : ""}`}>
        <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur-xl">
          <div className="flex min-h-20 items-center justify-between gap-4 px-5 py-4 md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              {/* Mobile/tablet nav trigger — hidden at lg+ where the
                  sidebar is already always visible. */}
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 lg:hidden"
                aria-label={t("common.openMenu")}
              >
                <Bars3Icon className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-indigo-600">
                  {isAdmin ? t("portal.admin") : t("portal.client")}
                </p>
                <h2 className="mt-1 truncate text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
                <p className="mt-1 truncate text-sm text-slate-500">{subtitle}</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              {/* Personal UI language toggle — client portal only. One
                  click swaps ar<->en via LanguageContext's setUserLanguage,
                  the same centralized persistence function My Account uses
                  (writes client_users.language, never clients.default_language).
                  Admin has no switcher here — Login.jsx never fetches
                  ui_language_* for admin accounts, so admin always renders
                  the 'ar' fallback regardless. */}
              {!isAdmin && (
                <button
                  type="button"
                  onClick={toggleLanguage}
                  disabled={switchingLanguage}
                  title={t("common.switchLanguage")}
                  aria-label={t("common.switchLanguage")}
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span aria-hidden="true">🌐</span>
                  <span>{language === "en" ? "عربي" : "EN"}</span>
                </button>
              )}

              <div className="hidden items-center gap-3 md:flex">
                <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 shadow-sm">
                  {t("auth.greeting", { name: "" })}
                  <span className="font-semibold text-slate-800">{displayName}</span>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-600 ring-1 ring-indigo-100">
                  {(displayName || "A").slice(0, 1).toUpperCase()}
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className={fullHeight ? "flex min-h-0 flex-1 flex-col px-4 py-5 md:px-6 lg:px-8 lg:py-6" : "min-h-[calc(100vh-5rem)] px-4 py-5 md:px-6 lg:px-8 lg:py-6"}>
          <div className={`mx-auto w-full max-w-[1800px] animate-[fadeIn_.2s_ease-out] ${fullHeight ? "flex min-h-0 flex-1 flex-col" : ""}`}>
            {!isAdmin && <SubscriptionBanner />}
            {/* key={location.pathname} resets the boundary's error state on
                navigation, so a crash on one page doesn't stick around after
                the user moves to a different route. */}
            <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
