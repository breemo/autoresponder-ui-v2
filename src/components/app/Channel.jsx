import React from "react";
import { ChannelTile } from "../public/Brand.jsx";

// One channel visual system for the website and the app: the app reuses the
// website's ChannelTile and only maps real platform / feature-slug values
// (e.g. "whatsapp_evolution", "website_chat", "facebook") onto its keys.
export function channelKeyFrom(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key.includes("whatsapp")) return "whatsapp";
  if (key.includes("instagram")) return "instagram";
  if (key.includes("messenger")) return "messenger";
  if (key.includes("facebook")) return "facebook";
  if (key.includes("telegram")) return "telegram";
  if (key.includes("website") || key.includes("webchat") || key.includes("web_chat")) return "website";
  return null;
}

export function AppChannelTile({ channel, className = "h-8 w-8 rounded-lg", iconClassName = "h-4 w-4" }) {
  const key = channelKeyFrom(channel);
  if (!key) {
    return <span className={`inline-flex shrink-0 items-center justify-center bg-slate-200 text-[10px] font-bold uppercase text-slate-500 ${className}`}>{String(channel || "?").slice(0, 2)}</span>;
  }
  return <ChannelTile channel={key} className={className} iconClassName={iconClassName} />;
}
