# Polymarket Protocol V2 and Data API v2: impact and migration plan (`VENUE-4`, 2026-10-05)

- **Status:** a proposal. No package below is authorized; the orchestrator and
  the user authorize them. Nothing here is a ruling on ADR-033 D5 (§8).
- **Facts:** every venue fact is cited by its id in
  [`verified-2026-10-05.md`](./verified-2026-10-05.md): `F-nn` facts, `C-nn`
  conflicts, `U-nn` unknowns, `S-…` sources.
- **Code:** every `file:line` is at `ab5033a`.
- **Inferences** are marked **INF**.
- **Safety:** every proposed package is PAPER-only, tested with fixtures and
  fakes, and touches no credential, signer or wallet.
- **Round 1 (2026-10-05),** after the joint review of `2f4629a`: the A14 and
  D6 owners; new row D18; `V2-1` acceptance 8; `V2-3` payouts; `V2-6`
  rewritten (account trades out, a number policy, the approvals dependency,
  the binding site, the dust floor); `V2-9`, `V2-11`; §5 item 5; §7.1 S4 and
  S5, §7.2, §7.3 and §7.4; §8 (H-3 and option 1).

## 1. Classes, owners and status words

| Class | Meaning |
| --- | --- |
| **A** | Breaks PAPER data or trading when our series' markets become V2 |
| **B** | Breaks when Data API v1 is retired |
| **C** | Pre-live only: signing, approvals, balances, positions, account reads, cancel paths |
| **D** | Research, backtest, fixtures, documentation, registers |

- **Owner** is the work-plan entry whose `allowed_paths`
  (`docs/spec/polymarket-bot-workplan.yaml`) cover the path. When two cover
  it, the later grant is named first.
- **Status words in the matrix:**
  - **Breaks**: fails as written;
  - **Dependent**: correct once given the right id, so no change is expected
    beyond a test;
  - **Verify**: only a live V2 observation can decide (the `U-` row is named);
  - **None**: no change.

## 2. Deadlines

| Date | Source | What must hold by then | Classes |
| --- | --- | --- | --- |
| **2026-10-24** | DOC (F-33) | No code calls Data API v1. **True today** (§3.B): the orchestrator re-runs the grep on 2026-10-23 (`V3-E15-DATA-API-V1-SUNSET`) | B |
| **2026-10-30** | Announcement only (C-23) | Class A merged and green on fixtures. Canary V2 markets run through this date, but Gamma does not list them (O.1), so a V2 window of our own series cannot be read before the switchover | A |
| **About 2026-11-02** | Announcement only (C-23) | Our series' new windows may be V2 (U-37). Windows are listed about 24 h ahead (O.5), so the first V2 window may appear on 2026-11-01. The running PAPER deployment must already carry class A. `VENUE-5` observes the first V2 window | A, plus the `VENUE-5` observation |
| **Before any mode above PAPER** | Handoff §11; AGENTS.md | Class C done, and D5 ruled and implemented | C |
| Alongside | — | ADR amendments land **before** the code they govern | D |

**INF.** 2026-11-02 is not on any official page, so it could come earlier.
Class A is planned to the 2026-10-30 date, which the user named.

## 3. Impact matrix

### 3.A Identifiers, admission, subscriptions, resolution, recorded-data readers (PAPER)

| # | `file:line` | What it does today | What V2 changes | Owner | Class |
| --- | --- | --- | --- | --- | --- |
| A1 | `packages/universe/src/series-admission.ts:600-611` | `judgeSeriesWindow` takes the token ids from `Market.clobTokenIds` (a JSON string): index 0 YES, index 1 NO, each checked by `TokenIdSchema`. It never reads `version` | Select by `version`: `"v2"` reads `positionIds` (an array), `"v1"` reads `clobTokenIds`, "even when both fields are present". Refuse missing or unknown versions (F-38, F-39, F-40). With the documented `clobTokenIds: null`, **every V2 window is refused**. If both fields are populated, **the CTF ids are admitted** | `ROLLOVER-1`, `WP-110` | **A, Breaks** |
| A2 | `packages/universe/src/series-admission.ts:393-436` (`GammaWindowEventReading`, `GammaWindowMarketReading`; `clobTokenIds` at 416-417) | The reading carries `clobTokenIds` as a string; it has no `version` and no `positionIds` | Add `version` and `positionIds: string[]` (F-41). Whether events carry `version` is undocumented (F-41) | `ROLLOVER-1`, `WP-110` | **A, Breaks** |
| A3 | `packages/polymarket-public/src/series-window/door.ts:12-28` (field list), `:203-226` (`readMarket`; `clobTokenIds: stringOf(…)` at 212) | Reads exactly the listed fields. `stringOf` turns a non-string into `null` | Read `version`, and read `positionIds` as an **array** of strings. Amend the header's field list (F-41) | `ROLLOVER-1`, `WP-070` | **A, Breaks** |
| A4 | `packages/polymarket-public/src/series-window/fetcher.ts:106-112` (`GET /clob-markets/${encodeURIComponent(conditionId)}`) | Sends Gamma's condition id as-is | Gamma's documented V2 condition id is 31 bytes (F-43), and `/clob-markets` answers the 31-byte form with **404** (F-70, S-L02). The judge then refuses with "no CLOB market-info read". Pad to 32 bytes on this boundary (F-43, S-D10 lines 152-155). The width Gamma actually serves is U-36 | `ROLLOVER-1`, `WP-070` | **A, Breaks** (Verify: U-36) |
| A5 | `packages/universe/src/series-admission.ts:611-629` (CLOB `t[]` pairing) | Gamma's index pairing must equal CLOB `t[].{t,o}`, or the window is refused | **OBS:** for a V2 market `t[].t` carries the V2 position ids with labels `Up` and `Down` (O.3). Passes once A1 selects `positionIds` | `ROLLOVER-1`, `WP-110` | A, Dependent on A1 |
| A6 | `packages/universe/src/series-admission.ts:99-200` (`ReviewedSeriesSchema`, strict); mirror `packages/trading-core/src/series.ts:73`; `packages/trading-core/src/config.ts:566`, `:862`, `:887` (`seriesConfigHash`) | The reviewed series pins slug, outcomes, ticks, fees, delay and `negRisk`. It has no protocol version | INF: a reviewed `acceptedProtocolVersions` parameter, so that a v1→v2 switch is admitted on purpose. Both mirrors and both pinned hashes change together. Needs ADR-030 Amendment 2 (§5) | `ROLLOVER-1` (`packages/universe/**`, `packages/trading-core/**`) | A |
| A7 | `packages/universe/src/series-admission.ts:349-365` (`windowInternalMarketId` hashes the condition id text), `:714` (presence check) | Treats the condition id as opaque text | Stable as long as one width is used throughout. Keep Gamma's form as the identity, and pad only at the CLOB and Data API boundaries (A4, C-19) | `ROLLOVER-1`, `WP-110` | A, Dependent |
| A8 | `apps/data-gateway/src/feeds/series-admission.ts:975`, `:1470-1479` (`parseTokenPair`) | The "already known" collision check reads the `clobTokenIds` pair, or `[]` | For V2 it must use the version-selected pair. With `clobTokenIds: null` today, the check matches by condition id only | `ROLLOVER-1`, `WP-120` | **A, Breaks** (low impact) |
| A9 | `packages/polymarket-public/src/venue/frames.ts:60-69` (`assets_ids` subscribe frame); `packages/polymarket-public/src/feed/subscriptions.ts:51-64` | Subscribes the market channel by the admitted ids | Unchanged: "Use the same asset ID for … market subscriptions (`assets_ids`)" (F-60). **OBS:** subscribing by a V2 id works (F-62) | `WP-070`, `ROLLOVER-1` | A, Dependent on A1 |
| A10 | `packages/polymarket-public/src/snapshot/fetcher.ts:95` (`GET /book`), `:143-147` (`POST /books`) | Seeds books by token id | **OBS:** `GET /book` with a V2 id returns 200 (O.2). `POST /books` was not tried (U-42) | `WP-070` | A, Dependent (Verify: U-42) |
| A11 | `packages/polymarket-public/src/venue/order-book.ts:119-131`, `packages/polymarket-public/src/venue/market-events.ts:67` (`z.object` decoders; D3 projection of declared fields) | Unknown keys are stripped, not refused | The V2 book's undocumented `"version":"v2"` (C-21) is ignored. No change; add a fixture test | `WP-070` | A, Dependent |
| A12 | `apps/data-gateway/src/directory.ts:172` (`identityForToken`); `packages/polymarket-public/src/normalize/market-events.ts:218`, `:289-290` (`resolveIdentity(asset_id)`) | Maps every book, price-change, last-trade and tick-size event to a market by `asset_id` | Right once A1 admits `positionIds` (F-60). Other V2 frame types are unobserved (U-38) | `ROLLOVER-1`, `WP-120`, `WP-070` | A, Dependent (Verify: U-38) |
| A13 | `packages/polymarket-public/src/normalize/market-events.ts:664-705` (`market_resolved`) | Matches `winning_asset_id` against the window's yes and no ids, giving `YES_WIN` or `NO_WIN`; otherwise `UNRESOLVED_MARKET` or `UNKNOWN_WINNING_TOKEN` | Whether a V2 `market_resolved` names the position id, or fires at all, is undocumented and unobserved (U-38). If it does not match, no resolution is published. ADR-030 then holds the window until an operator retires it (`apps/data-gateway/src/config.ts:393-404`; `feeds/series-admission.ts:800-833`), and the series cap fills. This fails closed, but stops admissions | `WP-070`, `ROLLOVER-1` | **A** (Verify: U-38) |
| A14 | `packages/polymarket-public/src/market-state/door.ts:150-165` (six documented fields), `:340-343` (`isGammaMarketTradeReady`); `apps/data-gateway/src/feeds/market-lifecycle.ts:815`, `:892` | Lifecycle comes from Gamma `active`, `closed`, `acceptingOrders` and `archived`. Other scalars, `umaResolutionStatus` among them, are recorded and not interpreted | V2 adds `resolutionStatus` (F-54), which this door would record, not interpret. Whether V2 markets keep the four state fields is U-36 | `ROLLOVER-1`, `WP-070` (door); `ROLLOVER-1`, `WP-120` (gateway) | A (Verify: U-36) |
| A15 | `tools/bench/host/recorder_core.py:18-22`, `:233-243` | The host-bench recorder requires `clobTokenIds` and drops any window without it | Records nothing for a V2 window with `clobTokenIds: null` | No work-plan entry covers `tools/bench/host/**` (`HOST-BENCH-PREP` commits `0340727`, `4c27e0f`; `HOST-BENCH` lists `tools/host-bench/**`) | **A, Breaks** (bench tooling) |
| A16 | `apps/research-worker/src/research-tier/identity.ts:79-80` (`TOKEN_KEYS`); `apps/backtest-cli/src/approximate/translate.ts:446-533` (token to configured market); `python/research/compaction/manifest.py:175` (`polymarket_token_ids`) | Read ids from recorded frames and configuration as opaque decimal strings | V2 ids are decimal strings of 75 digits (F-44), which these readers already accept (INF). Prove with a V2 fixture | `STORAGE-1`, `APPROX-REPLAY-1`, `WP-130` | A, Dependent |
| A17 | `packages/domain/src/identifiers.ts:58-62` (`TokenIdSchema`: canonical unsigned integer, at most `MAX_IDENTIFIER_LENGTH`); `packages/domain/src/events/series-admission.ts:80-81`; `db/migrations/0002_catalog` (`catalog.market_tokens.token_id`) | Decimal ids | V2 position ids fit (F-44). **No change in a protected path is needed for PAPER** | `WP-020`, `WP-040` (protected) | A, None |

