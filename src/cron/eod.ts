/**
 * @file End-of-day (EOD) batch settlement. Executes 8 steps: DNS kick, DNS
 * settle, interest accrual, daily balance snapshots, suspense cleanup, daily
 * limit reset, and audit logging.
 * @module cron/eod
 */
// 3. Bank側: 利息計算・日次スナップショット
// 4. ゼロサム検証
import type { Env } from '../types'
import { todayJST } from '../types'
import { kickDns, settleDns } from '../zc/dns'
import { cancelHtlc } from '../zc/lanes/htlc'
import { advanceBulk } from '../zc/lanes/bulk'
import { snapshotDailyBalance, applyDailyInterest, verifyZeroSum } from '../bank/ledger'
import { retryPendingNotifications } from '../zc/credit_notify'
import { retryFailedIgs } from '../zc/igs'
import { pruneDeliveredEvents } from '../zc/stream'

export async function runEod(env: Env): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = []
  const db = env.DB
  const today = todayJST()

  try {
    // 1. BULK 事前処理: RECEIVED → DECIDED_TO_SETTLE
    // kickDns より先に実行することで、当日 OPEN サイクルの dns_cycle_id が正しく付与される
    const bulkReceived = await db
      .prepare(`SELECT txid FROM Transactions WHERE lane='BULK' AND state='RECEIVED'`)
      .all<{ txid: string }>()
    for (const tx of bulkReceived.results) {
      await advanceBulk(tx.txid, env)
      log.push(`BULK advanced: ${tx.txid}`)
    }
    log.push(`BULK: ${bulkReceived.results.length} advanced`)

    // 2. DNS Kick
    const kickResult = await kickDns(today, env)
    log.push(`DNS Kick: cycle=${kickResult.cycle_id} state=${kickResult.state}`)

    // 3. DNS 清算（モック: 即時 SETTLED）
    // settleDns 内部で BULK DECIDED_TO_SETTLE TX の ZC_BANK_DEBIT キュー投入まで行う
    if (kickResult.state === 'KICKED') {
      await settleDns(kickResult.cycle_id, env)
      log.push(`DNS Settled: ${kickResult.cycle_id}`)
    }

    // 4. HTLC 期限切れチェック
    const expiredHtlcs = await db
      .prepare(`SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED') AND timelock < ?`)
      .bind(new Date().toISOString())
      .all<{ htlc_id: string; txid: string }>()

    for (const htlc of expiredHtlcs.results) {
      // env を渡して銀行側サスペンスの解放通知も行う（HTLC_LOCKED 時は reserve-funds が実行済み）
      await cancelHtlc(htlc.htlc_id, htlc.txid, 'TIMELOCK_EXPIRED', db, env)
      log.push(`HTLC expired: ${htlc.htlc_id}`)
    }

    // 5. 利息計算 + 残高スナップショット
    const accounts = await db
      .prepare(`SELECT DISTINCT bank_id, account_id FROM BankAccounts WHERE status='NORMAL'`)
      .all<{ bank_id: string; account_id: string }>()

    const bankIds = [...new Set(accounts.results.map(a => a.bank_id))]
    for (const bankId of bankIds) {
      await applyDailyInterest(bankId, today, db)
    }

    for (const acc of accounts.results) {
      await snapshotDailyBalance(acc.account_id, today, db)
    }
    log.push(`Snapshots saved for ${accounts.results.length} accounts`)

    // 6. ゼロサム検証
    for (const bankId of bankIds) {
      const ok = await verifyZeroSum(bankId, db)
      log.push(`ZeroSum ${bankId}: ${ok ? 'OK' : 'VIOLATED!'}`)
      if (!ok) {
        console.error(`[EOD] Zero-sum violation for ${bankId}`)
      }
    }

    // 7. 参加行の日次送金累計リセット（tx_amount_limit/daily_amount_limit 用）
    // migration 0015 で daily_amount_used カラムが追加済み
    await db.prepare(`UPDATE Participants SET daily_amount_used = 0`).run()
    log.push('daily_amount_used reset for all participants')

    // 8. 通知リトライ・IGSリトライ・SSEイベントプルーニング
    await retryPendingNotifications(db, env)
    await retryFailedIgs(db, env)
    await pruneDeliveredEvents(db)
    log.push('Notification retry, IGS retry, event prune: done')

    return { ok: true, log }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`ERROR: ${msg}`)
    console.error('[EOD] Error:', err)
    return { ok: false, log }
  }
}
