-- =============================================================================
-- 0017_circuit_breaker_metrics.sql
-- Extend CircuitBreakerState with bounded HALF_OPEN probes and lifetime
-- traffic counters, so operators can observe per-bank reliability and the
-- HALF_OPEN recovery cannot stampede a freshly-recovering bank.
--
-- Columns:
--   total_requests       lifetime count of allowed requests (CLOSED + HALF_OPEN)
--   total_successes      lifetime count of recordSuccess() calls
--   total_failures       lifetime count of recordFailure() calls
--   total_denied         lifetime count of fast-failed requests (state=OPEN)
--   half_open_inflight   probes currently outstanding while state=HALF_OPEN
--   last_success_at      ISO-8601 timestamp of the most recent success
-- =============================================================================

ALTER TABLE CircuitBreakerState ADD COLUMN total_requests     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE CircuitBreakerState ADD COLUMN total_successes    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE CircuitBreakerState ADD COLUMN total_failures     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE CircuitBreakerState ADD COLUMN total_denied       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE CircuitBreakerState ADD COLUMN half_open_inflight INTEGER NOT NULL DEFAULT 0;
ALTER TABLE CircuitBreakerState ADD COLUMN last_success_at    TEXT;
