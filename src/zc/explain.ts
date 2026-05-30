/**
 * @file explain.ts — Operational explainability for a transaction.
 *
 * Renders the FinalityLog chain plus current transaction state as a single
 * human-oriented structure: each state transition is paired with a plain-
 * language reason, and the response carries the tamper-evidence verification
 * so callers can trust what they read.
 */
import { verifyChain, CHAIN_ALGORITHM } from "./finality_chain";

interface TransactionSnapshot {
  txid: string;
  lane: string;
  state: string;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payee_bank_id: string;
  reason_code: string | null;
  decision_proof_ref: string | null;
  finality_log_ref: string | null;
  payer_bank_proof_ref: string | null;
  payee_bank_proof_ref: string | null;
  case_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FinalityRow {
  log_id: string;
  event_type: string;
  state_from: string | null;
  state_to: string;
  event_seq: number;
  occurred_at: string;
  payload_json: string;
  prev_hash: string | null;
  entry_hash: string | null;
}

export interface TimelineItem {
  seq: number;
  at: string;
  event: string;
  state_from: string | null;
  state_to: string;
  reason: string;
  actors: string[];
  payload: unknown;
}

/**
 * Event-type → 日本語 reason. Keys match FinalityEventType. Unknown events fall
 * back to a generic label so new event types do not break the endpoint.
 */
const EVENT_REASONS: Record<string, { reason: string; actors: string[] }> = {
  PaymentInitiated: { reason: "Payment request received", actors: ["ZC"] },
  PreCheckPassed: { reason: "Pre-validation (amount, balance, destination) passed", actors: ["ZC"] },
  PreCheckFailed: { reason: "Pre-validation failed", actors: ["ZC"] },
  HReserved: { reason: "送金元銀行で資金を確保しました（H予約）", actors: ["ZC", "PAYER_BANK"] },
  DecidedToSettle: { reason: "Decision to finalize settlementしました", actors: ["ZC"] },
  DecidedCancel: { reason: "決済のDecision to abortしました", actors: ["ZC"] },
  PayerExecConfirmed: { reason: "Debit confirmed at payer bank", actors: ["PAYER_BANK"] },
  PayeeExecConfirmed: { reason: "Credit confirmed at payee bank", actors: ["PAYEE_BANK"] },
  Settled: { reason: "Payment finalized", actors: ["ZC"] },
  Suspended: { reason: "Anomaly detected; transaction on hold (investigation required)", actors: ["ZC"] },
  FailedExecution: { reason: "実行中にエラーが発生しました", actors: ["ZC"] },
  Cancelled: { reason: "取引は取り消されました", actors: ["ZC"] },
  HtlcCreated: { reason: "条件付き決済（Hash-Time-Locked Contract）が作成されました", actors: ["ZC"] },
  HtlcLocked: { reason: "Hash-Time-Locked Contract の資金がロックされました", actors: ["PAYER_BANK"] },
  HtlcFulfillRequested: {
    reason: "Hash-Time-Locked Contract の解錠（プリイメージ提示）が行われました",
    actors: ["PAYEE_BANK"],
  },
  HtlcCancelled: { reason: "Hash-Time-Locked Contract がタイムアウトまたはキャンセルされました", actors: ["ZC"] },
  GtidRegistered: { reason: "多脚協調取引（GTID）を登録しました", actors: ["ZC"] },
  GtidDecided: { reason: "全脚の準備完了によりGTIDを確定しました", actors: ["ZC"] },
  GtidSettled: { reason: "GTID の全脚が決済完了しました", actors: ["ZC"] },
  RtpRequested: { reason: "Request-to-Pay (RTP) issued by the payee", actors: ["PAYEE_BANK"] },
  DnsKicked: { reason: "DNS サイクルを起動しました", actors: ["ZC"] },
  DnsSettled: { reason: "DNS ネット清算が完了しました", actors: ["ZC"] },
  DnsHoldActivated: { reason: "DNS サイクルをホールドしました", actors: ["ZC"] },
  FilterRejected: { reason: "Rejected by payee bank's credit filterされました", actors: ["PAYEE_BANK"] },
  FilterPending: {
    reason: "受取側の承認待ちで保留されています",
    actors: ["PAYEE_BANK", "CUSTOMER"],
  },
  ApprovalGranted: { reason: "Payee customer approves creditしました", actors: ["CUSTOMER"] },
  ApprovalDenied: { reason: "Payee customer rejects creditしました", actors: ["CUSTOMER"] },
  HtlcAuthRequested: {
    reason: "Hash-Time-Locked Contract オーソリ（受取側起点）を要求しました",
    actors: ["PAYEE_BANK"],
  },
  HtlcAuthApproved: { reason: "送金側が Hash-Time-Locked Contract オーソリを承認しました", actors: ["PAYER_BANK"] },
  HtlcAuthDeclined: { reason: "送金側が Hash-Time-Locked Contract オーソリを拒否しました", actors: ["PAYER_BANK"] },
  HtlcCaptured: { reason: "Hash-Time-Locked Contract オーソリをキャプチャしました", actors: ["PAYEE_BANK"] },
  HtlcVoided: { reason: "Hash-Time-Locked Contract オーソリを無効化しました", actors: ["ZC"] },
};

/** Top-level summary derived from the current transaction state. */
const STATE_SUMMARIES: Record<string, string> = {
  RECEIVED: "Immediately after the transaction was received",
  PRECHECKED: "Pre-validation passed; awaiting next processing step",
  H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held): "Funds are secured at the payer's bank",
  DECIDED_TO_SETTLE: "Decision to finalize settlement済みで、銀行での入出金処理中です",
  DECIDED_CANCEL: "決済Decision to abort済みで、後処理中です",
  SETTLED: "Payment has been finalized successfully",
  CANCELLED: "Transaction cancelledされました",
  SUSPENDED: "On hold due to anomaly detection. Staff investigation required",
  FAILED: "実行エラーにより失敗しました",
};