### 3.B Data API v1 retirement

| # | `file:line` | What it does today | What changes | Owner | Class |
| --- | --- | --- | --- | --- | --- |
| B1 | The whole repository | No tracked code calls a Data API v1 route. `git grep -n -E "['\"\`]/(positions\|closed-positions\|trades\|activity\|value\|traded\|holders\|oi\|live-volume)(\?\|['\"\`/])" -- ':!docs' ':!**/*.test.ts'` returns nothing at `ab5033a`. The only Data API route tags in code are `/v2/positions` and `/v2/approvals` (C1, C2). The v1 literals in tests are refusal cases (`apps/ops-cli/src/emergency/run.snapshot.test.ts:55`; `test/fault-injection/reconciliation/obligations.test.ts:635`) | Nothing breaks on 2026-10-24 (F-33). Re-run the grep on 2026-10-23 | the orchestrator (`V3-E15-DATA-API-V1-SUNSET`) | B, None |

### 3.C Signing, approvals, balances, positions, account reads, cancel paths (pre-live)

| # | `file:line` | What it does today | What V2 changes | Owner | Class |
| --- | --- | --- | --- | --- | --- |
| C1 | `packages/oms/src/reconciliation/ports.ts:31-38`, `:136-141`; `packages/oms/src/reconciliation/door.ts:683-724` | The read surface names `/v2/positions` and `/v2/approvals`. The wire adapter is owed by the composition round | The adapter meets the `data` envelope, cursor pagination and `snake_case` (F-65, F-66). Sizes are JSON doubles, and holdings under 0.1 shares are hidden by default (F-77; U-47). Whether `token_id` carries the position id for V2 holdings is U-45 | `WP-290`; the composition round | C |
| C2 | `apps/ops-cli/src/emergency/venue-truth.ts:31-33`, `:149-190`; `commands/account-snapshot.ts:9`; `commands/reconcile.ts:141` | Reads `/v2/positions` and `/v2/approvals` only | The same adapter duties as C1 | `WP-330` | C |
| C3 | `packages/polymarket-secure/package.json:18` (`"@polymarket/client": "0.11.0"`) | The SDK is pinned exactly | "Upgrade … (0.12.0 or later)" (F-37). 0.11.0 lacks `CONDITIONAL-V2` (F-53), and its position operations select by which ids are present (F-74). The upgrade changes `pnpm-lock.yaml` (protected) | `WP-260` | C |
| C4 | `packages/polymarket-secure/src/sdk-port.ts:17-29` (a `Pick` of 10 members) | A breaking SDK type change fails `typecheck` by design | No export was removed in 0.12.0 (§S.2). None of the 10 members returns account trade pages, whose `transactionHash` became optional (INF) | `WP-260` | C |
| C5 | `packages/polymarket-secure/src/venue-client.ts:415` (`createLimitOrder`; the SDK signs) | The SDK signs | V2: ExchangeV3, domain `"3"` (F-46). The SDK picks them from the id's reserved bits, not from Gamma `version` (F-47; U-46). Add a contract test that a V2 id is signed against ExchangeV3 and domain `"3"`, through `polymarket-secure/testing` | `WP-260` | C |
| C6 | `packages/polymarket-secure/src/venue-client.ts:57`, `:156` (`ASSET_ID` admits `0x…` hex); `signed-order.ts:69` (`TOKEN_ID` too); `user-stream/wire.ts:46-47` | A V2 id may be hex | U-13 is resolved: a V2 id is a **decimal string** (S-D02 lines 27, 34; S-D11 line 126). Drop the hex branch, or keep it only as a refusal | `WP-260`, `WP-280` | C |
| C7 | `packages/polymarket-secure/src/venue-client.ts:158` (`CONDITION_ID` is 64 hex, for `cancelMarketOrders`); `apps/ops-cli/src/emergency/grammar.ts:52`; versus `user-stream/wire.ts:45` (62 or 64) | Market-wide cancel refuses a 62-hex id | Market-wide cancel uses the condition id (F-60), and its width is undocumented (U-41). Until it is: refuse V2 market-wide cancel and keep per-order cancel by id | `WP-260`, `WP-330`, `WP-280` | C |
| C8 | `packages/polymarket-secure/src/user-stream/manager.ts:341-355` (`readMarkets`: condition ids); `normalize.ts:306`, `:326`, `:353` (`asset_id`) | Subscribes the user channel by condition id | Unchanged (F-60, F-61). The width is U-41 | `WP-280` | C (Verify: U-41) |
| C9 | `packages/inventory/src/venue-facts.ts:44-56` (`VenueContractRole`), `:76-121` (`DOCUMENTED_VENUE_CONTRACTS`), `:131-138` (`APPROVAL_SPENDER_ROLES`) | CTF, CTF Exchange, Neg Risk Exchange, adapters, ramps. An approval to any other spender is refused | Add ExchangeV3, PositionManager, Router and AutoRedeemer (F-71); "Existing CTF permissions do not grant these approvals" (F-49) | `WP-300` | C |
| C10 | `packages/inventory/src/approvals.ts:6-7`, `:121-122` (`assetType: "CONDITIONAL"`), `:148-157`; `venue-facts.ts:151-163` | The CLOB allowance sync models `COLLATERAL` and `CONDITIONAL`; ERC-1155 approval implicitly on CTF | `CONDITIONAL-V2` for V2 positions; ERC-1155 operator approval on **PositionManager** (F-49, F-51). Do not validate against the OpenAPI enum (C-22) | `WP-300` | C |
| C11 | `packages/inventory/src/wallet-operation-manager.ts:552-570`, `:588-590`, `:1585-1700` | CTF `splitPosition`, `mergePositions`, `redeemPositions` with index sets | Router `split`, `merge(bytes31, amount)`, `redeem(bytes31, outcomeIndex, amount)`, one outcome per call; approvals to the Router (F-49, F-73) | `WP-300` | C |
| C12 | `packages/inventory/src/assets.ts:97-131`; `wallet-operation-manager.ts:21-23` | The outcome-pair registry does not record the ledger | "Use PositionManager for V2 balances and transfers" (F-73). `getPayout`: "Unresolved positions can revert; zero is a valid losing payout" | `WP-300` | C |
| C13 | `packages/inventory/src/order-reservations.ts:8`, `:41-42` (`additionalCollateral`, default `"0"`) | A BUY holds price × size plus optional headroom | "Cover collateral spend, including fees"; "BUY fees add to collateral spend" (F-49, F-63) | `WP-300` | C |
| C14 | `packages/oms/src/order-manager.ts:52-60` (the expected order hash is STOPPED) | No hash is computed | A future expected hash depends on the domain: `"3"` and ExchangeV3 for V2, `"2"` for CTF (F-46) | `WP-270` | C |
| C15 | `packages/polymarket-secure/src/heartbeat/**` (ADR-033 D1-D4, D6) | A controller behind a port, with no transport | §8. Not changed by V2; U-40 asks whether heartbeats cover ExchangeV3 orders | `WP-320` | C |
| C16 | `apps/ops-cli/package.json` (the only app that depends on `@polymarket-bot/polymarket-secure`); `test/unit/tooling/app-bundles-load.test.ts` | The ops-cli bundle includes the SDK | The 0.12.0 tarball is 39 845 bytes larger (§S.1). ADR-018: rebuild and re-run the bundle-load test | `WP-330`, `WP-015` | C |

