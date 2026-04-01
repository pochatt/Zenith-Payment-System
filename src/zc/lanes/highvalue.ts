/**
 * @file HIGH_VALUE lane processing. Large-amount transfers with BOJ pre-fund
 *       checks and IGS settlement.
 * @module zc/lanes/highvalue
 */
// proof_type = PAYER_HV_ISOLATION_PROOF
import type { Env, PaymentInitiatedRequest } from '../../types'
import { nowISO } from '../../types'
import { writeFinalityLog, callBankAuthorityCheck, callBankNameCheck, finalizeCancelledTx } from '../orchestrator'
import { newDecisionProofRef, newFinalityLogRef } from '../../shared/proof'
import { newUUID } from '../../shared/idempotency'
import { initiateIgsSettlement } from '../igs'
import { calcBalance } from '../../bank/ledger'

export function processHighValueIngress(req: PaymentInitiatedRequest) {
  return { result: 'INGRESS_ACCEPTED' as const, txid: req.txid, state: 'RECEIVED' as const }
}

/**
 * HIGH_VALUE 非同期処理:
 * RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → (a_HV) → IGS待ち → b
 */
export async function advanceHighValue(txid: string, env: Env): Promise<void> {
  const db = env.DB
  const now = nowISO()

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{
      state: string; payer_bank_id: string; payee_bank_id: string;
      amount_value: number; payer_account_hash: string; payee_account_hash: string | null;
      pspr_ref: string | null; version: number
    }>()
  if (!tx || tx.state !== 'RECEIVED') return

  // 1. PRECHECKED
  await db.prepare(`UPDATE Transactions SET state='PRECHECKED', updated_at=?, version=version+1 WHERE txid=? AND state='RECEIVED'`).bind(now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })

  // 2. AML Authority Check
  // キュー再試行で同一 request_id を保証
  const authResult = await callBankAuthorityCheck(tx.payer_bank_id, { request_id: `AUTH-${txid}`, txid, check_type: 'INITIAL' }, env)
  if (authResult.result === 'NG') {
    await db.prepare(`UPDATE Transactions SET state='DECIDED_CANCEL', reason_code=?, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`).bind(authResult.reason_code, now, txid).run()
    // FinalityLog 記録と DECIDED_CANCEL → CANCELLED 遷移
    await writeFinalityLog(db, {
      txid, event_type: 'DecidedCancel', state_from: 'PRECHECKED', state_to: 'DECIDED_CANCEL',
      payload_json: JSON.stringify({ reason_code: authResult.reason_code }), txid_or_gtid: txid,
    })
    await finalizeCancelledTx(txid, db)
    return
  }

  // 3. Name Check
  // キュー再試行で同一 request_id を保証
  const nameResult = await callBankNameCheck(tx.payee_bank_id, {
    request_id: `NAME-${txid}`, txid, pspr_ref: tx.pspr_ref ?? undefined, account_hash: tx.payee_account_hash ?? '',
  }, env)
  if (nameResult.result === 'MISMATCH') {
    await db.prepare(`UPDATE Transactions SET state='PRECHECKED_SUSPENDED', reason_code='SUSPEND_NAMECHECK_PENDING', updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`).bind(now, txid).run()
    // FinalityLog 記録
    await writeFinalityLog(db, {
      txid, event_type: 'PreCheckSuspended', state_from: 'PRECHECKED', state_to: 'PRECHECKED_SUSPENDED',
      payload_json: JSON.stringify({ reason_code: 'SUSPEND_NAMECHECK_PENDING' }), txid_or_gtid: txid,
    })
    return
  }

  // 4. BOJ残高チェック（プレファンドRTGS）
  // BOJ(-) = 積立残高あり。calcBalance + amount > 0 なら残高不足
  const bojBalance = await calcBalance(`${tx.payer_bank_id}-BOJ`, db)
  if (bojBalance + tx.amount_value > 0) {
    await db.prepare(
      `UPDATE Transactions SET state='DECIDED_CANCEL', reason_code='BOJ_INSUFFICIENT_FUNDS',
       updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`
    ).bind(now, txid).run()
    await writeFinalityLog(db, {
      txid, event_type: 'DecidedCancel', state_from: 'PRECHECKED', state_to: 'DECIDED_CANCEL',
      payload_json: JSON.stringify({
        reason_code: 'BOJ_INSUFFICIENT_FUNDS',
        boj_balance: bojBalance,
        amount: tx.amount_value,
        available: -bojBalance,
      }),
      txid_or_gtid: txid,
    })
    await finalizeCancelledTx(txid, db)
    return
  }

  // 5. HIGH_VALUE は H予約スキップ（h_limit 消費なし）
  // Decision確定
  const decisionProofRef = newDecisionProofRef()
  const finalityLogRef = newFinalityLogRef()
  await db.prepare(`UPDATE Transactions SET state='DECIDED_TO_SETTLE', decision_proof_ref=?, finality_log_ref=?, updated_at=?, version=version+1 WHERE txid=? AND state='PRECHECKED'`).bind(decisionProofRef, finalityLogRef, now, txid).run()
  await writeFinalityLog(db, {
    txid, event_type: 'DecidedToSettle', state_from: 'PRECHECKED', state_to: 'DECIDED_TO_SETTLE',
    payload_json: JSON.stringify({ decision_proof_ref: decisionProofRef, lane: 'HIGH_VALUE' }), txid_or_gtid: txid,
  })

  // 6. ExecuteDebit（a_HV: proof_type=PAYER_HV_ISOLATION_PROOF）
  // payer_account_hash を渡す（HVは reserve-funds を経由しないため Bank 側で account を特定できない）
  await env.QUEUE.send({
    type: 'ZC_BANK_DEBIT',
    payload: {
      txid, payer_bank_id: tx.payer_bank_id, payee_bank_id: tx.payee_bank_id,
      amount: { value: tx.amount_value, currency: 'JPY' },
      decision_proof_ref: decisionProofRef, lane: 'HIGH_VALUE',
      payer_account_hash: tx.payer_account_hash,
    },
    txid, attempt: 0, enqueued_at: now,
  })

  // 7. IGS決済開始（debit キュー投入後、external_settlement_status を PENDING に設定）
  // payee credit は handleIgsCallback（igs.ts）が IGS確定後に実行する
  await db.prepare(
    `UPDATE Transactions SET external_settlement_status='PENDING', updated_at=? WHERE txid=?`
  ).bind(now, txid).run()
  await initiateIgsSettlement(db, txid, { value: tx.amount_value, currency: 'JPY' }, tx.payer_bank_id, tx.payee_bank_id, env)
}
