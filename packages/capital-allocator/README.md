# `@polymarket-bot/capital-allocator`

Owner: `WP-180`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.7 (Capital
Allocator), §9.10 (reserve before submission), §9.14 (prevent double
reservation), §6 invariants 1/7/10, §11 (run modes)
Related: [`docs/handoffs/WP-180.md`](../../docs/handoffs/WP-180.md),
[ADR-011](../../docs/adr/ADR-011-one-live-owner-per-market-policy.md),
[ADR-016](../../docs/adr/ADR-016-ratified-inferred-domain-shapes.md)

Pure layer-1 logic. **No I/O, no clock, no network, no credential.** Every
monetary and size value is an exact decimal string (§6 invariant 1).

---

## 1. The central rule

§9.7: the allocator "tracks commitments from both positions and open orders".
Every exposure entry therefore carries the two components **separately**, plus
their exact sum:

```ts
{ openOrderCommitted, positionCommitted, combined }
```

and every cap compares against `combined`. **A limit fully consumed by open
orders blocks a new commitment even with zero positions, and vice versa** — the
work plan's acceptance criterion 1, probed at the reservation gate in
`src/allocator.test.ts` and at the intent gate in `test/unit/risk/`.

What counts as committed pUSD exposure:

| Item | Contributes |
| --- | --- |
| a position | its `costBasis` — capital already spent |
| an open **BUY** order | `price × shares` — capital contractually committed, because the order can fill at any moment |
| an applied live **BUY** reservation | its `cost` (§9.10: reserve before submission) |
| an open **SELL** order or SELL reservation | `"0"` — it reserves *outcome tokens*, tracked by the inventory accounting, not by the pUSD table |

## 2. State is a value

`createAllocatorState` validates and derives; transitions return **new deeply
frozen** states; nothing mutates. An in-place edit throws.

Boundary semantics a caller must wire correctly:

- `availableCollateral` is pUSD committed **nowhere** — the caller's number must
  already exclude funds held against the supplied open orders. This package
  derives `reservedCollateral` (§9.7's "reserved pUSD") from open BUY orders plus
  applied live BUY reservations.
- Positions and orders carry a **per-instance** attribution, and inventory
  checks are instance-scoped, so one strategy cannot spend another's tokens
  (§6 invariant 7).
- A state whose sell orders reserve more tokens than the owning instance holds
  is **refused at construction** (§9.14).

## 3. Caps

§9.7: "Initial defaults should reflect user-defined caps rather than hardcoded
historical examples." So:

| Cap | Default |
| --- | --- |
| `globalAccountCap` | **required**, no default |
| `perStrategyCap` | **required**, no default |
| `perMarketCap`, `perSeriesCap`, `perUnderlyingCap`, `perResolutionWindowCap` | optional, no default |
| `liveMicroMaxOrderNotional` | **`"0"`** |
| `liveMicroMaxAccountExposure` | **`"0"`** |

The two live-micro defaults mirror the untouchable repository safety defaults
(`AGENTS.md`: `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`,
`LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`). A zero default is a safety floor, not an
example, and **nothing in this package raises them implicitly**. With the
defaults in place, any positive-notional commitment in a real-order run mode
(`EXECUTION_PROBE`, `LIVE_MICRO`, `LIVE`) is refused.

A cap configured for a scope dimension the request cannot be attributed to
**fails closed** (`CAPITAL_SCOPE_KEY_MISSING`): an unattributable request cannot
be proven within the cap.

## 4. Reservations

- `evaluateReservation` answers "may this commitment be made" and changes
  nothing.
- `applyReservation` **re-evaluates against the state it is given** and returns a
  new frozen state, so a stale verdict cannot overspend.
- `releaseReservation` returns the capacity.

**V1 does not net opposing strategy intents** (§9.7). A LIVE commitment requires
the requesting instance to be the recorded live owner of the market (ADR-011);
a conflicting owner — or **no owner at all** — is a refusal, never a silent
claim. `SHADOW` commitments are accounted in the instance's own independent
shadow book and never touch live collateral, live inventory, or live caps; the
independence holds in both directions.

## 5. Reason codes — the PACKAGE-OWNED vocabulary

Stable `CodeString`-shaped identifiers, safe as metric labels (§14.3). Adding a
code is additive; changing the meaning of one is not.

| Code | Meaning |
| --- | --- |
| `CAPITAL_INPUT_INVALID` | Input failed its schema (shape, decimal grammar, id grammar). |
| `CAPITAL_UUID_NOT_CANONICAL` | A UUID-shaped id arrived non-lowercase. ADR-016 §2: refuse, never case-fold. |
| `CAPITAL_DUPLICATE_IDENTIFIER` | Two positions, orders, or reservations share an id. |
| `CAPITAL_UNKNOWN_RESERVATION` | The named reservation does not exist in this state. |
| `CAPITAL_OVERSELL_UNBACKED` | Open sell orders reserve more tokens than the instance holds (§9.14). |
| `CAPITAL_COLLATERAL_INSUFFICIENT` | A buy commitment exceeds available (unreserved) pUSD. |
| `CAPITAL_INVENTORY_INSUFFICIENT` | A sell reservation exceeds the instance's unreserved holdings (§6 invariant 10). |
| `CAPITAL_GLOBAL_CAP_EXCEEDED` | The global account cap. |
| `CAPITAL_STRATEGY_CAP_EXCEEDED` | The per-strategy cap. |
| `CAPITAL_MARKET_CAP_EXCEEDED` | The per-market cap. |
| `CAPITAL_SERIES_CAP_EXCEEDED` | The per-series cap. |
| `CAPITAL_UNDERLYING_CAP_EXCEEDED` | The per-underlying cap. |
| `CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED` | The per-resolution-window cap. |
| `CAPITAL_SCOPE_KEY_MISSING` | A scope cap is configured but the request carries no attribution for it (fail closed). |
| `CAPITAL_LIVE_OWNERSHIP_CONFLICT` | Another instance is the live owner of this market (ADR-011). |
| `CAPITAL_LIVE_OWNERSHIP_MISSING` | No live owner is recorded; a live commitment needs one. |
| `CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED` | A real-order-mode commitment above the live-micro per-order cap (default `"0"`). |
| `CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED` | A real-order-mode commitment above the live-micro account-exposure cap (default `"0"`). |

## 6. Known boundary

A pre-existing **position supplied without a scope attribution** does not appear
in the series / underlying / resolution-window exposure tables. That is a
caller-side data gap rather than a silent pass: the reservation gate still fails
closed on the **request** side (`CAPITAL_SCOPE_KEY_MISSING`) whenever a cap is
configured for a dimension the request cannot be attributed to, so a new
commitment cannot be admitted under an unmeasurable cap. Attributing historical
positions is the caller's responsibility.

## 7. Dependency boundary

Declares exactly `@polymarket-bot/decimal` and `@polymarket-bot/domain` (both
layer 0) plus `zod`. It imports **no** layer-1 peer — including
`@polymarket-bot/risk`, which consumes this package's snapshot and verdict
**structurally** rather than through an edge, because
`docs/contracts/dependency-direction.md` §2.1 lists no same-layer edge between
them (F13). `test/unit/risk/ports.test.ts` pins that port.
