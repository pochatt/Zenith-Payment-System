/**
 * @file finality_chain.ts — Tamper-evident hash chain over FinalityLog entries.
 *
 * Each entry commits to its predecessor via SHA-256, scoped per txid (or gtid
 * when no txid is present). A silent rewrite of historical audit data therefore
 * invalidates every subsequent entry in the same chain.
 *
 * The chain identifier is `txid` if set, otherwise `gtid`. Entries with neither
 * are anchored to the sentinel 'GLOBAL' chain (system-level events).
 */
import { sha256hex } from '../shared/hmac'

export const GENESIS_PREV_HASH = 'GENESIS'
export const GLOBAL_CHAIN_ID = 'GLOBAL'
export const CHAIN_ALGORITHM = 'SHA-256 hash-chain v1'

export interface ChainableEntry {
  log_id: string
  txid: string | null
  gtid: string | null
  event_type: string
  state_from: string | null
  state_to: string
  payload_json: string
  event_seq: number
  occurred_at: string
  prev_hash?: string | null
  entry_hash?: string | null
}

export function chainIdOf(entry: Pick<ChainableEntry, 'txid' | 'gtid'>): string {
  return entry.txid ?? entry.gtid ?? GLOBAL_CHAIN_ID
}

/** Deterministic serialization for hashing. Field order is part of the protocol. */
function canonicalize(entry: ChainableEntry, prevHash: string): string {
  return [
    prevHash,
    entry.log_id,
    entry.txid ?? '',
    entry.gtid ?? '',
    entry.event_type,
    entry.state_from ?? '',
    entry.state_to,
    entry.payload_json,
    String(entry.event_seq),
    entry.occurred_at,
  ].join('|')
}

export async function computeEntryHash(entry: ChainableEntry, prevHash: string): Promise<string> {
  return sha256hex(canonicalize(entry, prevHash))
}

/** Fetch the most recent entry_hash for a chain, or GENESIS if empty. */
export async function getChainTipHash(db: D1Database, chainId: string): Promise<string> {
  if (chainId === GLOBAL_CHAIN_ID) {
    const row = await db
      .prepare(
        `SELECT entry_hash FROM FinalityLog
         WHERE txid IS NULL AND gtid IS NULL
         ORDER BY event_seq DESC LIMIT 1`,
      )
      .first<{ entry_hash: string | null }>()
    return row?.entry_hash ?? GENESIS_PREV_HASH
  }
  const row = await db
    .prepare(
      `SELECT entry_hash FROM FinalityLog
       WHERE (txid = ? OR gtid = ?)
       ORDER BY event_seq DESC LIMIT 1`,
    )
    .bind(chainId, chainId)
    .first<{ entry_hash: string | null }>()
  return row?.entry_hash ?? GENESIS_PREV_HASH
}

export interface ChainVerification {
  chain_id: string
  valid: boolean
  entries_checked: number
  break_at_seq: number | null
  break_reason: string | null
  algorithm: string
}

/**
 * Recompute hashes for every entry in a chain and detect tampering.
 *
 * Returns `valid: true` when every stored entry_hash matches its canonical
 * recomputation AND each entry's prev_hash equals the previous tip. The first
 * inconsistency is reported in `break_at_seq`.
 */
export async function verifyChain(db: D1Database, chainId: string): Promise<ChainVerification> {
  const rows = await (chainId === GLOBAL_CHAIN_ID
    ? db
        .prepare(
          `SELECT log_id, txid, gtid, event_type, state_from, state_to, payload_json,
                  event_seq, occurred_at, prev_hash, entry_hash
           FROM FinalityLog WHERE txid IS NULL AND gtid IS NULL
           ORDER BY event_seq ASC`,
        )
        .all<ChainableEntry>()
    : db
        .prepare(
          `SELECT log_id, txid, gtid, event_type, state_from, state_to, payload_json,
                  event_seq, occurred_at, prev_hash, entry_hash
           FROM FinalityLog WHERE txid = ? OR gtid = ?
           ORDER BY event_seq ASC`,
        )
        .bind(chainId, chainId)
        .all<ChainableEntry>())

  let expectedPrev = GENESIS_PREV_HASH
  let checked = 0
  for (const row of rows.results) {
    checked++
    // Legacy entries written before migration 0015 have no entry_hash — skip
    // strict verification but treat the chain as "partially verified".
    if (row.entry_hash == null) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: 'LEGACY_UNCHAINED_ENTRY',
        algorithm: CHAIN_ALGORITHM,
      }
    }
    if ((row.prev_hash ?? GENESIS_PREV_HASH) !== expectedPrev) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: 'PREV_HASH_MISMATCH',
        algorithm: CHAIN_ALGORITHM,
      }
    }
    const recomputed = await computeEntryHash(row, expectedPrev)
    if (recomputed !== row.entry_hash) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: 'ENTRY_HASH_MISMATCH',
        algorithm: CHAIN_ALGORITHM,
      }
    }
    expectedPrev = row.entry_hash
  }
  return {
    chain_id: chainId,
    valid: true,
    entries_checked: checked,
    break_at_seq: null,
    break_reason: null,
    algorithm: CHAIN_ALGORITHM,
  }
}
