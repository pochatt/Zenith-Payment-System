/**
 * @file types.ts — Single source of truth for all type definitions in Zenith Mock.
 *
 * This file defines every shared type used across the Zenith Coordinator (ZC) and
 * participating Bank Mock services. All other modules MUST import from this file;
 * local type re-declarations are strictly prohibited.
 *
 * The type hierarchy covers:
 *  - Cloudflare Worker environment bindings
 *  - Monetary primitives and proof references
 *  - ZC transaction state machines (TxState, HtlcState, GtidState, etc.)
 *  - Bank-side state types (SuspenseStatus, AccountStatus, etc.)
 *  - D1 database row types for every table
 *  - ZC Core API request/response types
 *  - ZC-to-Bank Ingress API types (7 endpoints)
 *  - Cloudflare Queue message types
 *  - FinalityLog event types
 *  - Payment filter, HTLC Auth, IGS, account verification, ZEDI,
 *    ISO 20022, FATF R16, proxy directory, QR payment, RTP, rich data,
 *    cross-border, and SSE event types
 *  - Account numbering helpers and utility functions
 *
 * @module types
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker Environment Bindings
// ---------------------------------------------------------------------------

/** Cloudflare Worker environment bindings shared by ZC and Bank workers. */
export interface Env {
  /** D1 database — single shared instance for both ZC and Bank schemas. */
  DB: D1Database
  /** Cloudflare Queue for async command dispatch (state advances, retries). */
  QUEUE: Queue
  /** R2 bucket for rich-data / attachment storage. */
  R2: R2Bucket
  /** HMAC-SHA256 secret for signing ZC-to-Bank Ingress API calls. */
  ZC_HMAC_SECRET: string
  /** Base URL for Bank Ingress API calls (e.g. "http://localhost:8787"). */
  BANK_BASE_URL: string
  /** Bearer token for cron-triggered endpoints (EOD, timeout sweep). */
  CRON_SECRET: string
  /** HMAC secret for QR code signature verification. */
  QR_SECRET: string
  /** Optional secondary R2 binding (alias). */
  R2_BUCKET?: R2Bucket
  /** External FPS gateway endpoint for cross-border settlement. */
  FOREIGN_FPS_ENDPOINT?: string
}

// ---------------------------------------------------------------------------
// Common Primitives
// ---------------------------------------------------------------------------

/** Monetary amount with currency code (typically "JPY"). */
export interface Amount {
  value: number
  currency: string
}

/**
 * Bank-issued proof reference attached to a transaction after execution.
 * Each proof certifies that a debit or credit was (or was not) applied.
 */
export interface BankProofRef {
  issuer_bank_id: string
  proof_type: ProofType
  proof_id: string
  /** RFC 3339 timestamp of when the proof was recorded. */
  recorded_at: string
  /** Present when funds were diverted to a custody (suspense) account. */
  custody_detail?: CustodyDetail | null
}

/**
 * Proof type indicating which side of the transaction issued the proof.
 * - PAYER_EXEC_PROOF: Payer bank confirmed debit execution.
 * - PAYER_HV_ISOLATION_PROOF: High-value payer isolation proof.
 * - PAYEE_EXEC_PROOF: Payee bank confirmed credit execution.
 * - NO_DEBIT_RECORDED_PROOF: Payer bank certifies no debit occurred (for cancellation).
 */
export type ProofType =
  | 'PAYER_EXEC_PROOF'
  | 'PAYER_HV_ISOLATION_PROOF'
  | 'PAYEE_EXEC_PROOF'
  | 'NO_DEBIT_RECORDED_PROOF'

/** Details when credit lands in a custody (suspense) account instead of the payee. */
export interface CustodyDetail {
  is_custody: true
  /** Reason: ACCOUNT_FROZEN, ACCOUNT_CLOSED, or NOT_FOUND. */
  reason_code: string
  /** Reference to the custody (suspense) account holding the funds. */
  custody_account_ref: string
}

// ---------------------------------------------------------------------------
// ZC-side State Types
// ---------------------------------------------------------------------------

/**
 * Transaction state machine for the Zenith Coordinator.
 *
 * Lifecycle: RECEIVED -> PRECHECKED -> H_RESERVED -> DECIDED_TO_SETTLE
 *   -> PAYER_EXEC_CONFIRMED -> PAYEE_EXEC_CONFIRMED -> SETTLED
 *
 * - RECEIVED: Initial state after ZC accepts a payment request.
 * - PRECHECKED: Passed pre-check validations (participant active, limits, etc.).
 * - PRECHECKED_SUSPENDED: Pre-check passed but transaction is held for review.
 * - H_RESERVED: H-model liquidity reservation secured for the payer bank.
 * - HTLC_LOCKED: (HTLC lane) Hash-locked; awaiting preimage claim.
 * - HTLC_FULFILL_REQUESTED: (HTLC lane) Preimage received; awaiting settlement.
 * - DECIDED_TO_SETTLE: Settlement decision made; ready for execution.
 * - DECIDED_CANCEL: Cancellation decision made; awaiting rollback.
 * - PAYER_EXEC_CONFIRMED: Payer bank confirmed debit execution.
 * - PAYEE_EXEC_CONFIRMED: Payee bank confirmed credit execution.
 * - SETTLED: Terminal success — both sides executed and finalized.
 * - SUSPENDED: Held for manual investigation (CASE raised).
 * - FAILED_EXECUTION: Execution failed on one side; requires remediation.
 * - CANCELLED: Terminal — transaction was cancelled and rolled back.
 */
export type TxState =
  | 'RECEIVED'
  | 'PRECHECKED'
  | 'PRECHECKED_SUSPENDED'
  | 'H_RESERVED'
  | 'HTLC_LOCKED'
  | 'HTLC_FULFILL_REQUESTED'
  | 'DECIDED_TO_SETTLE'
  | 'DECIDED_CANCEL'
  | 'PAYER_EXEC_CONFIRMED'
  | 'PAYEE_EXEC_CONFIRMED'
  | 'SETTLED'
  | 'SUSPENDED'
  | 'FAILED_EXECUTION'
  | 'CANCELLED'

