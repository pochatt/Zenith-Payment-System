// =============================================================================
// src/shared/request-id.ts  決定論的リクエストIDgenerate
// =============================================================================
// ZC → Bank Ingress API 呼び出しで使用するリクエストIDを一元管理する。
// idempotent制御のため、同一コマンド × 同一transactionで常に同じIDをgenerateする必要がある。
//
// 命名規則: {COMMAND_PREFIX}-{primary_key}
//   - primary_key は通常 txid だが、GTID leg の場合は leg_id を使用する
// =============================================================================

/**
 * Bank Ingress コマンドのプレフィックス定数。
 * ZcRequests tableの request_id カラムと対応する。
 */
export const REQUEST_PREFIX = {
  /** AML/制裁スクリーニング */
  AUTHORITY_CHECK: "AUTH",
  /** 名義confirmation */
  NAME_CHECK: "NAME",
  /** 資金reserved */
  RESERVE_FUNDS: "RESERVE",
  /** 仕向実行 (a) */
  EXECUTE_DEBIT: "DEBIT",
  /** 被仕向実行 (b) */
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
  /** GTID leg レディネスconfirmation */
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
