/**
 * @file dns.ts - Deferred Net Settlement (DNS) Cycle Management
 *
 * Manages the end-of-day DNS clearing cycle for non-HIGH_VALUE transactions.
 * The DNS cycle progresses through three states: OPEN -> KICKED -> SETTLED.
 *
 * Key operations:
 * - kickDns:    Assigns pending transactions to the cycle, computes net positions
 *               per participant, and transitions OPEN -> KICKED
 * - settleDns:  Settles suspense accounts, generates BOJ settlement journals,
 *               creates a settlement GTID, releases all H-reservations, and
 *               triggers BULK lane execution for deferred transactions
 * - holdDns:    Emergency hold (OPEN -> HOLD_ACTIVE) to pause clearing
 * - getOrCreateDnsCycle: Ensures a valid OPEN cycle exists for late-arriving TXs
 *
 * Settlement produces zero-sum double-entry journals:
 *   Phase 1: Suspense(-) / ZCS(+) per payer bank
 *   Phase 2: ZCS(+/-) / BOJ(-/+) per bank (RTGS-equivalent final settlement)
 */
import type { Env, DnsCycleRow } from '../types'
import { nowISO, suspenseAccountId, nostroAccountId } from '../types'
import { writeFinalityLog } from './orchestrator'
import { newUUID } from '../shared/idempotency'
import { settleSuspenseForDns } from '../bank/suspense'
import { insertJournalGroup, calcBalance } from '../bank/ledger'
import { releaseH } from './h_model'

// ---------------------------------------------------------------------------
// DNS Kick: 当日サイクルを OPEN → KICKED
// ---------------------------------------------------------------------------
export async function kickDns(businessDate: string, env: Env): Promise<{
  cycle_id: string; state: string; net_positions: Record<string, number>
}> {
  const db = env.DB
  const now = nowISO()

  // 当日 OPEN サイクルを取得（後着サイクル含む）。なければ新規作成
  let cycle = await db
    .prepare(`SELECT * FROM DnsCycles WHERE business_date = ? AND state = 'OPEN' ORDER BY created_at ASC LIMIT 1`)
    .bind(businessDate)
    .first<DnsCycleRow>()

  if (!cycle) {
    const cycleId = `DNS-${businessDate}`
    await db.prepare(
      `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', ?)`
    ).bind(cycleId, businessDate, now).run()
    cycle = await db
      .prepare(`SELECT * FROM DnsCycles WHERE business_date = ? AND state = 'OPEN' ORDER BY created_at ASC LIMIT 1`)
      .bind(businessDate)
      .first<DnsCycleRow>()
    if (!cycle) {
      // 当日サイクルは既に KICKED か SETTLED → early return
      const existing = await db.prepare(`SELECT * FROM DnsCycles WHERE business_date = ? ORDER BY created_at DESC LIMIT 1`).bind(businessDate).first<DnsCycleRow>()
      if (existing) return { cycle_id: existing.cycle_id, state: existing.state, net_positions: {} }
      throw new Error(`Failed to create DNS cycle for ${businessDate}`)
    }
  }

  // 未割当TX を先にサイクルに紐付け → その後ネットポジション計算
  // HIGH_VALUE は即時 RTGS 清算のため DNS Kick の対象外とする
  // DATE フィルタ廃止: dns_cycle_id=NULL の全未決TX（前日繰越分を含む）を収容する
  //   advanceBulk は dns_cycle_id を設定しないため、kickDns が唯一の割当機関
  await db.prepare(
    `UPDATE Transactions SET dns_cycle_id = ?
     WHERE dns_cycle_id IS NULL
       AND lane != 'HIGH_VALUE'
       AND state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED')`
  ).bind(cycle.cycle_id).run()

  // ネットポジション計算（割当後の全TX対象）
  const txRows = await db.prepare(
    `SELECT payer_bank_id, payee_bank_id, amount_value
     FROM Transactions
     WHERE dns_cycle_id = ? AND state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED','SETTLED')`
  ).bind(cycle.cycle_id).all<{ payer_bank_id: string; payee_bank_id: string; amount_value: number }>()

  // 単一パスで net / grossSend / grossReceive を同時集計（O(n) / O(participants)）。
  // 以前は filter+reduce で O(n*participants) かつ中間配列を毎回確保していた。
  const netPositions: Record<string, number> = {}
  const grossSendByBank: Record<string, number> = {}
  const grossReceiveByBank: Record<string, number> = {}
  for (const tx of txRows.results) {
    const payer = tx.payer_bank_id
    const payee = tx.payee_bank_id
    const amt = tx.amount_value
    netPositions[payer] = (netPositions[payer] ?? 0) - amt
    netPositions[payee] = (netPositions[payee] ?? 0) + amt
    grossSendByBank[payer] = (grossSendByBank[payer] ?? 0) + amt
    grossReceiveByBank[payee] = (grossReceiveByBank[payee] ?? 0) + amt
  }

  // DnsNetPositions に保存
  const netStmts: ReturnType<typeof db.prepare>[] = []
  for (const bankId in netPositions) {
    netStmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).bind(
        `DNSNET-${cycle.cycle_id}-${bankId}`, cycle.cycle_id, bankId,
        grossSendByBank[bankId] ?? 0, grossReceiveByBank[bankId] ?? 0, netPositions[bankId] ?? 0,
      )
    )
  }

  // サイクルを KICKED に更新
  await db.batch([...netStmts,
    db.prepare(`UPDATE DnsCycles SET state='KICKED', kicked_at=?, net_positions=? WHERE cycle_id=?`)
      .bind(now, JSON.stringify(netPositions), cycle.cycle_id)])

  await writeFinalityLog(db, {
    txid: null, event_type: 'DnsKicked', state_from: 'OPEN', state_to: 'KICKED',
    payload_json: JSON.stringify({ cycle_id: cycle.cycle_id, business_date: businessDate, net_positions: netPositions }),
    txid_or_gtid: cycle.cycle_id,
  })

  return { cycle_id: cycle.cycle_id, state: 'KICKED', net_positions: netPositions }
}

