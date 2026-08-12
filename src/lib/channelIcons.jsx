import React from "react";
import { ChatBubbleLeftRightIcon, CpuChipIcon } from "@heroicons/react/24/outline";

// Single reusable channel-icon system for the whole Client Portal (Inbox,
// Leads, Integrations, Dashboard). Uses recognizable brand-shaped inline
// SVG glyphs (no image assets, no new dependency — this project has no
// brand-icon library installed) instead of generic/unrelated Heroicons
// standing in for a channel, and a distinct system icon for AI Auto Reply
// rather than a social logo.

const WhatsAppGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.81L2 22l5.42-1.36a9.9 9.9 0 0 0 4.62 1.15h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.87 9.87 0 0 0 12.04 2zm0 1.67c2.19 0 4.25.85 5.8 2.4a8.2 8.2 0 0 1 2.4 5.83c0 4.55-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.83.84-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.38c0-4.55 3.71-8.24 8.28-8.24zm-4.6 4.68c-.16 0-.42.06-.64.31-.22.25-.85.83-.85 2.02 0 1.19.87 2.34.99 2.5.12.16 1.7 2.72 4.19 3.7.58.25 1.03.4 1.38.51.58.18 1.11.15 1.53.09.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28-.24-.12-1.44-.71-1.66-.79-.22-.08-.38-.12-.55.12-.16.24-.62.79-.76.95-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.55-1.35-.76-1.84-.2-.48-.4-.42-.55-.42h-.47z" />
  </svg>
);

const TelegramGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M21.94 4.6 18.6 19.42c-.25 1.1-.9 1.37-1.83.85l-5.06-3.73-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.14L18 6.5c.42-.37-.09-.58-.65-.2L7.02 12.7l-5.02-1.57c-1.09-.34-1.11-1.09.23-1.61L20.6 3.4c.91-.34 1.7.2 1.34 1.2z" />
  </svg>
);

const FacebookGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M13.5 21v-7.8h2.6l.4-3h-3v-1.93c0-.87.24-1.46 1.5-1.46h1.6V4.14C15.94 4.06 15.02 4 13.94 4c-2.24 0-3.78 1.37-3.78 3.88v2.32H7.5v3h2.66V21h3.34z" />
  </svg>
);

const InstagramGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
  </svg>
);

// Substring matching (not exact-key lookup) so real slugs like
// "whatsapp_evolution" or "ai_auto_reply" resolve correctly — same
// convention already used by ClientIntegrations.jsx's getFeatureMeta().
// Order matters: check the 4 social channels before the generic "ai" check.
export function getChannelIconMeta(channel) {
  const key = String(channel || "").trim().toLowerCase();

  if (key.includes("whatsapp")) {
    return { icon: WhatsAppGlyph, className: "bg-[#25D366] text-white", label: "WhatsApp" };
  }
  if (key.includes("telegram")) {
    return { icon: TelegramGlyph, className: "bg-[#26A5E4] text-white", label: "Telegram" };
  }
  if (key.includes("facebook") || key.includes("messenger")) {
    return { icon: FacebookGlyph, className: "bg-[#1877F2] text-white", label: "Facebook" };
  }
  if (key.includes("instagram")) {
    return {
      icon: InstagramGlyph,
      className: "bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white",
      label: "Instagram",
    };
  }
  if (key.includes("ai")) {
    return { icon: CpuChipIcon, className: "bg-violet-600 text-white", label: "AI Auto Reply" };
  }

  return { icon: ChatBubbleLeftRightIcon, className: "bg-slate-500 text-white", label: channel || "Unknown" };
}

// Small filled badge showing the channel's icon — used wherever a
// conversation/lead/integration's source channel needs a compact visual
// identifier (replaces plain text badges and meaningless numbered-initial
// avatars). Keeps an accessible label/tooltip even though the mark itself
// is visual-only.
export default function ChannelIcon({ channel, size = "h-9 w-9", iconSize = "h-5 w-5" }) {
  const { icon: Icon, className, label } = getChannelIconMeta(channel);
  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-2xl ${className}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <Icon className={iconSize} />
    </div>
  );
}
