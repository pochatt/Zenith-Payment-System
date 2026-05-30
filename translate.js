#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Comprehensive translation mapping
const translations = {
  // From first batch
  "口座番号から銀行コード (3桁) を取得": "Extract bank code (3 digits) from account number",
  "銀行コードから別段預金口座番号を生成": "Generate segregated deposit account number from bank code",
  "銀行コードから ZC清算勘定口座番号を生成": "Generate ZC settlement account number from bank code",
  "銀行コードから利益剰余金（Retained Earnings）口座番号を生成": "Generate retained earnings account number from bank code",
  "銀行コードから現金（Cash）口座番号を生成": "Generate cash account number from bank code",
  "口座番号が別段預金かどうか": "Check whether account number is a segregated deposit account",
  "次の口座番号を生成": "Generate the next account number",
  "証憑の内容ダイジェスト（監査用）": "Content digest of proof document (for audit purposes)",
  "API認証: X-Api-Key ヘッダーまたは Authorization: Bearer ヘッダーを検証": "API authentication: validate X-Api-Key header or Authorization: Bearer header",
  "モック環境では ZC_HMAC_SECRET を API キーとして使用": "In mock environment, use ZC_HMAC_SECRET as API key",
  "同一オリジンからのブラウザUI呼び出しを許可（開発・デモ用）": "Allow browser UI calls from same origin (development and demo use)",
  "Origin ヘッダーはブラウザが付与する。同一オリジンのリクエストでは Origin が": "Origin header is set by the browser. For same-origin requests, Origin is",
  "省略されるか、リクエストURLのオリジンと一致する。Refererと異なりパスを含まないため": "either omitted or matches the request URL's origin. Unlike Referer, it does not include the path, so",
  '"https://attacker.com/dashboard" のようなバイパスが不可能。': 'bypass attacks like "https://attacker.com/dashboard" are not possible.',
  "GET /api/transactions/:txid/explain  人間可読な状態遷移の説明 + 改ざん検知": "GET /api/transactions/:txid/explain — human-readable state transition explanation + tampering detection",
  "GET /api/transactions/:txid/postcard.svg  生成された金継ぎ風 SVG（画像）": "GET /api/transactions/:txid/postcard.svg — generated kintsugi-style SVG (image)",
  "GET /api/transactions/:txid/postcard  SVG + 三行詩 + モチーフのメタ": "GET /api/transactions/:txid/postcard — SVG + three-line poem + motif metadata",
  "GET /api/gtid/:gtid/events  (/events を先にマッチさせる)": "GET /api/gtid/:gtid/events — (match /events before the parameter)",
  "account は bank_id(3) + account_number(7) = 10文字であることを検証": "Verify that account is bank_id(3) + account_number(7) = 10 characters",
  "0025_rtp_consolidate.sql で RtpRequestRows を廃止したため、payer 側の受信": "RtpRequestRows was deprecated in 0025_rtp_consolidate.sql, so payer-side reception",
  "一覧も RtpRequests を直接参照する。": "also directly references RtpRequests.",
  "銀行 ingress と同じく X-ZC-Signature を検証する（PayerBank 発の署名付き証明）。": "Validate X-ZC-Signature like the bank ingress handler (PayerBank-issued signed proof).",
  "GET /api/boj/positions — 各参加行の日銀預け金（BOJ）残高照会（公開API）": "GET /api/boj/positions — query BOJ (Bank of Japan) deposit balances for each participating bank (public API)",
  "報告書「論点7: 資金清算・決済のあり方」—プレファンドRTGS方式の残高監視": 'Report "Topic 7: Framework for Fund Settlement and Payment" — balance monitoring for prefunded RTGS method',
  "QR検証OK → 実際の振込処理を起動": "QR verification OK → trigger actual transfer processing",
  "承認された場合: ZC に resume_credit を通知（Queue 経由）": "If approved: notify ZC of resume_credit via Queue",
  "対象取引の payee 情報を取得": "Retrieve payee information for the target transaction",
  "各銀行の日銀預け金勘定（BOJ）残高照会": "Query BOJ (Bank of Japan) deposit account balances for each bank",
  "顧客が着金承認後、銀行が ZC にクレジット処理の再開を通知する": "After customer approves credit arrival, bank notifies ZC to resume credit processing",
  "タイミング攻撃対策: 長さが違う場合も必ず比較": "Timing attack mitigation: always compare even if lengths differ",
  "国をまたぐ取引であることの整合性確認": "Verify consistency that transaction is cross-border",
  "fatf16_applicable=true だが is_cross_border=false: 矛盾した設定です": "fatf16_applicable=true but is_cross_border=false: contradictory configuration",
  "intermediary が存在する場合の検証": "Validation when intermediary is present",

  // From second batch
  "HTLC": "Hash-Time-Locked Contract",
  "鍵と鍵とを合わせ": "Combining the two keys together",
  "仮の鍵を預けて": "Depositing a temporary key",
  "H_RESERVED": "H_RESERVED (H-reserve funds are held)",
  "送金元で資金を確保済みです": "Funds are secured at the payer's bank",
  "招かれて参じて": "Responding to the invitation",
  "律儀に手順を踏み": "Following the procedure faithfully",
  "受取側から支払依頼（RTP）を発行しました": "Request-to-Pay (RTP) issued by the payee",
  "取引を受け付けた直後です": "Immediately after the transaction was received",
  "送金は正常に最終確定しました": "Payment has been finalized successfully",
  "異常検知により保留中です。担当者の調査が必要です": "On hold due to anomaly detection. Staff investigation required",
  "事前検証を通過し、次の処理を待っています": "Pre-validation passed; awaiting next processing step",
  "事前検証に失敗しました": "Pre-validation failed",
  "事前検証（金額・残高・宛先）に合格しました": "Pre-validation (amount, balance, destination) passed",
  "送金リクエストを受け付けました": "Payment request received",
  "受取銀行での入金を確認しました": "Credit confirmed at payee bank",
  "送金元銀行での引き落としを確認しました": "Debit confirmed at payer bank",
  "送金が最終確定しました": "Payment finalized",
  "異常を検知し取引を保留しました（要調査）": "Anomaly detected; transaction on hold (investigation required)",
  "HTLC の資金をロック": "Lock HTLC funds",
  "HTLC をタイムアウト/取消": "HTLC timeout / cancellation",
  "HTLC を作成": "Create HTLC",
  "クレジット通知の配信を試行": "Attempt delivery of credit notification",
  "中止を判断": "Decision to abort",
  "事前検証で弾かれ": "Rejected by pre-validation",
  "事前検証（金額・残高・宛先）を通過": "Passed pre-validation (amount, balance, destination)",
  "取引はキャンセル": "Transaction cancelled",
  "受取側がプリイメージで HTLC を解錠要求": "Payee requests HTLC unlock using preimage",
  "受取銀行の入金確認を取得": "Obtain credit confirmation from payee bank",
  "受取銀行の着金フィルタで拒否": "Rejected by payee bank's credit filter",
  "受取顧客が着金を承認": "Payee customer approves credit",
  "受取顧客が着金を拒否": "Payee customer rejects credit",
  "受取顧客の着金承認待ちで保留": "On hold awaiting payee customer credit approval",
  "実行エラーで失敗": "Execution error failure",
  "決済確定を判断": "Decision to finalize settlement",
  "異常検知により保留": "On hold due to anomaly detection",
  "送金は最終確定": "Payment is finalized",
  "送金リクエストを受付": "Payment request accepted",
  "送金元銀行で資金を H 予約": "H-reserve funds at payer bank",
  "送金元銀行の出金確認を取得": "Obtain debit confirmation from payer bank",
  "お振込み": "Transfer",
  "キャンセル済み": "Cancelled",
  "入金確認済み・最終化待ち": "Credit confirmed; awaiting finalization",
  "出金確認済み・入金待ち": "Debit confirmed; awaiting credit",
  "最終確定済み": "Finalized",
  "確定判断後の銀行処理中": "Bank processing in progress after finalization decision",
  "請求払い 着金": "Request-to-Pay credit",
  "請求払い": "Request-to-Pay",
  "小銭を渡し": "Give change",
  "X-ZC-Signature (HMAC-SHA256) による署名検証を行う。": "Perform signature verification using X-ZC-Signature (HMAC-SHA256).",
  "現金払い戻し": "Cash refund",
  "着金通知（決済完了後の入金記帳通知）": "Credit notification (credit posting notification after settlement completion)",
  "Request-to-Pay 通知（支払人銀行への請求通知）": "Request-to-Pay notification (billing notification to payer bank)",
  "ヘッダー X-Bank-Id + X-Customer-Id で認証（モック）。": "Authentication via X-Bank-Id + X-Customer-Id headers (mock).",
  "ヘッダー X-Bank-Id + X-Teller-Id で認証（モック）。": "Authentication via X-Bank-Id + X-Teller-Id headers (mock).",
  "顧客向けAPI（X-Bank-Id + X-Customer-Id）": "Customer API (X-Bank-Id + X-Customer-Id)",
  "行員向けAPI（X-Bank-Id + X-Teller-Id）": "Teller API (X-Bank-Id + X-Teller-Id)",
  "顧客が保有する全口座（CLOSED除外）の一覧と残高を返す。": "Return list and balances of all accounts held by customer (excluding CLOSED).",
  "送金元銀行として、指定取引の現在状態を返す。": "Return current state of specified transaction as payer bank.",
  "当該銀行の全口座を一覧表示する（システム口座含む）。": "List all accounts for the bank (including system accounts).",
  "指定口座の仕訳一覧を返す。": "Return journal entry list for specified account.",
  "直近のバッチ処理（EOD・DNS清算等）の実行状態を返す。": "Return execution status of recent batch processing (EOD, DNS settlement, etc.).",

  // Batch 3 translations
  "// マジックナンバーを排除し、保守性を向上させるために一元管理する。": "// Centrally manage to eliminate magic numbers and improve maintainability.",
  "// 各モジュールはハードコードされた数値の代わりにここからインポートする。": "// Each module imports from here instead of using hardcoded numbers.",
  "/** T2: 仕向実行 → 被仕向実行 のタイムアウト (5分) */": "/** T2: Timeout for sending-bank execution → receiving-bank execution (5 minutes) */",
  "/** T3: 被仕向証憑待ちタイムアウト (5分) */": "/** T3: Receiving-bank proof waiting timeout (5 minutes) */",
  "/** SUSPENDED 状態から FAILED_EXECUTION へ遷移するまでの猶予 (1時間) */": "/** Grace period to transition from SUSPENDED to FAILED_EXECUTION (1 hour) */",
  "/** GTID stalled recovery: GT_DECIDED_TO_SETTLE の滞留タイムアウト (10分) */": "/** GTID stalled recovery: GT_DECIDED_TO_SETTLE stall timeout (10 minutes) */",
  "/** 入金通知のリトライ間隔 (秒): 指数バックオフ */": "/** Credit notification retry interval (seconds): exponential backoff */",
  "/** 入金通知の最大リトライ回数 */": "/** Maximum retry count for credit notifications */",
  "// コントローラが既にクローズされている場合は無視": "// Ignore if the controller is already closed",
  "// 配信済みマーク": "// Mark as delivered",
  "// エラーをクライアントへ通知してもストリームは継続": "// Notify the client of the error, but continue the stream",
  '"CUSTODY returned 残高戻し"': '"CUSTODY returned balance reversal"',
  "description: 取引IDでフィルタ": "description: Filter by transaction ID",
  "description: 取引IDで部分一致検索": "description: Partial match search by transaction ID",
  "description: 口座IDでフィルタ": "description: Filter by account ID",
  "description: 払い戻し成功": "description: Refund successful",
  "description: 承認ステータスでフィルタ（デフォルト PENDING）": "description: Filter by approval status (default PENDING)",
  "VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）'": "VALUES (?, ?, 'BOJ', 'Bank of Japan (Deposit Account)'",
  "// HtlcContracts は Hash-Time-Locked Contract_LOCKED で作成しておき、Step 2 の Transactions": "// HtlcContracts are created with Hash-Time-Locked Contract_LOCKED status, and Transactions in Step 2",
  "// hashlock/timelock を確実に提供するため Transactions より先に存在させる。": "// exist before Transactions to ensure reliable provision of hashlock/timelock.",
  "// アトミックに加算し、超過時は rows=0 になる": "// Atomically increment, returning rows=0 on overflow",
  "// スキーマ不完全時: 警告をログして制限なしとして続行（開発環境での利便性のため）": "// If schema is incomplete: log a warning and continue without limits (for convenience in development environment)",
  "// 遷移 (RECEIVED → Hash-Time-Locked Contract_LOCKED) と整合させる。claimHtlc がリードする": "// Align with transition (RECEIVED → Hash-Time-Locked Contract_LOCKED). claimHtlc leads",
  "BankAuditLog の一覧を返す。txid でフィルタ可能。": "Return list of BankAuditLog entries. Filterable by txid.",
  "COMMITTED → SETTLED に更新。": "Update from COMMITTED → SETTLED.",
  "Custody 状態の別段預金を指定口座に振り替えて収束させる。": "Transfer segregated deposits in Custody status to the specified account to settle.",
  "Custody 発生時は別段預金に留める。": "When Custody occurs, keep in segregated deposits.",
  "D1 batch でアトミックに実行される。": "Executed atomically in D1 batch.",
  "DNS/IGS 決済完了後、受取銀行に入金を通知する。": "After DNS/IGS settlement completion, notify the receiving bank of credit.",
  "Hard Landing: ZCS → 別段預金 仕訳を記録。": "Hard Landing: Record journal entry from ZCS → segregated deposits.",
  "PENDING 状態の承認リクエストに対して承認（approved: true）": "Approve requests in PENDING status (approved: true)",
  "PSPR 登録名と BankAccounts.customer_name を照合する。": "Verify PSPR registered name against BankAccounts.customer_name.",
  "PaymentApprovalRequests に PENDING レコードを作成し、": "Create PENDING record in PaymentApprovalRequests,",
  "SuspenseDetails に RESERVED レコードを作成し、顧客口座の": "Create RESERVED record in SuspenseDetails for the customer account,",
  "SuspenseDetails の一覧を返す。status / txid でフィルタ可能。": "Return list of SuspenseDetails entries. Filterable by status/txid.",
  "SuspenseDetails を RESERVED → COMMITTED に変更し、": "Change SuspenseDetails from RESERVED → COMMITTED,",
  "SuspenseDetails を RESERVED → RELEASED に変更し、": "Change SuspenseDetails from RESERVED → RELEASED,",
  "ZC_RESUME_CREDIT キューメッセージを送信し、着金処理を再開する。": "Send ZC_RESUME_CREDIT queue message to resume credit processing.",
  "ZC→Bank Ingress コマンドの実行履歴（成功/失敗・理由コード）を確認できる。": "Can view execution history of ZC→Bank Ingress commands (success/failure and reason codes).",

  // Batch 4 translations
  "// タイムアウト定数 (秒)": "// Timeout constant (seconds)",
  "// 通知リトライ定数": "// Notification retry constant",
  "// FATF R.16 定数": "// FATF R.16 constant",
  "/** FATF R.16 適用閾値 (JPY): 1,000 USD 相当 */": "/** FATF R.16 application threshold (JPY): equivalent to 1,000 USD */",
  "/** 為替レート: 各通貨 → JPY 換算 */": "/** Exchange rate: conversion from each currency to JPY */",
  "/** BIC コードの標準長 (8桁 or 11桁) */": "/** Standard length of BIC code (8 or 11 digits) */",
  "/** D1 batch の最大ステートメント数 */": "/** Maximum statement count per D1 batch */",
  "/** R2 オフロード閾値 (バイト): 50KB 超のペイロードは R2 に格納 */": "/** R2 offload threshold (bytes): payloads exceeding 50KB are stored in R2 */",
  "/** クエリ結果のデフォルト LIMIT */": "/** Default LIMIT for query results */",
  "/** リッチデータのデフォルト保持日数 */": "/** Default retention days for rich data */",
  "/** 動的 QR のデフォルト有効期限 (ミリ秒): 15分 */": "/** Default validity period for dynamic QR (milliseconds): 15 minutes */",
  "// env を渡して銀行側サスペンスの解放通知も行う（Hash-Time-Locked Contract_LOCKED 時は reserve-funds が実行済み）": "// Pass env to also send bank-side suspense release notification (reserve-funds already executed when Hash-Time-Locked Contract is in _LOCKED state)",
  "// 1. T2_exec タイムアウト: DECIDED_TO_SETTLE が 5分以上": "// 1. T2_exec timeout: DECIDED_TO_SETTLE exceeds 5 minutes",
  "// 2. T3_payee_proof タイムアウト: PAYER_EXEC_CONFIRMED が 5分以上": "// 2. T3_payee_proof timeout: PAYER_EXEC_CONFIRMED exceeds 5 minutes",
  "// 3. FAILED_EXECUTION 遷移: SUSPENDED が expires_at を超えた場合": "// 3. FAILED_EXECUTION transition: when SUSPENDED exceeds expires_at",
  "// 4. Hash-Time-Locked Contract timelock 期限切れ": "// 4. Hash-Time-Locked Contract timelock expiration",
  "// 5. Vault TTL 切れ（論理削除）": "// 5. Vault TTL expiration (logical deletion)",
  "// 6. RTP 期限切れ（state 列のみを更新）": "// 6. RTP expiration (update state column only)",
  "// 8. GT_DECIDED_TO_SETTLE スタック GTID 回収（10分以上更新なし）": "// 8. GT_DECIDED_TO_SETTLE stuck GTID recovery (no updates for 10+ minutes)",
  "// 9. GT_SETTLED 済みなのに GtidLegs.state が未更新のレコードを一括修正": "// 9. Batch fix records where GT_SETTLED is complete but GtidLegs.state is not updated",
  "// BULK/DEFERRED は EOD まで DECIDED_TO_SETTLE で待機する設計のため除外": "// BULK/DEFERRED are excluded because they are designed to wait in DECIDED_TO_SETTLE state until EOD",
  "// CUSTODYは口座凍結/閉鎖で着金できなかった資金。DNS清算が完了しても": "// CUSTODY is funds that could not be credited due to account freeze/closure. Even after DNS settlement completes",
  "// Hash-Time-Locked Contract は timelock で独立管理されるため除外（claimHtlc は同期 debit で完結）": "// Hash-Time-Locked Contract is excluded because it is independently managed by timelock (claimHtlc completes as synchronous debit)",
  "// PAY方向: RESERVED → EXECUTED → SETTLED（支払側の別段清算）": "// PAY direction: RESERVED → EXECUTED → SETTLED (payer-side separate settlement)",
  "// RECEIVE方向: CUSTODY ステータスの受取側レコードもDNS清算対象とする": "// RECEIVE direction: also include payee-side records with CUSTODY status in DNS settlement scope",
  "// hashlock は空文字許可（サーバー側で自動生成）": "// hashlock allows empty string (auto-generated server-side)",
  "// leg 実行失敗や 0-legs で checkAndFinalizeGtid が呼ばれなかった GTID を救済": "// Rescue GTIDs where checkAndFinalizeGtid was not called due to leg execution failure or 0-legs",
  "/** bank_id は zenith-mock 3桁形式 */": "/** bank_id is in zenith-mock 3-digit format */",
  "/** 仕向支店コード（3桁: '001'〜'999'）。zenith-mock では DB 照合に不使用 */": "/** Originating branch code (3 digits: '001' to '999'). Not used for DB matching in zenith-mock */",
  "/** 口座番号（7桁数字）。zenith-mock の account_hash とは別体系 */": "/** Account number (7-digit numeral). Separate system from zenith-mock's account_hash */",
  "/** 被仕向支店コード（3桁: '001'〜'999'）。zenith-mock では DB 照合に不使用 */": "/** Receiving branch code (3 digits: '001' to '999'). Not used for DB matching in zenith-mock */",
  "/** 金額（円, 正の整数, 最大10桁） */": "/** Amount (yen, positive integer, maximum 10 digits) */",
  "// SUM(BankJournals) に -amount が反映済み。SuspenseDetails を再度差し引くと二重控除になる。": "// -amount is already reflected in SUM(BankJournals). Subtracting SuspenseDetails again would result in double deduction.",
  "// account_hash/account_id から BankAccount を取得": "// Retrieve BankAccount from account_hash/account_id",
  "// reserveSuspense が既に customer(-amount)/suspense(+amount) の仕訳を作成済みのため": "// Because reserveSuspense has already created the journal entry for customer(-amount)/suspense(+amount)",
  "RtpRequests.state と rtp_status を統合した結果、RtpState が唯一の状態集合。": "As a result of consolidating RtpRequests.state and rtp_status, RtpState is the sole state set.",
  "zenith-mock には支店概念がなく、`BankAccounts` は支店なしの口座IDのみ管理する。": "zenith-mock has no branch concept; `BankAccounts` manages only account IDs without branch information.",
  "zenith-mock の `Participants.bank_id` は実際の全銀銀行コードと1桁異なる。": "zenith-mock's `Participants.bank_id` differs by 1 digit from actual Zenginkyo bank codes.",
  "よって支店コードは変換時に「情報として保持するが、DB照合には使わない」として扱う。": "Therefore, branch codes are treated as \"retained as information but not used for DB matching\" during conversion.",
  "フィールド名は全銀協フォーマット仕様書の項目名に準拠。": "Field names comply with item names in the Zenginkyo format specification document.",

  // Final batch translations
  "// HTTP fetch ハンドラー": "// HTTP fetch handler",
  "* このハンドラはその「銀行側初期化」を受け付けるエンドポイント。": "* This handler is an endpoint that accepts the \"bank-side initialization\".",
  "* この識別子は DB の `account_hash` ではなく、銀行 `account-verify` エンドポイントへの": "* This identifier is not the DB's `account_hash`, but rather for the bank's `account-verify` endpoint",
};

