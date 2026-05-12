// src/pages/ClientSettings.jsx
import React from "react";

export default function ClientSettings() {
  return (
    <div className="space-y-6">
      {/* العنوان العلوي */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">إعدادات العميل</h1>
        <p className="text-gray-500 text-sm">
          هنا يمكنك ضبط إعدادات التكامل (Webhook / API / SMTP) الخاصة بحسابك.
          حالياً هي واجهة شكلية لتجهيز التصميم، وسنربطها بالـ Back-end لاحقاً.
        </p>
      </div>

      {/* كرت الإعدادات */}
      <div className="bg-white border shadow-sm rounded-xl p-6 space-y-6">
        {/* Webhook / API */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-800 text-sm">
            إعدادات التكامل (API / Webhook)
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                Webhook URL
              </label>
              <input
                type="text"
                placeholder="https://example.com/webhook"
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                API Key (للقراءة فقط مستقبلاً)
              </label>
              <input
                type="text"
                placeholder="سيتم توليد الـ API Key تلقائياً"
                className="w-full border rounded-lg px-3 py-2 bg-gray-50 text-gray-400 cursor-not-allowed"
                disabled
              />
            </div>
          </div>
        </section>

        <hr className="border-dashed" />

        {/* SMTP */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-800 text-sm">
            إعدادات البريد (SMTP)
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                SMTP Host
              </label>
              <input
                type="text"
                placeholder="smtp.mailserver.com"
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                SMTP Port
              </label>
              <input
                type="number"
                placeholder="587"
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                SMTP User
              </label>
              <input
                type="text"
                placeholder="user@example.com"
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <label className="block mb-1 text-gray-600 text-xs">
                SMTP Password
              </label>
              <input
                type="password"
                placeholder="••••••••"
                className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" className="rounded border-gray-300" />
                <span>استخدام TLS / STARTTLS إذا توفّر</span>
              </label>
            </div>
          </div>
        </section>

        <div className="flex justify-end">
          <button className="px-5 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            حفظ الإعدادات (قريباً)
          </button>
        </div>
      </div>
    </div>
  );
}
