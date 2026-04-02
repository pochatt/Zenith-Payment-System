-- Add CASE auto-classification column (AUTO_RESOLVABLE / AUTO_PROGRESS / MANUAL_ONLY)
ALTER TABLE Cases ADD COLUMN classification TEXT DEFAULT 'MANUAL_ONLY';

-- Add daily_amount_used column to Participants (referenced by EOD reset)
ALTER TABLE Participants ADD COLUMN daily_amount_used INTEGER DEFAULT 0;