// ---------------------------------------------------------------------------
// DNS 清算完了: KICKED → SETTLED
// ---------------------------------------------------------------------------
export async function settleDns(cycleId: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const cycle = await db
    .prepare(`SELECT * FROM DnsCycles WHERE cycle_id = ?`)
    .bind(cycleId).first<DnsCycleRow>()
  if (!cycle || cycle.state !== 'KICKED') return

  // ---------------------------------------------------------------------------
  // 事前BOJ残高充足確認: ネット支払超行の BOJ 残高を検証（プレファンドRTGS要件）
  // 報告書「論点7: 資金清算・決済のあり方」—プレファンドRTGS方式では
  // 清算前に各参加行の事前拠出残高が支払超額をカバーできるか確認する
  // ---------------------------------------------------------------------------
  const debitPositions = await db
    .prepare(`SELECT bank_id, net_position FROM DnsNetPositions WHERE cycle_id = ? AND net_position < 0`)
    .bind(cycleId).all<{ bank_id: string; net_position: number }>()

  const bojShortfalls: Array<{ bank_id: string; shortfall: number }> = []
  for (const row of debitPositions.results) {
    const bojBalance = await calcBalance(`${row.bank_id}-BOJ`, db)
    const requiredDebit = -row.net_position  // net_position < 0 なので正の値

    // NOTE: BOJ残高チェックロジック（偽陽性検査済み）
    // 符号規則: bojBalance は負値で表現される（負債会計: 日銀当座預金は負資産）
    //   例: 預金残高 100万円 → bojBalance = -1,000,000
    // 不足判定: bojBalance + requiredDebit > 0
    //   例1: bojBalance=-1,000,000, requiredDebit=900,000 → -100,000 ≤ 0 → OK
    //   例2: bojBalance=-100,000, requiredDebit=900,000 → 800,000 > 0 → 不足 ✓
    // このロジックは正しい。算出結果が直感的でないため、明示的に記述。
    if (bojBalance + requiredDebit > 0) {
      bojShortfalls.push({ bank_id: row.bank_id, shortfall: bojBalance + requiredDebit })
    }
  }

  if (bojShortfalls.length > 0) {
    // BOJ残高不足: サイクルを HOLD_ACTIVE に遷移して手動対処を待つ
    await db.prepare(
      `UPDATE DnsCycles SET state='HOLD_ACTIVE', hold_reason=?, updated_at=? WHERE cycle_id=?`
    ).bind(
      JSON.stringify({ reason: 'BOJ_INSUFFICIENT_FUNDS', shortfalls: bojShortfalls }),
      now, cycleId
    ).run()
    await writeFinalityLog(db, {
      txid: null, event_type: 'DnsHeld', state_from: 'KICKED', state_to: 'HOLD_ACTIVE',
      payload_json: JSON.stringify({ cycle_id: cycleId, reason: 'BOJ_INSUFFICIENT_FUNDS', shortfalls: bojShortfalls }),
      txid_or_gtid: cycleId,
    })
    console.error(`[dns] settleDns aborted: BOJ shortfall detected`, bojShortfalls)
    return
  }

  // 各銀行の別段預金を清算
  const participants = await db
    .prepare(`SELECT DISTINCT bank_id FROM DnsNetPositions WHERE cycle_id = ?`)
    .bind(cycleId).all<{ bank_id: string }>()

  for (const { bank_id } of participants.results) {
    await settleSuspenseForDns(bank_id, cycleId, db)
  }

  // DNS清算仕訳: 支払側の別段(PAY)を gross_send 分だけ ZC清算勘定へ振替
  //
  //   支払行 (gross_send > 0):
  //     Suspense(−gross_send) / ZCS(+gross_send) = 0 ✓
  //     → 別段が解消され、ZCへの支払義務が計上される
  //
  //   受取行 (gross_send = 0):
  //     仕訳不要 — Hard Landing + execute-credit 時点で
  //     ZCS(−) / Suspense(+) → Suspense(−) / Customer(+) が完結済み
  //
  //   両建て行 (gross_send > 0 かつ gross_receive > 0):
  //     送金分だけ Suspense(−gross_send) / ZCS(+gross_send)
  //     受取分は Hard Landing 済みのため ZCS残高は net に収束する
  const netPositions = await db
    .prepare(`SELECT bank_id, net_position, gross_send FROM DnsNetPositions WHERE cycle_id = ? AND is_settled = 0`)
    .bind(cycleId).all<{ bank_id: string; net_position: number; gross_send: number }>()

  for (const row of netPositions.results) {
    const suspAcctId = suspenseAccountId(row.bank_id)
    const zcsAcctId  = nostroAccountId(row.bank_id)   // {bankId}-ZCS

    if (row.gross_send > 0) {
      await insertJournalGroup(db, {
        bankId: row.bank_id,
        txGroupId: `DNS-SETTLE-${cycleId}-${row.bank_id}`,
        entries: [
          { accountId: suspAcctId, amount: -row.gross_send, txType: 'TRANSFER', description: `DNS settle ${cycleId} 別段(PAY)解消` },
          { accountId: zcsAcctId,  amount:  row.gross_send, txType: 'TRANSFER', description: `DNS settle ${cycleId} ZCS支払義務計上` },
        ],
        valueDate: cycle.business_date,
      })
    }
    await db.prepare(`UPDATE DnsNetPositions SET is_settled=1 WHERE cycle_id=? AND bank_id=?`).bind(cycleId, row.bank_id).run()
  }

  // ---------------------------------------------------------------------------
  // Phase 2: BOJ Settlement
  //   ZCS残高 = gross_send − gross_receive = −net_position
  //   仕訳: ZCS(−zcsBalance) / BOJ_CURRENT(+zcsBalance) ← ゼロサム ✓
  //   ・支払超行 (zcsBalance>0): ZCS(−X) / BOJ(+X) [ZCS義務解消、BOJ当座減]
  //   ・受取超行 (zcsBalance<0): ZCS(+Y) / BOJ(−Y) [ZCS権利解消、BOJ当座増]
  //   全銀行の BOJ 合計 = Σ(gross_send − gross_receive) = 0 ✓
  // ---------------------------------------------------------------------------
  const allPositions = await db
    .prepare(`SELECT bank_id, net_position, gross_send, gross_receive FROM DnsNetPositions WHERE cycle_id = ?`)
    .bind(cycleId)
    .all<{ bank_id: string; net_position: number; gross_send: number; gross_receive: number }>()

  // A. ZCSゼロクリア仕訳（各銀行）
  for (const row of allPositions.results) {
    const zcsBalance = row.gross_send - row.gross_receive  // = −net_position
    if (zcsBalance === 0) continue
    await insertJournalGroup(db, {
      bankId: row.bank_id,
      txGroupId: `DNS-BOJ-${cycleId}-${row.bank_id}`,
      entries: [
        { accountId: nostroAccountId(row.bank_id), amount: -zcsBalance, txType: 'TRANSFER', description: `DNS BOJ清算 ZCS解消 ${cycleId}` },
        { accountId: `${row.bank_id}-BOJ`,          amount:  zcsBalance, txType: 'TRANSFER', description: `DNS BOJ清算 日銀当座預金 ${cycleId}` },
      ],
      valueDate: cycle.business_date,
    })
  }

  // B. BOJ Settlement GTID（状態機械を経由せず GT_SETTLED で直接生成）
  //    net payer行 → PAYER leg、net receiver行 → PAYEE leg
  const payerBanks    = allPositions.results.filter(r => r.net_position < 0)
  const payeeBanks    = allPositions.results.filter(r => r.net_position > 0)
  const totalPayerAmt = payerBanks.reduce((s, r) => s + (-r.net_position), 0)
  const legCount      = payerBanks.length + payeeBanks.length

  if (legCount > 0 && totalPayerAmt > 0) {
    const gtidId = `GTID-DNS-${cycleId}`
    await db.prepare(
      `INSERT OR IGNORE INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count,
        legs_ready_count, legs_settled_count, version, created_at, updated_at)
       VALUES (?, 'GT_SETTLED', 'ZC', ?, ?, ?, ?, 0, ?, ?)`
    ).bind(gtidId, totalPayerAmt, legCount, legCount, legCount, now, now).run()

    for (const row of payerBanks) {
      await db.prepare(
        `INSERT OR IGNORE INTO GtidLegs
         (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
         VALUES (?, ?, 'PAYER', ?, ?, ?, 'LEG_SETTLED', 0, ?, ?)`
      ).bind(`LEG-DNS-${cycleId}-${row.bank_id}-PAY`, gtidId, row.bank_id,
             `${row.bank_id}-BOJ`, -row.net_position, now, now).run()
    }
    for (const row of payeeBanks) {
      await db.prepare(
        `INSERT OR IGNORE INTO GtidLegs
         (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
         VALUES (?, ?, 'PAYEE', ?, ?, ?, 'LEG_SETTLED', 0, ?, ?)`
      ).bind(`LEG-DNS-${cycleId}-${row.bank_id}-RCV`, gtidId, row.bank_id,
             `${row.bank_id}-BOJ`, row.net_position, now, now).run()
    }

    await writeFinalityLog(db, {
      txid: null, event_type: 'DnsGtidSettled',
      state_from: 'GT_DECIDED_TO_SETTLE', state_to: 'GT_SETTLED',
      payload_json: JSON.stringify({
        gtid: gtidId, cycle_id: cycleId,
        payer_count: payerBanks.length, payee_count: payeeBanks.length,
        total_amount: totalPayerAmt,
      }),
      txid_or_gtid: gtidId,
    })
  }
  // ---------------------------------------------------------------------------

  // サイクルを SETTLED に
  await db.prepare(`UPDATE DnsCycles SET state='SETTLED', settled_at=? WHERE cycle_id=?`).bind(now, cycleId).run()

  // DNS_CYCLE_SETTLED でH予約を解放（仕様: DNS決済完了後に解放）
  const hReservations = await db
    .prepare(
      `SELECT h.reservation_id FROM HReservations h
       JOIN Transactions t ON t.txid = h.txid
       WHERE t.dns_cycle_id = ? AND h.is_released = 0`
    )
    .bind(cycleId).all<{ reservation_id: string }>()
  for (const { reservation_id } of hReservations.results) {
    await releaseH(reservation_id, db)
  }

  await writeFinalityLog(db, {
    txid: null, event_type: 'DnsSettled', state_from: 'KICKED', state_to: 'SETTLED',
    payload_json: JSON.stringify({ cycle_id: cycleId }), txid_or_gtid: cycleId,
  })

  // BULK Execution: DNS清算完了を契機に DECIDED_TO_SETTLE な BULK TX をキューへ投入
  // （EOD経由・直接呼び出しのどちらでも確実に実行されるようここに配置）
  const bulkSettleReady = await db
    .prepare(
      `SELECT txid, payer_bank_id, payee_bank_id, amount_value, decision_proof_ref
       FROM Transactions
       WHERE dns_cycle_id = ? AND lane = 'BULK' AND state = 'DECIDED_TO_SETTLE'`
    )
    .bind(cycleId)
    .all<{ txid: string; payer_bank_id: string; payee_bank_id: string; amount_value: number; decision_proof_ref: string | null }>()

  for (const tx of bulkSettleReady.results) {
    await env.QUEUE.send({
      type: 'ZC_BANK_DEBIT',
      payload: {
        txid: tx.txid,
        payer_bank_id: tx.payer_bank_id,
        payee_bank_id: tx.payee_bank_id,
        amount: { value: tx.amount_value, currency: 'JPY' },
        decision_proof_ref: tx.decision_proof_ref ?? '',
        lane: 'BULK',
      },
      txid: tx.txid, attempt: 0, enqueued_at: now,
    })
  }
}

