-- =============================================================================
-- 0013_retained_earnings_account.sql
-- Add Retained Earnings (RE) internal account type to prevent interest accrual
-- from polluting the suspense account balance.
-- =============================================================================

-- BankAccounts.account_type は TEXT なので新しい値を自由に使える。
-- seed で作成される銀行ごとに RE 口座を挿入する。
-- 既存の銀行（001, 002）向けのデフォルトレコード。
-- 新規銀行は handleSeed / handleAddBank で自動作成される。
INSERT OR IGNORE INTO BankAccounts
  (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
VALUES
  ('001-RE', '001', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('002-RE', '002', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', '2025-01-01T00:00:00Z');
