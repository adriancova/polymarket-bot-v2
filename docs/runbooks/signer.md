# Runbook: the signer boundary and the secure venue adapter

Owner: `WP-260` (`packages/polymarket-secure`). Status: **PAPER only**. The
package holds no key, loads no key and ships no real signer. Under the
repository defaults it cannot construct a secure venue client.

Authority: handoff §0.2, §9.12, §11, §15; [ADR-010](../adr/ADR-010-run-mode-enablement-and-production-key-boundary.md)
§3–§4; [ADR-007](../adr/ADR-007-signed-order-idempotency-and-unknown-submissions.md)
§2–§7 and §11; `docs/contracts/dependency-direction.md` F5, F6, F7 and F12;
`docs/venue/verified-2026-09-30.md` §2.2, §2.4, §2.5, §9, §11 (C-6, C-9,
C-10, C-11, C-12) and §W.1–§W.3; `docs/venue/verified-2026-10-05.md` §S,
F-44, F-46, F-47 and F-53 (the `V2-5` re-pin).

---

## 1. What the package is

`@polymarket-bot/polymarket-secure` is the only package that may import the
official unified SDK, `@polymarket/client` (handoff §9.12; F6). The version is
pinned to **exactly `0.12.0`** (section 7; `V2-5` re-pinned it from `0.11.0`,
the floor Protocol V2 requires, F-37). The package wraps the SDK behind a
narrow internal interface, `SecureVenueClient`, and puts every signer access
behind one boundary.

| Entry point | Contents |
| --- | --- |
| `@polymarket-bot/polymarket-secure` | The `SecureVenueClient` interface and its outcome types; the one factory, `createSecureVenueClient`; the run-mode gate (`evaluateSignerGate`, `assertSignerGate`, `signerGateContextFromSafetyFlags`); the redacted error types (`SecureVenueError`, `SignerBoundaryRefusal`); the opaque `SignerHandle` and `SignedOrderEnvelope`; and `redactForLog`. |
| `@polymarket-bot/polymarket-secure/testing` | Test-only doubles: the mock signer (no key), a scripted I/O-free fake SDK, `createSecureVenueClientForTesting`, the network tripwire, and the SDK contract hooks (since `V2-5` among them a factory over the REAL SDK code with FAKE credentials, usable only with the test factory and the mock signer, behind the tripwire). |

Neither entry point exports a way to build a signer handle, a signer, the SDK
client, or SDK types. Neither exports any code that reads an environment
variable or a key.

## 2. How the boundary works

Every construction goes through `buildSecureVenueClient`, in this order.
A failed step throws, and nothing after it runs.

1. **The run-mode gate runs first**, before the signer handle is read and
   before any SDK code runs. It reads a context of exactly three own data
   properties: `{ runMode, maximumRunMode, allowRealOrders }`. It permits
   only when all three of these hold:
   - `runMode` is a §11 mode that needs a live signer (`EXECUTION_PROBE`,
     `LIVE_MICRO` or `LIVE`);
   - `runMode` does not exceed `maximumRunMode`;
   - `allowRealOrders` is the boolean `true`.

   Every other case throws `SignerBoundaryRefusal` with reason codes only.
   That covers `BACKTEST`, `PAPER`, `SHADOW`, `REPLAY`, a lower-case mode, a
   missing mode, the string `"true"`, a getter, an extra key, an inherited
   field, and any context whose reflection throws (a revoked proxy, a proxy
   trap that throws): the exception is caught, dropped unread, and the
   context refuses as `CONTEXT_UNREADABLE`.

   **A proxy is not refused as such.** JavaScript cannot tell a proxy from a
   plain object, so a proxy whose traps report exactly the three own data
   properties is read like the object it imitates. That is safe: each value
   is read once and copied, and the verdict is computed from the copies, so a
   trap cannot answer differently afterwards. The options object itself is
   read the same way: a throwing getter or trap on it refuses as
   `CONTEXT_UNREADABLE`, never as the raw error.
2. **The handle is checked.** It must be a `SignerHandle` that this package
   sealed; the check is a module-private `WeakMap` lookup. A forged object, a
   `SignerHandle.prototype` look-alike or `Reflect.construct` is refused
   (`SIGNER_NOT_SEALED`).
3. **The provenance is checked.** The real SDK binding refuses the test mock
   (`MOCK_SIGNER_REJECTED_BY_REAL_SDK`). The test factory accepts only the
   mock (`REAL_SIGNER_REJECTED_BY_TEST_FACTORY`).
4. **Only then is the signer unsealed** and handed to the SDK binding. For
   the real SDK, that is `createSecureClient({ signer, wallet?,
   onRateLimitUpdate? })`. No credentials, nonce or environment are passed:
   the SDK derives the L2 credentials itself, so no caller ever handles them.
5. **The SDK client is kept private.** It is held in a module-private
   `WeakMap`, because its `credentials` getter returns the L2 secret. It is
   never returned, serialised or inspected.

