# Repository File Structure

This document describes the directory layout and responsibilities within the Zenith Payment System mock implementation. The project comprises a TypeScript backend built on Cloudflare Workers, D1 (SQLite), Queues, and R2, alongside a frontend crafted with Alpine.js and Tailwind CSS.

## Directory & File Overview

```text
/
├── .wrangler/          # (Auto-generated) Local Wrangler environment data, including local D1 database files
│
├── migrations/         # Database schema migrations for D1 SQLite
│   ├── 0001_zc_schema.sql                  # ZC (Coordinator) core tables
│   ├── 0002_bank_schema.sql                # Participating bank tables
│   ├── 0003_trace_filter_htlc_auth.sql     # TxEventLog, AML filters, HTLC Auth
│   ├── 0004_new_settlement.sql             # New settlement mechanism tables
│   ├── 0005_rtp_request_rows.sql           # RTP request persistence
│   ├── 0006_rtp_columns.sql                # RTP column additions
│   ├── 0007_rtp_respond_columns.sql        # RTP response columns
│   ├── 0008_rtp_payee_account.sql          # RTP payee account info
│   ├── 0009_boj_prefund.sql                # BOJ prefunding provisioning
│   ├── 0010_fix_missing_columns.sql        # Missing column corrections (no-op patch)
│   ├── 0011_fix_gtid_legs.sql              # GtidLegs(txid) hot-path index
│   ├── 0012_fix_dns_cycles.sql             # DnsCycles constraint/column fix
│   ├── 0013_retained_earnings_account.sql  # Retained earnings account
│   ├── 0014_circuit_breaker_reversal.sql   # Circuit Breaker & Reversal tables
│   ├── 0015_finality_hash_chain.sql        # FinalityLog tamper-evident SHA-256 hash chain (prev_hash / entry_hash)
│   ├── 0016_performance_indexes.sql        # 13 hot-path indexes (timeout sweep, lane×state, expiry sweeps)
│   ├── 0017_circuit_breaker_metrics.sql    # CircuitBreakerState observability columns (total_denied, half_open_inflight, last_success_at, …)
│   ├── 0018_bug_fixes.sql                  # B4 ReversalRecords.approval_ref / B5,B6 FinalityLog partial UNIQUE / B8 daily reset col
│   ├── 0019_gtid_chain_fix.sql             # B9 idx_fl_gtid_chain_prev_hash (GTID-only partial UNIQUE)
│   ├── 0020_hv_threshold.sql               # Participants.hv_threshold (HIGH_VALUE auto-escalation)
│   └── 0021_finality_seq_counter.sql       # B10 FinalitySeq counter for monotonic event_seq allocation
│
├── schema/             # Integrated schema snapshot (review & reference; SoT is migrations/ + schema.md)
│   └── baseline.sql                        # Consolidated DDL of all migrations (may lag behind newest migrations)
│
├── specs/              # Specifications & design documentation
│   ├── zenith_public.html                  # ZC public specification (HTML viewer)
│   ├── zenith_public.md                    # ZC architecture & state-machine reference (~2,800 lines)
│   ├── zenith_policy.md                    # Transaction policies, governance, institutional rules
│   ├── schema.md                           # Database schema (SoT for table definitions)
│   ├── api-contracts.md                    # API contracts, JSON schemas, error catalog
│   ├── architecture.md                     # Cross-cutting implementation conventions & roadmap (errors / logger / lane helpers)
│   └── file_structure.md                   # Directory layout (Japanese; en.md is this file)
│
├── src/                # Source code (plain Cloudflare Workers fetch handler — no web framework)
│   ├── index.ts                            # Worker entry point: HTTP router, Queue consumer dispatch, Cron handlers
│   ├── html.d.ts                           # Type declaration for importing .html as strings
│   ├── types.ts                            # Single barrel export of all type definitions (re-exports types/*)
│   │
│   ├── types/                              # Type definition modules (always import via src/types.ts)
│   │   ├── primitives.ts                   # Env, Amount, BankProofRef, FATF data types
│   │   ├── states.ts                       # State string unions (TxState, HtlcState, GtidState, DnsState)
│   │   ├── rows.ts                         # D1 row types (Transactions, Participants, BankAccounts, etc.)
│   │   └── api.ts                          # HTTP I/O types, Queue message shapes, FinalityEventType union
│   │
│   ├── shared/                             # Cross-cutting utilities used by both ZC and Bank
│   │   ├── constants.ts                    # System constants & default thresholds
│   │   ├── errors.ts                       # DomainError / errorResponse / reason_code→category map (SoT for HTTP & retry)
│   │   ├── logger.ts                       # newRequestLogger (1 JSON line/event, X-Request-Id, PII auto-redaction)
│   │   ├── hmac.ts                         # HMAC-SHA256 signing & verification (Web Crypto)
│   │   ├── idempotency.ts                  # Idempotency-Key control
│   │   ├── iso20022.ts                     # ISO 20022 message generation & Zengin fixed-format conversion
│   │   ├── format_converter.ts             # Zengin ↔ new message conversion
│   │   ├── routing.ts                      # Routing & BIC/bank_id mapping
│   │   ├── fatf_validator.ts               # FATF R.16 (travel rule) compliance validation
│   │   ├── proof.ts                        # decision_proof_ref / bank_proof_ref generation
│   │   ├── request-id.ts                   # Deterministic request ID generation
│   │   └── validator.ts                    # ZC Ingress API payload schema validation
│   │
│   ├── cron/                               # Batch jobs triggered by Cron
│   │   ├── eod.ts                          # EOD 8-step process (DNS kick/settle, interest accrual, balance snapshot, daily limit reset)
│   │   └── timeout_sweep.ts                # 1-minute sweep for stalled TXs, HTLC timelock expiry, GTID/RTP expiry, htlc-auth capture timeout
│   │
│   ├── dashboard/                          # Frontend implementation (static HTML served via Worker fetch)
│   │   ├── index.html                      # ZC operating status & main dashboard (/, /dashboard)
│   │   ├── console.html                    # Bank & operations console (/console)
│   │   ├── bank-app.html                   # End-user banking app mock (/bank-app)
│   │   ├── theater.html                    # Settlement Theater — animated state transitions (/theater, /theatre)
│   │   └── sky.html                        # Sky mode — system overview (/sky)
│   │
│   ├── openapi/                            # OpenAPI schemas
│   │   ├── zc-api.ts                       # ZC Core API schema
│   │   └── bank-api.ts                     # Bank mock API schema
│   │
│   ├── zc/                                 # Zenith Coordinator core domain logic
│   │   ├── ingress.ts                      # ZC ingress API & validation (/api/*, /internal/*)
│   │   ├── orchestrator.ts                 # Queue consumer body (dispatches to orchestrator/*)
│   │   ├── orchestrator/                   # Async worker subsystems
│   │   │   ├── state_machine.ts            # ALLOWED_TRANSITIONS / isValidTransition (single source of truth for every state edge)
│   │   │   ├── finality.ts                 # FinalityLog append, finalizeCancelledTx, suspendTx, atomic CAS+log batch primitives
│   │   │   ├── bank_hub.ts                 # ZC→Bank call hub (Circuit Breaker gated)
│   │   │   └── gtid.ts                     # GTID multi-leg finalization logic
│   │   │
│   │   ├── lanes/                          # Individual lane state machines
│   │   │   ├── _helpers.ts                 # transitionWithLog / cancelInFlightTx / insertTxWithLog — CAS+FinalityLog atomic batch primitives
│   │   │   ├── express.ts                  # Fast-track retail settlements (synchronous Decision)
│   │   │   ├── standard.ts                 # Name-check + authorization-driven P2P transfers
│   │   │   ├── bulk.ts                     # Bulk batch processing (LSM scaffold; FIFO in mock)
│   │   │   ├── highvalue.ts                # High-value via BOJ RTGS (H-reserve skipped)
│   │   │   ├── htlc.ts                     # Hash-time-locked conditional settlements
│   │   │   ├── htlc_auth.ts                # HTLC Auth barrel (payee-initiated auth/capture/void)
│   │   │   ├── htlc_auth/                  # HTLC Auth split into modules
│   │   │   │   ├── whitelist.ts            # Merchant whitelist (register / revoke / list)
│   │   │   │   ├── request.ts              # Payee auth request + payer decline
│   │   │   │   ├── approve.ts              # Payer approval (preimage gen + canonical RECEIVED → HTLC_LOCKED)
│   │   │   │   ├── capture.ts              # Payee capture + void
│   │   │   │   └── query.ts                # Auth list / get
│   │   │   ├── gtid.ts                     # GTID multi-leg atomic Decision (leg_id-sorted PAYER↔PAYEE pairing)
│   │   │   ├── rtp.ts                      # RTP barrel
│   │   │   └── rtp/                        # RTP split into modules
│   │   │       ├── register.ts             # RTP request creation, payer notification
│   │   │       ├── respond.ts              # Payer accept / decline
│   │   │       └── query.ts                # RTP query + expiry cron sweep
│   │   │
│   │   ├── dns.ts                          # Daily Net Settlement cycle (kick / settle / hold / igs_mode=STOP)
│   │   ├── igs.ts                          # IGS (immediate gross settlement, BOJ-RTGS adapter)
│   │   ├── h_model.ts                      # H-limit reservation (RESERVED → LOCKED → released by DNS settle)
│   │   ├── qr.ts                           # QR code issuance (static/dynamic + HMAC validation)
│   │   ├── proxy.ts                        # Proxy directory (phone / email / corporate ID alias resolution)
│   │   ├── pspr.ts                         # Pre-Shared Payment Reference (Express addressing)
│   │   ├── cross_border.ts                 # Cross-border transfer + FATF R.16 travel-rule enforcement
│   │   ├── edi.ts                          # ZEDI-style EDI rich-data storage
│   │   ├── richdata.ts                     # Rich data store (commercial metadata decoupled from financial core)
│   │   ├── account_verify.ts               # Pre-settlement account verification (single + batch)
│   │   ├── credit_notify.ts                # Credit notification delivery (exponential backoff)
│   │   ├── trace.ts                        # TxEventLog append (detailed audit trail)
│   │   ├── case.ts                         # CASE management (OPEN → IN_PROGRESS → RESOLVED/ESCALATED, auto-close)
│   │   ├── reversal.ts                     # Reversal (post-finality remediation as separate STANDARD TX)
│   │   ├── circuit_breaker.ts              # CLOSED/OPEN/HALF_OPEN with observability metrics
│   │   ├── finality_chain.ts               # SHA-256 hash chain computation & verification (chain_id = COALESCE(txid, gtid, 'GLOBAL'))
│   │   ├── explain.ts                      # GET /api/transactions/:txid/explain (timeline + integrity.chain_verified)
│   │   ├── story.ts                        # GET /api/transactions/:txid/story (narrative + Mermaid sequence + health verdict)
│   │   ├── query.ts                        # Transaction query API (Appendix E.6 QueryResponse)
│   │   ├── stream.ts                       # SSE for banks (tx_state_change / credit_notification / rtp_request)
│   │   ├── stream_rafiki.ts                # Rafiki-style streaming micro-payments (WebSocket + Durable Object alarm)
│   │   ├── als.ts                          # Mojaloop-style account alias resolution (KV cache)
│   │   ├── limit_do.ts                     # TigerBeetle-style H-limit serialization (Durable Object)
│   │   └── vault.ts                        # Short-term sensitive data storage (AML, PII, TTL-managed)
│   │
│   └── bank/                               # Mock participating bank APIs & ledger logic
│       ├── ingress.ts                      # Bank-side ZC interface handlers (/bank/:id/zc-ingress/*)
│       ├── teller_api.ts                   # Teller API (account status, journal queries)
│       ├── customer_api.ts                 # End-user banking app API
│       ├── ledger.ts                       # Zero-sum double-entry journal core
│       ├── suspense.ts                     # Suspense & reserve account handling
│       └── filter.ts                       # AML/sanctions filter + approval workflow
│
├── test/               # vitest test suite (~30 files / ~400 cases, in-memory SQLite via better-sqlite3)
│   ├── helpers/
│   │   └── d1-mock.ts                      # MockD1Database factory + SCHEMA_MIGRATIONS list
│   ├── shared/                             # Cross-cutting unit tests
│   │   ├── errors.test.ts                  # DomainError / category mapping
│   │   ├── logger.test.ts                  # JSON shape / PII redaction / child baggage
│   │   ├── hmac.test.ts, validator.test.ts, fatf_validator.test.ts
│   ├── bank/
│   │   └── ledger.test.ts                  # Zero-sum invariants
│   ├── integration/                        # Cross-lane integration tests
│   │   ├── balance_invariants.test.ts      # Per-lane debit/credit/zero-sum + GTID 2×2 reverse-order coverage
│   │   ├── idempotency_replay.test.ts      # Same idempotency_key → single Transactions row
│   │   ├── queue_retry_policy.test.ts      # DomainError category × msg.retry()/ack() mapping
│   │   └── htlc_cancel_balance.test.ts     # TIMELOCK_EXPIRED / direct cancel restores payer suspense
│   └── zc/                                 # ZC lane + cross-cutting primitive tests
│       ├── lane_invariants.test.ts         # Static analysis: catches helper-bypassing raw SQL / unregistered FinalityEventType / missing tests
│       ├── lane_helpers.test.ts            # transitionWithLog / cancelInFlightTx / insertTxWithLog parallelism + TOCTOU
│       ├── atomic_finality.test.ts         # CAS + FinalityLog atomic batch / monotonic event_seq
│       ├── finality_chain.test.ts          # SHA-256 hash chain verification
│       ├── express.test.ts, standard.test.ts, highvalue.test.ts, htlc.test.ts, bulk.test.ts, rtp.test.ts, gtid.test.ts
│       ├── htlc_auth_canonical.test.ts, htlc_auth_regression.test.ts
│       ├── h_model.test.ts, dns.test.ts, circuit_breaker.test.ts, reversal.test.ts, daily_limit.test.ts
│       ├── orchestrator.test.ts
│       └── story.test.ts
│
├── remote_participants.json                # Remote environment seed data
├── test.json                               # Local test payloads
├── package.json                            # Node.js dependencies (wrangler, vitest, better-sqlite3 — no web framework)
├── tsconfig.json                           # TypeScript compilation config
├── tsconfig.test.json                      # Test TypeScript config
├── vitest.config.ts                        # vitest configuration
└── wrangler.toml                           # (Git-ignored) Cloudflare Workers deployment config
```

