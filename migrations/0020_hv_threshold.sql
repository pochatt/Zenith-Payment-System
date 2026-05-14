-- =============================================================================
-- 0020_hv_threshold.sql
--
-- Add per-participant HIGH_VALUE lane auto-routing threshold.
-- When a payment amount >= hv_threshold, ZC automatically escalates the lane
-- to HIGH_VALUE (RTGS via IGS) regardless of the requested lane.
-- NULL means "use the system-wide default" (ZC_HV_THRESHOLD env var, default 100,000,000 JPY).
-- =============================================================================

ALTER TABLE Participants ADD COLUMN hv_threshold INTEGER;
