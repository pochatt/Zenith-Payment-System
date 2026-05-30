/**
 * @file format_converter.ts — Legacy Zengin format ↔ New payment format converter.
 *
 * Bridges the existing flat fixed-length Zenginmessageフォーマット to the
 * new API-first payment initiation format used by Zenith Coordinator.
 *
 * Background (Zengin Future Vision SG 2026-03, 論点5):
 *   "既存フォーマットとのcompatibilityを確保しつつ、国際標準（ISO20022）に準拠可能な
 *    設計。message設計は拡張性を重視。" (section 3.(3) 設計思想 c)
 *
 * ## コード体系の違いについて（重要）
 *
 * ### bankコード桁数
 * | 系統               | 桁数 | 例     |
 * |--------------------|------|--------|
 * | 全銀フォーマット    | 4桁  | `0001` |
 * | zenith-mock DB     | 3桁  | `001`  |
 *
 * zenith-mock の `Participants.bank_id` は実際の全銀bankコードと1桁異なる。
 * 変換時は `zenginCodeToMockBankId` / `mockBankIdToZenginCode` を必ず使うこと。
 *
 * ### 支店コード
 * 全銀フォーマットは仕向・被仕向ともに3桁支店コードを持つ。
 * zenith-mock には支店概念がなく、`BankAccounts` は支店なしのaccountIDのみ管理する。
 * よって支店コードは変換時に「informationとして保持するが、DBmatchには使わない」として扱う。
 *
 * ### account識別子
 * | 系統               | 形式                    | 例                    |
 * |--------------------|-------------------------|-----------------------|
 * | 全銀フォーマット    | 7桁数字account number          | `1234567`             |
 * | zenith-mock        | `h:{UUID}` hash形式 | `h:acct-001-0001`     |
 *
 * 全銀account numberから account_hash への変換は zenith-mock の bank-side にしか
 * 知識がない（逆変換も不可）。変換器は `unresolved:` プレフィックスを付与した
 * ペンディング識別子をgenerateし、呼び出し元が `account-verify` endpointで
 * 解決してから使用する設計とする。
 *
 * @module shared/format_converter
 */

// ---------------------------------------------------------------------------
// Code conversion utilities
// ---------------------------------------------------------------------------

/**
 * Zengin 4-digit codebankコード → zenith-mock 3桁 bank_id 変換。
 *
 * 全銀コードの先頭1桁は常に '0' のため、単純に先頭を除去して3桁にする。
 * 例: '0001' → '001', '0005' → '005', '0010' → '010'
 *
 * @throws {Error} 入力が4桁数字でない場合
 */
export function zenginCodeToMockBankId(zenginCode: string): string {
  if (!/^\d{4}$/.test(zenginCode)) {
    throw new Error(`Invalid zengin bank code: "${zenginCode}" (must be 4 digits)`);
  }
  // Remove leading 1 digit (always '0') and extract 3 digits
  return zenginCode.slice(1);
}

/**
 * zenith-mock 3桁 bank_id → Zengin 4-digit codebankコード変換。
 *
 * 例: '001' → '0001', '010' → '0010'
 *
 * @throws {Error} 入力が3桁数字でない場合
 */
export function mockBankIdToZenginCode(bankId: string): string {
  if (!/^\d{3}$/.test(bankId)) {
    throw new Error(`Invalid mock bank_id: "${bankId}" (must be 3 digits)`);
  }
  return "0" + bankId;
}

/**
 * 全銀account number（7桁数字）と支店コードから「未解決account識別子」をgenerateする。
 *
 * この識別子は DB の `account_hash` ではなく、bank `account-verify` endpointへの
 * inquiry入力として使用するための一時的なプレースホルダー。
 * 呼び出し元が `account-verify` で解決した後、returnされた `account_hash` を使用する。
 *
 * フォーマット: `unresolved:{4桁bankコード}-{3桁支店コード}-{7桁account number}`
 */
export function buildUnresolvedAccountRef(
  zenginBankCode: string,
  sitenCode: string,
  kozaBango: string
): string {
  return `unresolved:${zenginBankCode}-${sitenCode}-${kozaBango.padStart(7, "0")}`;
}

/**
 * 未解決account識別子かどうかを判定する。
 * `account-verify` を呼ぶ前に使用。
 */
export function isUnresolvedAccountRef(accountHash: string): boolean {
  return accountHash.startsWith("unresolved:");
}

