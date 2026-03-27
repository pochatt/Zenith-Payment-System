/**
 * @file STANDARD lane processing. Async multi-step flow: PreCheck -> H-Reserve
 *       -> Authorization -> Decision -> Debit -> Credit -> Settle.
 * @module zc/lanes/standard
 */
import type { Env, PaymentInitiatedRequest } from '../../types'
import { nowISO } from '../../types'
import { reserveH, lockH, releaseH } from '../h_model'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { writeFinalityLog, callBankAuthorityCheck, callBankNameCheck, callBankReserveFunds, callBankReleaseReserve, finalizeCancelledTx } from '../orchestrator'
import { newUUID } from '../../shared/idempotency'
import { getOrCreateDnsCycle } from '../dns'

export interface StandardIngressResult {
  result: 'INGRESS_ACCEPTED'
  txid: string
  state: 'RECEIVED'
}

/**
 * Standardレーン受付: RECEIVED を返す（同期）
 * 後続処理（PreCheck → NameCheck → AuthorityCheck）はキューで非同期実行
 */
export function processStandardIngress(req: PaymentInitiatedRequest): StandardIngressResult {
  // レコードはすでに Transactions に INSERT 済み（ingress.ts で実施）
  return { result: 'INGRESS_ACCEPTED', txid: req.txid, state: 'RECEIVED' }
}

/**
 * Standard非同期処理: PRECHECKED → PRECHECKED_SUSPENDED(名義待ち) → H_RESERVED → DECIDED_TO_SETTLE
 * Queueコンシューマーから呼ばれる
 */
export async function advanceStandard(txid: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; payer_bank_id: string; payee_bank_id: string; amount_value: number; pspr_ref: string | null; payer_account_hash: string; payee_account_hash: string | null; version: number; expires_at: string | null }>()
  if (!tx) return

  if (tx.state !== 'RECEIVED') return  // 既に進んでいる

  // 1. PRECHECKED
  await db.prepare(
    `UPDATE Transactions SET state='PRECHECKED', updated_at=?, version=version+1 WHERE txid=? AND state='RECEIVED'`
  ).bind(now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })

  // 2. AML Authority Check
  // キュー再試行で同一 request_id を保証
  const authResult = await callBankAuthorityCheck(tx.payer_bank_id, {
    request_id: `AUTH-${txid}`, txid, check_type: 'INITIAL',
  }, env)
  if (authResult.result === 'NG') {
    await cancelAndLog(db, txid, 'PRECHECKED', authResult.reason_code ?? 'AUTHORITY_CHECK_NG')
    return
  }

  // 3. Name Check（Standard は口座情報→名義結果を提示）
  // キュー再試行で同一 request_id を保証
  const nameResult = await callBankNameCheck(tx.payee_bank_id, {
    request_id: `NAME-${txid}`, txid, pspr_ref: tx.pspr_ref ?? undefined, account_hash: tx.payee_account_hash ?? '',
  }, env)
  if (nameResult.result === 'MISMATCH') {
    // 名義確認結果を PRECHECKED_SUSPENDED に遷移して待機（顧客最終確認）
    await db.prepare(
      `UPDATE Transactions SET state='PRECHECKED_SUSPENDED', reason_code='SUSPEND_NAMECHECK_PENDING', updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
    ).bind(now, txid).run()
    return
  }

  // 4. H予約
  const reservationId = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db)
  if (!reservationId) {
    await cancelAndLog(db, txid, 'PRECHECKED', 'H_LIMIT_EXCEEDED')
    return
  }

  await db.prepare(
    `UPDATE Transactions SET state='H_RESERVED', h_reservation_id=?, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
  ).bind(reservationId, now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'HReserved', state_from: 'PRECHECKED', state_to: 'H_RESERVED',
    payload_json: JSON.stringify({ reservation_id: reservationId }), txid_or_gtid: txid,
  })

  // 5. Bank reserve-funds
  // キュー再試行で同一 request_id を保証（newUUID() は再試行ごとに変わる）
  const reserveResult = await callBankReserveFunds(tx.payer_bank_id, {
    request_id: `RESERVE-${txid}`, txid, amount: { value: tx.amount_value, currency: 'JPY' },
    account_hash: tx.payer_account_hash,
  }, env)
  if (reserveResult.result === 'ERROR') {
    await cancelAndLog(db, txid, 'H_RESERVED', reserveResult.reason_code ?? 'RESERVE_FAILED')
    return
  }

  // 6. 支払人最終認可待ち（Standard固有）
  // 本来は顧客が /authorize を叩く。ここではモックとして自動認可の準備状態に
  // H_RESERVED → H_RESERVED の no-op UPDATE を削除（version の無意味なインクリメントを排除）

  // 非同期で authorize キューに積む（モック: 30秒後に自動認可）
  await env.QUEUE.send({
    type: 'ZC_STATE_ADVANCE', payload: { txid, action: 'AUTO_AUTHORIZE' },
    txid, attempt: 0, enqueued_at: now,
  })
}

