/**
 * @file orchestrator.ts - ZC State Machine Core & Bank Call Hub
 *
 * Central orchestration module for the Zenith Coordinator (ZC). Manages the
 * transaction lifecycle state machine, dispatches queue messages to lane
 * processors, and routes all ZC-to-Bank internal calls through a unified hub.
 *
 * Key responsibilities:
 * - State transition validation (ALLOWED_TRANSITIONS map)
 * - FinalityLog audit trail persistence
 * - Payer/Payee execution confirmation handlers (a/b proof recording)
 * - Queue message dispatch (ZC_BANK_DEBIT, ZC_BANK_CREDIT, ZC_BANK_RELEASE, etc.)
 * - GTID multi-leg finalization (GT_SETTLED / GT_SUSPENDED)
 * - Bank Ingress API proxy (reserve-funds, execute-debit, execute-credit, etc.)
 *
 * All state transitions use optimistic locking (version column CAS) to prevent
 * TOCTOU race conditions in the D1/SQLite environment.
 */
import type {
  Env, TxState, QueueMessage,
  ReserveFundsRequest, ReserveFundsResponse,
  ExecuteDebitRequest, ExecuteDebitResponse,
  ExecuteCreditRequest, ExecuteCreditResult,
  ReleaseReserveRequest, ReleaseReserveResponse,
  LegReadyCheckRequest, LegReadyCheckResponse,
  AuthorityCheckRequest, AuthorityCheckResponse,
  NameCheckRequest, NameCheckResponse,
  FinalityEventType, TransactionRow,
} from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'
import { deserializeProof } from '../shared/proof'
import { releaseH } from './h_model'
import { openCase } from './case'
import { logTxEvent } from './trace'
import { createCreditNotification, deliverNotification } from './credit_notify'
import { publishEvent } from './stream'

// ---------------------------------------------------------------------------
// FinalityLog persistence
// ---------------------------------------------------------------------------

/** Shape of a FinalityLog row to be written. */
export interface FinalityLogEntry {
  txid: string | null
  event_type: FinalityEventType | string
  state_from: string | null
  state_to: string
  payload_json: string
  txid_or_gtid: string | null
}

/**
 * Persist a FinalityLog entry for audit trail.
 * Uses timestamp-based sequence numbers to survive Worker isolate restarts.
 *
 * @param db    - D1 database handle
 * @param entry - Log entry containing state transition details
 */