// ---------------------------------------------------------------------------
// 当日 DNS サイクルを取得または作成（共有ヘルパー: 各レーンが dns_cycle_id を設定するために使用）
// ---------------------------------------------------------------------------
export async function getOrCreateDnsCycle(db: D1Database, now: string): Promise<string> {
  const today = now.slice(0, 10)
  // OPEN サイクルのみ返す（KICKED は既にネッティング計算済みのため新規TX割当不可）
  const existing = await db
    .prepare(`SELECT cycle_id FROM DnsCycles WHERE business_date = ? AND state = 'OPEN'`)
    .bind(today)
    .first<{ cycle_id: string }>()
  if (existing) return existing.cycle_id

  // 標準サイクル ID で INSERT を試みる
  const cycleId = `DNS-${today}`
  const result = await db.prepare(
    `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
     VALUES (?, ?, 'OPEN', 'NORMAL', ?)`
  ).bind(cycleId, today, now).run()

  if ((result.meta.changes ?? 0) > 0) return cycleId

  // INSERT IGNORE 失敗 = 当日サイクルが既に SETTLED
  // → 後着 TX 用に新規 OPEN サイクルを suffix 付きで作成
  const lateId = `DNS-${today}-${now.slice(11, 19).replace(/:/g, '')}`
  await db.prepare(
    `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
     VALUES (?, ?, 'OPEN', 'NORMAL', ?)`
  ).bind(lateId, today, now).run()
  return lateId
}