After construction **no method throws**. Each method returns an outcome.
Caller input is read by contained reflection: a getter, a hole, a proxy trap
that throws or a revoked proxy makes the input invalid (`NOT_SENT`), and the
thrown value is dropped unread. Arrays are copied once, index by index, from
own data properties, so what is validated is exactly what is sent. An invalid
batch returns one `NOT_SENT` per request entry, bounded at 16, so a hostile
`length` cannot exhaust memory. Callers must not pair outcomes with inputs by
position on a refused batch.

The SDK's own RESPONSES are read the same way. A `postOrders` answer is never
used through its own methods (`map`, an iterator, a species constructor): its
entries are copied from own data properties into a fresh plain array with one
slot per SUBMITTED order. A non-array, a wrong length, or a reflection failure
makes every outcome `UNKNOWN` (`UNRECOGNISED_RESPONSE`). A hole or an
accessor entry makes that one outcome `UNKNOWN`.

`createLimitOrder` accepts a price strictly between 0 and 1 only. Before it
hands out an envelope, it checks the SDK's signed order against the request:

- token, side, post-only, expiration and order type (`GTC`, or `GTD` when an
  expiration was given) must match exactly;
- maker, signer and signature type must be what the pinned SDK derives from
  the client's account (its `Tr`/`Ee` functions): the signature type equals
  the wallet type (0 EOA, 1 proxy, 2 Safe, 3 deposit wallet/POLY_1271), the
  maker is the account wallet, and the signer is the wallet for type 3 and the
  account signer otherwise (addresses compared case-insensitively);
- `builder` and `metadata` must both be `bytes32(0)`, because this package
  never passes a builder code;
- the share amount must be the requested size rounded **down** by less than
  0.01 share, the pinned SDK's share precision;
- the quote amount must be price × shares rounded **down** by less than
  0.001 pUSD, the pinned SDK's coarsest quote precision.

The rounding table these bounds come from is unchanged in `0.12.0`
(`resolveRoundingConfig`, `actions/orders/context.ts` lines 14-31: shares to
2 decimals for every tick; the quote to 3 decimals at tick 0.1, 4 at 0.01, 5
at 0.005 and 0.001, 6 at 0.0025 and 0.0001). `V2-5` re-pinned it against the
real SDK for all six ticks (`sdk-0-12.test.ts`, section 7). A size with more
than 2 decimals is therefore still signed for less than was asked (10.129 is
signed as 10.12 shares). That is the `CO3-N1` gap between the signed size and
the OMS's unrounded size; it belongs to the pre-live OMS track, not to this
package.

**Asset ids are decimal strings (`V2-5`, plan row C6).** A CTF token id and a
Polymarket V2 position id are both canonical decimal strings of at most 78
digits (venue report 2026-10-05 F-39, F-44; U-13 is resolved). The `0x…` hex
branch is gone from the request grammar, the signed order's `tokenId` and the
user stream's `asset_id`: a hex id is `NOT_SENT` (or, on the stream, a
malformed event that requests reconciliation).

**The SDK picks the signing domain from the id (F-47).** A V2-shaped id
(reserved bits 40-103 all zero) is signed against ExchangeV3
(`0xe3333700cA9d93003F00f0F71f8515005F6c00Aa`) with EIP-712 domain version
`"3"`; any other id against the CTF Exchange or, on a neg-risk market, the Neg
Risk exchange, with `"2"`. Gamma's `version` is not consulted (U-46). Pinned
through the real SDK in `sdk-0-12.test.ts`.

These are exact integer comparisons, never floats. A mismatch is `FAILED`
(`UNKNOWN`), and the order is not transmitted. A change in the SDK's rounding
therefore fails closed.

`createLimitOrder` never transmits the ORDER, but it is not free of I/O: the
pinned SDK's `prepareLimitOrder` makes public, unauthenticated reads
(`actions/orders/cache.ts`): `GET /markets-by-token/{id}`, cached for the SDK
client's life, and `GET /clob-markets/{condition}`, cached for **10 minutes**
(lines 16-17); a price off the cached tick grid forces one fresh market read.
A `FAILED` sign outcome can
therefore carry an HTTP-derived kind (a transport failure, a 429). Whatever
its kind or effect, a `FAILED` sign outcome means **no order exists**: nothing
was signed that the caller holds, so nothing can have been posted.

| Method | Outcome kinds |
| --- | --- |
| `createLimitOrder` (signs locally; the order is never transmitted, but the SDK reads public market metadata) | `SIGNED` (a `SignedOrderEnvelope`) / `FAILED` |
| `postOrder`, `postOrders` (1…15 orders) | `ACCEPTED` (`LIVE` / `MATCHED` / `DELAYED`) / `REJECTED` / `NOT_SENT` / `REFUSED` / `UNKNOWN` |
| `cancelOrder`, `cancelOrders` (1…1,000 ids; C-11), `cancelMarketOrders`, `cancelAll` | `COMPLETED` / `NOT_SENT` / `REFUSED` / `UNKNOWN` |
| `fetchOrder` | `FOUND` / `FAILED` |

