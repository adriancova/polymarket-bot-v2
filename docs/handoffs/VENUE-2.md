# VENUE-2 — phase-2 venue gate (GOV-2B blocker G-01)

Work package `VENUE-2`, authorized 2026-09-15 (`IMPLEMENTATION_STATUS.md`,
commit `f8c5065`). Branch `venue-2`, base `f8c5065`, worktree
`polymarket-bot-venue-2`. Implementer: the project `venue-verifier` agent.
The first run was killed by an API session limit before any fetch was saved;
this record is from the resumed run, which started from a clean worktree and
an empty scratch directory. **All fetches are dated 2026-09-16 UTC**; the
report file carries the packet's name `verified-2026-09-15.md` (see
`deviations` 1).

## summary

- Wrote `docs/venue/verified-2026-09-15.md`: the **full** handoff-§1.2
  twelve-item re-verification for phase 2, in the frozen report's structure
  and numbering, plus the two pages `verified-2026-09-02.md` §7 queued (the
  resolution page and the market-by-id surface) and the two gaps
  `verified-2026-09-03.md` §5 queued (liquidity-rewards denomination; the
  deposited-USDC→pUSD funding path). It contains an explicit sentence
  discharging `verified-2026-09-02.md` §7 item 3, a per-item verdict for all
  twelve items (UNCHANGED / DRIFT / UNVERIFIED), a §11 conflicts table
  (C-1…C-4 re-examined, C-5…C-8 new), a §12 UNVERIFIED list with reasons
  (U-2…U-12 carried, U-13…U-17 new), a §13 safety attestation, and a §14
  source index with UTC timestamp, HTTP status, byte count and SHA-256 for
  every one of the 62 fetches (36 documentation pages/indexes, 26 SDK
  fetches — commit lookup, file tree, 15 files at the new commit, 9 at the
  frozen commit) plus a no-follow status probe of
  the 24 rendered URLs the frozen report and handoff §24 cite.
- Sources: current official documentation at `docs.polymarket.com` (served
  `.md` form) and the official `Polymarket/ts-sdk` at the **named commit
  `983a10a7579c95043d4099f60873ff7ea817e5a0`** (`main`, 2026-09-14), diffed
  file-by-file against the frozen commit `7fdbed42484b5d279c71aa36d3757d18968260da`.
- Verdicts: 4 items UNCHANGED (order types/expiration; heartbeat; geoblock;
  RTDS), 8 items DRIFT with 29 numbered drift rows
  (D-01…D-29), each quoting the frozen and current texts, the source, and the
  concrete repository consequence. No item is wholly UNVERIFIED; the
  documentary-only limits are stated per item.
- **No fixture payload changed**: no drift alters a wire shape a fixture
  encodes; the `apps/ops-cli` validator's pins (`effective_date` enum,
  report path, SDK permalink prefix, missing specs) prevent freezing any new
  phase-2 snapshot without an `apps/**` change, which this round may not
  make — recorded as findings (report §15). `test/fixtures/venue/README.md`
  gains a dated re-verification section (append-only) with per-fixture
  verdicts and two dated caveat corrections.
- The frozen report `verified-2026-08-24.md` is untouched. No `packages/**`,
  `apps/**`, config, env, ADR, register, spec or `IMPLEMENTATION_STATUS.md`
  edit.

## files_changed

- `docs/venue/verified-2026-09-15.md` — new (the report).
- `test/fixtures/venue/README.md` — appended section "Re-verification
  2026-09-15 (VENUE-2, the phase-2 venue gate)"; frozen text above it
  unchanged.
- `docs/handoffs/VENUE-2.md` — new (this record).

No other path. `git status --short` at hand-back shows only these three,
committed.

## tests_run

Run in the worktree at tip (after all edits), all green:

- `pnpm test:contract` — 583 / 65 / 158 / 95 passed (four suites; baseline at
  `f8c5065` was 583 / 65 / 158 / 95 — unchanged, as expected for a round that
  changes no fixture payload).
- `pnpm --filter @polymarket-bot/ops-cli test` — exit 0 but a **no-op**: the
  package declares no `test` script. Ran instead:
  `npx vitest run --config test/vitest.config.ts apps/ops-cli/src/verify-venue`
  — 2 files, **375 passed** (`fixtures.test.ts` 305, `canonical-grammar.test.ts`
  70); and `pnpm ops:verify-venue` (offline, fixtures + frozen report) —
  exit 0, every check `PASS` or `DOCUMENTED`.
- `pnpm run test` — **326 files / 7129 tests passed** (baseline 326 files / 7129 tests).
- `pnpm run lint` — exit 0.
- `pnpm run typecheck` — exit 0.

