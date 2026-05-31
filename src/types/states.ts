/**
 * @file states.ts — All state union types and enum-like string literals.
 *
 * Pure string unions with no intra-package dependencies. Imported by rows.ts,
 * api.ts, and any module that needs to refer to a state or mode value.
 */

// ---------------------------------------------------------------------------
// ZC Transaction State Machine
// ---------------------------------------------------------------------------

/**
 * Transaction state machine for the Zenith Coordinator.
 *
 * Lifecycle: RECEIVED -> PRECHECKED -> H_RESERVED -> DECIDED_TO_SETTLE
 *   -> PAYER_EXEC_CONFIRMED -> PAYEE_EXEC_CONFIRMED -> SETTLED
 */
export type TxState =
  | "RECEIVED"
  | "PRECHECKED"
  | "PRECHECKED_SUSPENDED"
  | "H_RESERVED"
  | "HTLC_LOCKED"
  | "HTLC_FULFILL_REQUESTED"
  | "DECIDED_TO_SETTLE"
  | "DECIDED_CANCEL"
  | "PAYER_EXEC_CONFIRMED"
  | "PAYEE_EXEC_CONFIRMED"
  | "SETTLED"
  | "SUSPENDED"
  | "FAILED_EXECUTION"
  | "CANCELLED";

/** State machine for HTLC (Hash Time-Locked Contract) transactions. */
export type HtlcState =
  | "HTLC_RECEIVED"
  | "HTLC_LOCKED"
  | "HTLC_FULFILL_REQUESTED"
  | "DECIDED_TO_SETTLE"
  | "PAYER_EXEC_CONFIRMED"
  | "PAYEE_EXEC_CONFIRMED"
  | "SETTLED"
  | "SUSPENDED"
  | "DECIDED_CANCEL"
  | "CANCELLED"
  | "FAILED_EXECUTION";

/** State machine for GTID coordinated multi-leg transactions. */
export type GtidState =
  | "GT_RECEIVED"
  | "GT_PRECHECKED"
  | "GT_DECIDED_TO_SETTLE"
  | "GT_DECIDED_CANCEL"
  | "GT_SETTLED"
  | "GT_SUSPENDED"
  | "GT_CANCELLED"
  | "GT_FAILED";

/** State of an individual leg within a GTID coordinated transaction. */
export type LegState =
  | "LEG_REGISTERED"
  | "LEG_READY_CHECKED"
  | "LEG_PAYER_CONFIRMED"
  | "LEG_PAYEE_CONFIRMED"
  | "LEG_SETTLED"
  | "LEG_SUSPENDED"
  | "LEG_FAILED";

/**
 * DNS (Deferred Net Settlement) cycle state.
 * - OPEN: Accepting transactions for netting.
 * - KICKED: Net positions calculated; awaiting settlement.
 * - SETTLED: All net positions settled via BOJ.
 * - HOLD_ACTIVE: Settlement suspended (e.g. insufficient funds at BOJ).
 */
export type DnsState = "OPEN" | "KICKED" | "SETTLED" | "HOLD_ACTIVE";

/**
 * IGS (Interbank Gross Settlement) operating mode.
 * - NORMAL: Standard RTGS processing.
 * - STOP: Settlement halted.
 * - RINGFENCED: Only pre-approved transactions settle.
 * - RINGFENCED_PLUS: Stricter ringfencing with additional controls.
 */
export type IgsMode = "NORMAL" | "STOP" | "RINGFENCED" | "RINGFENCED_PLUS";

/** Investigation case lifecycle state. */
export type CaseState = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "ESCALATED";

/**
 * Request-to-Pay lifecycle state.
 *
 * Old `state` (REQUESTED|ATTEMPTED|SETTLED|EXPIRED|FAILED) and
 * old `rtp_status` (CREATED|NOTIFIED|...) were consolidated
 * in 0025_rtp_consolidate.sql into single `state` column.
 *  - CREATED      : RtpRequests row created, bank not notified
 *  - NOTIFIED     : rtp-notify to paying bank successful
 *  - ACCEPTED     : Payer approved (transient state before TX creation — usually skipped)
 *  - TX_CREATED   : Linked fund transfer Transaction created
 *  - COMPLETED    : fund transfer SETTLED finalized
 *  - DECLINED     : Payer declined
 *  - EXPIRED      : expires_at elapsed
 *  - FAILED       : Other failure (max_attempts exceeded, etc)
 */
