/**
 * @file Bank proof reference generation for audit trails.
 *
 * Every fund reservation or credit operation produces a `BankProofRef`
 * (the "a" or "b" proof) that links a bank-side journal entry to the
 * ZC transaction. These proofs are stored in the Transactions table and
 * returned in API responses for reconciliation.
 *
 * @module shared/proof
 */
import type { BankProofRef, ProofType, CustodyDetail } from "../types";
import { nowISO } from "../types";
import { sha256hex } from "./hmac";
import { newUUID } from "./idempotency";

/**
 * Create a new `BankProofRef` with a unique proof ID and timestamp.
 *
 * A content digest is computed (SHA-256 over key fields) for audit
 * purposes, though the digest itself is not stored in the proof object.
 *
 * @param issuerBankId - Bank ID that issued this proof (e.g. "001")
 * @param proofType    - Phase of the proof: "a" (reserve) or "b" (credit)
 * @param txid         - Associated transaction ID
 * @param amount       - Transaction amount
 * @param custodyDetail - Optional custody/suspense account details
 * @returns A fully populated BankProofRef
 */
export async function createProof(
  issuerBankId: string,
  proofType: ProofType,
  txid: string,
  amount: number,
  custodyDetail?: CustodyDetail
): Promise<BankProofRef> {
  const proofId = `PROOF-${newUUID()}`;
  // voucherの内容ダイジェスト（audit用）
  await sha256hex(`${issuerBankId}:${proofType}:${txid}:${amount}:${proofId}`);

  const proof: BankProofRef = {
    issuer_bank_id: issuerBankId,
    proof_type: proofType,
    proof_id: proofId,
    recorded_at: nowISO(),
  };
  if (custodyDetail) {
    proof.custody_detail = custodyDetail;
  }
  return proof;
}

/**
 * Generate a decision proof reference for ZC state finalization.
 *
 * @returns A `DP-{uuid}` formatted reference string
 */
export function newDecisionProofRef(): string {
  return `DP-${newUUID()}`;
}

/**
 * Generate a finality log reference for settlement completion.
 *
 * @returns A `FL-{uuid}` formatted reference string
 */
export function newFinalityLogRef(): string {
  return `FL-${newUUID()}`;
}

/**
 * Serialize a BankProofRef to a JSON string for DB storage.
 *
 * @param proof - The proof reference to serialize
 * @returns JSON string representation
 */
export function serializeProof(proof: BankProofRef): string {
  return JSON.stringify(proof);
}

/**
 * Deserialize a BankProofRef from a JSON string.
 *
 * @param json - JSON string (or null) from D1
 * @returns Parsed BankProofRef, or null on invalid/missing input
 */
export function deserializeProof(json: string | null): BankProofRef | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as BankProofRef;
  } catch {
    return null;
  }
}
