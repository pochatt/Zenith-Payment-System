/**
 * @file finality.ts — FinalityLog persistence, cancellation, and suspension.
 *
 * All state-change audit trail writes and the two core terminal-state helpers
 * (finalizeCancelledTx, suspendTx) live here so they can be imported without
 * pulling in the full queue dispatcher or bank call hub.
 */
import type { TxState, FinalityEventType } from '../../types'
import { nowISO } from '../../types'
import { newUUID } from '../../shared/idempotency'
import { openCase, autoResolveCaseForTx } from '../case'
import { isValidTransition } from './state_machine'
import { chainIdOf, computeEntryHash, getChainTipHash } from '../finality_chain'

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
 *
 * Retries up to MAX_RETRIES times on UNIQUE constraint violations, which can
 * occur when two concurrent isolates write to the same chain simultaneously:
 *   - event_seq collision (B6): both computed the same monotonic seq value.
 *   - prev_hash collision (B5): both read the same chain tip and tried to link
 *     to the same predecessor, breaking the append-only invariant.
 *
 * On each retry the chain tip and seq are re-read so the new entry correctly
 * extends the chain that the earlier winner just committed.
 */
/** Prefixes recognized as non-TX chain identifiers stored in FinalityLog.gtid. */
const CHAIN_ID_PREFIXES = ['GT-', 'GTID-', 'DNS-']

export async function writeFinalityLog(db: D1Database, entry: FinalityLogEntry): Promise<void> {
  const MAX_RETRIES = 5
  const txidOrGtid = entry.txid_or_gtid
  const gtid = txidOrGtid && CHAIN_ID_PREFIXES.some(p => txidOrGtid.startsWith(p))
    ? txidOrGtid : null
  const chainId = chainIdOf({ txid: entry.txid, gtid })
  const occurredAt = nowISO()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const logId = `FL-${newUUID()}`

    const maxRow = await db
      .prepare(`SELECT MAX(event_seq) AS mx FROM FinalityLog`)
      .first<{ mx: number | null }>()
    const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000)
    const seq = Math.max(candidate, (maxRow?.mx ?? 0) + 1)

    // Re-read chain tip on every attempt to get the current predecessor hash.
    const prevHash = await getChainTipHash(db, chainId)
    const entryHash = await computeEntryHash({
      log_id: logId,
      txid: entry.txid,
      gtid,
      event_type: entry.event_type,
      state_from: entry.state_from,
      state_to: entry.state_to,
      payload_json: entry.payload_json,
      event_seq: seq,
      occurred_at: occurredAt,
    }, prevHash)

    try {
      await db.prepare(
        `INSERT INTO FinalityLog
         (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(logId, entry.txid, gtid, entry.event_type, entry.state_from,
        entry.state_to, entry.payload_json, seq, occurredAt, prevHash, entryHash).run()
      return  // success
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Retry only on UNIQUE constraint violations (event_seq or prev_hash conflict).
      if (!msg.includes('UNIQUE') && !msg.includes('unique')) throw err
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(`writeFinalityLog: failed after ${MAX_RETRIES} attempts due to concurrent writes — ${msg}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal-state helpers
// ---------------------------------------------------------------------------

/**
 * Finalize a cancelled transaction by transitioning DECIDED_CANCEL → CANCELLED.
 * DECIDED_CANCEL is a transient state that must be resolved immediately.
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
    await autoResolveCaseForTx(db, txid)
  }
}

/**
 * Suspend a transaction due to timeout, execution failure, or filter rejection.
 * Uses CAS (version guard) to prevent TOCTOU conflicts. Automatically opens
 * a Case for manual investigation and checks GTID leg status if applicable.
 */
export async function suspendTx(
  txid: string, reasonCode: string, db: D1Database,
  details?: Record<string, unknown>,
): Promise<void> {
  const now = nowISO()
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
    console.error(`[orchestrator] suspendTx CAS failed for ${txid}: state=${tx.state} may have advanced`)
    return
  }
  await writeFinalityLog(db, {
    txid, event_type: 'Suspended', state_from: tx.state, state_to: 'SUSPENDED',
    payload_json: JSON.stringify({ reason_code: reasonCode, ...details }), txid_or_gtid: txid,
  })

  await openCase(db, { related_txid: txid, reason_code: reasonCode, opened_by: 'ZC', description: `Auto-suspended: ${reasonCode}` })

  // TX-GT-* leg が SUSPENDED → GT_SUSPENDED へ遷移させる（循環 import 回避で動的 import）
  if (txid.startsWith('TX-GT-')) {
    const { checkAndFinalizeGtid } = await import('./gtid')
    const leg = await db.prepare(
      `SELECT gtid FROM GtidLegs WHERE txid = ?`
    ).bind(txid).first<{ gtid: string }>()
    if (leg) {
      await checkAndFinalizeGtid(leg.gtid, db)
    }
  }
}
