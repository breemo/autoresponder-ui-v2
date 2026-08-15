import React from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext.jsx";
import AdminClientSettings from "../admin/AdminClientSettings.jsx";

export default function ClientFeatureSettings() {
  const { user } = useAuth();
  const { t } = useTranslation();

  // حماية الصفحة
  if (!user || user.role !== "client") {
    return (
      <p className="text-red-500">
        {t("featureSettingsPage.unauthorized")}
      </p>
    );
  }

  // client_id يأتي من عضوية client_users المحلولة عند تسجيل الدخول
  // (وليس بمطابقة الإيميل، لأن أكثر من مستخدم قد ينتمي لنفس العميل الآن).
  const clientId = user.client_id;

  if (!clientId) {
    return <p className="text-red-500">{t("featureSettingsPage.noClientLinked")}</p>;
  }

  return <AdminClientSettings clientIdOverride={clientId} />;
}