export async function writeFinalityLog(db: D1Database, entry: FinalityLogEntry): Promise<void> {
  const logId = `FL-${newUUID()}`
  // 単調増加を保証: DB 内の max(event_seq) + 1 をフォールバックに使う
  const maxRow = await db
    .prepare(`SELECT MAX(event_seq) AS mx FROM FinalityLog`)
    .first<{ mx: number | null }>()
  const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const seq = Math.max(candidate, (maxRow?.mx ?? 0) + 1)
  const gtid = (entry.txid_or_gtid?.startsWith('GT-') || entry.txid_or_gtid?.startsWith('GTID-'))
    ? entry.txid_or_gtid : null
  await db.prepare(
    `INSERT INTO FinalityLog
     (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(logId, entry.txid, gtid, entry.event_type, entry.state_from,
    entry.state_to, entry.payload_json, seq, nowISO()).run()
}

// ---------------------------------------------------------------------------
// State transition validator
// ---------------------------------------------------------------------------

/** Exhaustive map of allowed state transitions in the transaction lifecycle. */
const ALLOWED_TRANSITIONS: Record<TxState, TxState[]> = {
  RECEIVED:              ['PRECHECKED', 'DECIDED_CANCEL'],
  PRECHECKED:            ['PRECHECKED_SUSPENDED', 'H_RESERVED', 'DECIDED_CANCEL', 'DECIDED_TO_SETTLE'],  // HIGH_VALUE は PRECHECKED → DECIDED_TO_SETTLE
  PRECHECKED_SUSPENDED:  ['PRECHECKED', 'DECIDED_CANCEL'],
  H_RESERVED:            ['DECIDED_TO_SETTLE', 'DECIDED_CANCEL'],
  DECIDED_TO_SETTLE:     ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],  // PAYEE_EXEC_CONFIRMED: GTID PAYEEleg はデビット不要で直接クレジット確認
  DECIDED_CANCEL:        ['CANCELLED'],
  PAYER_EXEC_CONFIRMED:  ['PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  PAYEE_EXEC_CONFIRMED:  ['SETTLED'],
  SUSPENDED:             ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'FAILED_EXECUTION'],
  SETTLED:               [],
  FAILED_EXECUTION:      [],
  CANCELLED:             [],
  HTLC_LOCKED:           ['HTLC_FULFILL_REQUESTED', 'DECIDED_CANCEL'],
  HTLC_FULFILL_REQUESTED: ['DECIDED_TO_SETTLE', 'FAILED_EXECUTION'],
}

/**
 * Check whether a state transition is permitted by the state machine.
 *
 * @param from - Current transaction state
 * @param to   - Target transaction state
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: TxState, to: TxState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// Execution 完了後の状態遷移処理
// ---------------------------------------------------------------------------

/**
 * Handle payer execution confirmation (proof "a").
 * Records the payer bank proof, transitions to PAYER_EXEC_CONFIRMED,
 * then enqueues the payee credit (proof "b") for asynchronous processing.
 *
 * @param txid             - Transaction ID
 * @param bankProofRefJson - JSON-serialized payer bank proof reference
 * @param env              - Worker environment bindings
 */
export async function onPayerExecConfirmed(
  txid: string, bankProofRefJson: string, env: Env,
): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT state, lane, payee_bank_id, payee_account_hash, amount_value, decision_proof_ref, version FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: TxState; lane: string; payee_bank_id: string; payee_account_hash: string | null; amount_value: number; decision_proof_ref: string | null; version: number }>()
  if (!tx) return

  if (!isValidTransition(tx.state, 'PAYER_EXEC_CONFIRMED')) {
    console.error(`[orchestrator] Invalid transition ${tx.state} → PAYER_EXEC_CONFIRMED for ${txid}`)
    return
  }

  const updated = await db.prepare(
    `UPDATE Transactions SET state='PAYER_EXEC_CONFIRMED', payer_bank_proof_ref=?, updated_at=?, version=version+1
     WHERE txid=? AND state=? AND version=?`
  ).bind(bankProofRefJson, now, txid, tx.state, tx.version).run()

  if ((updated.meta.changes ?? 0) === 0) return  // CAS 失敗

  await writeFinalityLog(db, {
    txid, event_type: 'PayerExecConfirmed', state_from: tx.state, state_to: 'PAYER_EXEC_CONFIRMED',
    payload_json: JSON.stringify({ payer_bank_proof_ref: JSON.parse(bankProofRefJson) }), txid_or_gtid: txid,
  })

  // HIGH_VALUE レーンは IGS コールバック（handleIgsCallback）が ZC_BANK_CREDIT を投入する。
  // ここで投入すると IGS コールバックと二重送信になり BOJ 清算仕訳が欠落するリスクがある。
  // IGS はこの後 processQueueMessage の ZC_BANK_DEBIT 完了フックで開始される。
  if (tx.lane !== 'HIGH_VALUE') {
    // b（PAYEE_EXEC_CONFIRMED）をキューに投入（payee_account_hash を伝播し execute-credit のフォールバック参照を排除）
    await env.QUEUE.send({
      type: 'ZC_BANK_CREDIT',
      payload: {
        txid, payee_bank_id: tx.payee_bank_id,
        payee_account_hash: tx.payee_account_hash ?? undefined,
        amount: { value: tx.amount_value, currency: 'JPY' },
        decision_proof_ref: tx.decision_proof_ref ?? '',
      },
      txid, attempt: 0, enqueued_at: now,
    })
  }
}

/**
 * Handle payee execution confirmation (proof "b").
 * Records the payee bank proof, transitions through PAYEE_EXEC_CONFIRMED to
 * SETTLED, releases H-reservations (deferred to DNS), publishes SSE events,
 * and triggers credit notification delivery.
 * For GTID legs (TX-GT-*), also checks if all legs are settled to finalize the GT.
 *
 * @param txid             - Transaction ID
 * @param bankProofRefJson - JSON-serialized payee bank proof reference
 * @param env              - Worker environment bindings
 */
export async function onPayeeExecConfirmed(
  txid: string, bankProofRefJson: string, env: Env,
): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT state, h_reservation_id, payee_bank_id, payee_account_hash, payer_bank_id, amount_value, purpose, edi_ref, version FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: TxState; h_reservation_id: string | null; payee_bank_id: string; payee_account_hash: string | null; payer_bank_id: string; amount_value: number; purpose: string | null; edi_ref: string | null; version: number }>()
  if (!tx) return

  if (!isValidTransition(tx.state, 'PAYEE_EXEC_CONFIRMED')) return

  const updated = await db.prepare(
    `UPDATE Transactions SET state='PAYEE_EXEC_CONFIRMED', payee_bank_proof_ref=?, updated_at=?, version=version+1
     WHERE txid=? AND state=? AND version=?`
  ).bind(bankProofRefJson, now, txid, tx.state, tx.version).run()

  if ((updated.meta.changes ?? 0) === 0) return

  await writeFinalityLog(db, {
    txid, event_type: 'PayeeExecConfirmed', state_from: tx.state, state_to: 'PAYEE_EXEC_CONFIRMED',
    payload_json: JSON.stringify({ payee_bank_proof_ref: JSON.parse(bankProofRefJson) }), txid_or_gtid: txid,
  })

  // SETTLED への遷移（CAS version guard 付き: 二重実行防止）
  const txAfterPayee = await db.prepare(
    `SELECT version FROM Transactions WHERE txid = ? AND state = 'PAYEE_EXEC_CONFIRMED'`
  ).bind(txid).first<{ version: number }>()
  if (!txAfterPayee) return
  const settledResult = await db.prepare(
    `UPDATE Transactions SET state='SETTLED', updated_at=?, version=version+1 WHERE txid=? AND state='PAYEE_EXEC_CONFIRMED' AND version=?`
  ).bind(now, txid, txAfterPayee.version).run()
  if ((settledResult.meta.changes ?? 0) === 0) return
  await writeFinalityLog(db, {
    txid, event_type: 'Settled', state_from: 'PAYEE_EXEC_CONFIRMED', state_to: 'SETTLED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })
  // H予約解放は DNS_CYCLE_SETTLED 時に dns.ts で実施（仕様: DNS決済完了後）

  // SSE: 状態変更イベントを発行
  await publishEvent(db, tx.payee_bank_id, 'TX_STATE_CHANGED', { txid, newState: 'SETTLED' })

  // クレジット通知: 着金通知を生成して即時配送試行
  let notificationId: string | null = null
  let notificationDelivered = false
  try {
    notificationId = await createCreditNotification(
      db, txid, tx.payee_bank_id, tx.payee_account_hash ?? '', { value: tx.amount_value, currency: 'JPY' },
      tx.payer_bank_id, tx.purpose ?? null, tx.edi_ref ?? null,
    )
    await deliverNotification(db, notificationId, env)
    notificationDelivered = true
    // SSE: 着金通知イベントを発行
    await publishEvent(db, tx.payee_bank_id, 'CREDIT_RECEIVED', { txid, amount: tx.amount_value })
  } catch (err) {
    console.error(`[orchestrator] credit notification failed for ${txid}:`, err)
  }
  // FinalityLog: 着金通知の配送結果を記録（配送成否の説明可能性を確保）
  await writeFinalityLog(db, {
    txid, event_type: 'CreditNotificationAttempted',
    state_from: 'SETTLED', state_to: 'SETTLED',
    payload_json: JSON.stringify({
      notification_id: notificationId,
      delivered: notificationDelivered,
      payee_bank_id: tx.payee_bank_id,
    }),
    txid_or_gtid: txid,
  })

  // 仕向銀行（payer bank）への決済完了通知: 入金結果通知の双方向完結
  // 報告書「論点2: 入金結果通知機能」—被仕向銀行への通知に加え、仕向銀行にも確定通知を送る
  try {
    await callBankIngress(tx.payer_bank_id, 'debit-settled', {
      request_id: `DEBIT-SETTLED-${txid}`,
      txid,
      amount: { value: tx.amount_value, currency: 'JPY' },
      payee_bank_id: tx.payee_bank_id,
      settled_at: now,
    }, env)
  } catch (err) {
    console.error(`[orchestrator] debit-settled notification failed for ${txid}:`, err)
  }

  // Reversal completion: 救済取引が SETTLED に到達 → ReversalRecords を COMPLETED に
  if (txid.startsWith('TX-REV-')) {
    const { completeReversal } = await import('./reversal')
    await completeReversal(txid, db).catch(e =>
      console.error(`[orchestrator] completeReversal failed for ${txid}:`, e))
  }

  // GTID leg 完了確認: 全 leg が SETTLED になったら GT_SETTLED へ遷移
  if (txid.startsWith('TX-GT-')) {
    const leg = await db.prepare(
      `SELECT gtid FROM GtidLegs WHERE txid = ?`
    ).bind(txid).first<{ gtid: string }>()
    if (leg) {
      await checkAndFinalizeGtid(leg.gtid, db)
    }
  }
}

/**
 * Check whether all legs of a GTID collaborative transaction have settled.
 * If all legs are SETTLED, transitions the GT to GT_SETTLED and updates all
 * leg states to LEG_SETTLED. If any leg is SUSPENDED or FAILED_EXECUTION,
 * transitions to GT_SUSPENDED for manual resolution.
 *
 * Exported for use by timeout_sweep to recover stuck GTIDs.
 *
 * @param gtid - Global Transaction ID
 * @param db   - D1 database handle
 */
export async function checkAndFinalizeGtid(gtid: string, db: D1Database): Promise<void> {
  const now = nowISO()
  const gt = await db.prepare(
    `SELECT state, version, leg_count FROM GtidTransactions WHERE gtid = ?`
  ).bind(gtid).first<{ state: string; version: number; leg_count: number }>()
  if (!gt || gt.state !== 'GT_DECIDED_TO_SETTLE') return

  // 全 GtidLegs の対応 Transaction 状態を確認
  const legs = await db.prepare(
    `SELECT gl.txid, t.state AS tx_state
     FROM GtidLegs gl
     LEFT JOIN Transactions t ON gl.txid = t.txid
     WHERE gl.gtid = ?`
  ).bind(gtid).all<{ txid: string; tx_state: string | null }>()

  // 失敗 leg がある場合は GT_SUSPENDED へ遷移
  const anyFailed = legs.results.some(
    l => l.tx_state === 'SUSPENDED' || l.tx_state === 'FAILED_EXECUTION'
  )
  if (anyFailed) {
    const failUpdated = await db.prepare(
      `UPDATE GtidTransactions SET state='GT_SUSPENDED', updated_at=?, version=version+1
       WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE' AND version=?`
    ).bind(now, gtid, gt.version).run()
    if ((failUpdated.meta.changes ?? 0) > 0) {
      await writeFinalityLog(db, {
        txid: null, event_type: 'GtidSuspended',
        state_from: 'GT_DECIDED_TO_SETTLE', state_to: 'GT_SUSPENDED',
        payload_json: JSON.stringify({ gtid, reason: 'LEG_EXECUTION_FAILED' }),
        txid_or_gtid: gtid,
      })
    }
    return
  }

  // PAYEEレグは Transaction を持たないため txid=null になる。
  // null txid レグは PAYER Transaction の着金フローで実質的に完了済みとみなす。
  const allSettled = legs.results.every(l => l.tx_state === 'SETTLED' || l.txid === null)
  if (!allSettled) return

  // legs_settled_count を leg_count に更新
  const updated = await db.prepare(
    `UPDATE GtidTransactions SET state='GT_SETTLED', legs_settled_count=?, updated_at=?, version=version+1
     WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE' AND version=?`
  ).bind(gt.leg_count, now, gtid, gt.version).run()

  if ((updated.meta.changes ?? 0) > 0) {
    // 全 GtidLegs を LEG_SETTLED に更新
    await db.prepare(
      `UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?, version=version+1 WHERE gtid=?`
    ).bind(now, gtid).run()

    await writeFinalityLog(db, {
      txid: null, event_type: 'GtidSettled', state_from: 'GT_DECIDED_TO_SETTLE', state_to: 'GT_SETTLED',
      payload_json: JSON.stringify({ gtid }), txid_or_gtid: gtid,
    })
  }
}

