# VENUE-SETL-1: series-admission venue facts and the btc-15m-updown settlement-spec prep

**Status:** Complete (2026-10-04). Merged `c373e25` (PR #62; CI run `37250111292` green).
**Commissioned by:** the user, 2026-10-04 (`ROLLOVER-1` Q3, and the settlement-spec prep).
**Reviewers:** Claude Opus and Codex gpt-6-astra, run one after the other and reconciled. Joint ACCEPT at round 2 on `03c7126`.
**Base:** `7830a5c`. The branch merged `main` at `117729e` before the PR.
**Paths:** `docs/venue/verified-2026-10-04.md`, `docs/settlement/**`, and the two `btc-15m-updown` seed files (values only). Every read was public and unauthenticated.

## summary

1. **`ROLLOVER-1` Q3** (`docs/venue/verified-2026-10-04.md`):
   - **Outcome-to-token pairing: documented.** Gamma's market-details page pairs outcomes and token ids by index, with index 0 the YES ("Up") outcome. The SDK agrees.
     - Conflict C-17: markets-by-token labels its primary token "(Yes)", but returned Down on 2 of 4 windows. Never pair from it.
   - **Discovery.** `GET /events/keyset` is documented, with `series_id` (an integer array; the series is 10192). `series_slug` is undocumented. `closed=false` alone returns stale events, so a date bound is needed. `new_market`'s delivery scope is undocumented, and it carries no schedule.
   - **Window schedule.** On 33 of 33 windows, `eventStartTime` is the open and `endDate` the close, by observation only. `startDate` is not the open (U-29). The title's ET range is the authority. The repeated DST hour on 2026-11-01 is ambiguous (U-34).
   - **Trading delay.** `secondsDelay` is absent and `itode` is true. Its length conflicts between official pages: 250 ms against 150 ms (C-16). The tick size changes near the price limits, at undocumented thresholds.
2. **The settlement prep** (`docs/settlement/btc-15m-updown-review.md`, and the checklist):
   - **The rules text is pinned:** sha256 `485ceb1d…`, identical on 31 windows since 2026-08-07. An earlier spot-price version applied before that date.
   - **The recommended reading, R2.** The settlement value is the Chainlink BTC/USD 60-second TWAP at the close, compared GTE with the same stream at the open.
     - Documentation establishes the 60 s TWAP feed for both prices. That each is read at its boundary is an inference.
     - The public `eventMetadata` agrees: the price to beat equals the previous window's final price (12 of 12), and outcomes match (21 of 21).
     - The literal rules sentence conflicts (C-15). The clarification question for Polymarket is drafted in review §3.5.
   - **U-24 blocks a review.** Which stream report gives each boundary value is undocumented.
   - **The sign-off path, traced in code, with its gaps.** Nothing can record a review today, and the trader does not read one. In PAPER, the settlement veto lifts only through the config flag `markets[].settlementReadiness.modelDependentActivationAllowed`. G-2: rules versions are stored per market.
   - **The seed** now says TWAP, 60 s, GTE, with explicit boundary rules and the ET title range as the window. It stays `EXAMPLE_UNREVIEWED` and `UNVERIFIED`.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `c990069` | CHANGES REQUIRED | 12 findings. The three HIGHs: `startDate` was called the creation time (X1); the boundary was conflated with the stream report chosen for it (X2); an inference was presented as documented (X6) |
| 2 | `03c7126` | **ACCEPT** | none |

## tests_run
- `lint`, `check:deps`, `typecheck` and `test` (483 / 10990, including both seed suites) exit 0.
- **Package-door probe:** 8 of 8. It covers activation SPEC_UNVERIFIED, the GTE tie, the precision example, and the 60 s window bounds.
- **CI:** GitHub CI on the PR #62 merge ref was green before the merge.

## deviations
- **The optional fixtures are deferred.** The `apps/ops-cli` fixture test requires every venue fixture to be claimed by a check, and that is outside these paths.

## known_risks
- **If Polymarket means R1 or R3** (C-15), the seed semantics are wrong. The spec stays UNVERIFIED until the user rules.
- **Several values are dated observations** that can change without notice: the Gamma field meanings, `eventMetadata`, and the resolution latency (53–152 s, median 55 s).
- **On 2026-11-01**, `ROLLOVER-1` must not take a window's interval from its title alone.

## follow_up
1. **The user** signs the checklist, and decides D1 (send the clarification question) and D2.
2. **`ROLLOVER-1`** relaunches with Q1–Q4 and these facts: pairing by index, discovery through `/events/keyset`, the ET title as the window authority with the Gamma fields as observation, and `itode`.
3. **A recording round.** Make a review recordable, and have the trader read it (gaps G-1 to G-7). Store rules versions per series (G-2).
4. **The `WP-110` owner:** the seeds README §5 conflict.

## commit_sha
`03c7126`
