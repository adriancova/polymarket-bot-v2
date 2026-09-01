# Settlement-spec seeds — EXAMPLE / UNREVIEWED

Owner: `WP-110`
Consumers: `packages/universe` (series), `packages/settlement` (specs), and the
composition root that loads seeds into `catalog.series` /
`catalog.settlement_specs` (`db/migrations/0002_catalog.up.sql`).

---

## 1. What these files are, and what they are not

Every file in this directory is **example configuration**. None of it is a
reviewed settlement specification, and none of it may be treated as one.

- **No file carries `verified_by` or `verified_at`.** Every spec seed has
  `verification.status = "UNVERIFIED"`, which is the state that BLOCKS
  model-dependent strategy activation (handoff §9.2; work plan `WP-110`
  acceptance 3). A seed that claimed a human review nobody performed would be
  the single most dangerous file in this repository, so
  `packages/settlement/src/seeds.test.ts` fails the build if any seed contains a
  reviewer field or a `VERIFIED` status.
- **No series binding is approved.** `binding.approved` is `false` in every
  series seed. Handoff §9.2: "Series binding is configuration, not
  heuristic-only. The system may suggest a series match, but a new market
  pattern is not auto-approved for live trading."
- **The settlement semantics are illustrative, not venue-verified.** The
  resolution source, observation type, window, and comparison in the spec seeds
  describe how such a series *could* settle. Whether a given Polymarket series
  actually settles that way is a venue fact this repository has not verified,
  and a reviewer must establish it — from the market's own rules text — before
  any spec is marked verified.

## 2. Why a seed exists at all

`btc-15m-updown` is the series the first strategy is configured against
(handoff §13.2), so the shapes the catalog needs must exist before that strategy
can be wired. The seed exists to make the *shape* concrete and to give the
loader something to exercise — not to pre-approve a market.

## 3. Layout

| Path | Validated by | Loads into |
| --- | --- | --- |
| `series/*.series.json` | `packages/universe` (`SeriesDefinitionSchema`) | `catalog.series` |
| `specs/*.settlement-spec.json` | `packages/settlement` (`SettlementSpecSchema`) | `catalog.settlement_specs` |

Each file is an envelope:

```jsonc
{
  "seedFormatVersion": 1,
  "status": "EXAMPLE_UNREVIEWED",   // the only permitted value
  "notice": "…",                     // human-readable warning, kept in the data
  "series" | "settlementSpec": { … } // the payload the package schema validates
}
```

The identifiers are fixed UUIDv7 literals so that re-seeding is idempotent and
so a spec seed can name the series seed it belongs to. They are values, not
timestamps to be read.

## 4. Before a spec here can be verified

`packages/settlement`'s `settlementSpecReviewBlockers` lists the machine-checkable
preconditions; a human reviewer owns the rest. As written, every spec seed is
blocked by at least:

1. **No `rulesVersionId`.** A review must name the market rules version it
   reviewed (§6 invariant 9). No market has been ingested for these series yet,
   so no rules version exists to name.
2. **The published-window check.** A spec that declares `windowSeconds` may be
   verified only against the windows the resolution feed actually publishes
   (ADR-009 §6; `docs/venue/verified-2026-08-24.md` §10.3 recorded 30 s and 60 s
   as of that date). The caller supplies the current list; nothing here hardcodes
   it as permanent truth.

## 5. Safety

These files contain no credential, key, address, endpoint, or account
identifier, and loading them enables nothing: an unverified spec blocks
activation by construction.
