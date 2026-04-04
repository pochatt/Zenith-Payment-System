/**
 * @file EXPRESS lane processing. Synchronous end-to-end settlement within a
 *       single request: PreCheck -> H-Reserve -> Decision -> Debit -> Credit -> Settle.
 * @module zc/lanes/express
 */
import type { Env, PaymentInitiatedRequest, TransactionRow } from '../../types'
import { nowISO } from '../../types'
import { reserveH, lockH, releaseH } from '../h_model'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { writeFinalityLog } from '../orchestrator'
import { callBankAuthorityCheck, callBankNameCheck, callBankReserveFunds } from '../orchestrator'
import { newUUID } from '../../shared/idempotency'
import { getOrCreateDnsCycle } from '../dns'

export interface ExpressResult {
  result: 'DECISION_ACCEPTED' | 'DECISION_REJECTED'
  txid: string
  state: string
  decision_proof_ref?: string
  reason_code?: string
}

/**
 * Expressレーン: 同期で Decision まで完結
 * RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 */
export async function processExpress(
  req: PaymentInitiatedRequest,
  env: Env,
): Promise<ExpressResult> {
  const db = env.DB
  const txid = req.txid
  const now = nowISO()

  // 1. PRECHECKED
  await transitionTx(txid, 'PRECHECKED', null, null, db, 'RECEIVED')
  await writeFinalityLog(db, {
    txid, event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })

  // 2. AML/Authority Check（payerBank）
  // 決定論的 request_id（同一 txid なら同一 request_id を生成）
  const authResult = await callBankAuthorityCheck(req.payer.bank_id, {
    request_id: `AUTH-${txid}`, txid, check_type: 'INITIAL', vault_ref: req.payer.vault_ref,
  }, env)
  if (authResult.result === 'NG') {
    await cancelTx(txid, authResult.reason_code ?? 'AUTHORITY_CHECK_NG', db)
    return { result: 'DECISION_REJECTED', txid, state: 'DECIDED_CANCEL', reason_code: authResult.reason_code }
  }

  // 3. Name Check（PSPR参照または payeeAccount）
  // 決定論的 request_id
  const nameResult = await callBankNameCheck(req.payee.bank_id, {
    request_id: `NAME-${txid}`, txid, pspr_ref: req.pspr_ref, account_hash: req.payee.account_hash ?? '',
  }, env)
  if (nameResult.result === 'MISMATCH') {
    await cancelTx(txid, 'NAME_MISMATCH', db)
    return { result: 'DECISION_REJECTED', txid, state: 'DECIDED_CANCEL', reason_code: 'NAME_MISMATCH' }
  }

  // 4. H予約
  const reservationId = await reserveH(req.payer.bank_id, txid, req.amount.value, db)
  if (!reservationId) {
    await cancelTx(txid, 'H_LIMIT_EXCEEDED', db)
    return { result: 'DECISION_REJECTED', txid, state: 'DECIDED_CANCEL', reason_code: 'H_LIMIT_EXCEEDED' }
  }

  // H_RESERVED 状態に遷移
  await transitionTx(txid, 'H_RESERVED', reservationId, null, db, 'PRECHECKED')
  await writeFinalityLog(db, {
    txid, event_type: 'HReserved', state_from: 'PRECHECKED', state_to: 'H_RESERVED',
    payload_json: JSON.stringify({ reservation_id: reservationId }), txid_or_gtid: txid,
  })

  // 5. Bank reserve-funds 呼び出し
  // 決定論的 request_id
  const reserveResult = await callBankReserveFunds(req.payer.bank_id, {
    request_id: `RESERVE-${txid}`, txid, amount: req.amount, account_hash: req.payer.account_hash,
  }, env)
  if (reserveResult.result === 'ERROR') {
    await cancelTx(txid, reserveResult.reason_code ?? 'RESERVE_FAILED', db)
    return { result: 'DECISION_REJECTED', txid, state: 'DECIDED_CANCEL', reason_code: reserveResult.reason_code }
  }

  // 6. Decision確定
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  // DECIDED_TO_SETTLE 時に dns_cycle_id を設定（H解放のために必要）
  const dnsCycleId = await getOrCreateDnsCycle(db, now)
  await db.prepare(
    `UPDATE Transactions
     SET state = 'DECIDED_TO_SETTLE', decision_proof_ref = ?, finality_log_ref = ?,
         dns_cycle_id = ?, updated_at = ?, version = version + 1
     WHERE txid = ? AND state = 'H_RESERVED'`
  ).bind(decisionProofRef, finalityLogRef, dnsCycleId, now, txid).run()

  // H予約を RESERVED → LOCKED に切り替え（DNS清算まで保持）
  await lockH(reservationId, db)

  await writeFinalityLog(db, {
    txid, event_type: 'DecidedToSettle', state_from: 'H_RESERVED', state_to: 'DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ decision_proof_ref: decisionProofRef }), txid_or_gtid: txid,
  })

  // 7. 非同期で Execution をキューに投入
  await env.QUEUE.send({
    type: 'ZC_BANK_DEBIT',
    payload: {
      payer_bank_id: req.payer.bank_id, payee_bank_id: req.payee.bank_id,
      txid, amount: req.amount, decision_proof_ref: decisionProofRef,
      reservation_id: reservationId,
    },
    txid, attempt: 0, enqueued_at: now,
  })

  return { result: 'DECISION_ACCEPTED', txid, state: 'DECIDED_TO_SETTLE', decision_proof_ref: decisionProofRef }
}