### 3.D Research, backtest, fixtures, documentation, registers

| # | `file:line` | What it does today | What V2 changes | Owner | Class |
| --- | --- | --- | --- | --- | --- |
| D1 | `packages/simulation/src/fill-model.ts:259-358`, `tier1.ts:316-370`, `venue.ts:1617-1630`; `packages/strategies/static-bracket/src/params.ts:139` (FAK, FOK allowed) | Fills in exact decimals; every order type is targeted in **shares** | `floor(makerAssetFill × takerAmount / makerAmount)` in base units; "FOK/FAK BUY targets are collateral" (F-63). INF: up to one micro-unit per maker fill, and more shares on a collateral-targeted FAK BUY with price improvement | `STORAGE-1`, `WP-210` (`packages/simulation/**`) | D (fidelity; before `WP-360`) |
| D2 | `packages/simulation/src/fees.ts:16-21`, `:200-240`; `packages/ledger/src/fill-posting.ts:357-366` | fee = C × rate × p(1−p), a separate collateral debit | Consistent with "BUY fees add to collateral spend; SELL fees are deducted from proceeds" (F-63). The V2 fee formula is U-43 | `WP-210`, `WP-200` | D |
| D3 | `test/contract/polymarket-public/fixtures/series-window.json` (V1 only); `series-window.test.ts:74` | A V1 capture | Add V2 cases from `test/fixtures/venue/protocol-v2/` | `ROLLOVER-1`, `WP-070` | D (with A1-A4) |
| D4 | `packages/universe/src/testing/series-admission.ts:113`; `packages/universe/src/series-admission.test.ts:126-129` | The testkit builds `clobTokenIds` candidates only | V2 candidates: `positionIds` with `clobTokenIds` null, with both populated, and with `version` missing or unknown | `ROLLOVER-1`, `WP-110` | D (with A1) |
| D5 | `test/integration/data-gateway/rollover-1-series-admission.test.ts:98`, `:360`, `:537` | Reads `clobTokenIds` from fixture markets | Select by version | `ROLLOVER-1`, `WP-120` | D (with A1) |
| D6 | `test/contract/polymarket-public/fixtures/gamma-market-by-id.json:157`; `gamma-market-state.test.ts:296`, `:318-323` | Treats `version` as an undocumented extra key | `version` and `positionIds` are now documented (E-23); `resolutionStatus` is not (C-18). The fixture's notes are stale | `ROLLOVER-1`, `WP-070` | D |
| D7 | `test/fixtures/venue/positions/split-merge-redeem.json:16-90`; `test/contract/wallet-operations/split-merge-redeem-fixtures.test.ts:148`; `venue-citations.test.ts:68`, `:85` | CTF only | Add V2 Router and PositionManager cases (F-73) | `WP-000` (fixtures); `WP-300` (contract tests) | D |
| D8 | `test/fixtures/venue/market-ws/lifecycle.json`; `apps/ops-cli/src/verify-venue/checks.ts:960-1000` (strict `new_market` with `clob_token_ids`) | No V2 frames. The strict schema applies to fixtures only | Add V2 frames once observed (U-38); add the V2 `book` frame with `version` | `WP-000` (`apps/ops-cli/src/verify-venue/**`) | D |
| D9 | `apps/ops-cli/src/verify-venue/fixtures.test.ts:265-272` | Every `.json` under `test/fixtures/venue/` must be claimed by one check | It is why `protocol-v2/` uses `.jsonc` and `.jsonl` (report §15). Add a check that claims them, then rename them to `.json` | `WP-000` (`apps/ops-cli/src/verify-venue/**`) | D |
| D10 | `tools/bench/host/tests/fixtures/gamma-events.json:20-249`; `tests/test_record_markets.py:114-123`; `tests/test_recorder_core.py:67` | V1 shapes only | Add a V2 event (with A15) | no work-plan entry (A15) | D |
| D11 | `infra/compose/data-gateway/gateway.config.example.json:14-17`; `infra/compose/trader/trader.config.example.json:84-86` | Static `yesTokenId` and `noTokenId` | For a V2 market the operator supplies the `positionIds`. A note is enough | `WP-120`, `WP-230` | D |
| D12 | `docs/adr/ADR-030-series-auto-admission-and-multi-window-runs.md:62-65` (Decision 1.2) | "the outcome token ids" | A dated amendment (§5) | the governance round (`LEAN-GOV` owns `ADR-030-*`) | D (gates A) |
| D13 | `docs/adr/ADR-009-settlement-spec-and-payoff-model-selection.md:172` (U-11); `docs/contracts/protected-contracts.md:267`; `packages/settlement/README.md:80` | `umaResolutionStatus` as the opaque resolution field | V2: `resolutionStatus` (F-54) and Data API `status`, `reporter`, `payouts` (F-57, F-59) | `WP-030`, `WP-110` | D |
| D14 | `docs/settlement/btc-15m-updown-review.md:219-221` ("Gamma's `version` field is …"), `:704` (option O4) | Settlement-review evidence | Stale at the switchover. O4 should name `/v2/resolutions` (`reporter` `CHAINLINK`, F-59) | the `VENUE-SETL-1` line (no work-plan entry for `docs/settlement/**`) | D |
| D15 | `docs/runbooks/emergency.md:102-110` (says the wire lexeme of a V2 position id is undocumented, citing U-13); `apps/ops-cli/src/emergency/grammar.test.ts:233` (asserts the U-13 citation); `docs/runbooks/signer.md:18`, `:373` (the pin) | Documentation | U-13 is resolved (decimal). The pin moves with C3 | `WP-330`, `WP-260` | D |
| D16 | `packages/universe/src/series-admission.ts:31-49` (header venue table, F-01 `clobTokenIds`); `packages/polymarket-public/src/series-window/door.ts:12-28`; `packages/polymarket-public/src/market-state/door.ts:57-63` | Documentation in code | Update with A1-A3 | `ROLLOVER-1`, `WP-070` | D |
| D17 | `IMPLEMENTATION_STATUS.md` (`V3-E15-DATA-API-V1-SUNSET`; the "Venue drift carried forward" U-15 line) | Brief items | V3-E15: nothing calls v1 at `ab5033a` (B1). U-15: resolved (report §12) | the orchestrator | D |
| D18 | `packages/settlement/src/payout.ts:56`, `:73-86`, `:121-130` (`YES_WIN`, `NO_WIN`, `SPLIT_50_50` at `"0.5"` each); `packages/risk/src/worst-case.ts:14`, `:67-70` | Models win, lose and the 50/50 split only, from the 2026-08-28 resolution pages | New on S-D13 line 92 (F-73, E-22): "A binary market can resolve to a split payout instead of a full `$1` or `$0`, in which case each side redeems for its share". The page states no ratio, and this plan infers none. Whether a split other than 50/50 exists for our series is for the settlement review. Until then `V2-3` refuses every payout vector except `[1000000,0]` and `[0,1000000]`. The review is proposed under `V2-11` | `WP-110` (`packages/settlement/**`), `WP-180` (`packages/risk/**`) | D |