/**
 * Finalize a cancelled transaction by transitioning DECIDED_CANCEL to CANCELLED.
 * DECIDED_CANCEL is a transient state that must be resolved immediately.
 *
 * @param txid - Transaction ID
 * @param db   - D1 database handle
 */
export async function finalizeCancelledTx(txid: string, db: D1Database): Promise<void> {
  const now = nowISO()
  const updated = await db.prepare(
    `UPDATE Transactions SET state='CANCELLED', updated_at=?, version=version+1 WHERE txid=? AND state='DECIDED_CANCEL'`
  ).bind(now, txid).run()
  if ((updated.meta.changes ?? 0) > 0) {
    await writeFinalityLog(db, {
      txid, event_type: 'Cancelled', state_from: 'DECIDED_CANCEL', state_to: 'CANCELLED',
      payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
    })
  }
}

/**
 * Suspend a transaction due to timeout, execution failure, or filter rejection.
 * Uses CAS (version guard) to prevent TOCTOU conflicts. Automatically opens
 * a Case for manual investigation and checks GTID leg status if applicable.
 *
 * @param txid       - Transaction ID
 * @param reasonCode - Reason for suspension (e.g. 'EXEC_DEBIT_FAILED')
 * @param db         - D1 database handle
 * @param details    - Optional structured context (e.g. bank response, actor) recorded in FinalityLog
 */
