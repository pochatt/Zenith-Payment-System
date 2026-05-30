/**
 * @file api.ts — API request/response types, Queue types, FinalityLog events,
 * ISO 20022 messages, and all feature-layer API types.
 *
 * Imports primitives and states; does not import rows (no DB shape leakage
 * into API contracts).
 */
import type { Amount, BankProofRef, FatfR16Data } from "./primitives";
import type {
  LaneType,
  PurposeType,
  ProxyType,
  TxState,
  CaseState,
  FilterScope,
  FilterType,
  FilterAction,
  QrType,
  RichDataType,
} from "./states";

// ---------------------------------------------------------------------------
// ZC Core API — request/response types
// ---------------------------------------------------------------------------

/** POST /api/transfers — Payment initiation request (all lanes). */
export interface PaymentInitiatedRequest {
  schema_version: string;
  message_type: "EVENT";
  name: "PaymentInitiated";
  message_id: string;
  idempotency_key: string;
  occurred_at: string;
  txid: string;
  lane: LaneType;
  amount: Amount;
  payer: { bank_id: string; account_hash: string; vault_ref?: string };
  payee: { bank_id: string; account_hash?: string; vault_ref?: string };
  purpose: PurposeType;
  pspr_ref?: string;
  expires_at?: string;
  proxy_type?: ProxyType;
  proxy_value?: string;
  is_cross_border?: number | boolean;
  fatf_data?: FatfR16Data;
  qr_ref?: string;
}

// POST /api/htlc/create
export interface HtlcCreateRequest {
  htlc_id: string;
  hashlock: string;
  timelock: string;
  amount: Amount;
  payer_bank_id: string;
  payer_account_hash: string;
  payee_bank_id: string;
  payee_account_hash: string;
  idempotency_key: string;
}

// POST /api/htlc/:htlc_id/claim
export interface HtlcClaimRequest {
  htlc_id: string;
  preimage: string;
  idempotency_key: string;
}

// POST /api/gtid/register
export interface GtidRegisterRequest {
  gtid: string;
  legs: GtidLegInput[];
  expires_at?: string;
  idempotency_key: string;
}

export interface GtidLegInput {
  leg_id: string;
  role: "PAYER" | "PAYEE";
  bank_id: string;
  account_hash: string;
  amount: Amount;
}

// POST /api/rtp/request
export interface RtpRequestInput {
  rtp_id: string;
  payee_bank_id: string;
  payer_bank_id: string;
  amount: Amount;
  expires_at: string;
  idempotency_key: string;
  payee_name?: string;
  description?: string;
  payee_account?: string;
}

// POST /api/transfers/:txid/authorize
export interface TransferAuthorizeRequest {
  txid: string;
  authorized: boolean;
  idempotency_key: string;
}

// POST /api/transfers/:txid/cancel
export interface TransferCancelRequest {
  txid: string;
  reason_code: string;
  idempotency_key: string;
}

// GET /api/transactions/:txid
export interface QueryResponse {
  txid: string;
  state: TxState;
  reason_code?: string;
  decision: {
    status: "NONE" | "DECIDED_TO_SETTLE" | "DECIDED_CANCEL";
    decision_proof_ref?: string;
  };
  execution: {
    a: "NONE" | "OK" | "NG";
    b: "NONE" | "OK" | "NG";
    payer_bank_proof_ref?: BankProofRef;
    payee_bank_proof_ref?: BankProofRef;
  };
  case?: { case_id?: string; status?: CaseState };
  as_of: string;
  watermark: number;
  freshness_level: "GREEN" | "YELLOW" | "RED";
  next_action_hint: "WAIT" | "RETRY_LATER" | "CONTACT_PAYER_BANK" | "OPEN_CASE";
  next_retry_at: string | null;
}

// POST /api/participants/register
export interface ParticipantRegisterRequest {
  bank_id: string;
  bank_name: string;
  ingress_base_url: string;
  h_limit: number;
}

// POST /api/pspr/register
export interface PsprRegisterRequest {
  pspr_ref: string;
  payee_bank_id: string;
  account_hash: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// ZC→Bank Ingress API
// ---------------------------------------------------------------------------

// reserve-funds
export interface ReserveFundsRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  account_hash: string;
}

export type ReserveFundsResponse =
  | { result: "RESERVED"; reservation_ref: string }
  | { result: "ERROR"; reason_code: string };

// execute-debit
export interface ExecuteDebitRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  decision_proof_ref: string;
  h_reservation?: { reservation_id: string; mode: "RESERVED" | "LOCKED" };
  execution_deadline?: string;
  lane?: LaneType;
  payer_account_hash?: string;
}

export interface ExecuteDebitResponse {
  result: "OK";
  bank_proof_ref: BankProofRef;
}

