import React, { useEffect, useId, useRef, useState } from "react";
import { QrCodeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";
import { buildQrMatrix } from "../../lib/telegramActivationQr.js";

// Telegram activation QR — shown ON DEMAND, in an accessible modal dialog,
// inside the authenticated Integrations page only. It encodes EXACTLY the
// activation URL the page already built (passed in, never rebuilt here).
// That URL contains the Bot Token, so:
//   - generated client-side (qrcode-generator) — no external QR service;
//   - drawn into an in-memory <canvas> only while the dialog is open — no
//     image/data URL is created, stored, uploaded or offered for download,
//     nothing is logged;
//   - cleared and unmounted on close (✕, backdrop, Esc), when the activation
//     URL changes, or when the page unmounts.

const CELL = 8; // px per module (rendered at ~288-320px for reliable scanning)
const MARGIN = 4; // quiet zone, in modules

export default function TelegramActivationQr({ activationUrl }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const canvasRef = useRef(null);
  const closeRef = useRef(null);
  const triggerRef = useRef(null);
  const titleId = useId();

  // A different integration/token/webhook -> close the previous QR.
  useEffect(() => {
    setOpen(false);
  }, [activationUrl]);

  // Draw only while open; clear on close/unmount.
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

  // Dialog keyboard handling: Esc closes; focus moves into the dialog and
  // returns to the trigger on close.
  useEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "Tab") {
        // single focusable control inside the dialog -> keep focus there
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  if (!activationUrl) return null;

  return (
    <div className="mt-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
      >
        <QrCodeIcon className="h-4 w-4" />
        {t("integrationsPage.showActivationQr")}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-[calc(100%-2rem)] max-w-sm rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-base font-bold text-slate-950">
                {t("integrationsPage.activationQrAlt")}
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
              >
                <XMarkIcon className="h-4 w-4" />
                {t("integrationsPage.hideActivationQr")}
              </button>
            </div>
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-5 text-amber-800">
              {t("integrationsPage.activationQrWarning")}
            </p>
            <div className="mt-4 flex justify-center">
              <canvas
                ref={canvasRef}
                role="img"
                aria-label={t("integrationsPage.activationQrAlt")}
                className="h-auto w-72 max-w-full rounded-lg bg-white"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
