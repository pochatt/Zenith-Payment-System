# Zenith Policy — English Digest

> A one-paragraph-per-section English digest of [`zenith_policy.md`](zenith_policy.md). The Japanese original is the source of truth; this digest exists so non-Japanese readers can grasp the shape of the institutional layer without reading the full text.
>
> **Caveat — jurisdiction.** The policy is written within the legal and supervisory context of **Japan** (the Banking Act, the Payment Services Act, the Act on the Protection of Personal Information, FATF Recommendations as implemented domestically, and prudential expectations of the Bank of Japan and the Financial Services Agency). Wording such as "supervisor", "central bank", "operating company", "participant agreement", and the role of CASE-based exception management presumes these institutions. Adoption in another jurisdiction would require re-grounding each prohibition, retention period, and approval authority in local law and regulatory practice.
>
> Chapter and section numbers below mirror the Japanese original.

---

## 1. Design Principles

### 1.1 Principles

Seven principles, in priority order: **(i) Explainability First** — state, reason, and evidence precede features; **(ii) Privacy by Design** — data minimisation, access minimisation, and auditability, never bolted on later; **(iii) Neutrality and Fair Access** — no discrimination in entry, pricing, or data; the design must pre-empt the misperception that a joint utility restricts competition; **(iv) Operational Feasibility** — front-line staff must be able to act, with explicit authority, procedure, and evidence; **(v) Resilience as Institution** — degradation, suspension, and resumption are held by institutional priority and authority, not by code paths alone; **(vi) Backward Compatibility** — gradual transition over disruptive replacement; **(vii) No Heroics** — designs that require sustained overtime to function are disallowed, and exceptions are institutionalised as CASEs rather than absorbed quietly.

### 1.2 Trade-offs (decision rule)

When principles collide, the priority order is: **public interest** (user protection and stability) → **neutrality** (competition policy) → **operational feasibility** → **cost**. Three named trade-offs guide design: immediacy vs risk control (systemically important domains favour control; immediacy must come with a degradation path; "unstoppable immediacy" is forbidden); openness vs manageability (resolved by two-tier participation — settlement participants and connected participants — with explicit prudential requirements for the latter; arbitrary refusal of entry is forbidden); transparency vs privacy (transparency is delivered by evidence trails, privacy by minimised access; aggregated full-data warehousing is forbidden).

### 1.3 Normative summary of Chapter 1

Exceptions are never absorbed by operational improvisation; they are institutionalised as CASEs. Privacy is held by minimisation plus auditability. Neutrality is enforced by enumerated prohibitions, not by aspiration. Institutions that fail the migration test are not adopted.

---

## 2. Institutional Specification — capabilities and rules

### 2.1 Scope (In / Out)

**In scope**: transfer-equivalent payments, account-to-account transfers, Request-to-Pay (RTP), and conditional settlement (HTLC); two participation classes — settlement participants (banks and equivalent) and connected participants (PSPs and equivalent); upper limits and high-value coordination are handled in a separate framework. **Out of scope**: securities settlement, physical cash transport, direct connection by unqualified parties, and "unlimited uncontrolled immediacy".

### 2.2 Processing rules

