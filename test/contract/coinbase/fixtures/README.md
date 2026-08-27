# Coinbase contract fixtures (WP-090)

Every file here is one frame the adapter is expected to see, wrapped in a
provenance record. The rules are not stylistic; they are what keeps the suite
from asserting invented venue behaviour.

## Rules

1. **A fixture derives from official Coinbase documentation or it is labelled.**
   `provenance.kind` is one of:

   - `DOCUMENTED_EXAMPLE` — the frame is the documented example, byte for byte
     apart from JSON whitespace. `provenance.modifications` MUST be empty.
   - `SYNTHETIC_COMPLETION` — the frame was built from a documented example to
     exercise a path the documentation shows no example for.
     `provenance.basedOn` names the fixture it was derived from and
     `provenance.modifications` lists every change, in words. A synthetic
     fixture may only change values inside shapes the documentation defines; it
     may not invent a field, a channel, or a message type and present it as
     real.

2. **Every fixture carries a URL and an access date.** Venue facts are volatile
   (handoff §1.2); a fixture with no date cannot be re-verified.

3. **`expectation` states what the adapter must do with it**, so a reviewer can
   see the intent without reading the test that consumes it.

4. **Nothing here came from the wire.** A read-only observation of the public
   feed was used during implementation to settle two facts (frames are UTF-8
   JSON text; `sequence_num` is per-connection) — both recorded in
   `packages/coinbase-adapter/src/venue-facts.ts` as observations, not as
   documentation — but no observed bytes were copied into a fixture.

5. **The suite is offline.** Nothing in `test/contract/coinbase` opens a socket
   or makes an HTTP request. The adapter's socket, clock, and timer are ports,
   and the tests inject fakes.

## Sources

| Short name | URL | Accessed |
| --- | --- | --- |
| channels page | <https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels> | 2026-08-27 |
| overview | <https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview> | 2026-08-27 |
| endpoints | <https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints> | 2026-08-27 |
| AsyncAPI | <https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json> | 2026-08-27 |

## A note on `sequence_num`

Every documented example prints `"sequence_num": 0`, because each is shown in
isolation. A scenario needs increasing values, so any fixture with a non-zero
`sequence_num` is `SYNTHETIC_COMPLETION` and says so in its modification list.
That is the single most common modification in this directory and it is never
silent.
