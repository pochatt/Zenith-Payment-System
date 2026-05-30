/**
 * @file format_converter.ts — Legacy Zengin format ↔ New payment format converter.
 *
 * Bridges the existing flat fixed-length Zengin電文フォーマット to the
 * new API-first payment initiation format used by Zenith Coordinator.
 *
 * Background (Zengin Future Vision SG 2026-03, 論点5):
 *   "既存フォーマットとの互換性を確保しつつ、国際標準（ISO20022）に準拠可能な
 *    設計。メッセージ設計は拡張性を重視。" (section 3.(3) 設計思想 c)
 *
 * ## コード体系の違いについて（重要）
 *
 * ### 銀行コード桁数
 * | 系統               | 桁数 | 例     |
 * |--------------------|------|--------|
 * | 全銀フォーマット    | 4桁  | `0001` |
 * | zenith-mock DB     | 3桁  | `001`  |
 *
 * zenith-mock's `Participants.bank_id` differs by 1 digit from actual Zenginkyo bank codes.
 * 変換時は `zenginCodeToMockBankId` / `mockBankIdToZenginCode` を必ず使うこと。
 *
 * ### 支店コード
 * 全銀フォーマットは仕向・被仕向ともに3桁支店コードを持つ。
 * zenith-mock has no branch concept; `BankAccounts` manages only account IDs without branch information.
 * Therefore, branch codes are treated as "retained as information but not used for DB matching" during conversion.
 *
 * ### 口座識別子
 * | 系統               | 形式                    | 例                    |
 * |--------------------|-------------------------|-----------------------|
 * | 全銀フォーマット    | 7桁数字口座番号          | `1234567`             |
 * | zenith-mock        | `h:{UUID}` ハッシュ形式 | `h:acct-001-0001`     |
 *
 * 全銀口座番号から account_hash への変換は zenith-mock の bank-side にしか
 * 知識がない（逆変換も不可）。変換器は `unresolved:` プレフィックスを付与した
 * ペンディング識別子を生成し、呼び出し元が `account-verify` エンドポイントで
 * 解決してから使用する設計とする。
 *
 * @module shared/format_converter
 */

// ---------------------------------------------------------------------------
// コード変換ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 全銀4桁銀行コード → zenith-mock 3桁 bank_id 変換。
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
  // 先頭1桁（常に '0'）を除去して3桁に
  return zenginCode.slice(1);
}

/**
 * zenith-mock 3桁 bank_id → 全銀4桁銀行コード変換。
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
 * 全銀口座番号（7桁数字）と支店コードから「未解決口座識別子」を生成する。
 *
 * この識別子は DB の `account_hash` ではなく、銀行 `account-verify` エンドポイントへの
 * 照会入力として使用するための一時的なプレースホルダー。
 * 呼び出し元が `account-verify` で解決した後、返却された `account_hash` を使用する。
 *
 * フォーマット: `unresolved:{4桁銀行コード}-{3桁支店コード}-{7桁口座番号}`
 */
export function buildUnresolvedAccountRef(
  zenginBankCode: string,
  sitenCode: string,
  kozaBango: string
): string {
  return `unresolved:${zenginBankCode}-${sitenCode}-${kozaBango.padStart(7, "0")}`;
}

/**
 * 未解決口座識別子かどうかを判定する。
 * `account-verify` を呼ぶ前に使用。
 */
export function isUnresolvedAccountRef(accountHash: string): boolean {
  return accountHash.startsWith("unresolved:");
}

// ---------------------------------------------------------------------------
// Legacy Zengin flat-format types（全銀フォーマット互換）
// ---------------------------------------------------------------------------

/**
 * Legacy Zengin電文フォーマット: 振込電文（内国為替取引）
 * 固定長フォーマットを JSON に射影した構造体。
 * Field names comply with item names in the Zenginkyo format specification document.
 *
 * 銀行コードは4桁（全銀標準）、支店コードは3桁。
 */
