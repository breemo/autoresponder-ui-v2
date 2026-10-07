import React from "react";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { WhatsAppGlyph, TelegramGlyph, FacebookGlyph, InstagramGlyph } from "../../lib/channelIcons.jsx";

// Brand mark — the same indigo rounded square + chat-bubble icon used by the
// app sidebar and public/favicon.svg.
export function BrandMark({ className = "h-9 w-9", iconClassName = "h-5 w-5" }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30 ${className}`}>
      <ChatBubbleLeftRightIcon className={iconClassName} />
    </span>
  );
}

export function BrandLogo({ className = "" }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark />
      <span className="text-[17px] font-bold tracking-tight text-slate-900">Auto Responder</span>
    </span>
  );
}

const MessengerGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.43 3.14 7.17.16.15.26.35.27.57l.05 1.78c.02.57.6.94 1.12.71l1.98-.87c.17-.08.36-.09.53-.04.91.25 1.88.38 2.91.38 5.64 0 10-4.13 10-9.7C22 6.13 17.64 2 12 2zm6 7.46-2.94 4.66a1.5 1.5 0 0 1-2.17.4l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66a1.5 1.5 0 0 1 2.17-.4l2.34 1.75c.21.16.51.16.72 0l3.16-2.4c.42-.32.97.18.69.63z" />
  </svg>
);

const WebsiteChatGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="13" rx="3.5" />
    <path d="M8 21l3-4" />
    <path d="M7.5 10.5h.01M12 10.5h.01M16.5 10.5h.01" strokeWidth="2.6" />
  </svg>
);

export const CHANNEL_STYLES = {
  whatsapp: { Glyph: WhatsAppGlyph, tile: "bg-[#25D366] text-white", label: "WhatsApp" },
  instagram: {
    Glyph: InstagramGlyph,
    tile: "bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white",
    label: "Instagram",
  },
  messenger: { Glyph: MessengerGlyph, tile: "bg-gradient-to-br from-[#00B2FF] to-[#006AFF] text-white", label: "Facebook Messenger" },
  facebook: { Glyph: FacebookGlyph, tile: "bg-[#1877F2] text-white", label: "Facebook" },
  telegram: { Glyph: TelegramGlyph, tile: "bg-[#26A5E4] text-white", label: "Telegram" },
  website: { Glyph: WebsiteChatGlyph, tile: "bg-slate-900 text-white", label: "Website Chat" },
};

export function ChannelTile({ channel, className = "h-8 w-8 rounded-lg", iconClassName = "h-[18px] w-[18px]" }) {
  const meta = CHANNEL_STYLES[channel] || CHANNEL_STYLES.website;
  const { Glyph } = meta;
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${meta.tile} ${className}`} role="img" aria-label={meta.label}>
      <Glyph className={iconClassName} />
    </span>
  );
}
