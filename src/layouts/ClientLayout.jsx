// src/layouts/ClientLayout.jsx
import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { ChartBarIcon } from "@heroicons/react/24/outline";

import {
  HomeIcon,
  ChatBubbleLeftRightIcon,
  ArrowRightOnRectangleIcon,
  Cog6ToothIcon,
  BoltIcon,ChatBubbleOvalLeftEllipsisIcon
} from "@heroicons/react/24/outline";

const menuItems = [
  {
    to: "/client",
    label: "الصفحة الرئيسية",
    key: "dashboard",
    icon: <HomeIcon className="w-5 h-5" />,
  },
  {
    to: "/client/messages",
    label: "الرسائل",
    key: "messages",
    icon: <ChatBubbleLeftRightIcon className="w-5 h-5" />,
  },
  {
    to: "/client/leads",
    label: "ارقام التواصل للزبائن",
    key: "leads",
    icon: <ChartBarIcon className="w-5 h-5" />,
  },
  {
    to: "/client/auto-replies",
    label: "الردود التلقائية",
    key: "auto-replies",
    icon: <BoltIcon className="w-5 h-5" />,
  },
  { to: "/client/integrations", label: "ربط المنصات" },
  { label: "إعدادات الميزات", to: "/client/feature-settings",},
  {
    to: "/client/quick-replies",
    label: "الخيارات السريعة",
    key: "quick-replies",
    icon: <ChatBubbleOvalLeftEllipsisIcon className="w-5 h-5" />,
  },
  {
    to: "/client/settings",
    label: "الإعدادات",
    key: "settings",
    icon: <Cog6ToothIcon className="w-5 h-5" />,
  },
];

export default function ClientLayout({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  function logout() {
    localStorage.removeItem("user");
    setUser(null);
    navigate("/");
  }

  const displayName = user?.business_name || user?.name || "العميل";

  return (
    <div className="min-h-screen flex bg-gray-100">

      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-sm border-l border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="px-6 py-6 border-b border-gray-100">
          <h1 className="text-xl font-bold text-blue-600">AutoResponder</h1>
          <p className="text-sm text-gray-500 mt-1">Client Panel</p>

          <div className="mt-4">
            <p className="font-semibold text-gray-800 text-sm">{displayName}</p>
            <p className="text-xs text-gray-500 truncate">{user?.email}</p>
          </div>
        </div>

        {/* Menu */}
        <nav className="flex-1 px-3 py-5 space-y-1">
          {menuItems.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.to === "/client"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
                ${
                  isActive
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-gray-100"
                }`
              }
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Logout */}
        <div className="px-4 py-4 border-t border-gray-200">
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
          >
            <ArrowRightOnRectangleIcon className="w-5 h-5" />
            تسجيل الخروج
          </button>
        </div>
      </aside>

      {/* Main Area */}
      <div className="flex-1 flex flex-col">

        {/* Top bar (ثابت وأنيق) */}
        <header className="h-16 bg-white shadow-sm border-b border-gray-200 flex items-center justify-between px-6">
          <div>
            <h2 className="text-lg font-bold text-gray-800">
              مرحباً، {displayName} 👋
            </h2>
            <p className="text-xs text-gray-500">لوحة تحكم العميل</p>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
