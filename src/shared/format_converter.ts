/**
 * @file format_converter.ts — Legacy Zengin format ↔ New payment format converter.
 *
 * Bridges the existing flat fixed-length Zengin message format to the
 * new API-first payment initiation format used by Zenith Coordinator.
 *
 * Background (Zengin Future Vision SG 2026-03, topic 5):
 *   "A design that ensures compatibility with the existing format while
 *    being able to conform to the international standard (ISO20022). Message
 *    design emphasizes extensibility." (section 3.(3) design philosophy c)
 *
 * ## About the differences in code systems (important)
 *
 * ### Bank code digit count
 * | System              | Digits | Example |
 * |--------------------|------|--------|
 * | Zengin format       | 4 digits | `0001` |
 * | zenith-mock DB     | 3 digits | `001`  |
 *
 * zenith-mock's `Participants.bank_id` differs by one digit from the actual Zengin bank code.
 * Always use `zenginCodeToMockBankId` / `mockBankIdToZenginCode` when converting.
 *
 * ### Branch code
 * The Zengin format has a 3-digit branch code for both originating and destination sides.
 * zenith-mock has no concept of branches, and `BankAccounts` manages only branchless account IDs.
 * Therefore the branch code is treated as "retained as information but not used for DB matching" during conversion.
 *
 * ### Account identifier
 * | System              | Format                  | Example               |
 * |--------------------|-------------------------|-----------------------|
 * | Zengin format       | 7-digit numeric account number | `1234567`     |
 * | zenith-mock        | `h:{UUID}` hash format  | `h:acct-001-0001`     |
 *
 * Conversion from a Zengin account number to an account_hash is known only to
 * zenith-mock's bank-side (and the reverse conversion is also impossible). The converter
 * generates a pending identifier with an `unresolved:` prefix, and the design requires
 * the caller to resolve it via the `account-verify` endpoint before use.
 *
 * @module shared/format_converter
 */

// ---------------------------------------------------------------------------
// Code conversion utilities
// ---------------------------------------------------------------------------

/**
 * Convert a 4-digit Zengin bank code → zenith-mock 3-digit bank_id.
 *
 * Since the leading digit of a Zengin code is always '0', simply strip the leading digit to make it 3 digits.
 * Example: '0001' → '001', '0005' → '005', '0010' → '010'
 *
 * @throws {Error} if the input is not a 4-digit number
 */
export function zenginCodeToMockBankId(zenginCode: string): string {
  if (!/^\d{4}$/.test(zenginCode)) {
    throw new Error(`Invalid zengin bank code: "${zenginCode}" (must be 4 digits)`);
  }
  // Strip the leading digit (always '0') to make it 3 digits
  return zenginCode.slice(1);
}

/**
 * Convert a zenith-mock 3-digit bank_id → 4-digit Zengin bank code.
 *
 * Example: '001' → '0001', '010' → '0010'
 *
 * @throws {Error} if the input is not a 3-digit number
 */
export function mockBankIdToZenginCode(bankId: string): string {
  if (!/^\d{3}$/.test(bankId)) {
    throw new Error(`Invalid mock bank_id: "${bankId}" (must be 3 digits)`);
  }
  return "0" + bankId;
}

/**
 * Generate an "unresolved account identifier" from a Zengin account number (7-digit number) and a branch code.
 *
 * This identifier is not the DB's `account_hash` but a temporary placeholder
 * used as the lookup input to the bank's `account-verify` endpoint.
 * After the caller resolves it via `account-verify`, use the returned `account_hash`.
 *
 * Format: `unresolved:{4-digit bank code}-{3-digit branch code}-{7-digit account number}`
 */
export function buildUnresolvedAccountRef(
  zenginBankCode: string,
  sitenCode: string,
  kozaBango: string
): string {
  return `unresolved:${zenginBankCode}-${sitenCode}-${kozaBango.padStart(7, "0")}`;
}

/**
 * Determine whether this is an unresolved account identifier.
 * Used before calling `account-verify`.
 */
