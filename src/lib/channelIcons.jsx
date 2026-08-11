import React from "react";
import {
  BoltIcon,
  ChatBubbleLeftRightIcon,
  PaperAirplaneIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";

// Reuses the same icon choices already established for these channels in
// ClientIntegrations.jsx's getFeatureMeta() and WhatsAppEvolutionSection,
// so the channel visual language stays consistent across Integrations,
// Inbox, and Leads instead of introducing a second icon set.
const CHANNEL_ICON_META = {
  whatsapp: { icon: ShieldCheckIcon, className: "bg-emerald-500 text-white" },
  telegram: { icon: PaperAirplaneIcon, className: "bg-sky-500 text-white" },
  facebook: { icon: BoltIcon, className: "bg-blue-600 text-white" },
  messenger: { icon: BoltIcon, className: "bg-blue-600 text-white" },
  instagram: { icon: Squares2X2Icon, className: "bg-gradient-to-br from-fuchsia-500 to-rose-400 text-white" },
};

export function getChannelIconMeta(channel) {
  const key = String(channel || "").trim().toLowerCase();
  return CHANNEL_ICON_META[key] || { icon: ChatBubbleLeftRightIcon, className: "bg-slate-500 text-white" };
}

// Small filled badge showing the channel's icon — used wherever a
// conversation/lead's source channel needs a compact visual identifier
// (replaces plain text badges and meaningless numbered-initial avatars).
export default function ChannelIcon({ channel, size = "h-9 w-9", iconSize = "h-5 w-5" }) {
  const { icon: Icon, className } = getChannelIconMeta(channel);
  return (
    <div className={`flex ${size} shrink-0 items-center justify-center rounded-2xl ${className}`} title={channel || "unknown"}>
      <Icon className={iconSize} />
    </div>
  );
}
