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
 * The converter handles the migration path from the current Zengin format
 * (katakana name, fixed-length fields) to the new structured JSON format,
 * allowing participating banks to connect without a full system rewrite.
 *
 * @module shared/format_converter
 */

// ---------------------------------------------------------------------------
// Legacy Zengin flat-format types (全銀フォーマット互換)
// ---------------------------------------------------------------------------

/**
 * Legacy Zengin電文フォーマット: 振込電文（内国為替取引）
 * 固定長フォーマットを JSON に射影した構造体。
 * フィールド名は全銀協フォーマット仕様書の項目名に準拠。
 */
export interface LegacyZenginTransfer {
  /** 仕向銀行コード (4桁) */
  shimukeKinko: string
  /** 仕向支店コード (3桁) */
  shimukeSiten: string
  /** 被仕向銀行コード (4桁) */
  hishimukeKinko: string
  /** 被仕向支店コード (3桁) */
  hishimukeSiten: string
  /** 科目 ('1'=普通, '2'=当座, '4'=貯蓄) */
  kamoku: '1' | '2' | '4'
  /** 口座番号 (7桁) */
  kozaBango: string
  /** 受取人名（カタカナ, 半角, 最大48文字） */
  uketorininMei: string
  /** 金額（円, 最大10桁） */
  kingaku: number
  /** 振込指定日 'YYYYMMDD' */
  furikomiShiteibi: string
  /** 依頼人コード（省略可） */
  iraininCode?: string
  /** 依頼人名（カタカナ, 半角） */
  iraininMei?: string
  /** EDI情報（最大20文字, 省略可） */
  ediJoho?: string
}

/** 全銀科目コード → 口座種別マッピング */
const KAMOKU_MAP: Record<string, string> = {
  '1': 'SAVINGS',    // 普通預金
  '2': 'CHECKING',   // 当座預金
  '4': 'SAVINGS',    // 貯蓄預金（モックではSAVINGS扱い）
}

// ---------------------------------------------------------------------------
// New format types (Zenith Coordinator API)
// ---------------------------------------------------------------------------

/**
 * Zenith Coordinator API の PaymentInitiatedRequest に相当する最小構造体。
 * 完全な型は types.ts の PaymentInitiatedRequest を参照。
 */
export interface ConvertedPaymentRequest {
  txid: string
  lane: 'STANDARD' | 'EXPRESS'
  amount: { value: number; currency: 'JPY' }
  payer: { bank_id: string; account_hash: string }
  payee: { bank_id: string; account_hash: string; account_name?: string }
  purpose: string
  idempotency_key: string
  /** 元の全銀フォーマットから引き継いだEDI情報（存在する場合） */
  legacy_edi?: string
  /** 変換元のフォーマットバージョン（監査用） */
  _source_format: 'ZENGIN_LEGACY'
}

// ---------------------------------------------------------------------------
// Converter: Legacy Zengin → New format
// ---------------------------------------------------------------------------

/**
 * 全銀フォーマットの振込電文を Zenith Coordinator API リクエスト形式に変換する。
 *
 * 変換規則:
 * - 銀行コード: `${kinko}` → bank_id として使用
 * - 口座番号: `${hishimukeKinko}-${hishimukeSiten}-${kozaBango}` を SHA256せず
 *   プレフィックス付き文字列として account_hash に格納（モック: 実運用では銀行側でハッシュ化）
 * - 金額: 円単位のまま amount.value に設定
 * - 受取人名: payee.account_name に格納（名前照合の入力値として使用）
 * - EDI情報: legacy_edi フィールドに引き継ぎ
 *
 * @param legacy  - 変換元の全銀フォーマット電文
 * @param txid    - 新システム側で採番した取引ID
 * @param payerAccountHash - 仕向銀行側で特定済みの送金人口座ハッシュ
 * @returns Zenith Coordinator API 形式のリクエストオブジェクト
 */
export function convertLegacyToNew(
  legacy: LegacyZenginTransfer,
  txid: string,
  payerAccountHash: string,
): ConvertedPaymentRequest {
  // 被仕向口座ハッシュ: 銀行コード+支店+口座番号 を識別子として構成
  // 実運用では被仕向銀行が account_hash を管理するが、変換時点では
  // 全銀フォーマット由来の識別子をそのまま使用し、銀行側で解決する
  const payeeAccountHash = `legacy:${legacy.hishimukeKinko}-${legacy.hishimukeSiten}-${legacy.kozaBango}`

  return {
    txid,
    lane: 'STANDARD',
    amount: { value: legacy.kingaku, currency: 'JPY' },
    payer: {
      bank_id: legacy.shimukeKinko,
      account_hash: payerAccountHash,
    },
    payee: {
      bank_id: legacy.hishimukeKinko,
      account_hash: payeeAccountHash,
      account_name: normalizeKatakana(legacy.uketorininMei),
    },
    purpose: 'P2P',
    idempotency_key: `LEGACY-${txid}`,
    legacy_edi: legacy.ediJoho,
    _source_format: 'ZENGIN_LEGACY',
  }
}

