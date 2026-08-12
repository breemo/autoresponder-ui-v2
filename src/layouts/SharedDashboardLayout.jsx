import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRightOnRectangleIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  HomeIcon,
  PuzzlePieceIcon,
  Squares2X2Icon,
  UserCircleIcon,
  UserGroupIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../context/AuthContext.jsx";
import { PERMISSIONS, hasUserPermission } from "../lib/permissions.js";
import { clearSessionExpiry } from "../lib/session.js";
import SubscriptionBanner from "../components/SubscriptionBanner.jsx";

const adminItems = [
  { to: "/admin", label: "نظرة عامة", description: "نظرة عامة", icon: HomeIcon, end: true },
  { to: "/admin/clients", label: "العملاء", description: "إدارة العملاء", icon: UsersIcon },
  { to: "/admin/messages", label: "الرسائل", description: "كل الرسائل", icon: ChatBubbleLeftRightIcon },
  { to: "/admin/auto-replies", label: "الردود التلقائية", description: "الردود", icon: BoltIcon },
  { to: "/admin/plans", label: "الباقات", description: "الباقات", icon: CreditCardIcon },
  { to: "/admin/features", label: "الميزات", description: "الميزات", icon: PuzzlePieceIcon },
  { to: "/admin/settings", label: "الإعدادات", description: "الإعدادات", icon: Cog6ToothIcon },
];

const clientItems = [
  { to: "/client", label: "نظرة عامة", description: "الرئيسية", icon: HomeIcon, end: true, permission: PERMISSIONS.DASHBOARD },
  { to: "/client/messages", label: "المحادثات", description: "إدارة الرسائل", icon: ChatBubbleLeftRightIcon, permission: PERMISSIONS.INBOX },
  { to: "/client/leads", label: "العملاء المحتملون", description: "العملاء المحتملون", icon: ChartBarIcon, permission: PERMISSIONS.LEADS },
  { to: "/client/auto-replies", label: "الردود التلقائية", description: "الردود", icon: BoltIcon, permission: PERMISSIONS.AUTO_REPLIES },
  { to: "/client/quick-replies", label: "الردود السريعة", description: "الردود السريعة", icon: ChatBubbleOvalLeftEllipsisIcon, permission: PERMISSIONS.AUTO_REPLIES },
  { to: "/client/integrations", label: "التكاملات", description: "ربط المنصات", icon: Squares2X2Icon, permission: PERMISSIONS.INTEGRATIONS },
  { to: "/client/feature-settings", label: "إعدادات الميزات", description: "إعدادات الميزات", icon: PuzzlePieceIcon, permission: PERMISSIONS.AI_SETTINGS },
  { to: "/client/team", label: "فريق العمل", description: "فريق العمل", icon: UserGroupIcon, permission: PERMISSIONS.TEAM_MANAGEMENT },
  { to: "/client/settings", label: "الإعدادات", description: "الإعدادات", icon: Cog6ToothIcon, permission: PERMISSIONS.SETTINGS },
  { to: "/client/account", label: "حسابي", description: "حسابي", icon: UserCircleIcon },
];

const pageTitles = {
  "/admin": ["نظرة عامة", "راقب أداء النظام والعملاء من مكان واحد"],
  "/admin/clients": ["العملاء", "إدارة العملاء، الباقات، وحالة التفعيل"],
  "/admin/messages": ["الرسائل", "متابعة الرسائل الواردة والصادرة عبر كل المنصات"],
  "/admin/auto-replies": ["الردود التلقائية", "إدارة الردود التلقائية وقواعد التشغيل"],
  "/admin/plans": ["الباقات", "إدارة الباقات وربط الميزات"],
  "/admin/features": ["الميزات", "إعداد ميزات وقنوات النظام"],
  "/admin/settings": ["الإعدادات", "إعدادات النظام العامة"],
  "/client": ["نظرة عامة", "ملخص نشاط الردود والمحادثات"],
  "/client/messages": ["المحادثات", "إدارة المحادثات والرسائل من مكان واحد"],
  "/client/leads": ["العملاء المحتملون", "أرقام وتفاصيل العملاء المحتملين"],
  "/client/auto-replies": ["الردود التلقائية", "إعداد الردود التلقائية الخاصة بك"],
  "/client/quick-replies": ["الردود السريعة", "إدارة الأزرار والخيارات السريعة"],
  "/client/integrations": ["التكاملات", "ربط Telegram و Facebook وباقي القنوات"],
  "/client/feature-settings": ["إعدادات الميزات", "إعدادات كل ميزة مفعّلة"],
  "/client/team": ["فريق العمل", "إدارة فريق العمل والصلاحيات"],
  "/client/settings": ["الإعدادات", "رسائل الترحيب والإعدادات العامة"],
  "/client/account": ["حسابي", "بياناتك الشخصية وكلمة المرور"],
};

