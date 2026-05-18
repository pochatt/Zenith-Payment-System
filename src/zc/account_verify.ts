/**
 * @file Pre-payment account verification (name-check). Queries target bank via
 *       ZC ingress to verify account holder name before payment.
 * @module zc/account_verify
 */
import type {
  Env,
  AccountVerificationRow,
  AccountVerifyRequest,
  AccountVerifyBatchRequest,
  BankAccountVerifyRequest,
  BankAccountVerifyResponse,
  VerificationStatus,
} from "../types";
import { nowISO } from "../types";
import { newUUID } from "../shared/idempotency";
import { signPayload } from "../shared/hmac";

// ---------------------------------------------------------------------------
// requestAccountVerification
// ---------------------------------------------------------------------------
/**
 * 口座確認リクエストを作成し、対象銀行の ZC Ingress API を呼ぶ。
 * キャッシュヒット時は銀行呼び出しをスキップする。
 *
 * @returns verification_id
 */
export async function requestAccountVerification(
  db: D1Database,
  req: AccountVerifyRequest,
  env: Env
): Promise<string> {
  const now = nowISO();

  // 冪等チェック: 同じ idempotency_key が存在すれば既存 ID を返す
  const existing = await db
    .prepare(`SELECT verification_id FROM AccountVerifications WHERE idempotency_key = ?`)
    .bind(req.idempotency_key)
    .first<{ verification_id: string }>();
  if (existing) return existing.verification_id;

  // アカウントハッシュ（account_id をそのままハッシュ相当として使用）
  const accountHash = req.target_account_id;

  // キャッシュ確認: 同一 (target_bank_id, target_account_hash) で有効期限内のレコードを探す
  const cached = await db
    .prepare(
      `SELECT * FROM AccountVerifications
       WHERE target_bank_id = ?
         AND target_account_hash = ?
         AND status IN ('MATCHED', 'UNMATCHED', 'NOT_FOUND')
         AND cached_until IS NOT NULL
         AND cached_until > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(req.target_bank_id, accountHash, now)
    .first<AccountVerificationRow>();

  if (cached) {
    // キャッシュヒット: 新しいレコードをキャッシュ結果でコピー作成
    const newId = req.verification_id;
    await db
      .prepare(
        `INSERT OR IGNORE INTO AccountVerifications
       (verification_id, request_bank_id, target_bank_id, target_account_hash,
        target_account_name, status, name_provided, match_score, fraud_warning,
        cached_until, idempotency_key, created_at, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId,
        req.request_bank_id,
        req.target_bank_id,
        accountHash,
        cached.target_account_name,
        cached.status,
        req.name_to_verify ?? null,
        cached.match_score,
        cached.fraud_warning,
        cached.cached_until,
        req.idempotency_key,
        now,
        now
      )
      .run();
    return newId;
  }

  // 新規レコードを PENDING で挿入
  await db
    .prepare(
      `INSERT OR IGNORE INTO AccountVerifications
     (verification_id, request_bank_id, target_bank_id, target_account_hash,
      target_account_name, status, name_provided, match_score, fraud_warning,
      idempotency_key, created_at)
     VALUES (?, ?, ?, ?, NULL, 'PENDING', ?, NULL, 0, ?, ?)`
    )
    .bind(
      req.verification_id,
      req.request_bank_id,
      req.target_bank_id,
      accountHash,
      req.name_to_verify ?? null,
      req.idempotency_key,
      now
    )
    .run();

  // 対象銀行の ZC Ingress API を呼ぶ
  const bankPayload: BankAccountVerifyRequest = {
    verification_id: req.verification_id,
    account_id: req.target_account_id,
    name_to_verify: req.name_to_verify,
  };
  const idemKey = `AV-${req.verification_id}`;

  try {
    const url = `${env.BANK_BASE_URL}/bank/${req.target_bank_id}/zc-ingress/account-verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZC-Signature": await signPayload(bankPayload, env.ZC_HMAC_SECRET),
        "X-Idempotency-Key": idemKey,
      },
      body: JSON.stringify(bankPayload),
    });

    if (res.ok) {
      const bankResp = (await res.json()) as BankAccountVerifyResponse;
      await handleBankVerifyResponse(db, req.verification_id, bankResp);
    } else {
      const errText = await res.text().catch(() => "");
      console.error("[AccountVerify] bank call failed:", res.status, errText);
      await db
        .prepare(
          `UPDATE AccountVerifications
         SET status = 'ERROR', responded_at = ?
         WHERE verification_id = ?`
        )
        .bind(now, req.verification_id)
        .run();
    }
  } catch (err) {
    console.error("[AccountVerify] fetch error:", err);
    await db
      .prepare(
        `UPDATE AccountVerifications
       SET status = 'ERROR', responded_at = ?
       WHERE verification_id = ?`
      )
      .bind(now, req.verification_id)
      .run();
  }

  return req.verification_id;
}

// ---------------------------------------------------------------------------
// handleBankVerifyResponse
// ---------------------------------------------------------------------------
/**
 * 銀行からの口座確認レスポンスを AccountVerifications テーブルに反映する。
 */
export async function handleBankVerifyResponse(
  db: D1Database,
  verificationId: string,
  response: BankAccountVerifyResponse
): Promise<void> {
  const now = nowISO();

  let status: VerificationStatus;
  let targetAccountName: string | null = null;
  let matchScore: number | null = null;
  let fraudWarning = 0;
  // キャッシュ有効期限: MATCHED/UNMATCHED は 24 時間、NOT_FOUND は 1 時間
  let cachedUntil: string | null = null;

  switch (response.result) {
    case "MATCHED": {
      status = "MATCHED";
      targetAccountName = response.account_name;
      matchScore = response.match_score;
      fraudWarning = response.fraud_warning ? 1 : 0;
      cachedUntil = addSeconds(now, 86400); // 24h
      break;
    }
    case "UNMATCHED": {
      status = "UNMATCHED";
      targetAccountName = response.account_name;
      matchScore = response.match_score;
      cachedUntil = addSeconds(now, 86400); // 24h
      break;
    }
    case "NOT_FOUND": {
      status = "NOT_FOUND";
      cachedUntil = addSeconds(now, 3600); // 1h
      break;
    }
    case "FROZEN": {
      status = "ERROR";
      break;
    }
    case "ERROR":
    default: {
      status = "ERROR";
      break;
    }
  }

  await db
    .prepare(
      `UPDATE AccountVerifications
     SET status = ?,
         target_account_name = ?,
         match_score = ?,
         fraud_warning = ?,
         cached_until = ?,
         responded_at = ?
     WHERE verification_id = ?`
    )
    .bind(status, targetAccountName, matchScore, fraudWarning, cachedUntil, now, verificationId)
    .run();
}

// ---------------------------------------------------------------------------
// getVerificationResult
// ---------------------------------------------------------------------------
/** verification_id に紐付く AccountVerifications レコードを返す。 */
export async function getVerificationResult(
  db: D1Database,
  verificationId: string
): Promise<AccountVerificationRow | null> {
  return db
    .prepare(`SELECT * FROM AccountVerifications WHERE verification_id = ?`)
    .bind(verificationId)
    .first<AccountVerificationRow>();
}

// ---------------------------------------------------------------------------
// batchVerify
// ---------------------------------------------------------------------------
/**
 * 複数口座の確認を一括で実行する。
 * 各アイテムに対して requestAccountVerification を呼び、結果配列を返す。
 */
export async function batchVerify(
  db: D1Database,
  req: AccountVerifyBatchRequest,
  env: Env
): Promise<Array<{ verification_id: string; status: VerificationStatus }>> {
  const results: Array<{ verification_id: string; status: VerificationStatus }> = [];

  for (let i = 0; i < req.items.length; i++) {
    const item = req.items[i];
    if (!item) continue;
    const verificationId = newUUID();
    const itemIdemKey = `${req.idempotency_key}-${i}`;

    try {
      const vid = await requestAccountVerification(
        db,
        {
          verification_id: verificationId,
          request_bank_id: req.request_bank_id,
          target_bank_id: item.target_bank_id,
          target_account_id: item.target_account_id,
          name_to_verify: item.name_to_verify,
          idempotency_key: itemIdemKey,
        },
        env
      );

      const row = await getVerificationResult(db, vid);
      results.push({
        verification_id: vid,
        status: (row?.status ?? "ERROR") as VerificationStatus,
      });
    } catch (err) {
      console.error("[AccountVerify] batch item error:", err);
      results.push({ verification_id: verificationId, status: "ERROR" });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
/** ISO 文字列に秒数を加算して新しい ISO 文字列を返す */
function addSeconds(isoStr: string, secs: number): string {
  return new Date(new Date(isoStr).getTime() + secs * 1000).toISOString();
}