// execute-credit
export interface ExecuteCreditRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  decision_proof_ref: string;
  payee_account_hash?: string;
}

export interface ExecuteCreditResponse {
  result: "OK";
  bank_proof_ref: BankProofRef;
}

// release-reserve
export interface ReleaseReserveRequest {
  request_id: string;
  txid: string;
  reservation_ref: string;
}

export interface ReleaseReserveResponse {
  result: "RELEASED";
  reservation_ref: string;
}

// leg-ready-check
export interface LegReadyCheckRequest {
  request_id: string;
  gtid: string;
  leg_id: string;
  role: "PAYER" | "PAYEE";
  amount: Amount;
  account_hash: string;
}

export type LegReadyCheckResponse =
  | { result: "OK"; reservation_ref?: string }
  | { result: "NG"; reason_code: string };

// authority-check
export interface AuthorityCheckRequest {
  request_id: string;
  txid: string;
  check_type: "INITIAL" | "RECHECK";
  vault_ref?: string;
}

export type AuthorityCheckResponse = { result: "OK" } | { result: "NG"; reason_code: string };

// name-check
export interface NameCheckRequest {
  request_id: string;
  txid: string;
  pspr_ref?: string;
  account_hash: string;
}

export type NameCheckResponse = { result: "MATCH" } | { result: "MISMATCH"; reason_code: string };

// ---------------------------------------------------------------------------
// Cloudflare Queue message types
// ---------------------------------------------------------------------------

export type QueueMessageType =
  | "ZC_BANK_RESERVE"
  | "ZC_BANK_DEBIT"
  | "ZC_BANK_CREDIT"
  | "ZC_BANK_RELEASE"
  | "ZC_BANK_AUTH_CHECK"
  | "ZC_BANK_NAME_CHECK"
  | "ZC_BANK_LEG_READY"
  | "ZC_STATE_ADVANCE"
  | "ZC_TIMEOUT_CHECK"
  | "ZC_RESUME_CREDIT"
  | "ZC_IGS_CALLBACK";

export interface QueueMessage {
  type: QueueMessageType;
  payload: unknown;
  txid?: string;
  gtid?: string;
  attempt: number;
  enqueued_at: string;
}

// ---------------------------------------------------------------------------
// FinalityLog event types
// ---------------------------------------------------------------------------

export type FinalityEventType =
  | "PaymentInitiated"
  | "PreCheckPassed"
  | "PreCheckFailed"
  | "HReserved"
  | "DecidedToSettle"
  | "DecidedCancel"
  | "PayerExecConfirmed"
  | "PayeeExecConfirmed"
  | "Settled"
  | "Suspended"
  | "FailedExecution"
  | "Cancelled"
  | "HtlcCreated"
  | "HtlcLocked"
  | "HtlcFulfillRequested"
  | "HtlcCancelled"
  | "GtidRegistered"
  | "GtidDecided"
  | "GtidDecidedCancel"
  | "GtidCancelled"
  | "GtidLegDecidedToSettle"
  | "GtidSettled"
  | "RtpRequested"
  | "RtpAccepted"
  | "RtpDeclined"
  | "DnsKicked"
  | "DnsSettled"
  | "DnsHoldActivated"
  | "FilterRejected"
  | "FilterPending"
  | "ApprovalGranted"
  | "ApprovalDenied"
  | "HtlcAuthRequested"
  | "HtlcAuthApproved"
  | "HtlcAuthDeclined"
  | "HtlcCaptured"
  | "HtlcVoided"
  | "FinalityChainAuditFailed"
  | "NoDebitRecordedProofSubmitted"
  | "HUnlockAuthorized";

// ---------------------------------------------------------------------------
// Common error response
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  error: string;
  reason_code?: string;
  txid?: string;
}

// ---------------------------------------------------------------------------
// Bank Customer API
// ---------------------------------------------------------------------------

export interface BalanceResponse {
  account_id: string;
  balance: number;
  currency: string;
  as_of: string;
}

export interface CustomerTransferRequest {
  amount: Amount;
  payee_bank_id?: string;
  payee_account_hash?: string;
  payee_account_id?: string;
  lane: LaneType;
  purpose: PurposeType;
  idempotency_key: string;
  pspr_ref?: string;
}

export interface SimpleTransferRequest {
  amount: Amount;
  payee_account_id: string;
  lane: LaneType;
  purpose: PurposeType;
  idempotency_key: string;
  payer_account_id?: string;
}

// ---------------------------------------------------------------------------
// PaymentFilter API
// ---------------------------------------------------------------------------

export type FilterEvalResult =
  | { matched: false }
  | { matched: true; action: "REJECT"; filter_id: string; reason_code: string }
  | { matched: true; action: "HOLD_CONFIRM"; filter_id: string; approval_id: string }
  | { matched: true; action: "HOLD_MANUAL"; filter_id: string; approval_id: string };