export interface ExplainResult {
  txid: string;
  lane: string;
  current_state: string;
  summary: string;
  reason_code: string | null;
  case_id: string | null;
  amount: { value: number; currency: string };
  parties: { payer_bank_id: string; payee_bank_id: string };
  timeline: TimelineItem[];
  integrity: {
    chain_verified: boolean;
    entries_checked: number;
    break_at_seq: number | null;
    break_reason: string | null;
    algorithm: string;
  };
  proofs: {
    decision_proof_ref: string | null;
    finality_log_ref: string | null;
    payer_bank_proof_ref: string | null;
    payee_bank_proof_ref: string | null;
  };
  timestamps: { created_at: string; updated_at: string };
}

export async function explainTransaction(
  db: D1Database,
  txid: string
): Promise<ExplainResult | null> {
  const tx = await db
    .prepare(
      `SELECT txid, lane, state, amount_value, amount_currency,
              payer_bank_id, payee_bank_id, reason_code,
              decision_proof_ref, finality_log_ref,
              payer_bank_proof_ref, payee_bank_proof_ref, case_id,
              created_at, updated_at
       FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<TransactionSnapshot>();
  if (!tx) return null;

  const flRows = await db
    .prepare(
      `SELECT log_id, event_type, state_from, state_to, event_seq,
              occurred_at, payload_json, prev_hash, entry_hash
       FROM FinalityLog WHERE txid = ?
       ORDER BY event_seq ASC`
    )
    .bind(txid)
    .all<FinalityRow>();

  const timeline: TimelineItem[] = flRows.results.map((row) => {
    const meta = EVENT_REASONS[row.event_type] ?? { reason: row.event_type, actors: ["ZC"] };
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
    return {
      seq: row.event_seq,
      at: row.occurred_at,
      event: row.event_type,
      state_from: row.state_from,
      state_to: row.state_to,
      reason: meta.reason,
      actors: meta.actors,
      payload,
    };
  });

  const integrity = await verifyChain(db, txid);
  const summary = STATE_SUMMARIES[tx.state] ?? `状態: ${tx.state}`;

  return {
    txid: tx.txid,
    lane: tx.lane,
    current_state: tx.state,
    summary,
    reason_code: tx.reason_code,
    case_id: tx.case_id,
    amount: { value: tx.amount_value, currency: tx.amount_currency },
    parties: { payer_bank_id: tx.payer_bank_id, payee_bank_id: tx.payee_bank_id },
    timeline,
    integrity: {
      chain_verified: integrity.valid,
      entries_checked: integrity.entries_checked,
      break_at_seq: integrity.break_at_seq,
      break_reason: integrity.break_reason,
      algorithm: CHAIN_ALGORITHM,
    },
    proofs: {
      decision_proof_ref: tx.decision_proof_ref,
      finality_log_ref: tx.finality_log_ref,
      payer_bank_proof_ref: tx.payer_bank_proof_ref,
      payee_bank_proof_ref: tx.payee_bank_proof_ref,
    },
    timestamps: { created_at: tx.created_at, updated_at: tx.updated_at },
  };
}
