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
| `data-v2-trades-v1-page1`, `-page2` | S-A08, S-A09 | live, redacted | `/v2/trades?condition=…` with cursor pagination; personal data, sizes, timestamps, hashes and cursors replaced |
| `data-v2-trades-v2-empty` | S-A07 | live | An empty page: `next_cursor` `null` |
| `data-v2-oi-v2` | S-A06 | live | A non-paginated `{data: […]}` envelope |

## Sanitization

- **No personal data.** The Data API trade rows carry wallet addresses,
  display names, pseudonyms, bios, profile images and transaction hashes. Each
  is replaced with a synthetic value labelled `synthetic-…` or an all-zero
  address or hash. Each row's `size` and block `timestamp` are replaced with
  synthetic numbers that keep the rows' order. The sidecars list every
  replacement.
- **The trade cursors are synthetic** (round 1). Both pages'
  `pagination.next_cursor` and the cursor in the page-2 sidecar's `url` read
  `synthetic-cursor-trades-p<page>-next`. A real feed cursor carries the seek
  anchor of the last row (S-O06), and a GET of the real page-2 URL returned
  the unredacted page byte for byte. So the committed URL no longer re-fetches
  it. The real URL is row S-A09 of the round's scratch fetch log.
- **What the redaction does not do.** These trades stay in Polymarket's own
  public feed, which anyone can read without credentials. The rows were the
  market's newest trades at the sidecar's `fetched_utc`, while its window was
  still open (OBS: the feed pages newest first). A walk of
  `/v2/trades?condition=<this market>` back to that time, matched on side,
  outcome and price, could find them again with their real wallets. The fixtures commit no personal data, and add
  nothing that the public feed does not already serve; they do not make the
  trades unfindable.
- **Contract addresses** and public market identifiers (condition ids,
  position and token ids, slugs) are kept, and so are observed prices and
  times outside the trade rows.
- **This departs from the parent tree's rules.**
  [`../README.md`](../README.md) "Sanitization rules" allows only identifiers
  "already published as examples in the official documentation, or synthetic
  values", and monetary values that are "the documentation's example values or
  small round numbers". These captures exist to pin live V2 shapes that the
  documentation does not show, so they keep live public identifiers and
  observed prices. `V2-9` (the migration plan) amends the parent README, or
  replaces these values, when it claims this directory.
- **Nothing here** came from an authenticated call, a wallet query or an order.
  No credential existed in the environment.
- **The raw responses** are kept outside the repository, in the round's scratch
  directory. Their digests are in the sidecars and in the report's source index.

## V2-9 (2026-10-06): under the gate, names kept

Added by `V2-9`; the text above is `VENUE-4`'s and is unchanged.

- **Claimed.** The `verify-venue` check `protocol-v2-captures`
  (`apps/ops-cli/src/verify-venue/checks.ts`, `PROTOCOL_V2_CAPTURES`;
  `captures.ts`) claims all 20 captures and their 20 sidecars. For each one it
  checks:
  - the sidecar's keys, and that the capture's bytes and sha256 match it;
  - that a capture with no redaction is the raw response, byte for byte;
  - the sidecar's fetch time, HTTP status, raw size and raw sha256, against the
    report's source index (§14);
  - strict JSON, or strict JSONL, with no key repeated in one object (round 1);
  - no credential, and no unlabelled personal data: in the capture, at any
    depth, and in the sidecar's text (`url`, `notes`, redactions,
    `extract.rule`); round 1 of V2-9 added the sidecar text, the email and
    user-name keys, person's rows and the S-O06 field list of a trade page;
  - the trade-feed rules of `../README.md` ("Exception 2026-10-06"),
    including every cursor parameter of the sidecar URL; round 2 added a
    cursor in any written form (an assignment, plain JSON, glued or
    re-encoded) and the documented type of every value on a trade URL;
    round 3 added the S-O06 type of every field of a trade page, market ids
    that the report alone corroborates, and labels glued to an address, a
    hash or a personal key; round 4 binds each sidecar URL to the route the
    report's source index records, in canonical form, and lets that report
    URL, not the sidecar's spelling, decide which captures are trade pages;
    round 5 fails closed on what the scanner cannot decode, parse or read
    (malformed percent-encoding, an unknown query parameter, a non-JSON
    frame text other than a control message), naming the reason;
  - the V2 facts each capture pins, with the report ids it cites.

  The gate now claims files of every suffix, so `.jsonc` and `.jsonl` no
  longer keep a file outside it. The "Why not `.json`" bullet above is
  historical.
- **No `.jsonc` held a comment.** Every file here parses with `JSON.parse`.
  So nothing moved into a sidecar, no payload byte changed, and every digest
  above still holds.
- **The rename to `.json` is deferred.** Readers outside V2-9's paths open
  these files by name, so renaming them needs a package that may edit those
  readers. They are in `apps/backtest-cli`, `apps/data-gateway`,
  `apps/research-worker`, `packages/polymarket-public`, `test/contract`,
  `test/integration/data-gateway` and `tools/bench/host`
  (`python/research` already accepts both suffixes). The session file stays
  `.jsonl` in any case: one record
  per line is not one JSON document, and wrapping it would change its bytes.
- **The departure from the parent rules** recorded under "Sanitization" is now
  the parent README's dated, scoped exception, "Exception 2026-10-06 (V2-9):
  sanitized live public captures".
