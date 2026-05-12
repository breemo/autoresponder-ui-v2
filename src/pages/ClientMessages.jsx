// src/pages/ClientMessages.jsx
import React from "react";

export default function ClientMessages() {
  return (
    <div className="space-y-6">
      {/* العنوان العلوي */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">الرسائل</h1>
        <p className="text-gray-500 text-sm">
          هنا ستظهر كل الرسائل الواردة والصادرة الخاصة بحسابك. (سنربطها
          بالنظام لاحقًا)
        </p>
      </div>

      {/* كرت الفلترة والبحث */}
      <div className="bg-white border shadow-sm rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
        <div className="flex items-center gap-2 text-sm">
          <button className="px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
            الكل
          </button>
          <button className="px-3 py-1.5 rounded-full text-xs font-semibold text-gray-600 hover:bg-gray-100">
            الواردة
          </button>
          <button className="px-3 py-1.5 rounded-full text-xs font-semibold text-gray-600 hover:bg-gray-100">
            الصادرة
          </button>
        </div>

        <div className="md:ml-auto w-full md:w-64">
          <input
            type="text"
            placeholder="بحث في محتوى الرسائل..."
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* كرت جدول الرسائل (placeholder لحد ما نربطه بالـ DB) */}
      <div className="bg-white border shadow-sm rounded-xl">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 text-sm">
            آخر الرسائل
          </h2>
          <span className="text-xs text-gray-400">
            سيتم جلب البيانات من النظام لاحقًا
          </span>
        </div>

        <div className="p-6">
          <div className="border-2 border-dashed border-gray-200 rounded-xl py-10 flex flex-col items-center justify-center text-gray-400 text-sm">
            <span className="text-3xl mb-2">💬</span>
            <p>لا توجد رسائل لعرضها حاليًا.</p>
            <p className="text-xs mt-1">
              عند تفعيل التكامل مع قنواتك، ستظهر الرسائل هنا بشكل مباشر.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