Verification commands that produced the evidence (all read-only,
unauthenticated; bodies kept only under
`/home/adriancova/.claude/jobs/c16cbccf/tmp/venue-2/`, not committed):
`curl -sS -L --max-time 60 -o <body> -w '%{http_code}\t%{size_download}\t%{num_redirects}\t%{url_effective}\t%{content_type}' <url>`
with `date -u` before each call and `sha256sum` after; `curl -sS -o
/dev/null -w '%{http_code}\t%{redirect_url}'` (no `-L`) for the rendered-URL
probes; `diff -u` between the frozen-commit and new-commit SDK bodies; a
Python check that every fixture `market` is a 66-character hex string
(D-08).

## assumptions

1. Handoff §1.1 precedence: current official documentation and **current
   official SDK behaviour at a named commit** control venue facts. Where a
   docs page and the SDK disagree (C-3, C-5, D-20) the SDK's reading is the
   one recorded as controlling, and the docs' reading is recorded verbatim
   beside it.
2. The `.md` served-source form of a docs page is the page (the convention of
   the 2026-09-02 and 2026-09-03 re-issues). Rendered URLs were probed for
   status only.
3. `api.github.com` and `raw.githubusercontent.com` are the official
   repository's own hosting and count as "official SDK repository" sources;
   the npm registry does not, and was not queried (U-7).
4. "Every difference from the frozen baseline is DRIFT" is read to include
   consequence-bearing additions (a new documented parameter or mode), not
   only contradictions; purely descriptive additions with no repository
   consequence are listed in-section without a D-row.
5. Fixture envelopes keep `retrieved: "2026-08-24"` because their payloads
   were not re-captured; a `retrieved` bump without a payload change would
   misstate capture provenance. The dated README section carries the
   re-verification date instead.

## deviations

