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
// BIC ↔ bank_id mapping (fixed mock values)
// ---------------------------------------------------------------------------

/**
 * BIC code → internal bank_id mapping table.
 * Fixed values in the mock implementation. In production, refer to the DB or an external directory.
 */
const BIC_TO_BANK_ID: Record<string, string> = {
  // Domestic participating banks in Japan
  MHCBJPJT: "001", // Nagaoka Bank
  BOTKJPJT: "002", // Owari Bank
  SMTBJPJT: "003", // Kaga Bank
  RZSBJPJT: "004", // Hizen Bank
  HANGJPJT: "005", // Satsuma Bank
  SMBCJPJT: "006", // Echigo Bank
  YUKBJPJT: "007", // Sanuki Bank (international BIC)
  SFJPJPJT: "008", // Bingo Bank
  AOZOBJPJT: "009", // Awaji Bank
  OKHBJPJT: "010", // Hyuga Bank (tentative)
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
// Lane → message format selection
// ---------------------------------------------------------------------------

/**
 * Selects the message format from the lane type and whether the transaction is cross-border.
 *
 * Selection rules:
 * - Cross-border transactions always use ISO20022 (pacs.008)
 * - HIGH_VALUE lane uses ISO20022 (large-value settlement regulation compliance)
 * - EXPRESS / RTP use ZENITH_NATIVE (low-latency priority)
 * - STANDARD uses ZENITH_NATIVE
 * - BULK / DEFERRED use ZENGIN_FIXED (Zengin batch compatibility)
 * - HTLC uses ZENITH_NATIVE (carries hash-lock information natively)
 *
 * @param lane - lane type
 * @param isCrossBorder - whether the transaction is cross-border
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
 * Returns the internal bank_id from a BIC code.
 * Returns null if not present in the mapping.
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
 * Returns the BIC code from an internal bank_id.
 * Generates and returns a dummy BIC if not present in the mapping.
 *
 * @param bankId - internal bank_id (e.g. '001', '002')
 * @returns SWIFT BIC code (8 characters)
 */
export function bankIdToBic(bankId: string): string {
  if (!bankId) return "UNKNJPJT";
  const bic = BANK_ID_TO_BIC[bankId];
  if (bic) return bic;
  // If unregistered: generate a dummy BIC in ZXXXXXXT format
  // X = embeds the digits of bankId (up to 4 characters)
  const paddedId = bankId.slice(0, 4).padStart(4, "0");
  return `Z${paddedId}JPJT`;
}

// ---------------------------------------------------------------------------
// Domestic / cross-border determination
// ---------------------------------------------------------------------------

/**
 * Determine whether a transfer is cross-border from the originating and destination bank_id.
 *
 * Determination rules:
 * - Both are numeric bank_id of 3 digits or fewer → domestic transaction (false)
 * - Either one contains "-" (e.g. JPMC-US, DEUT-DE) → cross-border (true)
 * - One is empty or unregistered → conservatively treated as cross-border (true)
 *
 * @param payerBankId - originating bank_id
 * @param payeeBankId - destination bank_id
 * @returns true if cross-border
 */
export function isCrossBorderTransfer(payerBankId: string, payeeBankId: string): boolean {
  if (!payerBankId || !payeeBankId) return true;

  const isDomestic = (id: string): boolean => /^\d{1,3}$/.test(id);

  // Domestic only when both are domestic bank_id (1 to 3 digit numbers)
  if (isDomestic(payerBankId) && isDomestic(payeeBankId)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Hash the proxy-resolved account information
// ---------------------------------------------------------------------------

/**
 * Hash the proxy-resolved account information with SHA-256.
 * Uses the Web Crypto API (globalThis.crypto).
 *
 * Purpose: avoid holding account numbers in plaintext; compare and reference by hash value.
 *
 * @param accountId - plaintext account number (e.g. '0010001234')
 * @returns hexadecimal string of the SHA-256 hash (64 characters)
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
 * Return the BIC mapping for each entry from a list of bank_id.
 * For the admin console and debugging.
 *
 * @param bankIds - array of bank_id
 * @returns mapping object of bank_id → BIC
 */
export function resolveBicsForBanks(bankIds: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of bankIds) {
    result[id] = bankIdToBic(id);
  }
  return result;
}

/**
 * Return the list of registered BICs (for tests and the simulator).
 *
 * @returns array of BIC codes
 */
export function getRegisteredBics(): string[] {
  return Object.keys(BIC_TO_BANK_ID);
}
