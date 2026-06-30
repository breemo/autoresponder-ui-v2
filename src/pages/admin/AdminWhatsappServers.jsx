export default function AdminWhatsappServers() {
  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">
            SETTINGS
          </p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">
            WhatsApp Connection Servers
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            إدارة سيرفرات Evolution API المستخدمة لربط عملاء Jawab AI.
          </p>
        </div>

        <button className="rounded-2xl bg-indigo-600 px-5 py-2.5 font-bold text-white hover:bg-indigo-700">
          + Add Server
        </button>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-4 text-right">Name</th>
              <th className="p-4 text-right">Base URL</th>
              <th className="p-4 text-center">Status</th>
              <th className="p-4 text-center">Clients</th>
              <th className="p-4 text-center">Priority</th>
              <th className="p-4 text-center">Actions</th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td className="p-4">لا يوجد سيرفرات حالياً</td>
              <td colSpan="5"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