// ---------------------------------------------------------------------------
// ヘルパー（Express専用）
// ---------------------------------------------------------------------------
// 状態ガード＋楽観ロック（AND state=? AND version=? で許可遷移のみ実行可能に）
// Bug #4 fix: version チェックを追加し、キュー再配信時の二重 H 予約を防止する
async function transitionTx(
  txid: string, state: string, reservationId: string | null, reasonCode: string | null, db: D1Database,
  fromState?: string,
): Promise<void> {
  if (fromState) {
    // version を取得して CAS UPDATE（楽観ロック）
    const cur = await db
      .prepare(`SELECT version FROM Transactions WHERE txid = ? AND state = ?`)
      .bind(txid, fromState).first<{ version: number }>()
    if (!cur) return  // 既に状態が変わっている: 冪等処理としてスキップ
    await db.prepare(
      `UPDATE Transactions SET state = ?, h_reservation_id = COALESCE(?, h_reservation_id),
       reason_code = COALESCE(?, reason_code), updated_at = ?, version = version + 1
       WHERE txid = ? AND state = ? AND version = ?`
    ).bind(state, reservationId, reasonCode, nowISO(), txid, fromState, cur.version).run()
  } else {
    await db.prepare(
      `UPDATE Transactions SET state = ?, h_reservation_id = COALESCE(?, h_reservation_id),
       reason_code = COALESCE(?, reason_code), updated_at = ?, version = version + 1
       WHERE txid = ?`
    ).bind(state, reservationId, reasonCode, nowISO(), txid).run()
  }
}

async function cancelTx(txid: string, reasonCode: string, db: D1Database): Promise<void> {
  const now = nowISO()
  // キャンセル前に h_reservation_id と現在状態を取得してH解放・FinalityLog に state_from を記録
  const txRow = await db
    .prepare(`SELECT h_reservation_id, state FROM Transactions WHERE txid = ?`)
    .bind(txid).first<{ h_reservation_id: string | null; state: string }>()
  if (!txRow) return
  // state guard: キャンセル可能な状態でのみ実行（DECIDED_TO_SETTLE以降への上書き防止）
  const cancelableStates = ['RECEIVED', 'PRECHECKED', 'PRECHECKED_SUSPENDED', 'H_RESERVED']
  if (!cancelableStates.includes(txRow.state)) return
  if (txRow.h_reservation_id) {
    await releaseH(txRow.h_reservation_id, db)
  }
  const updated = await db.prepare(
    `UPDATE Transactions SET state = 'DECIDED_CANCEL', reason_code = ?, updated_at = ?, version = version + 1
     WHERE txid = ? AND state IN ('RECEIVED','PRECHECKED','PRECHECKED_SUSPENDED','H_RESERVED')`
  ).bind(reasonCode, now, txid).run()
  if ((updated.meta.changes ?? 0) === 0) return
  await writeFinalityLog(db, {
    txid, event_type: 'DecidedCancel', state_from: txRow.state, state_to: 'DECIDED_CANCEL',
    payload_json: JSON.stringify({ reason_code: reasonCode }), txid_or_gtid: txid,
  })
  // DECIDED_CANCEL → CANCELLED
  const { finalizeCancelledTx } = await import('../orchestrator')
  await finalizeCancelledTx(txid, db)
}
