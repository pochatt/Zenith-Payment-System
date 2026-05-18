/**
 * @file Integration tests for src/zc/h_model.ts
 *
 * Verifies that H-limit reserve / lock / release correctly maintain the
 * h_used counter on the Participants table.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { reserveH, lockH, releaseH, getHStatus } from "../../src/zc/h_model";

const BANK_ID = "001";
const H_LIMIT = 1_000_000;

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  // Participants テーブルに行を挿入（0002 の初期データは BankAccounts のみなので手動）
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/001', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(BANK_ID, H_LIMIT)
    ._runSync();
});

describe("reserveH", () => {
  it("creates a reservation and increments h_used", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 100_000, d1 as any);
    expect(hResult.ok).toBe(true);
    if (hResult.ok) expect(hResult.reservation_id.startsWith("H-")).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(100_000);
  });

  it("returns ok=false with reason H_LIMIT_EXCEEDED when h_limit would be exceeded", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", H_LIMIT + 1, d1 as any);
    expect(hResult.ok).toBe(false);
    if (!hResult.ok) expect(hResult.reason).toBe("H_LIMIT_EXCEEDED");

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("returns ok=false with reason BANK_NOT_FOUND for unknown bank", async () => {
    const hResult = await reserveH("999", "TX-001", 1_000, d1 as any);
    expect(hResult.ok).toBe(false);
    if (!hResult.ok) expect(hResult.reason).toBe("BANK_NOT_FOUND");
  });

  it("allows multiple reservations up to h_limit", async () => {
    const r1 = await reserveH(BANK_ID, "TX-001", 400_000, d1 as any);
    const r2 = await reserveH(BANK_ID, "TX-002", 600_000, d1 as any);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(1_000_000);
  });

  it("rejects the next reservation when h_limit is exactly met", async () => {
    await reserveH(BANK_ID, "TX-001", 1_000_000, d1 as any);
    const r2 = await reserveH(BANK_ID, "TX-002", 1, d1 as any);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("H_LIMIT_EXCEEDED");
  });
});

describe("lockH", () => {
  it("promotes a RESERVED reservation to LOCKED", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 50_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    const locked = await lockH(rid, d1 as any);
    expect(locked).toBe(true);

    const row = await d1
      .prepare(`SELECT mode FROM HReservations WHERE reservation_id=?`)
      .bind(rid)
      .first<{ mode: string }>();
    expect(row?.mode).toBe("LOCKED");
  });

  it("returns false for an already-released reservation", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 50_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);
    const locked = await lockH(rid, d1 as any);
    expect(locked).toBe(false);
  });

  it("returns false for a non-existent reservation id", async () => {
    const locked = await lockH("H-does-not-exist", d1 as any);
    expect(locked).toBe(false);
  });
});

describe("releaseH", () => {
  it("marks the reservation released and decrements h_used", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 200_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    const released = await releaseH(rid, d1 as any);
    expect(released).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("prevents double-release (idempotency guard)", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 200_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);
    const second = await releaseH(rid, d1 as any);
    expect(second).toBe(false);

    // h_used should still be 0 (not negative)
    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("restores capacity so new reservations can succeed", async () => {
    const hRes1 = await reserveH(BANK_ID, "TX-001", H_LIMIT, d1 as any);
    expect(hRes1.ok).toBe(true);
    const rid = hRes1.ok ? hRes1.reservation_id : "";
    // At this point h_used == h_limit; another reservation fails
    expect((await reserveH(BANK_ID, "TX-002", 1, d1 as any)).ok).toBe(false);

    await releaseH(rid, d1 as any);

    // After release the full limit is available again
    const r2 = await reserveH(BANK_ID, "TX-002", H_LIMIT, d1 as any);
    expect(r2.ok).toBe(true);
  });

  it("never allows h_used to go below zero", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 100_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);

    // Force a second release by directly resetting is_released
    d1.prepare(`UPDATE HReservations SET is_released=0 WHERE reservation_id=?`)
      .bind(rid)
      ._runSync();
    await releaseH(rid, d1 as any);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBeGreaterThanOrEqual(0);
  });
});