export async function suspendTx(
  txid: string, reasonCode: string, db: D1Database,
  details?: Record<string, unknown>,
): Promise<void> {
  const now = nowISO()
  // version も取得して CAS UPDATE で TOCTOU 競合を防ぐ
  const tx = await db
    .prepare(`SELECT state, version FROM Transactions WHERE txid = ?`)
    .bind(txid).first<{ state: TxState; version: number }>()
  if (!tx) return

  if (!isValidTransition(tx.state, 'SUSPENDED')) return

  const updated = await db.prepare(
    `UPDATE Transactions SET state='SUSPENDED', reason_code=?, updated_at=?, version=version+1
     WHERE txid=? AND state=? AND version=?`
  ).bind(reasonCode, now, txid, tx.state, tx.version).run()
  if ((updated.meta.changes ?? 0) === 0) {
    // 競合で CAS 失敗: 既に別操作が状態を変更済み（SETTLED 等）のためスキップ
    console.error(`[orchestrator] suspendTx CAS failed for ${txid}: state=${tx.state} may have advanced`)
    return
  }
  await writeFinalityLog(db, {
    txid, event_type: 'Suspended', state_from: tx.state, state_to: 'SUSPENDED',
    payload_json: JSON.stringify({ reason_code: reasonCode, ...details }), txid_or_gtid: txid,
  })

  // CASE 起票
  await openCase(db, { related_txid: txid, reason_code: reasonCode, opened_by: 'ZC', description: `Auto-suspended: ${reasonCode}` })

  // TX-GT-* leg が SUSPENDED になった場合、GT を GT_SUSPENDED へ遷移させる
  if (txid.startsWith('TX-GT-')) {
    const leg = await db.prepare(
      `SELECT gtid FROM GtidLegs WHERE txid = ?`
    ).bind(txid).first<{ gtid: string }>()
    if (leg) {
      await checkAndFinalizeGtid(leg.gtid, db)
    }
  }
}