// ---------------------------------------------------------------------------
// DNS HOLD: OPEN → HOLD_ACTIVE
// ---------------------------------------------------------------------------
export async function holdDns(businessDate: string, reason: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  await db.prepare(
    `UPDATE DnsCycles SET state='HOLD_ACTIVE', igs_mode='STOP', hold_reason=? WHERE business_date=? AND state='OPEN'`
  ).bind(reason, businessDate).run()

  // 後着サイクル（suffix付き cycle_id）に対応するため DB から実際の cycle_id を取得
  const updated = await db.prepare(
    `SELECT cycle_id FROM DnsCycles WHERE business_date=? AND state='HOLD_ACTIVE' ORDER BY created_at DESC LIMIT 1`
  ).bind(businessDate).first<{ cycle_id: string }>()
  const cycleId = updated?.cycle_id ?? `DNS-${businessDate}`

  await writeFinalityLog(db, {
    txid: null, event_type: 'DnsHoldActivated', state_from: 'OPEN', state_to: 'HOLD_ACTIVE',
    payload_json: JSON.stringify({ cycle_id: cycleId, reason }), txid_or_gtid: cycleId,
  })
}

// ---------------------------------------------------------------------------
// DNS ステータス照会
// ---------------------------------------------------------------------------
export async function getDnsStatus(businessDate: string, db: D1Database): Promise<DnsCycleRow | null> {
  return db.prepare(`SELECT * FROM DnsCycles WHERE business_date = ? ORDER BY created_at DESC LIMIT 1`).bind(businessDate).first<DnsCycleRow>()
}

