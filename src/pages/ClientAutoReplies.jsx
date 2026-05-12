// src/pages/ClientAutoReplies.jsx
import React from "react";

export default function ClientAutoReplies() {
  return (
    <div className="space-y-6">
      {/* العنوان العلوي */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">
          الردود التلقائية
        </h1>
        <p className="text-gray-500 text-sm">
          أنشئ وردّدّل الردود التلقائية التي يرد بها النظام على رسائلك. حالياً
          هذه الصفحة شكل فقط، وسنربطها بالـ API لاحقاً.
        </p>
      </div>

      {/* كرت إضافة رد تلقائي */}
      <div className="bg-white border shadow-sm rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 text-sm">
            إضافة رد تلقائي جديد
          </h2>
          <span className="text-xs text-amber-500 font-medium">
            (تجريبي – بدون حفظ فعلي حالياً)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="md:col-span-1">
            <label className="block mb-1 text-gray-600 text-xs">
              نص التفعيل (Trigger)
            </label>
            <input
              type="text"
              placeholder='مثال: "مرحبا" أو "hi"'
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block mb-1 text-gray-600 text-xs">
              نص الرد التلقائي
            </label>
            <textarea
              rows={2}
              placeholder="الرد الذي سيتم إرساله تلقائياً عند مطابقة التفعيل..."
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button className="px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            حفظ (قريباً)
          </button>
        </div>
      </div>

      {/* كرت قائمة الردود (placeholder) */}
      <div className="bg-white border shadow-sm rounded-xl">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 text-sm">
            الردود التلقائية الحالية
          </h2>
          <span className="text-xs text-gray-400">
            سيتم جلب الردود من قاعدة البيانات لاحقاً
          </span>
        </div>

        <div className="p-6">
          <div className="border-2 border-dashed border-gray-200 rounded-xl py-10 flex flex-col items-center justify-center text-gray-400 text-sm">
            <span className="text-3xl mb-2">⚡</span>
            <p>لا توجد ردود تلقائية مضافة حتى الآن.</p>
            <p className="text-xs mt-1">
              عند تفعيل التخزين، ستظهر قائمة الردود هنا مع إمكانية التعديل
              والتعطيل.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
