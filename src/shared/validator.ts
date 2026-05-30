/**
 * @file Schema validation for ZC Ingress API payloads (Appendix E compliance).
 *
 * Each validator enforces the mandatory fields, format constraints, and
 * business rules defined in the spec. On failure it returns a structured
 * `reason_code` that is forwarded to the caller as-is.
 *
 * All validators are pure functions with no side effects.
 *
 * @module shared/validator
 */
import type {
  PaymentInitiatedRequest,
  HtlcCreateRequest,
  HtlcClaimRequest,
  GtidRegisterRequest,
  RtpRequestInput,
  LaneType,
  PurposeType,
} from "../types";

/** Result of a schema validation check. */
export interface ValidationResult {
  /** `true` if validation passed */
  ok: boolean;
  /** Machine-readable error code (e.g. `INVALID_AMOUNT`) */
  reason_code?: string;
  /** Human-readable explanation */
  message?: string;
}

const VALID_LANES: LaneType[] = [
  "EXPRESS",
  "STANDARD",
  "BULK",
  "DEFERRED",
  "RTP",
  "Hash-Time-Locked Contract",
  "HIGH_VALUE",
];
const VALID_PURPOSES: PurposeType[] = ["MERCHANT", "P2P", "BILL", "SALARY", "REFUND"];

function fail(reason_code: string, message: string): ValidationResult {
  return { ok: false, reason_code, message };
}

// ---------------------------------------------------------------------------
// PaymentInitiated (POST /api/transfers)
// ---------------------------------------------------------------------------

/**
 * Validate a payment initiation request (POST /api/transfers).
 *
 * Checks schema_version, txid format, lane, amount, payer/payee, and purpose.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validatePaymentInitiated(req: Partial<PaymentInitiatedRequest>): ValidationResult {
  if (!req.schema_version || req.schema_version !== "1.0")
    return fail("INVALID_SCHEMA_VERSION", 'schema_version must be "1.0"');
  if (!req.txid || !/^TX-/.test(req.txid)) return fail("INVALID_TXID", "txid must start with TX-");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  if (!req.lane || !VALID_LANES.includes(req.lane))
    return fail("INVALID_LANE", `lane must be one of ${VALID_LANES.join("|")}`);
  if (
    !req.amount ||
    typeof req.amount.value !== "number" ||
    req.amount.value <= 0 ||
    !Number.isInteger(req.amount.value)
  )
    return fail("INVALID_AMOUNT", "amount.value must be positive integer");
  if (!req.amount.currency || req.amount.currency !== "JPY")
    return fail("INVALID_CURRENCY", "amount.currency must be JPY");
  if (!req.payer?.bank_id || !req.payer?.account_hash)
    return fail("MISSING_PAYER", "payer.bank_id and payer.account_hash required");
  if (!req.payee?.bank_id) return fail("MISSING_PAYEE", "payee.bank_id required");
  if (!req.purpose || !VALID_PURPOSES.includes(req.purpose))
    return fail("INVALID_PURPOSE", `purpose must be one of ${VALID_PURPOSES.join("|")}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcCreate (POST /api/htlc/create)
// ---------------------------------------------------------------------------

/**
 * Validate an Hash-Time-Locked Contract creation request.
 *
 * Checks htlc_id format, optional hashlock hex, timelock date, amounts,
 * payer/payee accounts, and bank IDs.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcCreate(req: Partial<HtlcCreateRequest>): ValidationResult {
  if (!req.htlc_id || !/^Hash-Time-Locked Contract-/.test(req.htlc_id))
    return fail("INVALID_Hash-Time-Locked Contract_ID", "htlc_id must start with Hash-Time-Locked Contract-");
  // hashlock allows empty string (auto-generated server-side)
  if (req.hashlock && !/^[0-9a-f]{64}$/.test(req.hashlock))
    return fail(
      "INVALID_HASHLOCK",
      "hashlock must be 64-char hex SHA256 or empty for auto-generation"
    );
  if (!req.timelock || isNaN(Date.parse(req.timelock)))
    return fail("INVALID_TIMELOCK", "timelock must be RFC3339");
  if (!req.amount || req.amount.value <= 0)
    return fail("INVALID_AMOUNT", "amount.value must be positive");
  if (!req.payer_account_hash || req.payer_account_hash.length !== 10)
    return fail("INVALID_PAYER_ACCOUNT", "payer_account_hash must be 10-digit account number");
  if (!req.payee_account_hash || req.payee_account_hash.length !== 10)
    return fail("INVALID_PAYEE_ACCOUNT", "payee_account_hash must be 10-digit account number");
  if (!req.payer_bank_id || !req.payee_bank_id)
    return fail("MISSING_BANK_IDS", "payer_bank_id and payee_bank_id required");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcClaim (POST /api/htlc/:htlc_id/claim)
// ---------------------------------------------------------------------------

/**
 * Validate an Hash-Time-Locked Contract claim (preimage reveal) request.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcClaim(req: Partial<HtlcClaimRequest>): ValidationResult {
  if (!req.htlc_id) return fail("MISSING_Hash-Time-Locked Contract_ID", "htlc_id required");
  if (!req.preimage || !/^[0-9a-f]+$/.test(req.preimage))
    return fail("INVALID_PREIMAGE", "preimage must be hex string");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GtidRegister (POST /api/gtid/register)
// ---------------------------------------------------------------------------

/**
 * Validate a GTID (coordinated multi-leg transaction) registration request.
 *
 * Ensures at least 2 legs are present and each leg has the required fields.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateGtidRegister(req: Partial<GtidRegisterRequest>): ValidationResult {
  if (!req.gtid || !/^GT-/.test(req.gtid)) return fail("INVALID_GTID", "gtid must start with GT-");
  if (!Array.isArray(req.legs) || req.legs.length < 2)
    return fail("INVALID_LEGS", "legs must have at least 2 entries");
  for (const leg of req.legs) {
    if (!leg.leg_id || !leg.role || !leg.bank_id || !leg.account_hash)
      return fail("INVALID_LEG", "each leg requires leg_id, role, bank_id, account_hash");
    if (!leg.amount || leg.amount.value <= 0)
      return fail("INVALID_LEG_AMOUNT", "each leg amount.value must be positive");
  }
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// RtpRequest (POST /api/rtp/request)
// ---------------------------------------------------------------------------

/**
 * Validate a Request-to-Pay initiation request.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateRtpRequest(req: Partial<RtpRequestInput>): ValidationResult {
  if (!req.rtp_id || !/^RTP-/.test(req.rtp_id))
    return fail("INVALID_RTP_ID", "rtp_id must start with RTP-");
  if (!req.payee_bank_id || !req.payer_bank_id)
    return fail("MISSING_BANK_IDS", "payee_bank_id and payer_bank_id required");
  if (!req.amount || req.amount.value <= 0)
    return fail("INVALID_AMOUNT", "amount.value must be positive");
  if (!req.expires_at || isNaN(Date.parse(req.expires_at)))
    return fail("INVALID_EXPIRES_AT", "expires_at must be RFC3339");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

/**
 * Safely parse a JSON request body.
 *
 * @typeParam T - Expected shape of the parsed body
 * @param req - Incoming Request object
 * @returns Parsed body as `T`, or `null` if parsing fails
 */
export async function parseBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