/**
 * State machine for HTLC (Hash Time-Locked Contract) transactions.
 * Uses hash-lock + time-lock for conditional payment settlement.
 */
export type HtlcState =
  | 'HTLC_RECEIVED'
  | 'HTLC_LOCKED'
  | 'HTLC_FULFILL_REQUESTED'
  | 'DECIDED_TO_SETTLE'
  | 'PAYER_EXEC_CONFIRMED'
  | 'PAYEE_EXEC_CONFIRMED'
  | 'SETTLED'
  | 'SUSPENDED'
  | 'DECIDED_CANCEL'
  | 'CANCELLED'
  | 'FAILED_EXECUTION'

/**
 * State machine for GTID (Global Transaction ID) coordinated multi-leg transactions.
 * Coordinates multiple payer/payee legs that must settle atomically.
 */
export type GtidState =
  | 'GT_RECEIVED'
  | 'GT_PRECHECKED'
  | 'GT_DECIDED_TO_SETTLE'
  | 'GT_DECIDED_CANCEL'
  | 'GT_SETTLED'
  | 'GT_SUSPENDED'
  | 'GT_CANCELLED'
  | 'GT_FAILED'

/** State of an individual leg within a GTID coordinated transaction. */
export type LegState =
  | 'LEG_REGISTERED'
  | 'LEG_READY_CHECKED'
  | 'LEG_PAYER_CONFIRMED'
  | 'LEG_PAYEE_CONFIRMED'
  | 'LEG_SETTLED'
  | 'LEG_SUSPENDED'
  | 'LEG_FAILED'

/**
 * DNS (Deferred Net Settlement) cycle state.
 * - OPEN: Accepting transactions for netting.
 * - KICKED: Net positions calculated; awaiting settlement.
 * - SETTLED: All net positions settled via BOJ.
 * - HOLD_ACTIVE: Settlement suspended (e.g. insufficient funds at BOJ).
 */
export type DnsState = 'OPEN' | 'KICKED' | 'SETTLED' | 'HOLD_ACTIVE'

/**
 * IGS (Interbank Gross Settlement) operating mode.
 * - NORMAL: Standard RTGS processing.
 * - STOP: Settlement halted.
 * - RINGFENCED: Only pre-approved transactions settle.
 * - RINGFENCED_PLUS: Stricter ringfencing with additional controls.
 */
export type IgsMode = 'NORMAL' | 'STOP' | 'RINGFENCED' | 'RINGFENCED_PLUS'

/** Investigation case lifecycle state. */
export type CaseState = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'ESCALATED'

/** Request-to-Pay lifecycle state. */
export type RtpState = 'REQUESTED' | 'ATTEMPTED' | 'SETTLED' | 'EXPIRED' | 'FAILED'

/**
 * Processing lane determining settlement speed and method.
 * - EXPRESS: Real-time gross settlement (seconds).
 * - STANDARD: Near-real-time with DNS batching.
 * - BULK: Batch processing (salary, utility).
 * - DEFERRED: Deferred settlement via DNS cycle.
 * - RTP: Request-to-Pay initiated by payee.
 * - HTLC: Hash Time-Locked Contract conditional payment.
 * - HIGH_VALUE: Large-value transactions requiring IGS/RTGS settlement.
 */
export type LaneType =
  | 'EXPRESS'
  | 'STANDARD'
  | 'BULK'
  | 'DEFERRED'
  | 'RTP'
  | 'HTLC'
  | 'HIGH_VALUE'

/** Transaction purpose category. */
export type PurposeType = 'MERCHANT' | 'P2P' | 'BILL' | 'SALARY' | 'REFUND'

// ---------------------------------------------------------------------------
// Bank-side State Types
// ---------------------------------------------------------------------------

/**
 * Suspense (escrow) account entry lifecycle.
 * - RESERVED: Funds reserved from payer account.
 * - EXECUTED: Debit/credit executed against customer account.
 * - HV_TRANSIT: High-value funds in transit via IGS.
 * - HTLC_LOCKED: Funds locked under HTLC hash-lock.
 * - LANDED: Credit landed in payee suspense (hard landing).
 * - SETTLED: DNS/IGS settlement completed.
 * - CUSTODY: Funds held in custody (payee account frozen/closed/not found).
 * - RETURNED: Funds returned to originator.
 */
export type SuspenseStatus =
  | 'RESERVED'
  | 'EXECUTED'
  | 'HV_TRANSIT'
  | 'HTLC_LOCKED'
  | 'LANDED'
  | 'SETTLED'
  | 'CUSTODY'
  | 'RETURNED'

/** Direction of a suspense entry relative to the bank. */
export type SuspenseDirection = 'PAY' | 'RECEIVE' | 'HV_TRANSIT' | 'HTLC'

/** Status of a ZC Ingress command processed by the bank. */
export type ZcRequestStatus = 'PROCESSING' | 'DONE' | 'PROOF_ISSUED'

/** Customer account status governing transaction eligibility. */
export type AccountStatus = 'NORMAL' | 'FROZEN' | 'CLOSING_HOLD' | 'CLOSED'

/**
 * Bank account type.
 * - SAVINGS/CURRENT: Customer deposit accounts.
 * - SUSPENSE: Internal escrow account for in-flight transactions.
 * - SETTLEMENT: ZC settlement account (nostro equivalent).
 * - ASSET: Bank's own asset account (e.g. cash).
 * - BOJ: Bank of Japan current account (prefund balance).
 */
export type AccountType = 'SAVINGS' | 'CURRENT' | 'SUSPENSE' | 'SETTLEMENT' | 'ASSET' | 'BOJ'

// ---------------------------------------------------------------------------
// Database Row Types — ZC Side
// ---------------------------------------------------------------------------

/** Participants table: Banks registered with the Zenith Coordinator. */
export interface ParticipantRow {
  bank_id: string
  bank_name: string
  ingress_base_url: string
  /** Maximum H-model liquidity reservation cap (in JPY). */
  h_limit: number
  /** Current H-model liquidity in use (must not exceed h_limit). */
  h_used: number
  /** 1 = active participant, 0 = suspended. */
  is_active: number
  registered_at: string
}

