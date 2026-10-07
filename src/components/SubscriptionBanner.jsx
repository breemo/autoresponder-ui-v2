import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthContext.jsx";

// Non-destructive, read-only notice shown across the Client Portal when the
// client's subscription is inactive/expired. Never blocks rendering of the
// page itself — read access is always retained.
//
// This is informational/UX only, not an authorization boundary. The
// authoritative decision on whether service actions (sending, automation)
// are allowed is made by n8n at message-processing time, against the same
// `subscriptions` data — see
// supabase/migrations/20260814_client_subscription_status_view.sql for the
// architecture note.
export default function SubscriptionBanner() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [status, setStatus] = useState(null); // null = unknown/loading, avoids flashing the banner

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      if (!user?.client_id) return;

      const { data, error } = await supabase
        .from("client_subscription_status")
        .select("is_active, status, end_date")
        .eq("client_id", user.client_id)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        console.error(error);
        return;
      }

      // No subscription row at all → treat as active/unrestricted rather
      // than showing an inactive banner for a client who was simply never
      // assigned a subscription (plans are optional at client creation).
      setStatus(data || { is_active: true, status: null, end_date: null });
    }

    loadStatus();
    return () => {
      cancelled = true;
    };
  }, [user?.client_id]);

  if (!user || user.role !== "client") return null;
  if (!status || status.is_active) return null;

  return (
    <div className="mb-3 flex shrink-0 items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 sm:text-sm">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ExclamationTriangleIcon className="mt-px h-4 w-4 shrink-0" />
        <p className="min-w-0">
          {t("subscriptionBanner.message")}
        </p>
      </div>
      {/* Placeholder for a future "Renew Subscription" / payment-gateway action. */}
      <button
        type="button"
        disabled
        title={t("subscriptionBanner.renewButtonTitle")}
        className="shrink-0 cursor-not-allowed rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-700 opacity-70"
      >
        {t("subscriptionBanner.renewButton")}
      </button>
    </div>
  );
}
