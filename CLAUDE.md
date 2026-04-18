# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

Zenith Mock is a reference implementation of the **Zenith Coordinator (ZC)** — a next-generation payment settlement system built on Cloudflare Workers + D1 + Queues + R2. It coordinates multi-bank payment flows using per-lane state machines, with full traceability via an append-only FinalityLog.

## Commands

```bash
npm run dev                        # Start local dev server (http://localhost:8787)
npm run deploy                     # Deploy to Cloudflare Workers
npm run db:migrate:local           # Apply D1 migrations locally
npm run db:migrate:remote          # Apply D1 migrations to remote D1
npm run type-check                 # TypeScript type checking (tsc --noEmit)
npm run test                       # Run all tests once (vitest run)
npm run test:watch                 # Run tests in watch mode
npx vitest test/zc/express.test.ts # Run a single test file
```

**Setup:** Copy `wrangler.toml.example` to `wrangler.toml` and fill in your D1 database ID, Queues binding, and R2 bucket. There is no `.env` file — all config lives in `wrangler.toml`.

No linter is configured.

## Architecture

### Request Flow

1. `src/index.ts` — single entry point; routes HTTP to handlers, dispatches queue messages to the orchestrator, fires cron jobs
2. `src/zc/ingress.ts` — ZC-facing HTTP handlers (`/api/*`, `/internal/*`)
3. `src/bank/ingress.ts` — ZC→Bank ingress handler (`/bank/*`)
4. `src/bank/customer_api.ts` / `teller_api.ts` — customer and teller HTTP APIs
5. **Lane functions** (`src/zc/lanes/*.ts`) — synchronous state machine advances called by ingress handlers
6. **Orchestrator** (`src/zc/orchestrator.ts` + `src/zc/orchestrator/`) — queue consumer that drives async state transitions (payee credit, notifications)
7. **Cron jobs** (`src/cron/`) — EOD settlement at 07:30 UTC daily, timeout sweep every minute

### Payment Lanes

Each lane is a distinct state machine in `src/zc/lanes/`:

| Lane | File | Description |
|------|------|-------------|
| EXPRESS | `express.ts` | Synchronous end-to-end settlement; requires H-reserve prefunding |
| STANDARD | `standard.ts` | Requires payer authorization before settlement |
| HTLC | `htlc.ts` | Hash-time-locked contract; conditional release on preimage |
| RTP | `rtp.ts` | Request-to-Pay (pull-based); payee initiates |
| GTID | `gtid.ts` | Multi-leg coordinated transfers across banks |
| HIGH_VALUE | `highvalue.ts` | RTGS via IGS for large-value transactions |
| BULK | `bulk.ts` | Batch processing |

### State & Types

All types are exported from the single barrel `src/types.ts`, which re-exports four sub-modules:

- `src/types/primitives.ts` — `Env`, `Amount`, `BankProofRef`, FATF data shapes
- `src/types/states.ts` — State unions (`TxState`, `HtlcState`, `GtidState`, `DnsState`) as string literals
- `src/types/rows.ts` — D1 row types (`Transactions`, `Participants`, `BankAccounts`, etc.)
- `src/types/api.ts` — HTTP request/response types and queue message shapes

States are string unions (not enums). Always import types from `src/types.ts`, not the sub-modules directly.

### Database

28 tables across 14 numbered migration files in `/migrations/`. Key tables:
- `Transactions`, `Participants`, `BankAccounts`, `BankJournals` — core payment data
- `FinalityLog`, `TxEventLog` — append-only audit/trace (never updated, only inserted)
- `GtidTransactions`, `GtidLegs`, `HtlcRequests`, `RtpRequests`, `DnsCycles` — lane-specific state
- `CircuitBreakerStates`, `ReversalRequests`, `QrCodes`, `ProxyAliases`, `CrossBorderTransfers`, `EdiRecords`

**Never edit existing migration files.** New schema changes always go in a new numbered file.

Transactions use a `version` column for optimistic locking to prevent race conditions.

### Key Subsystems

- **H-Model** (`src/zc/h_model.ts`) — H-reserve prefunding; EXPRESS lane requires funds reserved before settlement decision
- **DNS** (`src/zc/dns.ts`) — Daily Net Settlement cycle (format: `DNS-YYYYMMDD-HHMMSS`)
- **Bank Ledger** (`src/bank/ledger.ts`) — Zero-sum double-entry journal; every debit has a matching credit
- **Shared utilities** (`src/shared/`) — HMAC signing, ISO 20022 XML generation, FATF R.16 validation, Zengin/ISO format conversion, idempotency, proof ref generation, routing

### Naming Conventions

- Transaction IDs: `TX-*` prefix
- Bank IDs: 3-digit codes (e.g., `001`, `002`)
- Account hashes: 10-digit strings (bank code + account suffix)
- Lane names: all-caps (`EXPRESS`, `STANDARD`, `HTLC`, etc.)
- State names: all-caps with underscores (`RECEIVED`, `PRECHECKED`, `H_RESERVED`, `DECIDED_TO_SETTLE`, etc.)
- Proof refs: `PROOF-*` prefix; decision proofs: `DECISION-PROOF-*`

## Testing

Tests live in `test/` mirroring the `src/` structure. They are integration-style: they run against an in-memory SQLite database (via `better-sqlite3`) that mirrors the full D1 schema.

- `test/helpers/d1-mock.ts` — provides `createTestDb()` which returns a `MockD1Database`
- Each test file seeds its own participants, accounts, and transactions in `beforeEach`
- `vitest` globals are enabled — no need to import `describe`, `it`, `expect`

```bash
npx vitest test/zc/express.test.ts   # single file
npx vitest --reporter=verbose        # verbose output
```