// ---------------------------------------------------------------------------
// Queue message dispatcher
// ---------------------------------------------------------------------------

/**
 * Central queue message dispatcher. Routes at-least-once messages to the
 * appropriate handler based on message type. Re-throws errors to trigger
 * queue retry (at-least-once delivery guarantee).
 *
 * Supported message types:
 * - ZC_BANK_RESERVE:  HTLC lock processing
 * - ZC_BANK_DEBIT:    Execute payer debit (proof "a")
 * - ZC_BANK_CREDIT:   Execute payee credit (proof "b")
 * - ZC_RESUME_CREDIT: Retry credit after payee approval
 * - ZC_BANK_RELEASE:  Release H-reservation and bank suspense
 * - ZC_BANK_LEG_READY: GTID leg ready-check
 * - ZC_STATE_ADVANCE:  Lane-specific state advancement
 * - ZC_IGS_CALLBACK:   BOJ/IGS settlement callback
 *
 * @param msg - Queue message with type discriminator
 * @param env - Worker environment bindings
 */
export async function processQueueMessage(msg: QueueMessage, env: Env): Promise<void> {
  try {
    switch (msg.type) {
      case 'ZC_BANK_RESERVE': {
        const p = msg.payload as { htlc_id: string; txid: string }
        const { lockHtlc } = await import('./lanes/htlc')
        await lockHtlc(p.htlc_id, env)
        break
      }
      case 'ZC_BANK_DEBIT': {
        const p = msg.payload as { txid: string; payer_bank_id: string; payee_bank_id: string; amount: { value: number; currency: string }; decision_proof_ref: string; reservation_id?: string; lane?: string; payer_account_hash?: string }
        // 再試行で同一 request_id を使うよう txid から決定論的に生成
        const t0 = Date.now()
        const bankResp = await callBankExecuteDebit(p.payer_bank_id, {
          request_id: `DEBIT-${p.txid}`, txid: p.txid, amount: p.amount,
          decision_proof_ref: p.decision_proof_ref,
          h_reservation: p.reservation_id ? { reservation_id: p.reservation_id, mode: 'RESERVED' } : undefined,
          lane: p.lane as any,
          payer_account_hash: p.payer_account_hash,  // HV用アカウントハッシュを伝播
        }, env)
        await logTxEvent(env.DB, {
          txid: p.txid, actor: `BANK_${p.payer_bank_id}`, action: 'EXECUTE_DEBIT',
          status: bankResp.result === 'OK' ? 'OK' : 'NG',
          reason_code: bankResp.result !== 'OK' ? ((bankResp as unknown as Record<string, unknown>).reason_code as string | undefined) : null,
          amount: p.amount.value, bank_id: p.payer_bank_id,
          duration_ms: Date.now() - t0,
        })
        if (bankResp.result === 'OK') {
          await onPayerExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env)
          // HIGH_VALUE: デビット確認後に IGS 決済を開始する。
          // advanceHighValue ではなくここで呼ぶことで、IGS コールバックが
          // PAYER_EXEC_CONFIRMED 状態を確実に見られるようにする。
          if (p.lane === 'HIGH_VALUE') {
            const { initiateIgsSettlement } = await import('./igs')
            await env.DB.prepare(
              `UPDATE Transactions SET external_settlement_status='PENDING', updated_at=? WHERE txid=?`
            ).bind(nowISO(), p.txid).run()
            await initiateIgsSettlement(
              env.DB, p.txid,
              { value: p.amount.value, currency: p.amount.currency },
              p.payer_bank_id, p.payee_bank_id,
              env,
            )
          }
        } else {
          await suspendTx(p.txid, 'EXEC_DEBIT_FAILED', env.DB, {
            bank_id: p.payer_bank_id,
            bank_result: (bankResp as unknown as Record<string, unknown>).result,
            bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
          })
        }
        break
      }
      case 'ZC_BANK_CREDIT': {
        const p = msg.payload as { txid: string; payee_bank_id: string; amount: { value: number; currency: string }; decision_proof_ref: string; payee_account_hash?: string }
        // 再試行で同一 request_id を使うよう txid から決定論的に生成
        const t1 = Date.now()
        const bankResp = await callBankExecuteCredit(p.payee_bank_id, {
          request_id: `CREDIT-${p.txid}`, txid: p.txid, amount: p.amount,
          decision_proof_ref: p.decision_proof_ref,
          payee_account_hash: p.payee_account_hash,
        }, env)
        await logTxEvent(env.DB, {
          txid: p.txid, actor: `BANK_${p.payee_bank_id}`, action: 'EXECUTE_CREDIT',
          status: bankResp.result === 'OK' ? 'OK' : bankResp.result === 'PENDING_APPROVAL' ? 'PENDING' : 'NG',
          reason_code: bankResp.result === 'FILTER_REJECTED' ? bankResp.reason_code
            : bankResp.result === 'PENDING_APPROVAL' ? 'AWAITING_PAYEE_APPROVAL' : null,
          amount: p.amount.value, bank_id: p.payee_bank_id,
          details: bankResp.result === 'PENDING_APPROVAL' ? { approval_id: bankResp.approval_id } : undefined,
          duration_ms: Date.now() - t1,
        })
        if (bankResp.result === 'OK') {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env)
        } else if (bankResp.result === 'PENDING_APPROVAL') {
          // 顧客承認待ち: SUSPENDED に遷移し CASE を起票
          // ZC_BANK_CREDIT は onPayerExecConfirmed から投入されるため直前状態は PAYER_EXEC_CONFIRMED
          await suspendTx(p.txid, 'AWAITING_PAYEE_APPROVAL', env.DB)
          await writeFinalityLog(env.DB, {
            txid: p.txid, event_type: 'FilterPending',
            state_from: 'PAYER_EXEC_CONFIRMED', state_to: 'SUSPENDED',
            payload_json: JSON.stringify({ approval_id: bankResp.approval_id }),
            txid_or_gtid: p.txid,
          })
        } else if (bankResp.result === 'FILTER_REJECTED') {
          // 着金フィルタで拒否: SUSPENDED に遷移（行員が手動解決）
          // ZC_BANK_CREDIT は onPayerExecConfirmed から投入されるため直前状態は PAYER_EXEC_CONFIRMED
          await suspendTx(p.txid, 'PAYEE_FILTER_REJECTED', env.DB)
          await writeFinalityLog(env.DB, {
            txid: p.txid, event_type: 'FilterRejected',
            state_from: 'PAYER_EXEC_CONFIRMED', state_to: 'SUSPENDED',
            payload_json: JSON.stringify({ filter_id: bankResp.filter_id, reason_code: bankResp.reason_code }),
            txid_or_gtid: p.txid,
          })
        } else {
          await suspendTx(p.txid, 'EXEC_CREDIT_FAILED', env.DB, {
            bank_id: p.payee_bank_id,
            bank_result: (bankResp as unknown as Record<string, unknown>).result,
            bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
          })
        }
        break
      }
      case 'ZC_RESUME_CREDIT': {
        // 顧客が着金承認を行った後、銀行から呼ばれる resume
        const p = msg.payload as { txid: string; payee_bank_id: string; payee_account_hash?: string }
        // 再度 execute-credit を試行（フィルタは通過済みのため新しい request_id で呼ぶ）
        // 決定論的 request_id: キューリトライ時に同一 ID を生成して冪等性を保証
        const resumeRequestId = `CREDIT-RESUME-${p.txid}`
        // 元の取引情報を取得
        const txInfo = await env.DB.prepare(
          `SELECT amount_value, decision_proof_ref, payee_account_hash FROM Transactions WHERE txid=?`
        ).bind(p.txid).first<{ amount_value: number; decision_proof_ref: string | null; payee_account_hash: string | null }>()
        if (!txInfo) { console.error('[ZC_RESUME_CREDIT] txid not found:', p.txid); break }
        const bankResp = await callBankExecuteCredit(p.payee_bank_id, {
          request_id: resumeRequestId, txid: p.txid,
          amount: { value: txInfo.amount_value, currency: 'JPY' },
          decision_proof_ref: txInfo.decision_proof_ref ?? '',
          payee_account_hash: p.payee_account_hash ?? txInfo.payee_account_hash ?? undefined,
        }, env)
        if (bankResp.result === 'OK') {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env)
        } else {
          // 顧客承認後のクレジット再試行が失敗（口座凍結等）。
          // 既に SUSPENDED 状態のため suspendTx（SUSPENDED→SUSPENDED は不正遷移）は使えない。
          // reason_code を上書きして FinalityLog + Case に記録する。
          console.error(`[ZC_RESUME_CREDIT] retry failed: ${JSON.stringify(bankResp)}`)
          const resumeFailReason = 'EXEC_CREDIT_FAILED_ON_RESUME'
          await env.DB.prepare(
            `UPDATE Transactions SET reason_code=?, updated_at=?, version=version+1 WHERE txid=? AND state='SUSPENDED'`
          ).bind(resumeFailReason, nowISO(), p.txid).run()
          await writeFinalityLog(env.DB, {
            txid: p.txid, event_type: 'ResumeCreditFailed',
            state_from: 'SUSPENDED', state_to: 'SUSPENDED',
            payload_json: JSON.stringify({
              reason_code: resumeFailReason,
              bank_id: p.payee_bank_id,
              bank_result: (bankResp as unknown as Record<string, unknown>).result,
              bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
            }),
            txid_or_gtid: p.txid,
          })
          await openCase(env.DB, {
            related_txid: p.txid, reason_code: resumeFailReason,
            opened_by: 'ZC', description: `Resume credit failed after payee approval: ${JSON.stringify(bankResp)}`,
          })
        }
        break
      }
      case 'ZC_BANK_RELEASE': {
        // H解放に加えて銀行側の別段預金も解放
        const p = msg.payload as { reservation_id: string; txid?: string; bank_id?: string }
        await releaseH(p.reservation_id, env.DB)
        if (p.txid && p.bank_id) {
          // reservation_id から決定論的な request_id を生成
          await callBankReleaseReserve(p.bank_id, {
            request_id: `RELEASE-${p.reservation_id}`, txid: p.txid, reservation_ref: p.reservation_id,
          }, env).catch(e => console.error(`[ZC_BANK_RELEASE] release-reserve failed: ${e}`))
        }
        break
      }
      case 'ZC_BANK_LEG_READY': {
        const p = msg.payload as { gtid: string }
        const { advanceGtid } = await import('./lanes/gtid')
        await advanceGtid(p.gtid, env)
        break
      }
      case 'ZC_STATE_ADVANCE': {
        const p = msg.payload as { txid: string; action: string }
        if (p.action === 'ADVANCE_STANDARD') {
          const { advanceStandard } = await import('./lanes/standard')
          await advanceStandard(p.txid, env)
        } else if (p.action === 'ADVANCE_BULK') {
          const { advanceBulk } = await import('./lanes/bulk')
          await advanceBulk(p.txid, env)
        } else if (p.action === 'ADVANCE_HV') {
          const { advanceHighValue } = await import('./lanes/highvalue')
          await advanceHighValue(p.txid, env)
        } else if (p.action === 'AUTO_AUTHORIZE') {
          const { authorizeStandard } = await import('./lanes/standard')
          await authorizeStandard(p.txid, true, env)
        }
        break
      }
      case 'ZC_IGS_CALLBACK': {
        const p = msg.payload as import('../types').IgsCallbackInput
        const { handleIgsCallback } = await import('./igs')
        await handleIgsCallback(env.DB, p, env)
        break
      }
      default:
        console.error('[queue] Unknown message type:', msg.type)
    }
  } catch (err) {
    console.error('[queue] Error processing message:', err)
    throw err  // at-least-once: 再試行させる
  }
}

