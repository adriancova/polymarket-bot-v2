# ADR-007: Signed-order idempotency and unknown submissions

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-260` (secure adapter), `WP-270` (OMS and signed-order
  persistence), `WP-280` (user stream), `WP-290` (reconciliation), `WP-310`
  (rate limits and restricted modes) — **not yet implemented**
- **Supersedes / Superseded by:** none

## Context

Handoff §6 invariant 6 is unconditional: "Unknown submission state is never
treated as rejection. Reconcile using the persisted signed order/order hash
before any retry with a new salt." Handoff §9.11 gives the order state machine
and a ten-step idempotent submission protocol, and closes with a warning that is
easy to violate by habit: "Do not assume the venue supports an arbitrary
client-order-ID field."

This is the highest-consequence protocol in the system. A wrong retry does not
produce a wrong number; it produces a **duplicate real position**.

Everything below about venue behavior is taken from
`docs/venue/verified-2026-08-24.md`. Nothing in this repository has ever
submitted an order, and no live gate has been requested (ADR-010).

## Decision

### 1. The order and settlement state machines are fixed

Order states (§9.11): `PLANNED`, `SIGNED`, `SENDING`, `ACKNOWLEDGED`, `LIVE`,
`DELAYED`, `PARTIALLY_FILLED`, `FILLED`, `CANCEL_PENDING`, `CANCELED`,
`REJECTED`, `SUBMISSION_UNKNOWN`, `RECONCILING`, `EXPIRED`.

Trade settlement states (§9.11): `MATCHED`, `MINED`, `CONFIRMED`, `RETRYING`,
`FAILED`. These are separate from order state (§6 invariant 5).

### 2. The idempotent submission protocol is binding, in order

1. Create `submission_attempt_id`.
2. Create and sign the complete venue order **locally**.
3. Persist the signed payload, salt, expected order hash/identifier, and the
   execution-plan link.
4. Commit state `SIGNED`.
5. Mark `SENDING` and transmit.
6. Persist the response or the timeout.
7. On a lost response, mark `SUBMISSION_UNKNOWN`.
8. Query authoritative orders and trades using the known signed-order identity.
9. Retry the same signed order only when safe and supported.
10. **Never create a new salt until the prior attempt is authoritatively absent,
    canceled, or terminal.**

Steps 3 and 4 happen **before** step 5. A process killed between transmission and
response persistence must find a `SIGNED`/`SENDING` record on restart; a process
that transmitted without persisting first has lost the only handle to the order it
may have created (§16.6 fault-injection: "Kill trader after transmission but
before response persistence").

`submission_attempts(expected_order_hash)` is unique where known (§10.7), so the
same signed identity cannot be recorded twice.

### 3. Unknown is not rejection, and never becomes one by timeout

`SUBMISSION_UNKNOWN` resolves only through **authoritative venue reads**, never
through elapsed time, a heuristic, or an absence of a user-stream message.

The authoritative read path is documented: `GET /data/order/<order_id>`,
`GET /data/orders` (filters `id`, `market`, `asset_id`), and `GET /data/trades`
(filters `id`, `market`, `asset_id`, `maker_address`, `after`, `before`), with
HMAC-SHA256 CLOB API credentials (venue report §5).

Reconciliation triggers on submission-unknown, user-stream reconnect, startup,
market-stream gap, wallet-operation unknown, discrepancy, or manual request
(§9.17), and it pauses new submissions before comparing (§9.17 procedure).
**Ambiguous state never resumes trading** (work-plan `WP-290` acceptance).

The venue's own reconnect guidance supports this rather than contradicting it —
verbatim: "Real-time updates do not replace authoritative account reads or replay
every change missed during a disconnection" (venue report §4). A reconnect
therefore always triggers reconciliation, and no component may claim to replay
missed stream events (work-plan `WP-280` acceptance).

### 4. Order identity is the signed order, not a client id

The venue's documented order submission wraps a signed EIP-712 struct — `salt`,
`maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side`,
`signatureType`, `timestamp`, `metadata`, `builder` — with top-level `deferExec`,
`orderType`, `expiration`, `owner`, and optional `postOnly` (venue report §2.1).

**No arbitrary client-order-ID field appears in that documented request shape.**
Handoff §9.11's prohibition therefore stands: the OMS keys idempotency on the
persisted signed payload and its expected order hash, not on a correlation id it
invented. Absence from the report is evidence about the *documented* request
shape, not proof that no such field exists anywhere; `WP-260`/`WP-270` must
re-check against the pinned SDK before implementation and must not add one on
assumption.

The salt is the thing that makes two otherwise identical orders distinct, which
is why step 10 exists: a new salt creates a **new order**, and creating one while
the prior attempt might be live is how a duplicate position happens.

### 5. Response statuses map without optimism

Documented order response statuses (venue report §2.2): `live` (resting on the
book), `matched` (matched immediately), `delayed` (marketable but subject to a
matching delay when `market.trading.secondsDelay > 0`), and `unmatched`
(marketable but failed to delay — **placement still succeeded**).

Mapping:

| Venue status | OMS state | Note |
| --- | --- | --- |
| `live` | `LIVE` | resting |
| `matched` | `PARTIALLY_FILLED` / `FILLED` per amounts | settlement state is separate |
| `delayed` | `DELAYED` | **never a fill.** Verbatim: "Its `makingAmount` and `takingAmount` are `"0"`, and its `tradeIds` and `transactionsHashes` are empty because no fills exist yet. Treat it as a pending order rather than a fill." (venue report §2.2) |
| `unmatched` | not a rejection | placement succeeded; the order must be tracked and reconciled, not discarded |

Failure responses (`success: false` / `ok: false`) carry `errorMsg`, `orderID`,
`status`, `makingAmount`, `takingAmount` and do **not** carry
`transactionsHashes`/`tradeIDs` (venue report §2.2). In the SDK those two fields
are `z.array(...).default([])`: the key may be absent and `[]` is substituted, but
an explicit `null` fails to parse (venue report §17). A parser must not "fix" that
by accepting `null`.

### 6. Unknown error codes are first-class UNKNOWN

The documented error taxonomy is **not exhaustive**: the place-orders page lists
example causes (insufficient balance/allowance, price not conforming to tick size,
size below `min_order_size`, GTD expiration less than 3 minutes in the future) and
does not enumerate the server-side codes (venue report §2.4, unverified item
**U-4** in §12).

Rule: an unrecognized code is surfaced as `UNKNOWN` and never invented, mapped to
a similar-looking known code, or silently treated as a rejection. A response the
adapter cannot classify is an unknown-submission condition, not a failure.

### 7. Restricted engine modes are transport conditions, not rejections

- A matching-engine restart returns **HTTP 425 (Too Early)** on order-related
  endpoints, with **no documented response body** (venue report §9, unverified
  item **U-9** in §12). Clients key on the status code alone; recommended
  behavior is exponential backoff starting at 1–2 seconds. A 425 is not a
  rejection of the order.
- After a restart the engine is in **post-only mode for 2 minutes**: cancels are
  accepted, and new orders must set `postOnly: true` (venue report §9).
- Cancel-only mode returns HTTP 503 with an `error` field (**not** `error_msg`);
  post-only mode returns HTTP 503 with `error`, `code: "post_only_mode"`, and
  `retry_after_seconds`, plus a `Retry-After` header whose exact value format is
  not shown (venue report §9).
- **Verbatim venue guidance: "Do not retry the same non-post-only order
  unchanged."** (venue report §9). Retrying it unchanged is forbidden; changing it
  to post-only is a **new order decision**, which means a new plan and a new
  signed order, not a quiet mutation of the previous attempt.

### 8. Expiration arithmetic must account for the GTD offset

GTC rests until filled or canceled with `expiration` `"0"` or omitted. GTD expires
at a unix-seconds timestamp, and — verbatim — **"GTD orders expire one minute
before their stated expiration as a security threshold"**, with a minimum stated
expiration around 3 minutes in the future (effective floor ~2 minutes) and the
lifetime formula `now + 60 + N` (venue report §2.3).

Consequences the OMS must implement rather than discover: a GTD order that
disappears before its stated timestamp is **expected**, not an anomaly; and a
requested lifetime shorter than the floor cannot be expressed as GTD at all and
must be handled by FAK/FOK or by cancel-on-deadline (§9.10 deadline and
escalation policy).

FAK fills available liquidity immediately and cancels the remainder; FOK fills
entirely and immediately or not at all; `postOnly` applies only to resting limit
types (venue report §2.3).

### 9. Cancellation outranks placement

Safety cancellation outranks new order placement, and rate-limit scheduling
reflects that priority (§6 invariant 13, §9.13 priority order: heartbeat first,
then emergency cancel/cancel-all, then reconciliation reads, then risk-reducing
orders, then stale-quote cancellation, then new orders, then metadata).

Venue grounding: per-signer budgets are **separate order and cancel token
buckets**, with documented token costs (`POST /order` 1; `POST /orders` = batch
size; `DELETE /order` 1; `DELETE /orders` = ID count; `DELETE /cancel-all` and
`DELETE /cancel-market-orders` 1 + one per order actually canceled), and batches
are all-or-nothing — "A batch is admitted only when the bucket contains enough
tokens for every entry. Otherwise, the entire request is rejected" (venue report
§8). Cancel endpoints and their `{"canceled": [...], "not_canceled": {...}}`
response shape are documented in venue report §5.

Rate limits, tiers, and headers (`Poly-RateLimit-Remaining`,
`Poly-RateLimit-Reset`, `Poly-RateLimit-Tier`, `Retry-After`,
`Poly-RateLimit-Warning`) are **configuration snapshots with a source and an
effective time**, never constants (§9.13; venue report §8).

### 10. Heartbeat interaction

Resting orders are protected by the order-heartbeat endpoint. If valid heartbeats
stop, the venue cancels open orders owned by those CLOB API credentials after the
documented timeout (venue report §5; details and the fencing consequences are
owned by ADR-008).

Consequence for the OMS: a heartbeat lapse means resting orders may already be
gone. The OMS must treat them as `RECONCILING` rather than assuming either
outcome, and must not re-place them without an authoritative read.

### 11. Persisted signed payloads are secrets

Signed order payloads persisted for idempotency are **encrypted at rest and
access-controlled** (§15). Logs redact API keys, passphrases, signatures, and
signed order payloads (§15). A signed payload must never appear in a fixture, a
log line, or an error message.

### 12. Open venue items carried by this ADR

- **C-3 — `MATCHED_NOT_BROADCASTED` scope. UNRESOLVED.** The real-time
  order-updates documentation lists `TRADE_STATUS_MATCHED_NOT_BROADCASTED` among
  the user-stream trade settlement states, while the official SDK states verbatim
  that "MatchedNotBroadcasted currently appears only on trades read via REST, not
  on user stream trade events" (venue report §4, §11 conflict C-3). Per handoff
  §1.1 source precedence (current official **SDK behavior** controls venue facts),
  the repository models the state in the **REST-trade layer only**, and the
  user-stream model carries the five plain values. **`WP-280` must re-check.**
  Binding rule meanwhile: the absence of `MATCHED_NOT_BROADCASTED` from the user
  stream is **not** evidence that a match did not occur; an OMS waiting on stream
  confirmation must still reconcile via REST.
  Related and verified: trade statuses arrive in **two wire forms** — REST
  serializes the prefixed `TRADE_STATUS_*` constants while the user WebSocket
  serializes plain values (venue report §4, resolving former U-8).
- **U-7 — the exact `@polymarket/client` npm version is UNVERIFIED.** The
  repository page did not display it (venue report §12 U-7, §1). This entire
  protocol is written against the pinned SDK reference commit
  `7fdbed42484b5d279c71aa36d3757d18968260da` (venue report §1). **`WP-260` pins
  the npm version with a fresh check**, and if the pinned version does not
  correspond to that commit, the order request/response schemas in venue report
  §2.1, §2.2, and §4 must be re-verified **before** this protocol is
  implemented.
- **U-2 — the server-side timeout for a missed WebSocket `PING` is undocumented**
  (venue report §12). The OMS may not infer "the venue considers us
  disconnected" from stream silence; staleness detection and reconciliation
  handle it (§9.9).

## Consequences

- **Recovery is slower than a retry.** Resolving `SUBMISSION_UNKNOWN` costs
  authoritative reads and a pause on submissions. That is the intended price of
  never double-filling.
- **The persisted signed payload becomes a high-value secret** with an encryption
  and access-control requirement attached to it forever (§15).
- **The GTD offset changes strategy-visible behavior.** Any strategy or planner
  reasoning about resting time must use the effective expiry, not the stated one,
  or its resting-time model is wrong by 60 seconds.
- **Unknown error codes will be common early.** Treating them as UNKNOWN rather
  than as rejections means more reconciliation cycles at first; the alternative is
  silently abandoning live orders.
- **C-3 forces belt-and-braces reconciliation** until `WP-280` resolves it: the
  OMS cannot rely on the user stream alone to observe a match.
- **This ADR is written against a pinned SDK commit, not a published version.** If
  U-7 resolves to a version that differs from that commit, part of this ADR is
  provisional and must be re-verified rather than assumed forward-compatible.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.1 — source precedence: current official SDK behavior controls venue facts.
- §1.3 — replacing the official SDK with hand-written signing requires an ADR.
- §6 invariants 5, 6, 13.
- §9.9 — incident action ladder; "Submission response lost → Reconcile using
  persisted signed order/order hash".
- §9.10 — execution planner defines deadline and escalation policy, slicing, and
  cancel/replace hysteresis; reserves collateral/inventory before submission.
- §9.11 — the order state machine, the trade settlement state machine, the
  ten-step idempotent submission protocol, and "Do not assume the venue supports
  an arbitrary client-order-ID field."
- §9.12 — the secure venue adapter wraps only the official unified SDK, isolates
  signer access, handles delayed responses, tracks asynchronous settlement,
  handles the current error taxonomy, detects restricted modes, and consumes
  rate-limit headers.
- §9.13 — rate-limit budgets, the priority order, and "Limits are configuration
  snapshots with source and effective time."
- §9.17 — reconciliation triggers and procedure.
- §10.4, §10.7 — `execution.submission_attempts`; `submission_attempts(expected_order_hash)`
  unique where known; `orders(venue_order_id)` unique where not null.
- §15 — signed order payloads encrypted at rest and access-controlled; logs redact
  signatures and signed payloads.
- §16.6 — fault-injection scenarios: kill before transmission, kill after
  transmission but before response persistence, kill after match but before
  user-stream update, drop user-stream messages, matching-engine `425` restart,
  cancel-only and post-only mode.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §1 — the pinned SDK reference commit `7fdbed42484b5d279c71aa36d3757d18968260da`;
  `@polymarket/client` is the only permitted client; archived CLOB clients are
  rejected.
- §2.1 — the signed EIP-712 order struct and the top-level submission fields; six-
  decimal integer maker/taker amounts; tick-dependent price/size precision.
- §2.2 — response fields, the four order statuses, the failure shape, and the
  verbatim delayed-order semantics.
- §2.3 — GTC/GTD/FAK/FOK; the verbatim GTD 60-second early-expiry rule and the
  ~3-minute minimum; `postOnly` only on resting limit types.
- §2.4 — the non-exhaustive error taxonomy.
- §4 — user-channel order and trade events; the six SDK `TradeStatus` states; the
  two wire forms (REST prefixed, WebSocket plain); the verbatim reconnect
  guidance; the raw versus normalized layering; REST trade reads are a distinct
  SDK schema.
- §5 — cancel endpoints and response shape; authoritative query endpoints; the
  order-heartbeat protocol.
- §8 — IP and per-signer rate limits, token costs, all-or-nothing batches, volume
  tiers, and response headers. Snapshot with effective date 2026-08-24.
- §9 — HTTP 425 with no documented body; the 2-minute post-only window;
  cancel-only and post-only 503 bodies; verbatim "Do not retry the same
  non-post-only order unchanged."
- §11 conflict **C-3** — `MATCHED_NOT_BROADCASTED` docs-versus-SDK scope.
  **UNRESOLVED; `WP-280` must re-check.**
- §12 unverified **U-2** (missed-`PING` server timeout), **U-4** (exhaustive error
  codes), **U-7** (npm version pin — `WP-260`), **U-9** (425 response body).
- §17 — `.default([])` versus `.nullish()` versus `.nullable()`; an explicit
  `null` for `tradeIDs`/`transactionsHashes` genuinely fails to parse.

**Implementation and prior handoffs:**

- `docs/handoffs/WP-000.md` — `known_risks` (C-3 modeled per SDK, `WP-280` must
  re-check; U-4 error strings are representative paraphrases; U-9 no 425 body) and
  `follow_up` (`WP-280` confirm C-3; `WP-260` pin the npm version with a fresh
  check).
- `docs/contracts/domain.md` §8 — no synthetic venue sequence number; identifier
  formats §7.2 leaves open.

**Safety:** this ADR changes no run-mode default (ADR-010). It describes a
protocol that is **unreachable** in the repository's current state:
`ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`,
`LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`, no signer configured, and no live gate
requested. Contract tests for this path must use mocks and sanitized fixtures and
must not place real orders in ordinary CI (§16.3).
