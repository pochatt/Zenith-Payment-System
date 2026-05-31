// =============================================================================
// src/shared/request-id.ts  Deterministic request ID generation
// =============================================================================
// Centrally manage request IDs used in ZC → Bank Ingress API calls.
// For idempotency control, must always generate the same ID for the same command × same transaction.
//
// Naming convention: {COMMAND_PREFIX}-{primary_key}
//   - primary_key is usually txid, but use leg_id for GTID legs
// =============================================================================

/**
 * Bank Ingress command prefix constants.
 * Corresponds to the request_id column in the ZcRequests table.
 */
export const REQUEST_PREFIX = {
  /** AML/sanctions screening */
  AUTHORITY_CHECK: "AUTH",
  /** Account name confirmation */
  NAME_CHECK: "NAME",
  /** Funds reserved */
  RESERVE_FUNDS: "RESERVE",
  /** Originating execution (a) */
  EXECUTE_DEBIT: "DEBIT",
  /** Destination execution (b) */
  EXECUTE_CREDIT: "CREDIT",
  /** 資金reserved解放 */
  RELEASE_RESERVE: "RELEASE",
  /** HTLC recheck */
  RECHECK: "RECHECK",
  /** fund transfercancelled */
  CANCEL: "CANCEL",
  /** cancelled時のreserved解放 */
  CANCEL_RELEASE: "CANCEL-RELEASE",
  /** Credit 再開 (credit / incoming paymentapproval後) */
  CREDIT_RESUME: "CREDIT-RESUME",
  /** GTID leg readiness confirmation */
  LEG_READY: "LEG-READY",
} as const;

export type RequestPrefix = (typeof REQUEST_PREFIX)[keyof typeof REQUEST_PREFIX];

/**
 * 決定論的リクエストIDをgenerateする。
 *
 * @param prefix - コマンド種別プレフィックス ({@link REQUEST_PREFIX})
 * @param key    - 主キー (txid, leg_id 等)
 * @returns `{prefix}-{key}` 形式の文字列
 *
 * @example
 * ```ts
 * makeRequestId(REQUEST_PREFIX.AUTHORITY_CHECK, 'TX-001')
 * // => 'AUTH-TX-001'
 *
 * makeRequestId(REQUEST_PREFIX.LEG_READY, 'LEG-abc')
 * // => 'LEG-READY-LEG-abc'
 * ```
 */
export function makeRequestId(prefix: RequestPrefix, key: string): string {
  return `${prefix}-${key}`;
}
