import { getSupabaseServerClient } from "./_lib/supabaseServer.js";

const MIN_PASSWORD_LENGTH = 8;

// Self-service password change — used by ClientAccount.jsx, including the
// mandatory first-login flow (must_change_password). Kept as a separate
// endpoint from api/client-users.js because it operates on the caller's
// OWN row only and re-verifies their current password, rather than relying
// on team_management authorization like the team-management actions do.
//
// This re-verification is a real credential check (unlike actor_user_id
// alone elsewhere in this app) — the caller must prove they know the
// current password before it's replaced, regardless of who they claim to
// be in the request body.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const userId = req.body?.user_id;
  const currentPassword = req.body?.current_password;
  const newPassword = req.body?.new_password;
  const confirmPassword = req.body?.confirm_password;

  if (!userId || !currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: "كلمة المرور الجديدة وتأكيدها غير متطابقين" });
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ success: false, message: `يجب أن تتكون كلمة المرور من ${MIN_PASSWORD_LENGTH} أحرف على الأقل` });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, password")
    .eq("id", userId)
    .maybeSingle();

  if (userError || !userRow) {
    return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
  }

  if (userRow.password !== currentPassword) {
    return res.status(401).json({ success: false, message: "كلمة المرور الحالية غير صحيحة" });
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({ success: false, message: "يجب أن تكون كلمة المرور الجديدة مختلفة عن الحالية" });
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({ password: newPassword, must_change_password: false })
    .eq("id", userId);

  if (updateError) {
    return res.status(500).json({ success: false, message: "فشل تحديث كلمة المرور" });
  }

  return res.status(200).json({ success: true, must_change_password: false });
}
