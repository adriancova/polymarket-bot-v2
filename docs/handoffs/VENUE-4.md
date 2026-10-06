# VENUE-4: Polymarket Protocol V2 and Data API v2 venue facts, and the migration plan

**Status:** Complete (2026-10-05). Merged `f925a43` (PR #78; CI run `37413220380` green). Folded into Wave 3 at the user's request, after Polymarket announced Protocol V2 on 2026-10-05.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 3 on `caf502d`.
**Base:** `ab5033a`.
**Paths (docs and public fixtures only):**
- `docs/venue/verified-2026-10-05.md`;
- `docs/venue/protocol-v2-migration-plan.md`;
- `test/fixtures/venue/protocol-v2/**`.

**Posture:** public, unauthenticated reads only.
- The Data API was read only on market-level routes (`trades`, `oi` and `resolutions` by condition, `prices-history`, `status`). No user address was queried.
- Committed fixtures have personal fields replaced with labelled synthetic values.
- The harness reported its safety classifier unavailable while the implementer ran. The orchestrator audited that agent's 261 tool calls, and every network call was a public GET.

## summary

1. **The venue report** `docs/venue/verified-2026-10-05.md` follows the house format: a source register with hashes, numbered facts with quotes, live observations, the SDK diff, and the registers. The facts that drive the plan:
   - **Dates:** Data API v1 is retired on **2026-10-24**. The canary runs through 2026-10-30, and the switchover is about **2026-11-02**; both dates come from the announcement only (C-23).
   - **Series 10192 is still all V1:** 96 of 96 open windows. The canary V2 markets are on the CLOB and on chain, but Gamma does not return them.
   - **V2 identifiers:** the trading id comes from `positionIds`, selected by the market's `version`, and `clobTokenIds` may be `null`. Gamma gives a 31-byte condition id, which the CLOB and the Data API need padded to 32 bytes.
   - **Resolution:** V2 resolution is `resolutionStatus`, or Data API `/v2/resolutions`, whose `payouts` are micro-USDC per share.
   - **SDK:** 0.12.0 is required by the docs. 0.11.0 already routes V2 orders to ExchangeV3 (domain version `"3"`) but lacks `CONDITIONAL-V2`. The bump is low risk.
   - **Heartbeat (ADR-033 D5):**
     - no SDK release has a heartbeat method;
     - `buildHmacSignature` and the `credentials` getter are public exports;
     - the documented route of the 10 s cancellation is `POST /v1/heartbeats`;
     - still open: the `400` key (C-20), and `POST /heartbeats`' timing (U-40).
2. **The impact on our code** (the plan's §3):
   - **Data API v1:** no tracked code calls it, so 2026-10-24 breaks nothing.
   - **At the V2 switchover, PAPER on the series stops.** Admission reads ids only from `clobTokenIds` and refuses every V2 window. If both fields are filled, the CTF ids are admitted, and V2 resolutions never resolve the window.
   - **The pre-live path is CTF-only and fails closed:** the SDK pin, inventory, wallet operations and market-wide cancel. The paper fill model sizes FAK and FOK BUYs in shares, not collateral.
3. **The migration plan** (`docs/venue/protocol-v2-migration-plan.md`) proposes these packages:

   | Package | What | Class | By |
   |---|---|---|---|
   | `V2-0` | ADR amendments | gates A | 2026-10-09 |
   | `V2-1` | version-selected identifiers and admission | A | 2026-10-20 |
   | `V2-2` | the market-data path and recorded-data readers | A | 2026-10-20 |
   | `V2-3` | V2 resolution | A | 2026-10-28 |
   | `V2-4` | a Data API v1 guard | B, optional | 2026-10-23 |
   | `VENUE-5` | the first V2 window's observation | D | at that window |
   | `V2-5` to `V2-8` | SDK 0.12.x; account reads on the SDK; inventory and wallet operations; cancel paths | C | before any mode above PAPER |
   | `V2-9` to `V2-11` | fixtures, simulation fidelity, registers | D | alongside |

4. **Unified SDK adoption** (the user's request), per surface:
   - **Gamma, public CLOB, the market WebSocket, `/v2/resolutions`:** keep our own clients. The SDK exposes no raw bodies for the WAL's journal-before-derive rule, drops or defaults fields, and drops WebSocket frames and hides reconnects. It can still serve as a test oracle.
   - **Account-truth Data API reads** (positions, approvals): adopt, inside `polymarket-secure`.
   - **Authenticated surfaces:** stay on the SDK, upgraded to 0.12.x.
   - **Governance:** no change to handoff §9.12 or F6 is needed.

## The user's rulings on this plan (2026-10-05)
1. **SDK scope:** the per-surface plan, as recommended.
2. **ADR-033 D5: option 1.** `POST /v1/heartbeats` inside `polymarket-secure`, signed with the SDK's public `buildHmacSignature`, as a named, reviewed exception. Pre-live.
3. **ADR-001 §8: the bounded binary64 rule** for Data API v2 sizes read through the SDK.

`V2-0` records all three in the ADRs.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `2f4629a` | CHANGES REQUIRED | 5 MEDIUMs: the heartbeat evidence understated `/v1/heartbeats`; a committed trade cursor could re-fetch unredacted rows; "account trades" put under the Data API; an unenforceable "exponent refused" promise; an approvals read that contradicted §9.12 |
| 2 | `00d793a` | CHANGES REQUIRED | 2 MEDIUMs: refusals the SDK path cannot enforce; positions reported complete despite the 0.1-share dust floor |
| 3 | `caf502d` | **ACCEPT** | none; two LOWs and three INFOs |

## known_risks
- **No V2 Gamma market has been observed,** since Gamma does not return the canary markets. The documented shape may differ (U-36), and the switchover date is undocumented (C-23). `VENUE-5` observes the first V2 window.
- **Positions:** `/v2/positions` omits holdings under 0.1 shares, and never lists inactive markets (U-47, U-48). So `V2-6` reports positions incomplete, and no live gate can pass on that read until both settle.
- **LOWs:** VENUE4-R3-01 (the `REDEEMABLE_LOST` arm is unnamed) and VENUE4-R3-02 (V2-6's door does not enforce the domain D). INFO: the `protocol-v2` `.jsonc` and `.jsonl` fixtures sit outside verify-venue's `.json`-only fixture gate.
- **Live digests are point-in-time.**

## follow_up
1. **`V2-0`:** the ADR amendments (§5 items 1-3 and 6) and the three rulings, with dual verifiers.
2. **`V2-1` and `V2-2`, then `V2-3`:** class A, by 2026-10-20 and 2026-10-28.
3. **`V2-4`, or the grep,** by 2026-10-23.
4. **`VENUE-5`:** at the first V2 window of series 10192.
5. **Class C and D:** as the plan orders them. `V2-11` adds the C-18…C-23 and U-35…U-48 register entries.

## commit_sha
`caf502d`
