import { getSupabaseServerClient } from "./_lib/supabaseServer.js";

const SETTING_KEY = "human_reply_webhook_url";

// Thin proxy to the n8n Human Reply workflow, following the same
// fetch-and-relay shape as api/create-whatsapp-instance.js. n8n resolves
// client/channel/integration from conversation_id and owns both channel
// delivery and the outbound Supabase insert — this endpoint does neither.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const conversation_id = req.body?.conversation_id;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  // Future: an authenticated user-identity field (e.g. sent_by_user_id) can
  // be added to this payload once client multi-user support exists, without
  // changing the shape of this handler.

  if (!conversation_id || !message) {
    return res.status(400).json({
      success: false,
      message: "conversation_id and message are required",
    });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const { data: setting, error: settingError } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const webhookUrl = setting?.value;

  if (settingError || !webhookUrl) {
    return res.status(500).json({
      success: false,
      message: "Human reply webhook is not configured",
    });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversation_id, message }),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reach human reply workflow",
    });
  }
}
