-- =============================================================================
-- 0011_fix_gtid_legs.sql  GtidLegs.txid インデックス追加
-- GtidLegs を txid で検索するクエリ（orchestrator.ts: onPayeeExecConfirmed / suspendTx）
-- が毎回フルテーブルスキャンになっていたため、インデックスを追加する。
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_legs_txid ON GtidLegs(txid);
