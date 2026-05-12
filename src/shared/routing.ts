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

import type { LaneType, MessageFormat } from '../types'

// ---------------------------------------------------------------------------
// BIC ↔ bank_id マッピング（モック固定値）
// ---------------------------------------------------------------------------

/**
 * BIC コード → 内部 bank_id マッピングテーブル。
 * モック実装では固定値。本番では DB または外部ディレクトリを参照する。
 */
const BIC_TO_BANK_ID: Record<string, string> = {
  // 日本国内参加銀行
  'MHCBJPJT': '001',   // 長岡銀行
  'BOTKJPJT': '002',   // 尾張銀行
  'SMTBJPJT': '003',   // 加賀銀行
  'RZSBJPJT': '004',   // 肥前銀行
  'HANGJPJT': '005',   // 薩摩銀行
  'SMBCJPJT': '006',   // 越後銀行
  'YUKBJPJT': '007',   // 讃岐銀行（国際BIC）
  'SFJPJPJT': '008',   // 備後銀行
  'AOZOBJPJT': '009',  // 淡路銀行
  'OKHBJPJT': '010',   // 日向銀行（仮）
  'HOKBJPJT': '011',
  'TOHOJPJT': '012',
  'CHUBJPJT': '013',
  'HOKRJPJT': '014',
  'HIRBJPJT': '015',
  'SHKBJPJT': '016',
  'FUKBJPJT': '017',
  'KUMBJPJT': '018',   // 大隅銀行
  'KAGBJPJT': '019',
  'OKNBJPJT': '020',
  // 海外主要銀行（クロスボーダー用）
  'CHASUS33': 'JPMC-US',   // JP Morgan Chase (US)
  'CITIUS33': 'CITI-US',   // Citibank (US)
  'BOFAUS3N': 'BOFA-US',   // Bank of America (US)
  'DEUTDEDB': 'DEUT-DE',   // Deutsche Bank (DE)
  'BNPAFRPP': 'BNPA-FR',   // BNP Paribas (FR)
  'HSBCHKHH': 'HSBC-HK',   // HSBC Hong Kong
}

/** bank_id → BIC マッピングテーブル（BIC_TO_BANK_ID の逆引き） */
const BANK_ID_TO_BIC: Record<string, string> = Object.fromEntries(
  Object.entries(BIC_TO_BANK_ID).map(([bic, id]) => [id, bic])
)

// ---------------------------------------------------------------------------
// レーン → メッセージフォーマット選択
// ---------------------------------------------------------------------------

/**
 * レーンタイプとクロスボーダー有無からメッセージフォーマットを選択する。
 *
 * 選択ルール:
 * - クロスボーダー取引は常に ISO20022 (pacs.008)
 * - HIGH_VALUE レーンは ISO20022 (大口資金決済規制対応)
 * - EXPRESS / RTP は ZENITH_NATIVE (低レイテンシ優先)
 * - STANDARD は ZENITH_NATIVE
 * - BULK / DEFERRED は ZENGIN_FIXED (全銀協バッチ互換)
 * - HTLC は ZENITH_NATIVE (ハッシュロック情報をネイティブで運搬)
 *
 * @param lane - レーンタイプ
 * @param isCrossBorder - クロスボーダー取引かどうか
 * @returns MessageFormat
 */
export function selectMessageFormat(lane: LaneType, isCrossBorder: boolean): MessageFormat {
  if (isCrossBorder) {
    return 'ISO20022'
  }

  switch (lane) {
    case 'HIGH_VALUE':
      return 'ISO20022'

    case 'BULK':
    case 'DEFERRED':
      return 'ZENGIN_FIXED'

    case 'EXPRESS':
    case 'STANDARD':
    case 'RTP':
    case 'HTLC':
    default:
      return 'ZENITH_NATIVE'
  }
}

// ---------------------------------------------------------------------------
// BIC ↔ bank_id 変換
// ---------------------------------------------------------------------------

/**
 * BIC コードから内部 bank_id を返す。
 * マッピングに存在しない場合は null を返す。
 *
 * @param bic - SWIFT BIC コード (8文字または11文字)
 * @returns 内部 bank_id または null
 */
export function bicToBankId(bic: string): string | null {
  if (!bic) return null
  // 11文字BIC（支店コード付き）は8文字に正規化して検索
  const normalizedBic = bic.length === 11 ? bic.substring(0, 8) : bic
  return BIC_TO_BANK_ID[normalizedBic.toUpperCase()] ?? null
}

/**
 * 内部 bank_id から BIC コードを返す。
 * マッピングに存在しない場合はダミー BIC を生成して返す。
 *
 * @param bankId - 内部 bank_id (例: '001', '002')
 * @returns SWIFT BIC コード (8文字)
 */
export function bankIdToBic(bankId: string): string {
  if (!bankId) return 'UNKNJPJT'
  const bic = BANK_ID_TO_BIC[bankId]
  if (bic) return bic
  // 未登録の場合: ZXXXXXXT 形式でダミーBICを生成
  // X = bankId の数字を埋め込む（最大4文字）
  const paddedId = bankId.slice(0, 4).padStart(4, '0')
  return `Z${paddedId}JPJT`
}

// ---------------------------------------------------------------------------
// 国内/クロスボーダー判定
// ---------------------------------------------------------------------------