export function isUnresolvedAccountRef(accountHash: string): boolean {
  return accountHash.startsWith("unresolved:");
}

// ---------------------------------------------------------------------------
// Legacy Zengin flat-format types (Zengin format compatible)
// ---------------------------------------------------------------------------

/**
 * Legacy Zengin message format: transfer message (domestic exchange transaction)
 * A struct projecting the fixed-length format into JSON.
 * Field names follow the item names in the Zengin Association format specification.
 *
 * Bank code is 4 digits (Zengin standard), branch code is 3 digits.
 */
export interface LegacyZenginTransfer {
  /** Originating bank code (Zengin 4 digits: '0001'–'9999') */
  shimukeKinko: string;
  /** Originating branch code (3 digits: '001'–'999'). Not used for DB matching in zenith-mock */
  shimukeSiten: string;
  /** Destination bank code (Zengin 4 digits: '0001'–'9999') */
  hishimukeKinko: string;
  /** Destination branch code (3 digits: '001'–'999'). Not used for DB matching in zenith-mock */
  hishimukeSiten: string;
  /** Account type ('1'=ordinary, '2'=current, '4'=savings) */
  kamoku: "1" | "2" | "4";
  /** Account number (7-digit number). A different system from zenith-mock's account_hash */
  kozaBango: string;
  /** Recipient name (half-width katakana, max 48 characters) */
  uketorininMei: string;
  /** Amount (yen, positive integer, max 10 digits) */
  kingaku: number;
  /** Designated transfer date 'YYYYMMDD' */
  furikomiShiteibi: string;
  /** Requester code (optional) */
  iraininCode?: string;
  /** Requester name (half-width katakana, optional) */
  iraininMei?: string;
  /** EDI information (max 20 characters, optional) */
  ediJoho?: string;
}

/** Zengin account-type code → zenith-mock account type mapping */
const KAMOKU_MAP: Record<string, string> = {
  "1": "SAVINGS", // Ordinary deposit account
  "2": "CHECKING", // Current account
  "4": "SAVINGS", // Savings deposit account (treated as SAVINGS in zenith-mock)
};

// ---------------------------------------------------------------------------
// New format types (Zenith Coordinator API)
// ---------------------------------------------------------------------------

/**
 * Minimal struct corresponding to the Zenith Coordinator API's PaymentInitiatedRequest.
 * See PaymentInitiatedRequest in types.ts for the complete type.
 *
 * When `payee.account_hash` has `isUnresolvedAccountRef()` === true,
 * it must be resolved via the `account-verify` endpoint before sending.
 */
export interface ConvertedPaymentRequest {
  txid: string;
  lane: "STANDARD" | "EXPRESS";
  amount: { value: number; currency: "JPY" };
  /** bank_id is in zenith-mock 3-digit format */
  payer: { bank_id: string; account_hash: string };
  /**
   * bank_id is in zenith-mock 3-digit format.
   * When account_hash has the `unresolved:` prefix,
   * resolve it via `account-verify` before use.
   */
  payee: { bank_id: string; account_hash: string; account_name?: string };
  purpose: string;
  idempotency_key: string;
  /** EDI information from the original Zengin format (if present) */
  legacy_edi?: string;
  /** Source format (for auditing) */
  _source_format: "ZENGIN_LEGACY";
  /**
   * Source Zengin code information (retains supplementary info such as branch code).
   * Not used for DB matching, but retained for incident investigation and reconciliation.
   */
  _zengin_meta: {
    shimukeKinko: string; // Zengin 4 digits
    shimukeSiten: string; // Branch 3 digits (not supported by DB)
    hishimukeKinko: string; // Zengin 4 digits
    hishimukeSiten: string; // Branch 3 digits (not supported by DB)
    kozaBango: string; // 7-digit account number (a different system from account_hash)
  };
}

// ---------------------------------------------------------------------------
// Converter: Legacy Zengin → New format
// ---------------------------------------------------------------------------

