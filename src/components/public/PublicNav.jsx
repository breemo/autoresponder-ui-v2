import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon, Bars3Icon, ChevronDownIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useAuth } from "../../context/AuthContext.jsx";
import { BrandLogo } from "./Brand.jsx";
import { LOGIN_PATH, NAV_ITEMS, PUBLIC_HOME_PATH, TRIAL_PATH, appHomePath } from "../../lib/publicSite.js";

// Section link that works from the landing page (in-page anchor, smooth
// scroll via `scroll-behavior: smooth` + section scroll-margin) and from any
// other public page (navigates home, LandingPage scrolls to the hash).
export function SectionLink({ section, onHome, className, children, onClick }) {
  if (onHome) {
    return (
      <a href={`#${section}`} className={className} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <Link to={{ pathname: PUBLIC_HOME_PATH, hash: `#${section}` }} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

function ResourcesMenu({ item, onHome }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        {item.label}
        <ChevronDownIcon className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
      </button>
      <div
        className={`absolute left-1/2 top-full z-50 w-60 -translate-x-1/2 pt-2 transition ${
          open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0"
        }`}
      >
        <div className="rounded-2xl border border-slate-200/80 bg-white p-2 shadow-xl shadow-slate-900/10">
          {item.children.map((child) => (
            <SectionLink
              key={child.section}
              section={child.section}
              onHome={onHome}
              onClick={() => setOpen(false)}
              className="block rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              {child.label}
            </SectionLink>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PublicNav({ onHome = false }) {
  const auth = useAuth();
  const dashboardPath = appHomePath(auth?.user);
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const closeMobile = () => setMobileOpen(false);

  return (
    <header
      className={`sticky top-0 z-40 transition-[background-color,box-shadow,border-color] duration-200 ${
        scrolled || mobileOpen
          ? "border-b border-slate-200/70 bg-white/85 shadow-sm shadow-slate-900/[0.03] backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8 lg:h-[72px]" aria-label="Main">
        <Link to={PUBLIC_HOME_PATH} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={closeMobile}>
          <BrandLogo />
        </Link>

        <div className="hidden items-center gap-1 lg:flex">
          {NAV_ITEMS.map((item) =>
            item.children ? (
              <ResourcesMenu key={item.label} item={item} onHome={onHome} />
            ) : (
              <SectionLink
                key={item.label}
                section={item.section}
                onHome={onHome}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900"
              >
                {item.label}
              </SectionLink>
            )
          )}
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          {dashboardPath ? (
            <Link
              to={dashboardPath}
              className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:-translate-y-px hover:bg-indigo-700"
            >
              Open dashboard
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          ) : (
            <>
              <Link
                to={LOGIN_PATH}
                className="rounded-full border border-indigo-200 bg-white/70 px-5 py-2.5 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-50"
              >
                Log in
              </Link>
              <Link
                to={TRIAL_PATH}
                className="group inline-flex items-center gap-2 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:-translate-y-px hover:bg-indigo-700"
              >
                Start Free Trial
                <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 transition hover:bg-slate-100 lg:hidden"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <XMarkIcon className="h-6 w-6" /> : <Bars3Icon className="h-6 w-6" />}
        </button>
      </nav>

      {mobileOpen && (
        <div className="h-[calc(100dvh-4rem)] overflow-y-auto border-t border-slate-100 bg-white px-5 pb-8 pt-4 sm:px-8 lg:hidden">
          <div className="space-y-1">
            {NAV_ITEMS.flatMap((item) => (item.children ? item.children : [item])).map((item) => (
              <SectionLink
                key={item.section}
                section={item.section}
                onHome={onHome}
                onClick={closeMobile}
                className="block rounded-xl px-3 py-3 text-base font-medium text-slate-700 transition hover:bg-slate-50"
              >
                {item.label}
              </SectionLink>
            ))}
          </div>
          <div className="mt-6 grid gap-3 border-t border-slate-100 pt-6">
            {dashboardPath ? (
              <Link to={dashboardPath} onClick={closeMobile} className="rounded-full bg-indigo-600 px-5 py-3 text-center text-sm font-semibold text-white">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to={TRIAL_PATH} onClick={closeMobile} className="rounded-full bg-indigo-600 px-5 py-3 text-center text-sm font-semibold text-white shadow-md shadow-indigo-600/25">
                  Start Free Trial
                </Link>
                <Link to={LOGIN_PATH} onClick={closeMobile} className="rounded-full border border-indigo-200 px-5 py-3 text-center text-sm font-semibold text-indigo-700">
                  Log in
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
