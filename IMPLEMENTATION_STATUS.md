# Implementation Status

Last updated: 2026-08-26  
Specification version: 2.0.0  
Current phase: `phase-1` — recording-ready (Wave 0 closed 2026-08-26)  
Maximum permitted run mode: `PAPER`

## Safety state

- `MAX_RUN_MODE=PAPER`
- `ALLOW_REAL_ORDERS=false`
- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`
- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
- Production signer configured: **No**
- Real venue credentials required: **No**
- Human live-micro approval: **Not granted**

## Work packages

| Work package           | State    | Dependencies       | Assignment |
| ---------------------- | -------- | ------------------ | ---------- |
| `WP-000`               | Complete | None               | Merged `d427f00` (impl chain `8d16849`→…→`ddc56ff`, 6 review rounds) |
| `WP-010`               | Complete | None               | Merged `12ce0ab` (impl `1bca7cf`) |
| `WP-020`               | Complete | `WP-010` ✓         | Merged `25bc451` (impl chain `815b6cb`→`9790e0a`→`8d9596e`) |
| `WP-030`               | Complete | `WP-000` ✓, `WP-020` ✓ | Merged `59cf254` (impl chain `051bb62`→`1e30ff1`→`66d29a9`→`21a3370`) |
| `WP-015`               | Complete | `WP-030` ✓         | Merged `d77b2ba` (impl chain `bb441dc`→…→`b2b3b9b`, 10 review rounds) |
| `WP-040`               | Complete | All ✓             | Merged `d23bb67` (impl chain `0a73ffe`→…→`f8982bf`, 5 review rounds) |
| `WP-050`               | Complete | All ✓             | Merged `8a607ec` (impl chain `32cb0a8`→`3c2228a`→`a972e96`→`3f35a0c`→`b3a906f`→`22db770`, 4 review rounds) |
| `WP-060`               | Complete | All ✓ | Merged `af29b08` (impl chain `d7bbb0f`→…→`954e764`, 3 review rounds) |
| `WP-090`               | Complete | All ✓ | Merged `335b1b0` (impl chain `aa74419`→…→`fa518e7`, 3 review rounds) |
| `WP-070`, `WP-080`     | IN_PROGRESS (Wave 1 batch 1B; C-4 phase gate satisfied 2026-08-27) | All ✓ | In remediation round 2 of their review loops; workplan lockfile/handoff ratifications added 2026-08-27 |
| `WP-100`               | Dependency-ready; sequenced AFTER `WP-070` merges (path subset) | All ✓ | — |
| `WP-260`               | Dependency-ready; DEFERRED to Wave 3 by wave ordering and signer-boundary safety | All ✓ | — |
| All other packages     | Blocked  | See work plan      | —          |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents
may begin in the current run; "Dependency-ready" rows must not start until this
table says otherwise.

### Wave 1 batch 1B phase-gate record (2026-08-27)

- **C-4 phase-start venue re-check executed by the orchestrator** (owner per the
  Wave 0 closeout record) before batch 1B dispatch: both pages re-fetched
  2026-08-27. `https://docs.polymarket.com/trading/quickstart` ("Place Your
  First Order") demonstrates only the unified `@polymarket/client`
  (`createSecureClient`, `@polymarket/client/viem`; Python `polymarket`
  package); `https://docs.polymarket.com/trading/overview` names no SDK
  package. The review-claimed archived-SDK references remain NOT REPRODUCED.
  Register row C-4 annotated in `docs/contracts/protected-contracts.md`
  (dated orchestrator governance edit); next re-check at the phase-2 start
  gate.
- `pnpm ops:verify-venue` (offline validation of the frozen report): exit 0,
  all sections PASS.
- Batch 1B dispatch: WP-070/WP-080/WP-090 in parallel (three worktree-isolated
  implementers — within the AGENTS.md four-agent ceiling and the runbook's
  two-to-three adapter recommendation; paths disjoint; `pnpm-lock.yaml`
  mechanically shared, reconciled at merge per the recorded WP-040/WP-050
  lockfile-regeneration procedure). WP-100 remains sequenced strictly after
  WP-070 merges (path subset). WP-070 packet carries the accumulated
  obligations: reworded C-1/U-1 acceptance criterion, register R-2 (venue
  schemas not hand-transcription-load-bearing within its paths), ADR-002 §7
  `.nullish()`-to-absent adapter rule, and the §9 fixture-only-narrowings
  binding list.

### Wave 1 batch 1B in-flight records (2026-08-27)

**WP-090 (Coinbase adapter):**
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-aab9b11346f9eb037`,
  base `145fc32`; chain `aa74419` (impl) → `44eb525` (handoff SHA record).
  58 files, all allowed; lockfile +16/−0. Orchestrator reproduced gates:
  root 1823/1823, contract 72/72 (offline), check:deps PASS. Public
  unauthenticated Advanced Trade WS; 15 venue facts cited (2026-08-27);
  C-CB-1 (per-product vs per-connection `sequence_num`) resolved per-connection
  on AsyncAPI authority; disclosed read-only 25s public-feed observation (no
  credential/order/fixture) settles the ADR-004 Coinbase-framing item: all
  frames UTF-8 JSON.
- Review round 1 (fresh Codex `01a044bd-10a2-7a22-8777-e20d8ac910dc`): **CHANGES
  REQUIRED** — 0 blocker, 2 high (H1 a malformed snapshot records channel
  satisfaction before validation, so an invalid trade snapshot plus a valid
  ticker snapshot falsely emits `FeedResynchronized`; H2 frames/callbacks from a
  closed connection are accepted and relabeled as current-generation data),
  2 medium (M1 a rejected trade reserves its dedupe identity so a corrected
  valid copy is suppressed; M2 silent paths — market-trades message timestamp
  unvalidated before use as venue time, heartbeat counter reuse/regression
  silently continued), 1 low (handoff "every frame yields output" overclaim).
  Venue judgments: V1/V2/V3/V5 ACCEPT (reviewer independently refetched the
  official pages; maker-side inversion required and correctly isolated);
  V4/V6 REJECT via H1/H2/M1. Deviations D1/D2/D3/D5 ACCEPT, D4 REJECT (M2).
  Remediation round 1 dispatched.
- Remediation round 1 completed 2026-08-27 in `d03391f` (+ doc `72587d1`),
  fresh repair session, probes reproduced first, per-finding mutation checks:
  H1 → channel satisfaction only via per-entry applied/refused verdicts (a
  knowingly suppressed duplicate counts as applied to avoid a reconnect
  livelock — pinned by its own test; refusals reported via new
  `COINBASE_SNAPSHOT_NOT_APPLIED`); H2 → `ingestFrame` takes a
  connection-origin parameter and refuses superseded connections with no
  state change, listeners bound to connection ordinal; M1 → deduplicator
  split into `isKnown`/`remember`, identity recorded only after the domain
  boundary; M2 → envelope timestamps validated on every classified arm
  (invalid → venue-time cleared, raw preserved), heartbeat tracker switch
  exhaustive with `COINBASE_HEARTBEAT_REGRESSED`; L1 → claim corrected in
  handoff and module header. Also surfaced: a literal U+0000 byte in the
  dedupe key separator replaced with a visible escape. Anomaly codes 16→19,
  contract tests 72→91, three new fixtures. Orchestrator fast-forwarded the
  canonical branch to `72587d1` and reproduced gates: root 1826/1826,
  contract 91/91, paths clean, lockfile untouched. New disclosed risk for
  review: a channel whose snapshot persistently fails to apply never
  resynchronizes — loud reconnect loop, not silent. Review round 2
  dispatched.
- Review round 2 (fresh Codex `01a0463c-8177-7601-b578-5d83e7009c28`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker, 1 high (H1 residue: a refused
  LATER snapshot does not revoke the channel's earlier satisfied mark —
  valid→refused→other-channel ordering still falsely emits
  FeedResynchronized), 2 medium (H2 residues: a retired socket's frame is
  accepted during the replacement's CONNECTING interval because the
  processor's connection id updates only on open; a synchronous `onOpen`
  loses subscriptions — `#socket` is assigned only after `connect()` returns,
  so `#sendSubscriptions` sees undefined — the exact timing invoked to
  justify ordinal binding), 2 low (handoff says five new counters, actual
  four; omitted-`from` origin parameter is a disclosed public-API risk — the
  bundled manager always supplies it). M1/M2/L1 confirmed FIXED;
  suppressed-counts-as-applied ACCEPTED (M1 prevents identity poisoning);
  U+0000 fix verified; post-open retired callbacks all correctly refused
  with observable counters; reconnect-loop risk accepted as loud fail-closed
  with WP-120 owning escalation. Remediation round 2 dispatched.
