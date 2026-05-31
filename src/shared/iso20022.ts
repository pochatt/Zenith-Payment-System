/**
 * @file ISO 20022 message builders and Zengin fixed-length format conversion.
 *
 * Supports the following message types:
 * - pacs.008 (CustomerCreditTransfer) -- outbound payment instruction
 * - pacs.002 (PaymentStatusReport) -- status acknowledgement/rejection
 * - pacs.004 (ReturnCreditTransfer) -- refund / return
 * - pacs.028 (PaymentStatusRequest) -- status inquiry
 * - pain.013 (CreditorPaymentActivationRequest) -- Request-to-Pay
 * - pain.014 (CreditorPaymentActivationRequestStatusReport) -- RTP response
 * - acmt.023 (AccountVerificationRequest) -- name-check inquiry
 * - acmt.024 (AccountVerificationResponse) -- name-check result
 *
 * Also provides bidirectional conversion between Zengin 120-byte fixed-length
 * records and ISO 20022 pacs.008 messages for batch/bulk lane compatibility.
 *
 * @module shared/iso20022
 */

import type {
  Pacs008Message,
  Pacs002Message,
  Pacs004Message,
  Pacs028Message,
  Pain013Message,
  Pain014Message,
  Acmt023Message,
  Acmt024Message,
  ZenginFixedRecord,
  FatfR16Data,
  Pacs008Debtor,
  Pacs008Creditor,
} from "../types";
import { bicToBankId, bankIdToBic } from "./routing";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Zengin fixed-length record size (120 bytes per record). */
const ZENGIN_RECORD_LENGTH = 120;

/** Zengin account type code to ISO 20022 account type label mapping. */
const ZENGIN_ACCOUNT_TYPE_LABEL: Record<string, string> = {
  "1": "SAVINGS", // Savings
  "2": "CURRENT", // Checking account
  "4": "SAVINGS", // Savings deposit
};

// ---------------------------------------------------------------------------
// pacs.008 generate
// ---------------------------------------------------------------------------

/**
 * Build a pacs.008 (FIToFICustomerCreditTransfer) message.
 *
 * This is the primary outbound payment instruction used for EXPRESS,
 * STANDARD, HIGH_VALUE, and cross-border lanes.
 *
 * @param params - Transfer parameters (amounts, parties, optional FATF/EDI data)
 * @returns Populated Pacs008Message
 */