/**
 * Convert a Zengin-format transfer message into Zenith Coordinator API request format.
 *
 * ## Conversion rules
 *
 * | Zengin field       | Target                           | Notes                              |
 * |--------------------|----------------------------------|------------------------------------|
 * | shimukeKinko (4-digit) | payer.bank_id (3-digit)      | converted via `zenginCodeToMockBankId` |
 * | hishimukeKinko(4-digit)| payee.bank_id (3-digit)      | converted via `zenginCodeToMockBankId` |
 * | shimukeSiten       | retained only in _zengin_meta     | no branch concept in DB             |
 * | hishimukeSiten     | retained only in _zengin_meta     | no branch concept in DB             |
 * | kozaBango (7-digit num)| payee.account_hash (unresolved:) | requires resolution via account-verify |
 * | uketorininMei      | payee.account_name               | input value for name matching       |
 * | kingaku            | amount.value                     | in yen                              |
 * | ediJoho            | legacy_edi                       | carried over as-is                  |
 *
 * ## Usage example
 * ```typescript
 * const converted = convertLegacyToNew(legacy, txid, payerAccountHash)
 * if (isUnresolvedAccountRef(converted.payee.account_hash)) {
 *   // resolve via account-verify before transferring
 *   const verified = await callAccountVerify(converted.payee.bank_id, converted._zengin_meta.kozaBango)
 *   converted.payee.account_hash = verified.account_hash
 * }
 * ```
 *
 * @param legacy           - the source Zengin-format message
 * @param txid             - transaction ID assigned by the new system
 * @param payerAccountHash - the remitter's account hash already identified on the originating bank side (`h:{UUID}` format)
 */
export function convertLegacyToNew(
  legacy: LegacyZenginTransfer,
  txid: string,
  payerAccountHash: string
): ConvertedPaymentRequest {
  // Bank code: Zengin 4 digits → zenith-mock 3 digits
  const payerBankId = zenginCodeToMockBankId(legacy.shimukeKinko);
  const payeeBankId = zenginCodeToMockBankId(legacy.hishimukeKinko);

  // Destination account: a Zengin account number cannot be used directly as an account_hash.
  // Generate an unresolved identifier; the caller resolves it via account-verify.
  const payeeAccountHash = buildUnresolvedAccountRef(
    legacy.hishimukeKinko,
    legacy.hishimukeSiten,
    legacy.kozaBango
  );

  return {
    txid,
    lane: "STANDARD",
    amount: { value: legacy.kingaku, currency: "JPY" },
    payer: {
      bank_id: payerBankId,
      account_hash: payerAccountHash,
    },
    payee: {
      bank_id: payeeBankId,
      account_hash: payeeAccountHash, // Unresolved: account-verify required
      account_name: normalizeKatakana(legacy.uketorininMei),
    },
    purpose: "P2P",
    idempotency_key: `LEGACY-${txid}`,
    legacy_edi: legacy.ediJoho,
    _source_format: "ZENGIN_LEGACY",
    _zengin_meta: {
      shimukeKinko: legacy.shimukeKinko,
      shimukeSiten: legacy.shimukeSiten,
      hishimukeKinko: legacy.hishimukeKinko,
      hishimukeSiten: legacy.hishimukeSiten,
      kozaBango: legacy.kozaBango,
    },
  };
}

// ---------------------------------------------------------------------------
// Converter: New format → Legacy Zengin (reverse conversion: for integration with the current Zengin system)
// ---------------------------------------------------------------------------

