// =============================================================================
// src/shared/constants.ts  システム定数・設定値
// =============================================================================
// Centrally manage to eliminate magic numbers and improve maintainability.
// Each module imports from here instead of using hardcoded numbers.
// =============================================================================

// ---------------------------------------------------------------------------
// Timeout constant (seconds)
// ---------------------------------------------------------------------------

/** T2: Timeout for sending-bank execution → receiving-bank execution (5 minutes) */
export const TIMEOUT_T2_EXEC_SEC = 300;

/** T3: Receiving-bank proof waiting timeout (5 minutes) */
export const TIMEOUT_T3_PAYEE_PROOF_SEC = 300;

/** Grace period to transition from SUSPENDED to FAILED_EXECUTION (1 hour) */
export const TIMEOUT_SUSPENDED_TO_FAILED_SEC = 3600;

/** GTID stalled recovery: GT_DECIDED_TO_SETTLE stall timeout (10 minutes) */
export const TIMEOUT_GTID_STALLED_SEC = 600;

// ---------------------------------------------------------------------------
// Notification retry constant
// ---------------------------------------------------------------------------

/** Credit notification retry interval (seconds): exponential backoff */
export const NOTIFICATION_BACKOFF_SEC = [30, 120, 600, 3600] as const;

/** Maximum retry count for credit notifications */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// FATF R.16 constant
// ---------------------------------------------------------------------------

/** FATF R.16 application threshold (JPY): equivalent to 1,000 USD */
export const FATF_THRESHOLD_JPY = 150_000;

/** Exchange rate: conversion from each currency to JPY */
export const EXCHANGE_RATE_TO_JPY: Record<string, number> = {
  JPY: 1,
  USD: 150,
  EUR: 163,
  GBP: 190,
  CNY: 21,
  HKD: 19,
  SGD: 112,
  AUD: 98,
  CAD: 110,
  CHF: 170,
} as const;

// ---------------------------------------------------------------------------
// 金額・件数制限
// ---------------------------------------------------------------------------

/** Maximum statement count per D1 batch */
export const D1_BATCH_MAX_STMTS = 100;

/** Default LIMIT for query results */
export const DEFAULT_QUERY_LIMIT = 50;

/** 承認リクエスト有効期限 (ミリ秒): 24時間 */
export const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cron 定数
// ---------------------------------------------------------------------------

/** EOD バッチ cron 式 (07:30 UTC = 16:30 JST) */
export const CRON_EOD = "30 7 * * *";

/** タイムアウト巡回 cron 式 (毎分) */
export const CRON_TIMEOUT_SWEEP = "* * * * *";

// ---------------------------------------------------------------------------
// ISO 20022 / 全銀定数
// ---------------------------------------------------------------------------

/** 全銀固定長レコードサイズ (バイト) */
export const ZENGIN_RECORD_LENGTH = 120;

/** Standard length of BIC code (8 or 11 digits) */
export const BIC_LENGTH_SHORT = 8;
export const BIC_LENGTH_FULL = 11;

// ---------------------------------------------------------------------------
// リッチデータ定数
// ---------------------------------------------------------------------------

/** R2 offload threshold (bytes): payloads exceeding 50KB are stored in R2 */
export const R2_OFFLOAD_THRESHOLD = 50 * 1024;

/** Default retention days for rich data */
export const RICHDATA_DEFAULT_RETENTION_DAYS = 365;

// ---------------------------------------------------------------------------
// QR コード定数
// ---------------------------------------------------------------------------

/** Default validity period for dynamic QR (milliseconds): 15 minutes */
export const QR_DYNAMIC_EXPIRY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// DNS (Deferred Net Settlement) 定数
// ---------------------------------------------------------------------------

/** DNS サイクル ID プレフィックス */
export const DNS_CYCLE_PREFIX = "DNS";

// ---------------------------------------------------------------------------
// BOJ プレファンド定数
// ---------------------------------------------------------------------------

/** 初期プレファンド額 (JPY): 1,000億円 */
export const BOJ_INITIAL_PREFUND = 100_000_000_000;