1. **Dates.** The packet names the deliverable `verified-2026-09-15.md` and
   the round was authorized 2026-09-15, but the resumed run performed every
   fetch on **2026-09-16** (17:18:29–17:31:29 UTC). The report says so in its
   header and every source row carries its own timestamp; the file name
   follows the packet. If the orchestrator prefers the file named by fetch
   date, it is a rename plus the `IMPLEMENTATION_STATUS.md` row (not this
   round's path).
2. **No fixture payload was updated**, although the packet anticipated
   fixture updates "where drift changes a wire shape". None did. The
   contract suites therefore prove the *unchanged* claim rather than a
   changed one. Where a documented shape could have been frozen (per-market
   `feeSchedule`, batch post-only responses, negative cancel balance, the
   exchange addresses, closed-only mode, `itode`), the `apps/ops-cli`
   validator has either no spec or a pinned `effective_date`, so it was
   reported as a finding (report §15) per the packet's instruction.
3. **Additional pages** beyond the frozen §14 list were fetched
   (site indexes for discovery; the SDK changelog; the TypeScript-SDK
   getting-started page; the user AsyncAPI page; the order-lifecycle,
   contracts, pUSD, bridge deposit/withdraw/supported-assets, send-heartbeat
   and API-overview pages; 15 SDK source files at the new commit and 9 at the
   frozen commit). Each is in §14 with its digest; the extras were needed to
   answer queued questions (Q3/Q4), to pin the SDK commit, and to diff rather
   than recollect.
4. The C-4 re-check that the register schedules for the phase-3 gate was
   performed now as part of the full round (still not reproduced); the
   phase-3 obligation is left standing.

## known_risks

1. **C-2 reopen condition is met (D-15)** and this round could not act on it
   (`docs/adr/**`, `docs/contracts/**` forbidden). Until the ADR-006/register
   owner records the documented USDC.e↔pUSD wrap/unwrap mechanism, the
   register row's "no venue assertion of equivalence or conversion" premise
   is stale. The operative rulings (distinct asset ids; explicit recorded
   conversions; per-source denomination) are unaffected either way.
2. **Per-market `feeSchedule` with an `exponent` (D-13, U-17).** The
   simulation fee model (`packages/simulation/src/fees.ts:16-19`) is the
   `exponent = 1` special case of what the venue now publishes per market.
   Any market with `exponent ≠ 1` is mis-priced by the current model. No
   fetched page writes out the general formula, so this cannot be fixed
   without inventing behaviour.
3. **Minimum-order-size unit conflict (C-7 / D-17).** Two official pages give
   opposite units (shares vs USDC notional). `static-bracket`'s
   `decide.ts:771` compares shares. If the venue's real rule is notional, a
   small-price entry could be refused or accepted wrongly. Needs venue
   evidence, not a preference.
4. **SDK has moved five minor versions with breaking changes (D-02).** Every
   SDK-derived statement in the frozen report was re-checked and the raw wire
   schemas the fixtures freeze are compatible (only `market` tightened to a
   hex condition id, which all fixtures already satisfy). But `WP-260` pins
   against a materially different client than the one the phase-0 report
   read.
5. **Protocol V2 is documented only in SDK source and its changelog (U-15).**
   The repository's `TokenId` narrowing (ADR-016) survives every documented
   example, but no page documents the wire lexeme of a V2 position id
   (U-13).
6. **The validator does not read this report.** `pnpm ops:verify-venue`
   validates section presence in `verified-2026-08-24.md` only (report §15
   item 2); the phase-2 report is evidence for humans and reviewers, not for
   the offline gate, until `apps/ops-cli` is changed.
7. **Documentary-only throughout.** Heartbeat enforcement, per-signer live
   enforcement (U-14), server `PING` timeouts (U-2) and maximum
   subscription size (U-3) remain unobserved; the safe posture (treat as
   enforced; detect staleness client-side) stands.
8. **Two label conflicts (C-8) and a symbol collision (D-15 caution ii)**
   could mislead a future reconciler that trusts names over addresses.

## follow_up

1. **Orchestrator / register owner** — dated amendments for C-2 (D-15) and
   U-11 (D-20) in `protected-contracts.md` §8 and ADR-006 / ADR-009; decide
   whether to name the report by fetch date (deviation 1); update handoff
   §24's three redirecting links (D-07, D-11, D-25) or annotate them.
2. **Adversarial review (required before merge)** — re-fetch a sample of §14
   and check every D-row against both quoted texts; the digests and line
   numbers in the report are there to be re-derived.
3. **`apps/ops-cli` owner (`WP-330` or an earlier authorized packet)** —
   report §15 items 1–4: admit dated snapshots, validate every dated report,
   add specs for `feeSchedule` / batch responses / closed-only / `itode`,
   and rename `level-removed-absolute-zero-UNVERIFIED` with its test.
4. **`packages/simulation` (ADR-012) and fee/reward accounting** — model the
   per-market `feeSchedule` (D-13) once the general-exponent formula is
   documented; keep `roundingMode` caller-declared (U-16).
5. **`packages/strategies/static-bracket`, `packages/universe`** — resolve
   the min-order-size unit (C-7) with venue evidence.
6. **`WP-260`** — pin `@polymarket/client` on the 0.10.x line with a fresh
   check; read the five changelog entries; use the SDK's
   `TradingRestriction` (D-23); accept both REST status spellings (C-5).
7. **`WP-270` / `WP-310` / `WP-320`** — model `unmatched` as accepted-not-
   filled (C-6), the un-cancellable delay window (D-18), negative cancel
   balances (D-21), the ≤15-order batch (D-05), closed-only mode (D-24)
   alongside geoblock close-only.
8. **`WP-280` / `WP-290`** — C-3 with its widened evidence; REST trade reads
   must accept both status spellings and the docs' optional fields (C-5).
9. **`WP-300`** — take the CTF Exchange / Neg Risk CTF Exchange addresses
   from report D-26 with source; read `market.version` before choosing a
   split/merge/redeem path (D-27, U-15).
10. **Phase-3 start gate** — a new full twelve-item report; this one does not
    pre-pay it.

## DRIFT table (all rows; the reviewer re-fetches against these)

| Row | Item | Frozen text (2026-08-24) | Current text (2026-09-16) | Consequence | Owner |
| --- | --- | --- | --- | --- | --- |
| D-01 | §1 SDK commit | reference commit `7fdbed42…` (2026-08-24) | `main` = `983a10a7579c95043d4099f60873ff7ea817e5a0` (2026-09-14) | fixtures/validator stay pinned to `7fdbed4…` by `checks.ts:72-76`; every SDK change diffed | `apps/ops-cli` owner (pin); this report (record) |
| D-02 | §1 SDK release line | version pinning deferred to WP-260; U-7 "npm version not observable" | `packages/client` `0.6.0` → `0.10.0`; changelog 0.7.0–0.10.0 each "Breaking change" | WP-260 pins against 0.10.x and reads the changelog | WP-260 |
| D-03 | §2.1 `side` on the wire | "`side` 0/1" (struct encoding, presented as the body) | typed data `side: 0`; JSON body `"side": "BUY"`, `salt` as JSON number ≤ MAX_SAFE_INTEGER; SDK `post.ts:163-164` | no request fixture exists; WP-260 uses the SDK | WP-260 |
| D-04 | §2.1 precision table | "tick 0.01 → 2 dp; 0.001 → 3 dp; 0.0001 → 4 dp; size 2 dp" | six rows incl. `0.005`, `0.0025`, plus Amount-decimals column and 3-step rounding; SDK `resolveRoundingConfig` same six at both commits | no hard-coded table in repo (`packages/decimal/src/tick.ts:80-96`, `packages/universe/src/parameters.ts:85`) | none (informational) |
| D-05 | §2 batch / fees | batch size only as token cost | `POST /orders` "1 and 15" orders; "builder taker fees are charged on top" | WP-270/WP-310 batch sizing; builder fees not modelled | WP-270, WP-310 |
| D-06 | §2.2 `unmatched` | "marketable but failed to delay; placement still succeeded" | same on place-orders; order-lifecycle: "placed on the book after the delay expired without a match" | C-6; OMS treats as accepted-not-filled | WP-270 |
| D-07 | §3 citation URL | `market-data/websocket/market-channel` | HTTP 308 → `market-data/realtime-data#market-stream` | fixture `source` fields still resolve; README notes it | none / handoff owner |
| D-08 | §4 raw `market` type | `market: z.string()` | `market: ConditionIdSchema` (hex, 64 or 66 chars) on all events but `new_market` | all fixture `market` values are 66-char hex; domain `ConditionIdSchema` looser than SDK | none |
| D-09 | §4 raw `asset_id` type | `asset_id: TokenIdSchema` | `asset_id: ClobAssetIdSchema` ("CTF token IDs or Polymarket V2 position IDs"); still `z.string()` | domain `TokenIdSchema` (`identifiers.ts:58-62`) is a narrowing; U-13 | packages/domain (ADR-016) when evidence appears |
| D-10 | §4 normalized fields | `tokenId`, `market` | `assetId`, `conditionId` added; old names `@deprecated` | raw wire unchanged; SDK-model consumers use new names | WP-260+ |
| D-11 | §4 citation URL | `market-data/websocket/user-channel` | HTTP 308 → `trading/realtime-order-updates`; new AsyncAPI `api-reference/wss/user` | fixtures unaffected; handoff §24 link redirects | handoff owner |
| D-12 | §6 / C-2 liquidity rewards | "$1 pUSD minimum" on the liquidity-rewards page | "$1" with **no token** (0 `usd` matches); "This program has ended. The August allocation is no longer active." | ADR-006 §7 fail-closed rule continues; 09-03 §5 item 1 answered | fee/reward accounting |
| D-13 | §6/§7 per-market fees | category table only | `feesEnabled`, `feeSchedule { rate, exponent, takerOnly, rebateRate }` per market | `packages/simulation/src/fees.ts:16-19,100-111` is the exponent-1 case | packages/simulation (ADR-012), WP-200 successors |
| D-14 | §6 builder fees | platform taker fees only | "builder taker fees are charged on top" | not modelled (no builder code sent) | none unless attribution is added |
| D-15 | §11 C-2 funding path | "no page … states a conversion rate or mechanism" | pUSD page: ERC-20 wrapper, "backed by USDC", wrap/unwrap via CollateralOnramp/Offramp, asset "Must be USDC.e"; deposit page "USDC vs pUSD"; resolution page "receives the released USDC.e collateral, wraps it into pUSD" | **C-2 reopen condition met**; distinct ids remain mandatory; three naming cautions | register / ADR-006 owner |
| D-16 | §7 tick sizes | "0.1 down to 0.0001, with special 0.0025" | closed six-row table incl. `0.005`; SDK `TickSizeValueSchema` same six at both commits | no code site; SDK union is closed (volatility note) | WP-260 |
| D-17 | §7 min order size unit | unit unstated | market-details "minimum USDC notional"; place-orders "minimum number of shares" | C-7; `static-bracket/src/decide.ts:771` compares shares | static-bracket, universe |
| D-18 | §7 delays | `secondsDelay` only | 250 ms taker delay on selected crypto/finance markets, `itode: true` on `GET /clob-markets/{condition_id}`; "During either delay, the order is pending and cannot be canceled" | OMS/cancel path must expect a `not_canceled` inside the window | WP-270, WP-310 |
| D-19 | §7.1 Gamma SDK schema | `marketMakerAddress: z.string()` required; AMM fields | removed (`0.9.0`); added `version` (`v1`/`v2`), `comboStatus` | parse loosened; `version` is the protocol discriminator | catalog work (WP-150/160), WP-260 |
| D-20 | U-11 `umaResolutionStatus` | register: "no documented value set … do not parse" | Gamma OpenAPI unchanged (nullable string); SDK closed enum `disputed/proposed/requested/resolved/settled` at both commits | register may re-scope by dated amendment; until then "do not parse" | register / ADR-009 owner |
| D-21 | §8 cancel buckets | "1 + one per order actually canceled" | "Negative Cancel Balance" Yes for Standard–Gold, No for Platinum–Elite; debt blocks future cancels | WP-310 scheduler; kill-switch after a large sweep | WP-310 |
| D-22 | §8 tiers | "30-day maker volume" | tier keyed to the **maker wallet** even if ≠ signer; "refresh every three hours" | read `Poly-RateLimit-Tier` from responses | WP-310 |
| D-23 | §9 SDK | no SDK statement | `RequestRejectedError.restriction` = RESTARTING (425) / POST_ONLY (503 + `post_only_mode`); cancel-only not classified | WP-260/WP-310 key on the typed restriction; cancel-only from `error` string | WP-260, WP-310 |
| D-24 | §9 modes | engine-level modes only | account-level **closed-only mode**, `GET /auth/ban-status/closed-only`, `fetchClosedOnlyMode()` | live gate treats like geoblock close-only; no reopen after rejection | WP-320, WP-310 |
| D-25 | §10.2 citation URL | `trading/ctf/overview` | HTTP 308 → `trading/positions/how-positions-work` | no fixture cites it; handoff §24 link redirects | handoff owner |
| D-26 | U-5 residual | exchange addresses "not on the retrieved page" | contracts page: CTF Exchange `0xE1111800…`, Neg Risk CTF Exchange `0xe2222d27…` (+ full contract tables) | resolved documentarily; not frozen (date pin) | WP-300 |
| D-27 | §10.2 protocols | CTF v1 split/merge/redeem via the two adapters | SDK routes Protocol V2 positions through Router/"Exchange V3"; V2 position id = module byte + 31-byte condition id + outcome byte; docs pages silent | U-15; WP-300/WP-260 read `market.version` | WP-260, WP-300 |
| D-28 | §16 credential names | catalog without relayer names | `POLYMARKET_RELAYER_API_KEY`, `POLYMARKET_RELAYER_API_KEY_ADDRESS`, headers `RELAYER_API_KEY`, `RELAYER_API_KEY_ADDRESS` | scanner already matches by `apikey` pattern; names only, no values | none |
| D-29 | resolution page | not covered by the frozen report | redemption "receives the released USDC.e collateral, wraps it into pUSD"; UmaCtfAdapter v1/v2/v3 address table | one of the D-15 sources; C-8 label conflict | settlement (informational) |

## UNVERIFIED list (with reasons)

| Id | Item | Reason it could not be verified |
| --- | --- | --- |
| U-2 | server `PING` timeout | not documented on any market/user page; SDK's 30 s is client-side; needs observation |
| U-3 | max `assets_ids` per subscription | no `maxItems` documented; needs observation or a venue statement |
| U-4 | exhaustive order error codes | only example causes documented |
| U-7 | published npm version | re-scoped: release line 0.10.0 per changelog + `package.json`; npm registry is not an official Polymarket domain and was not queried |
| U-9 | HTTP 425 body | only status + backoff documented; SDK keys on status alone |
| U-10 | cancellation/void payout | resolution page has three outcomes only; no refund path |
| U-11 | `umaResolutionStatus` vocabulary | docs: nullable string, no enum; SDK: closed 5-value enum — register decision needed (D-20) |
| U-12 | `MarketClosed` venue signal | lifecycle events are `new_market`/`market_resolved` only |
| U-13 (new) | wire lexeme of a Protocol V2 position id | SDK accepts any string, emits decimal; no documented V2 example |
| U-14 (new) | per-signer live enforcement started? | page still describes the 2026-07-24 warning-mode start; announcement or `429` observation needed |
| U-15 (new) | Protocol V2 / "Exchange V3" scope and settlement | documented only in SDK source and changelog; no docs page |
| U-16 (new) | fee rounding direction / tie rule | "rounded to 5 decimal places" only |
| U-17 (new) | `feeSchedule.exponent` semantics for `exponent ≠ 1` | one sentence and an `exponent: 1` example only |
| — | dispute transition event | process documented, no event |
| — | self-trade / same-signer matching | only a ToS policy sentence mentioning "self-matching"; no engine rule |
| — | bucket arbitration between callers | not documented |
| — | client order id on the CLOB request | none documented (Perps has one; out of scope) |
| — | base rate of restricted modes | not documented |
| — | heartbeat cadence in practice | documentary-only; would need an authenticated observation under an authorized packet |

## commit_sha

__COMMIT_SHA__ on branch `venue-2` (base `f8c5065`). Not merged, not pushed.
