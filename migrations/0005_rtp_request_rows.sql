-- 0005: RtpRequestRows テーブル作成（0002 で漏れていたテーブルを追加）
-- 0004 の ALTER TABLE は既に失敗しているため、全カラムを含めて CREATE TABLE IF NOT EXISTS する

CREATE TABLE IF NOT EXISTS RtpRequestRows (
  rtp_id          TEXT PRIMARY KEY,
  payee_bank_id   TEXT NOT NULL,
  payer_bank_id   TEXT NOT NULL,
  amount_value    INTEGER NOT NULL,
  rtp_status      TEXT NOT NULL DEFAULT 'CREATED',
  payee_name      TEXT,
  payer_account_id TEXT,
  description     TEXT,
  edi_ref         TEXT,
  linked_txid     TEXT,
  linked_txid_new TEXT,
  expires_at      TEXT NOT NULL,
  notified_at     TEXT,
  responded_at    TEXT,
  response_type   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rtp_request_rows_payer_bank
  ON RtpRequestRows (payer_bank_id, rtp_status, expires_at);

CREATE INDEX IF NOT EXISTS idx_rtp_request_rows_payee_bank
  ON RtpRequestRows (payee_bank_id);
