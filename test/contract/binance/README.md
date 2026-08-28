# Binance reference-adapter contract suite (`WP-080`)

Owner: `packages/binance-adapter` (`@polymarket-bot/binance-adapter`).

Run it with:

```sh
pnpm --filter @polymarket-bot/binance-adapter test:contract
```

Type-check it with the package's own `typecheck` script, which includes this
tree:

```sh
pnpm --filter @polymarket-bot/binance-adapter typecheck
```

This tree is self-contained — its own `vitest.config.ts` and `tsconfig.json`,
resolved through path aliases — because `test/vitest.config.ts` and
`test/tsconfig.json` are `WP-010`-owned protected paths. It follows the pattern
`WP-040` (`test/integration/postgres`), `WP-050`
(`test/fault-injection/wal`) and `WP-060` (`test/integration/event-bus`)
established. Wiring it into a root script is orchestrator-owned at merge.

## The suite runs offline

Nothing here opens a socket or makes a request, and neither does anything it
exercises. Venue facts were verified against the official Binance documentation
at implementation time (2026-08-27) and are frozen into `fixtures/` with their
citations; the tests read those files from disk.

## Fixture provenance

`AGENTS.md`: "Report conflicts or missing information; never silently invent
venue behavior." Every fixture file and every frame inside it carries a
provenance label, and `all-fixtures-parse.test.ts` enforces the labelling:

| Label | Meaning |
| --- | --- |
| `OFFICIAL_EXAMPLE` | Copied field for field from a documented payload block. |
| `OFFICIAL_EXAMPLE_WITH_PLACEHOLDER_FILLED` | A documented example whose printf `%s` placeholders are not JSON values; the substitution is stated in the file's `notes`. |
| `SYNTHETIC_DERIVED` | A documented frame *shape* arranged into a sequence or a deviation the venue publishes no example of — a duplicate, a reconnect transcript, a malformed frame. Labelled so no reader mistakes it for evidence of what Binance sends. |

Sources, all accessed **2026-08-27**:

- `web-socket-streams.md` —
  <https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md>
- `sbe-market-data-streams.md` —
  <https://github.com/binance/binance-spot-api-docs/blob/master/sbe-market-data-streams.md>
- `rest-api.md` —
  <https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md>

## Files

| File | What it holds the implementation to |
| --- | --- |
| `all-fixtures-parse.test.ts` | Every fixture parses, is attributable, and decodes and classifies exactly as it claims. |
| `duplicates.test.ts` | Acceptance 1a: a duplicate is suppressed, classified, and counted; a same-id conflict opens an incident; a late trade is published and a stale quote is not. |
| `reconnect.test.ts` | Acceptance 1b: every reconnect emits `FeedConnected` beside an unwaived `FeedGapDetected`, advances the subscription generation, and never claims a `FeedResynchronized` it did not perform. |
| `malformed-and-unknown.test.ts` | Malformed and unknown input becomes a typed classification plus an incident with the raw frame preserved — never a silent drop. |
| `timestamps-and-envelope.test.ts` | Acceptance 2: venue and receipt timestamps both survive and stay distinct; each emission becomes a valid §7.1 envelope once the gateway adds its three fields. |
| `staleness.test.ts` | Staleness is queryable data against the caller's stamp, and crossing the caller's threshold emits `FeedStale` once per episode. |
| `no-configuration-access.test.ts` | Acceptance 3, checked mechanically over the package source: no environment read, no config import, no filesystem, no upward workspace edge, no credential surface. |