export type ExecuteCreditResult =
  | ExecuteCreditResponse
  | { result: "FILTER_REJECTED"; reason_code: string; filter_id: string }
  | { result: "PENDING_APPROVAL"; approval_id: string };

export interface CreatePaymentFilterRequest {
  scope: FilterScope;
  account_id?: string;
  filter_type: FilterType;
  condition: Record<string, unknown>;
  action: FilterAction;
  description?: string;
  created_by: string;
}

export interface RespondApprovalRequest {
  approved: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// HTLC Auth API
// ---------------------------------------------------------------------------

export interface HtlcAuthRequestInput {
  auth_id: string;
  payee_bank_id: string;
  payee_account_hash: string;
  payer_bank_id: string;
  payer_account_hash: string;
  amount: Amount;
  purpose?: PurposeType;
  description?: string;
  auth_expires_at: string;
  capture_expires_at: string;
  idempotency_key: string;
}

export interface HtlcAuthApproveInput {
  idempotency_key: string;
}

export interface HtlcAuthDeclineInput {
  reason?: string;
  idempotency_key: string;
}

export interface HtlcCaptureRequest {
  idempotency_key: string;
}

export interface HtlcVoidRequest {
  reason?: string;
  idempotency_key: string;
}

export interface HtlcAuthWhitelistRegisterRequest {
  payee_bank_id: string;
  payee_account_hash: string;
  allowed_payer_bank_id?: string;
  max_amount?: number;
  allowed_purposes?: PurposeType[];
  description?: string;
  expires_at?: string;
}

// ---------------------------------------------------------------------------
// IGS API
// ---------------------------------------------------------------------------

export interface IgsRequestInput {
  ext_instruction_id: string;
  txid: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount: Amount;
  decision_proof_ref: string;
  a_proof_ref: string;
}

export interface IgsCallbackInput {
  ext_instruction_id: string;
  result: "SETTLED" | "FAILED" | "HOLD";
  boj_settle_ref?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Account Verification API
// ---------------------------------------------------------------------------

export interface AccountVerifyRequest {
  verification_id: string;
  request_bank_id: string;
  target_bank_id: string;
  target_account_id: string;
  name_to_verify?: string;
  idempotency_key: string;
}

export interface AccountVerifyBatchRequest {
  batch_id: string;
  request_bank_id: string;
  items: Array<{
    target_bank_id: string;
    target_account_id: string;
    name_to_verify?: string;
  }>;
  idempotency_key: string;
}

// Bank Ingress: account-verify
export interface BankAccountVerifyRequest {
  verification_id: string;
  account_id: string;
  name_to_verify?: string;
}

export type BankAccountVerifyResponse =
  | { result: "MATCHED"; account_name: string; match_score: number; fraud_warning: boolean }
  | { result: "UNMATCHED"; account_name: string; match_score: number }
  | { result: "NOT_FOUND" }
  | { result: "FROZEN"; reason: string }
  | { result: "ERROR"; reason_code: string };

// ---------------------------------------------------------------------------
// Credit Notification API
// ---------------------------------------------------------------------------

// Bank Ingress: credit-notify
export interface BankCreditNotifyRequest {
  notification_id: string;
  txid: string;
  payee_account_id: string;
  amount: Amount;
  payer_bank_id: string;
  payer_name_masked?: string;
  purpose?: string;
  edi_summary?: string;
  settled_at: string;
}

// ---------------------------------------------------------------------------
// ZEDI (全銀EDI) API
// ---------------------------------------------------------------------------

export interface EdiLineItem {
  item_number: number;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface EdiRegisterRequest {
  edi_ref: string;
  bank_id: string;
  invoice_number?: string;
  invoice_date?: string;
  payment_due_date?: string;
  tax_amount?: number;
  tax_rate?: number;
  discount_amount?: number;
  note?: string;
  sender_ref?: string;
  receiver_ref?: string;
  line_items?: EdiLineItem[];
  idempotency_key: string;
}

export interface EdiFilterCondition {
  field: "invoice_number" | "note" | "sender_ref" | "receiver_ref" | "amount_range";
  operator: "EQUALS" | "CONTAINS" | "REGEX" | "GT" | "LT";
  value: string;
}

// ---------------------------------------------------------------------------
// ISO 20022 Messages
// ---------------------------------------------------------------------------

export interface Pacs008Debtor {
  name: string;
  account_id: string;
  bank_id: string;
  bank_bic?: string;
}

export interface Pacs008Creditor {
  name: string;
  account_id: string;
  bank_id: string;
  bank_bic?: string;
}

export interface Pacs008Message {
  message_type: "pacs.008";
  message_id: string;
  creation_datetime: string;
  number_of_transactions: number;
  settlement_method: "CLRG" | "INDA";
  debtor: Pacs008Debtor;
  creditor: Pacs008Creditor;
  instructed_amount: Amount;
  purpose_code?: string;
  remittance_info?: {
    unstructured?: string;
    structured?: {
      creditor_ref?: string;
      invoice_number?: string;
      edi_ref?: string;
    };
  };
  regulatory_reporting?: FatfR16Data;
}

export interface Pacs002Message {
  message_type: "pacs.002";
  message_id: string;
  original_message_id: string;
  transaction_status: "ACCP" | "ACTC" | "ACSP" | "RJCT" | "PDNG";
  reason_code?: string;
  additional_info?: string;
}

export interface Acmt023Message {
  message_type: "acmt.023";
  message_id: string;
  account_id: string;
  account_holder_name?: string;
  inquiry_bank_id: string;
  target_bank_id: string;
}

export interface Acmt024Message {
  message_type: "acmt.024";
  original_message_id: string;
  verification_result: "MTCH" | "NMTC" | "NFND";
  account_holder_name?: string;
  match_score?: number;
}

/** pacs.004 — ReturnCreditTransfer */
export interface Pacs004Message {
  message_type: "pacs.004";
  message_id: string;
  creation_datetime: string;
  original_message_id: string;
  original_txid: string;
  return_amount: Amount;
  return_reason_code: string;
  debtor: { name: string; bank_id: string; account_id: string };
  creditor: { name: string; bank_id: string; account_id: string };
}

/** pacs.028 — PaymentStatusRequest */
export interface Pacs028Message {
  message_type: "pacs.028";
  message_id: string;
  original_message_id: string;
  original_txid: string;
  inquiry_bank_id: string;
}

/** pain.013 — CreditorPaymentActivationRequest (RTP) */
export interface Pain013Message {
  message_type: "pain.013";
  message_id: string;
  creation_datetime: string;
  rtp_id: string;
  payee_bank_id: string;
  payee_account_id: string;
  payee_name: string;
  payer_bank_id: string;
  requested_amount: Amount;
  requested_execution_date: string;
  purpose_code?: string;
  remittance_info?: string;
  expires_at: string;
}

/** pain.014 — CreditorPaymentActivationRequestStatusReport */
export interface Pain014Message {
  message_type: "pain.014";
  message_id: string;
  original_message_id: string;
  rtp_id: string;
  status: "ACTC" | "RJCT" | "PDNG";
  reason_code?: string;
  linked_txid?: string;
}

export interface ZenginFixedRecord {
  record_type: "1" | "2" | "8" | "9";
  bank_code: string;
  branch_code: string;
  account_type: "1" | "2" | "4";
  account_number: string;
  beneficiary_name: string;
  amount: number;
  originator_name: string;
  originator_bank_code: string;
  originator_branch_code: string;
}

// ---------------------------------------------------------------------------
// Proxy Directory API
// ---------------------------------------------------------------------------

export interface ProxyRegisterRequest {
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  idempotency_key: string;
}

export interface ProxyResolveResponse {
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// QR Payment API
// ---------------------------------------------------------------------------

export interface QrGenerateRequest {
  type: QrType;
  payee_bank_id: string;
  payee_account_id: string;
  payee_name?: string;
  amount?: number;
  purpose?: string;
  edi_ref?: string;
  expires_at?: string;
}

export interface QrPayRequest {
  qr_ref: string;
  payer_bank_id: string;
  payer_account_id: string;
  amount?: number;
  idempotency_key: string;
}

// ---------------------------------------------------------------------------
// RTP API
// ---------------------------------------------------------------------------

export interface RtpRespondRequest {
  response: "ACCEPTED" | "REJECTED";
  payer_bank_id: string;
  payer_account_id: string;
  idempotency_key: string;
}

// Bank Ingress: rtp-notify
export interface BankRtpNotifyRequest {
  rtp_id: string;
  payee_bank_id: string;
  payee_name: string;
  amount: Amount;
  description?: string;
  edi_ref?: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Rich Data Storage API
// ---------------------------------------------------------------------------

export interface RichDataStoreRequest {
  data_type: RichDataType;
  bank_id: string;
  txid?: string;
  content: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cross-border API
// ---------------------------------------------------------------------------

export interface CrossBorderSendRequest {
  cb_txid: string;
  payer_bank_id: string;
  payer_account_id: string;
  foreign_fps_id: string;
  foreign_bank_bic: string;
  foreign_account_id: string;
  foreign_currency: string;
  foreign_amount: number;
  fatf_data: FatfR16Data;
  idempotency_key: string;
}