// ---------------------------------------------------------------------------
// ZC -> Bank internal call hub (same-Worker routing)
// ---------------------------------------------------------------------------

/**
 * Request the payer bank to reserve funds in suspense for a pending transfer.
 *
 * @param bankId - Target bank ID
 * @param req    - Reserve funds request payload
 * @param env    - Worker environment bindings
 * @returns Reserve funds response from the bank
 */
export async function callBankReserveFunds(
  bankId: string, req: ReserveFundsRequest, env: Env,
): Promise<ReserveFundsResponse> {
  return callBankIngress(bankId, 'reserve-funds', req, env)
}

/**
 * Execute a debit on the payer bank (proof "a" generation).
 *
 * @param bankId - Payer bank ID
 * @param req    - Execute debit request payload
 * @param env    - Worker environment bindings
 * @returns Execute debit response with bank proof reference
 */
export async function callBankExecuteDebit(
  bankId: string, req: ExecuteDebitRequest, env: Env,
): Promise<ExecuteDebitResponse> {
  return callBankIngress(bankId, 'execute-debit', req, env)
}

/**
 * Execute a credit on the payee bank (proof "b" generation).
 *
 * @param bankId - Payee bank ID
 * @param req    - Execute credit request payload
 * @param env    - Worker environment bindings
 * @returns Execute credit result (OK, PENDING_APPROVAL, or FILTER_REJECTED)
 */
