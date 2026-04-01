/**
 * @file FATF Recommendation 16 (wire transfer) compliance validation.
 *
 * Validates that cross-border transactions above the threshold (JPY 150,000 /
 * USD 1,000 equivalent) carry the required originator and beneficiary
 * information mandated by the FATF Travel Rule.
 *
 * Key validations:
 * - Originator: name, account, plus at least one of address / national ID / DOB+birthplace
 * - Beneficiary: name and account
 * - Ordering & beneficiary institutions: bank ID, name, country (ISO 3166-1), optional BIC
 *
 * @module shared/fatf_validator
 */

import type { FatfR16Data, FatfParty, FatfInstitution } from '../types'

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

import { FATF_THRESHOLD_JPY, EXCHANGE_RATE_TO_JPY } from './constants'

// ---------------------------------------------------------------------------
// FATF R16 適用判定
// ---------------------------------------------------------------------------

/**
 * Determine whether FATF Recommendation 16 applies to a transaction.
 *
 * Both conditions must be met:
 * 1. The transfer is cross-border
 * 2. The amount is >= USD 1,000 equivalent (JPY 150,000)
 *
 * @param amount        - Transaction amount in the given currency
 * @param currency      - ISO 4217 currency code (e.g. "JPY", "USD")
 * @param isCrossBorder - Whether this is a cross-border transfer
 * @returns `true` if FATF R16 compliance is required
 */
export function isFatfApplicable(amount: number, currency: string, isCrossBorder: boolean): boolean {
  if (!isCrossBorder) return false

  const rate = EXCHANGE_RATE_TO_JPY[currency.toUpperCase()] ?? 150
  const amountInJpy = amount * rate

  return amountInJpy >= FATF_THRESHOLD_JPY
}

// ---------------------------------------------------------------------------
// FATF R16 必須フィールド検証
// ---------------------------------------------------------------------------

/**
 * Validate that all FATF R16 mandatory fields are present and well-formed.
 *
 * Checks:
 * - Originator: name, account, plus address OR national ID OR DOB+birthplace
 * - Beneficiary: name and account
 * - Ordering institution: bank ID, name, country code
 * - Beneficiary institution: bank ID, name, country code
 * - Consistency between `fatf16_applicable` and `is_cross_border` flags
 * - Optional intermediary institution fields if present
 *
 * @param data - The FATF R16 data block attached to a transaction
 * @returns `{ valid, errors }` -- errors array is empty on success
 */