// ---------------------------------------------------------------------------
// Legacy Zengin flat-format types (Zengin format compatible)
// ---------------------------------------------------------------------------

/**
 * Legacy Zenginmessageフォーマット: bank transfermessage（内国為替transaction）
 * 固定長フォーマットを JSON に射影した構造体。
 * フィールド名は全銀協フォーマットspecification書の項目名に準拠。
 *
 * bankコードは4桁（全銀標準）、支店コードは3桁。
 */
export interface LegacyZenginTransfer {
  /** 仕向bankコード（Zengin 4-digit code: '0001'〜'9999'） */
  shimukeKinko: string;
  /** 仕向支店コード（3桁: '001'〜'999'）。zenith-mock では DB matchに不使用 */
  shimukeSiten: string;
  /** 被仕向bankコード（Zengin 4-digit code: '0001'〜'9999'） */
  hishimukeKinko: string;
  /** 被仕向支店コード（3桁: '001'〜'999'）。zenith-mock では DB matchに不使用 */
  hishimukeSiten: string;
  /** 科目 ('1'=Savings, '2'=当座, '4'=貯蓄) */
  kamoku: "1" | "2" | "4";
  /** account number（7桁数字）。zenith-mock の account_hash とは別体系 */
  kozaBango: string;
  /** payee名（カタカナ半角, 最大48文字） */
  uketorininMei: string;
  /** amount（円, 正の整数, 最大10桁） */
  kingaku: number;
  /** Bank transfer specified date 'YYYYMMDD' */
  furikomiShiteibi: string;
  /** 依頼人コード（省略可） */
  iraininCode?: string;
  /** 依頼人名（カタカナ半角, 省略可） */
  iraininMei?: string;
  /** EDIinformation（最大20文字, 省略可） */
  ediJoho?: string;
}

/** 全銀科目コード → zenith-mock account種別mapping */
const KAMOKU_MAP: Record<string, string> = {
  "1": "SAVINGS", // Savings account
  "2": "CHECKING", // Checking account
  "4": "SAVINGS", // Savings deposit (treated as SAVINGS in zenith-mock)
};

// ---------------------------------------------------------------------------
// New format types (Zenith Coordinator API)
// ---------------------------------------------------------------------------

/**
 * Zenith Coordinator API の PaymentInitiatedRequest に相当する最小構造体。
 * 完全な型は types.ts の PaymentInitiatedRequest を参照。
 *
 * `payee.account_hash` が `isUnresolvedAccountRef()` === true の場合、
 * send前に `account-verify` endpointで解決が必要。
 */
export interface ConvertedPaymentRequest {
  txid: string;
  lane: "STANDARD" | "EXPRESS";
  amount: { value: number; currency: "JPY" };
  /** bank_id は zenith-mock 3桁形式 */
  payer: { bank_id: string; account_hash: string };
  /**
   * bank_id は zenith-mock 3桁形式。
   * account_hash が `unresolved:` プレフィックスを持つ場合は
   * `account-verify` で解決してから使用する。
   */
  payee: { bank_id: string; account_hash: string; account_name?: string };
  purpose: string;
  idempotency_key: string;
  /** 元の全銀フォーマットのEDIinformation（存在する場合） */
  legacy_edi?: string;
  /** 変換元フォーマット（audit用） */
  _source_format: "ZENGIN_LEGACY";
  /**
   * 変換元の全銀コードinformation（支店コード等の補足informationを保持）
   * DB matchには使わないが、障害調査・match用に保持する。
   */
  _zengin_meta: {
    shimukeKinko: string; // Zengin 4-digit code
    shimukeSiten: string; // Branch 3-digit code (DB not supported)
    hishimukeKinko: string; // Zengin 4-digit code
    hishimukeSiten: string; // Branch 3-digit code (DB not supported)
    kozaBango: string; // 7-digit account number (separate system from account_hash)
  };
}

// ---------------------------------------------------------------------------
// Converter: Legacy Zengin → New format
// ---------------------------------------------------------------------------

