/**
 * @file rows.ts — D1 database row types for every table.
 *
 * All interfaces here map 1-to-1 to a database table row. Imported by modules
 * that query or insert into D1 directly. No API or request/response types here.
 */
import type {
  TxState,
  LaneType,
  PurposeType,
  HtlcState,
  GtidState,
  LegState,
  DnsState,
  IgsMode,
  CaseState,
  RtpState,
  AccountType,
  AccountStatus,
  ZcRequestStatus,
  SuspenseDirection,
  SuspenseStatus,
  TxEventStatus,
  FilterScope,
  FilterType,
  FilterAction,
  ApprovalStatus,
  HtlcAuthStatus,
  IgsStatus,
  VerificationStatus,
  NotificationStatus,
  QrType,
  RichDataType,
  CrossBorderStatus,
  StreamEventType,
  ProxyType,
} from "./states";

// ---------------------------------------------------------------------------
// ZC-side Row Types
// ---------------------------------------------------------------------------

/** Participants table: Banks registered with the Zenith Coordinator. */
export interface ParticipantRow {
  bank_id: string;
  bank_name: string;
  ingress_base_url: string;
  h_limit: number;
  /**
   * Materialized counter — NOT careless denormalization. The atomic
   * `UPDATE ... SET h_used = h_used + ? WHERE (h_used + ?) <= h_limit` form
   * is how the H-limit is enforced race-free; deriving via SUM(HReservations
   * WHERE is_released=0) would reopen a TOCTOU window between the SUM and the
   * insert. Reconcilable with that SUM at rest. See src/zc/h_model.ts#reserveH.
   */
  h_used: number;
  /** 1 = active participant, 0 = suspended. */
  is_active: number;
  registered_at: string;
  /** Per-bank HIGH_VALUE auto-routing threshold (JPY). NULL = use system default. */
  hv_threshold: number | null;
}

