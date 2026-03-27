-- 0008: RtpRequests に payee_account_hash カラムを追加
-- respondToRtp で Transactions の payee_account_hash を正しく設定するために必要
ALTER TABLE RtpRequests ADD COLUMN payee_account_hash TEXT;
