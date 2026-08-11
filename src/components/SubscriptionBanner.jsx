import React, { useEffect, useState } from "react";
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
    <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 sm:flex-row sm:items-center sm:justify-between" dir="rtl">
      <div className="flex items-start gap-2">
        <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
        <p>
          اشتراكك غير نشط أو منتهي. يمكنك الاستمرار في عرض بياناتك، لكن إجراءات الخدمة (إرسال الردود، إضافة أرقام/تكاملات جديدة)
          معطّلة حتى تجديد الاشتراك.
        </p>
      </div>
      {/* Placeholder for a future "Renew Subscription" / payment-gateway action. */}
      <button
        type="button"
        disabled
        title="سيتم تفعيل هذا الخيار مع بوابة الدفع القادمة"
        className="shrink-0 cursor-not-allowed rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-700 opacity-70"
      >
        تجديد الاشتراك (قريباً)
      </button>
    </div>
  );
}