/** Transactions table: Core transaction record managed by the ZC orchestrator. */
export interface TransactionRow {
  txid: string;
  lane: LaneType;
  state: TxState;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payer_account_hash: string;
  payee_bank_id: string;
  payee_account_hash: string | null;
  pspr_ref: string | null;
  purpose: PurposeType | null;
  idempotency_key: string;
  schema_version: string;
  h_reservation_id: string | null;
  decision_proof_ref: string | null;
  finality_log_ref: string | null;
  payer_bank_proof_ref: string | null;
  payee_bank_proof_ref: string | null;
  reason_code: string | null;
  case_id: string | null;
  dns_cycle_id: string | null;
  expires_at: string | null;
  /**
   * IGS/BOJ external settlement status for HIGH_VALUE lane.
   * NONE = not an HV tx; REQUESTED = IGS sent; SETTLED = BOJ confirmed;
   * FAILED = IGS failed (recoverable); HOLD = BOJ hold (awaiting retry).
   */
  external_settlement_status: string;
  /** Optimistic lock counter — incremented on every state transition. */
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * HReservations table: H-model liquidity reservations.
 * Each reservation locks a portion of a bank's h_limit.
 */
export interface HReservationRow {
  reservation_id: string;
  txid: string;
  bank_id: string;
  amount: number;
  /** RESERVED = standard hold, LOCKED = Hash-Time-Locked Contract-reinforced hold. */
  mode: "RESERVED" | "LOCKED";
  /** 1 = reservation released (funds settled or cancelled). */
  is_released: number;
  created_at: string;
  released_at: string | null;
}

/** FinalityLog table: Immutable audit trail of every state transition and event. */
export interface FinalityLogRow {
  log_id: string;
  txid: string | null;
  gtid: string | null;
  event_type: string;
  state_from: string | null;
  state_to: string;
  payload_json: string;
  event_seq: number;
  occurred_at: string;
}

export interface DnsCycleRow {
  cycle_id: string;
  business_date: string;
  state: DnsState;
  igs_mode: IgsMode;
  kicked_at: string | null;
  settled_at: string | null;
  hold_reason: string | null;
  net_positions: string | null;
  created_at: string;
}

export interface HtlcContractRow {
  htlc_id: string;
  txid: string;
  state: HtlcState;
  hashlock: string;
  timelock: string;
  amount_value: number;
  payer_bank_id: string;
  payee_bank_id: string;
  secret_verified: number;
  authority_recheck_required: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GtidTransactionRow {
  gtid: string;
  state: GtidState;
  initiator_bank_id: string;
  total_amount: number;
  leg_count: number;
  /**
   * Display-only denormalization of GtidLegs.state counts. The settle decision
   * (`checkAndFinalizeGtid`) derives "all settled" from real leg/tx states, not
   * these columns — they exist for dashboard rendering. Snapshot-written at
   * GT_DECIDED_TO_SETTLE / GT_SETTLED, so stored values are accurate at
   * terminal transitions but may lag mid-flight. The single-GTID API
   * (`handleGetGtid`) overrides them with values derived from the loaded legs
   * to avoid any drift in the detail view.
   */
  legs_ready_count: number;
  legs_settled_count: number;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GtidLegRow {
  leg_id: string;
  gtid: string;
  txid: string | null;
  role: "PAYER" | "PAYEE";
  bank_id: string;
  account_hash: string;
  amount_value: number;
  state: LegState;
  bank_proof_ref: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CaseRow {
  case_id: string;
  related_txid: string | null;
  related_gtid: string | null;
  state: CaseState;
  reason_code: string;
  description: string | null;
  opened_by: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VaultRow {
  vault_ref: string;
  txid: string | null;
  data_type: "AML_EVAL" | "PII" | "RISK_HINT";
  payload_json: string;
  expires_at: string;
  is_evicted: number;
  created_at: string;
}

export interface PsprRegistryRow {
  pspr_ref: string;
  payee_bank_id: string;
  account_hash: string;
  capability_state: "ACTIVE" | "SUSPENDED" | "REVOKED";
  digest: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export interface RtpRequestRow {
  rtp_id: string;
  payee_bank_id: string;
  payer_bank_id: string;
  amount_value: number;
  state: RtpState;
  attempt_count: number;
  max_attempts: number;
  linked_txid: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyKeyRow {
  key: string;
  status: "PROCESSING" | "DONE";
  response_body: string | null;
  created_at: string;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Bank-side Row Types
// ---------------------------------------------------------------------------

export interface BankAccountRow {
  account_id: string;
  bank_id: string;
  customer_id: string;
  customer_name: string;
  account_type: AccountType;
  status: AccountStatus;
  freeze_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface BankJournalRow {
  journal_id: string;
  bank_id: string;
  account_id: string;
  amount: number;
  tx_type: string;
  txid: string | null;
  tx_group_id: string;
  description: string | null;
  value_date: string;
  created_at: string;
}

export interface ZcRequestRow {
  request_id: string;
  bank_id: string;
  txid: string | null;
  command_type: string;
  status: ZcRequestStatus;
  response_body: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface SuspenseDetailRow {
  suspense_id: string;
  bank_id: string;
  account_id: string;
  direction: SuspenseDirection;
  status: SuspenseStatus;
  amount: number;
  txid: string | null;
  request_id: string | null;
  dns_cycle_id: string | null;
  expires_at: string | null;
  custody_reason: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TxEventLogRow {
  log_id: string;
  txid: string | null;
  correlation_id: string | null;
  actor: string;
  action: string;
  status: TxEventStatus;
  reason_code: string | null;
  amount: number | null;
  bank_id: string | null;
  account_id: string | null;
  details_json: string | null;
  duration_ms: number | null;
  occurred_at: string;
}

export interface BankAuditLogRow {
  log_id: string;
  bank_id: string;
  txid: string | null;
  request_id: string | null;
  command: string;
  status: "OK" | "NG";
  reason_code: string | null;
  amount: number | null;
  account_id: string | null;
  details_json: string | null;
  occurred_at: string;
}

export interface PaymentFilterRow {
  filter_id: string;
  bank_id: string;
  scope: FilterScope;
  account_id: string | null;
  filter_type: FilterType;
  condition_json: string;
  action: FilterAction;
  description: string | null;
  is_active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentApprovalRequestRow {
  approval_id: string;
  bank_id: string;
  account_id: string;
  txid: string;
  filter_id: string;
  status: ApprovalStatus;
  sender_bank_id: string;
  sender_account_hash: string | null;
  amount_value: number;
  edi_data: string | null;
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HtlcAuthWhitelistRow {
  whitelist_id: string;
  payee_bank_id: string;
  payee_account_hash: string;
  allowed_payer_bank_id: string | null;
  max_amount: number | null;
  allowed_purposes: string | null;
  description: string | null;
  is_active: number;
  registered_at: string;
  expires_at: string | null;
}

export interface HtlcAuthRequestRow {
  auth_id: string;
  htlc_id: string | null;
  txid: string | null;
  status: HtlcAuthStatus;
  payee_bank_id: string;
  payee_account_hash: string;
  payer_bank_id: string;
  payer_account_hash: string;
  amount_value: number;
  purpose: string | null;
  description: string | null;
  auth_expires_at: string;
  capture_expires_at: string;
  vault_ref: string | null;
  hashlock: string | null;
  whitelist_id: string;
  approved_at: string | null;
  captured_at: string | null;
  voided_at: string | null;
  decline_reason: string | null;
  idempotency_key: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface IgsRequestRow {
  ext_instruction_id: string;
  txid: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount_value: number;
  amount_currency: string;
  status: IgsStatus;
  boj_settle_ref: string | null;
  requested_at: string;
  settled_at: string | null;
  failed_reason: string | null;
  retry_count: number;
}

export interface AccountVerificationRow {
  verification_id: string;
  request_bank_id: string;
  target_bank_id: string;
  target_account_hash: string;
  target_account_name: string | null;
  status: VerificationStatus;
  name_provided: string | null;
  match_score: number | null;
  fraud_warning: number;
  cached_until: string | null;
  idempotency_key: string | null;
  created_at: string;
  responded_at: string | null;
}

export interface CreditNotificationRow {
  notification_id: string;
  txid: string;
  payee_bank_id: string;
  payee_account_hash: string;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payer_name_masked: string | null;
  purpose: string | null;
  edi_summary: string | null;
  status: NotificationStatus;
  delivery_attempts: number;
  max_attempts: number;
  created_at: string;
  delivered_at: string | null;
  next_retry_at: string | null;
}

export interface EdiRecordRow {
  edi_ref: string;
  txid: string | null;
  format_version: string;
  invoice_number: string | null;
  invoice_date: string | null;
  payment_due_date: string | null;
  tax_amount: number | null;
  tax_rate: number | null;
  discount_amount: number | null;
  note: string | null;
  sender_ref: string | null;
  receiver_ref: string | null;
  line_items_json: string | null;
  created_by_bank_id: string;
  created_at: string;
}

export interface ProxyDirectoryRow {
  proxy_id: string;
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  is_active: number;
  registered_at: string;
  updated_at: string;
}

export interface QrCodeRow {
  qr_ref: string;
  qr_type: QrType;
  payee_bank_id: string;
  payee_account_id: string;
  payee_name: string;
  amount_value: number | null;
  amount_currency: string;
  purpose: string | null;
  edi_ref: string | null;
  signature: string;
  is_used: number;
  expires_at: string | null;
  created_at: string;
}

export interface RichDataStoreRow {
  data_ref: string;
  data_type: RichDataType;
  txid: string | null;
  content_json: string;
  content_hash: string;
  r2_key: string | null;
  created_by_bank_id: string;
  retention_days: number;
  created_at: string;
  expires_at: string | null;
}

export interface CrossBorderTransactionRow {
  cb_txid: string;
  domestic_txid: string | null;
  direction: "OUTBOUND" | "INBOUND";
  foreign_fps_id: string;
  foreign_bank_bic: string;
  foreign_account_id: string;
  foreign_currency: string;
  foreign_amount: number;
  exchange_rate: number | null;
  domestic_amount: number;
  status: CrossBorderStatus;
  settlement_bank_id: string | null;
  nostro_account_ref: string | null;
  fatf_data_json: string;
  created_at: string;
  updated_at: string;
}

export interface EventStreamRow {
  event_id: string;
  target_bank_id: string;
  event_type: StreamEventType;
  payload_json: string;
  is_delivered: number;
  created_at: string;
}

/**
 * EntityStateLog table: append-only history of status transitions for entities
 * outside the Transactions money-path state machine (Cases, PSPR capabilities,
 * bank account status, reversals). INSERT-ONLY — never updated.
 */
export interface EntityStateLogRow {
  log_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  state_from: string | null;
  state_to: string;
  reason_code: string | null;
  actor: string | null;
  payload_json: string | null;
  occurred_at: string;
}
