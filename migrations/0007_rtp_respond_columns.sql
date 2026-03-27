-- 0007: RtpRequests に respondToRtp が必要とするカラムを追加

ALTER TABLE RtpRequests ADD COLUMN linked_txid_new TEXT;
ALTER TABLE RtpRequests ADD COLUMN payer_account_id TEXT;
ALTER TABLE RtpRequests ADD COLUMN response_type TEXT;
ALTER TABLE RtpRequests ADD COLUMN responded_at TEXT;
