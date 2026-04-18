/**
 * @file primitives.ts — Leaf-level types with no intra-package dependencies.
 *
 * Contains Env, monetary primitives, proof references, FATF data structures,
 * account-number utilities, and timestamp helpers. These are imported by
 * every other type sub-module, so they must remain dependency-free.
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker Environment Bindings
// ---------------------------------------------------------------------------

/** Cloudflare Worker environment bindings shared by ZC and Bank workers. */
export interface Env {
  DB: D1Database
  QUEUE: Queue
  R2: R2Bucket
  ZC_HMAC_SECRET: string
  BANK_BASE_URL: string
  CRON_SECRET: string
  QR_SECRET: string
  R2_BUCKET?: R2Bucket
  FOREIGN_FPS_ENDPOINT?: string
}

// ---------------------------------------------------------------------------
// Monetary Primitives & Proof References
// ---------------------------------------------------------------------------

/** Monetary amount with currency code (typically "JPY"). */
export interface Amount {
  value: number
  currency: string
}

/**
 * Bank-issued proof reference attached to a transaction after execution.
 * Each proof certifies that a debit or credit was (or was not) applied.
 */
export interface BankProofRef {
  issuer_bank_id: string
  proof_type: ProofType
  proof_id: string
  recorded_at: string
  custody_detail?: CustodyDetail | null
}

export type ProofType =
  | 'PAYER_EXEC_PROOF'
  | 'PAYER_HV_ISOLATION_PROOF'
  | 'PAYEE_EXEC_PROOF'
  | 'NO_DEBIT_RECORDED_PROOF'

/** Details when credit lands in a custody (suspense) account instead of the payee. */
export interface CustodyDetail {
  is_custody: true
  reason_code: string
  custody_account_ref: string
}

// ---------------------------------------------------------------------------
// FATF Recommendation 16 — Cross-border Transfer Data
// ---------------------------------------------------------------------------

export interface FatfParty {
  name: string
  account_id: string
  address?: string
  national_id?: string
  date_of_birth?: string
  place_of_birth?: string
}

export interface FatfInstitution {
  bank_id: string
  bank_name: string
  bic?: string
  country: string
}

export interface FatfR16Data {
  originator: FatfParty
  beneficiary: FatfParty
  ordering_institution: FatfInstitution
  beneficiary_institution: FatfInstitution
  intermediary?: {
    name: string
    license_number?: string
    country: string
  }
  is_cross_border: boolean
  fatf16_applicable: boolean
}

// ---------------------------------------------------------------------------
// Account Number Utilities
// ---------------------------------------------------------------------------

/** 口座番号から銀行コード (3桁) を取得 */
export function bankCodeFromAccount(accountId: string): string {
  return accountId.slice(0, 3)
}

/** 銀行コードから別段預金口座番号を生成 */
export function suspenseAccountId(bankCode: string): string {
  return `${bankCode}0000000`
}

/** 銀行コードから ZC清算勘定口座番号を生成 */
export function nostroAccountId(bankCode: string): string {
  return `${bankCode}-ZCS`
}

/** 銀行コードから利益剰余金（Retained Earnings）口座番号を生成 */
export function retainedEarningsAccountId(bankCode: string): string {
  return `${bankCode}-RE`
}

/** 銀行コードから現金（Cash）口座番号を生成 */
export function cashAccountId(bankCode: string): string {
  return `${bankCode}-CASH`
}

/** 口座番号が別段預金かどうか */
export function isSuspenseAccount(accountId: string): boolean {
  return accountId.endsWith('0000000')
}

/** 次の口座番号を生成 */
export function generateAccountId(bankCode: string, seq: number): string {
  return `${bankCode}${String(seq).padStart(7, '0')}`
}

// ---------------------------------------------------------------------------
// Timestamp Utilities
// ---------------------------------------------------------------------------

export function nowISO(): string {
  return new Date().toISOString()
}

export function todayJST(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