export function validateFatfR16(data: FatfR16Data): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // originator 検証
  const originatorErrors = validateOriginator(data.originator)
  errors.push(...originatorErrors)

  // beneficiary 検証
  const beneficiaryErrors = validateBeneficiary(data.beneficiary)
  errors.push(...beneficiaryErrors)

  // ordering_institution 検証
  const orderingErrors = validateInstitution(data.ordering_institution)
  orderingErrors.forEach(e => errors.push(`ordering_institution: ${e}`))

  // beneficiary_institution 検証
  const beneficiaryInstErrors = validateInstitution(data.beneficiary_institution)
  beneficiaryInstErrors.forEach(e => errors.push(`beneficiary_institution: ${e}`))

  // 国をまたぐ取引であることの整合性確認
  if (data.fatf16_applicable && !data.is_cross_border) {
    errors.push('fatf16_applicable=true だが is_cross_border=false: 矛盾した設定です')
  }

  // intermediary が存在する場合の検証
  if (data.intermediary) {
    if (!data.intermediary.name || data.intermediary.name.trim().length === 0) {
      errors.push('intermediary.name: 仲介機関名は必須です')
    }
    if (!data.intermediary.country || data.intermediary.country.trim().length === 0) {
      errors.push('intermediary.country: 仲介機関の国コードは必須です')
    } else if (!isValidCountryCode(data.intermediary.country)) {
      errors.push(`intermediary.country: 無効な国コード '${data.intermediary.country}' (ISO 3166-1 alpha-2 が必要)')`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// originator (送金人) 情報検証
// ---------------------------------------------------------------------------

/**
 * Validate originator (sender) information per FATF R16.
 *
 * Required: name, account_id.
 * At least one additional identifier: address, national_id, or date_of_birth + place_of_birth.
 *
 * @param party - Originator party data
 * @returns Array of error messages (empty if valid)
 */
function validateOriginator(party: FatfParty): string[] {
  const errors: string[] = []
  const prefix = 'originator'

  // 必須フィールド
  if (!party.name || party.name.trim().length === 0) {
    errors.push(`${prefix}.name: 送金人氏名は必須です`)
  } else if (party.name.trim().length > 140) {
    errors.push(`${prefix}.name: 送金人氏名は140文字以内にしてください`)
  }

  if (!party.account_id || party.account_id.trim().length === 0) {
    errors.push(`${prefix}.account_id: 送金人口座番号は必須です`)
  }

  // 追加識別情報（住所 OR 国民識別番号 OR 生年月日+出生地）のいずれか必須
  const hasAddress     = Boolean(party.address?.trim())
  const hasNationalId  = Boolean(party.national_id?.trim())
  const hasDob         = Boolean(party.date_of_birth?.trim())
  const hasPob         = Boolean(party.place_of_birth?.trim())
  const hasDobAndPob   = hasDob && hasPob

  if (!hasAddress && !hasNationalId && !hasDobAndPob) {
    errors.push(
      `${prefix}: 送金人の追加識別情報が不足しています。` +
      `住所(address)、国民識別番号(national_id)、` +
      `生年月日+出生地(date_of_birth + place_of_birth) のいずれか1つが必須です`
    )
  }

  // 生年月日フォーマット検証（YYYY-MM-DD）
  if (hasDob && party.date_of_birth) {
    if (!isValidDateFormat(party.date_of_birth)) {
      errors.push(`${prefix}.date_of_birth: YYYY-MM-DD 形式で入力してください (例: 1985-04-15)`)
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// beneficiary (受取人) 情報検証
// ---------------------------------------------------------------------------

/**
 * Validate beneficiary (recipient) information per FATF R16.
 *
 * Required: name and account_id.
 * Unlike originator, no additional identifiers are mandated by FATF R16.
 *
 * @param party - Beneficiary party data
 * @returns Array of error messages (empty if valid)
 */
function validateBeneficiary(party: FatfParty): string[] {
  const errors: string[] = []
  const prefix = 'beneficiary'

  if (!party.name || party.name.trim().length === 0) {
    errors.push(`${prefix}.name: 受取人氏名は必須です`)
  } else if (party.name.trim().length > 140) {
    errors.push(`${prefix}.name: 受取人氏名は140文字以内にしてください`)
  }

  if (!party.account_id || party.account_id.trim().length === 0) {
    errors.push(`${prefix}.account_id: 受取人口座番号は必須です`)
  }

  return errors
}

// ---------------------------------------------------------------------------
// ordering/beneficiary institution 検証
// ---------------------------------------------------------------------------

/**
 * Validate financial institution information per FATF R16.
 *
 * Required: bank_id, bank_name, and ISO 3166-1 alpha-2 country code.
 * Optional but recommended: SWIFT BIC (8 or 11 characters).
 *
 * @param inst - Institution data (ordering or beneficiary)
 * @returns Array of error messages (empty if valid)
 */
function validateInstitution(inst: FatfInstitution): string[] {
  const errors: string[] = []

  if (!inst.bank_id || inst.bank_id.trim().length === 0) {
    errors.push('bank_id: 金融機関IDは必須です')
  }

  if (!inst.bank_name || inst.bank_name.trim().length === 0) {
    errors.push('bank_name: 金融機関名は必須です')
  }

  if (!inst.country || inst.country.trim().length === 0) {
    errors.push('country: 国コードは必須です')
  } else if (!isValidCountryCode(inst.country)) {
    errors.push(`country: 無効な国コード '${inst.country}' (ISO 3166-1 alpha-2 が必要, 例: JP, US, DE)`)
  }

  // BIC が存在する場合のフォーマット検証
  if (inst.bic) {
    if (!isValidBicFormat(inst.bic)) {
      errors.push(`bic: 無効な BIC フォーマット '${inst.bic}' (8文字または11文字が必要)`)
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// シリアライズ / デシリアライズ
// ---------------------------------------------------------------------------

/**
 * Serialize FatfR16Data to a JSON string for DB storage or transmission.
 *
 * @param data - FATF R16 data block
 * @returns JSON string
 */
export function serializeFatfData(data: FatfR16Data): string {
  return JSON.stringify(data)
}

/**
 * Deserialize a JSON string into FatfR16Data.
 *
 * Returns null if parsing fails or the object does not have the required shape.
 *
 * @param json - JSON string from D1 or an API payload
 * @returns Parsed FatfR16Data, or null on failure
 */
export function deserializeFatfData(json: string): FatfR16Data | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!isValidFatfR16Shape(parsed)) {
      return null
    }
    return parsed as FatfR16Data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 追加ユーティリティ（エクスポート）
// ---------------------------------------------------------------------------

/**
 * Convert an amount to JPY equivalent using fixed mock exchange rates.
 *
 * Used for FATF threshold checks and dashboard display.
 *
 * @param amount   - Transaction amount
 * @param currency - ISO 4217 currency code
 * @returns Approximate JPY equivalent (rounded to nearest integer)
 */
export function toJpyEquivalent(amount: number, currency: string): number {
  const rate = EXCHANGE_RATE_TO_JPY[currency.toUpperCase()] ?? 150
  return Math.round(amount * rate)
}

/**
 * Create a minimal FatfR16Data skeleton for transaction initialization.
 *
 * Automatically determines `fatf16_applicable` based on amount, currency,
 * and cross-border status. Callers can enrich the skeleton with additional
 * originator identifiers (address, national_id, etc.) before submission.
 *
 * @param params - Minimum required parameters for the skeleton
 * @returns FatfR16Data with mandatory fields populated
 */
export function createFatfDataSkeleton(params: {
  originatorName: string
  originatorAccountId: string
  beneficiaryName: string
  beneficiaryAccountId: string
  orderingBankId: string
  orderingBankName: string
  orderingCountry: string
  beneficiaryBankId: string
  beneficiaryBankName: string
  beneficiaryCountry: string
  isCrossBorder: boolean
  amount: number
  currency: string
}): FatfR16Data {
  return {
    originator: {
      name: params.originatorName,
      account_id: params.originatorAccountId,
    },
    beneficiary: {
      name: params.beneficiaryName,
      account_id: params.beneficiaryAccountId,
    },
    ordering_institution: {
      bank_id: params.orderingBankId,
      bank_name: params.orderingBankName,
      country: params.orderingCountry,
    },
    beneficiary_institution: {
      bank_id: params.beneficiaryBankId,
      bank_name: params.beneficiaryBankName,
      country: params.beneficiaryCountry,
    },
    is_cross_border: params.isCrossBorder,
    fatf16_applicable: isFatfApplicable(params.amount, params.currency, params.isCrossBorder),
  }
}

// ---------------------------------------------------------------------------
// 内部ユーティリティ（モジュール非公開）
// ---------------------------------------------------------------------------

/** Validate ISO 3166-1 alpha-2 country code format (regex only in mock). */
function isValidCountryCode(country: string): boolean {
  // 大文字に正規化してから検証（小文字入力も受け入れるが正規化済みを前提とする）
  return /^[A-Z]{2}$/.test(country.toUpperCase())
}

/** Normalize a country code to uppercase ISO 3166-1 alpha-2 format. */
export function normalizeCountryCode(country: string): string {
  return country.toUpperCase()
}

/** Validate SWIFT BIC format: 4-char institution + 2-char country + 2-char location [+ 3-char branch]. */
function isValidBicFormat(bic: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.toUpperCase())
}

/** Validate that a date string is in YYYY-MM-DD format and represents a real date. */
function isValidDateFormat(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const date = new Date(dateStr)
  return !isNaN(date.getTime())
}

/** TypeScript type guard: checks that a parsed object has the minimum FatfR16Data shape. */
function isValidFatfR16Shape(obj: unknown): obj is FatfR16Data {
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as Record<string, unknown>

  // 必須トップレベルキー
  const requiredKeys: (keyof FatfR16Data)[] = [
    'originator',
    'beneficiary',
    'ordering_institution',
    'beneficiary_institution',
    'is_cross_border',
    'fatf16_applicable',
  ]
  for (const key of requiredKeys) {
    if (!(key in o)) return false
  }

  // originator / beneficiary は name と account_id を持つオブジェクト
  for (const partyKey of ['originator', 'beneficiary'] as const) {
    const party = o[partyKey]
    if (typeof party !== 'object' || party === null) return false
    const p = party as Record<string, unknown>
    if (typeof p['name'] !== 'string') return false
    if (typeof p['account_id'] !== 'string') return false
  }

  // ordering_institution / beneficiary_institution は bank_id, bank_name, country を持つ
  for (const instKey of ['ordering_institution', 'beneficiary_institution'] as const) {
    const inst = o[instKey]
    if (typeof inst !== 'object' || inst === null) return false
    const i = inst as Record<string, unknown>
    if (typeof i['bank_id'] !== 'string') return false
    if (typeof i['bank_name'] !== 'string') return false
    if (typeof i['country'] !== 'string') return false
  }

  return true
}