export async function callBankExecuteCredit(
  bankId: string, req: ExecuteCreditRequest, env: Env,
): Promise<ExecuteCreditResult> {
  return callBankIngress(bankId, 'execute-credit', req, env)
}

/**
 * Release a previously reserved suspense hold at the bank.
 *
 * @param bankId - Bank ID holding the reservation
 * @param req    - Release reserve request payload
 * @param env    - Worker environment bindings
 * @returns Release reserve response
 */
export async function callBankReleaseReserve(
  bankId: string, req: ReleaseReserveRequest, env: Env,
): Promise<ReleaseReserveResponse> {
  return callBankIngress(bankId, 'release-reserve', req, env)
}

/**
 * Check if a GTID leg participant bank is ready for settlement.
 *
 * @param bankId - Participant bank ID
 * @param req    - Leg ready check request payload
 * @param env    - Worker environment bindings
 * @returns Leg ready check response (OK or NG)
 */
export async function callBankLegReadyCheck(
  bankId: string, req: LegReadyCheckRequest, env: Env,
): Promise<LegReadyCheckResponse> {
  return callBankIngress(bankId, 'leg-ready-check', req, env)
}

/**
 * Run AML/sanctions authority check against the payer bank.
 *
 * @param bankId - Payer bank ID
 * @param req    - Authority check request payload
 * @param env    - Worker environment bindings
 * @returns Authority check response (OK or NG with reason)
 */