### 2.1 What an outcome means for the OMS

| Outcome | Meaning | OMS consequence (ADR-007) |
| --- | --- | --- |
| `NOT_SENT` | Nothing left the process: local validation, SDK input validation or signing failed. | The attempt does not exist at the venue. |
| `REFUSED` | The venue returned a documented refusal whose code the pinned SDK could only have kept because the venue sent it: 503 with `post_only_mode` in its `code` field, never a code the SDK inferred from the `error` text (§2.2, rule 4c). (401, 425 and 429 are always `UNKNOWN`; see §2.2.) | Not placed. Retry only as §7 allows. Changing the order to post-only is a new order decision. |
| `REJECTED` | The SDK classified a venue rejection. The reasons are the eight named `OrderResponseErrorCode` members. | Not placed. |
| `UNKNOWN` | The order may exist. | `SUBMISSION_UNKNOWN`: reconcile by the signed identity before any new salt (§2 step 10, §3). |
| `ACCEPTED` / `DELAYED` | The order was placed, but `DELAYED` is never a fill: its amounts are `"0"` (§5). | Track the order as pending. |

### 2.2 Error taxonomy

Errors are classified by HTTP status and **documented** code. The venue's
`error` text is never used.

| SDK error / HTTP | Kind | Effect | Cancels |
| --- | --- | --- | --- |
| `UserInputError` | `INVALID_REQUEST` | `NOT_SENT` | — |
| `SigningError`, `CancelledSigningError` | `SIGNING_FAILED` | `NOT_SENT` | — |
| `RateLimitError` (429; the pinned SDK's ONLY 429) | `RATE_LIMITED` | **`UNKNOWN`** (the SDK discards the body) | — |
| 425, with or without a code | `ENGINE_RESTARTING` | **`UNKNOWN`** (the SDK can drop the code) | `UNKNOWN` |
| 503 + `code: "post_only_mode"` sent by the venue | `POST_ONLY_MODE` | `NOT_APPLIED` | `YES` (documented) |
| 503 + a `post_only_mode` the SDK may have inferred from the `error` text (rule 4c) | `TRADING_UNAVAILABLE` | `UNKNOWN` | `UNKNOWN` |
| 503, any other or no code | `TRADING_UNAVAILABLE` | `UNKNOWN` | `UNKNOWN` (C-9) |
| 401, with or without a code | `AUTHENTICATION_REJECTED` | **`UNKNOWN`** (the SDK can drop the code) | — |
| 401, 425 or 429 with any code (documented or not), including a `code` that is an accessor (present but unreadable) | by status, as above | **`UNKNOWN`** (ADR-007 §6) | as above |
| any other status | `REQUEST_REJECTED` | `UNKNOWN` (U-4) | — |
| `TransportError` / `TimeoutError` / `UnexpectedResponseError` | `TRANSPORT_FAILURE` / `TIMEOUT` / `UNEXPECTED_RESPONSE` | `UNKNOWN` | — |
| anything else, including an SDK look-alike that is not an instance, and any value whose reflection throws | `UNKNOWN` | `UNKNOWN` | — |

`NOT_APPLIED` (outcome `REFUSED`) is given **only** to 503 with the
documented `post_only_mode`, sent by the venue. ADR-007 §6: "an unrecognized
code is surfaced as UNKNOWN and never … silently treated as a rejection". The
kind still follows the status, so a caller can back off.

**Rule 4c: an inferred code is never a documented code (`V2-5`).** From
`0.12.0` the SDK's `ServiceClient` INFERS a `code` from the body's `error`
text when the body has no usable `code`, the status is not 400, and the text
is a snake_case identifier (`ServiceClient.ts` lines 309-318). The 2026-09-30
report already said this package "must not treat an inferred `code` as a
venue-documented code" (§2.4). The error object does not say which kind of
code it holds. An inferred code, though, *is* the `error` text, and the SDK
builds its message as `${error} (${url})` (line 320; `mapTradingRestrictionError`
keeps it verbatim when it re-wraps a 425 or 503). So a documented code is
trusted only when the error's own data `message` is a string that does **not**
begin with `${code} (`. Otherwise the code is unprovable: `venueCode` null,
`undocumentedVenueCode` true. A 503 `{"error": "post_only_mode"}` is
therefore `TRADING_UNAVAILABLE` / `UNKNOWN`, exactly what `0.11.0` produced for
it. The message is compared with that one prefix and dropped, never carried
or matched against anything else, so it can only withdraw trust from a code,
never grant it. A venue body whose `error` text is itself `post_only_mode`
and that also sends the code is `UNKNOWN` too: the fail-closed direction. The
documented post-only body (a sentence `error` and an explicit code) is
unaffected. Pinned through the real SDK, on the public client and the
authenticated `POST /order` path, in `v2-5.test.ts`.

**401 and 425 are `UNKNOWN` even with no code (CX-R3-01).** The pinned SDK's
`ServiceClient` keeps a JSON body's `code` only when the body's `error` is
truthy and the code is a non-empty string (and, from `0.12.0`, infers one from
an identifier-shaped `error`, rule 4c). A body such
as `{"code": "x"}`, `{"error": "", "code": "x"}` or `{"error": null, "code":
"x"}`, a non-string code, or a text or HTML body all reach this package with
no code. So "no code" can never be established, and a code-less 401 or 425
may be a venue answer that carried an undocumented code. The SDK's message
text is never used to tell these cases apart. For a placement this means a
425 (engine restart) forces reconciliation by signed identity before any new
salt. How the venue's documented 425 handling ("resubmit the signed
request" after backoff) composes with that reconciliation is for WP-310 and
WP-270 to decide under ADR-007; this package only reports the effect as
`UNKNOWN`, with kind `ENGINE_RESTARTING` and any `retryAfterSeconds`.

**Every 429 is `UNKNOWN`.** The pinned SDK's `ServiceClient` throws
`RateLimitError` for every 429 before it parses the body
(`if (status === 429) throw new RateLimitError(...)` precedes the body read),
so any `code` the venue sent is discarded and "no code" can never be
established. A 429 therefore forces reconciliation of a placement, like any
other `UNKNOWN`. The kind stays `RATE_LIMITED` (with `retryAfterSeconds` when
the `Retry-After` header was an integer), so backoff still works. (A
`RequestRejectedError` with status 429, which the pinned SDK never builds, is
`UNKNOWN` too.)

**Closed vocabularies.** Every field of a `SecureVenueError` is checked on
every construction: the kind, operation, effect, source and cancel flag
against fixed lists; the status as an integer from 100 to 599; the code
against the documented codes; and the retry delay against 0–86,400 s. Only own
data properties are read. The constructor throws a fixed, value-free
`TypeError` on anything else, and the instance is frozen. Re-mapping an
existing `SecureVenueError` re-reads and re-validates its own data fields; it
never calls a method a subclass could override. `SignerBoundaryRefusal`
accepts only its known reason codes.

**C-9.** The venue publishes three strings for one condition:

- the matching-engine guide: `trading is disabled`;
- the OpenAPI `trading_disabled` example: "Trading is currently disabled. Check polymarket.com for updates";
- the OpenAPI `cancel_only` example: "Trading is currently cancel-only. …".

All three map identically, to `TRADING_UNAVAILABLE` with `cancelsAvailable:
"UNKNOWN"` (E-05: "a cancel attempt is the only evidence"). The OpenAPI example
names `cancel_only` and `trading_disabled` arriving as `code` values are
undocumented codes, not cancel-only evidence.

**U-4.** The only documented `code` value is `post_only_mode`. Any other code is
recorded only as `undocumentedVenueCode: true`, and its value is not carried.
A code the pinned SDK may have inferred from the `error` text is never adopted
as documented (rule 4c, above).

**C-6, and what the pinned SDK does.** The venue documents `unmatched` as
"placement still succeeded". `@polymarket/client@0.11.0` (and `0.12.0`, whose
`post.ts` and `order-response.ts` are unchanged) turns that response
into `{ ok: false, code: "unmatched", message: "Unknown order failure" }` and
**drops the order id**. This is observed in the contract suite. The adapter maps
it to `UNKNOWN` (`SDK_UNMATCHED`), never to `REJECTED`. The OMS must reconcile
such an order by its signed identity (salt, maker, token), because it has no
order id.

### 2.3 The SDK's hidden transport behaviour (pinned by `V2-5`)

The SDK sends every request through `ky` 1.14.3 with `throwHttpErrors: false`
and no retry or timeout option of its own (`ServiceClient.ts` line 79; ky's
defaults, `distribution/utils/normalize.js` lines 3-16 and `core/Ky.js` line
153). For the ten port members that means:

| Request | On a network error (a rejected `fetch`) | On an HTTP error status | Timeout |
| --- | --- | --- | --- |
| `DELETE` (every cancel) | retried **twice**, after 0.3 s and 0.6 s: up to 3 attempts | not retried | 10 s per attempt; a timeout is **not** retried |
| `GET` (`fetchOrder`, the metadata reads of `createLimitOrder`) | retried twice | not retried | 10 s, not retried |
| `POST` (`postOrder`, `postOrders`) | **never** retried: 1 attempt | not retried | 10 s, not retried |

A cancel can therefore reach the venue up to three times, and a cancel's
`UNKNOWN` may stand for three attempts (INF: a repeated cancel of the same
order is expected to be harmless; no venue page states it). A placement is sent once per call; its `UNKNOWN` after a transport
failure or a timeout is `SUBMISSION_UNKNOWN` (ADR-007 §3). The SDK's own
rate-limit retry (`retry.ts`, `withRateLimitRetry`) is applied only to some
public and Data API reads, none of which is a port member. All of this is
pinned through the real SDK in `sdk-0-12.test.ts`.

## 3. Why no key can reach a paper process

Six independent layers stop it. Each is tested.

1. **No key-loading code exists.** No non-test source file in the package
   references `process`, `import.meta.env`, `Deno.env` or `Bun.env`, and none
   imports `fs` or `dotenv`. `source-hygiene.test.ts` parses every file with
   TypeScript and flags planted examples of each form. A composition root
   that wants the gate input from its environment passes the record
   explicitly to `signerGateContextFromSafetyFlags`. That function reads only
   `RUN_MODE`, `MAX_RUN_MODE` and `ALLOW_REAL_ORDERS`.
2. **No real signer exists.** The only sealed handle this package can produce
   is the `TEST_MOCK` mock. The mock holds no key. It signs only payloads in
   its own fixture domain (`WP-260 TEST FIXTURE - NOT A VENUE DOMAIN`), and it
   refuses `ClobAuthDomain` and every venue domain. Its 65-byte "signature"
   has `r = 0`, `s` = a SHA-256 digest of the payload, and a `0x00` parity
   byte. ECDSA requires `1 ≤ r ≤ n − 1`, so it is not a secp256k1 signature:
   the pinned SDK's own `ox` parses the bytes but refuses to recover any
   address ("expected valid r"). `signer-boundary.test.ts` shows this.
   `signMessage` and `sendTransaction` always refuse.

   *Correction (review r1).* An earlier version used a non-zero `r`, and this
   runbook said the `0x00` byte alone made the signature invalid. That was
   wrong: `0x00` is a valid y-parity, and `ox` recovered an address from it.
   The safety conclusion did not depend on it (no key exists, and the mock
   cannot reach the real SDK binding), but the claim is now true.
3. **The gate refuses every non-live mode and the repository defaults.**
   `MAX_RUN_MODE=PAPER` and `ALLOW_REAL_ORDERS=false` fail two conditions at
   once. A test reads this test process's real environment and asserts the
   refusal.
4. **The real SDK binding refuses the mock.** `createSecureVenueClient`
   refuses it before unsealing, so even a live-shaped context cannot put the
   mock in front of the real SDK through the production factory. The mock's
   call counters stay at zero. (Since `V2-5` the contract suite does run the
   real SDK CODE with the mock, through `createSecureVenueClientForTesting`
   and a test-only factory that adds FAKE credentials, behind the network
   tripwire. There the SDK asks the mock to sign a venue order domain, and the
   mock refuses it, by layer 2: no order is signed. The mock records the
   domain it was asked to sign, which is how the suite pins F-47.)
5. **Paper processes do not depend on this package.** `packages/trading-core`
   is layer 1, and an edge from it into this layer-2 package fails `check:deps`
   (F12). `packages/simulation` may not import a signer (F5).
   `apps/trader/package.json` declares no dependency on this package, and
   `WP-260` does not touch `apps/trader`. The control API asserts the same
   for itself (`test/integration/control-api/acceptance-3-no-signer.test.ts`).
   No other package may import the SDK: `check:deps` F6, and this package's
   repository-wide scan, `sdk-import-boundary.test.ts`. The same scan applies
   a `TEST-ONLY` rule: `@polymarket-bot/polymarket-secure/testing` (the mock
   signer, the fake SDK and `createSecureVenueClientForTesting`) may be
   imported only by test files (under `test/`, or `*.test.*` / `*.spec.*`).
   A relative import into `src/testing/` counts the same. F12 does allow a
   layer-3 app to import this layer-2 package; the rule narrows only the test
   subpath.
6. **The trader's startup veto.** A paper process that merely *references* a
   production secret name refuses to start (`packages/trading-core/src/safety.ts`;
   ADR-010 §3).

**The trust boundary, stated plainly.** The gate trusts the context it is
given. It cannot detect a composition root that lies about its own mode. The
startup validator of the process that builds the context is what makes the
context true. No such live process exists, and building one is a human-gated
change (ADR-010 §1, §3).

## 4. Redaction

Redaction here is structural, not a filter. `SecureVenueError` and every
outcome are built only from allow-listed scalars:

- kind, operation and effect;
- HTTP status;
- a documented code;
- a retry delay, bounded to 0–86,400 s;
- the cancel-availability flag;
- the SDK class name;
- a fixed sentence.

Nothing that is free text is ever copied in: not the SDK's message (which
embeds the venue text and the URL), not the `cause` (a `TransportError` can
wrap the request, including the `POLY_API_KEY`, `POLY_PASSPHRASE` and
`POLY_SIGNATURE` headers), not headers and not bodies.