/**
 * Reverse-convert Zenith Coordinator transaction information into a Zengin-format-compatible message.
 * Used for fallback sending and auditing during the coexistence period with the current Zengin system.
 *
 * ## Notes
 * - Branch code: since zenith-mock has no branch concept, `hishimukeSiten` / `shimukeSiten`
 *   must be obtained by the caller from the bank's account master and passed in.
 * - Account number: since account_hash cannot be reverse-looked-up, `payeeKozaBango` is received externally.
 *
 * @param converted        - transaction information in Zenith Coordinator format
 * @param payeeKozaBango   - destination account number (7 digits, obtained on the bank side)
 * @param uketorininMei    - recipient name (katakana)
 * @param furikomiShiteibi - designated transfer date 'YYYYMMDD'
 * @param payeeSitenCode   - destination branch code (3 digits, '000' if omitted)
 * @param shimukeSitenCode - originating branch code (3 digits, '000' if omitted)
 */
export function convertNewToLegacy(
  converted: Pick<ConvertedPaymentRequest, "payer" | "payee" | "amount">,
  payeeKozaBango: string,
  uketorininMei: string,
  furikomiShiteibi: string,
  payeeSitenCode: string = "000",
  shimukeSitenCode: string = "000"
): LegacyZenginTransfer {
  return {
    shimukeKinko: mockBankIdToZenginCode(converted.payer.bank_id),
    shimukeSiten: shimukeSitenCode,
    hishimukeKinko: mockBankIdToZenginCode(converted.payee.bank_id),
    hishimukeSiten: payeeSitenCode,
    kamoku: "1", // Default: ordinary deposit account
    kozaBango: payeeKozaBango.slice(-7).padStart(7, "0"),
    uketorininMei: toHalfWidthKatakana(uketorininMei).slice(0, 48),
    kingaku: converted.amount.value,
    furikomiShiteibi,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Basic validation of a Zengin-format message.
 *
 * Bank code is expected to be the Zengin-standard 4 digits, branch code 3 digits.
 * Note that this differs from zenith-mock's DB-side code (3 digits).
 */
export function validateLegacyFormat(legacy: LegacyZenginTransfer): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!/^\d{4}$/.test(legacy.shimukeKinko))
    errors.push(`shimukeKinko must be 4 digits (zengin standard), got "${legacy.shimukeKinko}"`);
  if (!/^\d{3}$/.test(legacy.shimukeSiten))
    errors.push(`shimukeSiten must be 3 digits, got "${legacy.shimukeSiten}"`);
  if (!/^\d{4}$/.test(legacy.hishimukeKinko))
    errors.push(
      `hishimukeKinko must be 4 digits (zengin standard), got "${legacy.hishimukeKinko}"`
    );
  if (!/^\d{3}$/.test(legacy.hishimukeSiten))
    errors.push(`hishimukeSiten must be 3 digits, got "${legacy.hishimukeSiten}"`);
  if (!["1", "2", "4"].includes(legacy.kamoku))
    errors.push(`kamoku must be '1' (普通), '2' (当座), or '4' (貯蓄)`);
  if (!/^\d{1,7}$/.test(legacy.kozaBango))
    errors.push(`kozaBango must be 1–7 digits, got "${legacy.kozaBango}"`);
  if (legacy.uketorininMei.length === 0) errors.push("uketorininMei is required");
  if (legacy.uketorininMei.length > 48)
    errors.push(`uketorininMei must be ≤ 48 chars, got ${legacy.uketorininMei.length}`);
  if (!Number.isInteger(legacy.kingaku) || legacy.kingaku <= 0)
    errors.push("kingaku must be a positive integer");
  if (legacy.kingaku > 9_999_999_999) errors.push("kingaku must be < 10,000,000,000");
  if (!/^\d{8}$/.test(legacy.furikomiShiteibi))
    errors.push(`furikomiShiteibi must be YYYYMMDD, got "${legacy.furikomiShiteibi}"`);

  // Verify that it starts with '0' (a Zengin bank code is '0' + 3 digits)
  if (/^\d{4}$/.test(legacy.shimukeKinko) && legacy.shimukeKinko[0] !== "0")
    errors.push(
      `shimukeKinko first digit should be '0' for domestic banks, got "${legacy.shimukeKinko[0]}"`
    );
  if (/^\d{4}$/.test(legacy.hishimukeKinko) && legacy.hishimukeKinko[0] !== "0")
    errors.push(
      `hishimukeKinko first digit should be '0' for domestic banks, got "${legacy.hishimukeKinko[0]}"`
    );

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the zenith-mock account-type string from a Zengin account-type code */
export function kamokuToAccountType(kamoku: string): string {
  return KAMOKU_MAP[kamoku] ?? "SAVINGS";
}

/** Full-width katakana → half-width katakana conversion (lookup-table approach) */
const FULL_TO_HALF_KATAKANA: Record<string, string> = {
  ァ: "ｧ",
  ア: "ｱ",
  ィ: "ｨ",
  イ: "ｲ",
  ゥ: "ｩ",
  ウ: "ｳ",
  ェ: "ｪ",
  エ: "ｴ",
  ォ: "ｫ",
  オ: "ｵ",
  カ: "ｶ",
  キ: "ｷ",
  ク: "ｸ",
  ケ: "ｹ",
  コ: "ｺ",
  サ: "ｻ",
  シ: "ｼ",
  ス: "ｽ",
  セ: "ｾ",
  ソ: "ｿ",
  タ: "ﾀ",
  チ: "ﾁ",
  ツ: "ﾂ",
  テ: "ﾃ",
  ト: "ﾄ",
  ナ: "ﾅ",
  ニ: "ﾆ",
  ヌ: "ﾇ",
  ネ: "ﾈ",
  ノ: "ﾉ",
  ハ: "ﾊ",
  ヒ: "ﾋ",
  フ: "ﾌ",
  ヘ: "ﾍ",
  ホ: "ﾎ",
  マ: "ﾏ",
  ミ: "ﾐ",
  ム: "ﾑ",
  メ: "ﾒ",
  モ: "ﾓ",
  ヤ: "ﾔ",
  ュ: "ｭ",
  ユ: "ﾕ",
  ョ: "ｮ",
  ヨ: "ﾖ",
  ャ: "ｬ",
  ラ: "ﾗ",
  リ: "ﾘ",
  ル: "ﾙ",
  レ: "ﾚ",
  ロ: "ﾛ",
  ワ: "ﾜ",
  ヲ: "ｦ",
  ン: "ﾝ",
  ヴ: "ｳﾞ",
  ッ: "ｯ",
  ガ: "ｶﾞ",
  ギ: "ｷﾞ",
  グ: "ｸﾞ",
  ゲ: "ｹﾞ",
  ゴ: "ｺﾞ",
  ザ: "ｻﾞ",
  ジ: "ｼﾞ",
  ズ: "ｽﾞ",
  ゼ: "ｾﾞ",
  ゾ: "ｿﾞ",
  ダ: "ﾀﾞ",
  ヂ: "ﾁﾞ",
  ヅ: "ﾂﾞ",
  デ: "ﾃﾞ",
  ド: "ﾄﾞ",
  バ: "ﾊﾞ",
  ビ: "ﾋﾞ",
  ブ: "ﾌﾞ",
  ベ: "ﾍﾞ",
  ボ: "ﾎﾞ",
  パ: "ﾊﾟ",
  ピ: "ﾋﾟ",
  プ: "ﾌﾟ",
  ペ: "ﾍﾟ",
  ポ: "ﾎﾟ",
};
function toHalfWidthKatakana(str: string): string {
  return str
    .replace(/[\u30A1-\u30F6\u30AC-\u30F4]/g, (ch) => FULL_TO_HALF_KATAKANA[ch] ?? ch)
    .replace(/\u30FC/g, "\uFF70") // Long vowel mark ー → ｰ
    .replace(/\u3000/g, " "); // Full-width space → half-width
}

/** Normalize a katakana string (remove control chars / non-ASCII, trim) */
function normalizeKatakana(str: string): string {
  return toHalfWidthKatakana(str)
    .replace(/[^\x20-\x7E\uFF65-\uFF9F]/g, "") // Remove everything except ASCII + half-width katakana
    .trim();
}
