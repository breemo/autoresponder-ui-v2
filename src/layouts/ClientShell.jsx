import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  BoltIcon,
  ChartPieIcon,
  ChatBubbleLeftRightIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  HomeIcon,
  Squares2X2Icon,
  UserCircleIcon,
  UserGroupIcon,
  UsersIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../context/AuthContext.jsx";
import { useLanguage } from "../context/LanguageContext.jsx";
import { clearSessionExpiry } from "../lib/session.js";
import {
  activeNavKey,
  pageTitleKey,
  pageWidthFor,
  readSidebarPinned,
  visibleClientNav,
  visibleUserMenu,
  writeSidebarPinned,
} from "../lib/clientNav.js";
import SubscriptionBanner from "../components/SubscriptionBanner.jsx";
import RouteErrorBoundary from "../components/RouteErrorBoundary.jsx";
import { BrandMark } from "../components/public/Brand.jsx";
import PageContainer from "../components/app/PageContainer.jsx";
import { Avatar, Tooltip, cx } from "../components/app/primitives.jsx";

// Client Portal shell (client-only). The Admin Portal keeps
// SharedDashboardLayout unchanged.
//
// Desktop (>= xl / 1280px): compact 72px icon rail, expandable to 240px.
//   >= 1536px: the expanded state pushes content and is remembered per device.
//   1280–1535px: starts collapsed; expanding is a temporary overlay so the
//   workspace (notably the Inbox) keeps its width.
// Below xl: off-canvas drawer behind a hamburger — the same xl threshold the
// Inbox's own tablet/desktop tiers are coordinated with.

const NAV_ICONS = {
  home: HomeIcon,
  inbox: ChatBubbleLeftRightIcon,
  leads: UsersIcon,
  replies: BoltIcon,
  aiAgent: CpuChipIcon,
  integrations: Squares2X2Icon,
  team: UserGroupIcon,
  settings: Cog6ToothIcon,
  myAccount: UserCircleIcon,
  myPerformance: ChartPieIcon,
};

