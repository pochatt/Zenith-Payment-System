/**
 * @file HTLC lane processing. Hash Time-Locked Contract creation, locking, and
 *       preimage-based claim.
 * @module zc/lanes/htlc
 */
import type { Env, HtlcCreateRequest, HtlcClaimRequest, HtlcContractRow } from '../../types'
import { nowISO } from '../../types'
import { reserveH, lockH, releaseH } from '../h_model'
import { writeFinalityLog, callBankAuthorityCheck, callBankExecuteDebit, onPayerExecConfirmed, suspendTx, finalizeCancelledTx } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { sha256hex } from '../../shared/hmac'
import { newUUID } from '../../shared/idempotency'
import { getOrCreateDnsCycle } from '../dns'

/** ランダムなpreimageを生成（32バイト hex） */
async function generatePreimage(): Promise<string> {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * HTLC新規作成: HTLC_RECEIVED
 * hashlock は自動生成（ユーザー入力不要）
 * preimage を返却し、claim 時に使う
 */
export async function createHtlc(req: HtlcCreateRequest, env: Env): Promise<{
  result: 'CREATED' | 'ERROR'; htlc_id?: string; state?: string; reason_code?: string;
  hashlock?: string; preimage?: string
}> {
  const db = env.DB
  const now = nowISO()
  const txid = `TX-HTLC-${req.htlc_id}`

  // ハッシュを自動生成（ユーザーがhashlockを指定していない場合）
  let hashlock = req.hashlock
  let preimage: string | undefined
  if (!hashlock || hashlock === '') {
    preimage = await generatePreimage()
    hashlock = await sha256hex(preimage)
  }

  // Transactions レコード作成
  await db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'HTLC', 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', ?, ?, 0)`
  ).bind(txid, req.amount.value, req.payer_bank_id, req.payer_account_hash,
    req.payee_bank_id, req.payee_account_hash,
    req.idempotency_key, now, now).run()

  // HtlcContracts レコード
  await db.prepare(
    `INSERT OR IGNORE INTO HtlcContracts
     (htlc_id, txid, state, hashlock, timelock, amount_value,
      payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
      version, created_at, updated_at)
     VALUES (?, ?, 'HTLC_RECEIVED', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).bind(req.htlc_id, txid, hashlock, req.timelock,
    req.amount.value, req.payer_bank_id, req.payee_bank_id, now, now).run()

  await writeFinalityLog(db, {
    txid, event_type: 'HtlcCreated', state_from: null, state_to: 'HTLC_RECEIVED',
    payload_json: JSON.stringify({ htlc_id: req.htlc_id, hashlock, timelock: req.timelock }),
    txid_or_gtid: txid,
  })

  // 非同期で H予約 & Lock
  await env.QUEUE.send({
    type: 'ZC_BANK_RESERVE', payload: { htlc_id: req.htlc_id, txid },
    txid, attempt: 0, enqueued_at: now,
  })

  return { result: 'CREATED', htlc_id: req.htlc_id, state: 'HTLC_RECEIVED', hashlock, preimage }
}

/**
 * HTLC Lock処理（QueueConsumerから呼ばれる）
 * HTLC_RECEIVED → HTLC_LOCKED
 */
export async function lockHtlc(htlcId: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<HtlcContractRow>()
  if (!htlc || htlc.state !== 'HTLC_RECEIVED') return

  // timelockが過去なら即DECIDED_CANCEL
  if (new Date(htlc.timelock) <= new Date(now)) {
    await cancelHtlc(htlcId, htlc.txid, 'TIMELOCK_EXPIRED', db)
    return
  }

  // H予約 (ZC側)
  const reservationId = await reserveH(htlc.payer_bank_id, htlc.txid, htlc.amount_value, db)
  if (!reservationId) {
    await cancelHtlc(htlcId, htlc.txid, 'H_LIMIT_EXCEEDED', db)
    return
  }

  // Bank側 reserve-funds（SuspenseDetails を作成 → execute-debit 時に必要）
  // payer_account_hash は Transactions テーブルから取得
  const txForPayer = await db
    .prepare(`SELECT payer_account_hash FROM Transactions WHERE txid = ?`)
    .bind(htlc.txid).first<{ payer_account_hash: string | null }>()
  const { callBankReserveFunds } = await import('../orchestrator')
  const reserveResult = await callBankReserveFunds(htlc.payer_bank_id, {
    request_id: `RESERVE-${htlc.txid}`,
    txid: htlc.txid,
    amount: { value: htlc.amount_value, currency: 'JPY' },
    account_hash: txForPayer?.payer_account_hash ?? '',
  }, env)
  if (reserveResult.result === 'ERROR') {
    await cancelHtlc(htlcId, htlc.txid, reserveResult.reason_code ?? 'RESERVE_FAILED', db)
    return
  }

  // lockH は claim 成功時（DECIDED_TO_SETTLE）に呼ぶ
  // HTLC_LOCKED はまだ条件未成立 → H は RESERVED のまま

  // Transactions UPDATE に状態ガードを追加（重複実行防止）
  // Transactions.state を HTLC_LOCKED に設定: 総覧・明細でHTLC状態を正確に表示するため
  await db.batch([
    db.prepare(`UPDATE HtlcContracts SET state='HTLC_LOCKED', version=version+1, updated_at=? WHERE htlc_id=?`).bind(now, htlcId),
    db.prepare(`UPDATE Transactions SET state='HTLC_LOCKED', h_reservation_id=?, updated_at=?, version=version+1 WHERE txid=? AND state='RECEIVED'`).bind(reservationId, now, htlc.txid),
  ])

  await writeFinalityLog(db, {
    txid: htlc.txid, event_type: 'HtlcLocked', state_from: 'HTLC_RECEIVED', state_to: 'HTLC_LOCKED',
    payload_json: JSON.stringify({ htlc_id: htlcId, reservation_id: reservationId }),
    txid_or_gtid: htlc.txid,
  })
}

/**
 * preimage 提示: HTLC_LOCKED → HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE
 */
export async function claimHtlc(req: HtlcClaimRequest, env: Env): Promise<{
  result: 'ACCEPTED' | 'REJECTED'; htlc_id: string; state: string; reason_code?: string
}> {
  const db = env.DB
  const now = nowISO()

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>()

  if (!htlc) return { result: 'REJECTED', htlc_id: req.htlc_id, state: 'NOT_FOUND', reason_code: 'NOT_FOUND' }
  if (htlc.state !== 'HTLC_LOCKED') return { result: 'REJECTED', htlc_id: req.htlc_id, state: htlc.state, reason_code: 'INVALID_STATE' }

  // timelock 期限確認
  if (new Date(htlc.timelock) <= new Date(now)) {
    await cancelHtlc(req.htlc_id, htlc.txid, 'TIMELOCK_EXPIRED', db)
    return { result: 'REJECTED', htlc_id: req.htlc_id, state: 'DECIDED_CANCEL', reason_code: 'TIMELOCK_EXPIRED' }
  }

  // preimage 検証: SHA256(preimage) == hashlock
  const computedHash = await sha256hex(req.preimage)
  if (computedHash !== htlc.hashlock) {
    return { result: 'REJECTED', htlc_id: req.htlc_id, state: htlc.state, reason_code: 'INVALID_PREIMAGE' }
  }

  // timelockが翌日以降 → AML recheck
  const endOfToday = new Date(now.slice(0, 10) + 'T23:59:59Z')
  const needsRecheck = new Date(htlc.timelock) > endOfToday
  if (needsRecheck) {
    // 決定論的 request_id（claim リトライ時に重複 ZcRequests を防ぐ）
    const recheckResult = await callBankAuthorityCheck(htlc.payer_bank_id, {
      request_id: `RECHECK-${htlc.txid}`, txid: htlc.txid, check_type: 'RECHECK',
    }, env)
    if (recheckResult.result === 'NG') {
      await cancelHtlc(req.htlc_id, htlc.txid, 'RECHECK_AUTHORITY_NG', db)
      return { result: 'REJECTED', htlc_id: req.htlc_id, state: 'DECIDED_CANCEL', reason_code: 'RECHECK_AUTHORITY_NG' }
    }
  }

  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()

  // HTLC_LOCKED → HTLC_FULFILL_REQUESTED（中間状態）
  await db.batch([
    db.prepare(`UPDATE HtlcContracts SET state='HTLC_FULFILL_REQUESTED', version=version+1, updated_at=? WHERE htlc_id=?`).bind(now, req.htlc_id),
    db.prepare(`UPDATE Transactions SET state='HTLC_FULFILL_REQUESTED', updated_at=?, version=version+1 WHERE txid=? AND state='HTLC_LOCKED'`).bind(now, htlc.txid),
  ])
  await writeFinalityLog(db, {
    txid: htlc.txid, event_type: 'HtlcFulfillRequested', state_from: 'HTLC_LOCKED', state_to: 'HTLC_FULFILL_REQUESTED',
    payload_json: JSON.stringify({ htlc_id: req.htlc_id }), txid_or_gtid: htlc.txid,
  })

  // dns_cycle_id 設定
  const dnsCycleId = await getOrCreateDnsCycle(db, now)

  // claim 成功時に lockH（DECIDED_TO_SETTLE 時点）
  if (htlc.txid) {
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(htlc.txid).first<{ h_reservation_id: string | null }>()
    if (txForH?.h_reservation_id) {
      await lockH(txForH.h_reservation_id, db)
    }
  }

  // HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE
  // AND state='HTLC_FULFILL_REQUESTED' の状態ガードを追加
  await db.batch([
    db.prepare(`UPDATE HtlcContracts SET state='DECIDED_TO_SETTLE', secret_verified=1, version=version+1, updated_at=? WHERE htlc_id=?`).bind(now, req.htlc_id),
    db.prepare(`UPDATE Transactions SET state='DECIDED_TO_SETTLE', decision_proof_ref=?, finality_log_ref=?, dns_cycle_id=?, updated_at=?, version=version+1 WHERE txid=? AND state IN ('HTLC_FULFILL_REQUESTED','HTLC_LOCKED')`).bind(decisionProofRef, finalityLogRef, dnsCycleId, now, htlc.txid),
  ])

  await writeFinalityLog(db, {
    txid: htlc.txid, event_type: 'DecidedToSettle', state_from: 'HTLC_FULFILL_REQUESTED', state_to: 'DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ htlc_id: req.htlc_id, decision_proof_ref: decisionProofRef }),
    txid_or_gtid: htlc.txid,
  })

  // HTLC は timelock があるため、キューの遅延リスクを避けて同期的に debit を実行する
  const bankResp = await callBankExecuteDebit(htlc.payer_bank_id, {
    request_id: `DEBIT-${htlc.txid}`,
    txid: htlc.txid,
    amount: { value: htlc.amount_value, currency: 'JPY' },
    decision_proof_ref: decisionProofRef,
  }, env)

  if (bankResp.result === 'OK') {
    await onPayerExecConfirmed(htlc.txid, JSON.stringify(bankResp.bank_proof_ref), env)
    return { result: 'ACCEPTED', htlc_id: req.htlc_id, state: 'PAYER_EXEC_CONFIRMED' }
  } else {
    await suspendTx(htlc.txid, 'EXEC_DEBIT_FAILED', db)
    return { result: 'REJECTED', htlc_id: req.htlc_id, state: 'SUSPENDED', reason_code: 'EXEC_DEBIT_FAILED' }
  }
}

export async function cancelHtlc(
  htlcId: string, txid: string, reasonCode: string, db: D1Database,
): Promise<void> {
  const now = nowISO()
  // h_reservation_id を取得してH解放
  const txForH = await db
    .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
    .bind(txid).first<{ h_reservation_id: string | null }>()
  if (txForH?.h_reservation_id) {
    await releaseH(txForH.h_reservation_id, db)
  }
  await db.batch([
    db.prepare(`UPDATE HtlcContracts SET state='DECIDED_CANCEL', version=version+1, updated_at=? WHERE htlc_id=?`).bind(now, htlcId),
    db.prepare(`UPDATE Transactions SET state='DECIDED_CANCEL', reason_code=?, updated_at=?, version=version+1 WHERE txid=?`).bind(reasonCode, now, txid),
  ])
  await writeFinalityLog(db, {
    txid, event_type: 'HtlcCancelled', state_from: null, state_to: 'DECIDED_CANCEL',
    payload_json: JSON.stringify({ htlc_id: htlcId, reason_code: reasonCode }), txid_or_gtid: txid,
  })
  // DECIDED_CANCEL → CANCELLED
  await finalizeCancelledTx(txid, db)
}
