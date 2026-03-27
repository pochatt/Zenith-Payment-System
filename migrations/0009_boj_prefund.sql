-- =============================================================================
-- 0009_boj_prefund.sql  プレファンドRTGS: 日銀当座預金初期残高
-- HIGH_VALUE レーンはプレファンド型RTGS（即時グロス決済）のため、
-- 各参加行が日銀当座に事前積立した残高をシード。
--
-- 仕訳: ZCS(+prefund) / BOJ(-prefund) = 0 ゼロサム ✓
--   ZCS(+): 行がZCに預け入れた積立義務（ZCが管理するプレファンド）
--   BOJ(-): 日銀当座残高（マイナス = 積立残高あり）
--
-- BOJ残高の符号規則（全テーブル共通）:
--   BOJ(+): 支払超（日銀当座残高を消費した）
--   BOJ(-): 受取超 or 積立残（日銀当座残高がある）
--
-- プレファンドチェック式: calcBalance('{bankId}-BOJ') + amount > 0 → 残高不足
-- =============================================================================

-- 001行（みずほ）: プレファンド 10,000,000 円
INSERT OR IGNORE INTO BankJournals
  (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
VALUES
  ('JNL-BOJ-INIT-001-ZCS', '001', '001-ZCS',  10000000, 'CASH', 'BOJ-INIT-001',
   'RTGS プレファンド積立 ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-001-BOJ', '001', '001-BOJ', -10000000, 'CASH', 'BOJ-INIT-001',
   'RTGS プレファンド積立 BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z');

-- 002行（三菱UFJ）: プレファンド 10,000,000 円
INSERT OR IGNORE INTO BankJournals
  (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
VALUES
  ('JNL-BOJ-INIT-002-ZCS', '002', '002-ZCS',  10000000, 'CASH', 'BOJ-INIT-002',
   'RTGS プレファンド積立 ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-002-BOJ', '002', '002-BOJ', -10000000, 'CASH', 'BOJ-INIT-002',
   'RTGS プレファンド積立 BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z');
