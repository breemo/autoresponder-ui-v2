import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

const handleLogin = async (e) => {
  e.preventDefault();

  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .eq("password", password)
    .single();

  if (error || !user) {
    setMessage("❌ البريد الإلكتروني أو كلمة المرور غير صحيحة");
    return;
  }

  // 🔍 1) نجلب بيانات العميل من جدول clients
  let clientData = null;
  if (user.role === "client") {
    const { data: cData } = await supabase
      .from("clients")
      .select("id, business_name, email")
      .eq("email", user.email)
      .single();

    clientData = cData;
  }

  // 🧠 2) ندمج ال user مع clientData بحيث يصير عنده client_id
  const finalUser = {
    ...user,
    client_id: clientData?.id || null,
    business_name: clientData?.business_name || null,
  };

  // 💾 3) نخزن البيانات الصحيحة للـ user
  localStorage.setItem("user", JSON.stringify(finalUser));
  setUser(finalUser);

  setMessage(`✅ مرحبًا ${user.role === "admin" ? "بالمدير" : "بالعميل"}!`);

  setTimeout(() => {
    navigate(user.role === "admin" ? "/admin" : "/client");
  }, 500);
};


  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={handleLogin}
        className="bg-white shadow-md rounded-lg px-8 py-6 w-96 border border-gray-100"
      >
        <h2 className="text-2xl font-bold mb-4 text-center text-blue-600">
          Auto Responder Login
        </h2>

        {message && (
          <p className="text-center mb-3 text-green-600 font-medium">
            {message}
          </p>
        )}

        <input
          type="email"
          placeholder="البريد الإلكتروني"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-3 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          required
        />

        <input
          type="password"
          placeholder="كلمة المرور"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          required
        />

        <button
          type="submit"
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition-all"
        >
          تسجيل الدخول
        </button>
      </form>
    </div>
  );
}
