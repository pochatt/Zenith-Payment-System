/**
 * @file errors.ts — Structured error system for the Zenith Coordinator.
 *
 * Single source of truth for error categories, HTTP status mapping, and
 * retry semantics. Replaces ad-hoc `throw new Error(...)` and silent
 * `console.error(...)` returns scattered across lanes and ingress handlers.
 *
 * # Usage
 *
 * ```ts
 * // Raise a typed domain error
 * throw new DomainError('H_LIMIT_EXCEEDED', 'H reservation exceeds participant limit', {
 *   bank_id, txid, requested: amount, available: remaining,
 * })
 *
 * // Inside an HTTP handler, convert to a Response
 * try {
 *   await processExpress(req, env)
 * } catch (e) {
 *   return errorResponse(e)
 * }
 * ```
 *
 * Every reason_code is documented in `specs/api-contracts.md` (Error Catalog).
 */

// ---------------------------------------------------------------------------
// Error category & retry semantics
// ---------------------------------------------------------------------------

/**
 * Error category. Drives HTTP status mapping and queue retry decisions.
 *
 * - VALIDATION: bad input (400). Never retry.
 * - AUTH:       missing/invalid credential (401/403). Never retry.
 * - NOT_FOUND:  target resource absent (404). Never retry.
 * - CONFLICT:   state guard / optimistic-lock conflict (409). Caller should re-read state.
 * - INVARIANT:  internal consistency violation (500). Bug; do not retry blindly.
 * - DOWNSTREAM: bank / IGS / external call failed transiently (502/503). Retry safe.
 * - TIMEOUT:    downstream did not respond in time (504). Retry safe.
 * - RATE_LIMIT: too many requests (429). Retry with backoff.
 * - INTERNAL:   uncategorized (500). Default for unknown throws.
 */
export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVARIANT'
  | 'DOWNSTREAM'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'INTERNAL'

/** Whether the queue consumer should retry on this category. */
export function isRetryable(category: ErrorCategory): boolean {
  return category === 'DOWNSTREAM' || category === 'TIMEOUT' || category === 'RATE_LIMIT'
}

/** HTTP status mapping. */
export function httpStatusOf(category: ErrorCategory): number {
  switch (category) {
    case 'VALIDATION': return 400
    case 'AUTH':       return 401
    case 'NOT_FOUND':  return 404
    case 'CONFLICT':   return 409
    case 'RATE_LIMIT': return 429
    case 'TIMEOUT':    return 504
    case 'DOWNSTREAM': return 502
    case 'INVARIANT':  return 500
    case 'INTERNAL':   return 500
  }
}

// ---------------------------------------------------------------------------
// Reason code catalog
// ---------------------------------------------------------------------------

/**
 * Canonical reason_code → category mapping.
 *
 * Mirrors the Error Catalog in `specs/api-contracts.md`. Any new code added
 * to a lane / handler MUST be registered here so HTTP status, retry policy,
 * and the public spec stay in sync.
 */
