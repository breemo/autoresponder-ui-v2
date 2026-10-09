import React from "react";
import { Link } from "react-router-dom";
import { BrandLogo, ChannelTile } from "./Brand.jsx";
import { SectionLink } from "./PublicNav.jsx";
import { CHANNELS, LOGIN_PATH, SECTION_IDS, TRIAL_CTA_LABEL, TRIAL_PATH } from "../../lib/publicSite.js";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Channels", section: SECTION_IDS.channels },
      { label: "AI Agent", section: SECTION_IDS.features },
      { label: "Shared Inbox", section: SECTION_IDS.team },
      { label: "Leads", section: SECTION_IDS.leads },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "How it works", section: SECTION_IDS.howItWorks },
      { label: "Live Monitoring preview", section: SECTION_IDS.monitoring },
      { label: "Use cases", section: SECTION_IDS.useCases },
      { label: "Pricing", section: SECTION_IDS.pricing },
    ],
  },
];

export default function PublicFooter({ onHome = false }) {
  return (
    <footer className="border-t border-slate-200/80 bg-white">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="col-span-2 md:col-span-1">
          <BrandLogo />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">
            AI and your team, working together on every customer conversation.
          </p>
          <div className="mt-5 flex gap-2">
            {CHANNELS.map((c) => (
              <ChannelTile key={c.key} channel={c.key} className="h-8 w-8 rounded-lg" iconClassName="h-4 w-4" />
            ))}
          </div>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">{col.title}</p>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  <SectionLink section={l.section} onHome={onHome} className="text-sm text-slate-600 transition hover:text-indigo-700">
                    {l.label}
                  </SectionLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Account</p>
          <ul className="mt-4 space-y-2.5">
            <li>
              <Link to={LOGIN_PATH} className="text-sm text-slate-600 transition hover:text-indigo-700">Log in</Link>
            </li>
            <li>
              <Link to={TRIAL_PATH} className="text-sm text-slate-600 transition hover:text-indigo-700">{TRIAL_CTA_LABEL}</Link>
            </li>
            <li>
              <SectionLink section={SECTION_IDS.contact} onHome={onHome} className="text-sm text-slate-600 transition hover:text-indigo-700">
                Contact
              </SectionLink>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-slate-100">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-6 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>© {new Date().getFullYear()} Auto Responder. All rights reserved.</p>
          <p>Product previews on this page use illustrative sample data.</p>
        </div>
      </div>
    </footer>
  );
}