**Rows: A 17, B 1, C 16, D 18.**

## 4. Proposed migration packages

All are PAPER-only. Each is tested with the `protocol-v2/` fixtures, the
existing fixtures and fakes; none adds a credential, a signer or a live mode.
The order below meets the deadlines in §2. Where the SDK is recommended (§7),
the work lands on it; elsewhere it stays on the hand-written path, for the
reasons in §7.

**Order and dates (proposed):**

| Step | Package | Class | Start | Done by |
| --- | --- | --- | --- | --- |
| 1 | `V2-0` governance (ADR amendments) | D, gates A | now | 2026-10-09 |
| 2 | `V2-1` admission and identifiers; `V2-2` market-data path and readers (in parallel; disjoint paths) | A | after `V2-0` | 2026-10-20 |
| 3 | `V2-3` V2 resolution | A | after `V2-1` merges | 2026-10-28 |
| 4 | `V2-4` Data API v1 guard (optional; the grep is the minimum) | B | any time | 2026-10-23 |
| 5 | `VENUE-5` first-V2-window observation | D | the first V2 window of series 10192 | within a day of it |
| 6 | `V2-5` SDK 0.12.x; `V2-6` account reads on the SDK; `V2-7` inventory and wallet operations; `V2-8` cancel paths | C | after Wave 3, as authorized | before any mode above PAPER |
| 7 | `V2-9` venue fixture catalogue; `V2-10` simulation fidelity; `V2-11` documents and registers | D | alongside | `V2-10` before `WP-360` |

### V2-0: governance, before the class-A code

- **Goal:** the dated ADR amendments of §5, items 1-3. Also the SDK-scope ADR
  (§7.3), **only if the user overrules this plan's recommendation** for the
  public surfaces; and the approvals exception (§5 item 5), **only if** no
  stable SDK release reads `/v2/approvals` when `V2-6` starts. The
  orchestrator writes them; this plan only lists what each must decide.
- **Allowed paths:** `docs/adr/ADR-030-*.md`, `docs/adr/ADR-033-*.md`,
  `docs/adr/ADR-009-*.md`, `docs/adr/README.md`, and
  `docs/handoffs/V2-0.md`.
- **Depends on:** this report.
- **Acceptance:** each amendment cites the facts by id; nothing silently
  overrides the handoff; ADR-033 gains a dated note of the D5 facts (§8) and no
  ruling.
- **Gate:** review, by two verifiers (Opus and gpt-6-astra).

### V2-1: version-selected identifiers and admission (class A)

- **Goal:** A1-A8, with D3-D5 and D16.
- **Allowed paths:**
  - `packages/universe/**`;
  - `packages/trading-core/src/series.ts`, `packages/trading-core/src/config.ts`
    and their tests;
  - `packages/polymarket-public/src/series-window/**`;
  - `apps/data-gateway/src/feeds/series-admission.ts` and its test;
  - `test/contract/polymarket-public/series-window*`;
  - `test/integration/data-gateway/rollover-1-series-admission.test.ts`;
  - `docs/handoffs/V2-1.md`.
- **Depends on:** `V2-0` (ADR-030 Amendment 2).
- **Acceptance:**
  1. The judge selects `positionIds` for `"v2"` and the decoded `clobTokenIds`
     for `"v1"`, "even when both fields are present".
  2. It refuses, by name, each of these: a missing, null or unknown
     `version`; a selected field absent or null ("not yet available",
     F-40); not exactly two ids; a non-decimal id; equal ids; and outcomes not
     matching the reviewed labels.
  3. Every refusal fails closed and raises the existing incident.
  4. The reviewed series carries `acceptedProtocolVersions`. A window whose
     version is not accepted is refused, so the series config hash changes
     only on review.
  5. The CLOB read sends the condition id right-padded to 32 bytes when it is
     31 bytes; a 32-byte id is sent unchanged. Gamma's form remains the
     window's identity (A4, A7; F-43; C-19).
  6. The `t[]` pairing passes on `protocol-v2/clob-markets-v2.jsonc` for a V2
     window built from the documented example.
  7. Every V1 fixture and test passes unchanged. The V1 admission output is
     byte-identical on `series-window.json`.
  8. CLOB `v` is read only as a labelled cross-check (C-21). If it is
     present and disagrees with Gamma `version`, the window is refused. An
     absent `v` alone does not refuse, because the plan relies on no
     undocumented field (§6). Tests cover all three cases: present and
     equal, present and different, and absent.
- **Gate:** review, by two verifiers. **Deadline:** 2026-10-20.

### V2-2: the market-data path and recorded-data readers (class A)

- **Goal:** A9-A12, A14, A15 and A16, mostly as proofs on V2 fixtures, plus
  the host-bench recorder fix.
- **Allowed paths:**
  - `packages/polymarket-public/src/{venue,normalize,snapshot,feed,market-state}/**`;
  - `test/contract/polymarket-public/market-ws-fixtures.test.ts`,
    `test/contract/polymarket-public/gamma-market-state.test.ts` and
    `test/contract/polymarket-public/fixtures/gamma-market-by-id.json` (D6);
  - `tools/bench/host/**`, which needs an explicit grant (A15);
  - test-only files under `apps/research-worker/**` and `apps/backtest-cli/**`;
  - `docs/handoffs/V2-2.md`.
