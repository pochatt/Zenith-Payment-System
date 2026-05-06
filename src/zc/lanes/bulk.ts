/**
 * @file BULK/DEFERRED lane processing. High-volume batch transfers settled via
 *       DNS cycle.
 * @module zc/lanes/bulk
 */
import type { Env, PaymentInitiatedRequest } from '../../types'
import { reserveH, lockH } from '../h_model'
import { callBankReserveFunds } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { transitionWithLog, cancelInFlightTx } from './_helpers'

export function processBulkIngress(req: PaymentInitiatedRequest) {
  return { result: 'INGRESS_ACCEPTED' as const, txid: req.txid, state: 'RECEIVED' as const }
}

/**
 * Bulkバッチ処理: RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 * EODバッチまたはウィンドウ締切Cronから呼ばれる
 */
export async function advanceBulk(txid: string, env: Env): Promise<void> {
  const db = env.DB

  // 1. RECEIVED → PRECHECKED
  const precheck = await transitionWithLog(db, {
    txid,
    fromState: 'RECEIVED',
    toState: 'PRECHECKED',
    eventType: 'PreCheckPassed',
    payload: { txid },
  })
  if (!precheck.applied) return

  // payer_bank_id / amount / account_hash は PRECHECKED 後にまとめて読む
  const tx = await db
    .prepare(`SELECT payer_bank_id, amount_value, payer_account_hash FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ payer_bank_id: string; amount_value: number; payer_account_hash: string }>()
  if (!tx) return

  // 2. H予約
  const reservationId = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db)
  if (!reservationId) {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: 'H_LIMIT_EXCEEDED',
      fromStates: ['PRECHECKED'],
      skipReleaseH: true,
    })
    return
  }

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: 'PRECHECKED',
    toState: 'H_RESERVED',
    eventType: 'HReserved',
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  })
  if (!reserved.applied) return

  // 3. 銀行側 reserve-funds（SuspenseDetails RESERVED 作成）
  // execute-debit が RESERVATION_NOT_FOUND で失敗するのを防ぐ
  const reserveResult = await callBankReserveFunds(tx.payer_bank_id, {
    request_id: `RESERVE-${txid}`, txid,
    amount: { value: tx.amount_value, currency: 'JPY' },
    account_hash: tx.payer_account_hash,
  }, env)
  if (reserveResult.result === 'ERROR') {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: reserveResult.reason_code ?? 'RESERVE_FAILED',
      fromStates: ['H_RESERVED'],
    })
    return
  }

  // 4. Decision確定（Bulkは即時Decision）
  // dns_cycle_id は kickDns が一元管理するため、ここでは設定しない
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  const decided = await transitionWithLog(db, {
    txid,
    fromState: 'H_RESERVED',
    toState: 'DECIDED_TO_SETTLE',
    eventType: 'DecidedToSettle',
    payload: { decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
    },
  })
  if (!decided.applied) return

  // DECIDED_TO_SETTLE で lockH（H_RESERVED → LOCKED）
  await lockH(reservationId, db)

  // DNS Execution はEOD時に一括実行（キューには積まない）
}
