import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function ManageUsers() {
  const [users, setUsers] = useState([]);

  const fetchUsers = async () => {
    const { data, error } = await supabase.from("users").select("*");
    if (error) console.error("خطأ:", error.message);
    else setUsers(data);
  };

  const deleteUser = async (id) => {
    if (!window.confirm("هل أنت متأكد من حذف هذا المستخدم؟")) return;
    await supabase.from("users").delete().eq("id", id);
    fetchUsers();
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold text-gray-800 mb-6">
        👥 إدارة المستخدمين
      </h2>

      <table className="w-full bg-white shadow-md rounded-xl overflow-hidden">
        <thead className="bg-blue-600 text-white">
          <tr>
            <th className="py-3 px-4 text-left">الاسم</th>
            <th className="py-3 px-4 text-left">البريد الإلكتروني</th>
            <th className="py-3 px-4 text-left">الدور</th>
            <th className="py-3 px-4 text-left">إجراء</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b hover:bg-gray-50">
              <td className="py-3 px-4">{u.name}</td>
              <td className="py-3 px-4">{u.email}</td>
              <td className="py-3 px-4">{u.role}</td>
              <td className="py-3 px-4">
                <button
                  onClick={() => deleteUser(u.id)}
                  className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                >
                  حذف
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