/** Transactions table: Core transaction record managed by the ZC orchestrator. */
export interface TransactionRow {
  txid: string
  lane: LaneType
  state: TxState
  amount_value: number
  amount_currency: string
  payer_bank_id: string
  payer_account_hash: string
  payee_bank_id: string
  payee_account_hash: string | null
  pspr_ref: string | null
  purpose: PurposeType | null
  idempotency_key: string
  schema_version: string
  h_reservation_id: string | null
  decision_proof_ref: string | null
  finality_log_ref: string | null
  /** JSON-serialized BankProofRef from payer bank after debit execution. */
  payer_bank_proof_ref: string | null
  /** JSON-serialized BankProofRef from payee bank after credit execution. */
  payee_bank_proof_ref: string | null
  reason_code: string | null
  case_id: string | null
  dns_cycle_id: string | null
  expires_at: string | null
  /** Optimistic lock counter — incremented on every state transition. */
  version: number
  created_at: string
  updated_at: string
}

/**
 * HReservations table: H-model liquidity reservations.
 * Each reservation locks a portion of a bank's h_limit to guarantee settlement.
 */
export interface HReservationRow {
  reservation_id: string
  txid: string
  bank_id: string
  amount: number
  /** RESERVED = standard hold, LOCKED = HTLC-reinforced hold. */
  mode: 'RESERVED' | 'LOCKED'
  /** 1 = reservation released (funds settled or cancelled). */
  is_released: number
  created_at: string
  released_at: string | null
}

/** FinalityLog table: Immutable audit trail of every state transition and event. */
export interface FinalityLogRow {
  log_id: string
  txid: string | null
  gtid: string | null
  event_type: string
  state_from: string | null
  state_to: string
  /** JSON-serialized event payload (proofs, amounts, reason codes, etc.). */
  payload_json: string
  /** Monotonically increasing sequence within a transaction. */
  event_seq: number
  occurred_at: string
}

export interface DnsCycleRow {
  cycle_id: string
  business_date: string
  state: DnsState
  igs_mode: IgsMode
  kicked_at: string | null
  settled_at: string | null
  hold_reason: string | null
  net_positions: string | null  // JSON
  created_at: string
}

export interface HtlcContractRow {
  htlc_id: string
  txid: string
  state: HtlcState
  hashlock: string
  timelock: string
  amount_value: number
  payer_bank_id: string
  payee_bank_id: string
  secret_verified: number
  authority_recheck_required: number
  version: number
  created_at: string
  updated_at: string
}