Other values are protected in the same way:

- **Signed orders.** A `SignedOrderEnvelope` renders only its non-secret
  `identity`. The payload with the signature is reachable only through
  `revealPayloadForEncryptedPersistence()`, whose one permitted use is
  encrypted persistence (§15; `WP-270`).
- **Order snapshots** drop the order's `owner`, which is the owning API key.
- **Rate-limit observations** keep a `tier` or `bucket` only when it matches a
  short token pattern.
- **Documented cancel failure reasons** are carried verbatim. Any other reason
  becomes `UNDOCUMENTED`.
- **`redactForLog`** is a second line of defence, for logging arbitrary
  objects. It redacts values under sensitive key names and never invokes a
  getter: object keys and array indices are read as own data properties, and
  `Map`/`Set` through the built-in iterators, never an own override. It
  reduces an `Error` to its name, and keeps the name only when it is a
  standard, SDK or package error name; any other name becomes `"Error"`. It is
  cycle-safe, bounded in depth and in collection size, and never throws: an
  unreadable object becomes `"[unreadable]"`.

`redaction.test.ts` is the property test. Using a fixed seed, it builds 120
hostile errors of every SDK class, with fake secrets in:

- the message;
- a cause chain up to four levels deep;
- headers and bodies;
- hidden, symbol and accessor properties.

