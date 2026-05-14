/**
 * @file STANDARD lane processing. Async multi-step flow: PreCheck -> H-Reserve
 *       -> Authorization -> Decision -> Debit -> Credit -> Settle.
 * @module zc/lanes/standard
 */
import type { Env, PaymentInitiatedRequest } from '../../types'
import { nowISO } from '../../types'
import { reserveH, lockH } from '../h_model'
import type { ReserveHResult } from '../h_model'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { writeFinalityLog, callBankAuthorityCheck, callBankNameCheck, callBankReserveFunds, callBankReleaseReserve } from '../orchestrator'
import { newUUID } from '../../shared/idempotency'
import { getOrCreateDnsCycle } from '../dns'
import { cancelInFlightTx } from './_helpers'

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
    .first<{ state: string; payer_bank_id: string; payee_bank_id: string; amount_value: number; pspr_ref: string | null; payer_account_hash: string; payee_account_hash: string | null; version: number; expires_at: string | null; purpose: string | null }>()
  if (!tx) return

  if (tx.state !== 'RECEIVED') return  // 既に進んでいる

  // 1. PRECHECKED — CAS ガード: 並行キュー再配信で二重実行を防ぐ
  const toPrechecked = await db.prepare(
    `UPDATE Transactions SET state='PRECHECKED', updated_at=?, version=version+1 WHERE txid=? AND state='RECEIVED'`
  ).bind(now, txid).run()
  if ((toPrechecked.meta.changes ?? 0) === 0) return  // 別コールが先に遷移済み
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
    await cancelInFlightTx(db, { txid, reasonCode: authResult.reason_code ?? 'AUTHORITY_CHECK_NG', fromStates: ['PRECHECKED'] })
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
    await writeFinalityLog(db, {
      txid, event_type: 'PreCheckSuspended', state_from: 'PRECHECKED', state_to: 'PRECHECKED_SUSPENDED',
      payload_json: JSON.stringify({ reason_code: 'SUSPEND_NAMECHECK_PENDING' }), txid_or_gtid: txid,
    })
    return
  }

  // 4. H予約
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db)
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ['PRECHECKED'] })
    return
  }
  const reservationId = hResult.reservation_id

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
    await cancelInFlightTx(db, { txid, reasonCode: reserveResult.reason_code ?? 'RESERVE_FAILED', fromStates: ['H_RESERVED'] })
    return
  }

  // 6. 支払人最終認可待ち（Standard固有）
  // REFUND purpose（Reversal TX）は OPS 起点で自然な承認者が存在しないため自動認可する。
  // その他の取引は送金行（または顧客）が POST /api/transfers/:txid/authorize を
  // 呼び出すまで H_RESERVED 状態で待機する。
  // 基本思想: ZC は決定主体ではなく状態の中継者。送金の最終認可は送金行に委ねる。
  if (tx.purpose === 'REFUND') {
    await authorizeStandard(txid, true, env)
  }
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
    await cancelInFlightTx(db, { txid, reasonCode: 'CANCEL_BY_PAYER', fromStates: ['H_RESERVED'] })
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

/**
 * 名義不一致サスペンド後の再開: PRECHECKED_SUSPENDED → H_RESERVED
 * 送金行が顧客確認を経て /resume-namecheck を呼び出した際に実行される。
 */
export async function resumeFromNameCheckSuspended(
  txid: string,
  env: Env,
): Promise<{ ok: boolean; state: string }> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; payer_bank_id: string; amount_value: number; payer_account_hash: string; version: number }>()
  if (!tx) return { ok: false, state: 'NOT_FOUND' }
  if (tx.state !== 'PRECHECKED_SUSPENDED') return { ok: false, state: tx.state }

  // PRECHECKED_SUSPENDED → PRECHECKED（名義チェック上書き承認）
  const updated = await db.prepare(
    `UPDATE Transactions SET state='PRECHECKED', reason_code=NULL, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED_SUSPENDED'`
  ).bind(now, txid).run()
  if ((updated.meta.changes ?? 0) === 0) return { ok: false, state: 'STATE_CONFLICT' }

  await writeFinalityLog(db, {
    txid, event_type: 'NameCheckOverridden', state_from: 'PRECHECKED_SUSPENDED', state_to: 'PRECHECKED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })

  // H予約
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db)
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ['PRECHECKED'] })
    return { ok: true, state: 'DECIDED_CANCEL' }
  }
  const reservationId = hResult.reservation_id

  await db.prepare(
    `UPDATE Transactions SET state='H_RESERVED', h_reservation_id=?, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
  ).bind(reservationId, now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'HReserved', state_from: 'PRECHECKED', state_to: 'H_RESERVED',
    payload_json: JSON.stringify({ reservation_id: reservationId }), txid_or_gtid: txid,
  })

  // Bank reserve-funds
  const reserveResult = await callBankReserveFunds(tx.payer_bank_id, {
    request_id: `RESERVE-${txid}`, txid, amount: { value: tx.amount_value, currency: 'JPY' },
    account_hash: tx.payer_account_hash,
  }, env)
  if (reserveResult.result === 'ERROR') {
    await cancelInFlightTx(db, { txid, reasonCode: reserveResult.reason_code ?? 'RESERVE_FAILED', fromStates: ['H_RESERVED'] })
    return { ok: true, state: 'DECIDED_CANCEL' }
  }

  return { ok: true, state: 'H_RESERVED' }
}
