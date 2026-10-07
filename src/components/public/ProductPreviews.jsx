import React from "react";
import {
  ArrowTrendingUpIcon,
  BellIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  FunnelIcon,
  HomeIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PuzzlePieceIcon,
  SparklesIcon,
  UserGroupIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { BrandMark, ChannelTile } from "./Brand.jsx";

// Static, illustrative product previews for the public website. They mirror
// the real Auto Responder product (Inbox, AI conversations, handover, leads,
// channel status) but contain sample data only — no API calls, no realtime.

export function PreviewFrame({ className = "", children }) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_24px_60px_-20px_rgba(49,46,129,0.25)] ring-1 ring-slate-900/[0.02] ${className}`}
    >
      {children}
    </div>
  );
}

function Avatar({ initials, tone = "bg-indigo-100 text-indigo-700", className = "h-8 w-8 text-[11px]" }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${tone} ${className}`}>{initials}</span>
  );
}

function StatCard({ value, label, delta }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3">
      <p className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl">{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-slate-500">{label}</p>
      {delta && (
        <p className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600">
          <ArrowTrendingUpIcon className="h-3 w-3" />
          {delta}
        </p>
      )}
    </div>
  );
}

const SAMPLE_STATS = [
  { value: "1,284", label: "Messages", delta: "12%" },
  { value: "327", label: "Conversations", delta: "6%" },
  { value: "91%", label: "AI handled", delta: "5%" },
  { value: "24", label: "Leads captured", delta: "20%" },
];

// ---------------------------------------------------------------------------
// Hero: dashboard overview
// ---------------------------------------------------------------------------
const SIDEBAR = [
  { icon: HomeIcon, label: "Home", active: true },
  { icon: InboxIcon, label: "Inbox", badge: "12" },
  { icon: UsersIcon, label: "Leads" },
  { icon: CpuChipIcon, label: "AI Assistant" },
  { icon: PuzzlePieceIcon, label: "Integrations" },
  { icon: UserGroupIcon, label: "Team" },
  { icon: Cog6ToothIcon, label: "Settings" },
];

const LIVE_ACTIVITY = [
  { channel: "whatsapp", title: "New message on WhatsApp", detail: "“Do you have this product available?”", time: "2m" },
  { icon: SparklesIcon, title: "AI replied", detail: "Shared product details and price", time: "3m" },
  { icon: UsersIcon, title: "Lead captured", detail: "Name and phone saved", time: "5m" },
  { icon: UserGroupIcon, title: "Conversation assigned", detail: "Handed over to the team", time: "8m" },
];

const CHANNEL_STATUS = [
  { channel: "whatsapp", label: "WhatsApp" },
  { channel: "instagram", label: "Instagram" },
  { channel: "facebook", label: "Facebook" },
  { channel: "telegram", label: "Telegram" },
  { channel: "website", label: "Website Chat" },
];