export interface GtidTransactionRow {
  gtid: string
  state: GtidState
  initiator_bank_id: string
  total_amount: number
  leg_count: number
  legs_ready_count: number
  legs_settled_count: number
  expires_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface GtidLegRow {
  leg_id: string
  gtid: string
  txid: string | null
  role: 'PAYER' | 'PAYEE'
  bank_id: string
  account_hash: string
  amount_value: number
  state: LegState
  bank_proof_ref: string | null  // JSON
  expires_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface CaseRow {
  case_id: string
  related_txid: string | null
  related_gtid: string | null
  state: CaseState
  reason_code: string
  description: string | null
  opened_by: string
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export interface VaultRow {
  vault_ref: string
  txid: string | null
  data_type: 'AML_EVAL' | 'PII' | 'RISK_HINT'
  payload_json: string
  expires_at: string
  is_evicted: number
  created_at: string
}

export interface PsprRegistryRow {
  pspr_ref: string
  payee_bank_id: string
  account_hash: string
  capability_state: 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
  digest: string
  expires_at: string
  created_at: string
  revoked_at: string | null
}

export interface RtpRequestRow {
  rtp_id: string
  payee_bank_id: string
  payer_bank_id: string
  amount_value: number
  state: 'REQUESTED' | 'ATTEMPTED' | 'SETTLED' | 'EXPIRED' | 'FAILED'
  attempt_count: number
  max_attempts: number
  linked_txid: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export interface IdempotencyKeyRow {
  key: string
  status: 'PROCESSING' | 'DONE'
  response_body: string | null
  created_at: string
  updated_at: string | null
}

// Bank側
export interface BankAccountRow {
  account_id: string
  bank_id: string
  customer_id: string
  customer_name: string
  account_type: AccountType
  status: AccountStatus
  freeze_reason: string | null
  opened_at: string
  closed_at: string | null
}

export interface BankJournalRow {
  journal_id: string
  bank_id: string
  account_id: string
  amount: number
  tx_type: string
  txid: string | null
  tx_group_id: string
  description: string | null
  value_date: string
  created_at: string
}

export interface ZcRequestRow {
  request_id: string
  bank_id: string
  txid: string | null
  command_type: string
  status: ZcRequestStatus
  response_body: string | null
  created_at: string
  updated_at: string | null
}

export interface SuspenseDetailRow {
  suspense_id: string
  bank_id: string
  account_id: string
  direction: SuspenseDirection
  status: SuspenseStatus
  amount: number
  txid: string | null
  request_id: string | null
  dns_cycle_id: string | null
  expires_at: string | null
  custody_reason: string | null
  settled_at: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// ZC Core API リクエスト/レスポンス型
// ---------------------------------------------------------------------------

/** POST /api/transfers — Payment initiation request (all lanes). */
export interface PaymentInitiatedRequest {
  schema_version: string
  message_type: 'EVENT'
  name: 'PaymentInitiated'
  message_id: string
  idempotency_key: string
  occurred_at: string
  txid: string
  lane: LaneType
  amount: Amount
  payer: { bank_id: string; account_hash: string; vault_ref?: string }
  payee: { bank_id: string; account_hash?: string; vault_ref?: string }
  purpose: PurposeType
  pspr_ref?: string
  expires_at?: string
  /** Proxy resolution: alias type (PHONE / EMAIL / NATIONAL_ID). */
  proxy_type?: ProxyType
  /** Proxy resolution: alias value (e.g. phone number). */
  proxy_value?: string
  /** Cross-border flag: 1 or true if the transfer crosses jurisdictions. */
  is_cross_border?: number | boolean
  /** FATF R.16 originator/beneficiary data (required when is_cross_border). */
  fatf_data?: FatfR16Data
  /** QR code reference (set by QR payment flow). */
  qr_ref?: string
}

// POST /api/htlc/create
export interface HtlcCreateRequest {
  htlc_id: string
  hashlock: string
  timelock: string
  amount: Amount
  payer_bank_id: string
  payer_account_hash: string
  payee_bank_id: string
  payee_account_hash: string
  idempotency_key: string
}

// POST /api/htlc/:htlc_id/claim
export interface HtlcClaimRequest {
  htlc_id: string
  preimage: string
  idempotency_key: string
}

// POST /api/gtid/register
export interface GtidRegisterRequest {
  gtid: string
  legs: GtidLegInput[]
  expires_at?: string
  idempotency_key: string
}

export interface GtidLegInput {
  leg_id: string
  role: 'PAYER' | 'PAYEE'
  bank_id: string
  account_hash: string
  amount: Amount
}

// POST /api/rtp/request
export interface RtpRequestInput {
  rtp_id: string
  payee_bank_id: string
  payer_bank_id: string
  amount: Amount
  expires_at: string
  idempotency_key: string
  payee_name?: string
  description?: string
  payee_account?: string
}

// POST /api/transfers/:txid/authorize
export interface TransferAuthorizeRequest {
  txid: string
  authorized: boolean
  idempotency_key: string
}

// POST /api/transfers/:txid/cancel
export interface TransferCancelRequest {
  txid: string
  reason_code: string
  idempotency_key: string
}

// GET /api/transactions/:txid レスポンス
export interface QueryResponse {
  txid: string
  state: TxState
  reason_code?: string
  decision: {
    status: 'NONE' | 'DECIDED_TO_SETTLE' | 'DECIDED_CANCEL'
    decision_proof_ref?: string
  }
  execution: {
    a: 'NONE' | 'OK' | 'NG'
    b: 'NONE' | 'OK' | 'NG'
    payer_bank_proof_ref?: BankProofRef
    payee_bank_proof_ref?: BankProofRef
  }
  case?: { case_id?: string; status?: CaseState }
  as_of: string
  freshness_level: 'GREEN'
  next_action_hint: 'WAIT' | 'RETRY_LATER' | 'CONTACT_PAYER_BANK' | 'OPEN_CASE'
}

// POST /api/participants/register
export interface ParticipantRegisterRequest {
  bank_id: string
  bank_name: string
  ingress_base_url: string
  h_limit: number
}

// POST /api/pspr/register
export interface PsprRegisterRequest {
  pspr_ref: string
  payee_bank_id: string
  account_hash: string
  expires_at: string
}

// ---------------------------------------------------------------------------
// ZC→Bank Ingress API 型
// ---------------------------------------------------------------------------

// reserve-funds
export interface ReserveFundsRequest {
  request_id: string
  txid: string
  amount: Amount
  account_hash: string
}

export type ReserveFundsResponse =
  | { result: 'RESERVED'; reservation_ref: string }
  | { result: 'ERROR'; reason_code: string }

// execute-debit
export interface ExecuteDebitRequest {
  request_id: string
  txid: string
  amount: Amount
  decision_proof_ref: string
  h_reservation?: { reservation_id: string; mode: 'RESERVED' | 'LOCKED' }
  execution_deadline?: string
  lane?: LaneType
  payer_account_hash?: string  // HVレーンは reserve-funds を経由しないため直接渡す
}

export interface ExecuteDebitResponse {
  result: 'OK'
  bank_proof_ref: BankProofRef
}

// execute-credit
export interface ExecuteCreditRequest {
  request_id: string
  txid: string
  amount: Amount
  decision_proof_ref: string
  payee_account_hash?: string   // ZC から渡す（Transactions テーブル直参照を排除）
}

export interface ExecuteCreditResponse {
  result: 'OK'
  bank_proof_ref: BankProofRef
}

// release-reserve
export interface ReleaseReserveRequest {
  request_id: string
  txid: string
  reservation_ref: string
}

export interface ReleaseReserveResponse {
  result: 'RELEASED'
  reservation_ref: string
}

// leg-ready-check
export interface LegReadyCheckRequest {
  request_id: string
  gtid: string
  leg_id: string
  role: 'PAYER' | 'PAYEE'
  amount: Amount
  account_hash: string
}

export type LegReadyCheckResponse =
  | { result: 'OK'; reservation_ref?: string }
  | { result: 'NG'; reason_code: string }

// authority-check
export interface AuthorityCheckRequest {
  request_id: string
  txid: string
  check_type: 'INITIAL' | 'RECHECK'
  vault_ref?: string
}

export type AuthorityCheckResponse =
  | { result: 'OK' }
  | { result: 'NG'; reason_code: string }

// name-check
export interface NameCheckRequest {
  request_id: string
  txid: string
  pspr_ref?: string
  account_hash: string
}

export type NameCheckResponse =
  | { result: 'MATCH' }
  | { result: 'MISMATCH'; reason_code: string }

// ---------------------------------------------------------------------------
// Cloudflare Queue メッセージ型
// ---------------------------------------------------------------------------
export type QueueMessageType =
  | 'ZC_BANK_RESERVE'
  | 'ZC_BANK_DEBIT'
  | 'ZC_BANK_CREDIT'
  | 'ZC_BANK_RELEASE'
  | 'ZC_BANK_AUTH_CHECK'
  | 'ZC_BANK_NAME_CHECK'
  | 'ZC_BANK_LEG_READY'
  | 'ZC_STATE_ADVANCE'
  | 'ZC_TIMEOUT_CHECK'
  | 'ZC_RESUME_CREDIT'
  | 'ZC_IGS_CALLBACK'

export interface QueueMessage {
  type: QueueMessageType
  payload: unknown
  txid?: string
  gtid?: string
  attempt: number
  enqueued_at: string
}

// ---------------------------------------------------------------------------
// FinalityLog イベント型
// ---------------------------------------------------------------------------
export type FinalityEventType =
  | 'PaymentInitiated'
  | 'PreCheckPassed'
  | 'PreCheckFailed'
  | 'HReserved'
  | 'DecidedToSettle'
  | 'DecidedCancel'
  | 'PayerExecConfirmed'
  | 'PayeeExecConfirmed'
  | 'Settled'
  | 'Suspended'
  | 'FailedExecution'
  | 'Cancelled'
  | 'HtlcCreated'
  | 'HtlcLocked'
  | 'HtlcFulfillRequested'
  | 'HtlcCancelled'
  | 'GtidRegistered'
  | 'GtidDecided'
  | 'GtidSettled'
  | 'RtpRequested'
  | 'DnsKicked'
  | 'DnsSettled'
  | 'DnsHoldActivated'
  | 'FilterRejected'
  | 'FilterPending'
  | 'ApprovalGranted'
  | 'ApprovalDenied'
  | 'HtlcAuthRequested'
  | 'HtlcAuthApproved'
  | 'HtlcAuthDeclined'
  | 'HtlcCaptured'
  | 'HtlcVoided'

// ---------------------------------------------------------------------------
// エラーレスポンス
// ---------------------------------------------------------------------------
export interface ErrorResponse {
  error: string
  reason_code?: string
  txid?: string
}

// ---------------------------------------------------------------------------
// Bank 顧客API 型
// ---------------------------------------------------------------------------
export interface BalanceResponse {
  account_id: string
  balance: number
  currency: string
  as_of: string
}

export interface CustomerTransferRequest {
  amount: Amount
  payee_bank_id?: string
  payee_account_hash?: string
  payee_account_id?: string         // 10桁口座番号（推奨: bankId自動導出）
  lane: LaneType
  purpose: PurposeType
  idempotency_key: string
  pspr_ref?: string
}

// ---------------------------------------------------------------------------
// Bank 顧客API 型（簡略化: payee_bank_id 不要、口座番号から自動導出）
// ---------------------------------------------------------------------------
export interface SimpleTransferRequest {
  amount: Amount
  payee_account_id: string          // 10桁の口座番号（銀行コード3桁+連番7桁）
  lane: LaneType
  purpose: PurposeType
  idempotency_key: string
  payer_account_id?: string         // 任意: 指定しない場合はデフォルト口座
}

// ---------------------------------------------------------------------------
// 口座番号体系ヘルパー
// 番号体系: BBBAAAAAAA (10桁)
//   BBB     = 銀行コード (001-999)
//   AAAAAAA = 口座連番 (0000001-9999999)
//   別段預金口座 = BBB0000000
// ---------------------------------------------------------------------------

/** 口座番号から銀行コード (3桁) を取得 */
export function bankCodeFromAccount(accountId: string): string {
  return accountId.slice(0, 3)
}

/** 銀行コードから別段預金口座番号を生成 */
export function suspenseAccountId(bankCode: string): string {
  return `${bankCode}0000000`
}

/**
 * 銀行コードから ZC清算勘定（日銀当座預金相当）口座番号を生成
 *
 * 残高の符号規則（account_type: 'SETTLEMENT'）:
 *   正残高 (+) … 銀行がZCに支払義務あり（支払超）
 *   負残高 (−) … ZCが銀行に支払義務あり（受取超 or 初期清算残高）
 *
 * 仕訳パターン:
 *   Hard Landing (受取側): ZCS(−) / Suspense(+)  ゼロサム ✓
 *   DNS Settle   (支払側): Suspense(−) / ZCS(+)  ゼロサム ✓
 */
export function nostroAccountId(bankCode: string): string {
  return `${bankCode}-ZCS`
}

/** 銀行コードから現金（Cash）口座番号を生成 */
export function cashAccountId(bankCode: string): string {
  return `${bankCode}-CASH`
}

/** 口座番号が別段預金かどうか */
export function isSuspenseAccount(accountId: string): boolean {
  return accountId.endsWith('0000000')
}

/** 次の口座番号を生成（bankCode + sequential） */
export function generateAccountId(bankCode: string, seq: number): string {
  return `${bankCode}${String(seq).padStart(7, '0')}`
}

// ---------------------------------------------------------------------------
// TxEventLog 型
// ---------------------------------------------------------------------------
export type TxEventStatus = 'OK' | 'NG' | 'PENDING'

export interface TxEventLogRow {
  log_id: string
  txid: string | null
  correlation_id: string | null
  actor: string
  action: string
  status: TxEventStatus
  reason_code: string | null
  amount: number | null
  bank_id: string | null
  account_id: string | null
  details_json: string | null
  duration_ms: number | null
  occurred_at: string
}

export interface BankAuditLogRow {
  log_id: string
  bank_id: string
  txid: string | null
  request_id: string | null
  command: string
  status: 'OK' | 'NG'
  reason_code: string | null
  amount: number | null
  account_id: string | null
  details_json: string | null
  occurred_at: string
}

// ---------------------------------------------------------------------------
// PaymentFilter 型
// ---------------------------------------------------------------------------
export type FilterType =
  | 'SENDER_BLOCK'       // 特定送金元口座ハッシュをブロック
  | 'SENDER_BANK_BLOCK'  // 特定送金元銀行IDをブロック
  | 'AMOUNT_LIMIT'       // 金額上限超過で発動
  | 'EDI_PATTERN'        // 電文パターンマッチ
  | 'REQUIRE_APPROVAL'   // 全着金に顧客承認を要求

export type FilterAction = 'REJECT' | 'HOLD_CONFIRM' | 'HOLD_MANUAL'
export type FilterScope = 'BANK_WIDE' | 'ACCOUNT'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT'

export interface PaymentFilterRow {
  filter_id: string
  bank_id: string
  scope: FilterScope
  account_id: string | null
  filter_type: FilterType
  condition_json: string
  action: FilterAction
  description: string | null
  is_active: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface PaymentApprovalRequestRow {
  approval_id: string
  bank_id: string
  account_id: string
  txid: string
  filter_id: string
  status: ApprovalStatus
  sender_bank_id: string
  sender_account_hash: string | null
  amount_value: number
  edi_data: string | null
  expires_at: string
  responded_at: string | null
  created_at: string
  updated_at: string
}

// フィルタ評価結果
export type FilterEvalResult =
  | { matched: false }
  | { matched: true; action: 'REJECT'; filter_id: string; reason_code: string }
  | { matched: true; action: 'HOLD_CONFIRM'; filter_id: string; approval_id: string }
  | { matched: true; action: 'HOLD_MANUAL'; filter_id: string; approval_id: string }

// execute-credit 拡張レスポンス（フィルタ発動時）
export type ExecuteCreditResult =
  | ExecuteCreditResponse
  | { result: 'FILTER_REJECTED'; reason_code: string; filter_id: string }
  | { result: 'PENDING_APPROVAL'; approval_id: string }

// PaymentFilter API 型
export interface CreatePaymentFilterRequest {
  scope: FilterScope
  account_id?: string
  filter_type: FilterType
  condition: Record<string, unknown>
  action: FilterAction
  description?: string
  created_by: string
}

export interface RespondApprovalRequest {
  approved: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// HTLC Auth（受取側起点オーソリ型）型
// ---------------------------------------------------------------------------
export type HtlcAuthStatus =
  | 'AUTH_REQUESTED'
  | 'AUTH_APPROVED'
  | 'AUTH_DECLINED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'EXPIRED'

export interface HtlcAuthWhitelistRow {
  whitelist_id: string
  payee_bank_id: string
  payee_account_hash: string
  allowed_payer_bank_id: string | null
  max_amount: number | null
  allowed_purposes: string | null  // JSON array
  description: string | null
  is_active: number
  registered_at: string
  expires_at: string | null
}

export interface HtlcAuthRequestRow {
  auth_id: string
  htlc_id: string | null
  txid: string | null
  status: HtlcAuthStatus
  payee_bank_id: string
  payee_account_hash: string
  payer_bank_id: string
  payer_account_hash: string
  amount_value: number
  purpose: string | null
  description: string | null
  auth_expires_at: string
  capture_expires_at: string
  vault_ref: string | null
  hashlock: string | null
  whitelist_id: string
  approved_at: string | null
  captured_at: string | null
  voided_at: string | null
  decline_reason: string | null
  idempotency_key: string
  version: number
  created_at: string
  updated_at: string
}

// HTLC Auth API リクエスト型
export interface HtlcAuthRequestInput {
  auth_id: string
  payee_bank_id: string
  payee_account_hash: string
  payer_bank_id: string
  payer_account_hash: string
  amount: Amount
  purpose?: PurposeType
  description?: string          // 商品・サービス説明（EDI相当）
  auth_expires_at: string       // 送金側が承認する期限
  capture_expires_at: string    // 受取側がキャプチャする期限（HTLCのtimelock相当）
  idempotency_key: string
}

export interface HtlcAuthApproveInput {
  idempotency_key: string
}

export interface HtlcAuthDeclineInput {
  reason?: string
  idempotency_key: string
}

export interface HtlcCaptureRequest {
  idempotency_key: string
}

export interface HtlcVoidRequest {
  reason?: string
  idempotency_key: string
}

// ホワイトリスト管理 API 型
export interface HtlcAuthWhitelistRegisterRequest {
  payee_bank_id: string
  payee_account_hash: string
  allowed_payer_bank_id?: string
  max_amount?: number
  allowed_purposes?: PurposeType[]
  description?: string
  expires_at?: string
}

// FinalityEventType 拡張

// ---------------------------------------------------------------------------
// QueueMessageType 拡張（新決済機能対応）
// ---------------------------------------------------------------------------
// 既存 QueueMessageType に追加（型は上で宣言済み。ここでは拡張分のコメントのみ）
// 'ZC_IGS_REQUEST'     — IGS振替依頼
// 'ZC_IGS_CALLBACK'    — IGS結果通知（内部キュー）
// 'ZC_CREDIT_NOTIFY'   — 入金結果通知配信
// 'ZC_RTP_NOTIFY'      — RTP請求通知配信

// ---------------------------------------------------------------------------
// IGS連携型
// ---------------------------------------------------------------------------
export type IgsStatus = 'REQUESTED' | 'SETTLED' | 'FAILED' | 'HOLD' | 'TIMEOUT'
export type ExternalSettlementStatus = 'NONE' | 'REQUESTED' | 'SETTLED' | 'FAILED' | 'HOLD'

export interface IgsRequestRow {
  ext_instruction_id: string
  txid: string
  payer_bank_id: string
  payee_bank_id: string
  amount_value: number
  amount_currency: string
  status: IgsStatus
  boj_settle_ref: string | null
  requested_at: string
  settled_at: string | null
  failed_reason: string | null
  retry_count: number
}

export interface IgsRequestInput {
  ext_instruction_id: string
  txid: string
  payer_bank_id: string
  payee_bank_id: string
  amount: Amount
  decision_proof_ref: string
  a_proof_ref: string
}

export interface IgsCallbackInput {
  ext_instruction_id: string
  result: 'SETTLED' | 'FAILED' | 'HOLD'
  boj_settle_ref?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// 事前口座確認型
// ---------------------------------------------------------------------------
export type VerificationStatus = 'PENDING' | 'MATCHED' | 'UNMATCHED' | 'NOT_FOUND' | 'ERROR' | 'EXPIRED'

export interface AccountVerificationRow {
  verification_id: string
  request_bank_id: string
  target_bank_id: string
  target_account_hash: string
  target_account_name: string | null
  status: VerificationStatus
  name_provided: string | null
  match_score: number | null
  fraud_warning: number
  cached_until: string | null
  idempotency_key: string | null
  created_at: string
  responded_at: string | null
}

export interface AccountVerifyRequest {
  verification_id: string
  request_bank_id: string
  target_bank_id: string
  target_account_id: string
  name_to_verify?: string
  idempotency_key: string
}

export interface AccountVerifyBatchRequest {
  batch_id: string
  request_bank_id: string
  items: Array<{
    target_bank_id: string
    target_account_id: string
    name_to_verify?: string
  }>
  idempotency_key: string
}

// Bank Ingress: account-verify
export interface BankAccountVerifyRequest {
  verification_id: string
  account_id: string
  name_to_verify?: string
}

export type BankAccountVerifyResponse =
  | { result: 'MATCHED'; account_name: string; match_score: number; fraud_warning: boolean }
  | { result: 'UNMATCHED'; account_name: string; match_score: number }
  | { result: 'NOT_FOUND' }
  | { result: 'FROZEN'; reason: string }
  | { result: 'ERROR'; reason_code: string }

// ---------------------------------------------------------------------------
// 入金結果通知型
// ---------------------------------------------------------------------------
export type NotificationStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'EXPIRED'

export interface CreditNotificationRow {
  notification_id: string
  txid: string
  payee_bank_id: string
  payee_account_hash: string
  amount_value: number
  amount_currency: string
  payer_bank_id: string
  payer_name_masked: string | null
  purpose: string | null
  edi_summary: string | null
  status: NotificationStatus
  delivery_attempts: number
  max_attempts: number
  created_at: string
  delivered_at: string | null
  next_retry_at: string | null
}

// Bank Ingress: credit-notify
export interface BankCreditNotifyRequest {
  notification_id: string
  txid: string
  payee_account_id: string
  amount: Amount
  payer_bank_id: string
  payer_name_masked?: string
  purpose?: string
  edi_summary?: string
  settled_at: string
}

// ---------------------------------------------------------------------------
// ZEDI型（全銀EDIリッチデータ）
// ---------------------------------------------------------------------------
export interface EdiLineItem {
  item_number: number
  description: string
  quantity: number
  unit_price: number
  amount: number
}

export interface EdiRecordRow {
  edi_ref: string
  txid: string | null
  format_version: string
  invoice_number: string | null
  invoice_date: string | null
  payment_due_date: string | null
  tax_amount: number | null
  tax_rate: number | null
  discount_amount: number | null
  note: string | null
  sender_ref: string | null
  receiver_ref: string | null
  line_items_json: string | null
  created_by_bank_id: string
  created_at: string
}

export interface EdiRegisterRequest {
  edi_ref: string
  bank_id: string
  invoice_number?: string
  invoice_date?: string
  payment_due_date?: string
  tax_amount?: number
  tax_rate?: number
  discount_amount?: number
  note?: string
  sender_ref?: string
  receiver_ref?: string
  line_items?: EdiLineItem[]
  idempotency_key: string
}

export interface EdiFilterCondition {
  field: 'invoice_number' | 'note' | 'sender_ref' | 'receiver_ref' | 'amount_range'
  operator: 'EQUALS' | 'CONTAINS' | 'REGEX' | 'GT' | 'LT'
  value: string
}

// ---------------------------------------------------------------------------
// ISO 20022型
// ---------------------------------------------------------------------------
export type MessageFormat = 'ZENITH_NATIVE' | 'ISO20022' | 'ZENGIN_FIXED'

export interface Pacs008Debtor {
  name: string
  account_id: string
  bank_id: string
  bank_bic?: string
}

export interface Pacs008Creditor {
  name: string
  account_id: string
  bank_id: string
  bank_bic?: string
}

export interface Pacs008Message {
  message_type: 'pacs.008'
  message_id: string
  creation_datetime: string
  number_of_transactions: number
  settlement_method: 'CLRG' | 'INDA'
  debtor: Pacs008Debtor
  creditor: Pacs008Creditor
  instructed_amount: Amount
  purpose_code?: string
  remittance_info?: {
    unstructured?: string
    structured?: {
      creditor_ref?: string
      invoice_number?: string
      edi_ref?: string
    }
  }
  regulatory_reporting?: FatfR16Data
}

export interface Pacs002Message {
  message_type: 'pacs.002'
  message_id: string
  original_message_id: string
  transaction_status: 'ACCP' | 'ACTC' | 'ACSP' | 'RJCT' | 'PDNG'
  reason_code?: string
  additional_info?: string
}

export interface Acmt023Message {
  message_type: 'acmt.023'
  message_id: string
  account_id: string
  account_holder_name?: string
  inquiry_bank_id: string
  target_bank_id: string
}

export interface Acmt024Message {
  message_type: 'acmt.024'
  original_message_id: string
  verification_result: 'MTCH' | 'NMTC' | 'NFND'
  account_holder_name?: string
  match_score?: number
}

/** pacs.004 — ReturnCreditTransfer（返金電文） */
export interface Pacs004Message {
  message_type: 'pacs.004'
  message_id: string
  creation_datetime: string
  original_message_id: string
  original_txid: string
  return_amount: Amount
  return_reason_code: string   // DUPL|FRAD|UPAY|CUST 等
  debtor: { name: string; bank_id: string; account_id: string }
  creditor: { name: string; bank_id: string; account_id: string }
}

/** pacs.028 — PaymentStatusRequest（取引状況照会電文） */
export interface Pacs028Message {
  message_type: 'pacs.028'
  message_id: string
  original_message_id: string
  original_txid: string
  inquiry_bank_id: string
}

/** pain.013 — CreditorPaymentActivationRequest（支払リクエスト送信電文 = RTP） */
export interface Pain013Message {
  message_type: 'pain.013'
  message_id: string
  creation_datetime: string
  rtp_id: string
  payee_bank_id: string
  payee_account_id: string
  payee_name: string
  payer_bank_id: string
  requested_amount: Amount
  requested_execution_date: string
  purpose_code?: string
  remittance_info?: string
  expires_at: string
}

/** pain.014 — CreditorPaymentActivationRequestStatusReport（支払リクエスト応答電文） */
export interface Pain014Message {
  message_type: 'pain.014'
  message_id: string
  original_message_id: string
  rtp_id: string
  status: 'ACTC' | 'RJCT' | 'PDNG'   // ACTC=承認, RJCT=拒否, PDNG=保留
  reason_code?: string
  linked_txid?: string
}

export interface ZenginFixedRecord {
  record_type: '1' | '2' | '8' | '9'
  bank_code: string
  branch_code: string
  account_type: '1' | '2' | '4'
  account_number: string
  beneficiary_name: string
  amount: number
  originator_name: string
  originator_bank_code: string
  originator_branch_code: string
}

// ---------------------------------------------------------------------------
// FATF勧告16型
// ---------------------------------------------------------------------------
export interface FatfParty {
  name: string
  account_id: string
  address?: string
  national_id?: string
  date_of_birth?: string
  place_of_birth?: string
}

export interface FatfInstitution {
  bank_id: string
  bank_name: string
  bic?: string
  country: string
}

export interface FatfR16Data {
  originator: FatfParty
  beneficiary: FatfParty
  ordering_institution: FatfInstitution
  beneficiary_institution: FatfInstitution
  intermediary?: {
    name: string
    license_number?: string
    country: string
  }
  is_cross_border: boolean
  fatf16_applicable: boolean
}

// ---------------------------------------------------------------------------
// エイリアス送金（Proxyディレクトリ）型
// ---------------------------------------------------------------------------
export type ProxyType = 'PHONE' | 'EMAIL' | 'NATIONAL_ID'

export interface ProxyDirectoryRow {
  proxy_id: string
  proxy_type: ProxyType
  proxy_value: string
  bank_id: string
  account_id: string
  account_holder_name: string
  is_active: number
  registered_at: string
  updated_at: string
}

export interface ProxyRegisterRequest {
  proxy_type: ProxyType
  proxy_value: string
  bank_id: string
  account_id: string
  account_holder_name: string
  idempotency_key: string
}

export interface ProxyResolveResponse {
  proxy_type: ProxyType
  proxy_value: string
  bank_id: string
  account_id: string
  account_holder_name: string
  resolved: boolean
}

// ---------------------------------------------------------------------------
// QRコード送金型
// ---------------------------------------------------------------------------
export type QrType = 'STATIC' | 'DYNAMIC'

export interface QrCodeRow {
  qr_ref: string
  qr_type: QrType
  payee_bank_id: string
  payee_account_id: string
  payee_name: string
  amount_value: number | null
  amount_currency: string
  purpose: string | null
  edi_ref: string | null
  signature: string
  is_used: number
  expires_at: string | null
  created_at: string
}

export interface QrGenerateRequest {
  type: QrType
  payee_bank_id: string
  payee_account_id: string
  payee_name?: string
  amount?: number
  purpose?: string
  edi_ref?: string
  expires_at?: string
}

export interface QrPayRequest {
  qr_ref: string
  payer_bank_id: string
  payer_account_id: string
  amount?: number
  idempotency_key: string
}

// ---------------------------------------------------------------------------
// RTP拡張型
// ---------------------------------------------------------------------------
export type RtpFullStatus =
  | 'CREATED'
  | 'NOTIFIED'
  | 'ACCEPTED'
  | 'TX_CREATED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'DECLINED'
  | 'EXPIRED'

export interface RtpRespondRequest {
  response: 'ACCEPTED' | 'REJECTED'
  payer_bank_id: string
  payer_account_id: string
  idempotency_key: string
}

// Bank Ingress: rtp-notify
export interface BankRtpNotifyRequest {
  rtp_id: string
  payee_bank_id: string
  payee_name: string
  amount: Amount
  description?: string
  edi_ref?: string
  expires_at: string
}

// ---------------------------------------------------------------------------
// リッチデータストレージ型
// ---------------------------------------------------------------------------
export type RichDataType = 'EDI' | 'INVOICE' | 'ATTACHMENT_META' | 'REMITTANCE'

export interface RichDataStoreRow {
  data_ref: string
  data_type: RichDataType
  txid: string | null
  content_json: string
  content_hash: string
  r2_key: string | null
  created_by_bank_id: string
  retention_days: number
  created_at: string
  expires_at: string | null
}

export interface RichDataStoreRequest {
  data_type: RichDataType
  bank_id: string
  txid?: string
  content: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// クロスボーダー送金型
// ---------------------------------------------------------------------------
export type CrossBorderStatus =
  | 'INITIATED'
  | 'ROUTED'
  | 'FOREIGN_ACCEPTED'
  | 'SETTLED'
  | 'FAILED'
  | 'RETURNED'

export interface CrossBorderTransactionRow {
  cb_txid: string
  domestic_txid: string | null
  direction: 'OUTBOUND' | 'INBOUND'
  foreign_fps_id: string
  foreign_bank_bic: string
  foreign_account_id: string
  foreign_currency: string
  foreign_amount: number
  exchange_rate: number | null
  domestic_amount: number
  status: CrossBorderStatus
  settlement_bank_id: string | null
  nostro_account_ref: string | null
  fatf_data_json: string
  created_at: string
  updated_at: string
}

export interface CrossBorderSendRequest {
  cb_txid: string
  payer_bank_id: string
  payer_account_id: string
  foreign_fps_id: string
  foreign_bank_bic: string
  foreign_account_id: string
  foreign_currency: string
  foreign_amount: number
  fatf_data: FatfR16Data
  idempotency_key: string
}

// ---------------------------------------------------------------------------
// 双方向通信型（SSE）
// ---------------------------------------------------------------------------
export type StreamEventType =
  | 'tx_state_change'
  | 'credit_notification'
  | 'rtp_request'
  | 'dns_status_change'
  | 'igs_result'
  | 'TX_STATE_CHANGED'
  | 'CREDIT_RECEIVED'
  | 'IGS_SETTLED'
  | 'DNS_KICKED'
  | 'RTP_RECEIVED'
  | 'ACCOUNT_VERIFIED'
  | 'QR_PAYMENT_RECEIVED'
  | 'CROSS_BORDER_UPDATED'

export interface EventStreamRow {
  event_id: string
  target_bank_id: string
  event_type: StreamEventType
  payload_json: string
  is_delivered: number
  created_at: string
}

// ---------------------------------------------------------------------------
// 参加形態型
// ---------------------------------------------------------------------------
export type ParticipationMode = 'FULL' | 'RECEIVE_ONLY' | 'SEND_ONLY'

// Util
// ---------------------------------------------------------------------------
export function nowISO(): string {
  return new Date().toISOString()
}

export function todayJST(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
