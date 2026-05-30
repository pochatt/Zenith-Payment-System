/**
 * @file state_machine.ts — Transaction state transition validator.
 *
 * Single source of truth for ALLOWED_TRANSITIONS. All state changes in the
 * system must pass through isValidTransition before being committed.
 */
import type { TxState } from "../../types";

/** Exhaustive map of allowed state transitions in the transaction lifecycle. */
export const ALLOWED_TRANSITIONS: Record<TxState, TxState[]> = {
  RECEIVED: ["PRECHECKED", "Hash-Time-Locked Contract_LOCKED", "DECIDED_CANCEL"],
  PRECHECKED: ["PRECHECKED_SUSPENDED", "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)", "DECIDED_CANCEL", "DECIDED_TO_SETTLE"], // HIGH_VALUE は PRECHECKED → DECIDED_TO_SETTLE
  PRECHECKED_SUSPENDED: ["PRECHECKED", "DECIDED_CANCEL"],
  H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held): ["DECIDED_TO_SETTLE", "DECIDED_CANCEL"],
  DECIDED_TO_SETTLE: ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "SUSPENDED"], // PAYEE_EXEC_CONFIRMED: GTID PAYEEleg はデビット不要で直接クレジット確認
  DECIDED_CANCEL: ["CANCELLED"],
  PAYER_EXEC_CONFIRMED: ["PAYEE_EXEC_CONFIRMED", "SUSPENDED"],
  PAYEE_EXEC_CONFIRMED: ["SETTLED"],
  SUSPENDED: ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "FAILED_EXECUTION"],
  SETTLED: [],
  FAILED_EXECUTION: [],
  CANCELLED: [],
  Hash-Time-Locked Contract_LOCKED: ["Hash-Time-Locked Contract_FULFILL_REQUESTED", "DECIDED_CANCEL"],
  Hash-Time-Locked Contract_FULFILL_REQUESTED: ["DECIDED_TO_SETTLE", "FAILED_EXECUTION"],
};

/**
 * Check whether a state transition is permitted by the state machine.
 *
 * @param from - Current transaction state
 * @param to   - Target transaction state
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: TxState, to: TxState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
