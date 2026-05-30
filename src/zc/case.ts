/**
 * @file CASE management — dispute/exception case creation and state updates.
 *       Tracks OPEN -> IN_PROGRESS -> RESOLVED/ESCALATED lifecycle.
 * @module zc/case
 */
import type { CaseState } from "../types";
import { nowISO } from "../types";
import { newUUID } from "../shared/idempotency";
import {
  buildEntityStateLogInsert,
  transitionEntityWithLog,
} from "../shared/entity_state_log";

export interface OpenCaseInput {
  related_txid?: string;
  related_gtid?: string;
  reason_code: string;
  description?: string;
  opened_by: "ZC" | "BANK" | "OPS";
}

/**
 * CASE起票
 */
export async function openCase(db: D1Database, input: OpenCaseInput): Promise<string> {
  const caseId = `CASE-${newUUID()}`;
  const now = nowISO();

  await db.batch([
    db
      .prepare(
        `INSERT INTO Cases
     (case_id, related_txid, related_gtid, state, reason_code, description, opened_by, created_at, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`
      )
      .bind(
        caseId,
        input.related_txid ?? null,
        input.related_gtid ?? null,
        input.reason_code,
        input.description ?? null,
        input.opened_by,
        now,
        now
      ),
    buildEntityStateLogInsert(db, {
      entityType: "CASE",
      entityId: caseId,
      eventType: "CaseOpened",
      stateFrom: null,
      stateTo: "OPEN",
      reasonCode: input.reason_code,
      actor: input.opened_by,
      payload: {
        related_txid: input.related_txid ?? null,
        related_gtid: input.related_gtid ?? null,
      },
    }),
  ]);

  // Transactions に case_id を紐付け
  if (input.related_txid) {
    await db
      .prepare(`UPDATE Transactions SET case_id=?, updated_at=? WHERE txid=?`)
      .bind(caseId, now, input.related_txid)
      .run();
  }

  return caseId;
}

/**
 * CASE状態update
 */
export async function updateCase(
  db: D1Database,
  caseId: string,
  newState: CaseState,
  resolvedAt?: string
): Promise<void> {
  const now = nowISO();
  const cur = await db
    .prepare(`SELECT state FROM Cases WHERE case_id = ?`)
    .bind(caseId)
    .first<{ state: string }>();
  if (!cur || cur.state === newState) return;

  await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE Cases SET state=?, resolved_at=COALESCE(?, resolved_at), updated_at=? WHERE case_id=? AND state=?`,
      binds: [newState, resolvedAt ?? null, now, caseId, cur.state],
    },
    transition: {
      entityType: "CASE",
      entityId: caseId,
      eventType: "CaseStateChanged",
      stateFrom: cur.state,
      stateTo: newState,
    },
  });
}

/**
 * CASE を解決状態へ自動遷移させる（状態進展による自動収束）
 */
export async function autoResolveCaseForTx(db: D1Database, txid: string): Promise<void> {
  const row = await db
    .prepare(`SELECT case_id FROM Transactions WHERE txid=? AND case_id IS NOT NULL`)
    .bind(txid)
    .first<{ case_id: string }>();
  if (row?.case_id) {
    const c = await db
      .prepare(`SELECT state FROM Cases WHERE case_id=?`)
      .bind(row.case_id)
      .first<{ state: string }>();
    if (c && (c.state === "OPEN" || c.state === "IN_PROGRESS")) {
      await updateCase(db, row.case_id, "RESOLVED", nowISO());
    }
  }
}

export async function autoResolveCaseForGtid(db: D1Database, gtid: string): Promise<void> {
  const cases = await db
    .prepare(`SELECT case_id FROM Cases WHERE related_gtid=? AND state IN ('OPEN', 'IN_PROGRESS')`)
    .bind(gtid)
    .all<{ case_id: string }>();
  for (const c of cases?.results ?? []) {
    await updateCase(db, c.case_id, "RESOLVED", nowISO());
  }
}
