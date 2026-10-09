import React, { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  AcademicCapIcon,
  ArrowRightIcon,
  BuildingStorefrontIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  CheckIcon,
  HeartIcon,
  LinkIcon,
  PlayCircleIcon,
  ScissorsIcon,
  ShoppingBagIcon,
  SparklesIcon,
  UserGroupIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import PublicNav from "../../components/public/PublicNav.jsx";
import PublicFooter from "../../components/public/PublicFooter.jsx";
import { ChannelTile } from "../../components/public/Brand.jsx";
import {
  ChatPreview,
  DashboardPreview,
  HERO_BUBBLES,
  InboxPreview,
  LeadsPreview,
  MessageBubble,
  MonitoringPreview,
} from "../../components/public/ProductPreviews.jsx";
import { CHANNELS, SECTION_IDS, TRIAL_CTA_LABEL, TRIAL_DAYS, TRIAL_PATH } from "../../lib/publicSite.js";

const PAGE_TITLE = "Auto Responder — AI + team for every customer conversation";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
function Eyebrow({ children, tone = "indigo" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-700 ring-indigo-100",
    violet: "bg-violet-50 text-violet-700 ring-violet-100",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ring-1 ${tones[tone]}`}>
      {children}
    </span>
  );
}

function SectionHeading({ eyebrow, title, text, center = false, eyebrowTone }) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      {eyebrow && <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow>}
      <h2 className="mt-4 text-3xl font-bold leading-[1.15] tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {text && <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">{text}</p>}
    </div>
  );
}

function CheckList({ items }) {
  return (
    <ul className="mt-7 space-y-3">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 text-[15px] text-slate-700">
          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white">
            <CheckIcon className="h-3 w-3" strokeWidth={3} />
          </span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function PrimaryButton({ to, children, className = "" }) {
  return (
    <Link
      to={to}
      className={`group inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:-translate-y-0.5 hover:bg-indigo-700 hover:shadow-indigo-600/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${className}`}
    >
      {children}
      <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
    </Link>
  );
}

function FeatureSection({ id, reverse = false, eyebrow, eyebrowTone, title, text, items, cta, visual, tinted = false, note }) {
  return (
    <section id={id} className={`scroll-mt-20 py-16 sm:py-20 ${tinted ? "bg-gradient-to-b from-slate-50/80 to-white" : ""}`}>
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2 lg:gap-16">
        <div className={reverse ? "lg:order-2" : ""}>
          <SectionHeading eyebrow={eyebrow} title={title} text={text} eyebrowTone={eyebrowTone} />
          <CheckList items={items} />
          {cta && <div className="mt-9">{cta}</div>}
          {note && <p className="mt-5 text-xs text-slate-400">{note}</p>}
        </div>
        <div className={`relative ${reverse ? "lg:order-1" : ""}`}>
          <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-br from-indigo-100/70 via-violet-50/60 to-transparent blur-2xl" />
          {visual}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function Hero() {
  return (
    <section id={SECTION_IDS.product} className="relative scroll-mt-20 overflow-hidden pb-16 pt-10 sm:pb-24 sm:pt-14 lg:pt-16">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-indigo-200/40 blur-3xl" />
        <div className="absolute -right-32 top-10 h-[460px] w-[460px] rounded-full bg-violet-200/40 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-white" />
      </div>

      <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <Eyebrow>
            <SparklesIcon className="h-3.5 w-3.5" />
            AI-powered customer conversations
          </Eyebrow>
          <h1 className="mt-6 text-[2.6rem] font-extrabold leading-[1.05] tracking-tight text-slate-900 sm:text-6xl lg:text-[3.6rem]">
            Turn every customer message into an{" "}
            <span className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-500 bg-clip-text text-transparent">opportunity</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
            Manage every customer conversation across WhatsApp, Instagram, Facebook Messenger, Telegram and Website Chat — with
            AI that answers instantly and your team stepping in whenever it matters.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <PrimaryButton to={TRIAL_PATH}>{TRIAL_CTA_LABEL}</PrimaryButton>
            <a
              href={`#${SECTION_IDS.howItWorks}`}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:text-indigo-700"
            >
              <PlayCircleIcon className="h-5 w-5 text-indigo-600" />
              See How It Works
            </a>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">
            {[`${TRIAL_DAYS}-day free trial (coming soon)`, "All five channels in one inbox", "AI + human handover"].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-indigo-600" strokeWidth={2.5} />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative lg:col-span-7 lg:py-8">
          <DashboardPreview />
          {/* Floating customer messages: placed on the frame's edges so they
              never cover dashboard content. Desktop only. */}
          <div aria-hidden="true" className="pointer-events-none">
            <MessageBubble {...HERO_BUBBLES[0]} className="absolute -top-2 left-[38%] hidden w-72 lg:flex" />
            <MessageBubble {...HERO_BUBBLES[2]} className="absolute -bottom-3 -left-8 hidden w-64 xl:flex" />
            <MessageBubble {...HERO_BUBBLES[1]} className="absolute -bottom-4 right-10 hidden w-60 lg:block" />
          </div>
        </div>
      </div>
    </section>
  );
}

function Channels() {
  return (
    <section id={SECTION_IDS.channels} className="scroll-mt-20 border-y border-slate-100 bg-white py-12">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <p className="text-center text-sm font-semibold text-slate-500">
          All your conversations in <span className="font-serif text-base italic text-indigo-600">one place</span>
        </p>
        <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-0 lg:divide-x lg:divide-slate-100">
          {CHANNELS.map((c, i) => (
            <li
              key={c.key}
              className={`group flex flex-col items-center gap-3 rounded-2xl px-4 py-4 transition hover:bg-slate-50 lg:rounded-none ${
                i === CHANNELS.length - 1 ? "col-span-2 sm:col-span-1" : ""
              }`}
            >
              <ChannelTile channel={c.key} className="h-12 w-12 rounded-2xl shadow-md transition group-hover:-translate-y-0.5" iconClassName="h-6 w-6" />
              <span className="text-sm font-semibold text-slate-800">{c.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const STEPS = [
  { icon: LinkIcon, title: "Connect your channels", text: "Link WhatsApp, Instagram, Facebook Messenger, Telegram and your Website Chat." },
  { icon: SparklesIcon, title: "Teach it your business", text: "Add your business information so the AI answers the way your team would." },
  { icon: ChatBubbleLeftRightIcon, title: "AI handles conversations", text: "Customers get instant answers while leads and details are captured automatically." },
  { icon: UserGroupIcon, title: "Your team steps in", text: "When a customer needs a person, the conversation is handed over to your team." },
];

function HowItWorks() {
  return (
    <section id={SECTION_IDS.howItWorks} className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          center
          eyebrow="How it works"
          title="From first message to happy customer"
          text="Set up once, then let AI and your team work side by side on every conversation."
        />
        <ol className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="group relative rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5">
              <div className="flex items-center justify-between">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 transition group-hover:bg-indigo-600 group-hover:text-white">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="text-sm font-bold text-slate-200">0{i + 1}</span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const USE_CASES = [
  { icon: HeartIcon, title: "Clinics & Healthcare", text: "Appointment questions, services and follow-ups." },
  { icon: BuildingStorefrontIcon, title: "Restaurants & Cafés", text: "Menus, opening hours, reservations and orders." },
  { icon: ShoppingBagIcon, title: "Stores & E-commerce", text: "Product availability, prices and delivery questions." },
  { icon: WrenchScrewdriverIcon, title: "Service Businesses", text: "Quotes, inquiries and service requests." },
  { icon: ScissorsIcon, title: "Salons & Beauty", text: "Bookings, services and pricing questions." },
  { icon: AcademicCapIcon, title: "Training Centers", text: "Courses, schedules and registrations." },
];

function UseCases() {
  return (
    <section id={SECTION_IDS.useCases} className="scroll-mt-20 bg-gradient-to-b from-white via-indigo-50/40 to-white py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          center
          eyebrow="Built for real businesses"
          title="Works for many types of businesses"
          text="Whether you run a clinic, a restaurant, a store or a service business, Auto Responder helps you answer faster and never miss a customer."
        />
        <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u) => (
            <li key={u.title} className="group flex gap-4 rounded-2xl border border-slate-200/80 bg-white p-6 transition hover:-translate-y-1 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/25">
                <u.icon className="h-6 w-6" />
              </span>
              <div>
                <h3 className="text-base font-semibold text-slate-900">{u.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{u.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Plan names and prices live in the database (Admin -> Plans) and there is
// no public pricing source yet, so this section deliberately shows no plan
// names or prices — only what is true for every plan and how plans differ.
const PLAN_DIMENSIONS = ["Monthly messages", "AI replies", "Connected channel accounts", "Auto replies"];

const TRIAL_INCLUDES = [
  "WhatsApp, Instagram, Messenger, Telegram & Website Chat",
  "AI Agent that answers from your business information",
  "Shared inbox with human handover",
  "Automatic lead capture",
  "Auto replies and quick replies",
  "Team members with roles and permissions",
];

function Pricing() {
  return (
    <section id={SECTION_IDS.pricing} className="scroll-mt-20 py-20 sm:py-24">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <SectionHeading
            eyebrow="Simple, transparent pricing"
            title="Choose the plan that fits your business"
            text={`Self-service sign-up with a ${TRIAL_DAYS}-day free trial is coming soon. Plans grow with you as your conversations grow.`}
          />
          <div className="mt-8 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5">
            <p className="text-sm font-semibold text-slate-900">Plans differ by</p>
            <ul className="mt-3 grid grid-cols-2 gap-2.5">
              {PLAN_DIMENSIONS.map((d) => (
                <li key={d} className="flex items-center gap-2 text-sm text-slate-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                  {d}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="relative overflow-hidden rounded-3xl border border-indigo-200 bg-white p-7 shadow-[0_30px_70px_-30px_rgba(79,70,229,0.45)] sm:p-9">
            <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gradient-to-br from-indigo-200/70 to-violet-200/40 blur-2xl" />
            <div className="relative flex flex-wrap items-start justify-between gap-4">
              <div>
                <span className="rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">Free trial · Coming soon</span>
                <p className="mt-4 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
                  {TRIAL_DAYS} days<span className="ml-2 text-lg font-semibold text-slate-400">to try everything</span>
                </p>
              </div>
            </div>
            <p className="relative mt-3 max-w-lg text-[15px] text-slate-600">
              Every plan includes the full Auto Responder experience:
            </p>
            <ul className="relative mt-6 grid gap-3 sm:grid-cols-2">
              {TRIAL_INCLUDES.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-slate-700">
                  <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                  {f}
                </li>
              ))}
            </ul>
            <div className="relative mt-8 flex flex-col gap-4 border-t border-slate-100 pt-7 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-slate-500">Self-service sign-up is not available yet. Existing customers can log in as usual.</p>
              <PrimaryButton to={TRIAL_PATH}>{TRIAL_CTA_LABEL}</PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section id={SECTION_IDS.contact} className="scroll-mt-20 px-5 pb-20 sm:px-8 sm:pb-24">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-600 px-6 py-14 text-center shadow-2xl shadow-indigo-600/25 sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-28 -right-20 h-80 w-80 rounded-full bg-violet-300/20 blur-3xl" />
        <div className="relative mx-auto max-w-2xl">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-white sm:text-[2.6rem]">
            Ready to transform your customer conversations?
          </h2>
          <p className="mt-5 text-base leading-relaxed text-indigo-100 sm:text-lg">
            Let AI and your team handle every message together. Self-service sign-up with a {TRIAL_DAYS}-day free trial is coming soon.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              to={TRIAL_PATH}
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-indigo-700 shadow-lg transition hover:-translate-y-0.5 hover:bg-indigo-50"
            >
              {TRIAL_CTA_LABEL}
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
            <a
              href={`#${SECTION_IDS.howItWorks}`}
              className="inline-flex items-center justify-center rounded-full border border-white/30 px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              See How It Works
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function LandingPage() {
  const location = useLocation();

  useEffect(() => {
    const previous = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  // Arriving from another page with /#section: scroll to it once rendered.
  useEffect(() => {
    if (!location.hash) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [location.hash]);

  return (
    <div dir="ltr" lang="en" className="min-h-screen overflow-x-hidden bg-white text-slate-900 antialiased">
      <PublicNav onHome />
      <main>
        <Hero />
        <Channels />
        <HowItWorks />
        <FeatureSection
          id={SECTION_IDS.features}
          eyebrow="AI Agent"
          title="Your AI Agent handles the conversations"
          text="It answers common questions using your business information, collects customer details and keeps conversations moving — around the clock."
          items={[
            "Understands what the customer is asking for",
            "Answers using your business information",
            "Collects names, phone numbers and other customer details",
            "Supports booking-related conversations where configured",
            "Hands the conversation to your team when needed",
          ]}
          cta={<PrimaryButton to={TRIAL_PATH}>{TRIAL_CTA_LABEL}</PrimaryButton>}
          visual={<ChatPreview />}
        />
        <FeatureSection
          id={SECTION_IDS.monitoring}
          reverse
          tinted
          eyebrow="Live Monitoring · Coming soon"
          eyebrowTone="violet"
          title="See your business conversations in real time"
          text="A live view of what is happening across your channels: messages, conversations, AI-handled replies and captured leads as they happen."
          items={[
            "Live message and conversation activity",
            "Channel connection status at a glance",
            "AI-handled vs. team-handled conversations",
            "Leads captured across every channel",
          ]}
          note="Preview with illustrative sample data. Live Monitoring is coming soon."
          visual={<MonitoringPreview />}
        />
        <FeatureSection
          id={SECTION_IDS.team}
          eyebrow="Human + AI"
          title="Work together for better customer care"
          text="AI takes care of routine questions. When a customer needs a person, your team picks up the conversation with the full history in front of them."
          items={[
            "One shared inbox for every channel",
            "Seamless handover from AI to your team",
            "Conversation assignment and claiming",
            "Team members with roles and permissions",
            "Reply to customers directly from the inbox",
          ]}
          cta={<PrimaryButton to={TRIAL_PATH}>{TRIAL_CTA_LABEL}</PrimaryButton>}
          visual={<InboxPreview />}
        />
        <FeatureSection
          id={SECTION_IDS.leads}
          reverse
          tinted
          eyebrow="Leads & Growth"
          title="Turn conversations into real business leads"
          text="Customer details collected during conversations become leads your team can act on — with the channel they came from and the conversation behind them."
          items={[
            "Names and phone numbers captured automatically",
            "Source channel for every lead",
            "Each lead linked to its conversation",
            "Follow up from the same place you chat",
          ]}
          cta={<PrimaryButton to={TRIAL_PATH}>{TRIAL_CTA_LABEL}</PrimaryButton>}
          visual={<LeadsPreview />}
        />
        <UseCases />
        <Pricing />
        <FinalCta />
      </main>
      <PublicFooter onHome />
    </div>
  );
}
