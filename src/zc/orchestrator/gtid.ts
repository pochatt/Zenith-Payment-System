/**
 * @file gtid.ts — GTID multi-leg finalization.
 *
 * Checks whether all legs of a Global Transaction have settled (or failed)
 * and drives the GT toward its terminal state.
 */
import { nowISO } from '../../types'
import { writeFinalityLog } from './finality'
import { autoResolveCaseForGtid } from '../case'

/**
 * Check whether all legs of a GTID collaborative transaction have settled.
 * Exported for use by timeout_sweep to recover stuck GTIDs.
 */
export async function checkAndFinalizeGtid(gtid: string, db: D1Database): Promise<void> {
  const now = nowISO()
  const gt = await db.prepare(
    `SELECT state, version, leg_count FROM GtidTransactions WHERE gtid = ?`
  ).bind(gtid).first<{ state: string; version: number; leg_count: number }>()
  if (!gt || gt.state !== 'GT_DECIDED_TO_SETTLE') return

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

  // null txid レグは PAYER Transaction の着金フローで実質的に完了済みとみなす
  const allSettled = legs.results.every(l => l.tx_state === 'SETTLED' || l.txid === null)
  if (!allSettled) return

  const updated = await db.prepare(
    `UPDATE GtidTransactions SET state='GT_SETTLED', legs_settled_count=?, updated_at=?, version=version+1
     WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE' AND version=?`
  ).bind(gt.leg_count, now, gtid, gt.version).run()

  if ((updated.meta.changes ?? 0) > 0) {
    await db.prepare(
      `UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?, version=version+1 WHERE gtid=?`
    ).bind(now, gtid).run()

    await writeFinalityLog(db, {
      txid: null, event_type: 'GtidSettled', state_from: 'GT_DECIDED_TO_SETTLE', state_to: 'GT_SETTLED',
      payload_json: JSON.stringify({ gtid }), txid_or_gtid: gtid,
    })

    await autoResolveCaseForGtid(db, gtid)
  }
}
