/**
 * @file ZEDI integration — Zengin EDI rich data management. Registers and
 *       queries structured invoice/remittance data attached to transactions.
 * @module zc/edi
 */
import type { EdiRecordRow, EdiRegisterRequest, EdiLineItem, EdiFilterCondition } from '../types'

// ---------------------------------------------------------------------------
// EDI登録: EdiRecords テーブルへ INSERT
// ---------------------------------------------------------------------------
export async function registerEdiRecord(
  db: D1Database,
  req: EdiRegisterRequest,
  createdByBankId: string,
): Promise<EdiRecordRow> {
  const ediRef = crypto.randomUUID()
  const now = new Date().toISOString()
  const lineItemsJson = req.line_items ? serializeLineItems(req.line_items) : null

  await db.prepare(`
    INSERT INTO EdiRecords
      (edi_ref, txid, format_version, invoice_number, invoice_date, payment_due_date,
       tax_amount, tax_rate, discount_amount, note, sender_ref, receiver_ref,
       line_items_json, created_by_bank_id, created_at)
    VALUES (?, NULL, '1.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    ediRef,
    req.invoice_number ?? null,
    req.invoice_date ?? null,
    req.payment_due_date ?? null,
    req.tax_amount ?? null,
    req.tax_rate ?? null,
    req.discount_amount ?? null,
    req.note ?? null,
    req.sender_ref ?? null,
    req.receiver_ref ?? null,
    lineItemsJson,
    createdByBankId,
    now,
  ).run()

  return {
    edi_ref: ediRef,
    txid: null,
    format_version: '1.0',
    invoice_number: req.invoice_number ?? null,
    invoice_date: req.invoice_date ?? null,
    payment_due_date: req.payment_due_date ?? null,
    tax_amount: req.tax_amount ?? null,
    tax_rate: req.tax_rate ?? null,
    discount_amount: req.discount_amount ?? null,
    note: req.note ?? null,
    sender_ref: req.sender_ref ?? null,
    receiver_ref: req.receiver_ref ?? null,
    line_items_json: lineItemsJson,
    created_by_bank_id: createdByBankId,
    created_at: now,
  }
}

// ---------------------------------------------------------------------------
// txid からEDIレコード取得
// ---------------------------------------------------------------------------
export async function getEdiByTxid(db: D1Database, txid: string): Promise<EdiRecordRow | null> {
  const row = await db.prepare(`
    SELECT * FROM EdiRecords WHERE txid = ? LIMIT 1
  `).bind(txid).first<EdiRecordRow>()
  return row ?? null
}

// ---------------------------------------------------------------------------
// edi_ref からEDIレコード取得
// ---------------------------------------------------------------------------
export async function getEdiByRef(db: D1Database, ediRef: string): Promise<EdiRecordRow | null> {
  const row = await db.prepare(`
    SELECT * FROM EdiRecords WHERE edi_ref = ? LIMIT 1
  `).bind(ediRef).first<EdiRecordRow>()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Transactions の edi_ref カラムを更新 (送金時にEDIを紐付ける)
// ---------------------------------------------------------------------------
export async function linkEdiToTransaction(db: D1Database, txid: string, ediRef: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE Transactions SET edi_ref = ?, updated_at = ? WHERE txid = ?`)
      .bind(ediRef, new Date().toISOString(), txid),
    db.prepare(`UPDATE EdiRecords SET txid = ? WHERE edi_ref = ?`)
      .bind(txid, ediRef),
  ])
}

// ---------------------------------------------------------------------------
// EDI filter: EdiFilterCondition に基づいて EdiRecords + Transactions を結合クエリ
// ---------------------------------------------------------------------------
export async function filterByEdiCondition(
  db: D1Database,
  bankId: string,
  condition: EdiFilterCondition,
): Promise<EdiRecordRow[]> {
  // Build WHERE clause based on field and operator
  let fieldExpr: string
  switch (condition.field) {
    case 'invoice_number': fieldExpr = 'e.invoice_number'; break
    case 'note':           fieldExpr = 'e.note'; break
    case 'sender_ref':     fieldExpr = 'e.sender_ref'; break
    case 'receiver_ref':   fieldExpr = 'e.receiver_ref'; break
    case 'amount_range':   fieldExpr = 'CAST(t.amount_value AS TEXT)'; break
    default:               fieldExpr = 'e.invoice_number'
  }

  let predicate: string
  const numVal = Number(condition.value)

  switch (condition.operator) {
    case 'EQUALS':
      predicate = `${fieldExpr} = ?`
      break
    case 'CONTAINS':
      predicate = `${fieldExpr} LIKE ?`
      break
    case 'REGEX':
      // SQLite has no native REGEX; fall back to LIKE with value as-is
      predicate = `${fieldExpr} LIKE ?`
      break
    case 'GT':
      predicate = `CAST(${fieldExpr} AS REAL) > ?`
      break
    case 'LT':
      predicate = `CAST(${fieldExpr} AS REAL) < ?`
      break
    default:
      predicate = `${fieldExpr} = ?`
  }

  // Bind value: CONTAINS/REGEX use wildcard
  let bindValue: string | number
  if (condition.operator === 'CONTAINS' || condition.operator === 'REGEX') {
    bindValue = `%${condition.value}%`
  } else if (condition.operator === 'GT' || condition.operator === 'LT') {
    bindValue = isNaN(numVal) ? 0 : numVal
  } else {
    bindValue = condition.value
  }

  const sql = `
    SELECT e.*
    FROM EdiRecords e
    LEFT JOIN Transactions t ON t.txid = e.txid
    WHERE e.created_by_bank_id = ?
      AND ${predicate}
    ORDER BY e.created_at DESC
    LIMIT 200
  `
  const result = await db.prepare(sql).bind(bankId, bindValue).all<EdiRecordRow>()
  return result.results ?? []
}

// ---------------------------------------------------------------------------
// line_items_json のパース/シリアライズ
// ---------------------------------------------------------------------------
export function parseLineItems(json: string): EdiLineItem[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed as EdiLineItem[]
  } catch {
    return []
  }
}

export function serializeLineItems(items: EdiLineItem[]): string {
  return JSON.stringify(items)
}