- **Depends on:** none; it may run beside `V2-1`.
- **Acceptance:**
  1. The V2 REST book and the V2 `book` frame, with `"version":"v2"`, decode
     and normalize to the same internal events as their V1 shapes.
  2. The recorder journals the frames verbatim (`ws-market-v2-session.jsonl`).
  3. The market-state door records a `resolutionStatus` scalar and does not
     interpret it.
  4. The host-bench recorder selects ids by `version` (with A1's refusals).
  5. The research and backtest readers accept a 75-digit V2 id.
  6. No V1 behaviour changes.
- **Gate:** automated, with a single verifier. **Deadline:** 2026-10-20.

### V2-3: resolution of V2 windows (class A)

- **Goal:** A13. A V2 window must not hold its cap slot forever because a
  `market_resolved` frame never matches.
- **Allowed paths:**
  - a new `packages/polymarket-public/src/resolution/**` (a door for
    `GET /v2/resolutions`);
  - a new `apps/data-gateway/src/feeds/resolution-check.ts`, with wiring in
    `apps/data-gateway/src/gateway.ts`, `apps/data-gateway/src/config.ts`
    and `apps/data-gateway/src/feeds/series-admission.ts` (after `V2-1`
    merges);
  - `test/integration/data-gateway/v2-resolution*.test.ts`;
  - `docs/handoffs/V2-3.md`.
- **Depends on:** `V2-0` (ADR-030 Amendment 2, item 4; ADR-009 if a Data API
  row may settle) and `V2-1`.
- **Acceptance:**
  1. For an admitted window past its scheduled close without a published
     resolution, the gateway polls `GET /v2/resolutions?condition=<32-byte
     form>` (F-57, F-70). This is a public, condition-keyed read within the
     §9.13 budget.
  2. It **journals the raw body before deriving** (ADR-030 Decision 3.1).
  3. A row with `status` `"resolved"` and `payouts` `[1000000,0]` or
     `[0,1000000]` is mapped to YES or NO by index (F-40: index 0 is YES).
     The door reads the raw wire tuple, in integer micro-USDC per share
     (F-57). The SDK's normalized form is collateral units, `["1","0"]`
     (F-78), and never reaches this door; a test proves that a
     collateral-unit tuple is refused, not read a millionfold low.
  4. Any other row, or a disagreement with a `market_resolved` frame, raises
     the existing unresolved-window incident and publishes nothing.
  5. Whether a mapped row may itself publish `MarketResolved`, or may only
     alarm, is what the ADR rules. The package implements that ruling.
  6. This is tested on `data-v2-resolutions-*.jsonc` and fakes.
- **Gate:** review, by two verifiers. **Deadline:** 2026-10-28.
- **If it slips:** the fail-closed path already exists. The window is held
  and the operator retires it by name (`config.ts:393-404`).

### V2-4: Data API v1 guard (class B, optional)

- **Goal:** keep B1 true after 2026-10-24.
- **Allowed paths:** `test/unit/tooling/**` and `docs/handoffs/V2-4.md`.
- **Acceptance:** a tooling test fails when a non-test source file names a
  Data API v1 route literal (B1's pattern, plus `/v1/market-positions`,
  `/v1/leaderboard`, `/v1/builders/*`, `/v1/activity/combos` and
  `/v1/positions/combos`), and passes at `HEAD`. `/v1/accounting/snapshot` is
  allowed (F-33).
- **Gate:** automated. **Deadline:** 2026-10-23. The minimum alternative is the
  orchestrator's grep.

### V2-5: SDK 0.12.x (class C; the `WP-260` line)

- **Goal:** C3-C6, C16.
- **Allowed paths:**
  - `packages/polymarket-secure/**` and `test/contract/polymarket-secure/**`;
  - `docs/runbooks/signer.md`;
  - `pnpm-lock.yaml`, which is protected and needs a grant;
  - `docs/handoffs/V2-5.md`.
- **Depends on:** Wave 3 complete, or an explicit authorization.
- **Acceptance:**
  1. A fresh pin check, in the five-step form of `verified-2026-09-30.md`
     §W.1: the version, its npm integrity and its provenance commit.
  2. A lockfile-only add, whose diff touches only `@polymarket/client` and
     `@polymarket/bindings`. If pnpm moves `zod`, that is an ADR-020 §7
     contract change and needs its own note.
  3. `typecheck` passes with the unchanged 10-member port.
  4. Contract tests, through `polymarket-secure/testing`:
     - a V2-shaped id signs against ExchangeV3 with domain `"3"`, and a V1 id
       against the CTF Exchange with `"2"` (F-47);
     - a V2 SELL uses `CONDITIONAL-V2` (F-53);
     - `place*` is never called. The source-hygiene test already refuses SDK
       imports elsewhere.
  5. These hidden behaviours are pinned by tests:
     - `ky` retries a `DELETE` (cancel) twice on a network error and never
       retries a `POST`;
     - the attempt timeout is 10 s;
     - `createLimitOrder` caches market metadata for 10 minutes
       (`actions/orders/cache.ts` lines 16-17).
  6. The `ASSET_ID` hex branch is removed (C6).
  7. The ops-cli bundle builds and loads (`app-bundles-load.test.ts`).
- **Gate:** security review, by two verifiers.

### V2-6: Data API account reads on the SDK (class C; the `WP-290` and `WP-330` lines)

- **Goal:** C1 and C2, the `readPositions` and `readApprovals` halves of
  `AccountReadPort`, on the SDK inside `packages/polymarket-secure` (§7.1
  S4). Account trades are not in it: `listTrades` stays on CLOB
  `/data/trades` (S4(a)).
- **Allowed paths:**
  - a new `packages/polymarket-secure/src/account-reads/**`, the adapter,
    which satisfies the `oms` port structurally;
  - `test/fault-injection/reconciliation/port-conformance.test.ts` (the
    `WP-290` line), extended to prove at compile time that the adapter
    satisfies those two `AccountReadPort` methods;
  - `packages/oms/src/reconciliation/ports.ts`, for **port shapes only**, and
    only if a shape must change. `packages/oms` is layer 1 and "may not
    import `packages/polymarket-secure`" (`ports.ts:21-23`); a composition
    root binds its ports (`:7`). No wiring goes into `packages/oms`;
  - `apps/ops-cli/src/emergency/**`, the one binding site in the repository:
    its `EmergencyVenueFactory` turns a credential into the reads
    (`apps/ops-cli/src/emergency/ports.ts:32-38`). "No live binding exists in
    this repository: the live composition binds them after ADR-033 D5 and the
    live-micro gate" (`:37-38`), and `V2-6` adds none;
  - their tests, and `docs/handoffs/V2-6.md`.
- **Depends on:**
  - `V2-5`;
  - **for the approvals half,** a stable SDK release whose public API reads
    `/v2/approvals`. Today only the canary's `fetchTradingApprovalsState`
    does, and it returns only the approvals missing from the SDK's own
    catalog. In 0.11.0 and 0.12.0 the method of that name reads on chain at
    the environment's RPC, by default `https://polygon.drpc.org` (report §S.2),
    so it must never stand behind the `/v2/approvals` tag.
  - **No hand-written `GET /v2/approvals` inside `polymarket-secure`.** Handoff
    §9.12 says "Wrap only the official unified SDK", and ADR-033 D5 calls a
    request the secure package sends itself "a reviewed, named exception to
    'wrap only the SDK'". `polymarket-secure/src` has no such request today.
    If the release is not out when `V2-6` starts, the approvals half waits,
    or `V2-0` writes the ADR of §5 item 5 and `V2-6` depends on it.
- **Acceptance:**
  1. `/v2/positions` is walked to `next_cursor: null`, with the filters
     re-sent on every page (F-66).
  2. **Numbers, under the policy of §7.1 S4.** A size is accepted only in the
     domain D: a canonical non-negative decimal with at most 6 fractional
     digits and at most 15 significant digits. Anything else is a malformed
     read, never an empty one. Tests, through fake `fetch` bodies:
     - every value of D round-trips unchanged through the SDK path (a full
       range plus a seeded random sample, as in the report's F-78 probe);
     - the lexemes `1e3` and `1E3` are accepted as `"1000"`. They denote the
       same double, and the exponent form cannot be seen after the SDK parse;
     - `0.123456789012345678`, `0.1234567`, `1e-7`, `1e21`,
       `12345678901234567`, `123456789012.123456` and `5.263157894736842` are
       each refused, whatever string the SDK makes of them;
     - a CLOSED-arm "~0 residual" outside D is refused, not rounded to zero
       (F-77).
  3. Condition ids are padded to 32 bytes before any call.
  4. A row whose `token_id` is neither the version-selected id nor a known V1
     id is refused (U-45).
  5. **The dust floor** (F-77). The read sends `filterType: "TOKENS"` and
     `filterAmount: 0`. Until U-47 shows that the venue honours 0, the
     adapter states that holdings under 0.1 shares may be missing from the
     read.
  6. The SDK's hidden 429 retries are counted against the §9.13 read budget.
  7. The SDK's `listTrades` (Data API `/v2/trades`) is never bound to
     `AccountReadPort.listTrades` (S4(a)).
  8. Every test uses fakes behind the tripwire. No live call is made.
- **Gate:** automated, with security review for the binding.

### V2-7: inventory and wallet operations (class C; the `WP-300` line)

- **Goal:** C9-C13, D7.
- **Allowed paths:** `packages/inventory/**`, `test/unit/inventory/**`,
  `test/contract/wallet-operations/**` and `docs/handoffs/V2-7.md`. The V2
  position-operation fixtures go in with `V2-9`.
- **Depends on:** `V2-5`.
- **Acceptance:**
  1. The contract roles and spenders gain ExchangeV3, PositionManager, Router
     and AutoRedeemer, at the proxy addresses (F-71).
  2. A BUY approves pUSD → ExchangeV3, fee headroom included; a SELL sets the
     PositionManager operator → ExchangeV3; split approves pUSD → Router;
     merge and redeem set the PositionManager operator → Router (F-49).
  3. The `CONDITIONAL-V2` sync is modelled (F-51).
  4. V2 plans use `bytes31` with the final-byte check, `outcomeIndex` 0 or 1,
     one redeem call per outcome, and six-decimal amounts (F-73).
  5. V1 plans are unchanged.
- **Gate:** automated.

### V2-8: cancel paths and the user stream (class C; the `WP-260`, `WP-280` and `WP-330` lines)

- **Goal:** C7, C8, D15.
- **Allowed paths:**
  - `packages/polymarket-secure/src/{venue-client.ts,user-stream/**}`;
  - `apps/ops-cli/src/emergency/**` and `docs/runbooks/emergency.md`;
  - their tests, and `docs/handoffs/V2-8.md`.
- **Depends on:** `V2-5`. U-41 is settled by documentation, or by a reviewed
  observation in a mode that permits it.
- **Acceptance:**
  1. Until U-41 is settled, a V2 market-wide cancel is refused with a named
     reason, and per-order cancel by id remains.
  2. Once U-41 is settled, the documented width is sent.
  3. The emergency grammar accepts decimal asset ids only.
  4. The runbook's U-13 text is corrected.
- **Gate:** security review.

### V2-9: the venue fixture catalogue (class D; the `WP-000` line)

- **Goal:** D8 and D9, and the V2 half of D7.
- **Allowed paths:** `apps/ops-cli/src/verify-venue/**`,
  `test/fixtures/venue/**` and `docs/handoffs/V2-9.md`.
- **Acceptance:**
  1. A check claims `protocol-v2/`, and its files are renamed to `.json`
     with their sidecars, leaving the fixtures' bytes and digests unchanged.
  2. A V2 `book` frame and V2 Router fixtures are added.
  3. The heartbeat fixture's notes cite C-20.
  4. **The parent fixture rules.** `test/fixtures/venue/README.md`
     ("Sanitization rules") allows only documentation-example or synthetic
     identifiers, and documentation-example or small round monetary values.
     `protocol-v2/` keeps live public identifiers and observed prices (report
     §15). Either the parent README gains a dated, scoped exception for
     sanitized live public captures, or the values are replaced.
  5. In any trade or activity fixture, the check refuses a cursor that
     decodes to a feed seek anchor, and a wallet, name or hash that is not a
     labelled synthetic value. It also refuses a sidecar whose redactions do
     not list `timestamp` and `next_cursor` (report §15).
- **Gate:** automated.

### V2-10: simulation fill fidelity (class D; the `STORAGE-1` and `WP-210` line)

- **Goal:** D1. Integer base units with the floor per maker fill;
  collateral-targeted FOK and FAK BUYs.
- **Allowed paths:** `packages/simulation/**`, `test/unit/simulation/**` and
  `docs/handoffs/V2-10.md`.
- **Depends on:** none. It must land before `WP-360` calibration.
- **Acceptance:**
  1. A golden test on the documented formula (F-63).
  2. Replay goldens change only with a recorded reason (`test:replay`).
- **Gate:** automated.

### V2-11: documents and registers (class D)

- **Goal:** D13, D14, D15, D17 and D18 (the settlement review records the
  documented binary split payout without inferring a ratio). Also the
  register rows: C-18…C-23 and U-35…U-47, with U-13, U-15, U-22 and U-33
  resolved.
- **Allowed paths:** `docs/contracts/protected-contracts.md`,
  `docs/settlement/**`, `docs/runbooks/**`, `IMPLEMENTATION_STATUS.md` and
  `docs/handoffs/V2-11.md`.
- **Gate:** review.

### `VENUE-5`: the first V2 window of our series (an observation round)

- **Goal:** settle U-36, U-37, U-38, U-39 and U-43 on our own series.
- **What it records:**
  - the Gamma JSON of a V2 window: `conditionId` width, `clobTokenIds`, `resolutionStatus`;
  - its `/clob-markets` record;
  - the market channel through that window's resolution, `market_resolved`
    included;
  - its `/v2/resolutions` row.

  It refreshes the `protocol-v2/` fixtures, and the class-A packages are
  re-checked against it.
- **Allowed paths:** `docs/venue/**`, `test/fixtures/venue/**` and its
  handoff.
- **Gate:** review, by two verifiers. **When:** within a day of the first V2
  window being listed (U-37).

## 5. ADR amendments and venue-pinned contract tests

**Dated amendments needed:**

1. **ADR-030** (Amendment 2). It must decide five things:
   - **identifiers:** the per-window id is selected by Gamma `version`;
     missing and unknown versions are refused (Decision 1.2, which today names
     "the outcome token ids");
   - **review:** accepted protocol versions become a reviewed series parameter;
   - **condition width:** Gamma's condition id stays the identity, and the
     CLOB and Data API get the 32-byte form;
   - **journaling:** a new journaled public read, `/v2/resolutions` (Decision
     3.1);
   - **resolution:** what happens when the market channel's resolution does
     not arrive or does not match (Decision 4). It may alarm only, or it may
     publish from the Data API row.
2. **ADR-009**, only if (1) lets a Data API row settle. The row's `payouts`
   are micro-USDC per share (F-57). The settlement spec's evidence source then
   changes, and so does the U-11 note.
3. **ADR-033.** A dated note of D5's venue facts (§8): H-1 to H-3, C-20 and
   U-40. The documented route of the 10 s cancellation is `/v1/heartbeats`
   (H-3), so D2's provisional contract (the `/v1/heartbeats` shapes) stands.
   If the ruling picks `POST /heartbeats`, which carries no id, D1, D2 and D6
   change: D6 defines "Confirmed" as "a success response that carries the
   next id".
4. Only if the user overrules §7's recommendation: a new ADR amending handoff
   §9.12 and F6 (§7.3).
5. Only if no stable SDK release reads `/v2/approvals` when `V2-6` starts:
   an ADR naming one unsigned, credential-free `GET /v2/approvals` inside
   `packages/polymarket-secure` as an exception to handoff §9.12's "Wrap only
   the official unified SDK". It must decide the exception's scope (that one
   route, read only), its transport rules (timeout, no retry beyond the §9.13
   budget, the response journaled or not), its exact-number handling (the
   route's `amount` is a string, F-77), and when it lapses (the first stable
   release that reads the route). ADR-033 D5 option 1 would be a second such
   exception, so the two should be decided together.

No change is needed to ADR-010 §4, ADR-004, ADR-020 or ADR-023 under this
plan's recommendation.

**Venue-pinned contract tests that must change:**
- `test/contract/polymarket-public/series-window.test.ts` with
  `fixtures/series-window.json` (`V2-1`);
- `test/contract/polymarket-public/gamma-market-state.test.ts` with
  `fixtures/gamma-market-by-id.json` (`V2-2`);
- `test/contract/polymarket-public/market-ws-fixtures.test.ts` (`V2-2`);
- `test/contract/wallet-operations/split-merge-redeem-fixtures.test.ts` and
  `venue-citations.test.ts` (`V2-7`);
- `test/contract/polymarket-secure/**` and
  `packages/polymarket-secure/src/testing/sdk-contract.ts`, whose header names
  `0.11.0` (`V2-5`);
- `apps/ops-cli/src/verify-venue/fixtures.test.ts` and `checks.ts` (`V2-9`);
- `apps/ops-cli/src/emergency/grammar.test.ts:233` (`V2-8`).

## 6. What this plan does not do

- It does not edit any code, ADR, the handoff, or an earlier venue report.
- It proposes no credential, signer, wallet, live mode or hand-written signing.
  The one signing question, D5's transport, is left to the user (§8).
- It does not rely on the switchover date (C-23) or on any undocumented field
  as an authority.

## 7. Unified SDK adoption

The user asked the migration to adopt `@polymarket/client`. The official
migration guide (S-D06 lines 15-17) says: "The SDK also covers the Gamma API and Data API.
Migrating direct Gamma and Data calls can simplify application code and give
you normalized, typed models". The page offers this as a benefit; no fetched
page makes it mandatory.

**Two constraints in this repository bear on it:**
1. Handoff §9.12: "The rest of the codebase must not import
   `@polymarket/client` directly". F6 (`docs/contracts/dependency-direction.md:652`)
   grants the SDK to `packages/polymarket-secure` only, and `check:deps`
   enforces it (`tools/check-dependency-direction.mjs:402`).
2. Journal before derive:
   - "The gateway journals every raw venue response it admits from, before it
     derives anything" (ADR-030 Decision 3.1, line 93);
   - the WAL payload "is the frame **exactly as received**", with
     `PING`/`PONG` stored "verbatim like any other frame"
     (`docs/contracts/wal-format.md` §5.1, lines 173-180);
   - ADR-004 §4.1, line 120: the gateway "**enqueues the exact raw frame to
     the WAL writer before** publication".

Every SDK claim below is read in the published 0.12.0 package (report §S.4,
unless another fact id is given).

### 7.1 Per surface

**S1. Gamma market and event reads, including keyset discovery.**
- **What the SDK offers:**
  - `listEvents` → `GET /events/keyset`, with `series_id` and `after_cursor`
    (`actions/events.ts` lines 196-230, 540-545);
  - `fetchMarket` → `GET /markets/{id}`;
  - a normalized `Market` with `version` and per-outcome `tokenId` and
    `positionId`.
- **V2 ids and resolution status:**
  - **No V2 id selection.** Both ids are exposed, and the caller chooses
    (S-D03 lines 95-97; §S.3).
  - `resolutionStatus` is not modelled; it is stripped (F-55).
  - An unknown `version` fails the parse: `ProtocolVersionSchema` is a closed
    `z.enum` (bindings `gamma/market.ts` lines 86-91).
- **Raw bodies:** **no.** Normalized models only; the `ServiceClient` getters
  are `@internal`.
- **Control:**
  - a fixed 10 s attempt timeout;
  - GETs retried twice on a network error;
  - no `AbortSignal`;
  - no 429 retry on Gamma;
  - injection only through `globalThis.fetch`;
  - rate-limit headers not visible for Gamma.
- **Fields:** the normalized `Market` drops `eventStartTime`, `makerBaseFee`,
  `takerBaseFee`, `restricted`, `automaticallyResolved`,
  `acceptingOrdersTimestamp` and `umaResolutionStatuses`. The series door and
  the market-state door read several of these
  (`series-window/door.ts:12-28`; `market-state/door.ts:20-28`).
- **Cost (ADR-018):** about +0.81 MB unminified for the CJS gateway bundle
  (+42%) if `zod` is shared (INF from the measured numbers, §S.4). The SDK
  must also move into `packages/polymarket-public`'s dependencies.
- **Recommendation: keep hand-written.**
  - The door must journal the raw body before deriving, and must read values
    from the materialized raw tree (`docs/contracts/schema-boundary.md` §1,
    D3). The SDK model would be a second parse of the same bytes, and it lacks
    fields the door reads.
  - The class-A change here is small: read `version` and the `positionIds`
    array (A2, A3), and select in the judge (A1).
- **Optional, needing no F6 change:** the contract suite may cross-check
  `V2-1`'s selection against the SDK's normalized outcomes. It would run
  through `packages/polymarket-secure/src/testing/` (the existing
  `sdk-contract.ts` pattern), as a test-only oracle.

**S2. Public CLOB reads: `GET /book`, `POST /books`, `GET /clob-markets/{id}`,
prices.**
- **What the SDK offers:** `fetchOrderBook`, `fetchOrderBooks`, `fetchPrices`,
  and `fetchMarketInfo`. `fetchMarketInfo` is exported from
  `@polymarket/client/actions` only, not from the root.
- **V2:**
  - `assetId` takes either id, with no version logic;
  - the book schema is a `z.object` without `version`, so the field is
    stripped (bindings `clob/order-book.ts` lines 59-70);
  - **`MarketInfoSchema` keeps only `fd.{r,e}`, `mts`, `nr` and `t`**
    (bindings `clob/market-data.ts` lines 132-143). It **defaults** `fd` to
    `{rate: 0, exponent: 0}` and `negRisk` to `false` when they are absent.
    Our series door reads `mos`, `mbf`, `tbf`, `itode` and `fd.to`, and it
    defaults nothing.
- **Raw bodies:** **no.**
- **Control:** GETs retried twice on a network error, POSTs not; a 10 s
  timeout; `Poly-RateLimit-*` visible through `onRateLimitUpdate` on the CLOB
  client.
- **Cost:** as S1.
- **Recommendation: keep hand-written.** The snapshot path journals and derives
  from raw bytes. The judge needs fields the SDK drops, and the SDK's silent
  defaults contradict the door's "never defaulted" rule. The V2 change on this
  path is in the id and the condition width (A4, A10), not in the transport.

**S3. The public market WebSocket.**
- **What the SDK offers:** `client.subscribe([{ topic: 'market', assetIds,
  customFeatureEnabled }])`, an async iterator.
- **V2:** ids pass through. The `book` frame's `version` is stripped by the
  event schema. `market_resolved` reaches a subscriber only with
  `customFeatureEnabled` and a matching `assetIds` entry
  (`websockets/clob/protocol.ts` lines 203-208).
- **Raw frames:** **no.**
  - `PONG` is consumed and non-JSON is dropped (`websockets/lifecycle.ts`
    lines 218-228);
  - a frame that fails the schema is skipped (`websockets/clob/market.ts`
    lines 143-149);
  - DOC: "Streams drop unknown or unreadable WebSocket frames" (S-D08 line
    332).
- **Control:** it reconnects and resubscribes on its own
  (`websockets/clob/market.ts` lines 152-156), and nothing tells the consumer.
  Injection is only through `globalThis.WebSocket`.
- **Cost:** as S1.
- **Recommendation: keep hand-written.** Silent drops break the WAL's verbatim
  rule and ADR-004 §4.1. Hidden reconnects defeat ADR-023's delivery sessions:
  a frame cannot be stamped with the connection that delivered it. The V2
  change on this path is nil (F-60, F-62).

**S4. Data API v2.**
- **What the SDK offers:** `listPositions` (`/v2/positions`), `listTrades`
  (`/v2/trades`), `listActivity`, `fetchResolutions`, open interest, holders
  and price history.
  - The `{data, pagination}` envelope is unwrapped, and filters are re-sent on
    every page.
  - `/v2/approvals` is read only by the canary's `fetchTradingApprovalsState`.
    In 0.11.0 and 0.12.0 that method reads on chain through a third-party RPC
    instead (report §S.2-§S.3).
- **V2:**
  - condition ids are padded for positions, resolutions, open interest and
    holders, but not for trades and activity (§S.3);
  - resolution `status` and `reporter` are closed enums (bindings
    `data/resolutions.ts` lines 32, 58);
  - **`payouts` is a two-element tuple, converted in units.** On the wire it
    is two non-negative integers in micro-USDC per share, `[1000000,0]`
    (F-57, F-59). The SDK turns them into collateral-unit decimal strings,
    `["1","0"]` (F-78). A reader must know which form it holds: one is a
    million times the other.
- **Numbers.** The Data API types sizes and prices as JSON `number`,
  `format: double` (F-77). The SDK parses the body with `response.json()` and
  turns each number into `String(value)` (F-78). So the lexeme is gone before
  any adapter sees it: `1e3` arrives as `"1000"`, and `0.123456789012345678`
  as `"0.12345678901234568"`. Re-validating the string afterwards cannot
  refuse an exponent form or detect a lost digit. The plan therefore promises
  no lexeme check on this path. It states the numeric domain instead (`V2-6`
  acceptance 2):
  - **The domain D:** a canonical non-negative decimal with at most 6
    fractional digits and at most 15 significant digits. Six decimals is the
    venue's base unit: "`1_000_000` is one pUSD or one share" (F-73).
  - **Why it is exact (INF, checked by the F-78 probe).** A double keeps 15
    significant decimal digits, and ECMAScript prints a double in its shortest
    round-trip form. So each member of D is the SDK string of every lexeme
    that denotes its nearest double, and of nothing else. A double that is not
    the nearest double of a member of D prints outside D, and is refused. A
    string in D therefore cannot hide another value of D.
  - **What it gives up.** Two lexemes of one double (`1e3` and `1000`) cannot
    be told apart. Under the documented `double` type they are one value, so
    nothing documented is lost. A value finer than 10^-6, or longer than 15
    significant digits, is refused, never rounded. The CLOSED arm's "~0
    residual" (F-77) may be such a value; its exact form is undocumented.
  - **Prices are not read.** The port reads `tokenId` and `size` only
    (`packages/oms/src/reconciliation/ports.ts:136`). `avg_price` and the
    other ratios are never a money authority on this path.
  - **The alternative.** Exact lexemes need a boundary before
    `response.json()`: the raw-capture shim of §7.3 item 2, and that ADR. The
    plan does not recommend it for `V2-6`.
- **The dust floor.** `/v2/positions` omits holdings under 0.1 shares unless
  `filter_amount` lowers the floor, and whether `0` is honoured is U-47 (F-77,
  F-78).
- **Raw bodies:** **no.**
- **Control:**
  - Data API reads are wrapped in `withRateLimitRetry`: two retries, waiting
    `Retry-After` or 1 s, and giving up if asked to wait more than 5 s
    (`retry.ts` lines 37-63);
  - ky's network retries apply as well;
  - no rate-limit headers are visible for the Data API client.
- **Cost:** none inside `polymarket-secure`, which already depends on the SDK.
- **Recommendations:**
  - **(a) Account-truth Data API reads, positions and approvals,** for
    reconciliation and the emergency CLI: **adopt, inside
    `packages/polymarket-secure`**, behind the existing `AccountReadPort`
    (`V2-6`). The port is already "the secure adapter's authenticated reads"
    (`packages/oms/src/reconciliation/ports.ts:11`), and `apps/ops-cli`
    already depends on `polymarket-secure`. Conditions: the numeric domain
    above, padded condition ids, the hidden 429 retries counted in the budget,
    and the approvals half only on a stable release that reads
    `/v2/approvals` (`V2-6` "Depends on").
  - **Account trades are not a Data API read.** `AccountReadPort.listTrades`
    is `/data/trades`, returning `VenueTradeView`, which needs a trade id, a
    status and the account's own legs with order id and maker or taker role
    (`ports.ts:35`, `:100-122`, `:134-135`). The SDK's `listTrades` calls Data
    API `/v2/trades` (client `actions/activity.ts` lines 139-151), and its
    `Trade` has none of those fields (bindings `data/activity.ts` lines
    389-432). It must never back that port. The matching SDK method is
    `listAccountTrades`, an authenticated CLOB read of `/data/trades` (client
    `actions/account.ts` lines 337-347), whose `ClobTrade` carries `id`,
    `status`, `takerOrderId`, `traderSide` and `makerOrders`, with `price` and
    `size` as strings (F-78). It belongs with S5, and its adapter is owed by
    the composition round that binds `AccountReadPort` (C1).
  - **(b) The gateway's public `/v2/resolutions` read** (`V2-3`): **keep
    hand-written** in `packages/polymarket-public`. It derives resolution
    events, so its raw body must be journaled first, as in S1.

**S5. The authenticated surfaces already in `polymarket-secure`.**
- **What the SDK offers:** `createLimitOrder`, `postOrder(s)`, the cancels,
  `fetchOrder` and `account`, through a 10-member port
  (`packages/polymarket-secure/src/sdk-port.ts:17-29`). Account trades
  (`listAccountTrades`, `/data/trades`; S4(a)) would join that port when the
  composition round binds `AccountReadPort.listTrades`.
- **V2:** routing by the id's bits (F-47); `CONDITIONAL-V2` only from 0.12.0
  (F-53).
- **Raw bodies:** no.
- **Control:**
  - cancels are `DELETE`s (`actions/orders/cancel.ts` line 240), which ky
    retries twice on a network error;
  - `POST` is never retried;
  - a fixed 10 s timeout;
  - a 10-minute metadata cache inside `createLimitOrder`
    (`actions/orders/cache.ts` lines 16-17);
  - rate-limit headers visible and already wired (`sdk-port.ts:31-35`).
- **Cost:** already paid; the upgrade adds about 40 KB (§S.1).
- **Recommendation: keep on the SDK and upgrade to 0.12.x** (`V2-5`). Pin the
  hidden behaviours with tests. The port must keep excluding `place*`, which
  approves on chain by itself.

### 7.2 Summary

| Surface | Recommendation | The deciding reason |
| --- | --- | --- |
| S1 Gamma | Keep hand-written; the SDK may serve as a test-only oracle | No raw body to journal; fields the door reads are dropped; no V2 selection |
| S2 Public CLOB | Keep hand-written | No raw body; `clob-markets` fields dropped and silently defaulted |
| S3 Market WebSocket | Keep hand-written | Frames dropped silently and reconnects hidden: breaks the WAL and ADR-023 |
| S4a Account-truth Data API reads (positions, approvals) | **Adopt, inside `polymarket-secure`**, under the numeric domain; approvals only on a stable release that reads `/v2/approvals` | Envelope, cursor and `snake_case` handled; no §9.12 or F6 change while the reads stay on the SDK |
| Account trades (`/data/trades`) | On the SDK's `listAccountTrades` (S5), never the Data API `listTrades` | The Data API `Trade` has no trade id, status, order id or role |
| S4b Gateway `/v2/resolutions` | Keep hand-written | It derives events: journal before derive |
| S5 Authenticated | Keep on the SDK, upgrade to 0.12.x | `CONDITIONAL-V2` and version-selected position operations |

**"Adopt with a raw-capture shim" is possible but not recommended for
S1-S3** (INF):
- **The tee.** `ky` reads `globalThis.fetch` per request (ky 1.14.3,
  `core/Ky.js` line 154), and the SDK constructs the global `WebSocket`. A
  process-global tee could therefore capture raw bytes and enqueue them to the
  WAL before handing them to the SDK.
- **What it would not fix.** Doors would still re-read the raw tree (ADR-020
  D3), so the SDK adds a second parse and nothing more. The WebSocket's silent
  drops and hidden reconnects would remain, and so would ADR-023.
- **The deadline.** It would put a new ADR, a shim and a review cycle on the
  class-A path before 2026-10-30.

### 7.3 The governance a change of scope needs

The recommendation above needs **no** change to §9.12 or F6, provided every
read in `polymarket-secure` stays on the SDK. A hand-written approvals request
there would need the ADR of §5 item 5. If the user nonetheless wants
`packages/polymarket-public` or the gateway to use the SDK's `PublicClient`,
an ADR amending handoff §9.12, F6 and ADR-010 §4 must decide:

1. **Scope:** which packages may import which SDK entry points. For example,
   `PublicClient` only, with no signer, no `SecureClient` and no
   `createSecureClient`; whether `@polymarket/bindings` alone may be imported;
   and how `check:deps` encodes that.
2. **Raw capture:** the mechanism (a global `fetch` or `WebSocket` tee, a
   recording proxy through the experimental `forkEnvironmentConfig`, or
   nothing), and its ordering guarantee: the WAL enqueue completes before the
   SDK parses.
3. **Authority:** SDK models are never an authority; doors read the journaled
   raw tree (ADR-020 D1-D4).
4. **Frames the SDK drops:** how `PONG`, unknown types and schema failures
   reach the WAL and the partial-normalization report (ADR-023 D2.4).
5. **Sessions:** session stamping across the SDK's hidden reconnects (ADR-023
   D1), and bounded queues with no silent overflow (ADR-004 §4.2-§4.3).
