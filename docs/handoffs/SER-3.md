# SER-3 completion record — outbound bytes, runtime decisions and soak artifacts

**Merged:** `603a49c` (`--no-ff`, 2026-09-15). Chain on base `a9dcb8a`:
`1e4f8e8` (candidate) → `0f0c985` (r1) → `d232871` (r2). Review arc: r1
**CHANGES REQUIRED** (2 MEDIUM, 2 LOW) → r2 **CHANGES REQUIRED** (3 LOW, one
blocking) → r3 **ACCEPT** (1 LOW, documentation-only). Two remediation rounds,
both opened by the reviewer.

**What it is.** The last round of the `docs/handoffs/SER-0-sweep.md` remediation.
Every byte that leaves the process, gates a runtime decision, or is written as
operator evidence is now produced by `encodePlainJson`
(`@polymarket-bot/risk/plain-json`, shipped by `SER-1`) instead of
`JSON.stringify`, which resolves `toJSON` through the prototype chain.

## What shipped

1. **`packages/polymarket-public`** — new `src/outbound-json.ts`, an adapter
   restating the encoder's typed refusal as `PublicMarketConfigurationError`,
   classified by an own-data read of `kind` (never `instanceof`). The RTDS
   subscribe frame is encoded ONCE at construction (a reconnect re-sends exactly
   those bytes); `feed/connection.ts` `#sendFrames` encodes EVERY frame before
   ANY is written (no partial batch); `runtime.ts` encodes the POST `/books`
   body before `fetch` runs.
2. **`packages/coinbase-adapter`** — both frame builders route through a private
   `encodeFrame` over `CoinbaseConfigurationError`, same discipline.
3. **`apps/data-gateway`** — `envelopeByteSize` measures own-data bytes at the
   default bound; an envelope with no own-data JSON text now halts publication
   through the existing `GATEWAY_PUBLISH_REJECTED` path instead of throwing a
   `TypeError` synchronously into a feed driver's socket callback.
4. **`apps/control-api`** — `json()` uses `indent: 2`; both transport refusal
   bodies go through the new exported `controlRefusalBody`; `asJsonInput` hands
   `pg` TEXT, keeping the `{ value }` wrap so a `null` document still lands as
   `{"value":null}` rather than SQL `NULL`.
5. **The soak harness** — `run-soak.mjs` consumes the primitive from source under
   a narrow `module.registerHooks` resolver (measured: Node 24 type-strips the
   `.ts` but does not rewrite its `./plain-data.js` specifier); `soak-status.json`
   is rendered by the new `src/status-artifact.ts`, driven by both the job and
   its pin.
6. **r1** — outbound containers are built ORDINARY regardless of the caller's
   species (M2), both classifiers pinned (M1), the dispatcher ordering claim
   corrected and exercised on the real dispatcher (L1), and the risk-specifier
   assertion rebuilt on the TypeScript compiler API (L2).
7. **r2** — `control-plane.ts`'s `attemptedKeys` rebuilt ordinary (N1), the
   batch-bound pin made to cross the bound it names (N2), and a sibling text
   scan moved onto the compiler-API walk (N3).

## The review arc

- **r1 (`1e4f8e8`, CHANGES REQUIRED).** **M2:** `rtds/frames.ts` built the frame
  with `.map()`, which preserves array SPECIES, so an `Array` subclass of
  ordinary valid subscriptions — cast-free and typechecking clean — became the
  frame's array and the encoder REFUSED it at construction, where base sent the
  frame. **M1:** the `instanceof` mutant survived both new classifiers.
  **L1/L2:** a false ordering claim and a regex that missed ordinary import
  spellings. The round also verified positively: the publisher's double bound
  (no open-shaped payload in `packages/domain/src/events/**`; the transport door
  is tighter at 16), the `json()` bound being the SAME predicate and constant as
  `readPlainData`'s, 16,800 differential comparisons with zero differences.
- **r2 (`0f0c985`, CHANGES REQUIRED).** M2/M1/L1/L2 all closed and re-verified —
  the index walk survived eight container shapes including a cross-realm array, a
  `Proxy`, a frozen array, a prototype `length` getter, a `Symbol.iterator`
  override and a hostile `Symbol.species` (where BASE emitted garbage and the tip
  emits the correct frame). **N1 (blocking):** the M2 sweep had missed
  `control-plane.ts:440`'s species-preserving `.map()`, whose audit record the
  re-pointed sink then refused — and the sink's comment claimed its documents
  were "frozen object literals over ordinary containers", which was measurably
  untrue for that path. **N2:** a pin stubbed `"{}"`, so it threw after the first
  chunk and never crossed the batch bound its name claimed. **N3:** a sibling
  scan kept the blind spot L2 had just removed.
- **r3 (`d232871`, ACCEPT).** N1 re-measured end to end on the real
  `ControlPlane` through a real `PostgresControlAuditSink` (record ordinary,
  bytes equal base, `pg` handed TEXT), its mutant failing 2 of 14; the rewritten
  sink comment checked sentence by sentence against the code; the N2 pin's three
  chunk bodies independently measured; the N3 walk proven non-vacuous against
  planted single-quoted, backtick and unicode-escaped imports that the old check
  passed 10/10. One new LOW, documentation-only: **N4**.

## Residuals (owned)