## System Operation

- **Entry Point**: `src/index.ts` aggregates all HTTP routing (`/api/*`, `/bank/*`, `/internal/*`, dashboard pages), Queue consumer dispatch, and Cron job triggers. Every response carries `X-Request-Id` for log correlation.
- **Database**: Cloudflare D1 (SQLite) with sequential migration files in `migrations/`. Existing migrations are **immutable**; schema changes always create a new numbered file, and `test/helpers/d1-mock.ts#SCHEMA_MIGRATIONS` must be updated in the same change. `schema/baseline.sql` is a reference snapshot only.
- **Domain Separation**: ZC core in `src/zc/`, bank mock in `src/bank/`, shared utilities in `src/shared/`. Lane mutations to `Transactions` go through `src/zc/lanes/_helpers.ts` (`transitionWithLog` / `cancelInFlightTx` / `insertTxWithLog`) — direct `UPDATE`/`INSERT` is enforced-out by `test/zc/lane_invariants.test.ts`.
- **Async Processing**: Queue consumer (`src/zc/orchestrator.ts` and `orchestrator/`) executes state transitions. `src/cron/` handles EOD settlement and timeout sweeping.
- **Single Type Export**: All types are exported from `src/types.ts`; implementations are split across `src/types/` submodules.
- **Frontend**: HTML files in `src/dashboard/` are Alpine.js + Tailwind CSS SPAs served statically as `Response(htmlString)` by the Worker fetch handler.
- **Testing**: `test/` mirrors `src/` structure. Integration tests use in-memory SQLite (better-sqlite3) with the full schema. `lane_invariants.test.ts` performs source-level regex checks; `balance_invariants.test.ts` asserts double-entry zero-sum across every lane.