/**
 * /authorize エンドポイントから呼ばれる: H_RESERVED → DECIDED_TO_SETTLE
 */
export async function authorizeStandard(
  txid: string,
  authorized: boolean,
  env: Env,
): Promise<{ ok: boolean; state: string; decision_proof_ref?: string }> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT state, payer_bank_id, payee_bank_id, amount_value, h_reservation_id, version FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; payer_bank_id: string; payee_bank_id: string; amount_value: number; h_reservation_id: string | null; version: number }>()
  if (!tx || tx.state !== 'H_RESERVED') return { ok: false, state: tx?.state ?? 'NOT_FOUND' }

  if (!authorized) {
    await cancelAndLog(db, txid, 'H_RESERVED', 'CANCEL_BY_PAYER')
    // H_RESERVED キャンセル時は reserve-funds 成功済みのため銀行の別段預金を解放する
    // cancelAndLog は H 予約を解放するが銀行側 SuspenseDetails は RESERVED のまま残る
    const suspense = await db
      .prepare(`SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' AND direction='PAY' LIMIT 1`)
      .bind(txid, tx.payer_bank_id).first<{ suspense_id: string }>()
    if (suspense) {
      await callBankReleaseReserve(tx.payer_bank_id, {
        request_id: `CANCEL-RELEASE-${txid}`, txid, reservation_ref: suspense.suspense_id,
      }, env).catch(e => console.error(`[authorizeStandard] release-reserve failed: ${e}`))
    }
    return { ok: true, state: 'DECIDED_CANCEL' }
  }

  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  // dns_cycle_id を設定
  const dnsCycleId = await getOrCreateDnsCycle(db, now)
  await db.prepare(
    `UPDATE Transactions SET state='DECIDED_TO_SETTLE', decision_proof_ref=?, finality_log_ref=?, dns_cycle_id=?, updated_at=?, version=version+1 WHERE txid=? AND state='H_RESERVED'`
  ).bind(decisionProofRef, finalityLogRef, dnsCycleId, now, txid).run()

  // H予約を RESERVED → LOCKED に切り替え（DNS清算まで保持）
  if (tx.h_reservation_id) {
    await lockH(tx.h_reservation_id, db)
  }

  await writeFinalityLog(db, {
    txid, event_type: 'DecidedToSettle', state_from: 'H_RESERVED', state_to: 'DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ decision_proof_ref: decisionProofRef }), txid_or_gtid: txid,
  })

  // Execution をキューに投入
  await env.QUEUE.send({
    type: 'ZC_BANK_DEBIT',
    payload: { payer_bank_id: tx.payer_bank_id, payee_bank_id: tx.payee_bank_id, txid, amount: { value: tx.amount_value, currency: 'JPY' }, decision_proof_ref: decisionProofRef, reservation_id: tx.h_reservation_id },
    txid, attempt: 0, enqueued_at: now,
  })

  return { ok: true, state: 'DECIDED_TO_SETTLE', decision_proof_ref: decisionProofRef }
}

async function cancelAndLog(db: D1Database, txid: string, fromState: string, reasonCode: string): Promise<void> {
  const now = nowISO()
  // h_reservation_id を取得してH解放
  const txForH = await db
    .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
    .bind(txid).first<{ h_reservation_id: string | null }>()
  if (txForH?.h_reservation_id) {
    await releaseH(txForH.h_reservation_id, db)
  }
  await db.prepare(
    `UPDATE Transactions SET state='DECIDED_CANCEL', reason_code=?, updated_at=?, version=version+1 WHERE txid=?`
  ).bind(reasonCode, now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'DecidedCancel', state_from: fromState, state_to: 'DECIDED_CANCEL',
    payload_json: JSON.stringify({ reason_code: reasonCode }), txid_or_gtid: txid,
  })
  // DECIDED_CANCEL → CANCELLED
  await finalizeCancelledTx(txid, db)
}