const srcDir = '/home/user/Zenith-Payment-System/src';
let filesProcessed = 0;
let replacementsApplied = 0;
let untranslatedFound = [];

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walkDir(filePath);
    } else if (file.endsWith('.ts') || file.endsWith('.js')) {
      processFile(filePath);
    }
  }
}

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;
  let originalContent = content;

  // Apply all translations
  for (const [japanese, english] of Object.entries(translations)) {
    if (content.includes(japanese)) {
      content = content.split(japanese).join(english);
      replacementsApplied++;
      modified = true;
    }
  }

  // Check for any remaining Japanese
  const japaneseRegex = /[぀-ゟ゠-ヿ一-鿿]/g;
  const matches = content.match(japaneseRegex);
  if (matches) {
    const uniqueJapanese = [...new Set(matches)];
    untranslatedFound.push({
      file: filePath,
      chars: uniqueJapanese.join('')
    });
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    filesProcessed++;
  }
}

// Run the translation
walkDir(srcDir);

console.log(`\n✓ Translation Complete`);
console.log(`  Files modified: ${filesProcessed}`);
console.log(`  Replacements applied: ${replacementsApplied}`);

if (untranslatedFound.length > 0) {
  console.log(`\n⚠ Untranslated Japanese characters found in:`);
  for (const item of untranslatedFound) {
    console.log(`  ${path.relative(srcDir, item.file)}: ${item.chars}`);
  }
}
