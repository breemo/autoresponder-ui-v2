import { Link } from "react-router-dom";

export default function AdminSettings() {
  const cards = [
    {
      title: "إعدادات عامة",
      desc: "اسم النظام، اللغة الافتراضية، ومظهر لوحة التحكم",
      icon: "⚙️",
    },
    {
      title: "إعدادات الأمان",
      desc: "الصلاحيات، الجلسات، والوصول الإداري",
      icon: "🔐",
    },
    {
      title: "إعدادات الإشعارات",
      desc: "تنبيهات الرسائل والعملاء والتكاملات",
      icon: "🔔",
    },
    {
      title: "إعدادات النظام",
      desc: "خيارات تشغيل عامة وتجهيزات مستقبلية",
      icon: "🧩",
    },
    {
      title: "WhatsApp Connection Servers",
      desc: "إدارة سيرفرات Evolution API وتوزيع العملاء عليها",
      icon: "💬",
      link: "/admin/settings/whatsapp-servers",
    },
  ];

  return (
    <div className="space-y-5" dir="rtl">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">
          SETTINGS
        </p>

        <h2 className="mt-1 text-2xl font-black text-slate-950">
          إعدادات النظام
        </h2>

        <p className="mt-1 text-sm text-slate-500">
          صفحة إعدادات إدارية جاهزة للتوسع لاحقاً.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.title}
            className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl">
              {card.icon}
            </div>

            <h3 className="font-black text-slate-950">
              {card.title}
            </h3>

            <p className="mt-2 text-sm leading-6 text-slate-500">
              {card.desc}
            </p>

            {card.link ? (
              <Link
                to={card.link}
                className="mt-5 inline-flex h-10 items-center rounded-2xl border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                فتح
              </Link>
            ) : (
              <button className="mt-5 h-10 rounded-2xl border border-slate-200 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50">
                قريباً
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