export type RtpState =
  | "CREATED"
  | "NOTIFIED"
  | "ACCEPTED"
  | "TX_CREATED"
  | "COMPLETED"
  | "DECLINED"
  | "EXPIRED"
  | "FAILED";

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
export type LaneType = "EXPRESS" | "STANDARD" | "BULK" | "DEFERRED" | "RTP" | "HTLC" | "HIGH_VALUE";

/** Transaction purpose category. */
export type PurposeType = "MERCHANT" | "P2P" | "BILL" | "SALARY" | "REFUND";

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
  | "RESERVED"
  | "EXECUTED"
  | "HV_TRANSIT"
  | "HTLC_LOCKED"
  | "LANDED"
  | "SETTLED"
  | "CUSTODY"
  | "RETURNED";

/** Direction of a suspense entry relative to the bank. */
export type SuspenseDirection = "PAY" | "RECEIVE" | "HV_TRANSIT" | "HTLC";

/** Status of a ZC Ingress command processed by the bank. */
export type ZcRequestStatus = "PROCESSING" | "DONE" | "PROOF_ISSUED";

/** Customer account status governing transaction eligibility. */
export type AccountStatus = "NORMAL" | "FROZEN" | "CLOSING_HOLD" | "CLOSED";

/**
 * Bank account type.
 * - SAVINGS/CURRENT: Customer deposit accounts.
 * - SUSPENSE: Internal escrow account for in-flight transactions.
 * - SETTLEMENT: ZC settlement account (nostro equivalent).
 * - ASSET: Bank's own asset account (e.g. cash).
 * - BOJ: Bank of Japan current account (prefund balance).
 */
export type AccountType = "SAVINGS" | "CURRENT" | "SUSPENSE" | "SETTLEMENT" | "ASSET" | "BOJ";

// ---------------------------------------------------------------------------
// Feature State Types
// ---------------------------------------------------------------------------

export type TxEventStatus = "OK" | "NG" | "PENDING";

export type FilterType =
  | "SENDER_BLOCK"
  | "SENDER_BANK_BLOCK"
  | "AMOUNT_LIMIT"
  | "EDI_PATTERN"
  | "REQUIRE_APPROVAL";

export type FilterAction = "REJECT" | "HOLD_CONFIRM" | "HOLD_MANUAL";
export type FilterScope = "BANK_WIDE" | "ACCOUNT";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "TIMEOUT";

export type HtlcAuthStatus =
  | "AUTH_REQUESTED"
  | "AUTH_APPROVED"
  | "AUTH_DECLINED"
  | "CAPTURED"
  | "VOIDED"
  | "EXPIRED";

export type IgsStatus = "REQUESTED" | "SETTLED" | "FAILED" | "HOLD" | "TIMEOUT";
export type ExternalSettlementStatus = "NONE" | "REQUESTED" | "SETTLED" | "FAILED" | "HOLD";

export type VerificationStatus =
  | "PENDING"
  | "MATCHED"
  | "UNMATCHED"
  | "NOT_FOUND"
  | "ERROR"
  | "EXPIRED";

export type NotificationStatus = "PENDING" | "DELIVERED" | "FAILED" | "EXPIRED";

export type QrType = "STATIC" | "DYNAMIC";

/**
 * @deprecated Use {@link RtpState} instead. In 0025_rtp_consolidate.sql
 * RtpState is unified state set after consolidating RtpRequests.state and rtp_status.
 */
export type RtpFullStatus = RtpState;

export type RichDataType = "EDI" | "INVOICE" | "ATTACHMENT_META" | "REMITTANCE";

export type CrossBorderStatus =
  | "INITIATED"
  | "ROUTED"
  | "FOREIGN_ACCEPTED"
  | "SETTLED"
  | "FAILED"
  | "RETURNED";

export type StreamEventType =
  | "tx_state_change"
  | "credit_notification"
  | "rtp_request"
  | "dns_status_change"
  | "igs_result"
  | "TX_STATE_CHANGED"
  | "CREDIT_RECEIVED"
  | "IGS_SETTLED"
  | "DNS_KICKED"
  | "RTP_RECEIVED"
  | "ACCOUNT_VERIFIED"
  | "QR_PAYMENT_RECEIVED"
  | "CROSS_BORDER_UPDATED";

export type ParticipationMode = "FULL" | "RECEIVE_ONLY" | "SEND_ONLY";

export type MessageFormat = "ZENITH_NATIVE" | "ISO20022" | "ZENGIN_FIXED";

export type ProxyType = "PHONE" | "EMAIL" | "NATIONAL_ID";