export function buildPacs008(params: {
  msgId: string;
  txid: string;
  amount: number;
  currency: string;
  payerBankBic: string;
  payerAccount: string;
  payerName: string;
  payeeBankBic: string;
  payeeAccount: string;
  payeeName: string;
  purpose?: string;
  fatf?: FatfR16Data;
  ediRef?: string;
}): Pacs008Message {
  const now = new Date().toISOString();

  const debtor: Pacs008Debtor = {
    name: params.payerName,
    account_id: params.payerAccount,
    bank_id: bicToBankIdLocal(params.payerBankBic) ?? params.payerBankBic,
    bank_bic: params.payerBankBic,
  };

  const creditor: Pacs008Creditor = {
    name: params.payeeName,
    account_id: params.payeeAccount,
    bank_id: bicToBankIdLocal(params.payeeBankBic) ?? params.payeeBankBic,
    bank_bic: params.payeeBankBic,
  };

  const msg: Pacs008Message = {
    message_type: "pacs.008",
    message_id: params.msgId,
    creation_datetime: now,
    number_of_transactions: 1,
    settlement_method: "CLRG",
    debtor,
    creditor,
    instructed_amount: { value: params.amount, currency: params.currency },
  };

  if (params.purpose) {
    msg.purpose_code = params.purpose;
  }

  if (params.ediRef || params.txid) {
    msg.remittance_info = {
      structured: {
        creditor_ref: params.txid,
        edi_ref: params.ediRef,
      },
    };
  }

  if (params.fatf) {
    msg.regulatory_reporting = params.fatf;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// pacs.002 generate
// ---------------------------------------------------------------------------

/**
 * Build a pacs.002 (FIToFIPaymentStatusReport) message.
 *
 * Used to acknowledge, reject, or report pending status for a payment.
 *
 * @param params - Status parameters (original message ref, status code, reason)
 * @returns Populated Pacs002Message
 */
export function buildPacs002(params: {
  msgId: string;
  originalMsgId: string;
  txid: string;
  status: "ACCP" | "RJCT" | "PDNG";
  reasonCode?: string;
}): Pacs002Message {
  const msg: Pacs002Message = {
    message_type: "pacs.002",
    message_id: params.msgId,
    original_message_id: params.originalMsgId,
    transaction_status: params.status,
  };

  if (params.reasonCode) {
    msg.reason_code = params.reasonCode;
  }

  if (params.status === "RJCT" && params.reasonCode) {
    msg.additional_info = `Transaction ${params.txid} rejected: ${params.reasonCode}`;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// acmt.023 generate
// ---------------------------------------------------------------------------

/**
 * Build an acmt.023 (IdentificationVerificationRequest) message.
 *
 * Used for account name verification (Confirmation of Payee) before
 * initiating a transfer.
 *
 * @param params - Inquiry parameters (requesting bank, target account)
 * @returns Populated Acmt023Message
 */
export function buildAcmt023(params: {
  msgId: string;
  verificationId: string;
  requestBankBic: string;
  targetBankBic: string;
  targetAccountId: string;
  targetAccountName?: string;
}): Acmt023Message {
  const msg: Acmt023Message = {
    message_type: "acmt.023",
    message_id: params.msgId,
    account_id: params.targetAccountId,
    inquiry_bank_id: bicToBankIdLocal(params.requestBankBic) ?? params.requestBankBic,
    target_bank_id: bicToBankIdLocal(params.targetBankBic) ?? params.targetBankBic,
  };

  if (params.targetAccountName) {
    msg.account_holder_name = params.targetAccountName;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// acmt.024 generate
// ---------------------------------------------------------------------------

/**
 * Build an acmt.024 (IdentificationVerificationResponse) message.
 *
 * Returns MTCH (match >= 80), NMTC (no match), or NFND (not found)
 * based on the name matching score.
 *
 * @param params - Verification result (score, fraud warning)
 * @returns Populated Acmt024Message
 */
export function buildAcmt024(params: {
  msgId: string;
  originalMsgId: string;
  verificationId: string;
  matchScore: number;
  nameProvided?: string;
  fraudWarning: boolean;
}): Acmt024Message {
  let result: "MTCH" | "NMTC" | "NFND";
  if (params.matchScore >= 80) {
    result = "MTCH";
  } else if (params.matchScore >= 0) {
    result = "NMTC";
  } else {
    result = "NFND";
  }

  const msg: Acmt024Message = {
    message_type: "acmt.024",
    original_message_id: params.originalMsgId,
    verification_result: result,
    match_score: params.matchScore,
  };

  if (params.nameProvided) {
    msg.account_holder_name = params.nameProvided;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// pacs.004 generate
// ---------------------------------------------------------------------------

/**
 * Build a pacs.004 (PaymentReturn) message.
 *
 * Used for refunds and return-of-funds processing.
 *
 * @param params - Return parameters (original tx ref, return amount, reason, parties)
 * @returns Populated Pacs004Message
 */
export function buildPacs004(params: {
  msgId: string;
  originalMsgId: string;
  originalTxid: string;
  returnAmount: number;
  currency: string;
  returnReasonCode: string;
  debtorBankId: string;
  debtorAccount: string;
  debtorName: string;
  creditorBankId: string;
  creditorAccount: string;
  creditorName: string;
}): Pacs004Message {
  return {
    message_type: "pacs.004",
    message_id: params.msgId,
    creation_datetime: new Date().toISOString(),
    original_message_id: params.originalMsgId,
    original_txid: params.originalTxid,
    return_amount: { value: params.returnAmount, currency: params.currency },
    return_reason_code: params.returnReasonCode,
    debtor: {
      name: params.debtorName,
      bank_id: params.debtorBankId,
      account_id: params.debtorAccount,
    },
    creditor: {
      name: params.creditorName,
      bank_id: params.creditorBankId,
      account_id: params.creditorAccount,
    },
  };
}

// ---------------------------------------------------------------------------
// pacs.028 generate
// ---------------------------------------------------------------------------

/**
 * Build a pacs.028 (FIToFIPaymentStatusRequest) message.
 *
 * Used for transaction status inquiries by participating banks.
 *
 * @param params - Inquiry parameters (original tx ref, inquiring bank)
 * @returns Populated Pacs028Message
 */
export function buildPacs028(params: {
  msgId: string;
  originalMsgId: string;
  originalTxid: string;
  inquiryBankId: string;
}): Pacs028Message {
  return {
    message_type: "pacs.028",
    message_id: params.msgId,
    original_message_id: params.originalMsgId,
    original_txid: params.originalTxid,
    inquiry_bank_id: params.inquiryBankId,
  };
}

// ---------------------------------------------------------------------------
// pain.013 generate
// ---------------------------------------------------------------------------

/**
 * Build a pain.013 (CreditorPaymentActivationRequest) message.
 *
 * The outbound Request-to-Pay message sent from the payee's bank
 * to the payer's bank, requesting payment by a deadline.
 *
 * @param params - RTP parameters (payee/payer info, amount, expiry)
 * @returns Populated Pain013Message
 */
export function buildPain013(params: {
  msgId: string;
  rtpId: string;
  payeeBankId: string;
  payeeAccountId: string;
  payeeName: string;
  payerBankId: string;
  amount: number;
  currency: string;
  requestedExecutionDate: string;
  purposeCode?: string;
  remittanceInfo?: string;
  expiresAt: string;
}): Pain013Message {
  return {
    message_type: "pain.013",
    message_id: params.msgId,
    creation_datetime: new Date().toISOString(),
    rtp_id: params.rtpId,
    payee_bank_id: params.payeeBankId,
    payee_account_id: params.payeeAccountId,
    payee_name: params.payeeName,
    payer_bank_id: params.payerBankId,
    requested_amount: { value: params.amount, currency: params.currency },
    requested_execution_date: params.requestedExecutionDate,
    purpose_code: params.purposeCode,
    remittance_info: params.remittanceInfo,
    expires_at: params.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// pain.014 generate
// ---------------------------------------------------------------------------

/**
 * Build a pain.014 (CreditorPaymentActivationRequestStatusReport) message.
 *
 * The payer bank's response to an RTP: accepted (ACTC), rejected (RJCT),
 * or pending (PDNG). May include a linked txid if payment was initiated.
 *
 * @param params - Response parameters (status, optional linked txid)
 * @returns Populated Pain014Message
 */
export function buildPain014(params: {
  msgId: string;
  originalMsgId: string;
  rtpId: string;
  status: "ACTC" | "RJCT" | "PDNG";
  reasonCode?: string;
  linkedTxid?: string;
}): Pain014Message {
  return {
    message_type: "pain.014",
    message_id: params.msgId,
    original_message_id: params.originalMsgId,
    rtp_id: params.rtpId,
    status: params.status,
    reason_code: params.reasonCode,
    linked_txid: params.linkedTxid,
  };
}

// ---------------------------------------------------------------------------
// Zengin → ISO 20022
// ---------------------------------------------------------------------------

/**
 * Convert a Zengin fixed-length record to an ISO 20022 pacs.008 message.
 *
 * Used when a BULK/DEFERRED lane payment needs to be forwarded to a
 * system that expects ISO 20022 format.
 *
 * @param record - Parsed Zengin 120-byte record
 * @returns Equivalent Pacs008Message
 */
export function zenginToIso20022(record: ZenginFixedRecord): Pacs008Message {
  const now = new Date().toISOString();
  const msgId = `ZG-${record.originator_bank_code}-${Date.now()}`;

  // Convert Zengin account number to internal format
  // Zengin: 4-digit institution code + 3-digit branch code + 7-digit account number
  const payeeAccountId = `${record.bank_code}${record.account_number.replace(/\s/g, "").padStart(7, "0")}`;
  const payerAccountId = `${record.originator_bank_code}0000000`; // Originating account is suspense account

  const payerBic = bankIdToBicLocal(record.originator_bank_code);
  const payeeBic = bankIdToBicLocal(record.bank_code);

  const debtor: Pacs008Debtor = {
    name: record.originator_name.trim(),
    account_id: payerAccountId,
    bank_id: record.originator_bank_code,
    bank_bic: payerBic,
  };

  const creditor: Pacs008Creditor = {
    name: record.beneficiary_name.trim(),
    account_id: payeeAccountId,
    bank_id: record.bank_code,
    bank_bic: payeeBic,
  };

  return {
    message_type: "pacs.008",
    message_id: msgId,
    creation_datetime: now,
    number_of_transactions: 1,
    settlement_method: "CLRG",
    debtor,
    creditor,
    instructed_amount: { value: record.amount, currency: "JPY" },
    remittance_info: {
      unstructured: `ZENGIN/${record.bank_code}/${record.branch_code}/${record.account_type}/${record.account_number}`,
    },
  };
}

// ---------------------------------------------------------------------------
// ISO 20022 → Zengin
// ---------------------------------------------------------------------------

/**
 * Convert an ISO 20022 pacs.008 message to a Zengin fixed-length record.
 *
 * Attempts to recover branch code and account type from the
 * `remittance_info.unstructured` field if it was originally encoded
 * in `ZENGIN/...` format.
 *
 * @param msg - The pacs.008 message to convert
 * @returns Equivalent ZenginFixedRecord
 */
export function iso20022ToZengin(msg: Pacs008Message): ZenginFixedRecord {
  // Decompose bank_code / branch_code from creditor.bank_id
  // Internal format: 3 or 4-digit bankId corresponds to bank_code
  const payeeBankId = msg.creditor.bank_id;
  const payerBankId = msg.debtor.bank_id;

  // Convert account number to Zengin format (7-digit fixed)
  // Internal account format: bankCode + 7-digit seq → extract last 7 digits as account number
  const rawAccountId = msg.creditor.account_id;
  const accountNumber =
    rawAccountId.length >= 7
      ? rawAccountId.slice(-7).padStart(7, "0")
      : rawAccountId.padStart(7, "0");

  // Recover branch code and account type from remittance_info.unstructured if available
  let branchCode = "000";
  let accountType: "1" | "2" | "4" = "1";

  const unstructured = msg.remittance_info?.unstructured ?? "";
  const zenginParts = unstructured.startsWith("ZENGIN/") ? unstructured.split("/") : [];
  if (zenginParts.length >= 5) {
    // ZENGIN/bank_code/branch_code/account_type/account_number
    branchCode = zenginParts[2] ?? "000";
    const parsedType = zenginParts[3];
    if (parsedType === "1" || parsedType === "2" || parsedType === "4") {
      accountType = parsedType;
    }
  }

  const beneficiaryName = padZenginKana(msg.creditor.name, 30);
  const originatorName = padZenginKana(msg.debtor.name, 40);

  return {
    record_type: "2",
    bank_code: payeeBankId.slice(0, 4).padStart(4, "0"),
    branch_code: branchCode.padStart(3, "0"),
    account_type: accountType,
    account_number: accountNumber,
    beneficiary_name: beneficiaryName,
    amount: msg.instructed_amount.value,
    originator_name: originatorName,
    originator_bank_code: payerBankId.slice(0, 4).padStart(4, "0"),
    originator_branch_code: "000",
  };
}

// ---------------------------------------------------------------------------
// Zengin fixed-length text parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 120-byte Zengin fixed-length text line into a ZenginFixedRecord.
 *
 * Record layout (Type 2 -- detail record):
 * ```
 *   Pos  1      : Record type (1)
 *   Pos  2-5    : Beneficiary bank code (4)
 *   Pos  6-8    : Beneficiary branch code (3)
 *   Pos  9      : Account type (1) -- 1:savings, 2:current, 4:deposit
 *   Pos 10-16   : Account number (7)
 *   Pos 17-46   : Beneficiary name (30, half-width katakana)
 *   Pos 47-56   : Amount (10, zero-padded right-aligned)
 *   Pos 57-96   : Originator name (40, half-width katakana)
 *   Pos 97-100  : Originator bank code (4)
 *   Pos 101-103 : Originator branch code (3)
 *   Pos 104-120 : Reserved (17)
 * ```
 *
 * @param line - Exactly 120 characters of Zengin fixed-length text
 * @returns Parsed ZenginFixedRecord
 * @throws Error if the line is not exactly 120 characters
 */
export function parseZenginRecord(line: string): ZenginFixedRecord {
  if (line.length !== ZENGIN_RECORD_LENGTH) {
    throw new Error(
      `Invalid Zengin record length: expected ${ZENGIN_RECORD_LENGTH}, got ${line.length}`
    );
  }

  const recordType = line.substring(0, 1) as "1" | "2" | "8" | "9";
  const bankCode = line.substring(1, 5);
  const branchCode = line.substring(5, 8);
  const rawAccType = line.substring(8, 9);
  const accountType =
    rawAccType === "1" || rawAccType === "2" || rawAccType === "4" ? rawAccType : ("1" as const);
  const accountNumber = line.substring(9, 16).trim();
  const beneficiaryName = line.substring(16, 46).trimEnd();
  const amountStr = line.substring(46, 56);
  const amount = parseInt(amountStr, 10) || 0;
  const originatorName = line.substring(56, 96).trimEnd();
  const origBankCode = line.substring(96, 100);
  const origBranchCode = line.substring(100, 103);

  return {
    record_type: recordType,
    bank_code: bankCode,
    branch_code: branchCode,
    account_type: accountType,
    account_number: accountNumber,
    beneficiary_name: beneficiaryName,
    amount,
    originator_name: originatorName,
    originator_bank_code: origBankCode,
    originator_branch_code: origBranchCode,
  };
}

// ---------------------------------------------------------------------------
// Zengin fixed-length text generation
// ---------------------------------------------------------------------------

/**
 * Serialize a ZenginFixedRecord into a 120-character fixed-length string.
 *
 * @param record - The record to serialize
 * @returns Exactly 120 characters of Zengin formatted text
 * @throws Error if the resulting string is not exactly 120 characters
 */
export function formatZenginRecord(record: ZenginFixedRecord): string {
  const parts: string[] = [
    record.record_type, //  1 character
    record.bank_code.padStart(4, "0").substring(0, 4), //  4 characters
    record.branch_code.padStart(3, "0").substring(0, 3), //  3 characters
    record.account_type, //  1 character
    record.account_number.padStart(7, "0").substring(0, 7), //  7 characters
    padZenginKana(record.beneficiary_name, 30), // 30 characters
    String(record.amount).padStart(10, "0").substring(0, 10), // 10 characters
    padZenginKana(record.originator_name, 40), // 40 characters
    record.originator_bank_code.padStart(4, "0").substring(0, 4), //  4 characters
    record.originator_branch_code.padStart(3, "0").substring(0, 3), // 3 characters
    "".padEnd(17, " "), // 17 characters（予備）
  ];

  const result = parts.join("");

  if (result.length !== ZENGIN_RECORD_LENGTH) {
    throw new Error(
      `Zengin record format error: expected ${ZENGIN_RECORD_LENGTH} chars, got ${result.length}`
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal utilities (module-private)
// ---------------------------------------------------------------------------

/**
 * Truncate/pad a name string to a fixed length for Zengin format.
 *
 * Production systems restrict to half-width katakana; this mock
 * accepts any characters and only enforces length.
 */
function padZenginKana(name: string, length: number): string {
  const truncated = name.substring(0, length);
  return truncated.padEnd(length, " ");
}

/**
 * BIC to bank_id lookup.
 * Delegates to the canonical mapping in routing.ts (20+ banks + foreign banks).
 * Previously this was a local 5-entry subset, which caused incorrect fallback
 * for bank IDs > 005.
 */
const bicToBankIdLocal = bicToBankId;

/**
 * bank_id to BIC lookup.
 * Delegates to the canonical mapping in routing.ts.
 */
const bankIdToBicLocal = bankIdToBic;
