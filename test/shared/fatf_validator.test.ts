/**
 * @file Unit tests for src/shared/fatf_validator.ts
 *
 * Regression coverage for:
 *   B3 — extra closing-quote in intermediary.country error message was
 *        producing malformed strings. Fixed by removing the stray "')".
 */
import { describe, it, expect } from 'vitest'
import { validateFatfR16 } from '../../src/shared/fatf_validator'
import type { FatfR16Data } from '../../src/types'

function baseData(): FatfR16Data {
  return {
    originator: {
      name: '山田太郎',
      account_id: '0010000001',
      address: '東京都千代田区1-1',
    },
    beneficiary: {
      name: 'John Doe',
      account_id: '0020000099',
    },
    ordering_institution: {
      bank_id: '001',
      bank_name: 'Bank A',
      country: 'JP',
    },
    beneficiary_institution: {
      bank_id: '002',
      bank_name: 'Bank B',
      country: 'US',
    },
    is_cross_border: true,
    fatf16_applicable: true,
  }
}

describe('validateFatfR16 — well-formed data', () => {
  it('passes a complete valid payload', () => {
    const result = validateFatfR16(baseData())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('validateFatfR16 — error messages are well-formed (B3)', () => {
  it('error for invalid intermediary country code does not contain stray quote characters', () => {
    const data: FatfR16Data = {
      ...baseData(),
      intermediary: {
        name: 'Intermediary Bank',
        country: 'XYZ',  // invalid: 3 chars, fails /^[A-Z]{2}$/ — triggers B3 code path
      },
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(false)

    const countryError = result.errors.find(e => e.includes('intermediary.country'))
    expect(countryError).toBeDefined()

    // B3 regression: the original message ended with "が必要)')" — two extra chars.
    // After the fix it ends with "が必要)" — exactly one closing paren, no stray quote.
    expect(countryError).not.toMatch(/が必要'\)/)   // old broken pattern
    expect(countryError).toMatch(/が必要\)$/)        // correct: ends with single ")"
  })

  it('error for missing intermediary country is a separate message', () => {
    const data: FatfR16Data = {
      ...baseData(),
      intermediary: {
        name: 'Intermediary Bank',
        country: '',
      },
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(false)
    const countryError = result.errors.find(e => e.includes('intermediary.country'))
    expect(countryError).toBeDefined()
    expect(countryError).toContain('必須')
  })
})

describe('validateFatfR16 — originator identity', () => {
  it('rejects when no additional identity info is provided', () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: { name: '山田太郎', account_id: '0010000001' },
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('originator'))).toBe(true)
  })

  it('passes when originator has date_of_birth + place_of_birth instead of address', () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: {
        name: '山田太郎',
        account_id: '0010000001',
        date_of_birth: '1990-01-01',
        place_of_birth: 'Tokyo',
      },
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(true)
  })

  it('rejects when only date_of_birth is given (without place_of_birth)', () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: {
        name: '山田太郎',
        account_id: '0010000001',
        date_of_birth: '1990-01-01',
      },
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(false)
  })
})

describe('validateFatfR16 — flag consistency', () => {
  it('rejects fatf16_applicable=true when is_cross_border=false', () => {
    const data: FatfR16Data = {
      ...baseData(),
      is_cross_border: false,
      fatf16_applicable: true,
    }
    const result = validateFatfR16(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('is_cross_border'))).toBe(true)
  })
})
