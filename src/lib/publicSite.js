// Public website (marketing) configuration — routes, navigation and the
// section anchors shared by the landing page, its navigation and footer.
//
// Routing contract (see src/App.jsx):
//   PUBLIC_HOME_PATH  -> public landing page
//   LOGIN_PATH        -> the existing Login page (unchanged)
//   TRIAL_PATH        -> placeholder for the upcoming registration / 3-day
//                        trial flow. Every "Start Free Trial" CTA links here,
//                        so the next phase only has to replace that page.

export const PUBLIC_HOME_PATH = "/";
export const LOGIN_PATH = "/login";
export const TRIAL_PATH = "/start-trial";

// Self-service registration / trial activation is NOT implemented yet, so
// every trial CTA says so explicitly and leads to the "coming soon" page
// (TRIAL_PATH). Replace this label when real sign-up ships.
export const TRIAL_CTA_LABEL = "Free Trial — Coming Soon";

// Where an already signed-in user continues from the public site.
export function appHomePath(user) {
  if (!user) return null;
  if (user.role === "admin") return "/admin";
  if (user.role === "client") return "/client";
  return null;
}

export const SECTION_IDS = {
  product: "product",
  channels: "channels",
  howItWorks: "how-it-works",
  features: "features",
  monitoring: "live-monitoring",
  team: "human-ai",
  leads: "leads",
  useCases: "use-cases",
  pricing: "pricing",
  contact: "contact",
};

export const NAV_ITEMS = [
  { label: "Product", section: SECTION_IDS.product },
  { label: "Features", section: SECTION_IDS.features },
  { label: "Pricing", section: SECTION_IDS.pricing },
  {
    label: "Resources",
    children: [
      { label: "How it works", section: SECTION_IDS.howItWorks },
      { label: "Live Monitoring preview", section: SECTION_IDS.monitoring },
      { label: "Use cases", section: SECTION_IDS.useCases },
    ],
  },
  { label: "Contact", section: SECTION_IDS.contact },
];

// Channels Auto Responder supports today.
export const CHANNELS = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "instagram", label: "Instagram" },
  { key: "messenger", label: "Facebook Messenger" },
  { key: "telegram", label: "Telegram" },
  { key: "website", label: "Website Chat" },
];

export const TRIAL_DAYS = 3;
