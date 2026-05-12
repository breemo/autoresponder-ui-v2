import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function MessagesLog() {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    fetchMessages();
  }, []);

  const fetchMessages = async () => {
    const { data, error } = await supabase
      .from("messages")
      .select("id, sender_id, receiver_id, content, created_at");
    if (error) console.error(error);
    else setMessages(data);
  };

  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold text-gray-800 mb-6">
        💬 سجل الرسائل
      </h2>

      <div className="bg-white shadow-md rounded-xl p-4">
        <table className="w-full">
          <thead className="bg-blue-600 text-white">
            <tr>
              <th className="py-2 px-3">المرسل</th>
              <th className="py-2 px-3">المستقبل</th>
              <th className="py-2 px-3">المحتوى</th>
              <th className="py-2 px-3">التاريخ</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className="border-b hover:bg-gray-50">
                <td className="py-2 px-3">{m.sender_id}</td>
                <td className="py-2 px-3">{m.receiver_id}</td>
                <td className="py-2 px-3">{m.content}</td>
                <td className="py-2 px-3 text-gray-500">
                  {new Date(m.created_at).toLocaleString("ar-EG")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