/**
 * 送金元と送金先の bank_id からクロスボーダー取引か判定する。
 *
 * 判定ルール:
 * - 両方が 3桁以下の数値 bank_id → 国内取引 (false)
 * - いずれか一方が "-" を含む（例: JPMC-US, DEUT-DE）→ クロスボーダー (true)
 * - 一方が空文字または未登録 → 保守的にクロスボーダーと判定 (true)
 *
 * @param payerBankId - 送金元 bank_id
 * @param payeeBankId - 送金先 bank_id
 * @returns クロスボーダーなら true
 */
export function isCrossBorderTransfer(payerBankId: string, payeeBankId: string): boolean {
  if (!payerBankId || !payeeBankId) return true

  const isDomestic = (id: string): boolean => /^\d{1,3}$/.test(id)

  // 両方が国内 bank_id（1〜3桁の数字）の場合のみ国内
  if (isDomestic(payerBankId) && isDomestic(payeeBankId)) {
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// プロキシ解決済みアカウント情報ハッシュ化
// ---------------------------------------------------------------------------

/**
 * プロキシ解決済みアカウント情報を SHA-256 でハッシュ化する。
 * Web Crypto API (globalThis.crypto) を使用。
 *
 * 用途: 口座番号を平文で保持せず、ハッシュ値で比較・参照する。
 *
 * @param accountId - 平文の口座番号（例: '0010001234'）
 * @returns SHA-256 ハッシュの16進数文字列 (64文字)
 */
export async function hashAccountId(accountId: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(accountId)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// 追加ユーティリティ
// ---------------------------------------------------------------------------

/**
 * bank_id の一覧から各行の BIC マッピングを返す。
 * 管理画面やデバッグ用途。
 *
 * @param bankIds - bank_id の配列
 * @returns bank_id → BIC のマッピングオブジェクト
 */
export function resolveBicsForBanks(bankIds: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const id of bankIds) {
    result[id] = bankIdToBic(id)
  }
  return result
}

/**
 * 登録済み BIC 一覧を返す（テスト・シミュレーター用）。
 *
 * @returns BIC コードの配列
 */
export function getRegisteredBics(): string[] {
  return Object.keys(BIC_TO_BANK_ID)
}

// ---------------------------------------------------------------------------
// Weighted shortest-path routing (Dijkstra) for cross-border correspondent chains
// ---------------------------------------------------------------------------

export interface CorrespondentEdge {
  /** Originating bank_id. */
  from: string
  /** Destination bank_id. */
  to: string
  /** Fee charged for using this hop, in minor units of the settlement ccy. */
  fee: number
  /** Latency cost in seconds (or arbitrary units; consistent across the graph). */
  latency: number
}

export interface CorrespondentPath {
  path: string[]
  totalFee: number
  totalLatency: number
  cost: number
}

/**
 * Dijkstra's algorithm over a correspondent-bank graph. Each edge has a fee
 * and a latency, combined into a scalar cost via `weight = feeWeight·fee +
 * latencyWeight·latency`. Returns the lowest-cost path from `source` to
 * `target`, or `null` if unreachable.
 *
 * Uses a sorted-array priority queue (O((V+E) log V) — fine for the few-dozen-
 * bank correspondent graphs typical in cross-border routing; a heap-based PQ
 * would only matter at thousands of nodes).
 */
export function findCorrespondentPath(
  edges: CorrespondentEdge[],
  source: string,
  target: string,
  weights: { fee: number; latency: number } = { fee: 1, latency: 1 },
): CorrespondentPath | null {
  const adj = new Map<string, CorrespondentEdge[]>()
  const nodes = new Set<string>()
  for (const e of edges) {
    nodes.add(e.from)
    nodes.add(e.to)
    const list = adj.get(e.from)
    if (list) list.push(e)
    else adj.set(e.from, [e])
  }
  if (!nodes.has(source) || !nodes.has(target)) return null

  const dist = new Map<string, number>()
  const prev = new Map<string, string | null>()
  const fee = new Map<string, number>()
  const latency = new Map<string, number>()
  for (const n of nodes) {
    dist.set(n, Infinity)
    prev.set(n, null)
    fee.set(n, 0)
    latency.set(n, 0)
  }
  dist.set(source, 0)

  const pq: Array<{ node: string; d: number }> = [{ node: source, d: 0 }]
  const settled = new Set<string>()

  while (pq.length > 0) {
    pq.sort((a, b) => a.d - b.d)
    const { node: u } = pq.shift()!
    if (settled.has(u)) continue
    settled.add(u)
    if (u === target) break

    for (const e of adj.get(u) ?? []) {
      if (settled.has(e.to)) continue
      const w = weights.fee * e.fee + weights.latency * e.latency
      const alt = (dist.get(u) ?? Infinity) + w
      if (alt < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, alt)
        prev.set(e.to, u)
        fee.set(e.to, (fee.get(u) ?? 0) + e.fee)
        latency.set(e.to, (latency.get(u) ?? 0) + e.latency)
        pq.push({ node: e.to, d: alt })
      }
    }
  }

  if ((dist.get(target) ?? Infinity) === Infinity) return null

  const path: string[] = []
  let cur: string | null = target
  while (cur !== null) {
    path.push(cur)
    cur = prev.get(cur) ?? null
  }
  path.reverse()

  return {
    path,
    totalFee: fee.get(target) ?? 0,
    totalLatency: latency.get(target) ?? 0,
    cost: dist.get(target) ?? Infinity,
  }
}
