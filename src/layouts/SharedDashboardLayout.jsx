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
  UserGroupIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../context/AuthContext.jsx";

const adminItems = [
  { to: "/admin", label: "Dashboard", description: "نظرة عامة", icon: HomeIcon, end: true },
  { to: "/admin/clients", label: "Clients", description: "إدارة العملاء", icon: UsersIcon },
  { to: "/admin/messages", label: "Messages", description: "كل الرسائل", icon: ChatBubbleLeftRightIcon },
  { to: "/admin/auto-replies", label: "Auto Replies", description: "الردود", icon: BoltIcon },
  { to: "/admin/plans", label: "Plans", description: "الباقات", icon: CreditCardIcon },
  { to: "/admin/features", label: "Features", description: "الميزات", icon: PuzzlePieceIcon },
  { to: "/admin/settings", label: "Settings", description: "الإعدادات", icon: Cog6ToothIcon },
];

const clientItems = [
  { to: "/client", label: "Dashboard", description: "الرئيسية", icon: HomeIcon, end: true },
  { to: "/client/messages", label: "Inbox", description: "المحادثات", icon: ChatBubbleLeftRightIcon },
  { to: "/client/leads", label: "Leads", description: "أرقام الزبائن", icon: ChartBarIcon },
  { to: "/client/auto-replies", label: "Auto Replies", description: "الردود", icon: BoltIcon },
  { to: "/client/quick-replies", label: "Quick Replies", description: "الأزرار السريعة", icon: ChatBubbleOvalLeftEllipsisIcon },
  { to: "/client/integrations", label: "Integrations", description: "ربط المنصات", icon: Squares2X2Icon },
  { to: "/client/feature-settings", label: "Feature Settings", description: "إعدادات الميزات", icon: PuzzlePieceIcon },
  { to: "/client/settings", label: "Settings", description: "الإعدادات", icon: Cog6ToothIcon },
];

const pageTitles = {
  "/admin": ["Dashboard", "راقب أداء النظام والعملاء من مكان واحد"],
  "/admin/clients": ["Clients", "إدارة العملاء، الباقات، وحالة التفعيل"],
  "/admin/messages": ["Messages", "متابعة الرسائل الواردة والصادرة عبر كل المنصات"],
  "/admin/auto-replies": ["Auto Replies", "إدارة الردود التلقائية وقواعد التشغيل"],
  "/admin/plans": ["Plans", "إدارة الباقات وربط الميزات"],
  "/admin/features": ["Features", "إعداد ميزات وقنوات النظام"],
  "/admin/settings": ["Settings", "إعدادات النظام العامة"],
  "/client": ["Dashboard", "ملخص نشاط الردود والمحادثات"],
  "/client/messages": ["Inbox", "إدارة المحادثات والرسائل من مكان واحد"],
  "/client/leads": ["Leads", "أرقام وتفاصيل العملاء المهتمين"],
  "/client/auto-replies": ["Auto Replies", "إعداد الردود التلقائية الخاصة بك"],
  "/client/quick-replies": ["Quick Replies", "إدارة الأزرار والخيارات السريعة"],
  "/client/integrations": ["Integrations", "ربط Telegram و Facebook وباقي القنوات"],
  "/client/feature-settings": ["Feature Settings", "إعدادات كل ميزة مفعلة"],
  "/client/settings": ["Settings", "رسائل الترحيب والإعدادات العامة"],
};

function getPageMeta(pathname, panel) {
  if (pageTitles[pathname]) return pageTitles[pathname];
  if (pathname.startsWith("/admin/client/")) return ["Client Settings", "إدارة إعدادات عميل محدد"];
  if (pathname.startsWith("/admin/plan-features/")) return ["Plan Features", "تحديد ميزات الباقة"];
  return panel === "admin" ? ["Admin Panel", "إدارة النظام"] : ["Client Panel", "لوحة تحكم العميل"];
}

export default function SharedDashboardLayout({ children, panel = "client" }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = panel === "admin";
  const navItems = isAdmin ? adminItems : clientItems;
  const displayName = user?.business_name || user?.name || (isAdmin ? "Admin" : "Client");
  const [title, subtitle] = getPageMeta(location.pathname, panel);

  function logout() {
    localStorage.removeItem("user");
    setUser(null);
    navigate("/");
  }

  return (
    <div className="min-h-screen bg-[#F5F7FB] text-slate-900">
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

      <div className="lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-xl">
          <div className="flex min-h-20 items-center justify-between gap-4 px-5 py-4 md:px-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-indigo-600">
                {isAdmin ? "Admin" : "Client"} Portal
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

        <main className="min-h-[calc(100vh-5rem)] px-4 py-5 md:px-6 lg:px-8 lg:py-6">
          <div className="mx-auto w-full max-w-[1800px] animate-[fadeIn_.2s_ease-out]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
