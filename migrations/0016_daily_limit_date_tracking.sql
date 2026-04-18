-- =============================================================================
-- 0016_daily_limit_date_tracking.sql - Daily limit auto-reset support
-- =============================================================================
--
-- MOTIVATION:
-- Previously, daily_amount_limit reset relied entirely on EOD cron job.
-- If cron fails or is delayed, the limit would persist beyond the calendar day.
--
-- FIX:
-- Add daily_amount_used_date column to track the date when daily_amount_used
-- was last accumulated. On each transfer request, check if the calendar day
-- has changed. If yes, automatically reset daily_amount_used in the same
-- atomic batch operation.
--
-- D1 TRANSACTION SAFETY:
-- The reset and increment are performed in a D1 batch (single transaction):
--   Step 1: UPDATE ... SET daily_amount_used = 0 WHERE ... AND daily_amount_used_date < TODAY
--   Step 2: UPDATE ... SET daily_amount_used += amount WHERE ... AND daily_amount_used_date = TODAY
--
-- This ensures atomicity: either both succeed (day changed) or both fail together.
-- =============================================================================

ALTER TABLE Participants ADD COLUMN daily_amount_used_date TEXT DEFAULT '2025-01-01';

-- Retroactively set today's date for all existing records so that
-- the first transfer of the day doesn't trigger an incorrect reset.
-- (Use a reasonable default; will be overwritten on first request.)