export interface LegacyZenginTransfer {
  /** 仕向銀行コード（全銀4桁: '0001'〜'9999'） */
  shimukeKinko: string;
  /** Originating branch code (3 digits: '001' to '999'). Not used for DB matching in zenith-mock */
  shimukeSiten: string;
  /** 被仕向銀行コード（全銀4桁: '0001'〜'9999'） */
  hishimukeKinko: string;
  /** Receiving branch code (3 digits: '001' to '999'). Not used for DB matching in zenith-mock */
  hishimukeSiten: string;
  /** 科目 ('1'=普通, '2'=当座, '4'=貯蓄) */
  kamoku: "1" | "2" | "4";
  /** Account number (7-digit numeral). Separate system from zenith-mock's account_hash */
  kozaBango: string;
  /** 受取人名（カタカナ半角, 最大48文字） */
  uketorininMei: string;
  /** Amount (yen, positive integer, maximum 10 digits) */
  kingaku: number;
  /** 振込指定日 'YYYYMMDD' */
  furikomiShiteibi: string;
  /** 依頼人コード（省略可） */
  iraininCode?: string;
  /** 依頼人名（カタカナ半角, 省略可） */
  iraininMei?: string;
  /** EDI情報（最大20文字, 省略可） */
  ediJoho?: string;
}

/** 全銀科目コード → zenith-mock 口座種別マッピング */
const KAMOKU_MAP: Record<string, string> = {
  "1": "SAVINGS", // 普通預金
  "2": "CHECKING", // 当座預金
  "4": "SAVINGS", // 貯蓄預金（zenith-mock では SAVINGS 扱い）
};

// ---------------------------------------------------------------------------
// New format types（Zenith Coordinator API）
// ---------------------------------------------------------------------------

/**
 * Zenith Coordinator API の PaymentInitiatedRequest に相当する最小構造体。
 * 完全な型は types.ts の PaymentInitiatedRequest を参照。
 *
 * `payee.account_hash` が `isUnresolvedAccountRef()` === true の場合、
 * 送信前に `account-verify` エンドポイントで解決が必要。
 */
export interface ConvertedPaymentRequest {
  txid: string;
  lane: "STANDARD" | "EXPRESS";
  amount: { value: number; currency: "JPY" };
  /** bank_id is in zenith-mock 3-digit format */
  payer: { bank_id: string; account_hash: string };
  /**
   * bank_id は zenith-mock 3桁形式。
   * account_hash が `unresolved:` プレフィックスを持つ場合は
   * `account-verify` で解決してから使用する。
   */
  payee: { bank_id: string; account_hash: string; account_name?: string };
  purpose: string;
  idempotency_key: string;
  /** 元の全銀フォーマットのEDI情報（存在する場合） */
  legacy_edi?: string;
  /** 変換元フォーマット（監査用） */
  _source_format: "ZENGIN_LEGACY";
  /**
   * 変換元の全銀コード情報（支店コード等の補足情報を保持）
   * DB 照合には使わないが、障害調査・照合用に保持する。
   */
  _zengin_meta: {
    shimukeKinko: string; // 全銀4桁
    shimukeSiten: string; // 支店3桁（DB非対応）
    hishimukeKinko: string; // 全銀4桁
    hishimukeSiten: string; // 支店3桁（DB非対応）
    kozaBango: string; // 7桁口座番号（account_hash とは別体系）
  };
}

// ---------------------------------------------------------------------------
// Converter: Legacy Zengin → New format
// ---------------------------------------------------------------------------

