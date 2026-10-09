import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, ClockIcon } from "@heroicons/react/24/outline";
import PublicNav from "../../components/public/PublicNav.jsx";
import { LOGIN_PATH, PUBLIC_HOME_PATH, TRIAL_DAYS } from "../../lib/publicSite.js";

// Placeholder for the upcoming self-service registration + trial flow.
// Intentionally has NO form and NO backend calls. The next phase replaces
// this page (route: TRIAL_PATH in src/lib/publicSite.js); every
// trial CTA (label: TRIAL_CTA_LABEL) already points here.
export default function StartTrial() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Free trial — coming soon — Auto Responder";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div dir="ltr" lang="en" className="flex min-h-screen flex-col bg-gradient-to-b from-indigo-50/60 via-white to-white text-slate-900">
      <PublicNav />
      <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
        <div className="w-full max-w-lg rounded-3xl border border-slate-200/80 bg-white p-8 text-center shadow-[0_30px_70px_-30px_rgba(79,70,229,0.35)] sm:p-10">
          <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <ClockIcon className="h-7 w-7" />
          </span>
          <h1 className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl">Free trial sign-up is coming soon</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            Self-service registration with a {TRIAL_DAYS}-day free trial is not available yet. Existing customers can log in as usual.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link
              to={LOGIN_PATH}
              className="inline-flex items-center justify-center rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700"
            >
              Log in
            </Link>
            <Link
              to={PUBLIC_HOME_PATH}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 px-6 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back to home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
