# Polymarket Protocol V2 and Data API v2 captures (`VENUE-4`, 2026-10-05)

Public, unauthenticated captures for the V2 migration packages proposed in
[`docs/venue/protocol-v2-migration-plan.md`](../../../../docs/venue/protocol-v2-migration-plan.md).
The facts they illustrate, and every source id cited below, are in
[`docs/venue/verified-2026-10-05.md`](../../../../docs/venue/verified-2026-10-05.md).

## Files

Each fixture `<name>.jsonc` or `<name>.jsonl` has a sidecar
`<name>.provenance.jsonc`. The sidecar gives the URL, the UTC fetch time, the
HTTP status, the byte count and sha256 of the raw response, the redactions
applied, and the fixture's own byte count and sha256. When no redaction is
listed, the fixture is the raw response, byte for byte, so its sha256 equals
`raw_sha256`.

- **`.jsonc` files are strict JSON** (RFC 8259): no comments, no trailing
  commas. Read them with `JSON.parse`.
- **`.jsonl`** holds one JSON record per line: `{t, dir, data}`, where `data` is
  the WebSocket frame text exactly as received (`PING` and `PONG` included).
- **Why not `.json`:** `apps/ops-cli/src/verify-venue/fixtures.test.ts` requires
  every `.json` file under `test/fixtures/venue/` to be claimed by exactly one
  `VENUE_CHECKS` entry. `VENUE-4` may not edit `apps/ops-cli/**`. Rename these
  files to `.json` when a package that owns `apps/ops-cli/src/verify-venue/**`
  adds a check that claims them, or excludes this directory.

## Index

| Fixture | Source id | Kind | What it shows |
| --- | --- | --- | --- |
| `gamma-market-v2-docs-example` | S-D16 lines 168-177 | documentation example | V2 Gamma market: `version` `"v2"`, `clobTokenIds` `null`, `positionIds` an array of decimal strings |
| `gamma-event-v2-docs-example` | S-D17 lines 271-289 | documentation example | V2 Gamma event; its `conditionId` is the 31-byte (62-hex) form |
| `gamma-market-v1-btc15m` | S-G04 | live | A `btc-15m-updown` window: `version` `"v1"`; `positionIds` absent |
| `gamma-events-keyset-series10192` | S-G05 | live | `GET /events/keyset?series_id=10192&closed=false&limit=2`, with `next_cursor` |
| `clob-markets-v2` | S-L01 | live | `GET /clob-markets/{64-hex}` for a V2 canary market: `t[].t` are V2 position ids; `"v":"v2"` |
| `clob-markets-v2-62hex-not-found` | S-L02 | live | The same condition in its 31-byte form: HTTP 404 |
| `clob-markets-v1` | S-L10 | live | The V1 window: `"v":"v1"` |
| `book-v2` | S-L03 | live | `GET /book?token_id=<V2 position id>`: 200, with an undocumented `"version":"v2"` |
| `book-v1` | S-L11 | live | The V1 book: no `version` key |
| `ws-market-v2-session` | S-W01 | live, trimmed | 60 s on the public market channel for one V2 position id |
| `data-v2-resolutions-v2-active` | S-L04 | live | `/v2/resolutions` for an open V2 market: `status` `active` |
| `data-v2-resolutions-v2-resolved` | S-A11 | live | A resolved V2 market: `reporter` `CHAINLINK`, `payouts` `[1000000,0]` |
| `data-v2-resolutions-v1-resolved` | S-A10 | live | A resolved V1 window |
| `data-v2-resolutions-62hex-invalid` | S-L05 | live | The 31-byte condition form: HTTP 400 `invalid_request` |
| `data-v2-prices-history-page1`, `-page2` | S-A02, S-A03 | live | Cursor pagination: page 2 fetched with page 1's `next_cursor` |
| `data-v2-trades-v1-page1`, `-page2` | S-A08, S-A09 | live, redacted | `/v2/trades?condition=…` with cursor pagination; personal data replaced |
| `data-v2-trades-v2-empty` | S-A07 | live | An empty page: `next_cursor` `null` |
| `data-v2-oi-v2` | S-A06 | live | A non-paginated `{data: […]}` envelope |

## Sanitization

- **No personal data.** The Data API trade rows carry wallet addresses,
  display names, pseudonyms, bios, profile images and transaction hashes. Each
  is replaced with a synthetic value labelled `synthetic-…` or an all-zero
  address or hash, and each row's `size` with a synthetic number. The
  sidecars list the replacements.
- **Contract addresses** and public market identifiers (condition ids,
  position and token ids, slugs) are kept.
- **Nothing here** came from an authenticated call, a wallet query or an order.
  No credential existed in the environment.
- **The raw responses** are kept outside the repository, in the round's scratch
  directory. Their digests are in the sidecars and in the report's source index.