// ---------------------------------------------------------------------------
// Converter: New format → Legacy Zengin (逆変換: 現行全銀システム連携用)
// ---------------------------------------------------------------------------

/**
 * Zenith Coordinator の取引情報を全銀フォーマット互換の電文に逆変換する。
 * 現行全銀システムとの併存期間中、旧システム側のサブクリアリングへの
 * フォールバック送信や、監査・照合用の電文再生成に使用する。
 *
 * @param converted - Zenith Coordinator 形式の取引情報
 * @param payeeKozaBango - 被仕向口座番号（銀行側から取得済み）
 * @param uketorininMei - 受取人名（カタカナ正規化済み）
 * @returns 全銀フォーマット互換の電文オブジェクト
 */
export function convertNewToLegacy(
  converted: Pick<ConvertedPaymentRequest, 'payer' | 'payee' | 'amount'>,
  payeeKozaBango: string,
  uketorininMei: string,
  furikomiShiteibi: string,
): Omit<LegacyZenginTransfer, 'shimukeSiten' | 'hishimukeSiten'> & { shimukeSiten: string; hishimukeSiten: string } {
  return {
    shimukeKinko: converted.payer.bank_id.padStart(4, '0'),
    shimukeSiten: '000',   // 支店コードは銀行側で解決
    hishimukeKinko: converted.payee.bank_id.padStart(4, '0'),
    hishimukeSiten: '000', // 支店コードは銀行側で解決
    kamoku: '1',           // デフォルト: 普通預金
    kozaBango: payeeKozaBango.slice(-7).padStart(7, '0'),
    uketorininMei: toHalfWidthKatakana(uketorininMei).slice(0, 48),
    kingaku: converted.amount.value,
    furikomiShiteibi,
  }
}

// ---------------------------------------------------------------------------
// Zengin フォーマット検証
// ---------------------------------------------------------------------------

/**
 * 全銀フォーマット電文の基本バリデーション。
 * @returns ok=true の場合は変換可能。ok=false の場合は errors に理由を格納。
 */
export function validateLegacyFormat(legacy: LegacyZenginTransfer): { ok: boolean; errors: string[] } {
  const errors: string[] = []

  if (!/^\d{4}$/.test(legacy.shimukeKinko))    errors.push('shimukeKinko must be 4 digits')
  if (!/^\d{3}$/.test(legacy.shimukeSiten))     errors.push('shimukeSiten must be 3 digits')
  if (!/^\d{4}$/.test(legacy.hishimukeKinko))   errors.push('hishimukeKinko must be 4 digits')
  if (!/^\d{3}$/.test(legacy.hishimukeSiten))   errors.push('hishimukeSiten must be 3 digits')
  if (!['1', '2', '4'].includes(legacy.kamoku)) errors.push('kamoku must be 1, 2, or 4')
  if (!/^\d{1,7}$/.test(legacy.kozaBango))      errors.push('kozaBango must be 1-7 digits')
  if (legacy.uketorininMei.length === 0)         errors.push('uketorininMei is required')
  if (legacy.uketorininMei.length > 48)          errors.push('uketorininMei must be ≤ 48 chars')
  if (legacy.kingaku <= 0)                       errors.push('kingaku must be positive')
  if (legacy.kingaku > 9_999_999_999)            errors.push('kingaku must be < 10,000,000,000')
  if (!/^\d{8}$/.test(legacy.furikomiShiteibi)) errors.push('furikomiShiteibi must be YYYYMMDD')

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// ヘルパー: カタカナ正規化
// ---------------------------------------------------------------------------

/** 全角カタカナ → 半角カタカナ変換 */
function toHalfWidthKatakana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, ch => {
    return String.fromCharCode(ch.charCodeAt(0) - 0x60)
  }).replace(/\u30FC/g, '\uFF70')  // 長音符
}

/** 半角カタカナを正規化（スペース統一・制御文字除去） */
function normalizeKatakana(str: string): string {
  return str
    .replace(/\u3000/g, ' ')    // 全角スペース → 半角
    .replace(/[^\x20-\x7E\uFF65-\uFF9F]/g, '')  // ASCII + 半角カタカナ以外除去
    .trim()
}

/** 全銀科目コードから口座種別文字列を返す */
export function kamokuToAccountType(kamoku: string): string {
  return KAMOKU_MAP[kamoku] ?? 'SAVINGS'
}
