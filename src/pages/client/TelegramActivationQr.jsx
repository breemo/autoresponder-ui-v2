import React, { useEffect, useRef, useState } from "react";
import { QrCodeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { buildQrMatrix } from "../../lib/telegramActivationQr.js";

// Telegram activation QR — shown ON DEMAND inside the authenticated
// Integrations page only. It encodes EXACTLY the activation URL the page
// already built (passed in, never rebuilt here). That URL contains the
// Bot Token, so:
//   - generated client-side (qrcode-generator) — no external QR service;
//   - drawn into an in-memory <canvas> — no image/data URL is created,
//     stored, uploaded or offered for download, nothing is logged;
//   - cleared and unmounted on close, when the activation URL changes, or
//     when the page unmounts.

const CELL = 6; // px per module
const MARGIN = 4; // quiet zone, in modules

export default function TelegramActivationQr({ activationUrl }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const canvasRef = useRef(null);

  // A different integration/token/webhook -> hide the previous QR.
  useEffect(() => {
    setOpen(false);
  }, [activationUrl]);

  useEffect(() => {
    if (!open) return undefined;
    const canvas = canvasRef.current;
    const matrix = buildQrMatrix(activationUrl);
    if (!canvas || !matrix) return undefined;
    const px = (matrix.size + MARGIN * 2) * CELL;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < matrix.size; r += 1) {
      for (let c = 0; c < matrix.size; c += 1) {
        if (matrix.modules[r][c]) ctx.fillRect((c + MARGIN) * CELL, (r + MARGIN) * CELL, CELL, CELL);
      }
    }
    return () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [open, activationUrl]);

  if (!activationUrl) return null;

  return (
    <div className="mt-2">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
        >
          <QrCodeIcon className="h-4 w-4" />
          {t("integrationsPage.showActivationQr")}
        </button>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] leading-5 text-amber-800">{t("integrationsPage.activationQrWarning")}</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              <XMarkIcon className="h-4 w-4" />
              {t("integrationsPage.hideActivationQr")}
            </button>
          </div>
          <div className="mt-3 flex justify-center">
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t("integrationsPage.activationQrAlt")}
              className="h-auto w-56 max-w-full rounded-lg bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
