/**
 * @file HMAC-SHA256 signing and verification using the Web Crypto API.
 *
 * All cryptographic operations use `globalThis.crypto.subtle` (available in
 * Cloudflare Workers). Node.js `crypto` module is NOT used.
 *
 * @module shared/hmac
 */
import type { Env } from '../types'

/**
 * Sign a payload with HMAC-SHA256 and return the hex digest.
 *
 * If `payload` is not already a string it is JSON-stringified first.
 *
 * @param payload - The data to sign (object or string)
 * @param secret  - The shared HMAC secret
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export async function signPayload(payload: unknown, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const keyData = enc.encode(secret)
  const msgData = enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload))

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData)
  return bufToHex(sig)
}

/**
 * Verify an X-ZC-Signature header against a payload.
 *
 * Uses constant-time comparison to mitigate timing attacks.
 *
 * @param payload   - The original payload that was signed
 * @param signature - The hex signature to verify
 * @param secret    - The shared HMAC secret
 * @returns `true` if the signature is valid
 */
export async function verifySignature(
  payload: unknown,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = await signPayload(payload, secret)
  // タイミング攻撃対策: 長さが違う場合も必ず比較
  if (expected.length !== signature.length) return false
  const a = new TextEncoder().encode(expected)
  const b = new TextEncoder().encode(signature)
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return result === 0
}

/**
 * Compute a SHA-256 hash and return it as a hex string.
 *
 * @param data - The input string to hash
 * @returns 64-character hex-encoded SHA-256 digest
 */
export async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  )
  return bufToHex(buf)
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Build standard headers for ZC-to-Bank internal HTTP calls.
 *
 * Produces `Content-Type`, `X-ZC-Signature`, and `X-Idempotency-Key` headers
 * required by every Bank Ingress API endpoint.
 *
 * @param payload        - Request body to sign
 * @param idempotencyKey - Idempotency key for the call
 * @param env            - Worker environment (provides ZC_HMAC_SECRET)
 * @returns Header record ready for `fetch()`
 */
export async function zcIngressHeaders(
  payload: unknown,
  idempotencyKey: string,
  env: Env,
): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    'X-ZC-Signature': await signPayload(payload, env.ZC_HMAC_SECRET),
    'X-Idempotency-Key': idempotencyKey,
  }
}
