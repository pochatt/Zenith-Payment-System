/**
 * @file HIGH_VALUE lane processing. Large-amount transfers with BOJ pre-fund
 *       checks and IGS settlement.
 *
 * Lane characteristics:
 *   - Bypasses H_RESERVED entirely (`PRECHECKED → DECIDED_TO_SETTLE` directly).
 *     This is the central-bank RTGS path: liquidity is checked against the
 *     payer bank's BOJ current-account balance, so H-limit accounting is not
 *     applicable. The state-machine table explicitly permits this edge
 *     (see `ALLOWED_TRANSITIONS.PRECHECKED`).
 *   - Settlement completes via IGS callback (`handleIgsCallback`).
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so each transition
 * is validated and atomically logged.
 *
 * @module zc/lanes/highvalue
 */
// proof_type = PAYER_HV_ISOLATION_PROOF
import type { Env, PaymentInitiatedRequest } from '../../types'
import { nowISO } from '../../types'
import { callBankAuthorityCheck, callBankNameCheck } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { calcBalance } from '../../bank/ledger'
import { transitionWithLog, cancelInFlightTx } from './_helpers'

export function processHighValueIngress(req: PaymentInitiatedRequest) {
  return { result: 'INGRESS_ACCEPTED' as const, txid: req.txid, state: 'RECEIVED' as const }
}

/**
 * HIGH_VALUE 非同期処理:
 * RECEIVED → PRECHECKED → DECIDED_TO_SETTLE → (a_HV) → IGS待ち → b
 * （H_RESERVED はスキップ。中央銀行 RTGS = BOJ プレファンドで担保するため）
 */
export async function advanceHighValue(txid: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{
      state: string; payer_bank_id: string; payee_bank_id: string;
      amount_value: number; payer_account_hash: string; payee_account_hash: string | null;
      pspr_ref: string | null; version: number
    }>()
  if (!tx || tx.state !== 'RECEIVED') return

  // 1. PRECHECKED
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: 'RECEIVED',
    toState: 'PRECHECKED',
    eventType: 'PreCheckPassed',
    payload: { txid },
  })
  if (!prechecked.applied) return

  // 2. AML Authority Check
  const authResult = await callBankAuthorityCheck(tx.payer_bank_id, { request_id: `AUTH-${txid}`, txid, check_type: 'INITIAL' }, env)
  if (authResult.result === 'NG') {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: authResult.reason_code ?? 'AUTHORITY_CHECK_NG',
      fromStates: ['PRECHECKED'],
      skipReleaseH: true,  // HV は H 予約を取らないため
    })
    return
  }

  // 3. Name Check
  const nameResult = await callBankNameCheck(tx.payee_bank_id, {
    request_id: `NAME-${txid}`, txid, pspr_ref: tx.pspr_ref ?? undefined, account_hash: tx.payee_account_hash ?? '',
  }, env)
  if (nameResult.result === 'MISMATCH') {
    // PRECHECKED → PRECHECKED_SUSPENDED (bookkeeping state; ALLOWED_TRANSITIONS permits it).
    const suspended = await transitionWithLog(db, {
      txid,
      fromState: 'PRECHECKED',
      toState: 'PRECHECKED_SUSPENDED',
      eventType: 'PreCheckSuspended',
      payload: { reason_code: 'SUSPEND_NAMECHECK_PENDING' },
      setColumns: { reason_code: 'SUSPEND_NAMECHECK_PENDING' },
    })
    if (!suspended.applied) return
    return
  }

  // 4. BOJ残高チェック（プレファンドRTGS）
  // BOJ 残高は負債会計のため負値。`bojBalance + amount > 0` で残高不足。
  const bojBalance = await calcBalance(`${tx.payer_bank_id}-BOJ`, db)
  if (bojBalance + tx.amount_value > 0) {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: 'BOJ_INSUFFICIENT_FUNDS',
      fromStates: ['PRECHECKED'],
      skipReleaseH: true,
      payloadExtra: {
        boj_balance: bojBalance,
        amount: tx.amount_value,
        available: -bojBalance,
      },
    })
    return
  }

  // 5. PRECHECKED → DECIDED_TO_SETTLE（H_RESERVED をスキップ）
  // この直行遷移は ALLOWED_TRANSITIONS.PRECHECKED に明示的に列挙されている。
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  const decided = await transitionWithLog(db, {
    txid,
    fromState: 'PRECHECKED',
    toState: 'DECIDED_TO_SETTLE',
    eventType: 'DecidedToSettle',
    payload: { decision_proof_ref: decisionProofRef, lane: 'HIGH_VALUE' },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
    },
  })
  if (!decided.applied) return

  // 6. ExecuteDebit（a_HV: proof_type=PAYER_HV_ISOLATION_PROOF）
  // payer_account_hash を渡す（HVは reserve-funds を経由しないため Bank 側で account を特定できない）
  // IGS決済開始はデビット確認後（onPayerExecConfirmed）に行う。
  await env.QUEUE.send({
    type: 'ZC_BANK_DEBIT',
    payload: {
      txid, payer_bank_id: tx.payer_bank_id, payee_bank_id: tx.payee_bank_id,
      amount: { value: tx.amount_value, currency: 'JPY' },
      decision_proof_ref: decisionProofRef, lane: 'HIGH_VALUE',
      payer_account_hash: tx.payer_account_hash,
    },
    txid, attempt: 0, enqueued_at: now,
  })
}
