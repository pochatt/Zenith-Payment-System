/**
 * @file GTID (Global Transaction ID) coordinated multi-leg transaction
 *       processing. Manages leg-ready-check and atomic multi-bank settlement.
 * @module zc/lanes/gtid
 */
import type { Env, GtidRegisterRequest, GtidTransactionRow, GtidLegRow } from '../../types'
import { nowISO } from '../../types'
import { writeFinalityLog, callBankLegReadyCheck } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { newUUID } from '../../shared/idempotency'
import { reserveH, lockH, releaseH } from '../h_model'
import { getOrCreateDnsCycle } from '../dns'

/**
 * GTID 登録: GT_RECEIVED + legs = LEG_REGISTERED
 */
export async function registerGtid(req: GtidRegisterRequest, env: Env): Promise<{
  result: 'GTID_ACCEPTED'; gtid: string; state: string
}> {
  const db = env.DB
  const now = nowISO()
  // total_amount は PAYER leg の合計（全 leg 合算は2倍になる）
  const totalAmount = req.legs.filter(l => l.role === 'PAYER').reduce((s, l) => s + l.amount.value, 0)

  const stmts = [
    db.prepare(
      `INSERT OR IGNORE INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count,
        legs_settled_count, expires_at, version, created_at, updated_at)
       VALUES (?, 'GT_RECEIVED', ?, ?, ?, 0, 0, ?, 0, ?, ?)`
    ).bind(req.gtid, req.legs[0]?.bank_id ?? '', totalAmount, req.legs.length, req.expires_at ?? null, now, now),
  ]

  for (const leg of req.legs) {
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO GtidLegs
       (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LEG_REGISTERED', 0, ?, ?)`
    ).bind(leg.leg_id, req.gtid, leg.role, leg.bank_id, leg.account_hash, leg.amount.value, now, now))
  }

  await db.batch(stmts)

  await writeFinalityLog(db, {
    txid: null, event_type: 'GtidRegistered', state_from: null, state_to: 'GT_RECEIVED',
    payload_json: JSON.stringify({ gtid: req.gtid, leg_count: req.legs.length }),
    txid_or_gtid: req.gtid,
  })

  // 非同期で全 leg の ready-check を実行
  await env.QUEUE.send({
    type: 'ZC_BANK_LEG_READY',
    payload: { gtid: req.gtid },
    gtid: req.gtid, attempt: 0, enqueued_at: now,
  })

  return { result: 'GTID_ACCEPTED', gtid: req.gtid, state: 'GT_RECEIVED' }
}

/**
 * 全 leg の ready-check を実行し、全員 OK なら Decision 確定
 * QueueConsumer から呼ばれる
 */
