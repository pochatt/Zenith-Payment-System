/**
 * @file Payment routing, BIC/bank_id mapping, and message format selection.
 *
 * Determines the wire format (ISO 20022, Zengin fixed-length, or Zenith
 * native) based on lane type and cross-border status. Also provides
 * BIC-to-internal-ID resolution and account hashing utilities.
 *
 * The BIC mapping table is hardcoded for the mock; a production system
 * would query an external directory service.
 *
 * @module shared/routing
 */

import type { LaneType, MessageFormat } from "../types";

// ---------------------------------------------------------------------------
// BIC ↔ bank_id mapping (mock fixed values)
// ---------------------------------------------------------------------------

/**
 * BIC code → internal bank_id mapping table.
 * In mock implementation, values are fixed. In production, query DB or external directory.
 */
const BIC_TO_BANK_ID: Record<string, string> = {
  // Participating banks in Japan
  MHCBJPJT: "001", // Nagaoka Bank
  BOTKJPJT: "002", // Owari Bank
  SMTBJPJT: "003", // Kaga Bank
  RZSBJPJT: "004", // Hizen Bank
  HANGJPJT: "005", // Satsuma Bank
  SMBCJPJT: "006", // Echigo Bank
  YUKBJPJT: "007", // Sanuki Bank (international BIC)
  SFJPJPJT: "008", // Bingo Bank
  AOZOBJPJT: "009", // Awaji Bank
  OKHBJPJT: "010", // Hyuga Bank (temporary)
  HOKBJPJT: "011",
  TOHOJPJT: "012",
  CHUBJPJT: "013",
  HOKRJPJT: "014",
  HIRBJPJT: "015",
  SHKBJPJT: "016",
  FUKBJPJT: "017",
  KUMBJPJT: "018", // Osumi Bank
  KAGBJPJT: "019",
  OKNBJPJT: "020",
  // Major overseas banks (for cross-border)
  CHASUS33: "JPMC-US", // JP Morgan Chase (US)
  CITIUS33: "CITI-US", // Citibank (US)
  BOFAUS3N: "BOFA-US", // Bank of America (US)
  DEUTDEDB: "DEUT-DE", // Deutsche Bank (DE)
  BNPAFRPP: "BNPA-FR", // BNP Paribas (FR)
  HSBCHKHH: "HSBC-HK", // HSBC Hong Kong
};

/** bank_id → BIC mapping table (reverse lookup of BIC_TO_BANK_ID) */
const BANK_ID_TO_BIC: Record<string, string> = Object.fromEntries(
  Object.entries(BIC_TO_BANK_ID).map(([bic, id]) => [id, bic])
);

// ---------------------------------------------------------------------------
// lane → message format selection
// ---------------------------------------------------------------------------

/**
 * Select message format based on lane type and cross-border status.
 *
 * Selection rules:
 * - Cross-border transaction always uses ISO20022 (pacs.008)
 * - HIGH_VALUE lane uses ISO20022 (large-value fund payment regulation compliance)
 * - EXPRESS / RTP use ZENITH_NATIVE (low-latency priority)
 * - STANDARD uses ZENITH_NATIVE
 * - BULK / DEFERRED use ZENGIN_FIXED (Zengin batch compatible)
 * - HTLC uses ZENITH_NATIVE (carries hashlock information natively)
 *
 * @param lane - lane type
 * @param isCrossBorder - whether it is a cross-border transaction
 * @returns MessageFormat
 */
export function selectMessageFormat(lane: LaneType, isCrossBorder: boolean): MessageFormat {
  if (isCrossBorder) {
    return "ISO20022";
  }

  switch (lane) {
    case "HIGH_VALUE":
      return "ISO20022";

    case "BULK":
    case "DEFERRED":
      return "ZENGIN_FIXED";

    case "EXPRESS":
    case "STANDARD":
    case "RTP":
    case "HTLC":
    default:
      return "ZENITH_NATIVE";
  }
}

// ---------------------------------------------------------------------------
// BIC ↔ bank_id conversion
// ---------------------------------------------------------------------------

/**
 * Return internal bank_id from BIC code.
 * Return null if not found in mapping.
 *
 * @param bic - SWIFT BIC code (8 or 11 characters)
 * @returns internal bank_id or null
 */
export function bicToBankId(bic: string): string | null {
  if (!bic) return null;
  // 11-character BIC (with branch code) is normalized to 8 characters for lookup
  const normalizedBic = bic.length === 11 ? bic.substring(0, 8) : bic;
  return BIC_TO_BANK_ID[normalizedBic.toUpperCase()] ?? null;
}

/**
 * Return BIC code from internal bank_id.
 * Generate and return dummy BIC if not found in mapping.
 *
 * @param bankId - internal bank_id (e.g., '001', '002')
 * @returns SWIFT BIC code (8 characters)
 */
export function bankIdToBic(bankId: string): string {
  if (!bankId) return "UNKNJPJT";
  const bic = BANK_ID_TO_BIC[bankId];
  if (bic) return bic;
  // If not registered: generate dummy BIC in ZXXXXXXT format
  // X = embed digits of bankId (up to 4 characters)
  const paddedId = bankId.slice(0, 4).padStart(4, "0");
  return `Z${paddedId}JPJT`;
}

// ---------------------------------------------------------------------------
// Domestic / cross-border determination
// ---------------------------------------------------------------------------

/**
 * Determine if transaction is cross-border from payer and payee bank_id.
 *
 * Determination rules:
 * - Both are numeric bank_id with 3 or fewer digits → domestic transaction (false)
 * - Either contains "-" (e.g., JPMC-US, DEUT-DE) → cross-border (true)
 * - One is empty or unregistered → conservatively determine as cross-border (true)
 *
 * @param payerBankId - payer bank_id
 * @param payeeBankId - payee bank_id
 * @returns true if cross-border
 */
export function isCrossBorderTransfer(payerBankId: string, payeeBankId: string): boolean {
  if (!payerBankId || !payeeBankId) return true;

  const isDomestic = (id: string): boolean => /^\d{1,3}$/.test(id);

  // Domestic only if both are domestic bank_id (1-3 digit numbers)
  if (isDomestic(payerBankId) && isDomestic(payeeBankId)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Proxy-resolved payment account hash
// ---------------------------------------------------------------------------

/**
 * Hash resolved account information with SHA-256.
 * Uses Web Crypto API (globalThis.crypto).
 *
 * Purpose: avoid storing account number in plain text, compare and reference by hash value.
 *
 * @param accountId - plain text account number (e.g., '0010001234')
 * @returns SHA-256 hash as hexadecimal string (64 characters)
 */
export async function hashAccountId(accountId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(accountId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Additional utilities
// ---------------------------------------------------------------------------

/**
 * Return BIC mapping for each bank_id in the list.
 * For admin screen and debugging purposes.
 *
 * @param bankIds - array of bank_id
 * @returns bank_id → BIC mapping object
 */
export function resolveBicsForBanks(bankIds: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of bankIds) {
    result[id] = bankIdToBic(id);
  }
  return result;
}

/**
 * Return list of registered BICs (for test and simulator).
 *
 * @returns array of BIC codes
 */
export function getRegisteredBics(): string[] {
  return Object.keys(BIC_TO_BANK_ID);
}