function getPageMeta(pathname, panel) {
  if (pageTitles[pathname]) return pageTitles[pathname];
  if (pathname.startsWith("/admin/client/")) return ["إعدادات العميل", "إدارة إعدادات عميل محدد"];
  if (pathname.startsWith("/admin/plan-features/")) return ["ميزات الباقة", "تحديد ميزات الباقة"];
  return panel === "admin" ? ["بوابة الإدارة", "إدارة النظام"] : ["بوابة المشترك", "لوحة تحكم العميل"];
}

// Pages listed here get a viewport-bound height (instead of the default
// natural page scroll) so they can manage their own internal scroll areas
// (e.g. the Inbox's conversation list / message pane). Opt-in by route only
// — every other page keeps the existing scroll behavior untouched.
const FULL_HEIGHT_ROUTES = ["/client/messages", "/admin/messages"];

export default function SharedDashboardLayout({ children, panel = "client" }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = panel === "admin";
  // Admin nav is unfiltered (unchanged). Client nav items with a
  // `permission` are hidden for members who don't have it — this is
  // presentation only, the actual enforcement is the route guard in
  // App.jsx (a hidden link is not a security boundary by itself). While a
  // mandatory password change is pending, every other item collapses away
  // so the sidebar doesn't show links that would just redirect back.
  const navItems = isAdmin
    ? adminItems
    : user?.must_change_password
    ? clientItems.filter((item) => item.to === "/client/account")
    : clientItems.filter((item) => !item.permission || hasUserPermission(user, item.permission));
  const displayName = user?.business_name || user?.name || (isAdmin ? "Admin" : "Client");
  const [title, subtitle] = getPageMeta(location.pathname, panel);
  const fullHeight = FULL_HEIGHT_ROUTES.includes(location.pathname);

  function logout() {
    localStorage.removeItem("user");
    clearSessionExpiry();
    setUser(null);
    navigate("/");
  }

  return (
    <div className={`bg-[#F5F7FB] text-slate-900 ${fullHeight ? "h-screen overflow-hidden" : "min-h-screen"}`}>
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-72 flex-col border-r border-slate-800/80 bg-[#0F172A] text-slate-100 lg:flex">
        <div className="flex h-20 items-center gap-3 border-b border-slate-800 px-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-950/30">
            <ChatBubbleLeftRightIcon className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">AutoResponder</h1>
            <p className="text-xs text-slate-400">{isAdmin ? "Admin Console" : "Client Workspace"}</p>
          </div>
        </div>

        <div className="border-b border-slate-800 px-5 py-4">
          <div className="rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/5">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Workspace</p>
            <p className="mt-2 truncate text-sm font-semibold text-white">{displayName}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{user?.email || "autoresponder.ai"}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `group flex items-center gap-3 rounded-2xl px-3 py-3 text-sm transition-all duration-200 ${
                    isActive
                      ? "bg-white text-slate-950 shadow-sm"
                      : "text-slate-400 hover:bg-slate-800/80 hover:text-white"
                  }`
                }
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-300 transition group-hover:bg-slate-700 group-hover:text-white">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium leading-5">{item.label}</span>
                  <span className="block truncate text-xs text-slate-500 group-hover:text-slate-300">{item.description}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <button
            onClick={logout}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 px-4 py-3 text-sm font-medium text-slate-300 transition hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-200"
          >
            <ArrowRightOnRectangleIcon className="h-5 w-5" />
            تسجيل الخروج
          </button>
        </div>
      </aside>

      <div className={`lg:pl-72 ${fullHeight ? "flex h-full flex-col" : ""}`}>
        <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur-xl">
          <div className="flex min-h-20 items-center justify-between gap-4 px-5 py-4 md:px-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-indigo-600">
                {isAdmin ? "بوابة الإدارة" : "بوابة المشترك"}
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
              <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
            </div>

            <div className="hidden items-center gap-3 md:flex">
              <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 shadow-sm">
                مرحباً، <span className="font-semibold text-slate-800">{displayName}</span>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-600 ring-1 ring-indigo-100">
                {(displayName || "A").slice(0, 1).toUpperCase()}
              </div>
            </div>
          </div>
        </header>

        <main className={fullHeight ? "flex min-h-0 flex-1 flex-col px-4 py-5 md:px-6 lg:px-8 lg:py-6" : "min-h-[calc(100vh-5rem)] px-4 py-5 md:px-6 lg:px-8 lg:py-6"}>
          <div className={`mx-auto w-full max-w-[1800px] animate-[fadeIn_.2s_ease-out] ${fullHeight ? "flex min-h-0 flex-1 flex-col" : ""}`}>
            {!isAdmin && <SubscriptionBanner />}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
