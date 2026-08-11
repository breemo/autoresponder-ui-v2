import React from "react";
import { useAuth } from "../../context/AuthContext.jsx";
import AdminClientSettings from "../admin/AdminClientSettings.jsx";

export default function ClientFeatureSettings() {
  const { user } = useAuth();

  // حماية الصفحة
  if (!user || user.role !== "client") {
    return (
      <p className="text-red-500">
        غير مصرح لك بالدخول إلى هذه الصفحة.
      </p>
    );
  }

  // client_id يأتي من عضوية client_users المحلولة عند تسجيل الدخول
  // (وليس بمطابقة الإيميل، لأن أكثر من مستخدم قد ينتمي لنفس العميل الآن).
  const clientId = user.client_id;

  if (!clientId) {
    return <p className="text-red-500">⚠️ لا يوجد حساب عميل مرتبط بهذا المستخدم</p>;
  }

  return <AdminClientSettings clientIdOverride={clientId} />;
}