- Remediation round 2 completed 2026-08-27 in `e31b711` (+ doc `fa518e7`),
  probes reproduced byte-for-byte first, per-finding mutation checks:
  R2-H1 → `#noteSnapshot` deletes the channel's seen-mark when a snapshot is
  not fully applied (revocation reported in the anomaly; deliberately does
  NOT re-open an already-closed gap — a refused restatement establishes no
  loss); R2-M1 → manager gates `onFrame` on the captured ordinal AND the
  processor gained `staleConnectionFrame(raw, from)` (counts, classifies
  with raw preserved, zero state change); R2-M2 → per-attempt
  `withSocket(action)` holds socket-dependent actions until `connect()`
  returns; synchronous callbacks remain legal; the `onFrame`-triggered drop
  shared the hole and is covered; R2-L1 → five→four corrected; R2-L2 →
  optional `from` kept per the accepted API shape with the risk documented
  precisely. Orchestrator fast-forwarded the canonical branch to `fa518e7`
  and reproduced gates: root 1827/1827, contract 94/94, paths clean,
  lockfile untouched. Review round 3 dispatched.
- Review round 3 (fresh Codex `01a0465f-25ef-7451-8601-9744555a22c7`,
  candidate `fa518e7` vs base `145fc32`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: sandbox-blocked root-suite subprocess tests; covered by the
  orchestrator's exact-commit 51/1827 reproduction). All round-2 fixes
  verified under direct adversarial interleavings (post-closure refusal →
  reconnect → single-channel snapshot does NOT resync; connecting-window
  frames refused with zero mutation; synchronous-open subscription delivery
  proven on start, reconnect, stop-from-callback, overtaken-attempt, and
  already-closed paths); no-reopen rationale ACCEPTED; trusts-its-caller
  trade ACCEPTED as disclosed LOW; mutation claims spot-verified.
- Merged to `main` as `335b1b0` under the release manager's standing
  delegation (2026-08-27). Post-merge on `main`: root 1827/1827, fault
  89/89, integration 208/208 + 81/81, contract 94/94 via the NEW root
  `test:contract` script wired by the orchestrator in the completion commit
  (with a CI "Venue contract tests (offline fixtures)" step; to be extended
  as WP-070/WP-080 merge), audit clean, frozen install verified.
  WP-090 is the first batch-1B merge; WP-070/WP-080 remain on base
  `145fc32` and their lockfile unions will be reconciled at their merges.

**WP-080 (Binance adapter):**
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a24ead9170631b1c6`,
  base `145fc32`; chain `cff20ba` (impl) → `be5d67a` (handoff). 48 files, all
  allowed; lockfile +16/−0. Orchestrator reproduced gates: root 1902/1902,
  contract 108/108 (offline), check:deps PASS. 15 venue facts cited from the
  official `binance/binance-spot-api-docs` (2026-08-27); ADR-004 framing item
  answered (JSON endpoints carry JSON; the binary SBE path is a different,
  key-required host, refused by construction); UNVERIFIED register BNC-U1..U6.
  Review round 1 dispatched.
- Review round 1 (fresh Codex `01a0461f-aa31-7a93-98dd-1cd768972403`): **CHANGES
  REQUIRED** — 0 blocker, 1 high (H1 retired-socket callbacks carry no immutable
  connection identity on MESSAGE/ERROR/CLOSE, so a stale socket's trade is
  relabeled as the current connection/generation and a stale close tears down
  the active feed — same defect class as WP-090's H2), 2 medium (M1 the
  combined-wrapper `stream` label is trusted unvalidated: a wrapper/payload
  symbol-or-kind mismatch is normalized instead of classified; M2 only the
  latest trade id is remembered, so a delayed non-adjacent duplicate is
  published twice as a "late observation"), 2 low (L1 BNC-U4 register text
  contradicts actual partial-book behavior; L2 MAX_FRAME_BYTES enforced as
  UTF-16 chars, not bytes). Venue judgments: V1 PASS (reviewer re-fetched all
  official sources), V2 ACCEPT (ADR-004 settlement complete), V4 **ACCEPT
  omission of `takerSide`** (frozen artifacts do not resolve the vocabulary;
  domain owner must rule; do NOT add a mapping from the current sample),
  V3/V5 FAIL only via H1/M1/M2/L1. All five deviations and all assumptions
  ACCEPTED (incident-per-generation contingent on H1). Remediation round 1
  dispatched.
- Remediation round 1 completed 2026-08-27 in `73b70bc`, fresh repair session,
  probes reproduced first, per-finding mutation checks (identity-gate
  mutation → 44 failures): H1 → `connectionId` required on all four
  socket-event variants, stamped once per socket by the factory; the feed
  accepts events only from the live socket (bounded retired-id FIFO 256);
  refused events mutate nothing and return typed `rejected` outcomes with a
  counter and incident; frames get a `STALE_CONNECTION` classification with
  raw preserved; ERROR/CLOSE from a never-live identity still accepted while
  nothing is live (failed connect attempts can direct reconnects); M1 →
  wrapper must equal the payload-derived lowercase `<symbol>@<suffix>` AND
  belong to the resolved subscription set (`CHANNEL_MISMATCH`/
  `CHANNEL_NOT_SUBSCRIBED`); an unconfirmable wrapper is
  `UNVERIFIED_WRAPPER` and never becomes `sourceChannel`; M2 → bounded
  per-key FIFO window of recent id→identity pairs (default 64), previously
  seen ids duplicate regardless of arrival order, eviction consequence
  documented and observable; L1 → register text distinguishes one-vs-both
  unusable sides with a behavior-pinning test; L2 → UTF-8 byte measurement;
  off-state frames now `STALE_CONNECTION` instead of throwing. Disclosed
  deviation: socket-event callbacks take the connection id as a REQUIRED
  first parameter (identity cannot be optional without reopening H1;
  package unmerged). New load-bearing WP-120 obligation: supply a unique
  `connectionId` per attempt. Orchestrator fast-forwarded the canonical
  branch to `73b70bc` and reproduced gates: root 1943/1943, contract
  115/115, paths clean, lockfile untouched. Review round 2 dispatched.
- Review round 2 (fresh Codex `01a0464c-3130-7980-bef1-e020109d42ae`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker/high, 1 medium (lifecycle events
  are not correlated to an authorized PENDING attempt: `connecting()`
  records no expected id, so any well-formed UNKNOWN identity is accepted
  whenever no socket is live — four demonstrated holes: forged close on
  fresh IDLE directs reconnect attempt 1; forged close during the
  replacement's connecting interval exhausts maxAttempts; unknown ERROR
  accepted after caller shutdown; after 257 retirements an evicted
  historical id's OPEN is accepted, replaces the live socket, and advances
  the generation), 0 low, notes (mutation count 45 not 44; root suite
  sandbox-limited as before). M1/M2/L1/L2 confirmed FIXED (wrapper
  validation, bounded duplicate window incl. eviction disclosure, register
  text, UTF-8 bytes); the retired-identity connecting-interval case IS
  refused (the WP-090-style residue does not exist here); never-live
  acceptance rule REJECTED as designed; 256-FIFO risk characterization
  REJECTED (false for OPEN); ND1/ND2 ACCEPT; WP-120 unique-id obligation
  sound but insufficient alone — the adapter must register pending ids.
  Remediation round 2 dispatched.
- **Cross-adapter `takerSide` divergence flagged by the orchestrator**: the
  frozen `ReferenceTradeObservedPayloadSchema.takerSide` is
  `BookSideSchema.optional()` documented only as "Taker side when the venue
  reports it" — the BID/ASK meaning for a taker is not specified. WP-090
  computes it (maker-side inversion, reviewer-accepted); WP-080 omits it
  (BNC-U5: refuses to guess the vocabulary mapping). Both are contract-legal;
  the semantic ruling (which BookSide value names the taker's side) is a
  domain-contract documentation gap for the next ADR-modifying package or an
  orchestrator governance round, and the two adapters must converge once
  ruled (WP-080 follow_up; register R-3 family).

**WP-070 (Polymarket public adapter):** implementer session hit an API session
limit after reporting all gates green, before writing the handoff document;
resumed via SendMessage per the recorded resume pattern (context intact).
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-af750220276628c72`,
  base `145fc32`; chain `f4d374d` (impl) → `f16390c` (handoff SHA record).
  42 files, all allowed; lockfile +16/−0. Orchestrator reproduced gates:
  root 1869/1869, contract 177/177 (offline), check:deps PASS. No
  `@polymarket/client` or archived-client import (F6/F7) — native
  WebSocket/fetch behind injected ports. Headlines: **C-1/U-1 CONFIRMED by
  current official documentation 2026-08-27** (new page
  `docs.polymarket.com/api-reference/wss/market`: `price_change.size` = "New
  aggregate size (0 means level removed)"), correctly NOT self-ratified
  (protected paths untouched; ADR ratification queued for the orchestrator);
  R-2 discharged for owned schemas via an executable SDK anchor table (116
  assertions against pinned commit `7fdbed4…`, 5 recorded divergences);
  §9 narrowings discharged at the venue edge; tick-size one-for-one;
  no invented sequence number. Review round 1 dispatched.
- Review round 1 (fresh Codex `01a04623-3b3b-7e73-990e-6e45253a9c80`): **CHANGES
  REQUIRED** — 0 blocker, 2 high (H1 stale socket callbacks cross the
  generation boundary and are relabeled as current — the SAME defect class
  found independently in WP-080 r1 and WP-090 r1; H2 gap lifecycle not
  generation-bound: unsubscribe increments the generation without opening a
  gap, and `markResynchronized` requires no open gap or expected generation,
  so a stale snapshot acknowledgement for generation N closes generation
  N+1's gap and double-emits FeedResynchronized), 2 medium (M1 the R-2
  anchor table records the LOCAL loosened modifier for the five divergent
  REST fields rather than the SDK modifier — proving divergence instead of
  detecting it — two owned nested schemas unanchored, and REST requiredness
  of min_order_size/tick_size/neg_risk/hash loosened without REST evidence;
  M2 the §9 "any-length hex condition id" narrowing is capped at 200 chars
  by the frozen domain `ConditionIdSchema` — a contract-level contradiction
  the adapter cannot discharge; flagged for ADR-governed resolution), 1 low
  (one-outcome-per-frame-element accounting overstated for multi-entry
  price_change). C-1/U-1 evidence **PASS with caveat** (reviewer confirmed
  the page's delta semantics and internal consistency; could not extract the
  exact nested quote through its extractor); tick-size PASS (snapshot-emits-
  nothing reading accepted); F6/F7 PASS (zero venue dependencies); D1/D2/D4/
  D5/D6 ACCEPT, D3 REJECT (requiredness dimension). Remediation round 1
  dispatched.
- Remediation round 1 completed 2026-08-27 in `ef4713c` (+ doc `d71eb85`),
  fresh repair session, probes reproduced first, per-finding mutation checks
  (11 code + 5 anchor-table mutations all caught): H1 → immutable
  `FeedSocketSession` built before the factory call, all four callbacks
  capture it, `#isLive(session)` gates every path; stale frames recorded
  under the STALE session's identity with a new `STALE_CONNECTION_FRAME`
  problem (no false attribution, §8.3 satisfied); stale opens close the
  abandoned socket; H2 → unsubscribe retains the generation (rule: on a live
  connection the generation advances exactly when a gap opens — swept
  invariant test); `markResynchronized` takes the expected
  `subscriptionGeneration` and returns accepted/rejected with
  `NO_OPEN_GAP`/`GENERATION_MISMATCH`; M1 → REST requiredness restored for
  hash/min_order_size/tick_size/neg_risk on fresh first-party evidence (the
  venue's own OpenAPI requires all ten; SDK requires 8/10; only
  timestamp/last_trade_price stay absence-tolerant as reasoned presence
  divergences citing the SDK), anchor table records sdk/rest/local modifiers
  separately with per-dimension reasons, both unanchored schemas anchored,
  policed by an exported-schema enumeration test (116→509 assertions);
  M2 → any-length claim withdrawn in place, >200-char boundary asserted as a
  typed `INVALID_CONDITION_ID` problem (no throw/silent drop), discharged
  in substance not literally, ADR flag stands (contract-owner item 3);
  L1 → per-entry `entryIndex` added, claim restated as the venue's
  accounting unit; side comment corrected. New evidence for the venue
  report re-issue: the GET /book OpenAPI also contradicts the prose page on
  bid/ask ordering (follow_up). Orchestrator fast-forwarded the canonical
  branch to `d71eb85` and reproduced gates: root 1886/1886, contract
  578/578, paths clean, lockfile untouched. Review round 2 dispatched.
- Review round 2 (fresh Codex `01a04658-4c9f-78d1-ab1a-9af7d72c2ff4`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker, 2 high (R2-H1 synchronous
  `onOpen` publishes FeedConnected without sending the subscription — the
  session goes live before the factory call returns the socket, so
  `#sendFrames` sends nothing; the same sibling-adapter timing defect;
  R2-H2 an empty-set reconnect opens a gap WITHOUT advancing the generation
  — `remove()` retains the generation when no assets remain but the
  reconnect gap opens unconditionally, so an old same-generation
  acknowledgement closes the newer gap; the swept invariant test misses it
  because it reconnects with an asset remaining), 1 medium (the withdrawn
  any-length condition-id claim survives verbatim in
  `src/venue/primitives.ts:34`/`:70` — location missed by the repair),
  2 low (anchor coverage guard is name-convention-bound; the
  "source rejects the vector" test description overstates what is
  mechanically executed). Fix judgments: H1 otherwise complete (session
  binding incl. the connecting-interval refusal verified), H2 otherwise
  complete (remove/double-ack/stale-gen/N+1-race all pass), M1 FIXED, L1
  FIXED, comment FIXED. **ND3 judged NOT a finding**: SDK-over-OpenAPI
  presence authority is defensible — the reviewer re-fetched current
  official docs and found the higher-level OrderBook documentation
  independently declares `timestamp?`/`lastTradePrice?` nullable, a
  first-party source conflict at the same §1.1 tier; union acceptance with
  recorded divergence is the right call; the eight both-sources-required
  fields stay fail-closed. ND5 bid/ask-ordering contradiction verified
  recorded. Remediation round 2 dispatched.
- **Contract-owner items accumulated from batch 1B round 1** (for the next
  ADR-modifying package or an orchestrator governance round): (1) ratify
  C-1/U-1 across the four provisional-marked paths (WP-070 documentary
  confirmation 2026-08-27); (2) rule the `takerSide` BID/ASK vocabulary
  (WP-080 omission accepted pending ruling; WP-090 emits maker-inversion;
  adapters must converge); (3) reconcile the frozen `ConditionIdSchema`
  200-char cap with the §9 no-length-bound narrowing (WP-070 M2).

### WP-060 completion record (2026-08-27)

- Review round 3 (fresh Codex session `01a0447d-5890-7a72-8808-810b0e473f2d`,
  candidate `954e764` vs base `4126f29`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: reviewer sandbox lacked Docker for the integration gate; covered
  by the orchestrator's independent 81/81 reproduction at the exact commit).
  All round-2 fixes verified FIXED with direct probes (typed queue-full refusal
  before any Redis mutation with no capacity leak; durable-first resync
  acknowledgement with failure-path stickiness and recovery; publish sequence
  validation→XADD→SET→XTRIM with exact-contents compensation; metrics judged
  server-side; foreign-entry disclosure accurate; clock-guard reorder).
  ND3/ND4/ND5 and NR5-NR8 all ACCEPT; two mutation-check claims independently
  spot-verified; full regression sweep clean.
- Merged to `main` as `af29b08` under the release manager's standing delegation
  (2026-08-27). Post-merge on `main`: root 1727/1727, fault 89/89, integration
  208/208 (postgres) + 81/81 (event-bus), `check:deps` PASS, audit clean,
  frozen install verified. Root `test:integration` wired by the orchestrator in
  the completion commit to run both integration suites; CI step renamed
  accordingly (WP-040/WP-050 precedent for orchestrator-owned root wiring).
- As merged: transport-neutral interface (publish / subscribe / consumer
  checkpoint / bounded retention) carrying frozen-domain `EventEnvelope`s;
  Redis Streams v1 implementation (ioredis@6) with serialized per-epoch
  publication (bounded admission queue, typed halt-class refusal), atomic
  publication ordinals making retention loss exactly detectable
  (`missedEventCount`), server-judged instance-bound `ebc2` checkpoint tokens,
  sticky hard-resync blocking delivery and checkpointing until an
  authoritative-snapshot acknowledgement is durably recorded, §8.3 metric set
  plus `unreadableCheckpoints`/`retentionTrimFailures`, BigInt-exact per-epoch
  ordering, opaque payloads. Vocabulary test mechanically enforces that no
  Redis term appears in consumer-facing types (ADR-003 Consequences).
- Binding obligations recorded for consumers (WP-060 handoff follow_up):
  WP-120 must dedup on `(gatewayEpoch, ingestSeq)` (NOT `eventId`), keep one
  stable durable consumer id per role, publish each epoch from one process
  sequentially, route `resync-required` to the halt path with a
  `DataQualityIncidentOpened` + authoritative snapshot, treat
  `EVENT_BUS_PUBLISH_QUEUE_FULL`/`EventBusUnavailableError` as
  halt-plus-incident signals, and size `maxQueuedPublishes`/retention
  deliberately (retention sizing belongs in the operational runbook). WP-140
  exports queue depth/max/oldest-age pairs from process memory. The 5 ms p99
  gateway-to-trader target remains an unmeasured target (ADR-003 §5).

### WP-060 review history (2026-08-27, archived)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-ab4ebe3e28c3ce141`,
  base `4126f29`; chain `d7bbb0f` (implementation) → `794347a` (handoff record).
  41 files, all in allowed paths (lockfile ratified 2026-08-27, additive-only +71/−0).
  Orchestrator reproduced all gates in the candidate worktree: frozen install,
  typecheck, lint, `check:deps` PASS, root 1703/1703, event-bus integration 57/57
  (real Testcontainers Redis).
- Review round 1 (fresh Codex session `01a04418-b394-7542-b762-25ffad67452a`,
  candidate `794347a` vs base `4126f29`): **CHANGES REQUIRED** — 0 blocker,
  2 high (H1 concurrent publishes can reorder one gateway epoch: check-then-act
  cursor advances after append, probe delivered `["2","1"]`; H2 forged or
  cross-instance checkpoint tokens are syntax-validated only and silently skip
  retained events — future entry ID yields `idle` with no gap), 2 medium (M1
  publish Lua script INCRs the ordinal before XADD, so an append failure burns
  an ordinal → false hard resync and phantom `messagesDropped`; M2 handoff
  instructs WP-120 to dedup on `eventId` instead of the required
  `(gatewayEpoch, ingestSeq)`), 1 low (L1 handoff's "no default start position"
  claim false — a safe stored-checkpoint/oldest-retained default exists), notes
  (reviewer sandbox had no Docker — integration suite verified by orchestrator
  instead; fresh consumer ID with explicit `start: newest` can proceed past
  another consumer's pending resync — explicit, WP-120 must keep its durable
  consumer ID stable; testing helpers not exported from the main entry).
  Deviation judgments: D1 REJECT as stated (prose), D2/D3/D4/D5 ACCEPT.
  Assumption judgments: A5 REJECT (§8.1 does not establish sequential gateway
  publication), A1-A4/A6/A7 ACCEPT. Interface neutrality, path ownership,
  dependency direction, and safety criteria PASS as reviewed.
- Remediation round 1 completed 2026-08-27 in `3bc247c` (+ handoff `eee4b54`),
  fresh repair session, every probe reproduced on the unmodified candidate
  before fixing, per-finding mutation checks: H1 → `KeyedSerialQueue` makes
  check+append+cursor one serialized step per gatewayEpoch (concurrent
  reverse-order publish now refused before append); H2 → per-stream instance
  marker key + versioned `ebc2` tokens, `RESOLVE_POSITION`/`STORE_CHECKPOINT`
  Lua scripts judge marker/ordinal/clock/exact-entry server-side before
  delivery, unreadable stored positions refused and counted
  (`unreadableCheckpoints`); M1/P6 → `PUBLISH_SCRIPT` prevalidates key types +
  safe-integer ceiling before any mutation, pcall-guarded append with
  compensation (failed counter write removes the appended entry); M2 → handoff
  corrected to `(gatewayEpoch, ingestSeq)` dedup with positive duplicate test;
  L1/NOTE → prose corrected, WP-120 obligations now explicit (stable durable
  consumer id per role). Two new disclosed deviations: fourth per-stream key
  (instance marker), new `unreadableCheckpoints` metric field. Orchestrator
  fast-forwarded the canonical branch to `eee4b54` and reproduced all gates:
  root 1719/1719, integration 73/73, check:deps PASS, lockfile untouched this
  round. Review round 2 dispatched.
- Review round 2 (fresh Codex session `01a0444d-a524-70b3-bfe8-c5f3cd0525eb`,
  candidate `eee4b54` vs base `4126f29`): **CHANGES REQUIRED** — 0 blocker,
  2 high (R2-H1 the new publish serialization queue is unbounded and queue-wait
  time invisible — 10,000 operations admitted behind a stalled publish with
  only active-key count observable, and `producerBlockedTimeMs` starts after
  dequeue, contra §8.3; R2-H2 a failed durable hard-resync acknowledgement
  clears the sticky resync state before the checkpoint write — injected
  write failure left delivery unlocked with `pendingAfterFailure: null`),
  1 medium (R2-M1 publish compensation cannot restore an entry trimmed by
  `XADD MAXLEN` when the subsequent counter `SET` fails at full retention;
  NR4 characterization REJECTED as incomplete), 3 low (L1 `unreadableCheckpoints`
  undercounts — marker-only check, a same-marker future token reports as
  ordinary lag; L2 handoff omits the accepted foreign-entry step-over
  exception; L3 clock regression refuses genuine retained checkpoints —
  fail-closed availability issue). Round-1 fixes otherwise verified: H1 core
  reorder fixed (queue does not poison/deadlock, epochs independent), H2 core
  forgery closed (future/cross-prefix/ebc1/mismatched tokens refused), P6/M2/
  L1/NOTE fixed; ND1/ND2 ACCEPT (ND2 contingent on L1), new ADR-002 §2
  serialization-boundary assumption ACCEPT, NR1 ACCEPT in principle
  (foreign-entry disclosure required), NR2/NR3 ACCEPT, empty-stream residue
  ruled LOW/NOTE-acceptable. Reviewer sandbox again had no Docker; integration
  evidence remains the orchestrator's independent 73/73 reproduction.
- Remediation round 2 completed 2026-08-27 in `9c43b52` (+ handoff `954e764`),
  fresh repair session, probes reproduced first, per-finding mutation checks:
  R2-H1 → `KeyedSerialQueue` bounds admission (`maxQueuedPublishes`, default
  1024) with typed `EventBusPublishQueueFullError` (subclass of
  `EventBusUnavailableError`), exposes pending count/max/oldest-pending age,
  and `publish` now times submission→completion so queue wait is counted in
  `producerBlockedTimeMs`; R2-H2 → durable checkpoint store happens FIRST,
  every in-memory resync transition after it in statements that cannot fail
  (probed: positions-key occupied, marker rewritten, transport unreachable);
  R2-M1 → `XADD` no longer trims — entry, then counter `SET`, then `XTRIM`
  last; a post-commit trim failure is counted (`retentionTrimFailures`), not
  raised; R2-L1 → stored positions judged with the same server-side script
  `subscribe` uses; R2-L2/L3 → foreign-entry step-over documented; exact-entry
  lookup moved before the clock guard (future id naming no entry still
  refused). New disclosed deviations: per-stream (not per-epoch) admission
  bound; new `retentionTrimFailures` metric field; defaulted fourth
  `EventBusUnavailableError` constructor parameter. Orchestrator
  fast-forwarded the canonical branch to `954e764` and reproduced all gates:
  root 1727/1727, integration 81/81, check:deps PASS, lockfile untouched.
  Review round 3 dispatched.

### WP-040 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-aa6e4c6fd7701b054`,
  base `b1431e4`; chain `0a73ffe` (initial) → `7d8e94d` (handoff) → `49d065c`
  (orchestrator D1: testcontainers build-script denial in pnpm-workspace.yaml,
  disclosed) → r1 `f439e55`/`c287413` → r2 `65d9622`/`8be5e5c` → r3
  `964c6e4`/`43dbe04` → r4 `ca5d603`/`f8982bf`; merged `d23bb67` under the
  standing delegation.
- Reviews (fresh Codex per round): r1 4H/4M/2L, r2 4H/2M, r3 1H/1M, r4 1H/1M/1N
  — every bypass reproduced on the reviewed schema before fixing — r5 **ACCEPT**
  (zero findings above NOTE; binding-class sweep run twice and closed).
- As merged: 57 tables across six schemas + internal/migrations; §10.7
  constraints database-enforced and adversarially probed (immutable balance
  identity keyed to reservation facts; forward-only fencing leases with an
  un-lowerable per-realm token high-water; account_key sentinel binding fills to
  orders; ledger discriminators bound to order/fill/wallet-operation facts incl.
  conditional wallet-market equality via PMB12; SIGNED requires its attempt per
  §9.11; decimal-safe JSON incl. model_outputs; NULLS NOT DISTINCT venue
  identity; uuid_v7 variant check); Kysely typed repositories; advisory-locked
  checksum-verified migration runner (up+down verified).
- Obligations recorded for consumers: F13/F16-F20 (WP-200: carry the market on
  ledger postings; resolve wallet-operation market before insert; net positions
  from ledger_entries.account_ref; attempt row before SIGNED order — WP-320
  same); R9-R21 risk register accurate and owned.
- Post-merge on `main` at `d23bb67`: lockfile regenerated (two benign vitest
  peer-key rewrites from the WP-050/WP-040 merge union; frozen install verified);
  1441 root + 89 fault + 208 integration tests green; root `test:integration`
  and `db:migrate` wired to the package (WP-010 placeholders replaced) and the
  CI step renamed to the real suite; `db:migrate` proven end-to-end against the
  compose dev DB (all 8 migrations applied then status-verified; torn down).

### WP-015 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a2a6f707d957e8153`,
  base `ff0c01e`; chain `bb441dc` (initial) → `c668493` (handoff) → nine
  remediation commits (`c9b59b2` `7de62d0` `6658026` `a87f26c` `a187ccf`
  `900b299` `fdf9c02` `9a89040` `b2b3b9b`); merged `d77b2ba`.
- **Ten independent adversarial review rounds** — an unusually deep hardening
  arc for a CI lint, each round closing exactly one more class of module-load
  escape a purity-restricted package could use to reach a forbidden module,
  every bypass runtime-verified by the reviewer: regex scanner (r1) → hand lexer
  (r2 fail-open) → TypeScript compiler-API AST (r2 rebuild) → require-capability
  tracking (r3) → total unconsumed-reference rule (r4) → `getBuiltinModule`
  (r5) → `.constructor` evaluator acquisition (r6) → `process.mainModule`/
  `require.main` (r7) → `.constructor`+ambient audit (r8, superseded) →
  named/renamed `node:module` imports (r8 fix) → `new`-result escape (r9) →
  ACCEPT (r10) at the calibrated ordinary-code bar.
- **Deliverable & scope**: `tools/check-dependency-direction.mjs` implements
  `docs/contracts/dependency-direction.md` §6 — it PARSES the contract's §2 layer
  table and §2.1 same-layer allowlist at runtime (no mirrored copy), builds the
  workspace dependency graph, and enforces cycles (F9), upward-edge (F12) and
  unlisted-same-layer-edge (F13) prohibitions, plus per-package forbidden
  specifiers / impure globals / evaluator+loader capability escapes (F1-F8/F11)
  for the four purity-restricted packages. Wired into CI as `pnpm check:deps`
  and the root `check:deps` script; repo verdict PASS (34 packages / 2 edges,
  only the S0 `domain→decimal` edge).
- **Honest terminal position** (WP-015 handoff, re-affirmed at merge): a
  name-enumeration static scanner is provably non-total. After ten rounds no
  ORDINARY-CODE (non-reflective, single-file, statically-named, plausibly-
  accidental) silent synchronous forbidden-load route is known; the remaining
  residuals — reflective acquisition (`Reflect.get`), runtime-computed member
  names, and cross-file capability injection — are inherent to the architecture
  and documented, not one-more-spelling gaps.
- **Durable follow-up (WP-030 contract owner)**: follow_up 8 — replace the
  growing negative capability list with a POSITIVE rule ("a call in a restricted
  package whose callee does not statically resolve to a declared import or a
  known-pure local is a finding"), total by construction. It needs a numbered
  `docs/contracts/**` §3 rule (outside WP-015's paths) and carries a
  contract-level noise trade-off, so it is deliberately deferred to the contract
  owner rather than rammed in. The CI check is defense-in-depth; the real purity
  guarantee remains package structure + review + tests + runtime.
- Post-merge on `main` at `d77b2ba`: 1628 root + 89 fault + 208 integration
  tests green; `check:deps` PASS; lockfile unchanged.

### WP-050 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a8f55b87222d2953c`,
  base `b1431e4`; chain `32cb0a8` (initial) → `3c2228a` (handoff) → `a972e96` (r1)
  → `3f35a0c` (r2) → `b3a906f` (r3) → `22db770` (orchestrator LOW wording fixes,
  disclosed); merged `8a607ec` under the standing delegation.
- Reviews (fresh Codex per round): r1 CHANGES REQUIRED (frame loss on non-append
  faults; doctored-metadata validation; soft cap), r2 CHANGES REQUIRED
  (fsyncgate; queue stranding; sidecar double-count; burst cap), r3 CHANGES
  REQUIRED (earlier-fsynced accountability; factory width; ordinal false
  positive) — each round's fixes probe-reproduced first — r4 **ACCEPT**
  (mutation walk verified no release-without-manifest path; recovery table,
  checksum boundary, older-manifest compatibility, §13 worked example all
  verified; 2 LOW doc wordings fixed pre-merge).
- Core guarantees as merged: durability watermark (any fsync-or-write failure
  freezes durability claims permanently; manifests never overcount);
  accountability released ONLY by a written manifest (an unmanifested segment
  returns every accepted record to `pendingFrames()` — at-least-once);
  `maxTotalBytes` holds for default/stable factories with an enforced
  1024-byte factory-id bound; provenance-scoped manifest validation.
- **Binding obligations on consumers** (carry into WP-120/WP-130 packets):
  dedup on `(gatewayEpoch, ingestSeq)` is MANDATORY (duplicates are the normal
  fault-boundary outcome by design); the gateway drives `drain()`/`tick()` and
  routes refusals/faults to incidents; retention memory (one segment's records,
  64 MiB default bound) is reasoned-not-profiled — profile in WP-140 soak.
- Post-merge: 1387 root + 89 fault tests green; root `test:fault` script and a
  CI step wired by the orchestrator in the completion commit (recorded plan).

### WP-030 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus subagent; session interrupted once by an
  API limit and resumed) on branch `worktree-agent-a919f38ed969c8ffc`, base
  `f7ccb8e`; chain `051bb62` (ADRs + contract docs) → `1e30ff1` (handoff) →
  `66d29a9` (review round 1 remediation) → `21a3370` (round-2 residual fix,
  applied directly by the orchestrator with disclosure in the handoff); merged to
  `main` as `59cf254` under the release manager's standing delegation.
- Independent adversarial reviews (fresh Codex session per round): round 1
  CHANGES REQUIRED (2 medium: 5/26 citation-sample failures, dependency-layer
  inconsistency), round 2 CHANGES REQUIRED (1 medium residue; fresh 15-site
  citation sample over the unaudited surface passed in full), round 3 **ACCEPT**
  (0 findings above NOTE; residual-fix scope and orchestrator disclosure
  verified).
- Post-merge integration on `main` at `59cf254`: all gates pass (1102/1102,
  pytest, audit). The one inherited NOTE (broken `#contract-freeze` anchor in
  `docs/contracts/domain.md`, present since WP-020) fixed in this governance
  commit as promised in the WP-030 handoff.
- Deliverables: ADR-001..ADR-012 (all Status: Accepted, evidence-cited),
  `docs/adr/README.md` (ADR policy/template), `docs/contracts/
  dependency-direction.md` (single-layer-per-package model, enumerated
  same-layer edges S0–S2, mechanically implementable three-part CI check spec —
  NOT yet enforced, owner unassigned), `docs/contracts/protected-contracts.md`
  (protected-path policy + open venue-fact register), additive `domain.md` §10
  ADR cross-reference, handoff `docs/handoffs/WP-030.md`.
- Open items registered for later packages: dependency-check CI owner; venue-fact
  gaps (same-account matching, shared-bucket arbitration, Binance/Coinbase
  framing → WP-080/WP-090, U-6 50/50 mechanics → WP-110, U-7 SDK pin → WP-260,
  C-1/U-1 → WP-070, C-2 → ledger/fees, C-3 → WP-280).

### WP-000 completion record (2026-08-26)

- Implemented by `venue-verifier` (rounds 3+ on Opus subagents) on branch
  `worktree-agent-a373c7ba6650bf1a9`, base `7faf30f`; commit chain `8d16849` →
  `f79aa96` (r1) → `f8ecdbb` (r2) → `30e6f47` (handoff) → `5b98b5e` (r3) →
  `4505aaf` (r4) → `ac85ab6` (r4b) → `ddc56ff` (r5); merged to `main` as
  `d427f00` under the release manager's standing delegation (2026-08-26).
- Independent adversarial reviews (fresh Codex session per round): rounds 1–5
  CHANGES REQUIRED, round 6 **ACCEPT** (session `01a03d73-8ad1-7b23-929d-9f93703b67ef`;
  0 blocker/high/medium; residual LOW: `conditionId` 31/32-byte fixture narrowing —
  runtime parsers must NOT inherit it; NOTE: report §17 wording, self-corrected).
- Post-merge integration on `main` at `d427f00`: install/typecheck/lint/test
  (1102/1102), `uv` + pytest, and `pnpm audit` all pass.
- Deliverables: `docs/venue/verified-2026-08-24.md` (29 gated sections, 120
  official-source citations, 26 SDK links pinned to commit `7fdbed4…`), 17
  sanitized fixture JSON files across market-ws/user-ws/orders/heartbeat/fees/
  rate-limits/geoblock/positions/rtds, and the `verify-venue` CLI skeleton with
  305 offline tests (per-section citation gate, recursive schema validation,
  credential scanner with 57+ vectors). No credential, signer, order, or
  authenticated call anywhere.
- Open venue conflicts/unverified items carried to WP-030/later packages:
  C-1/U-1 (price_change zero-removal semantics → WP-070), C-2 (USDC vs pUSD
  denomination → ledger/fee packages), C-3 (MATCHED_NOT_BROADCASTED layering →
  WP-280), U-7 (npm version pin → WP-260), plus fixture-only narrowings that
  runtime adapters must not inherit (SDK `.nullish()` fields, conditionId length).

### WP-020 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus subagent) on isolated worktree branch
  `worktree-agent-a45b4929f044830ca`, base `4c1d96f`; commit chain `815b6cb`
  (initial) → `9790e0a` (review round 1 remediation) → `8d9596e` (review round 2
  remediation); merged to `main` as `25bc451` under the release manager's standing
  delegation for this run (2026-08-26).
- Independent adversarial reviews (fresh Codex session per round): round 1
  CHANGES REQUIRED (3 high, 4 medium, 2 low), round 2 CHANGES REQUIRED (3 medium,
  1 low), round 3 **ACCEPT** (Codex session `01a03d55-078f-7283-ba28-9bb01535e0d1`;
  0 blocker/high/medium; residual LOW doc shorthand fixed post-merge; NOTE —
  WP-030 ADR should reserve top-level payload key `venue` for provenance).
- Post-merge integration on `main` at `25bc451`: `pnpm install --frozen-lockfile`,
  `typecheck`, `lint`, `test` (797/797), `uv sync --frozen` + `pytest`, and
  `pnpm audit --audit-level high` all pass.
- Deliverables: `@polymarket-bot/decimal` (canonical §7.3 grammar, exact
  arithmetic, deterministic domain-tagged SHA-256 hashing with strict hash-input
  grammar, exact tick modulo) and `@polymarket-bot/domain` (event envelope with
  required `gatewayEpoch`/`ingestSeq` and provenance refinement, 22 versioned
  event contracts, DecisionResult with zero-or-more intents, five intent types,
  run modes with PAPER-safe maximum assertion, versioned schema registry), plus
  `docs/contracts/domain.md` and handoff `docs/handoffs/WP-020.md`.
- Items deferred to WP-030 ADRs: decimal library + canonicalization + hash
  preimage; strict-boundary/normalize split; version-per-field-set policy;
  inferred `QuoteLevel`/`BasketLeg`; `DISPUTED` non-terminal ruling;
  `TradingParametersChanged` vocabulary (`status` per §10.1, `open_time`/
  `close_time` per §9.2); reserve payload key `venue` for provenance.
- Domain contracts are now FROZEN: changes require an ADR (workplan
  `protected_paths` already covers `packages/domain/**`, `packages/decimal/**`).

### WP-010 completion record (2026-08-22)

- Implemented by `wp-implementer` on isolated worktree branch; implementation commit `1bca7cf90d6488107d5fed908a44c5eb18989bc1`; merged to `main` as `12ce0ab` after human approval.
- Independent adversarial review: **ACCEPT**, zero high/medium findings.
- Acceptance criteria (`pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`, no live credentials; plus `uv sync --frozen` + `pytest`) verified by implementer, reproduced independently by reviewer, and re-run on merged `main` — all pass.
- Path ownership ratification: root `eslint.config.mjs` is canonically recorded in `docs/spec/polymarket-bot-workplan.yaml` under WP-010 `allowed_paths` and global `protected_paths` (2026-08-23).
- External post-merge review (Codex, 2026-08-23): CHANGES REQUIRED with two medium findings — both remediated same day: (1) CI now runs dependency vulnerability scans over both lockfiles (`pnpm audit --audit-level high`; `uv export --frozen` + `pip-audit --strict`), both passing locally; (2) the complete auditable WP-010 handoff with all required fields is recorded at `docs/handoffs/WP-010.md`. Additionally, a compose health gate (`pnpm test:compose` + CI `compose` job) now supplements the exit-0 `test:integration` placeholder, and it passes locally.

## Wave 0 closeout (2026-08-26)

- Closeout audits (runbook §10, both fresh read-only contexts): Codex mechanical
  audit (session `01a03ee5-ddd6-7683-918b-02840e9c0ff6`) — initial verdict
  **WAVE INCOMPLETE** solely on (a) two gates unrunnable in its sandbox and
  (b) status-file bookkeeping, with merges/acceptance/safety/register all PASS;
  Claude architectural consistency pass — **INCONSISTENCIES FOUND** (1 high,
  7 medium, 4 low, no blocker; ADR-vs-code, git-facts, and safety checks all
  verified clean), plus a 10-item Wave 1 gap list.
- Orchestrator gate reruns on `main@c9e9a72` (2026-08-26): `pnpm audit
  --audit-level high` → no known vulnerabilities; `pnpm test:compose` → healthy
  (with the documented `PMB_POSTGRES_PORT=15432`/`PMB_REDIS_PORT=16379`
  overrides; native PostgreSQL occupies 5432 on this host), stack torn down.
- Bookkeeping corrected in this commit: WP-000 fixture count (17 JSON files);
  authorization vocabulary + accurate dependency-ready states in the package
  table; stale worktree entries archived below.
- Governance fixes in this commit: WP-070 acceptance criterion reworded to stop
  asserting C-1/U-1 as settled (workplan, audit M3); WP-100 sequenced after
  WP-070 with a scoped package.json ratification (M8, runbook corrected);
  test-tree registration ratification for unexecuted test roots (M7); WP-015
  (dependency-direction CI enforcement) added to the workplan with ratified
  paths — resolves the unassigned-owner item; runbook added to AGENTS.md
  reading list (N15); venue-report filename ratification comment added to the
  workplan (L10).
- **C-4 ownership assigned**: the quickstart/overview archived-SDK-reference
  re-check is owned by the orchestrator-run phase-start venue re-verification
  (handoff §1.2), to be executed and recorded before Wave 1 batch 1B (WP-070+)
  dispatch.
- Remaining architecture findings (H1 null-handling doc contradiction; M2
  UNVERIFIED marker on book.ts + domain-successor policy; M4 binding-narrowing
  list completion; M5 grammar-duplication register + dropped follow-up; M6
  dependency-direction false fact; L9 decimal error-code defect; L11
  ops:verify-venue wiring; L12 ops-cli undeclared devDeps; N13 unratified
  inferred shapes register) → fixed in the bounded **Wave 0 closeout
  remediation package**: candidate `42fbf2b` (impl `2d41c97`, base `b1431e4`),
  independent review **ACCEPT** (0 blocker/high/medium; 1 low: handoff
  evidence-scope wording on the errors test; book.ts comment-only proven by
  identical stripped-transpile hash), merged `b8e5eab`, post-merge gates green
  (1203/1203 tests; `pnpm ops:verify-venue` exit 0; audit + compose verified
  earlier this closeout).

**WAVE 0: COMPLETE (2026-08-26).** All four packages plus the closeout
remediation merged and post-merge verified; both closeout audits' actionable
items resolved or ownership-assigned; domain contracts frozen; run mode PAPER;
no signer or credentials. Wave 1 authorized per the package table.

## Wave 0 review history (archived; all branches merged and worktrees removed)

- `worktree-agent-a919f38ed969c8ffc` (WP-030): base `f7ccb8e`, candidate `1e30ff1`
  (impl `051bb62` + handoff). ADR-001..012, docs/adr/README.md,
  docs/contracts/{dependency-direction,protected-contracts}.md, additive
  domain.md §10 cross-reference, docs/handoffs/WP-030.md. Implementer session was
  interrupted once by an API session limit and resumed with context intact.
  Orchestrator verified: 17 files all in allowed paths, domain.md diff purely
  additive, gates reproduced (1102/1102). Review round 1 (Codex session
  `01a03eb9-6992-76a2-9f02-ca351bf7cbc8`, candidate `1e30ff1` vs `f7ccb8e`):
  **CHANGES REQUIRED** — 0 blocker/high, 2 medium (citation-accuracy sample 26
  checked / 5 failed: taker-rebate "pool-shared, midnight UTC" generalization in
  ADR-006+ADR-012; ADR-011 deterministic loser-cancel-fails and account-level
  self-trade assertions beyond report evidence; ADR-004 "every feed JSON"
  overreach vs Binance/Coinbase + PING/PONG; dependency-layer contract
  internally inconsistent: event-bus in layers 1 and 2, same-layer ban would
  forbid strategy-runtime→strategy-sdk, layer CI unimplementable as written),
  1 low (handoff file-count 16 vs actual 17), notes (normalize one ADR
  cross-reference). All four flagged inferences RATIFIED; README/domain.md §10
  deviations ACCEPTED; three-part CI concept sound pending layer-model fix;
  deferred backlog fully covered; safety defaults PASS. Remediation round 1
  completed 2026-08-26 in `66d29a9` (per-program reward facts; contention risk
  without invented determinism; same-account matching marked NOT DOCUMENTED;
  ADR-004 feed-framing claims split with Binance/Coinbase marked to-verify;
  dependency model made single-layer-per-package with an enumerated
  permitted-same-layer-edges table — including the already-shipping S0
  domain→decimal edge — and a mechanically implementable fail-closed check spec;
  counts fixed; two new venue-fact gaps registered). Orchestrator fast-forwarded
  and verified (1102/1102). Review round 2 (Codex session
  `01a03ed6-4411-79c1-be09-dc87a4fad7f8`): **CHANGES REQUIRED** — one MEDIUM
  residue (ADR-006/ADR-012 Evidence summaries still carried the all-programs
  midnight-UTC overclaim although the Decision sections were fixed), one LOW
  (7-vs-8 remediation file count), one NOTE (broken `#contract-freeze` anchor in
  domain.md inherited from base — orchestrator to fix on `main` post-merge);
  round-1 items otherwise RESOLVED and the fresh 15-site citation sample over
  the previously unaudited surface passed in full. Residual fix `21a3370`
  applied directly by the orchestrator (four-line wording + count + round-2
  history entry; disclosed in the handoff) — gates re-verified 1102/1102.
  Review round 3 (focused, candidate `21a3370`): **ACCEPT**. Merged to `main` as
  `59cf254` and post-merge verified (see WP-030 completion record); worktrees and
  branches cleaned up. Wave 0 closeout audit pending.

- `worktree-agent-a45b4929f044830ca` (WP-020): base `4c1d96f`, first candidate `815b6cb`
  (chain `e7844c9`→`815b6cb`). Implementer handoff `docs/handoffs/WP-020.md` (in worktree);
  gates reproduced by orchestrator — 642/642 tests, lockfile purely additive, all 43 files
  in allowed paths. Independent adversarial review round 1 (Codex session
  `01a03d1d-1510-77a0-b6c5-2d8fed838715`, 2026-08-26): **CHANGES REQUIRED** — 0 blocker,
  3 high (hash preimage uses lenient normalizer accepting `+1.5`/`1.`/`.5` contra §7.3;
  same-version optional-field policy incompatible with strict unknown-key schemas —
  must increment per emitted field-set change; `FeedGapDetected.requiresAuthoritativeSnapshot`
  and `FeedResynchronized.authoritativeSnapshotApplied` accept `false` contra the
  gap→snapshot invariant), 4 medium (reference payload `venue` vs envelope `source`
  provenance conflict; `MarketResolved` accepts pending outcomes; contract/registry
  skip runtime schemaVersion validation; `TradingParametersChanged` too narrow for
  fee/delay/negRisk changes), 2 low (overstated recursive-mutation test claim;
  "never collide" wording). Acceptance 1/2/4/5 verified; 3 failed as reviewed.
  Remediation round 1 completed 2026-08-26 in `9790e0a` (separate hash-input grammar
  rejecting §7.3-forbidden forms with unchanged golden digests; version-per-field-set
  policy with evolution tests; gap/resync flags now literal `true`; provenance module
  + samples fix; terminal-outcome subset for MarketResolved with DISPUTED ruled
  non-terminal; runtime schemaVersion validation at both entry points;
  `parameterVersionRef` + `changedParameters` for TradingParametersChanged; recursive
  mutation walker; collision wording fixed; 757/757 tests; lockfile untouched).
  Repair agent was git-isolated from the original worktree (same as WP-000 r3);
  committed on its own branch and the orchestrator fast-forwarded
  `worktree-agent-a45b4929f044830ca` to `9790e0a`; gates reproduced by orchestrator.
  Review round 2 (Codex session `01a03d3b-c5ee-75a3-82ca-92fee192b2b7`, candidate
  `9790e0a` vs `4c1d96f`): **CHANGES REQUIRED** — 0 blocker, 0 high, 3 medium
  (registry `parseEnvelope` never invokes provenance check, so contradictory
  reference envelopes still parse; `assertSchemaVersion` uses `Number.isInteger`,
  admitting unsafe integers that envelope routing rejects; `TradingParameterKindSchema`
  omits open/close-time categories and carries `status` without citation), 1 low
  (handoff evidence overstatements: 12-vs-20 file count, incomplete resync-flag
  negative matrix, imprecise removed-tests claim). All five acceptance criteria
  PASS; round-1 items HIGH-1/2/3, MEDIUM-2, LOW-1/2 resolved; design rulings
  (golden digests, DISPUTED non-terminal, unbranded SchemaVersion,
  `parameterVersionRef`, staying at v1) all judged sound. Review also flagged a
  stale duplicate WP-020 table row in this file — fixed by orchestrator.
  Remediation round 2 completed 2026-08-26 in `8d9596e` (provenance enforced in the
  envelope schema itself via superRefine plus a parseEnvelope structural-bypass
  assert, 12 mismatch combinations tested through the registry;
  `Number.isSafeInteger` with `SchemaVersionSchema` as the single shared range;
  `open_time`/`close_time` added and `status` cited to §10.1 with a per-category
  citation table in domain.md §6.4; handoff precision fixes; 797/797 tests; no
  decimal-package, golden-digest, or lockfile change). Orchestrator fast-forwarded
  the branch to `8d9596e` and reproduced gates. Review round 3 (candidate `8d9596e`
  vs `4c1d96f`): **ACCEPT**. Merged to `main` as `25bc451` and post-merge verified
  (see WP-020 completion record); worktrees and branches cleaned up.

- `worktree-agent-a373c7ba6650bf1a9` (WP-000): base `7faf30f`, first candidate `8d16849`,
  second candidate `f79aa96`. Independent adversarial review round 1 (2026-08-24):
  **CHANGES REQUIRED** (fixture fidelity, rate-limit tiers, position schemas, vacuous
  verification PASS) — remediated in `f79aa96`. Review round 2 (2026-08-24):
  **CHANGES REQUIRED** (raw user-trade schema fidelity vs official SDK, recursive
  nested validation, report-evidence enforcement, canonical-decimal rules, credential
  header names, clob-client-v2 doc conflict, in-repo handoff). Remediation round 2
  completed in `f8ecdbb`; structured handoff record committed as `30e6f47` (branch
  HEAD, third candidate). `docs/handoffs/WP-000.md` ratified into WP-000 allowed
  paths (M4). Orchestrator re-verification (2026-08-26): all 24 changed files vs
  base `7faf30f` inside allowed paths; install/typecheck/lint/test reproduced in
  the worktree at `30e6f47` — 124/124 tests pass; handoff record complete.
  Independent adversarial review round 3 (fresh Codex session `01a03d03-0087-7132-bfaa-644e090779d1`,
  candidate `30e6f47` vs base `7faf30f`, 2026-08-26): **CHANGES REQUIRED** — 0 blocker,
  3 high (per-section report-evidence gate still bypassable by `UNVERIFIED`; several
  contract-bearing nested structures unchecked: fee tables, rate-limit headers/limits,
  position contracts, RTDS subscriptions/optional update fields; stand-in validators
  diverge from frozen SDK schema: empty-string optional decimals, non-integer
  `outcome_index`/`bucket_index`, non-digit epochs, omitted SDK fields), 1 medium
  (price-bound check via `Number()` accepts negative price on float underflow),
  2 low (mutable `blob/main` source URLs untied to pinned SHA; credential scanner
  misses `POLYMARKET_PRIVATE_KEY`/`POLYMARKET_BUILDER_API_KEY`). Round-2 findings
  M2/M3/M4 confirmed resolved; B1/H1/H2/M1 partial or unresolved. Path ownership,
  safety defaults, fixture coverage, and no-credential criteria PASS. Remediation
  round 3 completed 2026-08-26 in `5b98b5e` (per-section citation gate with
  enumerated exemptions; fully typed nested schemas with catalog guards; strict
  SDK-fidelity validators verified verbatim against the pinned commit, adding
  clob/account.ts and clob/order-response.ts sources; lexical price bounds;
  pinned permalinks enforced by validator; credential scanner 57 vectors with
  substring patterns; handoff claims corrected; 235/235 tests, mutation check
  performed). Repair agent was git-isolated from the original worktree, so the
  commit landed on `wp-000-remediation-round3` and the orchestrator fast-forwarded
  `worktree-agent-a373c7ba6650bf1a9` onto it; gates reproduced by orchestrator.
  Venue-fact conflict recorded: review's `POLYMARKET_BUILDER_API_KEY` not found on
  2026-08-26 official pages; verified names are `POLY_BUILDER_API_KEY` and
  `POLYMARKET_BUILDER_CODE` — later corrected in round 4: the migration page DOES
  document `POLYMARKET_BUILDER_API_KEY`/`_SECRET`/`_PASSPHRASE`; `/builders/api-keys`
  currently serves the Place Orders page; `POLY_BUILDER_*` headers live on the relayer
  submit-a-transaction reference. Review round 4 (Codex session
  `01a03d29-c533-7fc3-a180-d6995aa359c8`, candidate `5b98b5e` vs `7faf30f`):
  **CHANGES REQUIRED** — 0 blocker, 1 high (HIGH-2 continuation: `validateObjectSpec`
  skips null/undefined map entries; RTDS `filters` wrongly mandatory vs official TWAP
  docs; `TransactionOutcome.transactionId` and `clobRewards[].endDate` wrongly
  non-nullable vs official docs), 1 medium (round-3 credential reconciliation itself
  wrong: `POLYMARKET_BUILDER_API_KEY` IS on the official migration page; source
  attributions to /builders/api-keys incorrect), 1 low (catalog guard not recursive).
  Round-3 items HIGH-1/HIGH-3/MEDIUM-1/LOW-1/LOW-2 confirmed resolved. Deviation
  judgments: canonicalized fee strings acceptable as normalized data (raw-wire caveat
  required); added SDK sources beneficial; synthetic-completed fixtures must stay
  labeled; mutation-check claim not comprehensive. Remediation round 4 completed
  2026-08-26 in `4505aaf` (whole-map validation with declared nullability; RTDS
  `filters` optional with the wrong negative test replaced; nullable `transactionId`
  and rewards `endDate` per re-fetched official docs; credential citations corrected
  per-name — all four venue facts re-verified independently agreed with the review;
  new scanner gap `POLYMARKET_BUILDER_SECRET` found and fixed; recursive catalog
  guard; 257/257 tests; per-finding mutation checks). Orchestrator fast-forwarded
  the branch and reproduced gates. Repair session disclosed one NEW out-of-scope
  divergence: `clobRewards[].rewardsAmount`/`rewardsDailyRate` modeled as JSON
  number vs official DecimalString — fixed in follow-up `ac85ab6` (round 4b):
  SDK-parsed-layer modeling per the pinned SDK's DecimalishSchema, with the
  market-details page's three-tab type disagreement recorded verbatim in report
  §7.1; deliberate scope extension (`rewardsMinSize` → decimal-string) and
  deliberate relaxation (`assetAddress` narrowing removed per page + SDK) flagged
  for review; `conditionId` narrowing kept and marked. 279/279 tests; orchestrator
  fast-forwarded and reproduced gates. Review round 5 (Codex session
  `01a03d55-0eb7-7780-9ccf-96959244dd25`, candidate `ac85ab6` vs `7faf30f`):
  **CHANGES REQUIRED** — 0 blocker, 1 high (`validateObjectSpec` treats `optional`
  as implying nullable, so `filters: null`, `transactionsHashes: null`,
  `tradeIDs: null`, book `hash: null` all pass undocumented), 2 medium (strict
  reward schema omits official `holdingRewardsEnabled?: boolean|null`; report
  §7.1/§16 outside the per-section citation gate), 1 low (conditionId narrowing —
  accepted as residual for the frozen snapshot). All round-4 items otherwise
  RESOLVED; all round-4b judgment calls ACCEPTED (filters test replacement,
  SDK-parsed reward layer, rewardsMinSize extension, assetAddress relaxation,
  key-required snapshot strictness). Remediation round 5 completed 2026-08-26 in
  `ddc56ff` (null accepted only under explicit `nullable: true` — exactly four
  cited nullable fields enforced by a recursive walker guard; `tradeIDs`/
  `transactionsHashes` null-acceptance reclassified as defects vs the SDK's
  `.default([])`; book-`hash` null rejection recorded as fixture-only narrowing in
  new report §17; `holdingRewardsEnabled` modeled per official type with full
  MarketRewards key-by-key re-audit; citation gate completed across ALL report
  sections with §10/§15 as enumerated exemptions and the test's private section
  list deleted; 307/307 tests; per-finding mutation checks). Orchestrator
  fast-forwarded and reproduced gates. Review round 6 (candidate `ddc56ff` vs
  `7faf30f`): **ACCEPT**. Merged to `main` as `d427f00` and post-merge verified
  (see WP-000 completion record); worktrees and branches cleaned up.

### WP-000 in-flight record (2026-08-24)

- Path compliance, protected paths, safety defaults: verified clean by orchestrator and reviewer.
- Automated gates (install/typecheck/lint/test) pass on candidate `8d16849`, but the
  review found the fixture content itself does not faithfully match official venue
  contracts; acceptance is therefore not met and the package remains open.

## Accepted evidence

- WP-010 automated gate: install/typecheck/lint/test pass on `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.

## Open blockers

None.

## Deviations from specification

- Root `eslint.config.mjs` was outside WP-010's literal `allowed_paths`; ratified into WP-010 ownership (see completion record).
- Node 24 pin is `engines: ">=24"` + CI `node-version: 24` + runtime smoke assertion, not an exact `.nvmrc` pin; acceptable for WP-010, tighten later if needed.
- WP-000 verification report filename: workplan literally names `docs/venue/verified-2026-08-18.md` (plan-generation date), but handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification. **Ratified by orchestrator 2026-08-24**: the report is `docs/venue/verified-2026-08-24.md`; the workplan literal is treated as a template dated at plan generation. Flagged by independent review (M2) as requiring explicit ratification — recorded here.

## Pending external evidence

- `.github/workflows/ci.yml`: YAML-validated only — a real GitHub Actions run is pending.

## Resolved evidence items

- `docker-compose.yml` runtime validation (2026-08-22): Docker 29.1.2 / Compose v2.40.3 became available; `docker compose config` valid, `docker compose up -d --wait` brought both services to healthy (`pg_isready` accepting connections, `redis-cli ping` → PONG), both ports confirmed bound to 127.0.0.1 only. Host ports made overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`, defaults 5432/6379 unchanged) because this machine has a native PostgreSQL on 5432; validated with `PMB_POSTGRES_PORT=15432`. Stack torn down after verification.

## Human and operational gates

- Execution-probe gate: Not requested
- Live-micro gate: Not requested
- Live gate: Not requested
- Time-based soak evidence: None