6. **Transport policy:** acceptance of ky's GET retries, the 10 s timeout and
   the hidden Data API 429 retries under the §9.13 budgets.
7. **Cost and coupling:**
   - the gateway's bundle growth (ADR-018);
   - the `zod` coupling (ADR-020 §7: "A `zod` upgrade is a contract change");
   - a pin and upgrade policy for a 0.x SDK whose minor releases break things
     (S-D08 0.10.0: "Breaking change: …").
8. **Signer exclusion:** how a process that imports the SDK is kept from ever
   constructing a signer. The repository's network tripwire already relies on
   `globalThis.fetch` and `globalThis.WebSocket`
   (`packages/polymarket-secure/src/testing/network-tripwire.ts:9-10`).

### 7.4 The packages under this recommendation

- **Class A stays hand-written, so its deadline is unaffected:** `V2-1`,
  `V2-2` and `V2-3` change our doors and the judge, by 2026-10-28.
- **Class B needs no SDK work** (B1).
- **Class C lands on the SDK:**
  - `V2-5` upgrades it;
  - `V2-6` implements the positions and approvals reads on it, inside
    `polymarket-secure`, under the numeric domain of §7.1 S4; account trades
    stay on `/data/trades`;
  - `V2-7` and `V2-8` use the upgraded SDK's `CONDITIONAL-V2` and
    version-selected position operations, through the secure package's port.
