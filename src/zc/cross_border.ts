/**
 * @file Cross-border transfer management with FATF R.16 compliance. Routes
 *       outbound transfers to foreign FPS endpoints.
 * @module zc/cross_border
 */

import type {
  CrossBorderTransactionRow,
  CrossBorderSendRequest,
  CrossBorderStatus,
  FatfR16Data,
  Pacs008Message,
} from "../types";
import { nowISO } from "../types";
import { validateFatfR16, serializeFatfData } from "../shared/fatf_validator";
import { buildPacs008 } from "../shared/iso20022";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mock fixed exchange rate (foreign currency → JPY): constants.ts is the source of truth for consistent use */
import { EXCHANGE_RATE_TO_JPY as MOCK_EXCHANGE_RATES } from "../shared/constants";

// ---------------------------------------------------------------------------
// Start cross-border transfer
// ---------------------------------------------------------------------------

/**
 * Starts a cross-border transfer.
 *
 * Processing order:
 * 1. FATF R16 validation
 * 2. Create CrossBorderTransactions record
 * 3. Create domestic Transactions record (DEFERRED lane)
 * 4. Generate pacs.008 message
 * 5. Send to external FPS (mock: log only)
 *
 * @param db  - D1 database
 * @param req - cross-border transfer request
 * @param env - environment variables
 * @returns cb_txid, domestic_txid, pacs.008 message
 * @throws Error - when FATF R16 validation fails
 */
export async function initiateCrossBorderTransfer(
  db: D1Database,
  req: CrossBorderSendRequest,
  env: { FOREIGN_FPS_ENDPOINT?: string }
): Promise<{ cbTxid: string; domesticTxid: string; pacs008: Pacs008Message }> {
  // 1. FATF R16 validation
  const fatfResult = validateFatfR16(req.fatf_data);
  if (!fatfResult.valid) {
    throw new Error(`FATF R16 validation failed: ${fatfResult.errors.join("; ")}`);
  }

  const now = nowISO();
  const cbTxid = req.cb_txid.startsWith("CB-") ? req.cb_txid : `CB-${crypto.randomUUID()}`;
  const domesticTxid = `TX-${crypto.randomUUID()}`;

  // Foreign currency → JPY conversion
  const rate = MOCK_EXCHANGE_RATES[req.foreign_currency.toUpperCase()] ?? 1;
  const domesticAmount = Math.round(req.foreign_amount * rate);

  const fatfJson = serializeFatfData(req.fatf_data);

  // 2. Create the CrossBorderTransactions record
  await db
    .prepare(`
    INSERT INTO CrossBorderTransactions
      (cb_txid, domestic_txid, direction, foreign_fps_id, foreign_bank_bic,
       foreign_account_id, foreign_currency, foreign_amount, exchange_rate,
       domestic_amount, status, settlement_bank_id, nostro_account_ref,
       fatf_data_json, created_at, updated_at)
    VALUES (?, ?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?, 'INITIATED', NULL, NULL, ?, ?, ?)
  `)
    .bind(
      cbTxid,
      domesticTxid,
      req.foreign_fps_id,
      req.foreign_bank_bic,
      req.foreign_account_id,
      req.foreign_currency,
      req.foreign_amount,
      rate,
      domesticAmount,
      fatfJson,
      now,
      now
    )
    .run();

  // 3. Create the domestic Transactions record (DEFERRED lane)
  // Set external FPS information on the payee side (an empty string makes account identification impossible in execute-credit)
  // For cross-border, store foreign_bank_bic in payee_bank_id and foreign_account_id
  // in payee_account_hash, so they can be referenced during credit processing
  await db
    .prepare(`
    INSERT OR IGNORE INTO Transactions
      (txid, state, lane, amount_value, amount_currency,
       payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
       idempotency_key, version, created_at, updated_at)
    VALUES (?, 'RECEIVED', 'DEFERRED', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)
    .bind(
      domesticTxid,
      domesticAmount,
      "JPY",
      req.payer_bank_id,
      req.payer_account_id,
      req.foreign_bank_bic,
      req.foreign_account_id,
      req.idempotency_key,
      now,
      now
    )
    .run();

  // 4. Generate the pacs.008 message
  const pacs008 = buildPacs008({
    msgId: `MSG-${cbTxid}`,
    txid: cbTxid,
    amount: req.foreign_amount,
    currency: req.foreign_currency,
    payerBankBic: req.fatf_data.ordering_institution.bic ?? req.payer_bank_id,
    payerAccount: req.payer_account_id,
    payerName: req.fatf_data.originator.name,
    payeeBankBic: req.foreign_bank_bic,
    payeeAccount: req.foreign_account_id,
    payeeName: req.fatf_data.beneficiary.name,
    fatf: req.fatf_data,
  });

  // 5. Send to the external FPS (mock: log only)
  if (env.FOREIGN_FPS_ENDPOINT) {
    console.log(
      `[cross_border] MOCK send to foreign FPS ${env.FOREIGN_FPS_ENDPOINT}`,
      JSON.stringify({ cbTxid, pacs008: pacs008.message_id })
    );
  } else {
    console.log(`[cross_border] No FOREIGN_FPS_ENDPOINT configured. cbTxid=${cbTxid} (dry-run)`);
  }

  return { cbTxid, domesticTxid, pacs008 };
}

// ---------------------------------------------------------------------------
// Update cross-border transfer state
// ---------------------------------------------------------------------------

/**
 * Update the state of a cross-border transfer when an external FPS callback is received.
 *
 * @param db         - D1 database
 * @param cbTxid     - cross-border transaction ID
 * @param status     - new status
 * @param foreignRef - external FPS reference number (optional)
 */
export async function updateCrossBorderStatus(
  db: D1Database,
  cbTxid: string,
  status: CrossBorderStatus,
  foreignRef?: string
): Promise<void> {
  const now = nowISO();

  if (foreignRef) {
    await db
      .prepare(`
      UPDATE CrossBorderTransactions
      SET status = ?, nostro_account_ref = ?, updated_at = ?
      WHERE cb_txid = ?
    `)
      .bind(status, foreignRef, now, cbTxid)
      .run();
  } else {
    await db
      .prepare(`
      UPDATE CrossBorderTransactions
      SET status = ?, updated_at = ?
      WHERE cb_txid = ?
    `)
      .bind(status, now, cbTxid)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Cross-border transfer lookup
// ---------------------------------------------------------------------------

/**
 * Look up a cross-border transaction by cb_txid.
 *
 * @param db     - D1 database
 * @param cbTxid - cross-border transaction ID
 * @returns CrossBorderTransactionRow | null
 */
export async function getCrossBorderTransaction(
  db: D1Database,
  cbTxid: string
): Promise<CrossBorderTransactionRow | null> {
  return db
    .prepare(`
    SELECT * FROM CrossBorderTransactions WHERE cb_txid = ?
  `)
    .bind(cbTxid)
    .first<CrossBorderTransactionRow>();
}

// ---------------------------------------------------------------------------
// Fetch cross-border information from domestic_txid
// ---------------------------------------------------------------------------

/**
 * Fetch the cross-border transaction associated with domestic_txid.
 *
 * @param db          - D1 database
 * @param domesticTxid - domestic transaction ID
 * @returns CrossBorderTransactionRow | null
 */
export async function getCrossBorderByDomesticTxid(
  db: D1Database,
  domesticTxid: string
): Promise<CrossBorderTransactionRow | null> {
  return db
    .prepare(`
    SELECT * FROM CrossBorderTransactions WHERE domestic_txid = ?
  `)
    .bind(domesticTxid)
    .first<CrossBorderTransactionRow>();
}
