// =============================================================================
// src/shared/constants.ts  System constants and configuration values
// =============================================================================
// Centrally managed to eliminate magic numbers and improve maintainability.
// Each module imports constants from here instead of using hardcoded values.
// =============================================================================

// ---------------------------------------------------------------------------
// Timeout constants (seconds)
// ---------------------------------------------------------------------------

/** T2: Originating execution → Destination execution timeout (5 minutes) */
export const TIMEOUT_T2_EXEC_SEC = 300;

/** T3: Destination proof waiting timeout (5 minutes) */
export const TIMEOUT_T3_PAYEE_PROOF_SEC = 300;

/** Grace period from SUSPENDED state to FAILED_EXECUTION transition (1 hour) */
export const TIMEOUT_SUSPENDED_TO_FAILED_SEC = 3600;

/** GTID stalled recovery: GT_DECIDED_TO_SETTLE stall timeout (10 minutes) */
export const TIMEOUT_GTID_STALLED_SEC = 600;

// ---------------------------------------------------------------------------
// Notification retry constants
// ---------------------------------------------------------------------------

/** Credit notification retry interval (seconds): exponential backoff */
export const NOTIFICATION_BACKOFF_SEC = [30, 120, 600, 3600] as const;

/** Maximum retry attempts for credit notification */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// FATF R.16 constants
// ---------------------------------------------------------------------------

/** FATF R.16 application threshold (JPY): equivalent to 1,000 USD */
export const FATF_THRESHOLD_JPY = 150_000;

/** Exchange rate: each currency → JPY conversion */
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
// Amount and count limits
// ---------------------------------------------------------------------------

/** Maximum number of statements in D1 batch */
export const D1_BATCH_MAX_STMTS = 100;

/** Default LIMIT for query results */
export const DEFAULT_QUERY_LIMIT = 50;

/** Approval request expiry (milliseconds): 24 hours */
export const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cron constants
// ---------------------------------------------------------------------------

/** EOD batch cron expression (07:30 UTC = 16:30 JST) */
export const CRON_EOD = "30 7 * * *";

/** Timeout sweep cron expression (every minute) */
export const CRON_TIMEOUT_SWEEP = "* * * * *";

// ---------------------------------------------------------------------------
// ISO 20022 / Zengin constants
// ---------------------------------------------------------------------------

/** Zengin fixed-length record size (bytes) */
export const ZENGIN_RECORD_LENGTH = 120;

/** Standard BIC code length (8 or 11 digits) */
export const BIC_LENGTH_SHORT = 8;
export const BIC_LENGTH_FULL = 11;

// ---------------------------------------------------------------------------
// Rich data constants
// ---------------------------------------------------------------------------

/** R2 offload threshold (bytes): payloads exceeding 50KB are stored in R2 */
export const R2_OFFLOAD_THRESHOLD = 50 * 1024;

/** Default retention days for rich data */
export const RICHDATA_DEFAULT_RETENTION_DAYS = 365;

// ---------------------------------------------------------------------------
// QR code constants
// ---------------------------------------------------------------------------

/** Dynamic QR default expiry (milliseconds): 15 minutes */
export const QR_DYNAMIC_EXPIRY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// DNS (Deferred Net Settlement) constants
// ---------------------------------------------------------------------------

/** DNS cycle ID prefix */
export const DNS_CYCLE_PREFIX = "DNS";

// ---------------------------------------------------------------------------
// BOJ prefund constants
// ---------------------------------------------------------------------------

/** Initial prefund amount (JPY): 100 billion yen */
export const BOJ_INITIAL_PREFUND = 100_000_000_000;