export function DashboardPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <BrandMark className="h-6 w-6 rounded-lg" iconClassName="h-3.5 w-3.5" />
          <span className="text-xs font-semibold text-slate-800">Auto Responder</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="relative">
            <BellIcon className="h-4 w-4 text-slate-400" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-rose-500" />
          </span>
          <div className="hidden items-center gap-2 sm:flex">
            <Avatar initials="BC" className="h-6 w-6 text-[9px]" tone="bg-indigo-600 text-white" />
            <div className="leading-tight">
              <p className="text-[11px] font-semibold text-slate-800">Bright Clinic</p>
              <p className="text-[9px] text-slate-400">Owner</p>
            </div>
          </div>
        </div>
      </div>
      <div className="flex">
        <aside className="hidden w-36 shrink-0 border-r border-slate-100 p-2.5 sm:block">
          {SIDEBAR.map(({ icon: Icon, label, active, badge }) => (
            <div
              key={label}
              className={`mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] font-medium ${
                active ? "bg-indigo-50 text-indigo-700" : "text-slate-500"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="flex-1">{label}</span>
              {badge && <span className="rounded-full bg-rose-500 px-1.5 text-[9px] font-bold text-white">{badge}</span>}
            </div>
          ))}
        </aside>
        <div className="min-w-0 flex-1 p-3 sm:p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-bold text-slate-900">Home</p>
            <span className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] text-slate-500">Last 24 hours</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SAMPLE_STATS.map((s) => (
              <StatCard key={s.label} {...s} />
            ))}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1.25fr_1fr]">
            <div className="rounded-xl border border-slate-100 p-3">
              <p className="mb-2 text-[11px] font-semibold text-slate-800">Live activity</p>
              <ul className="space-y-2.5">
                {LIVE_ACTIVITY.map((a) => (
                  <li key={a.title} className="flex items-start gap-2">
                    {a.channel ? (
                      <ChannelTile channel={a.channel} className="h-6 w-6 rounded-full" iconClassName="h-3.5 w-3.5" />
                    ) : (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                        <a.icon className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-semibold text-slate-800">{a.title}</p>
                      <p className="truncate text-[10px] text-slate-500">{a.detail}</p>
                    </div>
                    <span className="shrink-0 text-[9px] text-slate-400">{a.time}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="hidden rounded-xl border border-slate-100 p-3 md:block">
              <p className="mb-2 text-[11px] font-semibold text-slate-800">Channels status</p>
              <ul className="space-y-2">
                {CHANNEL_STATUS.map((c) => (
                  <li key={c.label} className="flex items-center gap-2">
                    <ChannelTile channel={c.channel} className="h-5 w-5 rounded-md" iconClassName="h-3 w-3" />
                    <span className="flex-1 truncate text-[11px] text-slate-700">{c.label}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                      <span className="h-1 w-1 rounded-full bg-emerald-500" />
                      Connected
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

// Customer messages floating next to the hero dashboard (desktop only).
export const HERO_BUBBLES = [
  { channel: "whatsapp", text: "Hi, do you have this available?", time: "10:24" },
  { reply: true, text: "Yes! It's available. Here are the details…", time: "10:25" },
  { channel: "instagram", text: "What are your opening hours?", time: "10:28" },
  { channel: "messenger", text: "Can I book an appointment?", time: "10:31" },
  { channel: "telegram", text: "Do you offer home delivery?", time: "10:32" },
];

export function MessageBubble({ channel, reply, text, time, className = "" }) {
  if (reply) {
    return (
      <div className={`rounded-2xl rounded-tr-md bg-indigo-600 px-4 py-2.5 text-white shadow-lg shadow-indigo-600/20 ${className}`}>
        <p className="text-[13px] leading-snug">{text}</p>
        <p className="mt-1 text-right text-[10px] text-indigo-200">{time}</p>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white px-3 py-2.5 shadow-lg shadow-slate-900/[0.06] ${className}`}>
      <ChannelTile channel={channel} className="h-8 w-8 rounded-full" iconClassName="h-4 w-4" />
      <p className="text-[13px] text-slate-700">{text}</p>
      <span className="ml-auto pl-2 text-[10px] text-slate-400">{time}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI agent conversation
// ---------------------------------------------------------------------------
export function ChatPreview() {
  return (
    <PreviewFrame className="flex">
      <div className="hidden flex-col items-center gap-3 border-r border-slate-100 bg-slate-50/60 px-2.5 py-4 sm:flex">
        {["whatsapp", "instagram", "messenger", "telegram", "website"].map((c, i) => (
          <span key={c} className={`rounded-xl p-0.5 ${i === 0 ? "ring-2 ring-indigo-500/60" : ""}`}>
            <ChannelTile channel={c} className="h-7 w-7 rounded-lg" iconClassName="h-4 w-4" />
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
          <Avatar initials="SK" tone="bg-amber-100 text-amber-700" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">Sara K.</p>
            <p className="flex items-center gap-1 text-[11px] text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> via WhatsApp
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700">
            <SparklesIcon className="h-3 w-3" /> AI active
          </span>
        </div>
        <div className="space-y-3 bg-gradient-to-b from-white to-slate-50/70 px-4 py-4">
          <div className="flex justify-end">
            <p className="max-w-[78%] rounded-2xl rounded-tr-md bg-slate-100 px-3.5 py-2 text-[13px] text-slate-700">Do you have this product available?</p>
          </div>
          <div className="flex items-end gap-2">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white">
              <SparklesIcon className="h-3.5 w-3.5" />
            </span>
            <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-indigo-100 bg-indigo-50/70 px-3.5 py-2.5 text-[13px] text-slate-700">
              <p>Yes, it's available! Here are the details:</p>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-slate-600">
                <li>• Available in 3 colors</li>
                <li>• Delivery available in your city</li>
                <li>• Price as listed in our catalog</li>
              </ul>
              <p className="mt-1.5">Would you like me to reserve one for you?</p>
            </div>
          </div>
          <div className="flex justify-end">
            <p className="max-w-[78%] rounded-2xl rounded-tr-md bg-slate-100 px-3.5 py-2 text-[13px] text-slate-700">Yes please, the black one.</p>
          </div>
          <div className="flex items-end gap-2">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white">
              <SparklesIcon className="h-3.5 w-3.5" />
            </span>
            <p className="max-w-[82%] rounded-2xl rounded-bl-md border border-indigo-100 bg-indigo-50/70 px-3.5 py-2.5 text-[13px] text-slate-700">
              Perfect! Can I have your full name and phone number to complete it?
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 pt-1">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
              <UsersIcon className="h-3 w-3" /> Lead details saved
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

// ---------------------------------------------------------------------------
// Live monitoring (future feature — marketing preview with sample data)
// ---------------------------------------------------------------------------
const CHART = {
  messages: [40, 52, 46, 70, 64, 96, 88, 120, 142, 118, 132, 150, 128],
  conversations: [14, 18, 16, 22, 20, 30, 27, 33, 28, 31, 36, 34, 30],
};

function toPath(values, w, h, max) {
  const step = w / (values.length - 1);
  return values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
}

export function MonitoringPreview() {
  const w = 520;
  const h = 150;
  const max = 170;
  const messages = toPath(CHART.messages, w, h, max);
  const conversations = toPath(CHART.conversations, w, h, max);
  const peakX = (8 * w) / (CHART.messages.length - 1);
  const peakY = h - (CHART.messages[8] / max) * h;

  return (
    <PreviewFrame className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-slate-900">Business overview</p>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
        </div>
        <span className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] text-slate-500">Last 24 hours</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SAMPLE_STATS.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-slate-100 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-slate-800">Message activity</p>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-indigo-500" /> Messages</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-violet-300" /> Conversations</span>
          </div>
        </div>
        <div className="relative">
          <svg viewBox={`0 0 ${w} ${h + 4}`} className="h-36 w-full sm:h-40" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="ar-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="#eef0f6" strokeWidth="1" />
            ))}
            <path d={`${messages} L${w},${h} L0,${h} Z`} fill="url(#ar-area)" />
            <path d={messages} fill="none" stroke="#6366f1" strokeWidth="2.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={conversations} fill="none" stroke="#c4b5fd" strokeWidth="2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            <line x1={peakX} x2={peakX} y1="0" y2={h} stroke="#c7d2fe" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          </svg>
          <div
            className="pointer-events-none absolute mt-3 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-lg"
            style={{ left: `${(peakX / w) * 100}%`, top: `${(peakY / (h + 4)) * 100}%` }}
          >
            <p className="text-[10px] font-bold text-slate-800">12:00</p>
            <p className="whitespace-nowrap text-[9px] text-slate-500">142 messages · 28 conversations</p>
          </div>
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-slate-400">
          {["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
    </PreviewFrame>
  );
}

// ---------------------------------------------------------------------------
// Shared inbox (human + AI)
// ---------------------------------------------------------------------------
const INBOX_TABS = [
  { label: "Open", count: 11, active: true },
  { label: "Waiting", count: 3 },
  { label: "Closed" },
];

const INBOX_LIST = [
  { name: "Ahmad R.", channel: "whatsapp", text: "Yes, please reserve the black one", time: "2m", unread: 2, active: true },
  { name: "Sara K.", channel: "instagram", text: "Thank you! See you tomorrow", time: "5m" },
  { name: "Omar H.", channel: "messenger", text: "Do you offer installation?", time: "12m", waiting: true },
  { name: "Lina D.", channel: "telegram", text: "What are your working hours?", time: "1h" },
];

export function InboxPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <BrandMark className="h-6 w-6 rounded-lg" iconClassName="h-3.5 w-3.5" />
          <span className="text-xs font-semibold text-slate-800">Inbox</span>
        </div>
        <div className="flex -space-x-1.5">
          <Avatar initials="LD" className="h-6 w-6 text-[9px] ring-2 ring-white" tone="bg-emerald-100 text-emerald-700" />
          <Avatar initials="MN" className="h-6 w-6 text-[9px] ring-2 ring-white" tone="bg-sky-100 text-sky-700" />
          <Avatar initials="+2" className="h-6 w-6 text-[9px] ring-2 ring-white" tone="bg-slate-100 text-slate-600" />
        </div>
      </div>
      <div className="grid sm:grid-cols-[1fr_1.1fr]">
        <div className="border-slate-100 sm:border-r">
          <div className="flex gap-4 border-b border-slate-100 px-3 pt-2.5">
            {INBOX_TABS.map((tab) => (
              <span
                key={tab.label}
                className={`-mb-px border-b-2 pb-2 text-[11px] font-semibold ${
                  tab.active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400"
                }`}
              >
                {tab.label}
                {tab.count != null && <span className="ml-1 font-medium text-slate-400">({tab.count})</span>}
              </span>
            ))}
          </div>
          <div className="p-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-400">
              <MagnifyingGlassIcon className="h-3.5 w-3.5" /> Search conversations
              <FunnelIcon className="ml-auto h-3.5 w-3.5" />
            </div>
          </div>
          <ul>
            {INBOX_LIST.map((c) => (
              <li key={c.name} className={`flex items-center gap-2.5 px-3 py-2.5 ${c.active ? "bg-indigo-50/60" : ""}`}>
                <div className="relative">
                  <Avatar initials={c.name.split(" ").map((p) => p[0]).join("")} />
                  <ChannelTile channel={c.channel} className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full ring-2 ring-white" iconClassName="h-2.5 w-2.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[12px] font-semibold text-slate-800">{c.name}</p>
                    <span className="shrink-0 text-[9px] text-slate-400">{c.time}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[10px] text-slate-500">{c.text}</p>
                    {c.unread && <span className="ml-auto rounded-full bg-indigo-600 px-1.5 text-[9px] font-bold text-white">{c.unread}</span>}
                    {c.waiting && <span className="ml-auto shrink-0 rounded-full bg-amber-50 px-1.5 text-[9px] font-semibold text-amber-700">Waiting</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden flex-col sm:flex">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
            <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-800">Ahmad R.</p>
            <span className="whitespace-nowrap rounded-full bg-indigo-600 px-2.5 py-1 text-[10px] font-semibold text-white">Claim conversation</span>
          </div>
          <div className="flex-1 space-y-2.5 bg-slate-50/50 p-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-md bg-white px-3 py-2 text-[11px] text-slate-700 shadow-sm">Yes, please reserve the black one.</p>
            <div className="max-w-[88%] rounded-2xl rounded-tl-md bg-indigo-600 px-3 py-2 text-[11px] text-white">
              <p className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-indigo-200">
                <SparklesIcon className="h-2.5 w-2.5" /> AI
              </p>
              Perfect! I've noted it. Can I have your name and phone number?
            </div>
            <div className="flex items-center justify-center">
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[9px] font-semibold text-amber-700">Handed over to the team</span>
            </div>
            <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-[11px] text-slate-700">
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700">Lina · Agent</p>
              Hi Ahmad, I'll confirm your order right now.
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-slate-100 p-2.5">
            <span className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] text-slate-400">Type a reply…</span>
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <PaperAirplaneIcon className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
const LEADS = [
  { name: "Ahmad R.", phone: "+970 59• ••• 214", channel: "whatsapp", context: "Wants to reserve a product", status: "Open", tone: "bg-indigo-50 text-indigo-700" },
  { name: "Sara K.", phone: "+962 79• ••• 508", channel: "instagram", context: "Asked about an appointment", status: "Waiting for agent", tone: "bg-amber-50 text-amber-700" },
  { name: "Omar H.", phone: "+970 56• ••• 731", channel: "messenger", context: "Requested installation", status: "Open", tone: "bg-indigo-50 text-indigo-700" },
  { name: "Lina D.", phone: "+972 52• ••• 196", channel: "website", context: "Delivery question answered", status: "Closed", tone: "bg-slate-100 text-slate-600" },
];

export function LeadsPreview() {
  return (
    <PreviewFrame>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <UsersIcon className="h-4 w-4 text-indigo-600" />
          <span className="text-xs font-semibold text-slate-800">Leads</span>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">24 new</span>
        </div>
        <span className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] text-slate-500">All channels</span>
      </div>
      <div className="hidden grid-cols-[1.1fr_1fr_1.4fr_7.5rem] gap-3 border-b border-slate-100 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 sm:grid">
        <span>Customer</span>
        <span>Phone</span>
        <span>Conversation</span>
        <span className="text-right">Status</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {LEADS.map((l) => (
          <li key={l.name} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[1.1fr_1fr_1.4fr_7.5rem]">
            <div className="flex min-w-0 items-center gap-2.5">
              <ChannelTile channel={l.channel} className="h-7 w-7 rounded-lg" iconClassName="h-4 w-4" />
              <p className="truncate text-[12px] font-semibold text-slate-800">{l.name}</p>
            </div>
            <span className="order-last col-span-2 truncate text-[11px] text-slate-500 sm:order-none sm:col-span-1">{l.phone}</span>
            <span className="hidden truncate text-[11px] text-slate-500 sm:block">{l.context}</span>
            <span className={`justify-self-end whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${l.tone}`}>{l.status}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[10px] text-slate-500">
        <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" /> Every lead stays linked to the conversation it came from
      </div>
    </PreviewFrame>
  );
}
