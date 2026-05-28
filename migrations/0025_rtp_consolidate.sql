-- =============================================================================
-- 0025_rtp_consolidate.sql
-- RtpRequests.state + rtp_status の二重持ち、および RtpRequestRows の重複を統合。
--
--  - rtp_status (fine-grained: CREATED|NOTIFIED|ACCEPTED|TX_CREATED|COMPLETED|
--    DECLINED|EXPIRED|FAILED) を唯一の state 列に昇格。
--  - 旧 state (粗粒度: REQUESTED|ATTEMPTED|SETTLED|EXPIRED|FAILED) は廃止。
--    attemptRtp/settleRtp が state のみ書いて rtp_status を残置していた窓を解消。
--  - 支払銀行側の通知格納テーブル RtpRequestRows は RtpRequests と同一スキーマ
--    だったため廃止し、/api/rtp/incoming は RtpRequests を直接参照する。
-- =============================================================================

-- 1. state 列を参照するインデックスを先に落とす（SQLite は DROP COLUMN 時に
--    残存インデックスを許容しない）
DROP INDEX IF EXISTS idx_rtp_payer_state;
DROP INDEX IF EXISTS idx_rtp_payee_state;
DROP INDEX IF EXISTS idx_rtp_expires;

-- 2. 旧 state のみが更新されて rtp_status が古いまま残っているレコードを補正
UPDATE RtpRequests SET rtp_status = 'TX_CREATED'
  WHERE state = 'ATTEMPTED' AND rtp_status IN ('CREATED', 'NOTIFIED');
UPDATE RtpRequests SET rtp_status = 'COMPLETED'
  WHERE state = 'SETTLED' AND rtp_status <> 'COMPLETED';
UPDATE RtpRequests SET rtp_status = 'EXPIRED'
  WHERE state = 'EXPIRED' AND rtp_status <> 'EXPIRED';
UPDATE RtpRequests SET rtp_status = 'FAILED'
  WHERE state = 'FAILED' AND rtp_status IN ('CREATED', 'NOTIFIED');

-- 3. 旧 state 列を破棄して rtp_status を state にリネーム
ALTER TABLE RtpRequests DROP COLUMN state;
ALTER TABLE RtpRequests RENAME COLUMN rtp_status TO state;

-- 4. インデックスを新 state 列で再作成
CREATE INDEX IF NOT EXISTS idx_rtp_payer_state ON RtpRequests(payer_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_rtp_payee_state ON RtpRequests(payee_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_rtp_expires     ON RtpRequests(expires_at, state);

-- 5. 重複テーブル RtpRequestRows を削除
DROP INDEX IF EXISTS idx_rtp_request_rows_payer_bank;
DROP INDEX IF EXISTS idx_rtp_request_rows_payee_bank;
DROP TABLE IF EXISTS RtpRequestRows;
