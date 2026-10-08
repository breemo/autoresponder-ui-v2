// Client Portal navigation model (presentation only).
//
// Route paths are unchanged. Enforcement stays in App.jsx (ClientRoute
// permission redirects + must_change_password gate); filtering here only
// hides links a member cannot use. Groups bundle existing routes that share
// the SAME permission, so grouping never changes who can reach a page.

import { PERMISSIONS, hasUserPermission } from "./permissions.js";

export const CLIENT_NAV = [
  { key: "home", to: "/client", permission: PERMISSIONS.DASHBOARD, match: ["/client"] },
  { key: "inbox", to: "/client/messages", permission: PERMISSIONS.INBOX, match: ["/client/messages"] },
  { key: "leads", to: "/client/leads", permission: PERMISSIONS.LEADS, match: ["/client/leads"] },
  {
    key: "replies",
    to: "/client/auto-replies",
    permission: PERMISSIONS.AUTO_REPLIES, // agents have this but NOT settings — keep Replies out of Settings
    match: ["/client/auto-replies", "/client/quick-replies"],
    tabs: [
      { key: "autoReplies", to: "/client/auto-replies", permission: PERMISSIONS.AUTO_REPLIES },
      { key: "quickReplies", to: "/client/quick-replies", permission: PERMISSIONS.AUTO_REPLIES },
    ],
  },
  { key: "aiAgent", to: "/client/feature-settings", permission: PERMISSIONS.AI_SETTINGS, match: ["/client/feature-settings"] },
  { key: "integrations", to: "/client/integrations", permission: PERMISSIONS.INTEGRATIONS, match: ["/client/integrations"] },
  {
    key: "team",
    to: "/client/team",
    permission: PERMISSIONS.TEAM_MANAGEMENT,
    match: ["/client/team", "/client/team-performance"],
    tabs: [
      { key: "members", to: "/client/team", permission: PERMISSIONS.TEAM_MANAGEMENT },
      { key: "performance", to: "/client/team-performance", permission: PERMISSIONS.TEAM_MANAGEMENT },
    ],
  },
  { key: "settings", to: "/client/settings", permission: PERMISSIONS.SETTINGS, match: ["/client/settings"] },
];

// Personal pages (no permission) live in the user menu, plus Plan & Billing
// (account-level, gated by the same AI_SETTINGS permission its sections had
// on the AI Agent page — keeps the primary sidebar unchanged).
export const CLIENT_USER_MENU = [
  { key: "myAccount", to: "/client/account" },
  { key: "myPerformance", to: "/client/my-performance" },
  { key: "planBilling", to: "/client/plan-billing", permission: PERMISSIONS.AI_SETTINGS },
];

export const ACCOUNT_PATH = "/client/account";

export function visibleClientNav(user) {
  // While a mandatory password change is pending every other route redirects
  // to the Account page, so the rail only offers that page.
  if (user?.must_change_password) return [{ key: "myAccount", to: ACCOUNT_PATH, match: [ACCOUNT_PATH] }];
  return CLIENT_NAV.filter((item) => !item.permission || hasUserPermission(user, item.permission)).map((item) =>
    item.tabs ? { ...item, tabs: item.tabs.filter((tab) => !tab.permission || hasUserPermission(user, tab.permission)) } : item
  );
}

export function visibleUserMenu(user) {
  if (user?.must_change_password) return CLIENT_USER_MENU.filter((i) => i.key === "myAccount");
  return CLIENT_USER_MENU.filter((item) => !item.permission || hasUserPermission(user, item.permission));
}

export function activeNavKey(pathname, items = CLIENT_NAV) {
  const hit = items.find((item) => (item.match || [item.to]).includes(pathname));
  return hit ? hit.key : null;
}

const TITLE_KEYS = {
  "/client": "shell.nav.home",
  "/client/messages": "shell.nav.inbox",
  "/client/leads": "shell.nav.leads",
  "/client/auto-replies": "shell.nav.replies",
  "/client/quick-replies": "shell.nav.replies",
  "/client/feature-settings": "shell.nav.aiAgent",
  "/client/integrations": "shell.nav.integrations",
  "/client/team": "shell.nav.team",
  "/client/team-performance": "shell.nav.team",
  "/client/settings": "shell.nav.settings",
  "/client/account": "shell.nav.myAccount",
  "/client/my-performance": "shell.nav.myPerformance",
  "/client/plan-billing": "shell.nav.planBilling",
};

export function pageTitleKey(pathname) {
  return TITLE_KEYS[pathname] || "shell.nav.home";
}

// FULL = operational workspace; every other page shares the STANDARD canvas
// (readable limits live inside sections, not on the page).
const FULL_WIDTH_ROUTES = ["/client/messages"];

export function pageWidthFor(pathname) {
  return FULL_WIDTH_ROUTES.includes(pathname) ? "full" : "standard";
}

// Desktop sidebar preference (frontend-only, per device). Applies at >= 1536px
// where an expanded sidebar pushes content; between 1280 and 1535 the rail
// starts collapsed and expanding is a temporary overlay.
export const SIDEBAR_STORAGE_KEY = "ar.client.sidebar";

export function readSidebarPinned() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "expanded";
  } catch {
    return false;
  }
}

export function writeSidebarPinned(expanded) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, expanded ? "expanded" : "collapsed");
  } catch {
    // Best-effort only.
  }
}