It sends each error through every mapping path, every client method and
construction. It then checks every serialiser: JSON, `util.inspect`,
`util.format`, `String`, the stack, the cause chain, the own properties,
`structuredClone` and `redactForLog`. Two controls show the test can fail. The
raw errors do show their secrets to the detector. A deliberately leaky mapper is
caught on every case.

## 5. Tests, and why none can reach the venue

| Suite | Runs in | Contents |
| --- | --- | --- |
| `packages/polymarket-secure/src/**/*.test.ts` | root `pnpm test` (CI) | the gate, the boundary, the error mapping, redaction, the client, the repository-wide SDK import scan, source hygiene, the review pins (`hardening-r1.test.ts` to `hardening-r3.test.ts`), the `V2-5` pins (`v2-5.test.ts`: rule 4c, the decimal asset ids, the ten-member port, the loggable SDK error names), and the tripwire's own self-test (`testing/network-tripwire.test.ts`) |
| `test/contract/polymarket-secure/*.test.ts` | root `pnpm test:contract` (CI), or `pnpm --filter @polymarket-bot/polymarket-secure test:contract` | the venue fixtures run through the pinned SDK's own response parser and HTTP error construction, then through the client; and (`V2-5`, `sdk-0-12.test.ts`) the pin's integrity, F-47 signing domains, F-53 `CONDITIONAL-V2`, no `place*`, the transport behaviour of §2.3, the 10-minute metadata cache and the rounding table, all through the real SDK code |

