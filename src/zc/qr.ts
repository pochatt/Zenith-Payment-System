/**
 * @file QR code payment management. Generates static/dynamic QR codes with
 *       HMAC signatures and processes QR-initiated payments.
 * @module zc/qr
 */
import type { QrCodeRow, QrGenerateRequest, QrPayRequest } from "../types";
import { signPayload, verifySignature } from "../shared/hmac";

// ---------------------------------------------------------------------------
// Generate QR code
// Signature is HMAC-SHA256(qr_ref + payee_bank_id + amount, QR_SECRET)
// ---------------------------------------------------------------------------
export async function generateQrCode(
  db: D1Database,
  req: QrGenerateRequest,
  env: { QR_SECRET: string }
): Promise<QrCodeRow> {
  const qrRef = crypto.randomUUID();
  const now = new Date().toISOString();
  const amountValue = req.amount ?? null;
  const currency = "JPY";

  // Build signature payload string: qr_ref + payee_bank_id + amount (or '' if STATIC with no amount)
  const sigPayload = buildSigPayload(qrRef, req.payee_bank_id, amountValue ?? undefined);
  const signature = await signPayload(sigPayload, env.QR_SECRET);

  await db
    .prepare(`
    INSERT INTO QrCodes
      (qr_ref, qr_type, payee_bank_id, payee_account_id, payee_name,
       amount_value, amount_currency, purpose, edi_ref,
       signature, is_used, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)
    .bind(
      qrRef,
      req.type,
      req.payee_bank_id,
      req.payee_account_id,
      req.payee_name ?? "",
      amountValue,
      currency,
      req.purpose ?? null,
      req.edi_ref ?? null,
      signature,
      req.expires_at ?? null,
      now
    )
    .run();

  return {
    qr_ref: qrRef,
    qr_type: req.type,
    payee_bank_id: req.payee_bank_id,
    payee_account_id: req.payee_account_id,
    payee_name: req.payee_name ?? "",
    amount_value: amountValue,
    amount_currency: currency,
    purpose: req.purpose ?? null,
    edi_ref: req.edi_ref ?? null,
    signature,
    is_used: 0,
    expires_at: req.expires_at ?? null,
    created_at: now,
  };
}

// ---------------------------------------------------------------------------
// QRinquiry
// ---------------------------------------------------------------------------
export async function getQrCode(db: D1Database, qrRef: string): Promise<QrCodeRow | null> {
  const row = await db
    .prepare(`
    SELECT * FROM QrCodes WHERE qr_ref = ? LIMIT 1
  `)
    .bind(qrRef)
    .first<QrCodeRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// QR execution (signature validation → mark used → return txid)
// ---------------------------------------------------------------------------
export async function processQrPayment(
  db: D1Database,
  req: QrPayRequest,
  env: { QR_SECRET: string }
): Promise<{ valid: boolean; qrRow?: QrCodeRow; effectiveAmount?: number; error?: string }> {
  const qrRow = await getQrCode(db, req.qr_ref);
  if (!qrRow) {
    return { valid: false, error: "QR_NOT_FOUND" };
  }

  // expiredcheck
  if (qrRow.expires_at) {
    const expiresMs = new Date(qrRow.expires_at).getTime();
    if (expiresMs < Date.now()) {
      return { valid: false, error: "QR_EXPIRED" };
    }
  }

  // usage check (DYNAMIC QR single-use)
  if (qrRow.qr_type === "DYNAMIC" && qrRow.is_used === 1) {
    return { valid: false, error: "QR_ALREADY_USED" };
  }

  // DYNAMIC QR prefers fixed amount, else req.amount. STATIC QR requires req.amount
  const effectiveAmount =
    qrRow.qr_type === "DYNAMIC" ? (qrRow.amount_value ?? req.amount) : req.amount;
  if (effectiveAmount == null || effectiveAmount <= 0) {
    return { valid: false, error: "QR_AMOUNT_REQUIRED" };
  }

  // signaturevalidation
  const sigOk = await verifyQrSignature(
    qrRow.qr_ref,
    qrRow.payee_bank_id,
    qrRow.amount_value ?? undefined,
    qrRow.signature,
    env.QR_SECRET
  );
  if (!sigOk) {
    return { valid: false, error: "QR_INVALID_SIGNATURE" };
  }

  // Set DYNAMIC QR as used
  if (qrRow.qr_type === "DYNAMIC") {
    await db
      .prepare(`
      UPDATE QrCodes SET is_used = 1 WHERE qr_ref = ?
    `)
      .bind(qrRow.qr_ref)
      .run();
    return { valid: true, qrRow: { ...qrRow, is_used: 1 }, effectiveAmount };
  }

  // Return STATIC QR as-is (reusable)
  return { valid: true, qrRow, effectiveAmount };
}

// ---------------------------------------------------------------------------
// QRsignaturevalidation
// ---------------------------------------------------------------------------
export async function verifyQrSignature(
  qrRef: string,
  payeeBankId: string,
  amountValue: number | undefined,
  signature: string,
  secret: string
): Promise<boolean> {
  const sigPayload = buildSigPayload(qrRef, payeeBankId, amountValue);
  return verifySignature(sigPayload, signature, secret);
}

// ---------------------------------------------------------------------------
// Internal helpers: construct signature payload
// ---------------------------------------------------------------------------
function buildSigPayload(qrRef: string, payeeBankId: string, amountValue?: number): string {
  const amountStr = amountValue !== undefined ? String(amountValue) : "";
  return `${qrRef}:${payeeBankId}:${amountStr}`;
}
