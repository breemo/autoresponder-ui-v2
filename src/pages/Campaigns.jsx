import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import AdminLayout from "../layouts/AdminLayout";

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [name, setName] = useState("");

  useEffect(() => {
    fetchCampaigns();
  }, []);

  async function fetchCampaigns() {
    let { data } = await supabase.from("campaigns").select("*");
    setCampaigns(data || []);
  }

  async function addCampaign() {
    if (!name.trim()) return;

    await supabase.from("campaigns").insert({ name });
    setName("");
    fetchCampaigns();
  }

  return (
    <AdminLayout>
      <h1 className="text-2xl font-bold mb-4">الحملات</h1>

      <div className="flex gap-4 mb-6">
        <input
          className="border p-2 rounded w-64"
          placeholder="اسم الحملة"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button onClick={addCampaign} className="bg-blue-600 text-white px-4 py-2 rounded">
          إضافة حملة
        </button>
      </div>

      <table className="w-full bg-white shadow rounded">
        <thead>
          <tr className="border-b">
            <th className="p-3">الاسم</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-b">
              <td className="p-3">{c.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminLayout>
  );
}
