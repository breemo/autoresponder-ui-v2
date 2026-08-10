import { getSupabaseServerClient } from "./_lib/supabaseServer.js";

// Deliberately scoped to a single allowlisted key so this endpoint can never
// be used to read/write unrelated rows in system_settings (e.g. future
// secrets), even if the table grows later.
const SETTING_KEY = "human_reply_webhook_url";

export default async function handler(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", SETTING_KEY)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, message: "Failed to load setting" });
    }

    return res.status(200).json({
      success: true,
      human_reply_webhook_url: data?.value || "",
    });
  }

  if (req.method === "POST" || req.method === "PUT") {
    const rawValue = req.body?.human_reply_webhook_url;
    const value = typeof rawValue === "string" ? rawValue.trim() : "";

    if (!value) {
      return res.status(400).json({ success: false, message: "human_reply_webhook_url is required" });
    }

    const { error } = await supabase
      .from("system_settings")
      .update({ value })
      .eq("key", SETTING_KEY);

    if (error) {
      return res.status(500).json({ success: false, message: "Failed to save setting" });
    }

    return res.status(200).json({ success: true, human_reply_webhook_url: value });
  }

  return res.status(405).json({ success: false, message: "Method not allowed" });
}