export async function getDnsNetPositions(
  businessDate: string, db: D1Database,
): Promise<Array<{ bank_id: string; net_position: number; gross_send: number; gross_receive: number; is_settled: number }>> {
  const prefix = `DNS-${businessDate}%`
  const rows = await db
    .prepare(
      `SELECT bank_id, SUM(net_position) AS net_position, SUM(gross_send) AS gross_send, SUM(gross_receive) AS gross_receive, MIN(is_settled) AS is_settled
       FROM DnsNetPositions
       WHERE cycle_id LIKE ?
       GROUP BY bank_id`
    )
    .bind(prefix)
    .all<{ bank_id: string; net_position: number; gross_send: number; gross_receive: number; is_settled: number }>()
  return rows.results
}

// ---------------------------------------------------------------------------
// 各銀行の日銀預け金勘定（BOJ）残高照会
// account_type='BOJ' の口座に積み上がった仕訳を集計する
// ---------------------------------------------------------------------------
export async function getBojPositions(
  db: D1Database,
): Promise<Array<{ bank_id: string; boj_balance: number }>> {
  const rows = await db
    .prepare(
      `SELECT ba.bank_id, COALESCE(SUM(j.amount), 0) AS boj_balance
       FROM BankAccounts ba
       LEFT JOIN BankJournals j ON j.account_id = ba.account_id
       WHERE ba.account_type = 'BOJ'
       GROUP BY ba.bank_id
       ORDER BY ba.bank_id`
    )
    .all<{ bank_id: string; boj_balance: number }>()
  return rows.results
}
