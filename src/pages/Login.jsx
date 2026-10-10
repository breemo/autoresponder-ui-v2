import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  EyeIcon,
  EyeSlashIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext.jsx";
import { writeSessionExpiry } from "../lib/session.js";
import { writeStoredUser } from "../lib/storedUser.js";
import { BrandLogo, BrandMark, ChannelTile } from "../components/public/Brand.jsx";
import { MessageBubble } from "../components/public/ProductPreviews.jsx";
import { CHANNELS, PUBLIC_HOME_PATH, TRIAL_DAYS, TRIAL_PATH } from "../lib/publicSite.js";

// Server error codes (api/_lib/authLogin.js) -> existing login messages.
const LOGIN_ERROR_KEYS = {
  invalid_request: "login.errorInvalidCredentials",
  invalid_credentials: "login.errorInvalidCredentials",
  no_membership: "login.errorNoMembership",
  account_disabled: "login.errorAccountDisabled",
  rate_limited: "login.errorRateLimited",
};

// Existing translations carry a leading ❌/✅; the redesigned alert shows its
// own icon instead.
const stripStatusEmoji = (text) => String(text || "").replace(/^\s*(❌|✅)\s*/u, "");

function BrandPanel({ t }) {
  return (
    <div className="relative hidden overflow-hidden rounded-[1.6rem] bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-600 p-10 text-white lg:flex lg:flex-col xl:p-12">
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-28 -right-20 h-80 w-80 rounded-full bg-violet-300/25 blur-3xl" />

      <Link to={PUBLIC_HOME_PATH} className="relative w-fit rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
        <BrandLogo tone="light" />
      </Link>

      <div className="relative mt-auto pt-12">
        <h2 className="max-w-md text-balance text-[2rem] font-bold leading-tight tracking-tight rtl:leading-snug rtl:tracking-normal xl:text-[2.25rem]">
          {t("login.brandHeadline")}
        </h2>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-indigo-100 rtl:leading-loose">{t("login.brandText")}</p>

        <ul className="mt-7 space-y-3">
          {["brandPoint1", "brandPoint2", "brandPoint3"].map((key) => (
            <li key={key} className="flex items-center gap-3 text-sm font-medium text-white/90">
              <CheckCircleIcon className="h-5 w-5 shrink-0 text-indigo-200" />
              {t(`login.${key}`)}
            </li>
          ))}
        </ul>

        <div className="mt-9 max-w-sm space-y-3" aria-hidden="true">
          <MessageBubble channel="whatsapp" text={t("login.sampleCustomer")} time="10:24" />
          <div className="ms-10 rounded-2xl rounded-se-md bg-white/15 px-4 py-2.5 ring-1 ring-white/20 backdrop-blur">
            <p className="text-[13px] leading-snug text-white">{t("login.sampleReply")}</p>
            <p className="mt-1 text-end text-[10px] text-indigo-100">10:25</p>
          </div>
        </div>

        <div className="mt-9 flex items-center gap-2.5">
          {CHANNELS.map((c) => (
            <ChannelTile key={c.key} channel={c.key} className="h-9 w-9 rounded-xl ring-2 ring-white/20" iconClassName="h-[18px] w-[18px]" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const { t } = useTranslation();
  const lang = useLanguage();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(null); // { tone: "error" | "success", text }
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const isRtl = lang?.isRtl ?? false;

  // Authentication flow. Security C2: credentials are verified server-side
  // (api/_lib/authLogin.js) — the browser no longer queries `users`. The
  // response is the same user/membership shape as before minus credential
  // fields; stored user, session expiry and destinations are unchanged.
  // Returns true when the user was signed in.
  const handleLogin = async () => {
    const response = await fetch("/api/client-router?resource=login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success || !data.user) {
      setMessage({ tone: "error", text: t(LOGIN_ERROR_KEYS[data?.code] || "login.errorGeneric") });
      return false;
    }

    const user = data.user;

    // 💾 نخزن البيانات الصحيحة للـ user
    // Security C1: credentials are stripped again before the object
    // reaches localStorage or React state.
    const storedUser = writeStoredUser(user);
    writeSessionExpiry();
    setUser(storedUser);

    setMessage({ tone: "success", text: user.role === "admin" ? t("login.successAdmin") : t("login.successClient") });

    setTimeout(() => {
      navigate(user.role === "admin" ? "/admin" : "/client");
    }, 500);

    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setMessage(null);
    setLoading(true);
    try {
      const signedIn = await handleLogin();
      // On success keep the button in its loading state until navigation.
      if (!signedIn) setLoading(false);
    } catch (err) {
      // Log only the message — never the error object, which may carry
      // request details from the credential query.
      console.error("Login failed:", err?.message || "unknown error");
      setMessage({ tone: "error", text: t("login.errorGeneric") });
      setLoading(false);
    }
  };

  const switchLanguage = () => lang?.setUserLanguage?.(lang.language === "ar" ? "en" : "ar");

  const inputClass =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-[15px] text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/15 disabled:bg-slate-50";

  return (
    <div dir={isRtl ? "rtl" : "ltr"} lang={lang?.language || undefined} className="relative flex min-h-screen flex-col overflow-x-hidden bg-slate-50/70 text-slate-900">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-indigo-200/40 blur-3xl" />
        <div className="absolute -bottom-40 -right-32 h-[440px] w-[440px] rounded-full bg-violet-200/40 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-4 py-5 sm:px-6 lg:justify-center lg:py-10">
        {/* Top row: aligned to the auth shell's edges. */}
        <div className="flex items-center justify-between gap-3 pb-4 lg:px-2 lg:pb-5">
          <Link
            to={PUBLIC_HOME_PATH}
            className="rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden"
            aria-label="Auto Responder"
          >
            <BrandLogo />
          </Link>
          <Link
            to={PUBLIC_HOME_PATH}
            className="group hidden items-center gap-2 rounded-full py-2 text-sm font-medium text-slate-600 transition hover:text-indigo-700 lg:inline-flex"
          >
            <ArrowLeftIcon className="h-4 w-4 transition group-hover:-translate-x-0.5 rtl:rotate-180 rtl:group-hover:translate-x-0.5" />
            {t("login.backToHome")}
          </Link>
          <button
            type="button"
            onClick={switchLanguage}
            lang={lang?.language === "ar" ? "en" : "ar"}
            className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700"
          >
            {lang?.language === "ar" ? "English" : "العربية"}
          </button>
        </div>

        {/* Auth shell: brand panel + login form as one composition. */}
        <div className="rounded-[2rem] border border-slate-200/80 bg-white p-2 shadow-[0_40px_90px_-40px_rgba(49,46,129,0.35)] lg:grid lg:min-h-[640px] lg:grid-cols-[1.08fr_1fr]">
          <BrandPanel t={t} />

          <main className="flex items-center justify-center px-5 py-8 sm:px-10 sm:py-12 lg:px-12">
            <div className="w-full max-w-[380px]">
              <BrandMark className="h-11 w-11 rounded-2xl" iconClassName="h-6 w-6" />
              <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-900 rtl:tracking-normal sm:text-[1.75rem]">{t("login.welcomeTitle")}</h1>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-500">{t("login.welcomeSubtitle")}</p>

              {message && (
                <div
                  role={message.tone === "error" ? "alert" : "status"}
                  className={`mt-6 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm font-medium ${
                    message.tone === "error"
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {message.tone === "error" ? (
                    <ExclamationCircleIcon className="mt-px h-5 w-5 shrink-0" />
                  ) : (
                    <CheckCircleIcon className="mt-px h-5 w-5 shrink-0" />
                  )}
                  <span>{stripStatusEmoji(message.text)}</span>
                </div>
              )}

              <form onSubmit={onSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="login-email" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {t("login.emailLabel")}
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    inputMode="email"
                    dir="ltr"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={`${inputClass} ${isRtl ? "text-right" : ""}`}
                    disabled={loading}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {t("login.passwordLabel")}
                  </label>
                  <div className="relative" dir={isRtl ? "rtl" : "ltr"}>
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      name="password"
                      autoComplete="current-password"
                      dir="ltr"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} ${isRtl ? "ps-12 text-right" : "pe-12"}`}
                      disabled={loading}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 end-0 flex w-12 items-center justify-center rounded-e-xl text-slate-400 transition hover:text-indigo-600 focus:outline-none focus-visible:text-indigo-600"
                      aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="group mt-2 inline-flex w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                      {t("login.submitting")}
                    </>
                  ) : (
                    <>
                      {t("login.submit")}
                      <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-8 border-t border-slate-100 pt-6 text-center">
                <p className="text-sm text-slate-500">{t("login.newHere")}</p>
                <Link
                  to={TRIAL_PATH}
                  className="mt-3 inline-flex w-full items-center justify-center rounded-full border border-indigo-200 bg-indigo-50/40 px-6 py-3 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-50"
                >
                  {t("login.startTrial", { days: TRIAL_DAYS })}
                </Link>
              </div>
            </div>
          </main>
        </div>

        <div className="mt-6 text-center lg:hidden">
          <Link to={PUBLIC_HOME_PATH} className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-indigo-700">
            <ArrowLeftIcon className="h-4 w-4 rtl:rotate-180" />
            {t("login.backToHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}