Every test installs the **network tripwire**. It replaces `globalThis.fetch`,
`globalThis.WebSocket` and `net.Socket.prototype.connect`, the path under
every Node TCP and TLS client. It also refuses DNS (every `lookup*`,
`resolve*` and `reverse` function of `node:dns` and `node:dns/promises`, and
the `Resolver` classes' methods) and UDP (`dgram.Socket` `send` and
`connect`). Any attempt throws and is recorded, and the
test fails in `afterEach` if the attempt list is not empty. The contract suite
serves sanitized HTTP fixtures to the SDK from an in-memory responder. Before
`V2-5` it used only one unauthenticated public-client request. Since `V2-5` it
also builds the real SDK's secure client with the FAKE L2 credential of the
fake SDK (`fake-api-key-WP260-…`), so the SDK signs the HMAC headers of its
requests with that fake secret; every such request is answered from memory,
and anything the responder does not answer is refused. `testing/network-tripwire.test.ts` exercises every leg (fetch,
WebSocket, TCP and TLS, DNS, UDP, and restoration), so removing a leg fails the root
`pnpm test`.

No test uses a real key, a real credential, a real authenticated endpoint or
a WebSocket connection. No test signs or places an order on a venue domain.

## 6. What a future live process must do (NOT enabled; for the record)

Nothing below is authorised. ADR-010 §1: human approval first, recorded in
`IMPLEMENTATION_STATUS.md`, then a configuration change; never the reverse.

- Add a real signer inside this package, sealed with a new provenance. It must
  be loaded from a protected runtime mount in the live execution process only
  (§15). It must not be loaded from the environment, a repository file or a
  paper, backtest or recorder process. This is an ADR-gated change.
- Build the gate context from that process's validated startup configuration.
- Keep the startup deny-list and the four PAPER defaults in every non-live
  process.

## 7. SDK pin and the §W.1 fresh check

### 7.1 The current pin: `0.12.0` (`V2-5`, 2026-10-06)

