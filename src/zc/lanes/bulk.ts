/**
 * @file BULK/DEFERRED lane processing. High-volume batch transfers settled via
 *       DNS cycle.
 * @module zc/lanes/bulk
 */
import type { Env, PaymentInitiatedRequest } from '../../types'
import { nowISO } from '../../types'
import { reserveH, lockH, releaseH } from '../h_model'
import { writeFinalityLog, callBankReserveFunds, finalizeCancelledTx } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { newUUID } from '../../shared/idempotency'

export function processBulkIngress(req: PaymentInitiatedRequest) {
  return { result: 'INGRESS_ACCEPTED' as const, txid: req.txid, state: 'RECEIVED' as const }
}

/**
 * Bulkバッチ処理: RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 * EODバッチまたはウィンドウ締切Cronから呼ばれる
 */
export async function advanceBulk(txid: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; payer_bank_id: string; payee_bank_id: string; amount_value: number; payer_account_hash: string; h_reservation_id: string | null; version: number; dns_cycle_id: string | null }>()
  if (!tx || tx.state !== 'RECEIVED') return

  // 1. PRECHECKED
  await db.prepare(
    `UPDATE Transactions SET state='PRECHECKED', updated_at=?, version=version+1 WHERE txid=? AND state='RECEIVED'`
  ).bind(now, txid).run()
  // RECEIVED → PRECHECKED の FinalityLog を記録
  await writeFinalityLog(db, {
    txid, event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })

  // 2. H予約
  const reservationId = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db)
  if (!reservationId) {
    await db.prepare(
      `UPDATE Transactions SET state='DECIDED_CANCEL', reason_code='H_LIMIT_EXCEEDED', updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
    ).bind(now, txid).run()
    await writeFinalityLog(db, {
      txid, event_type: 'DecidedCancel', state_from: 'PRECHECKED', state_to: 'DECIDED_CANCEL',
      payload_json: JSON.stringify({ reason_code: 'H_LIMIT_EXCEEDED' }), txid_or_gtid: txid,
    })
    await finalizeCancelledTx(txid, db)
    return
  }

  await db.prepare(
    `UPDATE Transactions SET state='H_RESERVED', h_reservation_id=?, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
  ).bind(reservationId, now, txid).run()
  // PRECHECKED → H_RESERVED の FinalityLog を記録
  await writeFinalityLog(db, {
    txid, event_type: 'HReserved', state_from: 'PRECHECKED', state_to: 'H_RESERVED',
    payload_json: JSON.stringify({ reservation_id: reservationId }), txid_or_gtid: txid,
  })

  // 3. 銀行側 reserve-funds（SuspenseDetails RESERVED 作成）
  // execute-debit が RESERVATION_NOT_FOUND で失敗するのを防ぐ
  // キュー再試行で同一 request_id を保証（newUUID() は再試行ごとに変わる）
  const reserveResult = await callBankReserveFunds(tx.payer_bank_id, {
    request_id: `RESERVE-${txid}`, txid,
    amount: { value: tx.amount_value, currency: 'JPY' },
    account_hash: tx.payer_account_hash,
  }, env)
  if (reserveResult.result === 'ERROR') {
    await releaseH(reservationId, db)
    await db.prepare(
      `UPDATE Transactions SET state='DECIDED_CANCEL', reason_code=?, updated_at=?, version=version+1 WHERE txid=? AND state='H_RESERVED'`
    ).bind(reserveResult.reason_code ?? 'RESERVE_FAILED', now, txid).run()
    await writeFinalityLog(db, {
      txid, event_type: 'DecidedCancel', state_from: 'H_RESERVED', state_to: 'DECIDED_CANCEL',
      payload_json: JSON.stringify({ reason_code: reserveResult.reason_code }), txid_or_gtid: txid,
    })
    await finalizeCancelledTx(txid, db)
    return
  }

  // 4. Decision確定（Bulkは即時Decision）
  // dns_cycle_id は kickDns が一元管理するため、ここでは設定しない
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  await db.prepare(
    `UPDATE Transactions SET state='DECIDED_TO_SETTLE', decision_proof_ref=?, finality_log_ref=?, updated_at=?, version=version+1 WHERE txid=? AND state='H_RESERVED'`
  ).bind(decisionProofRef, finalityLogRef, now, txid).run()

  // DECIDED_TO_SETTLE で lockH（H_RESERVED → LOCKED）
  await lockH(reservationId, db)

  await writeFinalityLog(db, {
    txid, event_type: 'DecidedToSettle', state_from: 'H_RESERVED', state_to: 'DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ decision_proof_ref: decisionProofRef }), txid_or_gtid: txid,
  })

  // DNS Execution はEOD時に一括実行（キューには積まない）
}

