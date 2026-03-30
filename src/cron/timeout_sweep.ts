/**
 * @file Timeout sweep (runs every minute). Expires stale transactions in
 * T2/T3 timeout, recovers SUSPENDED->FAILED, expires HTLC timelocks, and
 * cleans up stalled GTID transactions.
 * @module cron/timeout_sweep
 */
// - Vault TTL切れ → 論理削除（is_evicted = 1）
// - GT_DECIDED_TO_SETTLE スタック GTID 回収
import type { Env } from '../types'
import { nowISO } from '../types'
import { suspendTx, checkAndFinalizeGtid } from '../zc/orchestrator'
import { cancelHtlc } from '../zc/lanes/htlc'
import { expireRtpRequests } from '../zc/rtp'
import { retryPendingNotifications } from '../zc/credit_notify'

// タイムアウト閾値（秒）
const T2_EXEC_TIMEOUT_SEC = 300    // 5分: DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED
const T3_PAYEE_TIMEOUT_SEC = 300   // 5分: PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED

export async function runTimeoutSweep(env: Env): Promise<{ swept: number }> {
  const db = env.DB
  const now = new Date()
  let swept = 0

  // 1. T2_exec タイムアウト: DECIDED_TO_SETTLE が 5分以上
  // BULK/DEFERRED は EOD まで DECIDED_TO_SETTLE で待機する設計のため除外
  // HTLC は timelock で独立管理されるため除外（claimHtlc は同期 debit で完結）
  const t2Deadline = new Date(now.getTime() - T2_EXEC_TIMEOUT_SEC * 1000).toISOString()
  const decidedOld = await db
    .prepare(`SELECT txid FROM Transactions WHERE state='DECIDED_TO_SETTLE' AND lane NOT IN ('BULK','DEFERRED','HTLC') AND updated_at < ?`)
    .bind(t2Deadline)
    .all<{ txid: string }>()

  for (const tx of decidedOld.results) {
    await suspendTx(tx.txid, 'SUSPEND_EXEC_TIMEOUT', db)
    swept++
  }

  // 2. T3_payee_proof タイムアウト: PAYER_EXEC_CONFIRMED が 5分以上
  const t3Deadline = new Date(now.getTime() - T3_PAYEE_TIMEOUT_SEC * 1000).toISOString()
  const payerConfOld = await db
    .prepare(`SELECT txid FROM Transactions WHERE state='PAYER_EXEC_CONFIRMED' AND updated_at < ?`)
    .bind(t3Deadline)
    .all<{ txid: string }>()

  for (const tx of payerConfOld.results) {
    await suspendTx(tx.txid, 'SUSPEND_PAYEE_PROOF_TIMEOUT', db)
    swept++
  }

  // 3. FAILED_EXECUTION 遷移: SUSPENDED が expires_at を超えた場合
  const failedOld = await db
    .prepare(`SELECT txid FROM Transactions WHERE state='SUSPENDED' AND expires_at IS NOT NULL AND expires_at < ?`)
    .bind(now.toISOString())
    .all<{ txid: string }>()

  for (const tx of failedOld.results) {
    await db.prepare(
      `UPDATE Transactions SET state='FAILED_EXECUTION', reason_code='FAILED_EXEC_TIMEOUT', updated_at=?, version=version+1 WHERE txid=? AND state='SUSPENDED'`
    ).bind(nowISO(), tx.txid).run()
    swept++
  }

  // 4. HTLC timelock 期限切れ
  const expiredHtlcs = await db
    .prepare(`SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED') AND timelock < ?`)
    .bind(now.toISOString())
    .all<{ htlc_id: string; txid: string }>()

  for (const htlc of expiredHtlcs.results) {
    // env を渡して銀行側サスペンスの解放通知も行う（HTLC_LOCKED 時は reserve-funds が実行済み）
    await cancelHtlc(htlc.htlc_id, htlc.txid, 'TIMELOCK_EXPIRED', db, env)
    swept++
  }

  // 5. Vault TTL 切れ（論理削除）
  const expiredVault = await db
    .prepare(`UPDATE Vault SET is_evicted=1 WHERE is_evicted=0 AND expires_at < ?`)
    .bind(now.toISOString())
    .run()
  swept += expiredVault.meta.changes ?? 0

  // 6. RTP 期限切れ（rtp_status・state を両方更新するモジュール関数を使用）
  try {
    swept += await expireRtpRequests(db)
  } catch (e) {
    console.error('[timeout_sweep] expireRtpRequests failed (schema mismatch?):', e)
  }

  // 7. 未配信通知リトライ
  await retryPendingNotifications(db, env)

  // 8. GT_DECIDED_TO_SETTLE スタック GTID 回収（10分以上更新なし）
  // leg 実行失敗や 0-legs で checkAndFinalizeGtid が呼ばれなかった GTID を救済
  const gtStuckDeadline = new Date(now.getTime() - 10 * 60 * 1000).toISOString()
  const stuckGtids = await db
    .prepare(`SELECT gtid FROM GtidTransactions WHERE state='GT_DECIDED_TO_SETTLE' AND updated_at < ?`)
    .bind(gtStuckDeadline)
    .all<{ gtid: string }>()

  for (const g of stuckGtids.results) {
    await checkAndFinalizeGtid(g.gtid, db)
    swept++
  }

  // 9. GT_SETTLED 済みなのに GtidLegs.state が未更新のレコードを一括修正
  const legFixResult = await db.prepare(`
    UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?
    WHERE state NOT IN ('LEG_SETTLED','LEG_FAILED','LEG_REGISTERED')
      AND gtid IN (SELECT gtid FROM GtidTransactions WHERE state='GT_SETTLED')
  `).bind(nowISO()).run()
  swept += legFixResult.meta.changes ?? 0

  return { swept }
}
