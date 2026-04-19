/**
 * @file ZC Core API — OpenAPI 3.0 specification (YAML string constant).
 *
 * Served at GET /api/openapi/zc.yaml.
 * Covers all ZC-side endpoints: transfers, HTLC, HTLC Auth, GTID, RTP,
 * account verification, EDI, proxy, QR, rich data, cross-border,
 * DNS, SSE, IGS, events, CASE, PSPR, and participant management.
 *
 * @module openapi/zc-api
 */
const zcApiYaml = `openapi: 3.0.3
info:
  title: Zenith Coordinator (ZC) Core API
  version: 2.0.0
  description: |
    Zenith Coordinator core API. Accepts payment initiation from participating
    banks and orchestrates multi-lane settlement (EXPRESS, STANDARD, BULK,
    HIGH_VALUE, HTLC, GTID, RTP). Provides account verification, EDI,
    proxy directory, QR payments, cross-border transfers, DNS management,
    real-time SSE events, and administrative endpoints.
  license:
    name: MIT
servers:
  - url: /
    description: Cloudflare Workers

tags:
  - name: transfers
    description: Payment initiation, authorization, and cancellation
  - name: htlc
    description: Hash Time-Locked Contract (create, claim, auth)
  - name: htlc-auth
    description: HTLC payee-initiated authorization (request, approve, decline, capture, void)
  - name: gtid
    description: Global Transaction ID — coordinated multi-leg transfers
  - name: rtp
    description: Request-to-Pay
  - name: query
    description: Transaction and event queries
  - name: dns
    description: Deferred Net Settlement cycle management
  - name: account-verify
    description: Pre-payment account name verification
  - name: edi
    description: ZEDI — structured invoice/remittance data
  - name: proxy
    description: Alias payment proxy directory (phone/email/ID)
  - name: qr
    description: QR code payment (static/dynamic)
  - name: richdata
    description: Rich data storage (EDI, invoices, attachments)
  - name: cross-border
    description: Cross-border transfers with FATF R.16 compliance
  - name: sse
    description: Server-Sent Events for real-time notifications
  - name: admin
    description: Participant/bank management and initialization

paths:
  # =========================================================================
  # Transfers
  # =========================================================================
  /api/transfers:
    post:
      tags: [transfers]
      summary: Submit payment (PaymentInitiated)
      description: |
        All lanes: EXPRESS / STANDARD / BULK / DEFERRED / HIGH_VALUE / RTP.
        Idempotent. EXPRESS settles synchronously within this request.
        Supports proxy resolution (proxy_type + proxy_value) and
        cross-border FATF R.16 validation (is_cross_border + fatf_data).
      requestBody:
        required: true
        content:
          application/json:
            schema:
              \$ref: '#/components/schemas/PaymentInitiatedRequest'
      responses:
        "200":
          description: Accepted
          content:
            application/json:
              schema:
                \$ref: '#/components/schemas/IngressAcceptedResponse'
        "400":
          \$ref: '#/components/responses/BadRequest'
        "409":
          \$ref: '#/components/responses/Conflict'
        "422":
          description: Proxy not found or FATF validation failed

  /api/transfers/{txid}/authorize:
    post:
      tags: [transfers]
      summary: Authorize transfer (STANDARD / HIGH_VALUE)
      parameters:
        - \$ref: '#/components/parameters/txid'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [txid, authorized]
              properties:
                txid: { type: string }
                authorized: { type: boolean }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Authorization result
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string }
                  txid: { type: string }
                  state: { type: string }
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/transfers/{txid}/cancel:
    post:
      tags: [transfers]
      summary: Cancel transfer (pre-Decision only)
      description: |
        Cancellable states: RECEIVED / PRECHECKED / PRECHECKED_SUSPENDED / H_RESERVED.
        Atomically releases H-reservation, bank suspense, and transitions to CANCELLED.
      parameters:
        - \$ref: '#/components/parameters/txid'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [txid, reason_code]
              properties:
                txid: { type: string }
                reason_code: { type: string, example: CANCEL_BY_PAYER }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Cancelled
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: CANCELLED }
                  txid: { type: string }
                  state: { type: string, example: CANCELLED }
        "404":
          \$ref: '#/components/responses/NotFound'
        "409":
          \$ref: '#/components/responses/Conflict'

  # =========================================================================
  # HTLC
  # =========================================================================
  /api/htlc/create:
    post:
      tags: [htlc]
      summary: Create HTLC contract
      requestBody:
        required: true
        content:
          application/json:
            schema:
              \$ref: '#/components/schemas/HtlcCreateRequest'
      responses:
        "201":
          description: HTLC created
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: HTLC_CREATED }
                  htlc_id: { type: string }
                  state: { type: string, example: HTLC_LOCKED }
        "400":
          \$ref: '#/components/responses/BadRequest'

  /api/htlc/{htlc_id}/claim:
    post:
      tags: [htlc]
      summary: Claim HTLC (reveal preimage)
      parameters:
        - name: htlc_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [htlc_id, preimage, idempotency_key]
              properties:
                htlc_id: { type: string }
                preimage: { type: string, description: SHA-256 preimage (hex) }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Claim result
        "404":
          \$ref: '#/components/responses/NotFound'
        "409":
          \$ref: '#/components/responses/Conflict'

  /api/htlc:
    get:
      tags: [htlc]
      summary: List HTLCs
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 50 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
      responses:
        "200":
          description: HTLC list

  /api/htlc/{htlc_id}:
    get:
      tags: [htlc]
      summary: Get HTLC details
      parameters:
        - name: htlc_id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: HTLC details
        "404":
          \$ref: '#/components/responses/NotFound'

  # =========================================================================
  # HTLC Auth (payee-initiated authorization)
  # =========================================================================
  /api/htlc/auth-request:
    post:
      tags: [htlc-auth]
      summary: Submit payee-initiated authorization request
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [auth_id, payee_bank_id, payee_account_hash, payer_bank_id, payer_account_hash, amount, auth_expires_at, capture_expires_at, idempotency_key]
              properties:
                auth_id: { type: string }
                payee_bank_id: { type: string }
                payee_account_hash: { type: string }
                payer_bank_id: { type: string }
                payer_account_hash: { type: string }
                amount: { \$ref: '#/components/schemas/Amount' }
                purpose: { type: string, enum: [MERCHANT, P2P, BILL, SALARY, REFUND] }
                description: { type: string }
                auth_expires_at: { type: string, format: date-time }
                capture_expires_at: { type: string, format: date-time }
                idempotency_key: { type: string }
      responses:
        "201":
          description: Auth request created

  /api/htlc/auth-requests:
    get:
      tags: [htlc-auth]
      summary: List authorization requests
      parameters:
        - name: payer_bank_id
          in: query
          schema: { type: string }
        - name: status
          in: query
          schema: { type: string }
      responses:
        "200":
          description: Auth request list

  /api/htlc/auth/{auth_id}:
    get:
      tags: [htlc-auth]
      summary: Get authorization request details
      parameters:
        - name: auth_id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Auth request details
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/htlc/auth/{auth_id}/approve:
    post:
      tags: [htlc-auth]
      summary: Approve authorization (payer side)
      parameters:
        - name: auth_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idempotency_key]
              properties:
                idempotency_key: { type: string }
      responses:
        "200":
          description: Approved

  /api/htlc/auth/{auth_id}/decline:
    post:
      tags: [htlc-auth]
      summary: Decline authorization (payer side)
      parameters:
        - name: auth_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idempotency_key]
              properties:
                reason: { type: string }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Declined

  /api/htlc/{htlc_id}/capture:
    post:
      tags: [htlc-auth]
      summary: Capture authorized HTLC (payee side)
      parameters:
        - name: htlc_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idempotency_key]
              properties:
                idempotency_key: { type: string }
      responses:
        "200":
          description: Captured

  /api/htlc/{htlc_id}/void:
    post:
      tags: [htlc-auth]
      summary: Void authorized HTLC
      parameters:
        - name: htlc_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idempotency_key]
              properties:
                reason: { type: string }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Voided

  /api/htlc/auth-whitelist:
    get:
      tags: [htlc-auth]
      summary: List auth whitelist entries
      responses:
        "200":
          description: Whitelist entries
    post:
      tags: [htlc-auth]
      summary: Register auth whitelist entry
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [payee_bank_id, payee_account_hash]
              properties:
                payee_bank_id: { type: string }
                payee_account_hash: { type: string }
                allowed_payer_bank_id: { type: string }
                max_amount: { type: integer }
                allowed_purposes: { type: array, items: { type: string } }
                description: { type: string }
                expires_at: { type: string, format: date-time }
      responses:
        "201":
          description: Whitelist entry created

  /api/htlc/auth-whitelist/{whitelist_id}:
    delete:
      tags: [htlc-auth]
      summary: Revoke auth whitelist entry
      parameters:
        - name: whitelist_id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Revoked

  # =========================================================================
  # GTID
  # =========================================================================
  /api/gtid/register:
    post:
      tags: [gtid]
      summary: Register GTID (coordinated multi-leg transfer)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              \$ref: '#/components/schemas/GtidRegisterRequest'
      responses:
        "201":
          description: GTID accepted
        "400":
          \$ref: '#/components/responses/BadRequest'

  /api/gtid:
    get:
      tags: [gtid]
      summary: List GTIDs
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 20 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
      responses:
        "200":
          description: GTID list

  /api/gtid/{gtid}:
    get:
      tags: [gtid]
      summary: Get GTID details
      parameters:
        - name: gtid
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: GTID details
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/gtid/{gtid}/events:
    get:
      tags: [gtid]
      summary: Get GTID event log
      parameters:
        - name: gtid
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: GTID events

  # =========================================================================
  # RTP
  # =========================================================================
  /api/rtp/request:
    post:
      tags: [rtp]
      summary: Create Request-to-Pay
      requestBody:
        required: true
        content:
          application/json:
            schema:
              \$ref: '#/components/schemas/RtpRequestInput'
      responses:
        "201":
          description: RTP accepted
        "400":
          \$ref: '#/components/responses/BadRequest'

  /api/rtp/incoming:
    get:
      tags: [rtp]
      summary: List incoming RTP requests (payer view)
      parameters:
        - name: account
          in: query
          required: true
          schema: { type: string }
          description: Payer account number (bank_id derived from first 3 digits)
      responses:
        "200":
          description: Incoming RTP requests

  /api/rtp/{rtp_id}/respond:
    post:
      tags: [rtp]
      summary: Respond to RTP request (accept/reject)
      parameters:
        - name: rtp_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [response, payer_bank_id, payer_account_id, idempotency_key]
              properties:
                response: { type: string, enum: [ACCEPTED, REJECTED] }
                payer_bank_id: { type: string }
                payer_account_id: { type: string }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Response recorded

  # =========================================================================
  # Emerging Architecture Integrations (Rafiki, Mojaloop, TigerBeetle style)
  # =========================================================================
  /api/stream/connect:
    get:
      tags: [stream, sse]
      summary: Rafiki-style WebSockets streaming endpoint
      description: |
        Accepts WebSocket connections for continuous micro-payment streams.
        Batches micro-transactions into D1 logs using DO Alarms.
      responses:
        "101":
          description: Switching Protocols (WebSocket Upgrade)

  /api/als/lookup:
    get:
      tags: [proxy, account-verify]
      summary: Mojaloop-style Account Lookup Service (ALS)
      description: |
        High-speed O(1) directory alias resolution utilizing KV cache.
      parameters:
        - name: alias
          in: query
          required: true
          schema:
            type: string
          description: Alias to resolve (e.g. phone:090..., payid:...)
      responses:
        "200":
          description: Resolved Bank ID and Account ID/PSPR
          content:
            application/json:
              schema:
                type: object
                properties:
                  bank_id: { type: string }
                  account_hash: { type: string }
                  pspr_ref: { type: string }
        "400":
          \$ref: '#/components/responses/BadRequest'
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/limit/reserve:
    post:
      tags: [transfers]
      summary: LimitDO H-reservation (TigerBeetle-style bottleneck bypass)
      description: |
        Synchronous highly-concurrent Limit check run on Durable Objects to bypass D1 db locks.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: integer }
      responses:
        "200":
          description: H-Reserve allocation status
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean }
                  reservation_id: { type: string }
                  reason: { type: string }
        "400":
          \$ref: '#/components/responses/BadRequest'

  # =========================================================================
  # Query / Events
  # =========================================================================
  /api/transactions:
    get:
      tags: [query]
      summary: List transactions
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 50 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
        - name: bank_id
          in: query
          schema: { type: string }
        - name: state
          in: query
          schema: { type: string }
        - name: txid
          in: query
          schema: { type: string }
          description: Prefix match on txid
        - name: account
          in: query
          schema: { type: string }
        - name: date_from
          in: query
          schema: { type: string, format: date }
        - name: date_to
          in: query
          schema: { type: string, format: date }
      responses:
        "200":
          description: Transaction list

  /api/transactions/{txid}:
    get:
      tags: [query]
      summary: Get transaction details (QueryResponse)
      parameters:
        - \$ref: '#/components/parameters/txid'
      responses:
        "200":
          description: QueryResponse (Appendix E.6 compliant)
          content:
            application/json:
              schema:
                \$ref: '#/components/schemas/QueryResponse'
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/transactions/{txid}/events:
    get:
      tags: [query]
      summary: Get transaction event log
      parameters:
        - \$ref: '#/components/parameters/txid'
      responses:
        "200":
          description: Transaction events

  /api/events:
    get:
      tags: [query]
      summary: Get recent system events
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 100 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
      responses:
        "200":
          description: Recent events

  /api/cases/{case_id}:
    get:
      tags: [query]
      summary: Get CASE details
      parameters:
        - name: case_id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: CASE details
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/cases/{case_id}/update:
    post:
      tags: [query]
      summary: Update CASE state
      parameters:
        - name: case_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [state]
              properties:
                state: { type: string, enum: [OPEN, IN_PROGRESS, RESOLVED, ESCALATED] }
      responses:
        "200":
          description: CASE updated

  # =========================================================================
  # DNS
  # =========================================================================
  /api/dns/{business_date}/status:
    get:
      tags: [dns]
      summary: Get DNS cycle status
      parameters:
        - name: business_date
          in: path
          required: true
          schema: { type: string, format: date, example: "2026-01-15" }
      responses:
        "200":
          description: DNS cycle status
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/dns/{business_date}/position:
    get:
      tags: [dns]
      summary: Get bank net positions
      parameters:
        - name: business_date
          in: path
          required: true
          schema: { type: string, format: date }
      responses:
        "200":
          description: Net position list

  # =========================================================================
  # Account Verification
  # =========================================================================
  /api/account-verify:
    post:
      tags: [account-verify]
      summary: Single account verification (name-check)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [verification_id, target_bank_id, target_account_id, idempotency_key]
              properties:
                verification_id: { type: string }
                request_bank_id: { type: string }
                target_bank_id: { type: string }
                target_account_id: { type: string }
                name_to_verify: { type: string }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Verification result

  /api/account-verify/batch:
    post:
      tags: [account-verify]
      summary: Batch account verification
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [batch_id, items, idempotency_key]
              properties:
                batch_id: { type: string }
                request_bank_id: { type: string }
                items:
                  type: array
                  items:
                    type: object
                    required: [target_bank_id, target_account_id]
                    properties:
                      target_bank_id: { type: string }
                      target_account_id: { type: string }
                      name_to_verify: { type: string }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Batch verification results

  /api/account-verify/{verificationId}:
    get:
      tags: [account-verify]
      summary: Get verification result
      parameters:
        - name: verificationId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Verification result
        "404":
          \$ref: '#/components/responses/NotFound'

  # =========================================================================
  # EDI (ZEDI)
  # =========================================================================
  /api/edi/register:
    post:
      tags: [edi]
      summary: Register EDI record (invoice/remittance data)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [edi_ref, idempotency_key]
              properties:
                edi_ref: { type: string }
                invoice_number: { type: string }
                invoice_date: { type: string, format: date }
                payment_due_date: { type: string, format: date }
                tax_amount: { type: number }
                tax_rate: { type: number }
                discount_amount: { type: number }
                note: { type: string }
                sender_ref: { type: string }
                receiver_ref: { type: string }
                line_items: { type: array, items: { type: object } }
                idempotency_key: { type: string }
      responses:
        "201":
          description: EDI record created

  /api/edi/tx/{txid}:
    get:
      tags: [edi]
      summary: Get EDI records by transaction ID
      parameters:
        - \$ref: '#/components/parameters/txid'
      responses:
        "200":
          description: EDI records
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/edi/{ediRef}:
    get:
      tags: [edi]
      summary: Get EDI record by reference
      parameters:
        - name: ediRef
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: EDI record
        "404":
          \$ref: '#/components/responses/NotFound'

  # =========================================================================
  # Proxy Directory
  # =========================================================================
  /api/proxy/register:
    post:
      tags: [proxy]
      summary: Register proxy alias (phone/email/national_id → account)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [proxy_type, proxy_value, bank_id, account_id, account_holder_name, idempotency_key]
              properties:
                proxy_type: { type: string, enum: [PHONE, EMAIL, NATIONAL_ID] }
                proxy_value: { type: string }
                bank_id: { type: string }
                account_id: { type: string }
                account_holder_name: { type: string }
                idempotency_key: { type: string }
      responses:
        "201":
          description: Proxy registered

  /api/proxy/resolve:
    get:
      tags: [proxy]
      summary: Resolve proxy alias to account
      parameters:
        - name: proxy_type
          in: query
          required: true
          schema: { type: string, enum: [PHONE, EMAIL, NATIONAL_ID] }
        - name: proxy_value
          in: query
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Resolved account
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/proxy/{proxyId}:
    delete:
      tags: [proxy]
      summary: Deactivate proxy alias
      parameters:
        - name: proxyId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deactivated

  # =========================================================================
  # QR Payments
  # =========================================================================
  /api/qr/generate:
    post:
      tags: [qr]
      summary: Generate QR code for payment
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [type, payee_bank_id, payee_account_id]
              properties:
                type: { type: string, enum: [STATIC, DYNAMIC] }
                payee_bank_id: { type: string }
                payee_account_id: { type: string }
                payee_name: { type: string }
                amount: { type: integer }
                purpose: { type: string }
                edi_ref: { type: string }
                expires_at: { type: string, format: date-time }
      responses:
        "201":
          description: QR code generated

  /api/qr/pay:
    post:
      tags: [qr]
      summary: Process QR payment
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [qr_ref, payer_bank_id, payer_account_id, idempotency_key]
              properties:
                qr_ref: { type: string }
                payer_bank_id: { type: string }
                payer_account_id: { type: string }
                amount: { type: integer }
                idempotency_key: { type: string }
      responses:
        "200":
          description: Payment initiated
        "400":
          \$ref: '#/components/responses/BadRequest'

  /api/qr/{qrRef}:
    get:
      tags: [qr]
      summary: Get QR code details
      parameters:
        - name: qrRef
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: QR code details
        "404":
          \$ref: '#/components/responses/NotFound'

  # =========================================================================
  # Rich Data
  # =========================================================================
  /api/richdata/store:
    post:
      tags: [richdata]
      summary: Store rich data (EDI, invoice, attachment metadata)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data_type, content]
              properties:
                data_type: { type: string, enum: [EDI, INVOICE, ATTACHMENT_META, REMITTANCE] }
                bank_id: { type: string }
                txid: { type: string }
                content: { type: object }
      responses:
        "201":
          description: Rich data stored

  /api/richdata/tx/{txid}:
    get:
      tags: [richdata]
      summary: List rich data by transaction ID
      parameters:
        - \$ref: '#/components/parameters/txid'
      responses:
        "200":
          description: Rich data list

  /api/richdata/{dataRef}:
    get:
      tags: [richdata]
      summary: Get rich data by reference
      parameters:
        - name: dataRef
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Rich data
        "404":
          \$ref: '#/components/responses/NotFound'

  # =========================================================================
  # Cross-Border
  # =========================================================================
  /api/cross-border/send:
    post:
      tags: [cross-border]
      summary: Initiate cross-border transfer
      description: Routes to foreign FPS. Requires FATF R.16 data.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [cb_txid, payer_bank_id, payer_account_id, foreign_fps_id, foreign_bank_bic, foreign_account_id, foreign_currency, foreign_amount, fatf_data, idempotency_key]
              properties:
                cb_txid: { type: string }
                payer_bank_id: { type: string }
                payer_account_id: { type: string }
                foreign_fps_id: { type: string }
                foreign_bank_bic: { type: string }
                foreign_account_id: { type: string }
                foreign_currency: { type: string }
                foreign_amount: { type: number }
                fatf_data: { type: object }
                idempotency_key: { type: string }
      responses:
        "201":
          description: Cross-border transfer initiated
        "400":
          \$ref: '#/components/responses/BadRequest'

  /api/cross-border/{cbTxid}:
    get:
      tags: [cross-border]
      summary: Get cross-border transfer status
      parameters:
        - name: cbTxid
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Cross-border status
        "404":
          \$ref: '#/components/responses/NotFound'

  /api/cross-border/{cbTxid}/callback:
    post:
      tags: [cross-border]
      summary: Receive cross-border status callback
      parameters:
        - name: cbTxid
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              properties:
                status: { type: string, enum: [FOREIGN_ACCEPTED, SETTLED, FAILED, RETURNED] }
                foreign_ref: { type: string }
      responses:
        "200":
          description: Status updated

  # =========================================================================
  # SSE
  # =========================================================================
  /api/sse/events/{bankId}:
    get:
      tags: [sse]
      summary: Server-Sent Events stream for a bank
      description: Long-lived SSE connection delivering real-time events (tx state changes, credit notifications, RTP requests, etc.)
      parameters:
        - name: bankId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: SSE event stream
          content:
            text/event-stream: {}

  # =========================================================================
  # IGS
  # =========================================================================
  /api/igs/callback:
    post:
      tags: [admin]
      summary: IGS (BOJ-Net) settlement callback
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [ext_instruction_id, result]
              properties:
                ext_instruction_id: { type: string }
                result: { type: string, enum: [SETTLED, FAILED, HOLD] }
                boj_settle_ref: { type: string }
                reason: { type: string }
      responses:
        "200":
          description: Callback processed

  # =========================================================================
  # Admin
  # =========================================================================
  /api/pspr/register:
    post:
      tags: [admin]
      summary: Register PSPR (Pre-Shared Payment Reference)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [pspr_ref, payee_bank_id, account_hash, expires_at]
              properties:
                pspr_ref: { type: string }
                payee_bank_id: { type: string }
                account_hash: { type: string }
                expires_at: { type: string, format: date-time }
      responses:
        "201":
          description: PSPR registered

  /api/participants/register:
    post:
      tags: [admin]
      summary: Register participant bank
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [bank_id, bank_name, ingress_base_url, h_limit]
              properties:
                bank_id: { type: string, example: "001" }
                bank_name: { type: string }
                ingress_base_url: { type: string }
                h_limit: { type: integer, example: 100000000 }
      responses:
        "201":
          description: Participant registered

  /api/banks:
    get:
      tags: [admin]
      summary: List participating banks
      responses:
        "200":
          description: Bank list
    post:
      tags: [admin]
      summary: Add bank (auto-numbering)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [bank_name]
              properties:
                bank_name: { type: string }
                h_limit: { type: integer }
      responses:
        "201":
          description: Bank created

  /api/banks/{bankId}:
    delete:
      tags: [admin]
      summary: Delete bank (no active TXs only)
      parameters:
        - name: bankId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deleted
        "409":
          \$ref: '#/components/responses/Conflict'

  /api/banks/{bankId}/accounts:
    get:
      tags: [admin]
      summary: List bank accounts
      parameters:
        - name: bankId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Account list

  /api/accounts/{accountId}/name:
    get:
      tags: [admin]
      summary: Account name lookup
      parameters:
        - name: accountId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Account name

components:
  parameters:
    txid:
      name: txid
      in: path
      required: true
      schema: { type: string }

  responses:
    BadRequest:
      description: Validation error
      content:
        application/json:
          schema: { \$ref: '#/components/schemas/ErrorResponse' }
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema: { \$ref: '#/components/schemas/ErrorResponse' }
    Conflict:
      description: State conflict (optimistic lock failure or INVALID_STATE)
      content:
        application/json:
          schema: { \$ref: '#/components/schemas/ErrorResponse' }

  schemas:
    ErrorResponse:
      type: object
      properties:
        error: { type: string }
        reason_code: { type: string }

    Amount:
      type: object
      required: [value, currency]
      properties:
        value: { type: integer, example: 10000 }
        currency: { type: string, example: JPY }

    PaymentInitiatedRequest:
      type: object
      required: [schema_version, message_type, name, message_id, idempotency_key, occurred_at, txid, lane, amount, payer, payee, purpose]
      properties:
        schema_version: { type: string, example: "1.0" }
        message_type: { type: string, example: EVENT }
        name: { type: string, example: PaymentInitiated }
        message_id: { type: string }
        idempotency_key: { type: string }
        occurred_at: { type: string, format: date-time }
        txid: { type: string, example: TX-abc }
        lane:
          type: string
          enum: [EXPRESS, STANDARD, BULK, DEFERRED, HIGH_VALUE, RTP]
        amount: { \$ref: '#/components/schemas/Amount' }
        payer:
          type: object
          required: [bank_id, account_hash]
          properties:
            bank_id: { type: string }
            account_hash: { type: string }
            vault_ref: { type: string }
        payee:
          type: object
          required: [bank_id]
          properties:
            bank_id: { type: string }
            account_hash: { type: string }
            vault_ref: { type: string }
        purpose:
          type: string
          enum: [MERCHANT, P2P, BILL, SALARY, REFUND]
        pspr_ref: { type: string }
        expires_at: { type: string, format: date-time }
        proxy_type: { type: string, enum: [PHONE, EMAIL, NATIONAL_ID] }
        proxy_value: { type: string }
        is_cross_border: { type: integer, description: "1 for cross-border" }
        fatf_data: { type: object, description: FATF R.16 originator/beneficiary data }
        qr_ref: { type: string }

    IngressAcceptedResponse:
      type: object
      properties:
        result: { type: string, example: INGRESS_ACCEPTED }
        txid: { type: string }
        state: { type: string, example: RECEIVED }

    HtlcCreateRequest:
      type: object
      required: [htlc_id, hashlock, timelock, amount, payer_bank_id, payee_bank_id, idempotency_key]
      properties:
        htlc_id: { type: string, example: HTLC-abc }
        hashlock: { type: string, description: SHA-256 hex (or empty for auto-generation) }
        timelock: { type: string, format: date-time }
        amount: { \$ref: '#/components/schemas/Amount' }
        payer_bank_id: { type: string }
        payee_bank_id: { type: string }
        payer_account_hash: { type: string }
        payee_account_hash: { type: string }
        idempotency_key: { type: string }

    HtlcRow:
      type: object
      properties:
        htlc_id: { type: string }
        state: { type: string, enum: [HTLC_RECEIVED, HTLC_LOCKED, HTLC_FULFILL_REQUESTED, DECIDED_TO_SETTLE, SETTLED, CANCELLED] }
        hashlock: { type: string }
        timelock: { type: string, format: date-time }
        amount_value: { type: integer }
        payer_bank_id: { type: string }
        payee_bank_id: { type: string }
        created_at: { type: string, format: date-time }

    GtidRegisterRequest:
      type: object
      required: [gtid, legs, idempotency_key]
      properties:
        gtid: { type: string, example: GT-abc }
        legs:
          type: array
          minItems: 2
          items:
            type: object
            required: [leg_id, role, bank_id, account_hash, amount]
            properties:
              leg_id: { type: string }
              role: { type: string, enum: [PAYER, PAYEE] }
              bank_id: { type: string }
              account_hash: { type: string }
              amount: { \$ref: '#/components/schemas/Amount' }
        expires_at: { type: string, format: date-time }
        idempotency_key: { type: string }

    RtpRequestInput:
      type: object
      required: [rtp_id, payee_bank_id, payer_bank_id, amount, expires_at, idempotency_key]
      properties:
        rtp_id: { type: string, example: RTP-abc }
        payee_bank_id: { type: string }
        payer_bank_id: { type: string }
        amount: { \$ref: '#/components/schemas/Amount' }
        expires_at: { type: string, format: date-time }
        payee_name: { type: string }
        description: { type: string }
        payee_account: { type: string }
        idempotency_key: { type: string }

    QueryResponse:
      type: object
      properties:
        txid: { type: string }
        state: { type: string }
        reason_code: { type: string }
        decision:
          type: object
          properties:
            status: { type: string, enum: [NONE, DECIDED_TO_SETTLE, DECIDED_CANCEL] }
            decision_proof_ref: { type: string }
        execution:
          type: object
          properties:
            a: { type: string, enum: [NONE, OK, NG] }
            b: { type: string, enum: [NONE, OK, NG] }
            payer_bank_proof_ref: { type: string }
            payee_bank_proof_ref: { type: string }
        case:
          type: object
          properties:
            case_id: { type: string }
            status: { type: string }
        as_of: { type: string, format: date-time }
        freshness_level: { type: string, example: GREEN }
        next_action_hint: { type: string, enum: [WAIT, RETRY_LATER, CONTACT_PAYER_BANK, OPEN_CASE] }
`

export default zcApiYaml