/**
 * 全銀フォーマットの振込電文を Zenith Coordinator API リクエスト形式に変換する。
 *
 * ## 変換規則
 *
 * | 全銀フィールド     | 変換先                           | 備考                               |
 * |--------------------|----------------------------------|------------------------------------|
 * | shimukeKinko (4桁) | payer.bank_id (3桁)              | `zenginCodeToMockBankId` で変換     |
 * | hishimukeKinko(4桁)| payee.bank_id (3桁)              | `zenginCodeToMockBankId` で変換     |
 * | shimukeSiten       | _zengin_meta のみ保持             | DB に支店概念なし                   |
 * | hishimukeSiten     | _zengin_meta のみ保持             | DB に支店概念なし                   |
 * | kozaBango (7桁数字)| payee.account_hash (unresolved:) | account-verify での解決が必要       |
 * | uketorininMei      | payee.account_name               | 名前照合の入力値                    |
 * | kingaku            | amount.value                     | 円単位                              |
 * | ediJoho            | legacy_edi                       | そのまま引き継ぎ                    |
 *
 * ## 使用例
 * ```typescript
 * const converted = convertLegacyToNew(legacy, txid, payerAccountHash)
 * if (isUnresolvedAccountRef(converted.payee.account_hash)) {
 *   // account-verify で解決してから送金
 *   const verified = await callAccountVerify(converted.payee.bank_id, converted._zengin_meta.kozaBango)
 *   converted.payee.account_hash = verified.account_hash
 * }
 * ```
 *
 * @param legacy           - 変換元の全銀フォーマット電文
 * @param txid             - 新システム側で採番した取引ID
 * @param payerAccountHash - 仕向銀行側で特定済みの送金人口座ハッシュ (`h:{UUID}` 形式)
 */
export function convertLegacyToNew(
  legacy: LegacyZenginTransfer,
  txid: string,
  payerAccountHash: string
): ConvertedPaymentRequest {
  // 銀行コード: 全銀4桁 → zenith-mock 3桁
  const payerBankId = zenginCodeToMockBankId(legacy.shimukeKinko);
  const payeeBankId = zenginCodeToMockBankId(legacy.hishimukeKinko);

  // 被仕向口座: 全銀口座番号はそのまま account_hash にできない。
  // 未解決識別子を生成し、呼び出し元が account-verify で解決する。
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
      account_hash: payeeAccountHash, // 未解決: account-verify が必要
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
// Converter: New format → Legacy Zengin（逆変換: 現行全銀システム連携用）
// ---------------------------------------------------------------------------

/**
 * Zenith Coordinator の取引情報を全銀フォーマット互換の電文に逆変換する。
 * 現行全銀システムとの併存期間中のフォールバック送信・監査用途に使用する。
 *
 * ## 注意事項
 * - 支店コード: zenith-mock に支店概念がないため、`hishimukeSiten` / `shimukeSiten`
 *   は呼び出し元が銀行側の口座マスタから取得して渡す必要がある。
 * - 口座番号: account_hash から逆引き不可のため `payeeKozaBango` を外部から受け取る。
 *
 * @param converted        - Zenith Coordinator 形式の取引情報
 * @param payeeKozaBango   - 被仕向口座番号（7桁, 銀行側で取得済み）
 * @param uketorininMei    - 受取人名（カタカナ）
 * @param furikomiShiteibi - 振込指定日 'YYYYMMDD'
 * @param payeeSitenCode   - 被仕向支店コード（3桁, 省略時 '000'）
 * @param shimukeSitenCode - 仕向支店コード（3桁, 省略時 '000'）
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
    kamoku: "1", // デフォルト: 普通預金
    kozaBango: payeeKozaBango.slice(-7).padStart(7, "0"),
    uketorininMei: toHalfWidthKatakana(uketorininMei).slice(0, 48),
    kingaku: converted.amount.value,
    furikomiShiteibi,
  };
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

/**
 * 全銀フォーマット電文の基本バリデーション。
 *
 * 銀行コードは全銀標準の4桁、支店コードは3桁を期待する。
 * zenith-mock の DB 側コード（3桁）とは異なることに注意。
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

  // 先頭が '0' であることを確認（全銀銀行コードは '0' + 3桁）
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
// ヘルパー
// ---------------------------------------------------------------------------

/** 全銀科目コードから zenith-mock 口座種別文字列を返す */
export function kamokuToAccountType(kamoku: string): string {
  return KAMOKU_MAP[kamoku] ?? "SAVINGS";
}

/** 全角カタカナ → 半角カタカナ変換（ルックアップテーブル方式） */
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
    .replace(/[^\x20-\x7E\uFF65-\uFF9F]/g, "") // ASCII + 半角カタカナ以外除去
    .trim();
}
