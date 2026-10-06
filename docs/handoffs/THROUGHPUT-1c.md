# THROUGHPUT-1c: book freshness by feed liveness, not by the last change (ADR-023)

**Status:** Complete (2026-10-02). Merged `0c270df` (PR #38; CI run `37095740897` green). **ADR-023 was ratified by the user as is on 2026-10-02.**
**Reviewers:**
- rounds 1–5: Opus and gpt-6-astra, reconciled;
- rounds 6–9: dual and reconciled, after continuations.

**Joint ACCEPT at round 9 on `d997d39`.**
**Base:** `8de4828`, then `64bbd92` after main was merged into the branch at round 5. **Posture:** PAPER only.

The implementer handoffs `handoff-r0.md` … `handoff-r8.md`, the joint reports and the bench evidence are kept outside the repository, in `~/pmb-rounds/throughput-1c/`. This record summarises them.

## summary

**The finding.** In H1 run 1, 54% of decisions paused on `SB.STALE_BOOK` (about 9% in runs 3–8). Book age is `now − (the book's last change)`, so a quiet but live book reads stale after 2 s.

**The rule (ADR-023, opt-in).** `bookFreshness: { basis: "CONNECTION_CONFIRMED", maximumLastChangeAgeMs }` vouches for a book by the latest confirmation of its delivery session, its connection and subscription generation.
- An absent block means `LAST_CHANGE`, the old rule; that path computes byte-identical values.
- A per-book ceiling bounds the extension: 30 s in the example config.

**The safeguards built over nine rounds.** Every gap falls back to `LAST_CHANGE`, the fail-closed direction.
- **Losses first.** The adapter reports a frame's problems before its events. The gateway validates every envelope of a market-channel frame before it publishes any (R6). It never starts a frame in a transport call that cannot hold it whole, and it publishes `GATEWAY_FRAME_SPLIT` ahead of an oversized frame (R7).
- **The consumer rule (R8, the class fix).** A `FrameCompletionGate` in `packages/trading-core` uses a frame's confirmations only after the trader has processed a later event of the same gateway epoch. A frame cut anywhere upstream never vouches for a book. The handoff enumerates 17 boundaries on a frame's path, each with a named pin. A seeded property test covers 9 boundary families (90 cases), and fails on the round-7 tip.
- **The epoch taint.** Any market-less incident turns the extension off for that gateway's lifetime.
- **The process-lag guard (D7, option (a)).** A trader lagging the stream has its extension narrowed by the lag, and gets exactly `LAST_CHANGE` once the lag exceeds the confirmation's lead.

**The rulings.** The orchestrator recorded three interim rulings on 2026-10-01. The user's ratification of ADR-023 on 2026-10-02 confirmed all three:
1. D7 option (a), the process-lag guard.
2. The guard's use of the `Clock` port is not a change to clock semantics (`CO2-N1` is unchanged; ADR-031 covers it).
3. The epoch taint stays coarse and fail-closed.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `f341d5f` | CHANGES REQUIRED | X1 HIGH (no per-book ceiling), X8 HIGH (problems after events), X9 HIGH (a lagging trader is admitted more under the rule), X2 and X3 MEDIUM |
| 2 | `a0a5f24` | CHANGES REQUIRED | X9 HIGH |
| 3 | `9de687b` | CHANGES REQUIRED | X9 HIGH (closed by the guard; a ruling was owed) |
| 4 | `26d1e91` | CHANGES REQUIRED | X9-GOV: the rulings were not recorded |
| 5 | `26d1e91` | CHANGES REQUIRED | X9-GOV (recorded in governance `64bbd92`) |
| 6 | `74e17ca` | CHANGES REQUIRED | R6-H1: a refused envelope mid-frame |
| 7 | `2d29b2d` | CHANGES REQUIRED | R7-H1 (the publisher splits a run), and SCOPE MEDIUM |
| 8 | `298199d` | CHANGES REQUIRED | R8-H1: the trader reads a frame in two polls |
| 9 | `d997d39` | **ACCEPT** | none; INFO items only |

Rounds 6–8 found the same class of defect at three new boundaries. Round 8 was told to fix the class at the consumer, and did.

## tests_run

**Gates on `d997d39`:**
- typecheck, lint and check:deps exit 0;
- unit: 384 files / 8328 tests;
- e2e: 9/212;
- replay: 3/17;
- trader integration: 31/241;
- data-gateway integration: 14/104;
- event-bus integration: 10/112.

**The orchestrator's bench re-measure** (2026-10-01, `~/pmb-rounds/throughput-1c/bench-orch/`): 8 alternating runs on the rebuilt H1 burst, `dac9f77` against `d5dda21`.
- **+1.7% wall time and +1.6% CPU** by median.
- Identical normalized decisions (`cf304b57…`) and 0 stale pauses on both sides.
- One candidate run hit a load spike.

**CI:**
- PR #38's merge ref was green at `d5dda21` (run `36874368278`).
- It was green again after main was merged in at `b677fd8`, together with ADR-023's Accepted status and index row: run `37095740897`.

## assumptions
- The venue documents no cross-asset ordering on the market channel (N-B). The ceiling bounds the exposure that leaves.

## deviations
- None beyond the ruled design.

## known_risks
- **The coarse taint makes the rule nearly inert in an H1-like deployment.** The Binance adapter's subscription-start incident taints the epoch. A trader that reads from the epoch's start falls back to `LAST_CHANGE`. A trader that joins mid-stream may miss the incident; the ceiling bounds that gap (X2).
- **N-B.** A book whose changes the venue stops while other books flow reads fresh for up to the ceiling minus the bound (28 s with the example values).
- **The real effect is unproven on live data.** On the recording, both rules pause 0 times; the 21.9% → 0 figure comes from a derived stream. A live run must measure it.
- **`ADR023-CLOCK-STEP`.** A backward step of the gateway's wall clock can extend a confirmation, when both clocks step together.
- **Other disclosed residuals:**
  - the negative-lag clamp;
  - no end-to-end backtest pin under `CONNECTION_CONFIRMED`;
  - no live/replay byte parity under process lag;
  - an oversized frame turns the extension off.
- **`FLAKE-CANONICAL-ORDER`.** Load-sensitive unit timeouts were seen during review.

## follow_up
1. **Narrowing the taint.** It is the user's choice. Revisit it once a live run or the burn-in shows whether stale pauses cost trades.
2. **`CO2-N1`.** ADR-031, option (a), is the implementation round, after `PROVENANCE-1`.
3. **Gateway rounds:**
   - an epoch-start signal (X2);
   - incidents attributed to a session or a market;
   - a monotonic receipt basis (`ADR023-CLOCK-STEP`).
4. **Contract text:**
   - `docs/contracts/features-v1.md` §2 should note the vouched-for `lastEventAt`;
   - a venue-register row for N-B;
   - bind `bookFreshness` to the configuration identity (X6).

## commit_sha
`d997d392496d7a25ab6531741b9423f579f508ae`. It was merged together with ADR-023's Accepted status (`a126ed1`) and main (`b086786`).

## Moved from the brief (2026-10-06, `RECORDS-W3`)

The brief carried this package's rulings and its authorization detail under "Authorized now" until `47549ac`. They moved here verbatim, to bring the brief within its budget. The brief keeps one line on the rulings and the user's open choice on the taint, under Human items.

```markdown
- `THROUGHPUT-1c` is Complete (2026-10-02, `0c270df`); ADR-023 is Accepted, ratified by the user as is. See [Work packages](#work-packages). Its rulings and evidence are below, kept for reference.
  - **Rulings: made by the orchestrator on 2026-10-01, each the most conservative option, and confirmed by the user's ratification of ADR-023 on 2026-10-02:**
    - **ADR-023 D7: option (a)**, the process-lag guard, as implemented. Not (b), narrowing criterion B, and not (c), deferring the opt-in.
    - **The Clock-port reading:** the guard's use of the `Clock` port is NOT a clock-semantics change. Every age stays in event time; the process clock can only remove the extension ADR-023 adds, never make a book fresher (ADR-023 D7). `CO2-N1` is unchanged.
    - **The epoch taint (O-I1(ii)): kept coarse and fail-closed.** Any market-less incident taints the gateway epoch, with no source filter. Narrowing it, for example ignoring reference-venue incidents, would LOOSEN a fail-closed rule, so it is left to the user. Consequence: with a Binance feed the rule changes nothing until narrowed (ADR-023 §5).
  - **Test-path ownership (2026-10-01):** `THROUGHPUT-1c`'s test grant is narrowed to the paths it has touched: `test/integration/paper-trader/**` and `test/unit/strategies/**` (plus tests inside its packages). This lifts `STORAGE-1`'s dependency on it, per the work plan's own clause; their test paths are disjoint.
  - The finding: in H1 run 1, 20,367 of 37,546 decisions (54%) paused on `SB.STALE_BOOK`. Book age is `now − book.asOf`, the last change, so a quiet but live book reads stale after 2 s. The risk policy's `venueBookMaxAgeMs` has the same shape.
  - Scope (1): ADR-023, Proposed: a liveness-based freshness rule grounded ONLY in the venue's documented market-channel behaviour (`docs/venue/verified-*.md` and current official docs; never invented). The user ratifies it before merge.
  - Scope (2): end to end: a gateway liveness signal if one is needed, then features, strategy and risk freshness, with the strategy's parameter and version discipline.
  - Evidence (3): a quiet but live book is fresh; a silent or disconnected feed is stale within its bound; every golden change is listed and explained.
  - HARDENING LOOP; verifier: a Fable adversarial-reviewer. Gate: automated checks, the Fable adversarial review, the user's ADR-023 ratification, and a green CI run on GitHub.
```