`V2-5` ran the five-step check of `docs/venue/verified-2026-09-30.md` §W.1 at
2026-10-06T10:22:08Z-10:22:46Z, before it changed the dependency. The sources
were read-only, unauthenticated GETs of `registry.npmjs.org` (metadata and
attestations), `api.github.com` (commit and compare) and the documentation
changelog; the raw bodies, their SHA-256 digests and the fetch log are in the
round's scratch directory, mirrored to `~/pmb-rounds/v2-5/pin-check/`.

| Step | Check | Result |
| --- | --- | --- |
| 1 | npm `dist-tags.latest` for `@polymarket/client` | **`0.12.0`** (published 2026-10-01T14:04:12.359Z). No `0.12.x` patch exists. The other tags were recorded and not adopted: `beta 0.3.0-beta.1`, `latestnpm 0.4.0`, `canary 0.0.0-canary-20261001190242`. |
| 1 | GitHub `Polymarket/ts-sdk` `main` head | `d36b9df37b8562887aadad78b063bb84550eb343` (2026-10-01T18:58:58Z, "Merge pull request #380 from Polymarket/feature/dev-697-price-provider"). It is unreleased and **not pinned**. |
| 2 | Integrity | `@polymarket/client@0.12.0`: `sha512-ZciRp/j0bLQYB3ownLtQDarBTgT3WwXuk/Gp+Ppt7bz/9U4X5EL6DlrLUMBKcYyvFJfK17dKUhe/YPZSngMhqw==` (npm shasum `f96f6ac7ead4c9b97d6e5be05ecc05c62d2149dc`). `@polymarket/bindings@0.12.0`: `sha512-x/7CA6+n20joFvjk0GpUYn01XNbARAe4UwnUsGp/LnE+xaCM1DJjAq6dhI/ZiMmVdgbyVn1ukNeXPrhQ8GhTIQ==` (shasum `e6180811be40028c9c9cb6d6ef2c492688332d9e`). Both equal `verified-2026-10-05.md` §S.1 and the lockfile; `pnpm install` verified the tarballs against them. |
| 2 | The npm attestations `/-/npm/v1/attestations/@polymarket%2fclient@0.12.0` and `…%2fbindings@0.12.0` | Each SLSA provenance v1 names `git+https://github.com/Polymarket/ts-sdk@refs/heads/main`, workflow `.github/workflows/release.yml`, `gitCommit` **`71f9723f70f065af79670ac6269ab51729fcfb5e`** (2026-10-01T13:58:32Z, "Merge pull request #367 from Polymarket/changeset-release/main"). The subject sha512 digests, `65c891a7…9e0321ab` and `c7fec203…f0685321`, are the two integrities above in hex. |
| 3 | `latest` moved, so: the changelog and the diff | The `0.12.0` entry of `https://docs.polymarket.com/changelog/sdks.md` contains neither "breaking" nor "removed". Its behaviour changes (account-trade hashes may be absent, cursors bound to their query, new position filters, split/merge/redeem by `version`, `CONDITIONAL-V2`) touch none of the ten port members. The compare `d527956f…71f9723f` is 88 commits and 66 files ahead, 0 behind. Of the §W.1 table's secure-client files, only these changed: `ServiceClient.ts` (+11/−1: the code inference, rule 4c), `errors.ts` (+77: `PaginationLimitError`, `OperationAbortedError`, `PerpsCancelRetryError`), `index.ts` (+4: `AssetType` and Perps exports), `decorators/subscriptions.ts` (+1: a type export), bindings `clob/account.ts` (+11/−2: `CONDITIONAL_V2`, optional `transactionHash`) and bindings `shared.ts` (+9: a helper). Unchanged: `post.ts`, `restrictions.ts`, `typed-data.ts`, `cancel.ts`, `orders.ts`, bindings `order-response.ts`, the four auth files, `websockets/clob/user.ts`, bindings `subscriptions/clob.ts`, `environments.ts`, `clients.ts`, the realtime and RTDS files; and, beyond the table, `limit.ts`, `amounts.ts`, `fixed.ts`, `context.ts`, `cache.ts`, `prepare.ts`, `protocol.ts`, `exchange.ts`, `wallet.ts`, `retry.ts`, `rate-limit.ts` and `decorators/trading.ts`. **Choice: `0.12.0`**, the documented floor (F-37). |
| 4 | `engines.node` | `>=24` for both packages, unchanged. |
| 5 | Has the E-11 legacy-topic removal landed in `0.12.0`? | No: `actions/subscriptions.ts` and `websockets/rtds.ts` are unchanged since `0.11.0`, which deprecated the legacy topics. This package does not use RTDS topics. |

- **The lockfile change** touches only the `@polymarket/client` and
  `@polymarket/bindings` entries (importer, packages and snapshots). The
  dependency ranges of both are unchanged apart from the exact bindings pin,
  so `ky` 1.14.3, `ox` 0.14.53 and `zod` 4.4.3 did not move (ADR-020 §7: no
  `zod` change).
