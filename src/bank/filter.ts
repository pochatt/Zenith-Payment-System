/**
 * @file Payment filter evaluation and management. Evaluates incoming credits
 * against SENDER_BLOCK, SENDER_BANK_BLOCK, AMOUNT_LIMIT, EDI_PATTERN, and
 * REQUIRE_APPROVAL filters. Manages approval request lifecycle.
 * @module bank/filter
 */
//
// 将来的な顧客承認フロー拡張ポイント:
//   - HOLD_CONFIRM が発動したとき approval_id を生成して返す
//   - 顧客スマートフォンへのプッシュ通知送信はここに追加する
//   - 顧客が承認/拒否後 ZC にコールバックする仕組みも同様
import type {
  FilterEvalResult, PaymentFilterRow, PaymentApprovalRequestRow,
  CreatePaymentFilterRequest, RespondApprovalRequest,
  EdiFilterCondition, EdiRecordRow,
} from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'
import { filterByEdiCondition } from '../zc/edi'

// ---------------------------------------------------------------------------
// フィルタ評価
// ---------------------------------------------------------------------------

/**
 * 着金フィルタを評価する。
 * execute-credit の前段で呼び出し、最初にマッチしたフィルタのアクションを返す。
 *
 * @param bankId        着金銀行ID
 * @param accountId     着金口座ID（内部ID）
 * @param senderBankId  送金元銀行ID
 * @param senderAccountHash 送金元口座ハッシュ
 * @param amountValue   送金額
 * @param ediData       電文EDIデータ（null可）
 * @param txid          ZC取引ID
 */
export async function evaluatePaymentFilters(
  bankId: string,
  accountId: string,
  senderBankId: string,
  senderAccountHash: string | null,
  amountValue: number,
  ediData: string | null,
  txid: string,
  db: D1Database,
): Promise<FilterEvalResult> {
  // 銀行全体フィルタ + 口座フィルタを取得（優先度: ACCOUNT > BANK_WIDE）
  const rows = await db.prepare(
    `SELECT * FROM PaymentFilters
     WHERE bank_id = ? AND is_active = 1
       AND (scope = 'BANK_WIDE' OR (scope = 'ACCOUNT' AND account_id = ?))
     ORDER BY CASE scope WHEN 'ACCOUNT' THEN 0 ELSE 1 END ASC, filter_id ASC`
  ).bind(bankId, accountId).all<PaymentFilterRow>()

  for (const filter of rows.results) {
    const cond = JSON.parse(filter.condition_json) as Record<string, unknown>
    const matched = matchFilter(filter.filter_type, cond, {
      senderBankId, senderAccountHash, amountValue, ediData,
    })
    if (!matched) continue

    // フィルタにマッチした
    if (filter.action === 'REJECT') {
      return {
        matched: true,
        action: 'REJECT',
        filter_id: filter.filter_id,
        reason_code: 'PAYMENT_FILTER_REJECTED',
      }
    }

    // HOLD_CONFIRM / HOLD_MANUAL: 承認リクエストを生成
    const approvalId = await createApprovalRequest(db, {
      bankId,
      accountId,
      txid,
      filterId: filter.filter_id,
      senderBankId,
      senderAccountHash,
      amountValue,
      ediData,
      // 承認期限: 着金保留から24時間
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })

    return {
      matched: true,
      action: filter.action,
      filter_id: filter.filter_id,
      approval_id: approvalId,
    }
  }

  return { matched: false }
}

