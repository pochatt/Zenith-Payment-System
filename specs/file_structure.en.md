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
│   ├── 0010_fix_missing_columns.sql        # Missing column corrections
│   ├── 0011_fix_gtid_legs.sql              # GtidLegs schema fixes
│   ├── 0012_fix_dns_cycles.sql             # DnsCycles schema fixes
│   ├── 0013_retained_earnings_account.sql  # Retained earnings account
│   └── 0014_circuit_breaker_reversal.sql   # Circuit Breaker & Reversal tables
│
├── schema/             # Integrated schema snapshot (review & reference)
│   └── baseline.sql                        # Consolidated DDL of all migrations
│
├── specs/              # Specifications & design documentation
│   ├── zenith_public.md                    # ZC public specification & architecture map
│   ├── zenith_policy.md                    # Transaction policies & business rules
│   ├── schema.md                           # Database schema & relationships
│   ├── schema.en.md                        # Database schema (English)
│   ├── api-contracts.md                    # API contracts & JSON schemas
│   ├── api-contracts.en.md                 # API contracts (English)
│   └── file_structure.md                   # This file (Japanese)
│
├── src/                # Source code (Hono-based web server)
│   ├── index.ts                            # Main Hono router, Worker entry point, Queue/Cron handlers
│   ├── html.d.ts                           # Type declaration for importing .html as strings
│   ├── types.ts                            # Single barrel export of all type definitions
│   │
│   ├── types/                              # Type definition modules (reference via src/types.ts)
│   │   ├── primitives.ts                   # Env, Amount, BankProofRef, FATF data types
│   │   ├── states.ts                       # State string unions (TxState, HtlcState, GtidState, DnsState)
│   │   ├── rows.ts                         # D1 row types (Transactions, Participants, BankAccounts, etc.)
│   │   └── api.ts                          # HTTP I/O & Queue message types
│   │
│   ├── shared/                             # Shared utilities for ZC & banks
│   │   ├── constants.ts                    # System constants & configuration
│   │   ├── hmac.ts                         # HMAC-SHA256 signing & verification
│   │   ├── idempotency.ts                  # Idempotency-Key control
│   │   ├── iso20022.ts                     # ISO 20022 message generation & fixed-format conversion
│   │   ├── format_converter.ts             # All-bank format ↔ new message conversion
│   │   ├── routing.ts                      # Routing & BIC/bank_id mapping
│   │   ├── fatf_validator.ts               # FATF R.16 compliance validation
│   │   ├── proof.ts                        # BankProofRef generation
│   │   ├── request-id.ts                   # Deterministic request ID generation
│   │   └── validator.ts                    # ZC Ingress API payload schema validation
│   │
│   ├── cron/                               # Batch jobs triggered by Cron
│   │   ├── eod.ts                          # EOD 8-step process (DNS kick/settle, interest accrual, snapshot, etc.)
│   │   └── timeout_sweep.ts                # 1-minute stalled transaction & timelock & GTID expiry processing
│   │
│   ├── dashboard/                          # Frontend implementation (static HTML served by Hono)
│   │   ├── index.html                      # ZC operating status & main dashboard
│   │   ├── console.html                    # Bank & operations console
│   │   └── bank-app.html                   # End-user banking app mock
│   │
│   ├── openapi/                            # OpenAPI schema generation
│   │   ├── zc-api.ts                       # ZC Core API schema
│   │   └── bank-api.ts                     # Bank mock API schema
│   │
│   ├── zc/                                 # Zenith Coordinator core domain logic
│   │   ├── ingress.ts                      # Payment ingestion API & validation (/api/*, /internal/*)
│   │   ├── orchestrator.ts                 # Queue consumer & dispatcher
│   │   ├── orchestrator/                   # Async worker implementations
│   │   │   ├── state_machine.ts            # ALLOWED_TRANSITIONS / isValidTransition
│   │   │   ├── finality.ts                 # FinalityLog append & SUSPENDED confirmation
│   │   │   ├── bank_hub.ts                 # ZC→Bank call hub with Circuit Breaker
│   │   │   └── gtid.ts                     # GTID multi-leg finalization logic
│   │   │
│   │   ├── lanes/                          # Individual lane implementations
│   │   │   ├── express.ts                  # Fast-track retail settlements
│   │   │   ├── standard.ts                 # Standard payment with name check & auth
│   │   │   ├── bulk.ts                     # Bulk batch processing
│   │   │   ├── highvalue.ts                # High-value RTGS via BOJ
│   │   │   ├── htlc.ts                     # Hash-Time-Lock conditional settlements
│   │   │   ├── htlc_auth.ts                # HTLC Auth (payee-initiated authorization)
│   │   │   ├── gtid.ts                     # Global ID atomic & multi-leg settlements
│   │   │   └── rtp.ts                      # Request-to-Pay pull-initiated collection
│   │   │
│   │   ├── dns.ts                          # Daily Net Settlement cycle processing
│   │   ├── igs.ts                          # IGS high-value prefunding & immediate settlement
│   │   ├── h_model.ts                      # H-limit reserve & release
│   │   ├── qr.ts                           # QR code issuance logic
│   │   ├── proxy.ts                        # Proxy (alias) resolution
│   │   ├── pspr.ts                         # Pre-Shared Payment Reference
│   │   ├── cross_border.ts                 # Cross-border transfers & FATF compliance
│   │   ├── edi.ts                          # EDI (Enterprise Data Interchange)
│   │   ├── richdata.ts                     # Rich data (financial core vs. commercial data separation)
│   │   ├── account_verify.ts               # Account pre-verification & name check
│   │   ├── credit_notify.ts                # Credit notification to payee bank (exponential backoff)
│   │   ├── trace.ts                        # TxEventLog append (audit trail)
│   │   ├── case.ts                         # Case management (dispute/exception handling)
│   │   ├── reversal.ts                     # Reversal (post-finality remediation)
│   │   ├── circuit_breaker.ts              # Participant health monitoring & graceful degradation
│   │   ├── query.ts                        # Transaction query API (Appendix E.6 QueryResponse)
│   │   ├── stream.ts                       # SSE for banks (tx_state_change, credit_notification, rtp_request)
│   │   └── vault.ts                        # Short-term sensitive data storage (AML, PII, TTL)
│   │
│   └── bank/                               # Mock participating bank APIs & logic
│       ├── ingress.ts                      # Bank-side ZC interface handlers (/bank/*)
│       ├── teller_api.ts                   # Teller API (account status, balance query)
│       ├── customer_api.ts                 # End-user banking app API
│       ├── ledger.ts                       # Double-entry ledger & zero-sum journal core
│       ├── suspense.ts                     # Suspense & reserve account handling
│       └── filter.ts                       # AML/sanctions filtering mock
│
├── test/               # vitest test suite (in-memory SQLite integration tests)
│   ├── helpers/
│   │   └── d1-mock.ts                      # MockD1Database factory (better-sqlite3)
│   ├── shared/                             # Shared layer unit tests (hmac, validator)
│   ├── bank/                               # Bank logic tests (ledger)
│   └── zc/                                 # ZC lane, h_model, DNS, circuit_breaker tests
│
├── remote_participants.json                # Remote environment seed data
├── test.json                               # Local test payloads
├── package.json                            # Node.js dependencies (Hono, wrangler, vitest)
├── tsconfig.json                           # TypeScript compilation config
├── tsconfig.test.json                      # Test TypeScript config
├── vitest.config.ts                        # vitest configuration
└── wrangler.toml                           # (Git-ignored) Cloudflare Workers deployment config
```

## System Operation

- **Entry Point**: `src/index.ts` aggregates all HTTP routing (`/api/*`, `/bank/*`, `/internal/*`, dashboard), Queue dispatch, and Cron job triggers.
- **Database**: Cloudflare D1 (SQLite) with sequential migration files in `migrations/`. Existing migrations are immutable; schema changes always create new numbered files. `schema/baseline.sql` is a reference snapshot.
- **Domain Separation**: ZC core is in `src/zc/`, bank mock is in `src/bank/`, shared utilities in `src/shared/`.
- **Async Processing**: Queue consumer (`src/zc/orchestrator.ts` and `orchestrator/`) executes state transitions. `src/cron/` handles EOD settlement and timeout sweeping.
- **Single Type Export**: All types are exported from `src/types.ts`; implementations split across `src/types/` submodules.
- **Frontend**: HTML files in `src/dashboard/` are Alpine.js + Tailwind CSS SPAs served statically by Hono.
- **Testing**: `test/` mirrors `src/` structure, using in-memory SQLite (better-sqlite3) for integration tests.
