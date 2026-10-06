import qrcode from "qrcode-generator";

// Telegram activation QR — pure matrix builder (no DOM, no network).
// Encodes EXACTLY the string it is given (the already-built setWebhook
// activation URL). The activation URL contains the Bot Token, so callers
// render the matrix on demand into an in-memory canvas only: no external
// QR service, no image/data URL persisted, no download, no logging.
export function buildQrMatrix(text) {
  if (typeof text !== "string" || !text) return null;
  const qr = qrcode(0, "M"); // type 0 = smallest version that fits
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < size; r += 1) {
    const row = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { size, modules };
}
