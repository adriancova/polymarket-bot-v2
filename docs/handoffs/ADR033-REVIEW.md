# ADR033-REVIEW: ADR-033 checked, corrected and accepted (the order heartbeat, C-12)

**Status:** Complete (2026-10-03). Merged `47575cf` (PR #57; CI run `37169761544` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 4 on `4abe22c`.
**Base:** `85b81e5`, where the orchestrator committed the draft as Proposed.
**Paths:** `docs/adr/ADR-033-order-heartbeat-behind-a-port.md` and its README row. Docs only.

## summary

- **The draft.** The orchestrator drafted ADR-033 to settle C-12 / E-17 for PAPER: the SDK has no order-heartbeat method, but §9.12 says both "wrap only the SDK" and "heartbeat orders".
- **The reviser** checked every citation and fixed four soundness gaps. Two verifiers then reviewed it over four rounds.
- **The accepted ADR:**
  - `WP-320` builds the heartbeat controller behind an `OrderHeartbeatTransport` port, and writes no transport. ADR-008 §2–§4 apply unchanged. It uses the `ORDER_HEARTBEAT` rate class and the signer gate's live-mode refusal.
  - Kill-switch state reaches the gate through the health lease. A MARKET- or STRATEGY_INSTANCE-scope switch never stops the heartbeat.
  - **D6:**
    - The controller starts lapsed.
    - From 10 s after the last confirmed heartbeat was sent, every open order is treated as possibly canceled, and reconciliation goes through `OrderManager.requestOrderReconciliation` and the coordinator.
    - New entries stay blocked until a reconciliation run that started after a fresh confirmation passes.
  - **D5, the transport, is open for the user.** Its options:
    1. an L2-signed request from the SDK's primitives;
    2. wait for SDK support;
    3. the `@internal` client;
    4. go live without heartbeats.
- **Governance.** The orchestrator set the status to Accepted for D1–D4 and D6 after the merge.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 0 | `2deaa09` | (reviser) | C1–C20. Among them: a wrong claim that PAPER forbids network access; the wrong §9.17 trigger; 15 s instead of 10 s; ADR-008 not cited; kill-switch scope |
| 1 | `2deaa09` | CHANGES REQUIRED | I-01 HIGH: the lapse end could not be met through the OMS API. I-02 HIGH: a delayed success ended a lapse. I-03 MEDIUM: an unrecorded venue-docs conflict on the heartbeat path |
| 2 | `7905680` | CHANGES REQUIRED | R2-ACC HIGH: an overstated reconciliation claim. F2-M1 HIGH: the lapse end ignored the venue's 5 s sweep |
| 3 | `5bd09d0` | CHANGES REQUIRED | R3-TRIG HIGH: when a run takes its triggers |
| 4 | `4abe22c` | **ACCEPT** | none; three LOWs |

## tests_run
- `lint`, `check:deps` and `test` (480 / 10753) exit 0 on the candidate. Only the two allowed paths changed.
- **CI:** GitHub CI on the PR #57 merge ref was green.

## assumptions
- The venue's 10 s timer restarts on each valid heartbeat it receives. That is the natural reading of the documentation, and is documentary only.

## deviations
- **The orchestrator's draft was materially wrong in places.** Every correction is recorded in the ADR's Revision bullet.

## known_risks
- **Context 3, open.** The guide says `POST /v1/heartbeats`; the API reference says `POST /heartbeats`. It goes to the next venue round.
- **The r4 LOWs:**
  - R4-W1: "started" is used for two different times;
  - R4-L1: spacing after a NOT_RUN;
  - R4-L2: what D2's amendment clause names.
- **`requestOrderReconciliation`** records `MANUAL_REQUEST` as the reason, so a lapse appears in order history as a manual request.

## follow_up
1. **`WP-320`'s packet** carries:
   - D6: the entry block, starting lapsed, and the lapse end;
   - the kill-switch scope rule;
   - the r4 LOWs;
   - `WP-310` follow_up 3, on sharing the IP rate budget with the data gateway.
2. **When `WP-290` merges,** re-cite D6's coordinator on `main`.
3. **The next venue round:** re-check whether the SDK has gained a heartbeat method, and whether it exports its L2 signing primitives publicly; also Context 3. Then the user rules D5.

## commit_sha
`4abe22c`
