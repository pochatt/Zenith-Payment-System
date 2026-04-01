/**
 * @file IGS (Interbank Gross Settlement) / BOJ-Net integration for HIGH_VALUE
 *       lane. Manages RTGS-like settlement requests and callbacks.
 * @module zc/igs
 */
import type { Env, IgsRequestRow, IgsCallbackInput } from '../types'
import { nowISO, nostroAccountId } from '../types'
import { newUUID } from '../shared/idempotency'
import { writeFinalityLog } from './orchestrator'
import { insertJournalGroup } from '../bank/ledger'

// ---------------------------------------------------------------------------
// initiateIgsSettlement
// ---------------------------------------------------------------------------
/**
 * IgsRequests レコードを作成し、BOJ（モック）への決済依頼を送信する。
 * モックでは Queue に ZC_IGS_CALLBACK メッセージを 2 秒後相当で送信して自動確認させる。
 * Queue が利用不可の場合はフォールバックとして Promise ベースで非同期確認を試みる。
 *
 * @returns ext_instruction_id
 */
export async function initiateIgsSettlement(
  db: D1Database,
  txid: string,
  amount: { value: number; currency: string },
  payerBankId: string,
  payeeBankId: string,
  env: Env,
): Promise<string> {
  const extId = `IGS-${newUUID()}`
  const now = nowISO()

  await db.prepare(
    `INSERT OR IGNORE INTO IgsRequests
     (ext_instruction_id, txid, payer_bank_id, payee_bank_id,
      amount_value, amount_currency, status, retry_count, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', 0, ?)`,
  ).bind(extId, txid, payerBankId, payeeBankId, amount.value, amount.currency, now).run()

  // モック: BOJ確認をQueueで2秒後に自動発火
  const callbackMsg = {
    type: 'ZC_IGS_CALLBACK' as const,
    payload: {
      ext_instruction_id: extId,
      result: 'SETTLED',
      boj_settle_ref: `BOJ-${newUUID()}`,
    } satisfies IgsCallbackInput,
    txid,
    attempt: 0,
    enqueued_at: now,
  }

  try {
    // Cloudflare Queues: delaySeconds は将来対応のため直接送信
    await env.QUEUE.send(callbackMsg)
  } catch (err) {
    // Queue 未設定環境では Promise 経由で非同期処理（テスト用フォールバック）
    console.error('[IGS] Queue send failed, running inline fallback:', err)
    // Worker の実行コンテキストが続く限りコールバックを試みる
    Promise.resolve().then(async () => {
      try {
        await handleIgsCallback(db, callbackMsg.payload, env)
      } catch (e) {
        console.error('[IGS] inline fallback callback failed:', e)
      }
    })
  }

  return extId
}

// ---------------------------------------------------------------------------
// handleIgsCallback
// ---------------------------------------------------------------------------
/**
 * BOJ からのコールバックを処理し、取引状態を前進させる。
 * SETTLED → payee execute-credit → Transactions.state = SETTLED
 * FAILED / HOLD → Transactions.state = SUSPENDED
 */
