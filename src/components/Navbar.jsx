import React from "react";
import { Link, useNavigate } from "react-router-dom";

export default function Navbar() {
  const navigate = useNavigate();

  const logout = () => {
    localStorage.removeItem("user");
    navigate("/");
  };

  return (
    <nav className="bg-white shadow px-6 py-4 flex justify-between items-center">
      <h2 className="text-xl font-bold text-blue-600">AutoResponder Admin</h2>

      <div className="flex gap-6 text-gray-700 font-medium">
        <Link to="/admin" className="hover:text-blue-600">الرئيسية</Link>
        <Link to="/admin/users" className="hover:text-blue-600">المستخدمين</Link>
        <Link to="/admin/logs" className="hover:text-blue-600">السجلات</Link>
        <Link to="/admin/settings" className="hover:text-blue-600">الإعدادات</Link>

        <button
          onClick={logout}
          className="bg-red-500 hover:bg-red-600 text-white px-4 py-1 rounded"
        >
          تسجيل خروج
        </button>
      </div>
    </nav>
  );
}