- **If the user overrules §7.2 for S1-S3:** `V2-0` gains the §7.3 ADR. `V2-1`
  and `V2-2` then wait for it and add the raw-capture shim. **INF:** that puts
  the 2026-10-30 deadline at risk. The fallback is to ship class A
  hand-written first and migrate the transport afterwards.

## 8. ADR-033 D5 after this round

**The facts that bear on the ruling** (report §H):
- **H-1.** No release (0.11.0, 0.12.0 or the canary) has a public
  order-heartbeat method. The guide's TypeScript tab still reads "Content
  coming soon."
- **H-2.** `buildHmacSignature` is a public root export, and `SecureClient`'s
  own L2 headers are built with it. `credentials` and `account` are public
  getters. The authenticated transport, `secureClob`, is still `@internal`.
- **H-3.** The CLOB OpenAPI documents two routes:
  - `POST /v1/heartbeats`: the id chain; a `200` with `heartbeat_id`; a `400`
    keyed `error`;
  - `POST /heartbeats`: no body; a `200` with `{status: "ok"}`.

  The guide documents only the first, keys its `400` `error_msg`, and ties
  the 10 s cancellation to it: "If a valid heartbeat is not received within 10
  seconds, all open orders owned by those CLOB API credentials are canceled",
  then "Send an empty `heartbeat_id` to `POST /v1/heartbeats`" (S-D20 lines
  1486-1497). The OpenAPI puts "all open orders for the user will be
  automatically canceled" on both operations (S-O02 lines 4115, 4162).
  **So the documented route of the 10 s cancellation is `/v1/heartbeats`.**
  Still open: `/heartbeats`' timing and its relation to `/v1/heartbeats`
  (U-40), and the `400` key (C-20).