export async function handleIgsCallback(
  db: D1Database,
  input: IgsCallbackInput,
  env: Env,
): Promise<void> {
  const { ext_instruction_id, result, boj_settle_ref, reason } = input
  const now = nowISO()

  // IgsRequests 取得
  const igsRow = await db
    .prepare(`SELECT * FROM IgsRequests WHERE ext_instruction_id = ?`)
    .bind(ext_instruction_id)
    .first<IgsRequestRow>()

  if (!igsRow) {
    console.error('[IGS] callback: IgsRequests row not found:', ext_instruction_id)
    return
  }
  if (igsRow.status !== 'REQUESTED') {
    // 冪等: すでに処理済みなら無視
    return
  }

  if (result === 'SETTLED') {
    // IgsRequests を SETTLED に更新
    await db.prepare(
      `UPDATE IgsRequests
       SET status = 'SETTLED', boj_settle_ref = ?, settled_at = ?
       WHERE ext_instruction_id = ? AND status = 'REQUESTED'`,
    ).bind(boj_settle_ref ?? null, now, ext_instruction_id).run()

    // Transactions 取得
    const tx = await db
      .prepare(
        `SELECT state, payee_bank_id, amount_value, decision_proof_ref,
                payee_account_hash, version
         FROM Transactions WHERE txid = ?`,
      )
      .bind(igsRow.txid)
      .first<{
        state: string
        payee_bank_id: string
        amount_value: number
        decision_proof_ref: string | null
        payee_account_hash: string | null
        version: number
      }>()

    if (!tx) {
      console.error('[IGS] callback: Transactions row not found:', igsRow.txid)
      return
    }

    // 楽観的ロックで状態確認（PAYER_EXEC_CONFIRMED または A_EXEC_OK 相当の状態）
    // HIGH_VALUE レーンでは ZC_BANK_DEBIT 完了後に PAYER_EXEC_CONFIRMED になる
    if (tx.state !== 'PAYER_EXEC_CONFIRMED') {
      console.error('[IGS] callback: unexpected state:', tx.state, 'for txid:', igsRow.txid)
      return
    }

    // ---------------------------------------------------------------------------
    // BOJ決済仕訳（プレファンドRTGS: 即時グロス清算）
    // DNS清算を経由せず、IGS確定時点でBOJ当座を直接振替
    //
    // 支払行: ZCS(-amount) / BOJ(+amount)  [ZCS積立義務解消、BOJ当座減]
    // 受取行: ZCS(+amount) / BOJ(-amount)  [ZCS受取権計上、BOJ当座増]
    //
    // 各グループはゼロサム ✓ かつ bank_id が各行に対応
    // ---------------------------------------------------------------------------
    const valueDate = now.slice(0, 10)
    const amount = igsRow.amount_value

    // 支払行（payer）BOJ決済仕訳
    await insertJournalGroup(db, {
      bankId: igsRow.payer_bank_id,
      txGroupId: `IGS-BOJ-PAY-${igsRow.txid}`,
      entries: [
        {
          accountId: nostroAccountId(igsRow.payer_bank_id),
          amount: -amount,
          txType: 'TRANSFER',
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 支払行ZCS解消`,
        },
        {
          accountId: `${igsRow.payer_bank_id}-BOJ`,
          amount: amount,
          txType: 'TRANSFER',
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 支払行BOJ当座減`,
        },
      ],
      valueDate,
    })

    // 受取行（payee）BOJ決済仕訳
    await insertJournalGroup(db, {
      bankId: igsRow.payee_bank_id,
      txGroupId: `IGS-BOJ-RCV-${igsRow.txid}`,
      entries: [
        {
          accountId: nostroAccountId(igsRow.payee_bank_id),
          amount: amount,
          txType: 'TRANSFER',
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 受取行ZCS計上`,
        },
        {
          accountId: `${igsRow.payee_bank_id}-BOJ`,
          amount: -amount,
          txType: 'TRANSFER',
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 受取行BOJ当座増`,
        },
      ],
      valueDate,
    })

    await writeFinalityLog(db, {
      txid: igsRow.txid,
      event_type: 'IgsConfirmed',
      state_from: 'PAYER_EXEC_CONFIRMED',
      state_to: 'PAYER_EXEC_CONFIRMED',
      payload_json: JSON.stringify({ ext_instruction_id, boj_settle_ref: boj_settle_ref ?? null }),
      txid_or_gtid: igsRow.txid,
    })

    // payee execute-credit をキューに送信
    await env.QUEUE.send({
      type: 'ZC_BANK_CREDIT',
      payload: {
        txid: igsRow.txid,
        payee_bank_id: tx.payee_bank_id,
        amount: { value: tx.amount_value, currency: 'JPY' },
        decision_proof_ref: tx.decision_proof_ref ?? '',
        payee_account_hash: tx.payee_account_hash ?? undefined,
      },
      txid: igsRow.txid,
      attempt: 0,
      enqueued_at: now,
    })
  } else {
    // FAILED / HOLD
    // HOLD と FAILED を区別（両方 'FAILED' になるデッドコードを修正）
    // HOLD: 一時保留（日銀ネット流動性不足等）→ retryFailedIgs が再試行
    // FAILED: 恒久失敗 → retryFailedIgs が再試行（retry_count 上限まで）
    const newStatus = result === 'HOLD' ? 'HOLD' : 'FAILED'
    await db.prepare(
      `UPDATE IgsRequests
       SET status = ?, failed_reason = ?
       WHERE ext_instruction_id = ? AND status = 'REQUESTED'`,
    ).bind(newStatus, reason ?? result, ext_instruction_id).run()

    // 取引を SUSPENDED に遷移
    const upd = await db.prepare(
      `UPDATE Transactions
       SET state = 'SUSPENDED', reason_code = 'IGS_FAILED', updated_at = ?, version = version + 1
       WHERE txid = ? AND state = 'PAYER_EXEC_CONFIRMED'`,
    ).bind(now, igsRow.txid).run()

    if ((upd.meta.changes ?? 0) > 0) {
      await writeFinalityLog(db, {
        txid: igsRow.txid,
        event_type: 'Suspended',
        state_from: 'PAYER_EXEC_CONFIRMED',
        state_to: 'SUSPENDED',
        payload_json: JSON.stringify({ reason: 'IGS_FAILED', ext_instruction_id, boj_reason: reason }),
        txid_or_gtid: igsRow.txid,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// retryFailedIgs
// ---------------------------------------------------------------------------
/**
 * cron から呼ばれる。FAILED または REQUESTED（タイムアウト相当）で retry_count < 3 の
 * IgsRequests を再試行する。
 */
export async function retryFailedIgs(db: D1Database, env: Env): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT * FROM IgsRequests
       WHERE status IN ('FAILED', 'HOLD') AND retry_count < 3`,
    )
    .all<IgsRequestRow>()

  for (const row of rows.results ?? []) {
    const now = nowISO()
    // retry_count をインクリメント、status を REQUESTED に戻す
    const upd = await db.prepare(
      `UPDATE IgsRequests
       SET status = 'REQUESTED', retry_count = retry_count + 1,
           failed_reason = NULL, requested_at = ?
       WHERE ext_instruction_id = ? AND retry_count < 3`,
    ).bind(now, row.ext_instruction_id).run()

    if ((upd.meta.changes ?? 0) === 0) continue

    console.log('[IGS] retrying:', row.ext_instruction_id, 'attempt:', row.retry_count + 1)

    const callbackPayload: IgsCallbackInput = {
      ext_instruction_id: row.ext_instruction_id,
      result: 'SETTLED',
      boj_settle_ref: `BOJ-RETRY-${newUUID()}`,
    }

    try {
      await env.QUEUE.send({
        type: 'ZC_IGS_CALLBACK',
        payload: callbackPayload,
        txid: row.txid,
        attempt: row.retry_count + 1,
        enqueued_at: now,
      })
    } catch (err) {
      console.error('[IGS] retry queue send failed:', err)
      // フォールバック: インラインで再処理
      try {
        await handleIgsCallback(db, callbackPayload, env)
      } catch (e) {
        console.error('[IGS] retry inline fallback failed:', e)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// getIgsStatus
// ---------------------------------------------------------------------------
/** txid に紐付く最新の IgsRequests レコードを返す。存在しない場合は null。 */
export async function getIgsStatus(
  db: D1Database,
  txid: string,
): Promise<IgsRequestRow | null> {
  return db
    .prepare(
      `SELECT * FROM IgsRequests WHERE txid = ? ORDER BY requested_at DESC LIMIT 1`,
    )
    .bind(txid)
    .first<IgsRequestRow>()
}
