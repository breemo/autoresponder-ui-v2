import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../context/AuthContext";
import { writeSessionExpiry } from "../lib/session.js";

export default function Login() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const { t } = useTranslation();

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
    setMessage(t("login.errorInvalidCredentials"));
    return;
  }

  // 🔍 1) نجلب عضوية العميل من جدول client_users (مش عن طريق مطابقة الإيميل)
  let finalUser = { ...user };

  if (user.role === "client") {
    const { data: membership, error: membershipError } = await supabase
      .from("client_users")
      .select("client_id, role, is_active, permissions_overrides, clients(id, business_name, email)")
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError || !membership) {
      setMessage(t("login.errorNoMembership"));
      return;
    }

    if (membership.is_active === false) {
      setMessage(t("login.errorAccountDisabled"));
      return;
    }

    // 🧠 2) ندمج ال user مع بيانات العضوية بحيث يصير عنده client_id ودوره
    finalUser = {
      ...user,
      client_id: membership.client_id,
      business_name: membership.clients?.business_name || null,
      client_role: membership.role,
      is_active: membership.is_active,
      permissions_overrides: membership.permissions_overrides,
    };

    // Best-effort UI-language fetch — completely separate from AI/customer
    // language, this only resolves which language the PORTAL itself
    // renders in for this account (see LanguageContext.jsx for the
    // resolution order). Both columns are new/optional and may not exist
    // yet if the language migration hasn't been applied — caught and
    // silently ignored so login never breaks because of this, exactly like
    // the last_login_at best-effort update below.
    try {
      const { data: langRow } = await supabase
        .from("client_users")
        .select("language, clients(default_language)")
        .eq("user_id", user.id)
        .maybeSingle();

      finalUser.ui_language_user = langRow?.language || null;
      finalUser.ui_language_client = langRow?.clients?.default_language || null;
    } catch (langErr) {
      // Column(s) not present yet, or any other failure — language simply
      // falls back to the system default; never blocks login.
    }
  }

  // 💾 3) نخزن البيانات الصحيحة للـ user
  localStorage.setItem("user", JSON.stringify(finalUser));
  writeSessionExpiry();
  setUser(finalUser);

  // Best-effort last-login stamp (shown on the client Team page). Not
  // awaited/blocking — a failure here must never prevent login.
  supabase.from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id).then(
    () => {},
    () => {}
  );

  setMessage(user.role === "admin" ? t("login.successAdmin") : t("login.successClient"));

  setTimeout(() => {
    navigate(user.role === "admin" ? "/admin" : "/client");
  }, 500);
};


  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={handleLogin}
        dir="rtl"
        className="bg-white shadow-md rounded-lg px-8 py-6 w-96 border border-gray-100"
      >
        <h2 className="text-2xl font-bold mb-4 text-center text-blue-600">
          {t("login.title")}
        </h2>

        {message && (
          <p className="text-center mb-3 text-green-600 font-medium">
            {message}
          </p>
        )}

        <input
          type="email"
          placeholder={t("login.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-3 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          required
        />

        <input
          type="password"
          placeholder={t("login.passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          required
        />

        <button
          type="submit"
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition-all"
        >
          {t("login.submit")}
        </button>
      </form>
    </div>
  );
}
