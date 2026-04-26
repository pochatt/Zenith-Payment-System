/**
 * @file logger.ts — Structured JSON logger with per-request context.
 *
 * Emits one JSON line per log event so Cloudflare Logpush / wrangler tail
 * remain machine-parseable. Carries a `request_id` and arbitrary baggage
 * (txid, bank_id, lane, etc.) without forcing every call site to pass them.
 *
 * # Usage
 *
 * ```ts
 * const log = newRequestLogger({ method: 'POST', path: '/api/transfers' })
 * log.info('lane.dispatch', { txid, lane: 'EXPRESS' })
 * try {
 *   ...
 * } catch (e) {
 *   log.error('lane.failed', { txid, error: e })
 *   throw e
 * }
 * log.info('request.complete', { status: 200, duration_ms: log.elapsed() })
 * ```
 *
 * Output line (newline-delimited JSON):
 * ```
 * {"ts":"2026-04-26T...","level":"info","event":"lane.dispatch",
 *  "request_id":"req-...","method":"POST","path":"/api/transfers",
 *  "txid":"TX-001","lane":"EXPRESS"}
 * ```
 */

import { newUUID } from './idempotency'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  request_id?: string
  method?: string
  path?: string
  [k: string]: unknown
}

export interface RequestLogger {
  /** Generate a child logger with merged baggage. Useful inside lane code. */
  child(extra: Record<string, unknown>): RequestLogger
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
  /** Milliseconds elapsed since logger creation. */
  elapsed(): number
  /** The request_id used for tracing; surfaced in error responses. */
  readonly request_id: string
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a logger scoped to one HTTP request / queue message / cron tick.
 * If `ctx.request_id` is omitted a new one is generated.
 */
export function newRequestLogger(ctx: LogContext = {}): RequestLogger {
  const start = Date.now()
  const baggage: LogContext = {
    request_id: ctx.request_id ?? `req-${newUUID()}`,
    ...ctx,
  }
  return makeLogger(baggage, start)
}

function makeLogger(baggage: LogContext, start: number): RequestLogger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...baggage,
      ...(fields ? sanitize(fields) : {}),
    }
    // One sink: console. Cloudflare collects it as JSON automatically.
    // We use the matching console method so log-level filtering works in tail.
    const writer = console[level === 'debug' ? 'log' : level] ?? console.log
    writer(JSON.stringify(line))
  }
  return {
    request_id: baggage.request_id as string,
    child(extra) {
      return makeLogger({ ...baggage, ...extra }, start)
    },
    debug(event, fields) { emit('debug', event, fields) },
    info(event, fields)  { emit('info',  event, fields) },
    warn(event, fields)  { emit('warn',  event, fields) },
    error(event, fields) { emit('error', event, fields) },
    elapsed() { return Date.now() - start },
  }
}

// ---------------------------------------------------------------------------
// Field sanitization
// ---------------------------------------------------------------------------

/**
 * Convert non-serializable fields (Error, undefined) into JSON-safe values.
 * Strips fields whose key looks PII-ish (vault_ref, secret, hmac_*).
 */
function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (isPiiKey(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    if (v instanceof Error) {
      out[k] = {
        name: v.name,
        message: v.message,
        ...(v as { reason_code?: unknown }).reason_code != null
          ? { reason_code: (v as { reason_code?: unknown }).reason_code }
          : {},
        ...(v as { details?: unknown }).details != null
          ? { details: (v as { details?: unknown }).details }
          : {},
      }
    } else if (v === undefined) {
      // skip
    } else {
      out[k] = v
    }
  }
  return out
}

const PII_KEYS = new Set([
  'vault_ref', 'preimage', 'secret', 'hmac_secret',
  'authorization', 'api_key', 'private_key',
])

function isPiiKey(k: string): boolean {
  const lower = k.toLowerCase()
  if (PII_KEYS.has(lower)) return true
  return lower.includes('password') || lower.endsWith('_pii')
}
