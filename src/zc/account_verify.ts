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
 * accountconfirmationリクエストをcreateし、Call target bank's ZC Ingress API。
 * cacheヒット時はbank呼び出しをスキップする。
 *
 * @returns verification_id
 */
export async function requestAccountVerification(
  db: D1Database,
  req: AccountVerifyRequest,
  env: Env
): Promise<string> {
  const now = nowISO();

  // idempotentcheck: if same idempotency_key exists, return existing ID
  const existing = await db
    .prepare(`SELECT verification_id FROM AccountVerifications WHERE idempotency_key = ?`)
    .bind(req.idempotency_key)
    .first<{ verification_id: string }>();
  if (existing) return existing.verification_id;

  // account hash (use account_id directly as hash)
  const accountHash = req.target_account_id;

  // Cache check: find record with same (bank, hash) within deadline
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
    // Cache hit: copy-create from cache result
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

  // Insert new record as PENDING
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

  // Call target bank's ZC Ingress API
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
 * bankからのaccountconfirmationレスポンスを AccountVerifications tableに反映する。
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
  // Cache expiry: MATCHED/UNMATCHED 24h, NOT_FOUND 1h
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
/** verification_id に紐付く AccountVerifications レコードをreturn。 */
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
 * 複数accountのconfirmationを一括で実行する。
 * 各アイテムに対して requestAccountVerification を呼び、結果arrayをreturn。
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
// Helpers
// ---------------------------------------------------------------------------
/** ISO 文字列に秒数を加算して新しい ISO 文字列をreturn */
function addSeconds(isoStr: string, secs: number): string {
  return new Date(new Date(isoStr).getTime() + secs * 1000).toISOString();
}
