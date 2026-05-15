-- =============================================================================
-- 0021_finality_seq_counter.sql
--
-- B10: Replace the `Date.now()*1000 + random` event_seq allocation in
--      writeFinalityLog with a real monotonic counter. The previous scheme
--      relied on wall-clock + random jitter for ordering, with a UNIQUE
--      retry as the only safety net — fine for a single-isolate dev
--      environment but a fragile foundation for an append-only audit
--      ledger.
--
-- Design:
--   - Single-row counter table (id = 1 enforced by CHECK constraint).
--   - Allocator does `UPDATE FinalitySeq SET next_seq = next_seq + 1
--     WHERE id = 1 RETURNING next_seq` which is atomic in SQLite/D1.
--   - Seeded from MAX(event_seq) so monotonicity is preserved across
--     migration even if FinalityLog already contains rows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS FinalitySeq (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq  INTEGER NOT NULL
);

-- Seed the counter at MAX(event_seq) so the first allocated seq is strictly
-- greater than any pre-existing entry. INSERT OR IGNORE makes the seed
-- idempotent on re-application.
INSERT OR IGNORE INTO FinalitySeq (id, next_seq)
VALUES (1, COALESCE((SELECT MAX(event_seq) FROM FinalityLog), 0));
