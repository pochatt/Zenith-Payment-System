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
// BIC ↔ bank_id mapping（モック固定値）
// ---------------------------------------------------------------------------

/**
 * BIC コード → 内部 bank_id mappingtable。
 * モックimplementationでは固定値。本番では DB または外部ディレクトリを参照する。
 */
const BIC_TO_BANK_ID: Record<string, string> = {
  // 日本国内参加bank
  MHCBJPJT: "001", // 長岡銀行
  BOTKJPJT: "002", // 尾張銀行
  SMTBJPJT: "003", // 加賀銀行
  RZSBJPJT: "004", // 肥前銀行
  HANGJPJT: "005", // 薩摩銀行
  SMBCJPJT: "006", // 越後銀行
  YUKBJPJT: "007", // 讃岐銀行（国際BIC）
  SFJPJPJT: "008", // 備後銀行
  AOZOBJPJT: "009", // 淡路銀行
  OKHBJPJT: "010", // 日向銀行（仮）
  HOKBJPJT: "011",
  TOHOJPJT: "012",
  CHUBJPJT: "013",
  HOKRJPJT: "014",
  HIRBJPJT: "015",
  SHKBJPJT: "016",
  FUKBJPJT: "017",
  KUMBJPJT: "018", // 大隅銀行
  KAGBJPJT: "019",
  OKNBJPJT: "020",
  // 海外主要bank（クロスボーダー用）
  CHASUS33: "JPMC-US", // JP Morgan Chase (US)
  CITIUS33: "CITI-US", // Citibank (US)
  BOFAUS3N: "BOFA-US", // Bank of America (US)
  DEUTDEDB: "DEUT-DE", // Deutsche Bank (DE)
  BNPAFRPP: "BNPA-FR", // BNP Paribas (FR)
  HSBCHKHH: "HSBC-HK", // HSBC Hong Kong
};

/** bank_id → BIC mappingtable（BIC_TO_BANK_ID の逆引き） */
const BANK_ID_TO_BIC: Record<string, string> = Object.fromEntries(
  Object.entries(BIC_TO_BANK_ID).map(([bic, id]) => [id, bic])
);

// ---------------------------------------------------------------------------
// lane → messageフォーマット選択
// ---------------------------------------------------------------------------

/**
 * laneタイプとクロスボーダー有無からmessageフォーマットを選択する。
 *
 * 選択ルール:
 * - クロスボーダーtransactionは常に ISO20022 (pacs.008)
 * - HIGH_VALUE laneは ISO20022 (大口資金payment規制対応)
 * - EXPRESS / RTP は ZENITH_NATIVE (低レイテンシ優先)
 * - STANDARD は ZENITH_NATIVE
 * - BULK / DEFERRED は ZENGIN_FIXED (全銀協batch互換)
 * - HTLC は ZENITH_NATIVE (hashlockinformationをネイティブで運搬)
 *
 * @param lane - laneタイプ
 * @param isCrossBorder - クロスボーダーtransactionかどうか
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
// BIC ↔ bank_id 変換
// ---------------------------------------------------------------------------

/**
 * BIC コードから内部 bank_id をreturn。
 * mappingに存在しない場合は null をreturn。
 *
 * @param bic - SWIFT BIC コード (8文字または11文字)
 * @returns 内部 bank_id または null
 */
export function bicToBankId(bic: string): string | null {
  if (!bic) return null;
  // 11文字BIC（支店コード付き）は8文字に正規化して検索
  const normalizedBic = bic.length === 11 ? bic.substring(0, 8) : bic;
  return BIC_TO_BANK_ID[normalizedBic.toUpperCase()] ?? null;
}

/**
 * 内部 bank_id から BIC コードをreturn。
 * mappingに存在しない場合はダミー BIC をgenerateしてreturn。
 *
 * @param bankId - 内部 bank_id (例: '001', '002')
 * @returns SWIFT BIC コード (8文字)
 */
export function bankIdToBic(bankId: string): string {
  if (!bankId) return "UNKNJPJT";
  const bic = BANK_ID_TO_BIC[bankId];
  if (bic) return bic;
  // 未登録の場合: ZXXXXXXT 形式でダミーBICをgenerate
  // X = bankId の数字を埋め込む（最大4文字）
  const paddedId = bankId.slice(0, 4).padStart(4, "0");
  return `Z${paddedId}JPJT`;
}

// ---------------------------------------------------------------------------
// 国内/クロスボーダー判定
// ---------------------------------------------------------------------------

/**
 * payerとfund transfer先の bank_id からクロスボーダーtransactionか判定する。
 *
 * 判定ルール:
 * - 両方が 3桁以下の数値 bank_id → 国内transaction (false)
 * - いずれか一方が "-" を含む（例: JPMC-US, DEUT-DE）→ クロスボーダー (true)
 * - 一方が空文字または未登録 → 保守的にクロスボーダーと判定 (true)
 *
 * @param payerBankId - payer bank_id
 * @param payeeBankId - fund transfer先 bank_id
 * @returns クロスボーダーなら true
 */
export function isCrossBorderTransfer(payerBankId: string, payeeBankId: string): boolean {
  if (!payerBankId || !payeeBankId) return true;

  const isDomestic = (id: string): boolean => /^\d{1,3}$/.test(id);

  // 両方が国内 bank_id（1〜3桁の数字）の場合のみ国内
  if (isDomestic(payerBankId) && isDomestic(payeeBankId)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// プロキシ解paymentみアカウントinformationhash化
// ---------------------------------------------------------------------------

/**
 * プロキシ解paymentみアカウントinformationを SHA-256 でhash化する。
 * Web Crypto API (globalThis.crypto) を使用。
 *
 * 用途: account numberを平文で保持せず、hash値で比較・参照する。
 *
 * @param accountId - 平文のaccount number（例: '0010001234'）
 * @returns SHA-256 ハッシュの16進数文字列 (64文字)
 */
export async function hashAccountId(accountId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(accountId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// 追加ユーティリティ
// ---------------------------------------------------------------------------

/**
 * bank_id の一覧から各行の BIC mappingをreturn。
 * 管理画面やfor debugging途。
 *
 * @param bankIds - bank_id のarray
 * @returns bank_id → BIC のマッピングオブジェクト
 */
export function resolveBicsForBanks(bankIds: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of bankIds) {
    result[id] = bankIdToBic(id);
  }
  return result;
}

/**
 * 登録済み BIC 一覧をreturn（test・シミュレーター用）。
 *
 * @returns BIC コードの配列
 */
export function getRegisteredBics(): string[] {
  return Object.keys(BIC_TO_BANK_ID);
}
