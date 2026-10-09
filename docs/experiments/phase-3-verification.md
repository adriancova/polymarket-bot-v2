# Phase 3 verification report: live-micro fault injection (WP-340)

**Work package:** `WP-340`, live-micro fault-injection verification (Wave 3, PAPER only).
**Date:** 2026-10-05.
**Subject:** the merged Wave 3 packages on `main` at `f4d73ba`: `WP-260` to `WP-330`.
**Verifier:** the `WP-340` implementing agent. This report is not a review: two independent verifiers review it.
**Revision:** r1, 2026-10-05. It remediates the joint round-1 review (J1 to J8, §11).
**Posture:** PAPER only. No credential, key, signer, wallet or real order exists anywhere in this work. The only connections made are scenario 6's: to the local Docker daemon, and to the throwaway PostgreSQL container it starts.

> **This report authorizes nothing live.** Completing `WP-340` does not raise `MAX_RUN_MODE`, enable real orders, or set a live-micro cap. Every live-shaped context below is a literal that reaches only fakes, a mock venue or a throwaway database. Live trading still needs ADR-033 D5's ruling, a live composition root, credentials, and the human gates of phase 4.

---

## 0. Summary

The four work-plan criteria, each proven by named tests that fail when their guard is removed (§6):

| Criterion | Holds? | Proven by |
| --- | --- | --- |
| 1. Mid-order crashes recover without duplicate exposure | **Yes** | `mid-order-crash.test.ts` (every kill point, beneath WP-260's client too), `mid-order-crash.property.test.ts` (seeded) |
| 2. Lost user-stream events reconcile | **Yes**, with finding WP340-F1 (a fail-closed halt that needs an operator) | `lost-stream-events.test.ts`, `lost-stream-events.property.test.ts`, `findings.test.ts` |
| 3. Heartbeat failure cancels mock open orders | **Yes** | `heartbeat-failure.test.ts` |
| 4. Live maximum defaults remain zero | **Yes** | `live-defaults.test.ts` |

Packet scenarios 4 (the independent cancel path) and 6 (two writers on real PostgreSQL) hold too: `independent-cancel.test.ts` and `postgres/two-writers.test.ts`. Scenario 4 also holds against the trader's D-21 cancel debt on the signer both keys share (§4.5). Every file named here lives under `test/fault-injection/live/`.

The suites stand in for an operator's review of WP340-F1 with a recovery driver. It releases a quarantine only when the quarantine is bound to F1's conflict and the `LIVE` behind it was stale (§5, `release-driver.test.ts`). Every other halt fails a run, and every population of its releases is pinned exactly.

**One finding needs product code, and is STOPPED:** WP340-F1 (§5). A `LIVE` order event that reaches the OMS after the OMS already holds the order in a terminal state halts the order's market. The account then stays paused until an operator releases the quarantine. Safety holds. A fault-free sequence triggers it in the mock: a place-then-cancel answered before the order's `PLACEMENT` push. That ordering is the mock's push timing (assumption A8), and how often the real venue produces it is unmeasured. It is pinned as expected failures, never skipped. The user ruled its fix on 2026-10-05 (§5).

---

## 1. How to run it

| Suite | Command | Needs |
| --- | --- | --- |
| Live fault injection | `pnpm exec vitest run --config test/fault-injection/live/vitest.config.ts` | nothing |
| Its typecheck | `pnpm exec tsc --noEmit -p test/fault-injection/live/tsconfig.json` | nothing |
| Two writers, real PostgreSQL | `pnpm exec vitest run --config test/fault-injection/live/postgres/vitest.config.ts` | Docker |

No root script runs these yet. The root `package.json` is protected, so wiring them into `test:fault`, the root `typecheck` and CI is the orchestrator's (§10).

**Why nothing is under `test/e2e/live-mock/`.** The work plan also grants that path, but `test/e2e/safety-posture.test.ts` (WP-250) owns all of `test/e2e/**`. It refuses any import but a short permitted list and relative paths, and any line that assigns a live run mode. A live-shaped mock test must compose WP-260's mock signer and live-shaped contexts. Meeting that scan's letter would mean reaching the secure adapter through relative paths, which defeats its purpose. The two end-to-end files (`independent-cancel.test.ts`, `live-defaults.test.ts`) therefore live here; the first gate run with them under `test/e2e/live-mock/` failed that scan, 2 of 235. Whether the e2e posture scan should exempt a live-mock subtree is the orchestrator's to rule.

---

## 2. What is real, and what is doubled

Every scenario composes the merged packages itself, inside the test tree, against a mock venue. Nothing is wired into a live composition root, because none exists.

| Package | Real in this suite |
| --- | --- |
| `WP-260` `packages/polymarket-secure` | `SecureVenueClient` built by `createSecureVenueClientForTesting`: the run-mode gate runs, the signer is the package's sealed mock, every signed order is cross-checked against its request and the account, and every answer and error is classified by WP-260's own mapping. Restores go through `SignedOrderEnvelope.fromPersistedPayload`. |
| `WP-270` `packages/oms` | `OrderManager`: state machines, signed-payload persistence, the salt gate, cancel and replace, attribution, reservations, recovery. |
| `WP-280` user stream | `createUserStreamManager` with a live-shaped context: normalization, projections, reconnects and every reconciliation request. |
| `WP-290` reconciliation | `ReconciliationCoordinator`, `ReconciliationJournal` and the real `Ledger`. |
| `WP-300` inventory | `ReservationService` over `InventoryBook`, in memory. Its book survives every crash only by the surviving-inventory assumption below. `WalletOperationManager` is not composed. |
| `WP-310` | `VenueModeDetector` with `withModeDetection` and `venueModeSource`, and `RateLimitBudget`, both on their dated venue-valued snapshots. |
| `WP-320` | `createLiveSafety` (the fencing authority, the health lease, kill-switch enforcement, eligibility, the ADR-033 D6 lapse recovery, the fenced venue port, `OmsProgressMonitor`), `createOrderHeartbeatController`, and `createFencingLeaseStore` on real PostgreSQL. |
| `WP-330` `apps/ops-cli` | `runOpsCli`, the whole invocation: the gate, the scoped confirmation, the audit (a real file), the budget, the session and the command. |

Doubled, as the earlier suites double them:

- **The venue** is the mock CLOB (§3), behind WP-260's fake-SDK seam.
- **The OMS store** is WP-270's `MemoryStore`, and the payload cipher its `MockCipher`.
- **The journal sink and the time line** are in memory: WP-320's `ManualTime`.
- **WP-320's fakes** stand in for the kill-switch reader, the geoblock and closed-only ports and the release finality. WP-320's in-memory `MemoryFencingStore` is used everywhere except scenario 6.
- **WP-300's inventory book is carried across every crash, in memory.** The harness inherits this from WP-290's. WP-300 has no journal rebuild (`WP300-PERSIST`, §9), so a real restart would lose the book. Every "reservations conserved" check after a restart (§4.1) therefore holds only under this **surviving-inventory assumption**.
- **Scenario 6's writers** use WP-320's fake OMS view and coordinator, because the fence is that scenario's subject. ADR-008 §5 says a standby "may not submit orders or send heartbeats while another holder is live". That neither writer runs an OMS or a reconciler against the account is this harness's own, stricter design choice. The OMS's own fenced path is in `heartbeat-failure.test.ts`.

**Safety rails in the tests:**

- Every test installs WP-260's network tripwire and fails if anything was refused.
- The real-PostgreSQL file installs a guard of the same kind that admits exactly one TCP destination: the throwaway container's host and port. Since r1 it checks the host too, and a self-test pins that (J8a).
- The pinned SDK's error objects are made by the SDK's own HTTP layer, answered from memory by the tripwire's responder (`support/sdk-errors.ts`), as WP-260's contract suite makes them.

---

## 3. The mock venue

`test/fault-injection/live/support/mock-clob.ts` subclasses WP-290's `ReconWorld`, imported read-only, so WP-290's ledger and consistency oracle apply to it unchanged.

### 3.1 What it models, and where each fact is documented

`mock-venue-facts.test.ts` checks each quote verbatim against the dated report. It also checks that the mock's figure equals the product's own constant.

| Behaviour | Source |
| --- | --- |
| A valid heartbeat must arrive within 10 s or every open order of those credentials is canceled; the check runs every 5 s; send every 5 s | `verified-2026-09-16.md` §5 (S-D17); unchanged by digest in `verified-2026-09-30.md` §5 |
| The heartbeat id chain: an empty id to start, the next id on each success, `400` with the expected id | same |
| `425` on order-related requests while the engine restarts, `Retry-After` optional; then post-only for two minutes, cancels allowed, a non-post-only order refused `503 post_only_mode` | `verified-2026-09-30.md` §9, E-06, E-07 |
| Cancel-only and disabled trading both answer `503 {"error": "trading is disabled"}`; cancels "work even in cancel-only mode" | §9 E-05, §2.5 |
| `live` and `unmatched` placement answers; the pinned SDK turns `unmatched` into `{ok: false, code: "unmatched"}` | §2.2, C-6; the WP-260 handoff |
| Placements in batches of 1 to 15; batch cancels of at most 1,000 ids (C-11, the lower figure) | `verified-2026-09-16.md` §2.1 D-05; `verified-2026-09-30.md` §2.5 |
| Cancel answers `{canceled, not_canceled}` with the documented reasons | §2.5 |
| Order and cancel buckets **per signer address**, shared by every API key of that signer (the trader's and the emergency key are two keys of one signer); the Standard tier from the dated snapshot; a batch admitted only with tokens for every entry; `Poly-RateLimit-*` feedback; `429` with `Retry-After` | `verified-2026-09-16.md` §8 (S-D25); `rate-limits-2026-09-30` |
| D-21: a cancel-all or cancel-market first consumes one cancel token, then one more per order canceled once the result is known. On the Standard tier that can put the bucket in debt, and `Remaining` goes negative. Later cancel requests stay blocked until the bucket holds the next request's cost | `verified-2026-09-16.md` §8 D-21 |
| User channel `order` events (`PLACEMENT`, `UPDATE`, `CANCELLATION`) and `trade` events (`MATCHED` … `CONFIRMED`); `PING` every 10 s answered `PONG`; no replay after a disconnection | `verified-2026-09-16.md` §4; §W.4 |
| An order missing from the open-orders list is not proof of cancellation; a by-id read returns it whatever its status | §W.9 E-14 |

### 3.2 What it assumes (undocumented; each is a test assumption)

| Id | Assumption | Where it matters |
| --- | --- | --- |
| A1 | API keys of one account see and act on the account's orders: open-order reads, by-id cancels and the user channel. Session Keys see only their own (E-16) and are not modelled. | scenario 4: the emergency key cancels the trader key's orders |
| A2 | `DELETE /cancel-all` cancels the orders owned by the calling credentials. That is WP-330's own plan text; the docs do not say. The wider reading, every order of the account, is run too. | scenario 4 runs both readings |
| A3 | While the heartbeat stays lapsed, every check cancels the credentials' open orders, including orders placed after the first sweep. A sweep leaves the id chain unchanged. An empty id after the chain started is invalid. | scenario 3 |
| A4 | Heartbeats and reads are answered normally in every engine mode. | scenarios 3 and the restricted modes |
| A5 | A cancel refused `425` during a restart was not applied. | restricted modes |
| A6 | The 5 s check's phase is fixed when the venue starts. A valid heartbeat received exactly 10 s after the last one still counts. The venue's clock never stalls when a process does. | scenario 3 |
| A7 | Our orders rest and never cross on arrival. Fills are the venue's later matches at the order's price, fee 0, as `ReconWorld` books them. | every scenario |
| A8 | A user-channel frame is pushed through the shared time line, so it reaches a process only when that time line turns. It therefore always trails the synchronous REST answer of the request that caused it. The venue documents no ordering between a REST answer and the push of the same change. | WP340-F1's route 3 rests on it; routes 1 and 2 do not |
| A9 | The rate-limit details the docs leave open. Tokens refill continuously at the tier's rate. A request refused `429` consumes nothing: an order batch, or a cancel blocked by D-21. The refusal is the pinned SDK's `RateLimitError` with `Retry-After: 2`. A by-id cancel batch, like a placement batch, needs a token for every id. Callers sharing one signer are served in arrival order; bucket arbitration is undocumented (`verified-2026-09-16.md` §12). A 425'd cancel consumes nothing, with A5. | the rate-limit pins; scenario 4 under D-21 debt |

The documented timing is documentary only (`verified-2026-09-16.md` §5): no round has observed the venue enforce it.

---

## 4. Scenarios run, with results and counts

All counts below are from the final runs listed in §7.

### 4.1 Criterion 1: mid-order crashes (`mid-order-crash.test.ts`, `mid-order-crash.property.test.ts`)

Each named scenario runs once without a crash. Then the first process is killed BEFORE and AFTER each port call it makes, one call per run. The kill points cover every OMS and reconciliation port, plus the steps beneath WP-260's client:

- the signer call (MID-SIGNING);
- the venue's processing, entered (MID-TRANSMISSION) or completed (MID-ANSWER).

A fresh process restarts over what survives. It binds, reconciles until it resumes, and drains as a live composition would: the same signed order resent on the restart path, or abandoned only when the OMS accepts that.

The oracle (`support/oracle.ts`):

- no duplicate exposure at any instant: no S2, no DUPLICATE_EXPOSURE, no OVER_EXPOSURE;
- every resume consistent (WP-290's R1), and every accepted answer true when given (R2, R3);
- consistent at the end, with nothing lost;
- reservations conserved exactly;
- no signature at rest: in the OMS store, the journal or the ledger;
- the journal replays.

| Scenario (`mid-order-crash.test.ts`) | Port calls in the baseline | Kill runs (before and after each) | WP340-F1 releases (baseline / kill runs) |
| --- | --- | --- | --- |
| Accepted, partly filled (the user channel and a reconciliation deliver it), canceled | 81 | 162 | 0 / 0 |
| MID-ANSWER: the venue acted and the answer was lost; PRESENT by signed identity, then filled; a premature second order refused | 106 | 212 | 1 / 151 |
| MID-TRANSMISSION: the request never arrived; ABSENT after the horizon; then a new salt | 75 | 150 | 0 / 0 |
| A late arrival inside the horizon: never ABSENT, found PRESENT; premature second orders refused | 61 | 122 | 0 / 0 |
| A real 425 (the pinned SDK's own error): held ABSENT, the same signed order resent in the post-only window | 65 | 130 | 0 / 0 |
| `unmatched` (the pinned SDK's UNKNOWN): found PRESENT | 57 | 114 | 0 / 0 |
| A batch whose answer was lost after the venue acted: both PRESENT, one filled | 94 | 188 | 0 / 0 |
| A documented rejection, then a new salt | 51 | 102 | 0 / 0 |
| **Total** | **590** | **1,180** (each killed; plus 8 baselines) | **1 / 151** |

Every one of the 1,188 runs passed the oracle, and in none did the recovery driver refuse a halting alert. Each scenario's release counts are pinned exactly (`support/expected-releases.ts`). The MID-ANSWER scenario meets WP340-F1 by its first route in most runs, because its lost answer, its fill and its timely stream are exactly that route's ingredients.

"Reservations conserved" after a restart holds under the surviving-inventory assumption (§2): the inventory book outlives the process here, and no composition can provide that until `WP300-PERSIST` is done.

Named pins on the three moments the packet names (`mid-order-crash.test.ts`, second `describe`):

- **MID-SIGNING.** Killed after the signer produced a signature the SDK never returned. No order exists anywhere, the signature is nowhere at rest, and the group trades again.
- **MID-TRANSMISSION.** Killed with the durable SENDING mark written and the request not yet out. The venue never sees it, and ABSENT is accepted only with the quiescence attestation.
- **MID-ANSWER.** Killed after the venue created the order. The restarted process finds it PRESENT by signed identity. Exactly one order exists, and it is never resent.
- **MID-ANSWER of a reconciliation.** Killed between the OMS's write of the answer and the journal's. Nothing is applied twice. Its no-crash baseline is F1's route 1, with one release; the killed run has none.

Each of the four pins asserts its release count and that the driver refused nothing.

The seeded property runs random programs: placements under every modelled answer, batches, matches, cancels, engine restarts, socket drops, time and reconciliation. Each seed gets a baseline and random kill points.

Seeds 1 to 200, each with a baseline and 4 random kill points: **1,000 runs, all passing the oracle.**

- 800 runs were killed; every kill landed, and 257 placements reached the venue in the baselines.
- Kills by port family:
  - `journal.append` 251, `store.apply` 149;
  - reads: `read.positions` 54, `read.openOrders` 47, `read.trades` 46, `read.collateral` 35, `read.approvals` 34, `read.order` 17;
  - `ledger.projected` 31; `cipher.decrypt` 19, `cipher.encrypt` 13;
  - `sdk.signer.signTypedData` 18 (mid-signing), `reconciler.request` 17, `venue.sign` 15, `store.load` 14;
  - `venue.process.placement` 10 (mid-transmission or mid-answer), `inventory.reserve` 9, `venue.post` 7, `inventory.release` 6;
  - `halt.market`, `inventory.consume`, `venue.postBatch` and `venue.process.cancel` 2 each.
- WP340-F1 was released 71 times, pinned exactly; the driver refused no halting alert.

### 4.2 Criterion 2: lost user-stream events (`lost-stream-events.test.ts`, `lost-stream-events.property.test.ts`)

The real WP-280 manager reads the mock channel through `MockUserChannel`. Its chaos drops, duplicates and delays frames, reorders them, and drops the socket. The outputs go to the real coordinator.

| Case | Result |
| --- | --- |
| A fill whose every frame is DROPPED | Invisible to the stream: no request. The composition's periodic run reads it, and the OMS and the ledger equal the venue. |
| A venue CANCELLATION DROPPED | The periodic run reads the order by id (E-14). The OMS closes it and releases its reservation. |
| Every frame DUPLICATED | Each fill is recorded once, and the ledger books each trade once. |
| REORDERED (a settlement before its match, an UPDATE before the PLACEMENT) | The reads settle every fill exactly. |
| DELAYED past a read | WP340-F1, route 2. The account holds until an operator's review, then equals the venue. The one release is pinned. |
| The socket DROPS right after a PLACEMENT, before the fill | Loss request, pause, reconnect, RESUBSCRIBED, reconcile; consistent. |
| The socket DROPS DURING a reconciliation run | The run reading at that moment does not resume; a later one does, consistent. |
| An UNRECOGNISED frame | `UNRECOGNIZED_MESSAGE` request, pause, reconcile; consistent. |
| A foreign ORDER, its frames dropped | `ORDER_UNATTRIBUTED`; market halted; paused until an operator release. |
| A FILL of that foreign order | `TRADE_UNATTRIBUTED`; nothing attributed to a strategy. |
| A HOLDING delta (tokens, collateral) | `POSITION_UNATTRIBUTED` and `BALANCE_UNATTRIBUTED`, booked to the ledger's UNATTRIBUTED scope; halted; paused. |

Every named case also pins the driver's record: no WP340-F1 release (one in route 2), and no halting alert refused. The three UNATTRIBUTED cases pin that the driver releases none of their quarantines.

The seeded property (`lost-stream-events.property.test.ts`) ran seeds 1 to 300. Each had a random chaos policy and a random program of placements, venue matches, venue-side cancels, OMS cancels, socket drops, time and periodic runs. **All 300 seeds pass.**

- The venue published 1,514 frames. The manager was handed 929 (duplicates included), and 423 were dropped.
- The socket was lost 117 times.
- 301 venue matches and 113 venue-side cancels happened. Since r1 a cancel is counted only when the venue really canceled the order (J8b); the count is unchanged.
- 1,508 resumes occurred, and R1 checked each one: never resumed while the OMS or the ledger differed from the venue.
- At the end, the OMS and the ledger equal venue truth in every seed.
- WP340-F1 was released 59 times, pinned exactly; the driver refused no halting alert.

### 4.3 Criterion 3: heartbeat failure (`heartbeat-failure.test.ts`)

A live-shaped process (`support/safety-node.ts`: WP-320's real live safety and controller, the OMS behind WP-320's fence) heartbeats to the mock venue and rests one order there. Then the heartbeat stops by each WP-320 path. Each case asserts, from the venue's own record:

- the cancel came more than 10 s after the last valid heartbeat, and at most 15 s after it;
- no valid heartbeat arrived in between;
- the controller lapsed (ADR-033 D6), the composition recorded it, and new entries were blocked;
- the D6 recovery sent the order to RECONCILING (`MANUAL_REQUEST`);
- reconciliation then shows the order CANCELED with its reservation released, and R1 to R3 hold.

| Path | Lapse cause | Venue cancel after the last valid heartbeat |
| --- | --- | --- |
| Unhealthy health lease (the market feed's proof ages out); pages "Heartbeat health lease failed while orders may exist" | `GATE_REFUSED` (`HEALTH_MARKET_DATA_PROOF_STALE`) | 14.5 s |
| Lost fence (an operator revokes the lease); every submission refused, signing included | `GATE_REFUSED` (`FENCE_RENEW_LOST`) | 14.5 s |
| GLOBAL FULL_HALT, its own cancels never answered | `GATE_REFUSED` (`HEALTH_KILL_SWITCH_ENGAGED_STOPS_HEARTBEAT`) | 14.5 s |
| ACCOUNT FULL_HALT, its own cancels never answered | the same | 14.5 s |
| Transport failure (the gate still passes) | `TRANSPORT_FAILED` | 14.5 s |
| A 20 s process stall (the venue sweeps during it) | `NO_ATTEMPT` | 14.5 s |

The GLOBAL and ACCOUNT CANCEL_ALL variants, with working cancels, cancel the order through the OMS at once and stop the heartbeat. A MARKET or a STRATEGY_INSTANCE FULL_HALT does NOT stop the heartbeat (ADR-033 D1 item 3): the venue receives a valid heartbeat every 5 s for 30 s and sweeps nothing, and the switch's own cancel removes its order.

The 14.5 s, printed by each case of the final run, comes from the clock phases: a heartbeat every 5 s from t = 0.5 s, and the venue's checks every 5 s from t = 0. The documented window allows anything in (10 s, 15 s], and that window is what each case asserts.

### 4.4 The restricted modes and rate limits (`restricted-modes.test.ts`)

- **A real 425 restart, then the post-only window.** No placement is sent while the engine restarts. No non-post-only order reaches the venue in the two-minute window (E-07): WP-310's gates refuse it in the OMS. The 425'd order is reconciled ABSENT and never duplicated. Its same signed order is refused on the restart path inside the window, so the composition abandons it. Cancels pass, the mode returns to NORMAL, and the group trades with a new salt.
- **Cancel-only.** The 503 is UNKNOWN, and placements pause. The order reconciles ABSENT and is closed. Cancels still work at the venue.
- **A per-signer 429.** The pinned SDK's `RateLimitError` is UNKNOWN, never a rejection, and it reconciles ABSENT. The venue's documented headers reach the composition through WP-260's `onRateLimitUpdate`: `Remaining` 59 after an accepted order, then 0 on the 429, tier `Standard`. Fed with that answer, WP-310's budget grants no `NEW_ORDER` for the signer inside the 2 s `Retry-After`, and grants one after it. A probe with the feedback withheld found it granted at once, so the pin depends on the feedback.

**The rate-limit model itself** (`rate-limits.test.ts`, r1, J4), each case through WP-260's real client:

- **Per signer, not per API key.** The trader key's drained order bucket refuses the emergency key's placement with `429`, and nothing is created. One token later (25 ms) it is admitted. The trader key's spent cancel bucket blocks the emergency key's cancel-all in the same way.
- **D-21 admission.** The 121st cancel-all at one instant is blocked, and admitted 13 ms later.
- **D-21 debt.** A cancel-all that cancels 130 orders leaves the bucket at 120 − 1 − 130 = −11. The header's `Remaining` reads −11. Every cancel, by id or cancel-all, stays blocked for 149 ms, and the next one passes at 150 ms. A cancel-market does the same.
- **All-or-nothing batches.** A by-id batch of 6 ids at a balance of 5 is refused whole, and consumes nothing. The batch of 5 passes.

### 4.5 Packet scenario 4: the independent cancel path (`independent-cancel.test.ts`)

**Setup:**

- The trader places orders under its own API key.
- One order is part-filled, and the account also holds an order the trader never knew of.
- Then the trader dies, and its database becomes unreachable: its OMS store and its journal sink reject every call, and every call is counted.

`runOpsCli cancel-all` then runs with LIVE-shaped flags and only its own ports:

- the emergency credential (an opaque `{accountRef}`);
- WP-260's real client under the separate `emergency` key, built with the context the CLI's gate permitted (as WP-330's own tests build it);
- the venue's reads;
- a real file audit log;
- an audit mirror whose database is unreachable;
- a lease store that throws if it is opened.

**Result, under both readings of A2:**

- exit `COMPLETED`, with nothing of the account left resting;
- the audit file holds `INVOKED`, `ACTING` and `OUTCOME`, in order, at mode 0600;
  - `ACTING` lists the three orders it planned against, before any cancel;
  - `OUTCOME` says `verified: true`;
- no credential or signature in the audit or the output;
- zero calls to the trader's database, and no lease store opened.

**Against the trader's D-21 debt (r1, J4).** The trader's last act before dying was a market sweep of 140 resting orders. That left the cancel bucket of the signer it shares with the emergency key at −21. The CLI's `DELETE /cancel-all` is then refused `429` (UNKNOWN, `RATE_LIMITED`). Its by-id sweep waits out the `Retry-After`, and cancels all three orders. The exit is `COMPLETED`, `verified: true`, and the audit records the refused cancel-all and the sweep. The CLI's own plan says it cannot see the venue's shared balance; the venue's real `Retry-After` for a blocked cancel is assumption A9.

Under the credential-scoped reading, `DELETE /cancel-all` cancels nothing the trader's key placed; WP-330's by-id sweep of venue truth does. When the trader comes back, its restart reconciles to the emergency cancels: both orders CANCELED (one part-filled), consistent and resumed. Under PAPER flags the same invocation exits `RUN_MODE_REFUSED`. It touches no configuration, credential, venue or lease, and every order stays.

### 4.6 Criterion 4: the live maximum defaults (`live-defaults.test.ts`)

- **Shipped configurations.** `AGENTS.md` and the brief state all four defaults. The shipped trader example runs `PAPER` with both caps at exactly `"0"`. No compose fragment and no CI workflow sets any of the four.
- **Code defaults.** An absent setting reads as PAPER, no real orders and caps `"0"`; each raised value is refused by name. This holds for WP-260's flags reader, the trader's startup floor, the backtest floor and the allocator's fenced caps.
- **Every live-capable component refuses in PAPER, before its port is touched.** It also refuses under the repository ceiling when a live mode is asked for, and in BACKTEST and SHADOW. The components:
  - WP-260's secure client, the real and the test factory;
  - WP-280's manager;
  - WP-320's controller, fencing authority and live safety;
  - WP-320's PostgreSQL lease store: its database handle is a proxy that is never read;
  - every venue-touching command of WP-330's CLI.

### 4.7 Packet scenario 6: two writers on real PostgreSQL (`test/fault-injection/live/postgres/two-writers.test.ts`)

**Setup:**

- Two live-shaped writers share one account, one API key and one lease in `ops.fencing_leases`, on a throwaway Testcontainers database with every migration applied.
- Both try to transmit the whole time: a heartbeat every 5 s, and an order every tick through WP-320's fenced port in front of WP-260's client.
- The venue's own log is the oracle.

| Case | Result |
| --- | --- |
| They race for the lease | Exactly one wins. Only it signs, places and heartbeats at the venue. The other is refused in its own process (`FENCE_NOT_ACQUIRED`). Never both held, never both permitted, at most one ACTIVE lease. |
| The holder STALLS | The other takes over only after the lease ended by the database's clock and the 60 s bound passed. An order the old holder signed while holding is refused at its transmission. From the new holder's first act on, the old holder never reaches the venue. |
| An operator REVOKES the holder | The same. |

The time line runs at most 10 times faster than real time and never slower than it. So a holder's local deadline always falls before its lease's real expiry, which is the authority's conservative direction.

The file's network guard admits only the container's host and port. A fourth test pins that: a connect to the database's port on another loopback host, or to another port on its host, is refused (r1, J8a).

---

## 5. Findings

### WP340-F1 (STOPPED): a `LIVE` observation that reaches the OMS after a terminal state halts the market

**What happens.** WP-270's OMS raises a halting `EVIDENCE_CONFLICT` alert ("a terminal order was observed LIVE") when an order event says `LIVE` for an order it holds FILLED or CANCELED. WP-290 then quarantines the market (`OMS_HALTING_ALERT`) and holds the account until an operator releases the quarantine. In a truthful world such an event is only ever stale. The user channel carries a venue timestamp on every event, but the OMS's observation port takes none, so it cannot tell a stale event from a contradiction.

**Three routes, each reproduced and pinned in `findings.test.ts`:**

1. A placement's answer is lost, and the venue fills or cancels the order. The stream's `PLACEMENT` (LIVE) is retained while the attempt is unknown. The reconciliation's PRESENT answer adopts the terminal state, and only then is the retained `LIVE` drained. It is related to WP270-R4-01: the adoption and the drain are not crash-atomic either. After a restart, the same conflict comes back as "recovered with an open evidence conflict".
2. A frame lags a reconciliation read that recorded the order FILLED.
3. With no fault at all, the OMS places and cancels an order before the stream delivers its `PLACEMENT` frame. The venue answered two REST calls faster than one push. Any cancel or replace faster than the push latency can halt its market. This route rests on the mock's push timing, assumption A8: a frame always trails the REST answer of the request that caused it. The venue documents no such ordering, and how often it occurs live is unmeasured. Routes 1 and 2 do not depend on A8.

**Safety holds.** Nothing is sent while the quarantine stands. The release resumes only a consistent account, and R1 was checked at every resume.

**Liveness does not.** In the suites, a recovery driver (`releaseKnownFindings`, `support/live-node.ts`) releases WP340-F1 as an operator would, and nothing else. Since r1 (J1) it releases a quarantine only when `classifyQuarantine` finds all of the following:

1. **Provenance.** The quarantine's alert is bound to the conflict event(s) that opened it. WP-290 names the alert by the OMS instance's first run id and the alert's ordinal. A live alert is bound to the `EVIDENCE_CONFLICT` event of its own order in the same commit. A recovered alert ("recovered with an open evidence conflict") is bound to every `conflict: true` event after the last `conflict: false` one, in the log the restarted OMS loaded. Every conflict-opening type counts: `EVIDENCE_CONFLICT`, `OBSERVATION_UNRECOGNISED`, a read's conflict and a venue-id conflict. An ambiguous binding is refused.
2. **Shape.** Every bound event is F1's: an `EVIDENCE_CONFLICT` out of FILLED or CANCELED, caused by an observation of `LIVE`.
3. **Staleness.** When each bound event was written, the venue already held the order terminal, so the `LIVE` was stale. The venue still holds it terminal at the release.

Every other halting-alert quarantine stays and is recorded, with its reason, in the world's refused list. Every suite fails a run on a refusal.

`release-driver.test.ts` pins both of round 1's witnesses, each of which the r0 driver released:

- **Provenance (astra's witness).** An F1 is released; an unrecognised-status conflict then reopens the same CANCELED order, and the process crashes. The recovered halt is bound to the later conflict, and stays.
- **Staleness (Opus's witness, without a mutant).** The OMS holds an order CANCELED that the venue rests, and a true `LIVE` arrives. The alert text is F1's, but the `LIVE` was true, so the halt stays.

Two positive controls show a genuine F1, live and recovered after a crash, is still released. Mutant M20 (§6), any partial fill completing the order, now fails the named crash and stream tests. On the r0 tree they passed it, 23 of 23, while its driver released true contradictions: the Opus verifier counted 519 releases of venue-live orders, and r1 reproduced the pass, with 362 and 277 releases in two crash scenarios that release none unmutated.

**Every release the driver makes, by population** (`support/expected-releases.ts`; each pinned exactly by its suite):

| Population | File | Releases |
| --- | --- | --- |
| Crash matrix, no-crash baselines | `mid-order-crash.test.ts` | 1 |
| Crash matrix, kill runs | `mid-order-crash.test.ts` | 139 |
| Crash named pins (one baseline) | `mid-order-crash.test.ts` | 1 |
| Crash property | `mid-order-crash.property.test.ts` | 70 |
| Stream named (route 2) | `lost-stream-events.test.ts` | 1 |
| Stream property | `lost-stream-events.property.test.ts` | 59 |
| **The r0 suites** | | **271** |
| Release-driver pins (r1) | `release-driver.test.ts` | 3 |
| **Total** | | **274** |

The r0 report gave 151 + 71 + 59 (+1) = 282; it missed the two baselines (J3). The four TODAY tests of `findings.test.ts` release their quarantine by hand and are not counted.

**Note (2026-10-09, C1-OMS06).** The table above is the current pins. When this report was written, the suites pinned 151 kill-run releases, 71 property releases, 284 on the r0 suites and 287 in total. C1-OMS06 deleted WP-290's halt port: the live gate now reads the quarantines from the coordinator's journal. The coordinator's `halt.market` calls were kill points, so they are gone. MID-ANSWER has 101 port calls instead of 106, and its kill runs release 139 times instead of 151. The seeded crash property's kills land elsewhere and release 70 times instead of 71. §4.1's call and kill figures predate the change.

**Owner, and the ruling.** The user ruled on 2026-10-05: venue-time ordering. The venue timestamp is passed into the OMS. A `LIVE` older than the evidence that made the order terminal is recorded as stale, with no halt; a newer one still halts. Before live: a short ADR, then a `packages/oms` round, with a venue check of the stream timestamps' ordering and precision. Until then, every `LIVE` after a terminal state needs an operator. When that round lands, the `it.fails` markers fail, and every count above drops to 0.

**Reproduction:**

```
pnpm exec vitest run --config test/fault-injection/live/vitest.config.ts findings
```

The four `it.fails` pins state the wanted behaviour (routes 2 and 3, and route 1 for a fill and for a cancel). The four "TODAY" tests state the current fail-closed behaviour, including the operator's release.

### Other observations (no product change asked)

- **Under assumption A2**, `cancel-all` alone cancels nothing another key placed. WP-330's by-id sweep is what makes the emergency path work (mutant M14). If the venue scopes reads by credential too, which E-16 documents for Session Keys, neither works. Treat any multi-credential design as unreconcilable until an ADR rules it (`verified-2026-09-30.md` E-16).
- **Mutant M15 first survived.** No scenario had exercised the post-time fence check, so the takeover cases now include an order signed before the loss and posted after it. M19 also first survived: the periodic by-id read hid a missing D6 order request. The heartbeat cases now assert the D6 requests from the OMS's durable events.

---

## 6. Mutation rows

Each row was applied to the real package in a scratch worktree (`git worktree add --detach`, with `node_modules` hardlinked). The relevant suite was run, and the file was restored. Its sha256 was compared with the original, and every row matched. Nothing was committed.

In r1 every row was run again, against the r1 tests, and M20 was added (J1). The table gives the r1 results.

| Id | Criterion | Mutant (real package) | Expected to fail | Observed (`Tests` line; failing tests) |
| --- | --- | --- | --- | --- |
| M1 | 1 | `oms` `#saltGate` always open, the whole plan remaining | a new salt while an earlier attempt is unresolved (S2, DUPLICATE_EXPOSURE) | KILLED: 2 failed, 11 passed. The seeded property, and the late-arrival case. In the MID-ANSWER case the OMS's pause refuses the premature order first |
| M2 | 1 | `oms` reconciliation: ABSENT before the quiescence horizon | a late arrival read ABSENT (R2), then a second salt | KILLED: 2 failed, 11 passed. The seeded property, and the late-arrival case |
| M3 | 1 | `polymarket-secure`: a `TransportError` mapped NOT_SENT, not UNKNOWN | a lost answer closed while its order lives | KILLED: 5 failed, 8 passed. MID-ANSWER, the batch, late arrival, MID-ANSWER of a reconciliation, the seeded property |
| M17 | 1 | `polymarket-secure`: `unmatched` mapped REJECTED | an order that exists treated as rejected | KILLED: 2 failed, 11 passed. The `unmatched` case, the seeded property |
| M4 | 2 | `oms` reconciliation: no by-id read of a tracked open order the open list omits (E-14) | a dropped venue cancel never reconciled | KILLED: 1 failed, 11 passed. The stream property. The named dropped-cancel case still passes, because the order's earlier evidence makes the coordinator read it by id anyway |
| M5 | 2 | `oms` reconciliation: a missed fill reported delivered, never given to the OMS | a dropped fill never reconciled | KILLED: 8 failed, 4 passed |
| M6 | 2 | `polymarket-secure` user stream: no request on a socket loss | the loss neither asks nor pauses | KILLED: 2 failed, 10 passed. The worst-moment socket drop, and the stream property |
| M7 | 3 | `polymarket-secure` heartbeat: the gate always permits | the heartbeat never stops, so the venue never cancels | KILLED: 7 failed, 3 passed. Every gate-driven path. The transport and stall paths do not depend on the gate |
| M8 | 3 | `trader` kill switch: GLOBAL or ACCOUNT no longer stops the heartbeat | the venue never sweeps under a kill switch whose cancels hang | KILLED: 4 failed, 6 passed |
| M9 | 3 | `trader` kill switch: a MARKET switch stops the heartbeat | ADR-033 D1 item 3 | KILLED: 1 failed, 9 passed |
| M19 | 3 | `trader` lapse recovery: no `requestOrderReconciliation` (ADR-033 D6 step 2) | the lapse sends no order to RECONCILING | KILLED: 3 failed, 7 passed. It first SURVIVED, because the periodic by-id read hid it; the D6 pin was added (§5) |
| M10 | 4 | `polymarket-secure`: the flags reader defaults `MAX_RUN_MODE` to LIVE | an absent setting is no longer PAPER | KILLED: 1 failed, 14 passed |
| M11 | 4 | `capital-allocator`: `LIVE_MICRO_CAP_FLOOR` raised to `"1"` | the cap floor and the shipped example | KILLED: 2 failed, 13 passed |
| M12 | 4 | shipped `trader.config.example.json`: `liveMicroMaxOrderNotional` raised to `"25"` | a live cap raised in a shipped config | KILLED: 1 failed, 14 passed |
| M13 | 4 | `trading-core`: the startup floor accepts a nonzero cap | a raised cap not refused | KILLED: 1 failed, 14 passed |
| M14 | scenario 4 | `ops-cli` `cancel-all` skips its by-id sweep | under A2's credential scope, the trader's orders stay | KILLED: 3 failed, 2 passed. The account-scoped reading passes, which is what A2 predicts. Since r1 the D-21 debt case fails too: its refused cancel-all leaves everything resting |
| M15 | scenario 6 | `trader` fenced venue: a placement transmitted whatever the fence says | the old holder's signed order reaches the venue after the takeover | KILLED: 2 failed, 2 passed (the r1 guard self-test is the fourth test). It first SURVIVED; the held-back-order pin was added (§5) |
| M16 | scenario 6 | `trader` fenced venue: a non-holder may sign | the non-holder signs at the venue | KILLED: 3 failed, 1 passed (the guard self-test) |
| M18 | restricted modes | `oms` restricted mode: POST_ONLY reported to the OMS as NORMAL | a non-post-only order sent into the post-only window | KILLED: 1 failed, 2 passed |
| M20 | 1 and 2 (J1) | `oms` `#applyFill`: any partial fill completes the order, so it is FILLED while the venue still rests the remainder, and a true `LIVE` then raises F1's alert text | the driver releasing a true contradiction as F1 | KILLED: 7 failed, 16 passed, on the NAMED crash and stream tests: the driver refuses those halts, and the runs stay halted. On the r0 tree the same named tests passed it, 23 of 23, with 362 and 277 releases in two crash scenarios (reproduced in r1) |

**20 of 20 killed against the r1 tests.** Every file was restored byte-identically. Rows M15 and M16 ran on real PostgreSQL. Results: `~/pmb-rounds/wp-340/r1/mutation-results-r1.json` (r0: `mutation-results-final.json`); script: `r1/mutate-r1.py`.

---

## 7. Gates

Every gate below was run on the r1 tree, in one sequence (r1 logs: `~/pmb-rounds/wp-340/r1/gates/`; r0: `~/pmb-rounds/wp-340/gates/`). Every one exited 0, with one disclosed retry.

| Gate | Result (files / tests) |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm check:deps` | exit 0; 35 packages, 105 edges (unchanged) |
| `pnpm test` | 528 / 11,893; nothing of WP-340 runs in it |
| `pnpm test:e2e` | 9 / 216 |
| `pnpm test:replay` | 3 / 19 |
| `pnpm test:contract` | 8 suites: 7/650, 6/65, 9/158, 7/95, 2/31, 2/9, 5/76, 3/28 |
| `pnpm test:fault` | WAL 11/89, OMS 1/7, reconciliation 64/848 |
| `pnpm --filter @polymarket-bot/trader test:fault:live-safety` | 15 / 74 |
| this suite's typecheck (`test/fault-injection/live/tsconfig.json`) | exit 0 |
| **this suite** (`test/fault-injection/live/vitest.config.ts`) | **13 / 95** (r0: 10 / 75) |
| **this suite's PostgreSQL half** (Docker) | **1 / 4** (r0: 1 / 3) |
| control-api `test:integration` (CONTROL-1b's whole-repo guard) | 22 / 310 |
| control-api `test:integration:postgres` | 5 / 36 |
| storage-postgres `test:integration` (the fencing store's own suite) | 16 / 257 |
| ops-cli `test:integration` (the emergency CLI's bundle on PostgreSQL) | 1 / 6, on a retry. The first attempt failed before any test ran: Testcontainers' "Port 41462 not bound after 120000ms" (6 skipped). Nothing under `apps/ops-cli` or `test/integration` changed in r1 |

Docker was available. The Testcontainers containers this work started were stopped by Testcontainers itself, and no other container was touched.

In r0, the first full gate run had the two end-to-end files under `test/e2e/live-mock/`. It failed `test:e2e` at 2 of 235 (§1). They were moved, and every gate was run again.

---

## 8. What remains unverified until a live composition root exists

Nothing here can verify the following. Each needs real infrastructure, a credential, or a ruling.

- **ADR-033 D5, the heartbeat transport.** No transport exists. The mock serves S-D17's shapes; the S-D17 / S-D18 conflict (the route, and whether a success carries an id) is open.
- **Credentials.** None of these exists:
  - the trader's signer and L2 API credentials;
  - the emergency credential binding (§15);
  - the CSPRNG behind `requestToken` (ADR-032);
  - the AEAD payload cipher.

  The mock signer's signature is never a valid one.
- **The IP-budget split** with the data gateway and the ops CLI (WP310-LOWS, WP320-FOLLOWUPS): budgets are per process here.
- **The signer's shared buckets, live.** The mock shares one signer's buckets between the trader's and the emergency key, as §8 documents, and blocks cancels in D-21 debt. Not verified: the venue's real answer to a blocked cancel and its `Retry-After` (A9); bucket arbitration between callers; whether the emergency CLI's single by-id sweep clears a debt deeper than what refills before it is sent.
- **Restart-safe inventory.** WP-300's book is in memory only, with no journal rebuild (`WP300-PERSIST`). This harness carries it across every crash, so every "reservations conserved" result after a restart holds only under the surviving-inventory assumption (§2). `WalletOperationManager` is not composed, so wallet-operation restart recovery is unverified.
- **Adapters the composition binds:**
  - the authenticated read adapter (`AccountReadPort` over the SDK and the Data API `/v2`);
  - the OMS store on migration `0005`, with `0008`'s trigger refusing a stale holder's attempt;
  - the real user-socket binding;
  - the kill-switch reader on `ops.kill_switch_events`;
  - the geoblock and closed-only endpoints.
- **Composition duties** WP-290 and WP-320 name:
  - deliver WP-280's outputs in order;
  - restart the coordinator, never rebind it;
  - route the pages and `cancelTimeoutMs` (the halt port was deleted by C1-OMS06, 2026-10-09; see §5's note).
- **The venue's real behaviour:**
  - the timing is documentary only;
  - the venue's deduplication of a same-salt resend after a 425 is undocumented (WP270-DECISIONS);
  - so are the A1 to A9 assumptions (§3.2);
  - so is whether a lapse's sweep also covers the emergency key's orders.

---

## 9. Open Wave 3 residuals, cross-referenced

| Brief row | Item | Exercised here? |
| --- | --- | --- |
| `WP270-DECISIONS` | ABSENT needs the quiescence attestation | Yes: R2 at every accepted ABSENT, the late-arrival scenarios, and mutant M2 |
| | The 425-only same-salt resend | Yes: on the mock, a same salt is the same order; the venue's deduplication stays undocumented (§8) |
| | The expected order hash is null | Not resolvable here: reconciled by signed identity throughout |
| | WP270-R4-01, the venue-id adoption and the drain are not crash-atomic | Related to WP340-F1 route 1, the drain order; the crash suites hit adoption kill points and recover |
| | OP-R4-01, unpinned guards | Not targeted |
| `WP290-RESIDUALS` | V7-PHANTOM-PERMANENT-HOLD | WP340-F1 is a related liveness hold. It is operator-releasable, not permanent |
| | I-12, a lone foreign exact twin adopted PRESENT | Not reproduced: the mock never creates exact twins |
| | Composition duties | The suites deliver outputs in order and restart rather than rebind (§8) |
| `WP300-PERSIST` | WP-300's identity sets, kept observations, quarantines and request map are in memory only; no journal rebuild | **Not exercised; assumed away.** The harness carries the inventory book across every crash (the surviving-inventory assumption, §2), so reservation conservation after a restart is shown only under it. `WalletOperationManager` is not composed: wallet-operation restart recovery is unverified (§8) |
| `WP300C-OBLIGATIONS` | The composition binds `requestToken` to a CSPRNG and tests that composed ids cannot be derived; it calls `retryReconciliationRequests` on a cadence and alerts on `outstandingReconciliationRequests()`; a journal or replay records the drawn tokens; WP-290 echoes `requestId` and never answers with a read made before receiving the request; INFO J9, R4-01, R4-02 | Run, not asserted here: WP-290's coordinator calls the OMS's `retryReconciliationRequests` at the start of every run and echoes each `requestId` in its answers (WP-290's own suites pin both). Not exercised: the CSPRNG (a deterministic test token source is used), a composition's own cadence, the outstanding-request alert, and the recording of the drawn tokens. They are composition duties (§8) |
| `WP310-LOWS` | CX310-R3-01, OP-R3-01, the policy numbers | Not targeted. The suite runs on the dated snapshots, which are not operator rulings |
| `WP320-FOLLOWUPS` | `scopeRef` validation, an OMS cancel deadline, the composition's routes, the `test:fault` wiring, the IP split | The cancel-hang case in §4.3 shows the heartbeat backstop when a cancel never answers. The rest are composition or CI items (§8, §10) |
| `WP330-LOWS` | CX330-R5-01, WP330-V5-01, the INFO pins | Not targeted. Scenario 4 uses the real file audit, sequentially |
| `CAP1-RESIDUALS` | `CAP1-TIER1-LIMIT-PRICE`, OBS-1, OBS-2, R4-FABLE-01 | Not exercised: the risk checks are not composed here. R4-FABLE-01 needs a halt released in-run, which no live composition does yet |
| `ROLLOVER1-RESIDUALS` | R8-FABLE-01, R8-FABLE-02, r7 item 9, the user's confirmation of the amendments | Not exercised: series windows are not composed here |
| `V3-C12-HEARTBEAT-ADR` | ADR-033 D5, the heartbeat transport; the guide's `POST /v1/heartbeats` against the API reference's `POST /heartbeats` | Not resolvable here. The mock serves S-D17's shapes behind WP-320's transport port (§8) |
| `WP340-F1` | This report's finding (§5); ruled by the user 2026-10-05, venue-time ordering | Pinned: four `it.fails` and four TODAY tests; every release by the suites' driver is bound and counted (§5) |

---

## 10. Follow-up

1. **WP340-F1:** the ADR and the `packages/oms` round the user's 2026-10-05 ruling names (§5). Then delete the `it.fails` markers and set every count in `support/expected-releases.ts` to 0.
2. **The orchestrator:** wire `test/fault-injection/live/vitest.config.ts`, with its typecheck, into the root `test:fault` chain and CI. Also wire the PostgreSQL half into the Docker step. Rule whether WP-250's e2e posture scan should admit a live-mock subtree (§1).
3. **The live composition root,** after ADR-033 D5: bind every adapter and duty in §8, then re-run this suite against it before any mode above PAPER.
4. **A venue round:** A1, A2, A3, A8 and A9 (§3.2), and the S-D17 / S-D18 conflict.
5. **`WP300-PERSIST`** before any restart-safe composition: until then, reservation conservation across a restart is shown only under the surviving-inventory assumption (§2).

---

## 11. Revision r1

The joint round-1 review (Opus and gpt-6-astra, reconciled) found:

| Id | Severity | What changed |
| --- | --- | --- |
| J1 | HIGH | The F1 driver binds each release to its conflict and checks staleness (§5); every release population and the refusals are pinned; two negative pins and mutant M20 |
| J2 | MEDIUM | `WP300-PERSIST` and `WP300C-OBLIGATIONS` in §9; the surviving-inventory assumption in §2 and §8 |
| J3 | LOW | Every release population counted and pinned, 284 on the r0 suites (§5) |
| J4 | MEDIUM | Buckets per signer address, D-21 admission and post-result debit (§3.1, A9); `rate-limits.test.ts`; scenario 4 under the trader's debt |
| J5 | LOW | The leftover debug line is a labelled count line; a hygiene pin |
| J6 | LOW | ADR-008 §5 quoted for what it says (§2) |
| J7 | LOW | The push timing is assumption A8; "common" removed |
| J8 | INFO | The database guard checks the host (a self-test pins it); venue cancels counted when effective; the single heartbeat phase stays disclosed (§4.3) |

`report.test.ts` and `mock-venue-facts.test.ts` pin the report's side of J2, J3, J6 and J7.
