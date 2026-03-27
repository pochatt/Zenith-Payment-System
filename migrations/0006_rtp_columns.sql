-- 0006: RtpRequests / RtpRequestRows カラム追加（registerRtpRequest が必要とするカラム）

ALTER TABLE RtpRequests ADD COLUMN rtp_status TEXT NOT NULL DEFAULT 'CREATED';
ALTER TABLE RtpRequests ADD COLUMN payee_name TEXT;
ALTER TABLE RtpRequests ADD COLUMN description TEXT;
ALTER TABLE RtpRequests ADD COLUMN edi_ref TEXT;
ALTER TABLE RtpRequests ADD COLUMN notified_at TEXT;