- **What `V2-5` re-verified, the list WP-260 left for any re-pin:**
  - the `ServiceClient` code-retention rule: **changed** (rule 4c, §2.2);
  - the 429 throw order: unchanged (`ServiceClient.ts` lines 243-248);
  - `Tr`/`Ee`/`Bo` (`wallet.ts`) and the `WalletType`/`SignatureType` enums:
    unchanged;
  - the rounding constants: unchanged (§2, pinned for all six ticks);
  - `LOGGABLE_ERROR_NAMES`: the three new SDK error classes were added.
- **Entry points:** production code imports only the SDK root. Since `V2-5`
  the test-only hooks (`src/testing/sdk-contract.ts`) also import
  `@polymarket/client/actions` (`fetchBalanceAllowance`). No signer adapter
  (`/viem`, `/ethers-v5`, `/privy`) is imported, and the optional peers are
  still not installed.
- **Audit:** `pnpm audit --audit-level high` exits 0 after the change; see the
  `V2-5` handoff for the counts.

### 7.2 The earlier pin: `0.11.0` (`WP-260`, 2026-09-30; superseded)

The check was run by `WP-260` at 2026-09-30T15:48:20Z, before the dependency
was added. The sources were read-only, unauthenticated metadata GETs; no
tarball was downloaded before the install.

| Step | Check | Result |
| --- | --- | --- |
| 1 | npm `dist-tags.latest` for `@polymarket/client` | **`0.11.0`**, unchanged. The other tags were recorded and not adopted: `beta 0.3.0-beta.1`, `latestnpm 0.4.0`, `canary 0.0.0-canary-20260930151117`. |
| 1 | GitHub `Polymarket/ts-sdk` `main` head | `f6801b96d3465326ae86b9b35bbe1475b7ea8647` (2026-09-30T15:07:09Z, "Merge pull request #383 from Polymarket/fix/native-position-allowance"). It is unreleased and **not pinned**. It has moved past `6842ffa4…`, which the venue report recorded. |
| 2 | The lockfile integrity equals the venue report's value | `sha512-ZafpNtV0eDxwzY8SKysSbeMBf6zhJrnO/Ykj0nBAglKimjkKCIOnyAn1hxPlfwf+x66PEB5z3lrDQo0OYF72cg==`: **equal**. The npm shasum is `586a20d51ebf36f954bb9fb6f3265d0cb1b432ea`. |
| 2 | The npm attestation `/-/npm/v1/attestations/@polymarket%2fclient@0.11.0` | The SLSA provenance v1 names `git+https://github.com/Polymarket/ts-sdk@refs/heads/main`, `gitCommit` **`d527956f47cf893849a25a6d2f7d5bee03d04965`**. Its subject sha512 `65a7e936…5ef672` is the integrity above in hex. |
| 3 | `latest` moved? | No, so there were no changelog entries to review. |
| 4 | `engines.node` | `>=24`, unchanged. |
| 5 | Has the E-11 legacy-topic removal landed in `0.11.0`? | No. `0.11.0` is the release that *deprecates* the legacy topics (venue report §W.1: "none removed"). This package does not use RTDS topics. |

- **Resolved dependencies:** `@polymarket/bindings 0.11.0` and
  `@polymarket/types 0.2.0`. The optional peers (`viem`, `ethers-v5`,
  `@privy-io/node`) are **not installed**. This package imports only the SDK
  root entry and none of the signer adapters (`/viem`, `/ethers-v5`, `/privy`).
- **Audit:** `pnpm audit --audit-level high` gives identical output before and
  after the addition: 2 moderate findings, both pre-existing, and no high or
  critical finding.
- **An SDK packaging quirk, recorded.** The `0.11.0` root `.d.ts` re-exports
  every `@polymarket/bindings` symbol, but the runtime root exports only the
  enums. `OrderResponseSchema`, for example, is `undefined` at runtime. The
  adapter does not rely on any schema export. The contract hook finds the
  schema from the SDK's own resolution root. (`0.12.0` behaves the same.)

## 8. Open items owned elsewhere

- **C-12, order heartbeats.** The SDK has no heartbeat method. An ADR is owed
  before `WP-320`, and `SecureVenueClient` deliberately has no heartbeat.
- **`WP-280`.** The authenticated user stream belongs under
  `src/user-stream/**`, built on this boundary.
- **`WP-300`.** Wallet operations (split, merge, redeem, approvals) are not
  exposed yet.
- **`WP-270`.** ADR-007 §2 needs the *expected order hash* before
  transmission. The pinned SDK does not return it from `createLimitOrder`, and
  this package does not compute it by hand: hand-written signing or hashing
  would need an ADR (handoff §1.3). The envelope's identity carries the salt
  and the signed fields.
- **`WP-290`.** Reconciliation needs `listOpenOrders` and trade reads. They
  can be added to the interface in the same pattern.
- **Wiring the contract suite into the root `test:contract` script.** Done
  since: the root `test:contract` runs this package's `test:contract`
  (section 5).