export async function advanceGtid(gtid: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const gt = await db
    .prepare(`SELECT * FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<GtidTransactionRow>()
  if (!gt || gt.state !== 'GT_RECEIVED') return

  const legs = await db
    .prepare(`SELECT * FROM GtidLegs WHERE gtid = ?`)
    .bind(gtid)
    .all<GtidLegRow>()

  // GT_PRECHECKED に遷移（CAS: 並行処理による二重実行を防ぐ）
  const toPrechecked = await db.prepare(
    `UPDATE GtidTransactions SET state='GT_PRECHECKED', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_RECEIVED'`
  ).bind(now, gtid).run()

  // changes=0 は他の Worker が先に遷移済み → 二重実行しない
  if ((toPrechecked.meta.changes ?? 0) === 0) return

  // 各 leg の ready-check
  let allReady = true
  for (const leg of legs.results) {
    // キュー再試行で同一 request_id を保証（leg_id は一意なので安全）
    const checkResult = await callBankLegReadyCheck(leg.bank_id, {
      request_id: `LEG-READY-${leg.leg_id}`, gtid, leg_id: leg.leg_id, role: leg.role,
      amount: { value: leg.amount_value, currency: 'JPY' }, account_hash: leg.account_hash,
    }, env)

    if (checkResult.result === 'OK') {
      await db.prepare(
        `UPDATE GtidLegs SET state='LEG_READY_CHECKED', updated_at=?, version=version+1 WHERE leg_id=?`
      ).bind(now, leg.leg_id).run()
    } else {
      allReady = false
      await db.prepare(
        `UPDATE GtidLegs SET state='LEG_FAILED', updated_at=?, version=version+1 WHERE leg_id=?`
      ).bind(now, leg.leg_id).run()
    }
  }

  if (!allReady) {
    await db.prepare(
      `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=?`
    ).bind(now, gtid).run()
    await writeFinalityLog(db, {
      txid: null, event_type: 'GtidDecidedCancel', state_from: 'GT_PRECHECKED', state_to: 'GT_DECIDED_CANCEL',
      payload_json: JSON.stringify({ gtid, reason: 'LEG_READY_CHECK_NG' }), txid_or_gtid: gtid,
    })
    await finalizeGtidCancelled(gtid, db)
    return
  }

  // Bug #6 fix: PAYER/PAYEE 両ロールの存在確認を Decision 確定前に実施
  // Decision後に検証すると GT_DECIDED_TO_SETTLE → GT_DECIDED_CANCEL という不正遷移が FinalityLog に記録される
  const payerLegs = legs.results.filter(l => l.role === 'PAYER')
  const payeeLegs = legs.results.filter(l => l.role === 'PAYEE')
  const payerLeg = payerLegs[0]
  const payeeLeg = payeeLegs[0]
  if (!payerLeg || !payeeLeg) {
    console.error(`[gtid] GTID ${gtid} is missing PAYER or PAYEE leg — cancelling`)
    await db.prepare(
      `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
    ).bind(now, gtid).run()
    await writeFinalityLog(db, {
      txid: null, event_type: 'GtidDecidedCancel', state_from: 'GT_PRECHECKED', state_to: 'GT_DECIDED_CANCEL',
      payload_json: JSON.stringify({ gtid, reason: 'MISSING_LEG_ROLE' }), txid_or_gtid: gtid,
    })
    await finalizeGtidCancelled(gtid, db)
    return
  }

  // Decision 確定前に PAYER leg の H 予約を取得・ロック
  const hReservations = new Map<string, string>() // leg_id → reservationId
  for (const leg of legs.results) {
    if (leg.role !== 'PAYER') continue
    const legTxid = `TX-GT-${leg.leg_id}`
    const reservationId = await reserveH(leg.bank_id, legTxid, leg.amount_value, db)
    if (!reservationId) {
      // H超過 → 既確保済みを解放してキャンセル
      for (const resId of hReservations.values()) {
        await releaseH(resId, db)
      }
      await db.prepare(
        `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
      ).bind(now, gtid).run()
      await writeFinalityLog(db, {
        txid: null, event_type: 'GtidDecidedCancel', state_from: 'GT_PRECHECKED', state_to: 'GT_DECIDED_CANCEL',
        payload_json: JSON.stringify({ gtid, reason: 'H_LIMIT_EXCEEDED' }), txid_or_gtid: gtid,
      })
      await finalizeGtidCancelled(gtid, db)
      return
    }
    // DECIDED_TO_SETTLE 直行なので即 LOCK
    await lockH(reservationId, db)
    hReservations.set(leg.leg_id, reservationId)
  }

  // 全 leg OK → Decision 原子確定
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  // dns_cycle_id を設定（DNS清算でのH解放に必要）
  const dnsCycleId = await getOrCreateDnsCycle(db, now)

  // Bug #5 fix: AND state='GT_PRECHECKED' でステートガードを追加し、
  // 並行タイムアウトキャンセルが先に GT_DECIDED_CANCEL に遷移していた場合に上書きしない
  const decisionUpdated = await db.prepare(
    `UPDATE GtidTransactions SET state='GT_DECIDED_TO_SETTLE', legs_ready_count=leg_count, updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
  ).bind(now, gtid).run()

  if ((decisionUpdated.meta.changes ?? 0) === 0) {
    // 並行処理で既にキャンセル等に遷移済み → 確保済みH予約を解放してスキップ
    for (const resId of hReservations.values()) {
      await releaseH(resId, db)
    }
    console.warn(`[gtid] advanceGtid: decision CAS failed for ${gtid} (already transitioned from GT_PRECHECKED)`)
    return
  }

  await writeFinalityLog(db, {
    txid: null, event_type: 'GtidDecided', state_from: 'GT_PRECHECKED', state_to: 'GT_DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ gtid, decision_proof_ref: decisionProofRef }),
    txid_or_gtid: gtid,
  })

  // PAYERレグ用 Transaction を作成し Execution をキューへ投入する。
  // PAYEEレグは Transaction を持たない。クレジットは PAYER Transaction の
  // onPayerExecConfirmed → ZC_BANK_CREDIT フローで逐次実行されるため、
  // ここで直接 ZC_BANK_CREDIT を投入すると二重着金が発生する。

  for (const leg of legs.results) {
    // PAYEEレグは Transaction を作らず ZC_BANK_CREDIT も送らない。
    // クレジットは対応する PAYERレグ Transaction の onPayerExecConfirmed で投入される。
    if (leg.role === 'PAYEE') continue

    const txid = `TX-GT-${leg.leg_id}`
    // PAYER の対応 PAYEE を index で決定（存在しない場合は先頭 PAYEE を使用）
    const idx = payerLegs.indexOf(leg)
    const counterpartyPayeeLeg = payeeLegs[idx] ?? payeeLeg
    const hReservationId = hReservations.get(leg.leg_id) ?? null

    // Transactions レコードを作成（execute-debit/credit が参照する）
    // payer_bank_id / payee_bank_id に PAYER と対応 PAYEE の情報を格納し、
    // onPayerExecConfirmed がそのまま ZC_BANK_CREDIT に使えるようにする。
    await db.prepare(
      `INSERT OR IGNORE INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, schema_version, decision_proof_ref,
        h_reservation_id, dns_cycle_id, version, created_at, updated_at)
       VALUES (?, 'DEFERRED', 'DECIDED_TO_SETTLE', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', ?, ?, ?, 0, ?, ?)`
    ).bind(
      txid, leg.amount_value,
      leg.bank_id,                    // payer_bank_id
      leg.account_hash,               // payer_account_hash
      counterpartyPayeeLeg.bank_id,   // payee_bank_id
      counterpartyPayeeLeg.account_hash, // payee_account_hash
      `GTID-${gtid}-${leg.leg_id}`, decisionProofRef, hReservationId, dnsCycleId, now, now,
    ).run()

    // PAYERレグの GtidLegs に txid を紐付け
    await db.prepare(
      `UPDATE GtidLegs SET txid=?, updated_at=?, version=version+1 WHERE leg_id=?`
    ).bind(txid, now, leg.leg_id).run()

    await env.QUEUE.send({
      type: 'ZC_BANK_DEBIT',
      payload: {
        gtid, leg_id: leg.leg_id,
        payer_bank_id: leg.bank_id, payee_bank_id: counterpartyPayeeLeg.bank_id,
        txid, amount: { value: leg.amount_value, currency: 'JPY' },
        decision_proof_ref: decisionProofRef,
      },
      gtid, attempt: 0, enqueued_at: now,
    })
  }
}

// ---------------------------------------------------------------------------
// GTID キャンセル終端処理: GT_DECIDED_CANCEL → GT_CANCELLED
// ---------------------------------------------------------------------------
async function finalizeGtidCancelled(gtid: string, db: D1Database): Promise<void> {
  const now = nowISO()
  const updated = await db.prepare(
    `UPDATE GtidTransactions SET state='GT_CANCELLED', updated_at=?, version=version+1
     WHERE gtid=? AND state='GT_DECIDED_CANCEL'`
  ).bind(now, gtid).run()
  if ((updated.meta.changes ?? 0) > 0) {
    await writeFinalityLog(db, {
      txid: null, event_type: 'GtidCancelled', state_from: 'GT_DECIDED_CANCEL', state_to: 'GT_CANCELLED',
      payload_json: JSON.stringify({ gtid }), txid_or_gtid: gtid,
    })
  }
}