function useMediaQuery(query) {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

function UserMenu({ user, displayName, items, onLogout, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("shell.userMenu")}
        className="flex items-center gap-2 rounded-xl py-1 ps-1 pe-1.5 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 md:pe-2"
      >
        <Avatar name={displayName} className="h-8 w-8 text-xs" />
        <span className="hidden max-w-[160px] truncate text-sm font-medium text-slate-700 md:block">{displayName}</span>
        <ChevronDownIcon className={cx("hidden h-4 w-4 text-slate-400 transition md:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute end-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-slate-900">{displayName}</p>
            {user?.email && (
              <p className="truncate text-xs text-slate-500" dir="ltr">
                {user.email}
              </p>
            )}
          </div>
          <div className="my-1 h-px bg-slate-100" />
          {items.map((item) => {
            const Icon = NAV_ICONS[item.key];
            return (
              <Link
                key={item.key}
                to={item.to}
                role="menuitem"
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
              >
                <Icon className="h-[18px] w-[18px] text-slate-400" />
                {t(`shell.nav.${item.key}`)}
              </Link>
            );
          })}
          <div className="my-1 h-px bg-slate-100" />
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-rose-600 transition hover:bg-rose-50"
          >
            <ArrowRightOnRectangleIcon className="h-[18px] w-[18px]" />
            {t("auth.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ClientShell({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { language, setUserLanguage, isRtl } = useLanguage();

  const isDesktop = useMediaQuery("(min-width: 1280px)");
  const isWide = useMediaQuery("(min-width: 1536px)");
  const [pinned, setPinned] = useState(readSidebarPinned);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [switchingLanguage, setSwitchingLanguage] = useState(false);

  const expanded = isDesktop && (isWide ? pinned : overlayOpen);
  const showLabels = !isDesktop || expanded;
  const pushContent = isDesktop && isWide && pinned;

  const navItems = visibleClientNav(user);
  const userMenuItems = visibleUserMenu(user);
  const activeKey = activeNavKey(location.pathname, navItems);
  const activeGroup = navItems.find((item) => item.key === activeKey && item.tabs && item.tabs.length > 1);
  const width = pageWidthFor(location.pathname);
  const fullHeight = width === "full";
  const title = t(pageTitleKey(location.pathname));
  const displayName = user?.business_name || user?.name || user?.email || "Client";

  // Transient UI closes on navigation.
  useEffect(() => {
    setMobileNavOpen(false);
    setOverlayOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen && !overlayOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setMobileNavOpen(false);
        setOverlayOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen, overlayOpen]);

  function toggleRail() {
    if (isWide) {
      const next = !pinned;
      setPinned(next);
      writeSidebarPinned(next);
    } else {
      setOverlayOpen((v) => !v);
    }
  }

  // Same behavior as the previous shell.
  function logout() {
    localStorage.removeItem("user");
    clearSessionExpiry();
    setUser(null);
    navigate("/login");
  }

  async function toggleLanguage() {
    if (switchingLanguage) return;
    setSwitchingLanguage(true);
    await setUserLanguage(language === "en" ? "ar" : "en");
    setSwitchingLanguage(false);
  }

  // Direction-aware chevrons computed in JS (expanded -> points to the start
  // edge, i.e. "collapse"; collapsed -> points to the end edge).
  const CollapseIcon = expanded === !isRtl ? ChevronDoubleLeftIcon : ChevronDoubleRightIcon;

  return (
    <div className={cx("bg-[#F5F7FB] text-slate-900", fullHeight ? "h-app-viewport overflow-hidden" : "min-h-screen")}>
      {mobileNavOpen && <div className="fixed inset-0 z-40 bg-slate-950/40 xl:hidden" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}
      {overlayOpen && !isWide && (
        <div className="fixed inset-0 z-40 hidden bg-slate-950/10 xl:block" onClick={() => setOverlayOpen(false)} aria-hidden="true" />
      )}

      {/* start-0 / border-e (logical) position the rail on the right in RTL.
          The off-canvas TRANSFORM below xl is computed in JS from isRtl (not
          Tailwind's rtl: variant): rtl: rules are emitted after the xl:
          block, so `rtl:translate-x-full` would beat `xl:translate-x-0` and
          hide the sidebar on desktop in Arabic — the bug fixed earlier in
          SharedDashboardLayout. */}
      <aside
        aria-label={t("shell.mainNav")}
        className={cx(
          "fixed start-0 top-0 z-50 flex h-app-viewport w-64 flex-col border-e border-slate-200/80 bg-white transition-[transform,width] duration-200 ease-out xl:translate-x-0",
          expanded ? "xl:w-60" : "xl:w-[72px]",
          mobileNavOpen ? "translate-x-0" : isRtl ? "translate-x-full" : "-translate-x-full",
          (mobileNavOpen || (overlayOpen && !isWide)) && "shadow-2xl shadow-slate-900/10"
        )}
      >
        <div className={cx("flex min-h-14 shrink-0 items-center gap-2.5 border-b border-slate-100 pt-[env(safe-area-inset-top,0px)]", showLabels ? "px-4" : "justify-center px-2")}>
          <Link to="/client" className="flex min-w-0 items-center gap-2.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" aria-label="Auto Responder">
            <BrandMark className="h-9 w-9" />
            {showLabels && (
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold tracking-tight text-slate-900" dir="ltr">
                  Auto Responder
                </span>
                <span className="block truncate text-[11px] text-slate-500">{displayName}</span>
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="ms-auto rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 xl:hidden"
            aria-label={t("common.closeMenu")}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* No overflow clipping while collapsed so tooltips can extend past the rail. */}
        <nav className={cx("flex-1 space-y-1 px-3 py-3", showLabels ? "overflow-y-auto" : "overflow-visible")}>
          {navItems.map((item) => {
            const Icon = NAV_ICONS[item.key] || HomeIcon;
            const active = item.key === activeKey;
            const label = t(`shell.nav.${item.key}`);
            return (
              <Link
                key={item.key}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "group relative flex h-10 items-center gap-3 rounded-xl text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  showLabels ? "px-3" : "justify-center",
                  active ? "bg-indigo-50 text-indigo-700" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                )}
              >
                {active && <span className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-indigo-600" aria-hidden="true" />}
                <Icon className="h-5 w-5 shrink-0" />
                <span className={showLabels ? "truncate" : "sr-only"}>{label}</span>
                {!showLabels && <Tooltip label={label} />}
              </Link>
            );
          })}
        </nav>

        <div className="hidden shrink-0 border-t border-slate-100 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] pt-3 xl:block">
          <button
            type="button"
            onClick={toggleRail}
            aria-expanded={expanded}
            className={cx(
              "group relative flex h-10 w-full items-center gap-3 rounded-xl text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
              showLabels ? "px-3" : "justify-center"
            )}
          >
            <CollapseIcon className="h-5 w-5 shrink-0" />
            <span className={showLabels ? "truncate" : "sr-only"}>{expanded ? t("shell.collapseSidebar") : t("shell.expandSidebar")}</span>
            {!showLabels && <Tooltip label={t("shell.expandSidebar")} />}
          </button>
        </div>
      </aside>

      <div className={cx("transition-[padding] duration-200", pushContent ? "xl:ps-60" : "xl:ps-[72px]", fullHeight && "flex h-full flex-col")}>
        <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200/80 bg-white/90 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-4 lg:px-6">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 xl:hidden"
              aria-label={t("common.openMenu")}
            >
              <Bars3Icon className="h-5 w-5" />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 sm:text-lg rtl:tracking-normal">{title}</h1>
            {/* Future: page actions / notifications live here. */}
            <button
              type="button"
              onClick={toggleLanguage}
              disabled={switchingLanguage}
              title={t("common.switchLanguage")}
              aria-label={t("common.switchLanguage")}
              lang={language === "en" ? "ar" : "en"}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-60"
            >
              {language === "en" ? "عربي" : "EN"}
            </button>
            <UserMenu user={user} displayName={displayName} items={userMenuItems} onLogout={logout} t={t} />
          </div>
        </header>

        <main className={fullHeight ? "flex min-h-0 flex-1 flex-col px-2 pb-2 pt-2 sm:px-3 sm:pb-3" : "px-3 py-4 sm:px-4 lg:px-6 lg:py-5"}>
          <PageContainer width={width} className={fullHeight ? "flex min-h-0 flex-1 flex-col" : "animate-[fadeIn_.2s_ease-out]"}>
            <SubscriptionBanner />
            {activeGroup && (
              <nav aria-label={t("shell.sectionNav")} className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
                {activeGroup.tabs.map((tab) => {
                  const on = tab.to === location.pathname;
                  return (
                    <Link
                      key={tab.key}
                      to={tab.to}
                      aria-current={on ? "page" : undefined}
                      className={cx(
                        "-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition",
                        on ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-900"
                      )}
                    >
                      {t(`shell.tabs.${tab.key}`)}
                    </Link>
                  );
                })}
              </nav>
            )}
            {/* key resets the boundary's error state on navigation. */}
            <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>
          </PageContainer>
        </main>
      </div>
    </div>
  );
}
