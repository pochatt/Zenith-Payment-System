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
// 定数
// ---------------------------------------------------------------------------

/** モック固定為替レート（外貨 → JPY）: constants.ts を正として統一使用 */
import { EXCHANGE_RATE_TO_JPY as MOCK_EXCHANGE_RATES } from "../shared/constants";

// ---------------------------------------------------------------------------
// クロスボーダーfund transfer開始
// ---------------------------------------------------------------------------

/**
 * クロスボーダーfund transferを開始する。
 *
 * 処理順序:
 * 1. FATF R16 validation
 * 2. CrossBorderTransactions レコードcreate
 * 3. 国内 Transactions レコード (DEFERRED lane) create
 * 4. pacs.008 messagegenerate
 * 5. 外部 FPS へsend (モック: logのみ)
 *
 * @param db  - D1 データベース
 * @param req - クロスボーダーfund transferリクエスト
 * @param env - 環境変数
 * @returns cb_txid, domestic_txid, pacs.008 メッセージ
 * @throws Error - FATF R16 validation失敗時
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

  // 外貨 → 円換算
  const rate = MOCK_EXCHANGE_RATES[req.foreign_currency.toUpperCase()] ?? 1;
  const domesticAmount = Math.round(req.foreign_amount * rate);

  const fatfJson = serializeFatfData(req.fatf_data);

  // 2. CrossBorderTransactions レコードcreate
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

  // 3. 国内 Transactions レコード (DEFERRED lane) create
  // payee 側は外部 FPS のinformationをsetする（空文字列だと execute-credit でaccount特定不可）
  // クロスボーダーでは foreign_bank_bic を payee_bank_id、foreign_account_id を
  // payee_account_hash に格納し、credit / incoming payment処理で参照可能にする
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

  // 4. pacs.008 messagegenerate
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

  // 5. 外部 FPS へsend (モック: logのみ)
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
// クロスボーダーfund transfer状態update
// ---------------------------------------------------------------------------

/**
 * 外部FPSコールバックreceive時にクロスボーダーfund transferの状態をupdateする。
 *
 * @param db         - D1 データベース
 * @param cbTxid     - クロスボーダーtransaction ID
 * @param status     - 新しいステータス
 * @param foreignRef - 外部FPSの参照番号（オプション）
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
// クロスボーダーfund transferinquiry
// ---------------------------------------------------------------------------

/**
 * cb_txid でクロスボーダーtransactionをinquiryする。
 *
 * @param db     - D1 データベース
 * @param cbTxid - クロスボーダーtransaction ID
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
// domestic_txid からクロスボーダーinformationをget
// ---------------------------------------------------------------------------

/**
 * domestic_txid に紐づくクロスボーダーtransactionをgetする。
 *
 * @param db          - D1 データベース
 * @param domesticTxid - 国内transaction ID
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