**Acceptance** assigns a transaction identifier (`txid`, or `gtid` for grouped) at the moment a participant receives a customer instruction, after which the transaction is queryable. **Cancel** is permitted only before b (`PAYEE_EXEC_CONFIRMED`) and only under specified conditions (mis-send, double-send, etc.) accompanied by evidence (the customer's cancellation request, counter-party consent, …). **Correct**: standalone correction of essential fields (amount, payee) is forbidden because audit, inquiry, and dispute resolution all break under it; the only permitted form is cancel + re-instruct. **Reversal**: after b, remedies are issued as a new transaction (Reversal), requiring payee consent, a court / statutory order, or a supervisory request. **Freeze, attachment, suspicious-activity hold**: account-level execution sits with the participant; ZC supplies state (`FREEZE`, `LEGAL_HOLD`) and evidence references, not legal judgement.

### 2.3 HTLC (conditional settlement)

HTLC is a conditional reservation, not a finality event: while in `HTLC_LOCKED`, the condition is unmet and the row remains subject to cancellation or expiry. Funds are held by the paying participant in an internal HTLC-escrow account, with customer-facing disclosure in the participant's terms. Third-party rights (attachment, insolvency procedures, etc.) are executed by the participant according to law and contract; ZC provides `FREEZE` / `LEGAL_HOLD` state and references to evidence without taking a legal position. ZC never holds the HTLC secret itself — only `secret_hash` and verification evidence (presentation timestamp, verification result, signature reference). Responsibility for suspected illegitimate fulfilment (e.g. preimage leakage) sits first with the customer-facing participant, with recourse allocated under the participant agreement based on presentation and custody responsibility.

#### 2.3.1 HTLC Auth (payee-initiated authorisation)

A card-style "authorise now, capture later" overlay on HTLC, targeted at e-commerce, hospitality, rental, and similar cases where credit must be reserved before the final amount is known. States flow `AUTH_REQUESTED → AUTH_APPROVED → CAPTURED | VOIDED | EXPIRED`; the underlying Transactions row follows the canonical `RECEIVED → HTLC_LOCKED → … → SETTLED` path. Payees must be pre-registered on `HtlcAuthWhitelist` — whitelisting is itself an institutional act of the ZC operator, bounded by `allowed_payer_bank_id`, `max_amount`, and `allowed_purposes`. Merchant-onboarding responsibility (KYB-equivalent credit and adverse-party screening) sits with the ZC operator and the receiving participant. Capture timeouts auto-release funds via ZC's `timeout_sweep` cron. Canonical entry is mandatory: rows must enter at `RECEIVED` and transition through `HTLC_LOCKED` via the audited helper, not be inserted directly at `HTLC_LOCKED`. The preimage is held in the ZC Vault under `data_type='HTLC_PREIMAGE'` with TTL capped at `capture_expires_at + 60 minutes`, and never appears in FinalityLog payloads (only a hash prefix).

### 2.4 GTID (multi-party coordinated transactions)

A GTID groups several legs under a single reference identifier; **legal effect arises per leg**. Finality (b) is per-leg, declared on each leg's `PAYEE_EXEC_CONFIRMED`. The accounting / customer-facing completion date (`gtid_completion_date`) is the date on which all legs reach b, but DNS recognition is per leg (no GTID-level netting). A partial non-completion past `PR-GTID-TTL` puts the GTID into `GT_SUSPENDED`; insolvency-related clawback acts only on the affected leg and does not unwind already-final legs. Two pre-decision invariants are normative: **amount balance** (sum of payer-leg amounts equals sum of payee-leg amounts; violation → `AMOUNT_BALANCE_MISMATCH`) and **role completeness** (at least one PAYER leg and one PAYEE leg; violation → `MISSING_LEG_ROLE`). The PAYER–PAYEE pairing is determined by `leg_id` lexicographic order; pairings based on insert order or DB ROWID are explicitly forbidden because they have produced wrong-bank settlements in real systems.

### 2.5 DNS and DNS_HOLD

#### 2.5.1 Position

Daily Net Settlement (DNS) compresses many same-day transactions into net positions between participants for daily clearing. **DNS_HOLD** is the state in which a net debtor cannot settle on the day. It is treated **not as a cancellation but as a request for bridge liquidity**. Information disclosure during HOLD is bound to a pre-approved public message template, aligned with the official supervisory position, to avoid bank-run-inducing rumour and risk transmission.

#### 2.5.2 DNS_HOLD escalation protocol

Detection by the central bank during clearing triggers notification to the operating company ("operating DM") and the ZC operator. The official status `HOLD_ACTIVE` is broadcast to participants. The losing participant must first attempt **self-help** (market funding, intra-firm liquidity movement, collateral pledging). If insufficient, the operating DM activates pre-contracted **Liquidity-Providing-Bank (LPB)** commitments; funds land in a special liquidity-pool account at the central bank. If still insufficient, a **mutual contribution** call is issued to all participants under prior regulation, with funds delivered to the same pool. If still insufficient, the central bank may, under consultation with supervisors and on its own statutory basis, provide **special liquidity** into the same pool. Unresolved HOLDs roll over to the next business day with continuation, suspension, or default-management consequences.

#### 2.5.3 Liquidity risk quantification (parameters fixed by regulation)

**Coverage target** under normal conditions: LPB commitments plus mutual-contribution commitments must cover the largest net debtor's shortfall. Under stress: an additional fraction `PR-LIQ-COVER2_FACTOR` of the second-largest net debtor's shortfall is required, including short-term funding mechanisms (collateral pledging, same-day inter-account movement). **Early-warning indicators (EWI)** are defined per participant (net-debit trajectory, collateral capacity, funding tightness) and at system level (HOLD frequency, mean time to clear, LPB / mutual-contribution invocation count). **Stress tests** run monthly (standard scenarios) and annually (crisis scenarios). Pass criteria (same-day resolution rate ≥ X, maximum resolution time ≤ Y) are fixed by regulation; failing them triggers review of fees, participation requirements, or H limits.

#### 2.5.4 Roll-over and default management

A HOLD that cannot resolve in-day rolls over to the next business day, but only for a specified time / count. Beyond that, the **participant default management process** (exclusion-recalculation, participation suspension, insolvency handling) must engage. Indefinite roll-over is forbidden.

### 2.6 Normative summary of Chapter 2

Scope is fixed by In / Out and may not creep. Cancellation is bounded before b. Standalone correction is forbidden. After b, only Reversal applies. Freezes and attachments are executed by the account-managing participant; ZC supplies state and evidence.

### 2.7 HIGH_VALUE auto-escalation threshold governance

`Participants.hv_threshold` rewrites a sender-specified `EXPRESS` or `STANDARD` request to the `HIGH_VALUE` lane above a configured amount, tilting the immediacy-vs-risk trade-off toward control. **Changing this threshold is an institutional act, not a technical setting.** It requires four-eyes approval by the designated ZC operator authority, an impact analysis (volume, participant notification), supervisory pre-consultation per policy, and a notice period. Defaults: per-participant override on `Participants.hv_threshold`; system default via the `ZC_HV_THRESHOLD` environment variable; final fallback ¥100 million. Forbidden: dynamic threshold changes for load avoidance, discriminatory threshold setting against particular participants (other than on legitimate credit grounds), and lowering the threshold to spoil a participant's immediacy. Each change is logged with `evidence_ref` (proposal, approval document) and approver id.

---

## 3. Governance in Action

### 3.1 DNS_HOLD initial communication, public disclosure, customer messaging

On HOLD declaration, the ZC operator privately notifies supervisors (financial supervisor and central bank) within a regulated time window, and notifies the affected parties within the same window. A confidential all-participants status is broadcast, but root-cause attribution and shortfall amounts remain restricted to a need-to-know audience under ABAC plus audit log. If public disclosure becomes necessary, it is issued in consultation with supervisors within a regulated window, using only pre-approved templates (`public_message_id`). Participants' customer messaging is bound to the same templates, with explicit prohibitions: **(a)** naming a particular participant (unless that participant has publicly disclosed itself), **(b)** quantitative information (shortfall amount, debt ratio), and **(c)** conclusory wording such as "bankrupt" or "insolvent".

### 3.2 Data governance (minimisation plus auditability)

ZC does not hold PII such as full names, addresses, or account numbers. It holds **only the minimum data needed for coordination plus the evidence trail required for explainability**.

#### 3.2.1 Data minimisation catalogue

The catalogue specifies, per data item, purpose, storage form, retention period, and access roles. Examples: `txid` / `gtid` / `leg_id` (10 years, plaintext); participant id (10 years, plaintext); amount and currency (10 years); state transitions (10 years in FinalityLog under WORM); per-participant customer identifier (5 years as salted hash, viewable only by that participant for matching); network metadata such as IP (2 years, masked and aggregated, viewable only by SOC/CSIRT and audit); evidence references such as `proof_ref` (10 years, id-only); CASE classification and deadlines (10 years). Adding a new data item requires a coordinated decision on purpose, retention, and access — **opportunistic collection ("it might be useful") is explicitly forbidden**.

#### 3.2.2 Access control and audit

Five roles are defined with explicit "can-see" and "cannot-see" scopes — participant operations, participant legal / compliance, operator SOC / CSIRT, audit, and supervisor — each paired with a specified audit mechanism (access register reviews monthly; audit reviews quarterly; SIEM monitoring continuous; supervisor disclosure register with post-disclosure review).

##### 3.2.2.1 Purpose codes (P01–P07)

Every data access request must carry a **purpose code** with a named originator and approver, defining minimum data scope and audit-trail requirements. The seven codes are: **P01** customer state inquiry; **P02** CASE handling (cancel, correct, reversal); **P03** fraud first-strike (kill-switch); **P04** audit (annual or thematic); **P05** regulatory inquiry under statutory grounds; **P06** incident analysis; **P07** fund payouts and recoveries. Access without a purpose code, cross-customer profiling, normalised mass extraction, and external export are forbidden as serious compliance violations, and trigger immediate access suspension.

###### 3.2.2.1.1 Audit logging and violation detection

Every data access is recorded in the Access Audit Log with subject, purpose code, approver, scope, timestamp (RFC 3339), decision (permit / deny), reason code, and export reference where applicable. **Real-time blocks** auto-fire for requests without a purpose code or approver, and for queries matching prohibited patterns (mass search, ranking, correlation discovery); each block raises `DataAccessViolationDetected`. **Post-hoc detection** picks up cross-participant matching by the same subject, repurposing of data originally fetched under a different code, and export-retention violations, escalating each into a CASE. Serious violations are notified to supervisors, the operating company, and the audit lead within `PR-DATA-VIOLATION_NOTIFY_TTL`.

##### 3.2.2.2 Break-glass (emergency access)

Emergency access is restricted to customer-impacting incidents and serious fraud response, with mandatory expiration and post-incident review. The applicant submits purpose, scope, and expiration; the operating DM approves with parallel notification to the audit lead. Approved access is logged with reason and scope, reviewed by audit within a specified window; rejection is recorded with reason. Renewal requires re-application.

##### 3.2.2.3 Acquisition and export controls

Mass search, ranking queries, and correlation discovery are not permitted; queries are restricted to transaction id, CASE id, or participant key. Bulk CSV-style export is in principle prohibited, allowed only for audit with WORM retention and export-handling controls. Maximum grant duration is fixed by policy; expired grants require re-application rather than extension.

### 3.3 Evidence retention (WORM) and third-party assurance

The FinalityLog, the disclosure register, and the fund-payout register are retained in WORM-equivalent form with mandatory tamper detection. Audit reviews the working of WORM (integrity) annually.

---

## Source

The Japanese original is [`zenith_policy.md`](zenith_policy.md) in this repository. When wording differs, the Japanese controls. Cross-references in the code base (`reason_code`, table names, state literals) match the originals exactly.