/** フィルタ条件の評価 */
function matchFilter(
  filterType: string,
  condition: Record<string, unknown>,
  ctx: {
    senderBankId: string
    senderAccountHash: string | null
    amountValue: number
    ediData: string | null
  },
): boolean {
  switch (filterType) {
    case 'SENDER_BLOCK':
      return ctx.senderAccountHash !== null
        && ctx.senderAccountHash === condition.sender_account_hash

    case 'SENDER_BANK_BLOCK':
      return ctx.senderBankId === condition.sender_bank_id

    case 'AMOUNT_LIMIT':
      return typeof condition.max_amount === 'number'
        && ctx.amountValue > condition.max_amount

    case 'EDI_PATTERN': {
      if (!ctx.ediData || typeof condition.pattern !== 'string') return false
      try {
        const re = new RegExp(condition.pattern as string, 'i')
        return re.test(ctx.ediData)
      } catch {
        return false
      }
    }

    // EDI_STRUCTURED: EdiFilterCondition による構造化照合
    // condition は { field, operator, value } の EdiFilterCondition 形式
    // evaluatePaymentFilters からの同期呼び出しでは DB アクセス不可のため、
    // ediData（purpose テキスト）に対して条件を文字列照合する簡易評価を行う。
    // 完全な DB 照合は applyEdiFilter() を使用すること。
    case 'EDI_STRUCTURED': {
      const cond = condition as Partial<EdiFilterCondition>
      if (!cond.field || !cond.operator || cond.value === undefined) return false
      const target = ctx.ediData ?? ''
      const val = String(cond.value)
      switch (cond.operator) {
        case 'EQUALS':   return target === val
        case 'CONTAINS': return target.includes(val)
        case 'REGEX': {
          try { return new RegExp(val, 'i').test(target) } catch { return false }
        }
        case 'GT': return parseFloat(target) > parseFloat(val)
        case 'LT': return parseFloat(target) < parseFloat(val)
        default:   return false
      }
    }

    case 'REQUIRE_APPROVAL':
      return true  // 無条件発動

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// PaymentApprovalRequests CRUD
// ---------------------------------------------------------------------------

interface CreateApprovalParams {
  bankId: string
  accountId: string
  txid: string
  filterId: string
  senderBankId: string
  senderAccountHash: string | null
  amountValue: number
  ediData: string | null
  expiresAt: string
}

async function createApprovalRequest(
  db: D1Database,
  params: CreateApprovalParams,
): Promise<string> {
  const approvalId = `APR-${newUUID()}`
  const now = nowISO()
  await db.prepare(
    `INSERT INTO PaymentApprovalRequests
     (approval_id, bank_id, account_id, txid, filter_id, status,
      sender_bank_id, sender_account_hash, amount_value, edi_data,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    approvalId, params.bankId, params.accountId, params.txid, params.filterId,
    params.senderBankId, params.senderAccountHash,
    params.amountValue, params.ediData,
    params.expiresAt, now, now,
  ).run()
  return approvalId
}

/** 顧客の承認/拒否を記録する */
export async function respondToApproval(
  bankId: string,
  approvalId: string,
  req: RespondApprovalRequest,
  db: D1Database,
): Promise<{ ok: boolean; txid?: string; reason?: string }> {
  const now = nowISO()
  const approval = await db.prepare(
    `SELECT * FROM PaymentApprovalRequests WHERE approval_id = ? AND bank_id = ?`
  ).bind(approvalId, bankId).first<PaymentApprovalRequestRow>()

  if (!approval) return { ok: false, reason: 'NOT_FOUND' }
  if (approval.status !== 'PENDING') return { ok: false, reason: 'ALREADY_RESPONDED' }

  // 期限切れチェックと応答をアトミックに実行（単一 UPDATE で TOCTOU 回避）
  const newStatus = req.approved ? 'APPROVED' : 'REJECTED'
  const respondResult = await db.prepare(
    `UPDATE PaymentApprovalRequests
     SET status=?, responded_at=?, updated_at=?
     WHERE approval_id=? AND status='PENDING' AND expires_at > ?`
  ).bind(newStatus, now, now, approvalId, now).run()

  if (respondResult.meta.changes === 0) {
    // expires_at <= now なら期限切れ → TIMEOUT にマーク
    const timeoutResult = await db.prepare(
      `UPDATE PaymentApprovalRequests SET status='TIMEOUT', updated_at=?
       WHERE approval_id=? AND status='PENDING' AND expires_at <= ?`
    ).bind(now, approvalId, now).run()

    if (timeoutResult.meta.changes > 0) {
      return { ok: false, reason: 'EXPIRED' }
    }
    return { ok: false, reason: 'ALREADY_RESPONDED' }
  }

  return { ok: true, txid: approval.txid }
}

/** 期限切れの承認リクエストを TIMEOUT に更新（timeout_sweep.ts から呼ばれる） */
export async function sweepExpiredApprovals(db: D1Database): Promise<number> {
  const now = nowISO()
  const result = await db.prepare(
    `UPDATE PaymentApprovalRequests
     SET status='TIMEOUT', updated_at=?
     WHERE status='PENDING' AND expires_at < ?`
  ).bind(now, now).run()
  return result.meta.changes ?? 0
}

/** 口座の承認待ちリクエスト一覧 */
export async function listApprovalRequests(
  bankId: string,
  accountId: string | null,
  status: string | null,
  db: D1Database,
): Promise<(PaymentApprovalRequestRow & { filter_type: string | null })[]> {
  let sql = `
    SELECT a.*, f.filter_type
    FROM PaymentApprovalRequests a
    LEFT JOIN PaymentFilters f ON a.filter_id = f.filter_id
    WHERE a.bank_id = ?`
  const binds: unknown[] = [bankId]
  if (accountId) { sql += ` AND a.account_id = ?`; binds.push(accountId) }
  if (status) { sql += ` AND a.status = ?`; binds.push(status) }
  sql += ` ORDER BY a.created_at DESC LIMIT 100`
  const rows = await db.prepare(sql).bind(...binds).all<PaymentApprovalRequestRow & { filter_type: string | null }>()
  return rows.results
}

// ---------------------------------------------------------------------------
// PaymentFilters CRUD
// ---------------------------------------------------------------------------

export async function createFilter(
  bankId: string,
  req: CreatePaymentFilterRequest,
  db: D1Database,
): Promise<PaymentFilterRow> {
  const filterId = `FLT-${newUUID()}`
  const now = nowISO()
  await db.prepare(
    `INSERT INTO PaymentFilters
     (filter_id, bank_id, scope, account_id, filter_type, condition_json,
      action, description, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).bind(
    filterId, bankId, req.scope, req.account_id ?? null,
    req.filter_type, JSON.stringify(req.condition),
    req.action, req.description ?? null, req.created_by, now, now,
  ).run()

  return {
    filter_id: filterId, bank_id: bankId, scope: req.scope,
    account_id: req.account_id ?? null, filter_type: req.filter_type,
    condition_json: JSON.stringify(req.condition), action: req.action,
    description: req.description ?? null, is_active: 1,
    created_by: req.created_by, created_at: now, updated_at: now,
  }
}

export async function listFilters(
  bankId: string,
  accountId: string | null,
  db: D1Database,
): Promise<PaymentFilterRow[]> {
  let sql = `SELECT * FROM PaymentFilters WHERE bank_id = ?`
  const binds: unknown[] = [bankId]
  if (accountId) { sql += ` AND account_id = ?`; binds.push(accountId) }
  sql += ` ORDER BY created_at DESC`
  const rows = await db.prepare(sql).bind(...binds).all<PaymentFilterRow>()
  return rows.results
}

export async function setFilterActive(
  bankId: string,
  filterId: string,
  isActive: boolean,
  db: D1Database,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE PaymentFilters SET is_active=?, updated_at=? WHERE filter_id=? AND bank_id=?`
  ).bind(isActive ? 1 : 0, nowISO(), filterId, bankId).run()
  return (result.meta.changes ?? 0) > 0
}

export async function deleteFilter(
  bankId: string,
  filterId: string,
  db: D1Database,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM PaymentFilters WHERE filter_id=? AND bank_id=?`
  ).bind(filterId, bankId).run()
  return (result.meta.changes ?? 0) > 0
}

// ---------------------------------------------------------------------------
// EDI構造化フィルタ: EdiRecords + Transactions を結合して条件照合
// ---------------------------------------------------------------------------

/**
 * EdiFilterCondition に基づいて EdiRecords を検索し、
 * 一致した取引IDの一覧を返す。
 *
 * @param db              D1 データベース
 * @param bankId          フィルタ対象の銀行ID（EdiRecords.created_by_bank_id）
 * @param filterCondition EdiFilterCondition（field / operator / value）
 * @returns 一致した EdiRecordRow 配列（txid で Transactions と紐付け可）
 */
export async function applyEdiFilter(
  db: D1Database,
  bankId: string,
  filterCondition: EdiFilterCondition,
): Promise<EdiRecordRow[]> {
  return filterByEdiCondition(db, bankId, filterCondition)
}