1. **`packages/polymarket-public/src/runtime.ts` `jsonBody`** — the root IS the
   caller's value, so a non-plain body is refused before `fetch` where base
   coerced or was hijacked. Domain stated on the port (`ports.ts`). Unreachable
   in-repo: `globalHttpClient` is wired only as `polymarketHttpClient` and
   consumed only by `PublicBookSnapshotFetcher`.
2. **`apps/control-api/src/health-source.ts` `TraderHealthSource`** — an exported
   interface: a composition implementing it WITHOUT the door and returning a
   foreign container makes `/v1/health` answer **500** where base answered 200
   (measured). Fail-closed, no state change, and all three in-repo
   implementations go through the door. **Follow-up:** brand
   `TraderHealthReportInput` in `@polymarket-bot/observability` so only
   `readTraderHealthReport` can mint one — that is the clean closure, and it
   lives outside this round's paths.
3. **`apps/control-api/src/adapters/postgres-audit-sink.ts`** — a caller driving
   the sink DIRECTLY with a hand-built record whose state document carries a
   foreign container. Now stated precisely; the producer-side hole (N1) is fixed
   and pinned. The sink is not wired at HEAD.
4. **`apps/data-gateway/src/publisher.ts` `enqueue`** — residual by construction
   (the envelope is taken by reference), but verdict-equivalent: both the redis
   door (`encodeEnvelope`) and `MemoryEventTransport` refuse the same value, and
   the tip is strictly better in the stack-overflow case.
5. **`packages/polymarket-public/src/rtds/frames.ts` hole divergence** — an
   out-of-type hole now throws where base's `.map()` left a hole; unreachable
   through the feed, because `validateSubscriptions` throws the same `TypeError`
   first at base and at tip.
6. **`apps/control-api/src/control-plane.ts:440` iterator-vs-index values
   divergence** — `[...keys]` reads the caller's iterator where base's `.map()`
   read indices, so an `Array` subclass overriding `Symbol.iterator` (in-type and
   cast-free, proven with the compiler) changes the recorded VALUES. Never the
   species, so the encoder is satisfied and nothing refuses. Accepted: the list is
   §14.1 audit diagnostics, not a decision (the 403 is decided by
   `forbiddenControlKeysIn` walking the BODY), and the only in-repo caller passes
   a frozen ordinary array. **N4 (owed by the docs round):** one sentence at the
   site stating that trade-off, naming `rtds/frames.ts`'s index walk as the place
   it went the other way.
7. `encodePlainJson`'s own residual carries over: a `Proxy` handed to it runs its
   traps. Both classifiers are pinned against whatever such a trap throws.

**Where the index walk belongs** (the reviewer's adjudication, recorded so a
later round does not churn it): only where base itself read by INDEX *and* the
values are load-bearing for an outbound protocol frame or a runtime decision —
which is exactly `rtds/frames.ts`. `venue/frames.ts`, `coinbase venue-facts.ts`
and `snapshot/fetcher.ts` were ALREADY iterator-based at base (`[...assetsIds]`,
`[...productIds]`, `[...new Set(tokenIds)]`), so converting them would INTRODUCE
a divergence from base rather than remove one.

## Gates at the merged tip `d232871`, and on `main` at `603a49c`

At the tip: `pnpm run test` 316 files / 7010 tests; typecheck, lint,
`check:deps` 34 packages / 75 edges; `test:contract` 583/65/158/95;
`test:soak-smoke` 1/5; data-gateway integration 11/58; control-api integration
8/77; `soak:evaluate` PENDING (no evidence windows exist; none is claimed).

Post-merge on `main` at `603a49c`, after `pnpm install --frozen-lockfile
--offline` materialized all seven workspace links: **323 files / 7082 tests**,
typecheck, lint, `check:deps` **34 packages / 78 edges** (72 + 6 downward risk
edges from SER-2 and SER-3), `test:fault` 11/89, `test:contract`
583/65/158/95, `test:soak-smoke` 1/5, and all six integration suites —
storage-postgres 215, event-bus 81, research-worker 27, data-gateway 58,
trader 110, control-api 77.

## Process note (disclosed)

Both confirming reviews of this round ran as independent Claude
`adversarial-reviewer` agents. Codex refused the sibling SER-2 packet four times
across two models (`gpt-6-astra` ×3, `gpt-5.6-sol` ×1) with a false-positive
content-filter error after substantial work each time, and was not retried here.
Every reviewer was independent of every implementing agent, which is what
`AGENTS.md` requires; the model diversity of earlier rounds was not available.

## Follow-ups (owned)

- **The docs round** (next): `docs/contracts/schema-boundary.md` §5's OPEN
  successor obligation is now discharged by SER-0 → SER-1/2/3 and should say so;
  it can also cite `encodeJsonbText` as the `pg` text rule, record the six new
  downward `risk` edges and the consumed subpath `./plain-json`, and carry N4's
  one-sentence site note.
- Brand `TraderHealthReportInput` in `@polymarket-bot/observability` (residual 2).
- `SER-2`'s residuals 2 and 3 (`excludedSegments[].gatewayEpoch` bounding;
  `parseDatasetManifest`'s cast) are `packages/storage-parquet`'s to close.
- `TRDR-2` candidate (recorded in `SER-0-sweep.md`): `writePnlSnapshot` inserts
  camelCase keys into snake_case `accounting.pnl_snapshots` columns behind
  `.values(row as never)`.
- Consider factoring the hostile-thrown-`Proxy` fixture and the six-context
  harness (`test/unit/ledger/inherited-tojson.ts`, now imported across four test
  trees) into one shared home.