export const REASON_CODE_CATEGORY: Record<string, ErrorCategory> = {
  // ----- Validation
  INVALID_REQUEST:        'VALIDATION',
  MISSING_FIELD:          'VALIDATION',
  INVALID_AMOUNT:         'VALIDATION',
  INVALID_LANE:           'VALIDATION',
  INVALID_STATE:          'VALIDATION',
  INVALID_PROXY_TYPE:     'VALIDATION',
  FATF_R16_VIOLATION:     'VALIDATION',
  PREIMAGE_MISMATCH:      'VALIDATION',
  EXPIRED:                'VALIDATION',

  // ----- Authentication / authorization
  UNAUTHORIZED:           'AUTH',
  INVALID_HMAC:           'AUTH',
  WHITELIST_REJECTED:     'AUTH',
  ACCOUNT_FROZEN:         'AUTH',

  // ----- Not found
  TX_NOT_FOUND:           'NOT_FOUND',
  HTLC_NOT_FOUND:         'NOT_FOUND',
  GTID_NOT_FOUND:         'NOT_FOUND',
  RTP_NOT_FOUND:          'NOT_FOUND',
  ACCOUNT_NOT_FOUND:      'NOT_FOUND',
  PROXY_NOT_FOUND:        'NOT_FOUND',
  PARTICIPANT_NOT_FOUND:  'NOT_FOUND',

  // ----- Conflict (state machine / optimistic lock)
  CONCURRENCY_CONFLICT:   'CONFLICT',
  STATE_GUARD:            'CONFLICT',
  IDEMPOTENCY_REPLAY:     'CONFLICT',
  ALREADY_PROCESSED:      'CONFLICT',

  // ----- Settlement / domain
  H_LIMIT_EXCEEDED:       'CONFLICT',
  RESERVE_FAILED:         'CONFLICT',
  AUTHORITY_CHECK_NG:     'CONFLICT',
  NAME_MISMATCH:          'CONFLICT',
  CIRCUIT_OPEN:           'CONFLICT',

  // ----- Downstream / infrastructure
  BANK_ERROR:             'DOWNSTREAM',
  BANK_TIMEOUT:           'TIMEOUT',
  IGS_ERROR:              'DOWNSTREAM',
  ALS_LOOKUP_FAILED:      'DOWNSTREAM',
  RATE_LIMITED:           'RATE_LIMIT',

  // ----- Invariant violations (these indicate bugs)
  CHAIN_TAMPERED:         'INVARIANT',
  LEDGER_IMBALANCE:       'INVARIANT',
  IMPOSSIBLE_TRANSITION:  'INVARIANT',
}

/** Resolve the category of a reason_code; defaults to INTERNAL when unknown. */
export function categoryOf(reasonCode: string): ErrorCategory {
  return REASON_CODE_CATEGORY[reasonCode] ?? 'INTERNAL'
}

// ---------------------------------------------------------------------------
// DomainError class
// ---------------------------------------------------------------------------

/**
 * Typed domain error. Carries:
 *  - reason_code: machine-readable code (see REASON_CODE_CATEGORY).
 *  - category:    derived from the code; controls HTTP status + retry policy.
 *  - details:     structured context (txid, bank_id, amounts, etc.) — never PII.
 *
 * Throwing `DomainError` is preferred over `throw new Error(...)` because the
 * top-level handlers can render a consistent JSON response and the queue
 * consumer can decide retry vs ack.
 */
export class DomainError extends Error {
  readonly reason_code: string
  readonly category: ErrorCategory
  readonly details: Record<string, unknown>
  readonly cause?: unknown

  constructor(
    reason_code: string,
    message: string,
    details: Record<string, unknown> = {},
    options: { cause?: unknown; category?: ErrorCategory } = {},
  ) {
    super(message)
    this.name = 'DomainError'
    this.reason_code = reason_code
    this.category = options.category ?? categoryOf(reason_code)
    this.details = details
    this.cause = options.cause
  }

  toJSON(): {
    error: string; reason_code: string; category: ErrorCategory;
    details: Record<string, unknown>;
  } {
    return {
      error: this.message,
      reason_code: this.reason_code,
      category: this.category,
      details: this.details,
    }
  }
}

/** Type guard — narrows an unknown thrown value to DomainError. */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError
}

// ---------------------------------------------------------------------------
// HTTP rendering
// ---------------------------------------------------------------------------

/**
 * Render any thrown value into a JSON error Response.
 *
 * - DomainError → typed JSON with reason_code + category.
 * - other Error → 500 INTERNAL_ERROR with the error message.
 * - non-Error   → 500 INTERNAL_ERROR with String(e).
 *
 * Always includes a `request_id` field if provided (taken from the request
 * tracing context; see logger.ts).
 */
export function errorResponse(e: unknown, request_id?: string): Response {
  if (isDomainError(e)) {
    const status = httpStatusOf(e.category)
    const body = { ...e.toJSON(), request_id }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const msg = e instanceof Error ? e.message : String(e)
  const body = {
    error: msg,
    reason_code: 'INTERNAL_ERROR',
    category: 'INTERNAL' as ErrorCategory,
    details: {},
    request_id,
  }
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })
}