- **V2.** Nothing in Protocol V2 changes the heartbeat. Whether it protects
  ExchangeV3 orders is unstated (U-40; INF: yes, since it is per credential).

**The options, restated:**
1. **An L2-signed request inside `packages/polymarket-secure`, built from the
   SDK's primitives.**
   - **What changed:** its precondition now holds. The primitives are public
     (H-2), so it needs no hand-written signing. It is still the reviewed,
     named exception to "wrap only the SDK", because it sends its own HTTP
     request.
   - **The route is documented:** `/v1/heartbeats` carries the 10 s
     cancellation and the id (H-3), and it fits ADR-033 D1, D2 and D6 as
     written.
   - **Still open:** the `400` key, which must be read as either `error_msg`
     or `error` (C-20). Only a ruling that chose `/heartbeats` instead would
     meet its undocumented timing (U-40) and amend D6's "Confirmed".
2. **Wait for SDK support, and ask upstream.** **What changed:** nothing. 0.12.0
   and the canary have no method, and no official page announces one. Every
   live-signer mode stays blocked meanwhile.
3. **Call the `@internal` `secureClob`.** **What changed:** nothing. It is
   still `@internal` and can change without notice. Its `POST` is not retried.
4. **Go live without order heartbeats.** **What changed:** nothing. It still
   removes a heartbeat control, which §1.3 gates by ADR, and ADR-008 §3's
   fail-safe.

ADR-033's own recommendation reads: "option 1 if the SDK still has no method
and exports the primitives publicly; otherwise option 2". H-1 and H-2 are the
facts that sentence turns on. **This plan makes no ruling.**