export async function callBankAuthorityCheck(
  bankId: string, req: AuthorityCheckRequest, env: Env,
): Promise<AuthorityCheckResponse> {
  return callBankIngress(bankId, 'authority-check', req, env)
}

/**
 * Verify payee account name against the payee bank's records.
 *
 * @param bankId - Payee bank ID
 * @param req    - Name check request payload
 * @param env    - Worker environment bindings
 * @returns Name check response (MATCH, MISMATCH, or NOT_FOUND)
 */
export async function callBankNameCheck(
  bankId: string, req: NameCheckRequest, env: Env,
): Promise<NameCheckResponse> {
  return callBankIngress(bankId, 'name-check', req, env)
}

/**
 * Internal routing hub: dispatches bank commands to the Bank Ingress handler
 * within the same Worker (no external HTTP call needed).
 *
 * @param bankId  - Target bank ID
 * @param command - Ingress command name (e.g. 'reserve-funds', 'execute-debit')
 * @param payload - Command-specific request payload
 * @param env     - Worker environment bindings
 * @returns Typed response from the bank handler
 */
async function callBankIngress<T>(
  bankId: string, command: string, payload: unknown, env: Env,
): Promise<T> {
  const { allowRequest, recordSuccess, recordFailure } = await import('./circuit_breaker')

  // Circuit Breaker: 参加行への送信可否を判定
  const allowed = await allowRequest(bankId, env.DB)
  if (!allowed) {
    console.warn(`[orchestrator] Circuit OPEN for bank ${bankId}, fast-failing ${command}`)
    // 送信禁止 → 即座にエラー応答を返す（再送嵐防止）
    return { result: 'ERROR', reason_code: 'CIRCUIT_OPEN' } as unknown as T
  }

  // 同一 Worker 内部呼び出し: Bank Ingress ハンドラを直接呼ぶ
  const { handleBankIngress } = await import('../bank/ingress')
  try {
    const result = await handleBankIngress(bankId, command, payload, env) as T
    // 成功 → 回路リセット
    await recordSuccess(bankId, env.DB)
    return result
  } catch (err) {
    // 失敗 → 障害カウンタ加算（閾値超過で回路 OPEN）
    await recordFailure(bankId, env.DB)
    throw err
  }
}