/**
 * 全銀フォーマットのbank transfermessageを Zenith Coordinator API リクエスト形式に変換する。
 *
 * ## 変換規則
 *
 * | 全銀フィールド     | 変換先                           | remark                               |
 * |--------------------|----------------------------------|------------------------------------|
 * | shimukeKinko (4桁) | payer.bank_id (3桁)              | `zenginCodeToMockBankId` で変換     |
 * | hishimukeKinko(4桁)| payee.bank_id (3桁)              | `zenginCodeToMockBankId` で変換     |
 * | shimukeSiten       | _zengin_meta のみ保持             | DB に支店概念なし                   |
 * | hishimukeSiten     | _zengin_meta のみ保持             | DB に支店概念なし                   |
 * | kozaBango (7桁数字)| payee.account_hash (unresolved:) | account-verify での解決が必要       |
 * | uketorininMei      | payee.account_name               | 名前matchの入力値                    |
 * | kingaku            | amount.value                     | 円単位                              |
 * | ediJoho            | legacy_edi                       | そのまま引き継ぎ                    |
 *
 * ## 使用例
 * ```typescript
 * const converted = convertLegacyToNew(legacy, txid, payerAccountHash)
 * if (isUnresolvedAccountRef(converted.payee.account_hash)) {
 *   // Resolve via account-verify before fund transfer
 *   const verified = await callAccountVerify(converted.payee.bank_id, converted._zengin_meta.kozaBango)
 *   converted.payee.account_hash = verified.account_hash
 * }
 * ```
 *
 * @param legacy           - 変換元の全銀フォーマットmessage
 * @param txid             - 新システム側で採番したtransaction ID
 * @param payerAccountHash - 仕向bank側で特定済みのfund transfer人account hash (`h:{UUID}` 形式)
 */
export function convertLegacyToNew(
  legacy: LegacyZenginTransfer,
  txid: string,
  payerAccountHash: string
): ConvertedPaymentRequest {
  // Bank code: Zengin 4-digit code → zenith-mock 3-digit
  const payerBankId = zenginCodeToMockBankId(legacy.shimukeKinko);
  const payeeBankId = zenginCodeToMockBankId(legacy.hishimukeKinko);

  // Destination account: Zengin account number cannot be used directly as account_hash.
  // Generate unresolved identifier; caller resolves via account-verify
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
// Converter: New format → Legacy Zengin (reverse conversion: for current Zengin system integration)
// ---------------------------------------------------------------------------

/**
 * Reverse convert Zenith Coordinator transaction information to Zengin format compatible message.
 * Used for fallback send and audit purposes during coexistence period with current Zengin system.
 *
 * ## Caution items
 * - Branch code: Since zenith-mock has no branch concept, `hishimukeSiten` / `shimukeSiten`
 *   must be obtained from bank-side account master and passed by the caller.
 * - account number: Since reverse lookup from account_hash is not possible, `payeeKozaBango` is received from outside.
 *
 * @param converted        - Zenith Coordinator 形式のtransactioninformation
 * @param payeeKozaBango   - Destination account number (7 digits, already obtained on bank side)
 * @param uketorininMei    - Payee name (in katakana)
 * @param furikomiShiteibi - Bank transfer specified date 'YYYYMMDD'
 * @param payeeSitenCode   - Destination branch code (3 digits, default '000')
 * @param shimukeSitenCode - Originating branch code (3 digits, default '000')
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
    kamoku: "1", // Default: Savings account
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
 * Basic validation of Zengin format message.
 *
 * Bank code is expected to be 4 digits per Zengin standard, branch code 3 digits.
 * Note: differs from zenith-mock DB-side code (3 digits).
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
    errors.push(`kamoku must be '1' (Savings), '2' (当座), or '4' (貯蓄)`);
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

  // 先頭が '0' であることをconfirmation（全銀bankコードは '0' + 3桁）
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

/** 全銀科目コードから zenith-mock account種別文字列をreturn */
export function kamokuToAccountType(kamoku: string): string {
  return KAMOKU_MAP[kamoku] ?? "SAVINGS";
}

/** 全角カタカナ → 半角カタカナ変換（ルックアップtable方式） */
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
    .replace(/\u30FC/g, "\uFF70") // 長音符 ー → ｰ
    .replace(/\u3000/g, " "); // 全角スペース → 半角
}

/** カタカナ文字列を正規化（制御文字・非ASCII除去, trim） */
function normalizeKatakana(str: string): string {
  return toHalfWidthKatakana(str)
    .replace(/[^\x20-\x7E\uFF65-\uFF9F]/g, "") // Remove anything except ASCII + half-width katakana
    .trim();
}
