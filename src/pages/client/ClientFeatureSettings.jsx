import React, { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";
import { supabase } from "../../lib/supabaseClient.js";
import AdminClientSettings from "../admin/AdminClientSettings.jsx";

export default function ClientFeatureSettings() {
  const { user } = useAuth();

  const [clientId, setClientId] = useState(null);
  const [error, setError] = useState("");

  // حماية الصفحة
  if (!user || user.role !== "client") {
    return (
      <p className="text-red-500">
        غير مصرح لك بالدخول إلى هذه الصفحة.
      </p>
    );
  }

  // --------------------------------------------------
  // 1) جلب بيانات العميل عبر الإيميل
  // --------------------------------------------------
  useEffect(() => {
    async function loadClient() {
      const { data: client, error } = await supabase
        .from("clients")
        .select("*")
        .eq("email", user.email)
        .single();

      if (error || !client) {
        setError("⚠️ لا يوجد حساب عميل مرتبط بهذا المستخدم");
        return;
      }

      setClientId(client.id);
    }

    loadClient();
  }, [user.email]);

  // --------------------------------------------------
  // 2) معالجة حالة عدم إيجاد العميل
  // --------------------------------------------------
  if (error) {
    return <p className="text-red-500">{error}</p>;
  }

  if (!clientId) {
    return <p>جاري تحميل بيانات العميل...</p>;
  }

  // --------------------------------------------------
  // 3) إعادة استخدام صفحة إعدادات الأدمن
  // --------------------------------------------------
  return <AdminClientSettings clientIdOverride={clientId} />;
}
