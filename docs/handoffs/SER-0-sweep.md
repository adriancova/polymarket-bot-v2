# SER-0 — the inherited-`toJSON` route: whole-repository measurement (2026-09-15)

**Status:** measurement complete; remediation authorized as `SER-1`, `SER-2`, `SER-3`
(see `IMPLEMENTATION_STATUS.md`). This record is the evidence those rows cite.

## What was measured

`docs/contracts/schema-boundary.md` §5 recorded an OPEN successor obligation when
`WP-060-FU1` merged (`d869868`): *"`JSON.stringify` resolves `toJSON` through the
PROTOTYPE CHAIN — reachable from any array a door leaves `Array.prototype` on, and
from a `bigint` through `BigInt.prototype` … Every other door that ends in
`JSON.stringify` of a materialized tree should be measured for the same route."*

This sweep measured every `JSON.stringify(` site in non-test source (113 sites /
54 files, plus the INDIRECT routes: the `pg` driver's `prepareValue`, socket
`send`, `fetch` bodies, Redis arguments, digest inputs, and third-party
canonicalizers) at `main` `d6e05bf`, in six pollution contexts per site —
{`Object.prototype`, `Array.prototype`, `BigInt.prototype`} × {enumerable
assignment, non-enumerable `defineProperty`} — with install → call → capture →
restore-in-`finally` → only then assert (an inherited `toJSON` left installed
corrupts vitest's IPC).

**Acceptance bar.** A HIT is a site where an inherited `toJSON` changes
value-bearing output (stored, hashed, sent, compared, used as a map key or a
byte bound) or a decision. Error-message-only sites are NOTE and dismissed by
count. Every area had to reconcile its grep count as
findings + clean + dismissed-message + test-only (+ unprobed, named).

**Method / models.** 15 measurement areas (14 file groups + 1 indirect-route
critic) run by independent Opus agents, each writing and running its own
vitest probes from the session scratchpad (no tracked file touched). Every
material finding was then verified by TWO further independent agents that did
not see the original probes: a *reproduce* lens (fresh probe, concrete input,
`refuted=true` by default) and a *reachability* lens (adversarial-reviewer
agent, code reading only: is there a live producer of a hijackable type, and
does anything downstream refuse?). 48 material findings; all 48 reproduced
(zero reproduce refutations); the reachability lens calibrated severity.

## Per-area accounting

| area | grep sites | findings | clean | dismissed (message) | test-only |
|---|---|---|---|---|---|
| features-digest | 9 | 0 | 6 | 7 | 1 |
| outbound-wire | 8 | 4 | 1 | 0 | 2 |
| simulation | 26 | 0 | 10 | 26 | 1 |
| postgres | 5 | 7 | 5 | 2 | 7 |
| ledger-pnl-keys | 10 | 7 | 2 | 0 | 1 |
| strategy-runtime-json | 2 | 1 | 6 | 0 | 0 |
| orderbook-settlement | 5 | 0 | 0 | 5 | 3 |
| research-backtest | 10 | 1 | 0 | 9 | 2 |
| observability-soak | 6 | 5 | 5 | 0 | 6 |
| binance-outbound | 7 | 1 | 6 | 0 | 4 |
| parquet | 6 | 3 | 0 | 0 | 3 |
| wal | 4 | 5 | 3 | 0 | 2 |
| decisions | 5 | 3 | 1 | 0 | 20 |
| gateway-runtime | 10 | 4 | 3 | 3 | 1 |
| indirect | 51 | 9 | 14 | 10 | 5 |

`features-digest` (canonical JSON only ever hands `JSON.stringify` a primitive
string), `simulation` (26 sites, all refusal messages; the value paths parse
into own data and never serialize), and `orderbook-settlement` (5 message
sites; `order-book/serialize.ts` builds lines by template `ToString`, not this
class) are CLEAN. `strategy-runtime/json.ts`'s scalar branch is clean on its
precondition (materialized input) and only reachable off-precondition.

## Verdicts (48 material findings)

Severity = the reachability lens's calibrated grade. "reach-refuted" means the
lens found no live producer of a hijackable type at HEAD *or* judged the
output message-only; the mechanism reproduced in every case. **Membership in
a remediation round is decided by the class rule, not by the calibrated
grade:** ADR-020 §6 binds a conforming door against refusal decisions that
vary with ambient prototype state, and `d99c2ac` (WP-060-FU1 r4) set the
repository's standard that an own-data encoder is the closure — so every site
whose REPO-BUILT container reaches `JSON.stringify` and whose bytes are
stored, sent, hashed, compared, decided on, or used as a key is in scope,
whatever the caller could or could not supply today.

| id | area | claimed | verdict | reproduce / reach | round | site |
|---|---|---|---|---|---|---|
| `rtds-subscribe-frame-root-and-array` | outbound-wire | CRITICAL | CONFIRMED CRITICAL | CRITICAL / CRITICAL | SER-3 | packages/polymarket-public/src/rtds/feed.ts:620, RtdsTwapFeed.#handleOpen — socket.send(JSON.stringify(buildSubscribeFrame(this.#options.subscriptions |
| `clob-market-frames-root-and-assets-array` | outbound-wire | CRITICAL | CONFIRMED CRITICAL | CRITICAL / CRITICAL | SER-3 | packages/polymarket-public/src/feed/connection.ts:1027, PublicMarketFeed.#sendFrames — socket.send(JSON.stringify(frame)) for buildMarketSubscribeFram |
| `clob-rest-books-post-body` | outbound-wire | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-3 | packages/polymarket-public/src/runtime.ts:124, globalHttpClient — fetch(request.url, { body: JSON.stringify(request.jsonBody) }) |
| `coinbase-subscribe-unsubscribe-frames` | outbound-wire | CRITICAL | CONFIRMED HIGH | CRITICAL / HIGH | SER-3 | packages/coinbase-adapter/src/venue-facts.ts:402 buildSubscribeFrame and :418 buildUnsubscribeFrame — return JSON.stringify(frame); sent verbatim by C |
| `dataset-catalog-identity-columns` | postgres | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/dataset-catalog.ts:300-302, createDatasetCatalogRepository().importDatasetManifest (3 grep sites: start_eve |
| `pg-prepare-value-signed-payload` | postgres | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/orders.ts:140, createOrderRepository().recordSubmissionAttempt (INDIRECT: no JSON.stringify in the repo; pg |
| `pg-prepare-value-configs-parameters` | postgres | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/strategy.ts:130, createStrategyRepository().createConfig (INDIRECT via pg prepareValue) |
| `pg-prepare-value-order-events-payload` | postgres | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/orders.ts:270, createOrderRepository().appendOrderEvent (INDIRECT via pg prepareValue) |
| `pg-prepare-value-response-payload` | postgres | CRITICAL | REACH-REFUTED→NOTE | CRITICAL / NOTE | SER-2 | packages/storage-postgres/src/repositories/orders.ts:176, createOrderRepository().recordSubmissionResponse (INDIRECT via pg prepareValue; deliberately |
| `pg-prepare-value-params-schema` | postgres | HIGH | CONFIRMED MEDIUM | MEDIUM / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/strategy.ts:89, createStrategyRepository().createDefinition (INDIRECT via pg prepareValue; UNGUARDED by des |
| `pg-prepare-value-raw-metadata-and-default` | postgres | HIGH | CONFIRMED MEDIUM | HIGH / MEDIUM | SER-2 | packages/storage-postgres/src/repositories/catalog.ts:102, createCatalogRepository().registerMarket, `raw_metadata: input.rawMetadata ?? {}` (INDIRECT |
| `ledger-attribution-bucket-key-parity-flip` | ledger-pnl-keys | CRITICAL | REACH-REFUTED→NOTE | CRITICAL / NOTE | SER-1 | packages/ledger/src/balance.ts:274 attributionBucketKey (called by attributionBucketsOfValidated, checkAttributionParityOfValidated, and projections.t |
| `ledger-leg-key-reversal-flip` | ledger-pnl-keys | CRITICAL | CONFIRMED HIGH | CRITICAL / HIGH | SER-1 | packages/ledger/src/balance.ts:438 legKeyOfValidated (via legKey at :418 and legDeltasOfValidated; consumed by Ledger.checkReversal through isExactNeg |
| `ledger-balance-line-key-collapse` | ledger-pnl-keys | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-1 | packages/ledger/src/projections.ts:266 balanceLineKey (applyTransaction fold, exported) |
| `ledger-virtual-position-key-merge` | ledger-pnl-keys | CRITICAL | CONFIRMED CRITICAL | CRITICAL / CRITICAL | SER-1 | packages/ledger/src/projections.ts:271 virtualPositionKey (applyTransaction fold, exported) |
| `pnl-composite-key-cross-denomination-merge` | ledger-pnl-keys | HIGH | CONFIRMED MEDIUM | HIGH / MEDIUM | SER-1 | packages/pnl/src/state.ts:95 key2 (exported as pnlCompositeKey; used by applyFee, applyRewardPayout, applyRewardEstimate) |
| `ledger-stable-stringify-bigint-route` | ledger-pnl-keys | MEDIUM | REACH-REFUTED→NOTE | MEDIUM / NOTE | SER-1 | packages/ledger/src/projections.ts:710 stableStringify primitive branch (serializeProjection, serializeLedger) |
| `pnl-stable-stringify-bigint-route` | ledger-pnl-keys | MEDIUM | REACH-REFUTED→NOTE | NOTE / NOTE | SER-1 | packages/pnl/src/serialize.ts:46 stableStringify primitive branch (serializePnlState, serializeRealizedPnl, serializePnlSnapshots) |
| `stratjson-scalar-route-unmaterialized-bigint-function` | strategy-runtime-json | MEDIUM | REACH-REFUTED→NOTE | NOTE / NOTE | — (off-precondition; materialization refuses first) | packages/strategy-runtime/src/json.ts:1150 canonicalJsonStringify — scalar route `completed = JSON.stringify(current) ?? "null"` (reached for every no |
| `research-worker-cycle-report-line` | research-backtest | MEDIUM | REACH-REFUTED→NOTE | MEDIUM / NOTE | — (stdout log line) | apps/research-worker/src/worker.ts:117 runCompactionCycle (the per-cycle summary handed to dependencies.report, which main.ts:83 wires to console.log  |
| `soak-parser-schemaversion-reason-bytes` | observability-soak | MEDIUM | REACH-REFUTED→NOTE | MEDIUM / NOTE | — (message) | packages/observability/src/recorder/soak-evidence.ts:278, parseSoakWindowEvidence — `unknown schemaVersion ${JSON.stringify(value["schemaVersion"])}` |
| `soak-parser-kind-reason-bytes` | observability-soak | MEDIUM | REACH-REFUTED→NOTE | NOTE / NOTE | — (message) | packages/observability/src/recorder/soak-evidence.ts:282, parseSoakWindowEvidence — `unknown kind ${JSON.stringify(value["kind"])}` |
| `extra-soak-status-artifact-arrays` | observability-soak | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-3 | test/soak/recorder/evaluate.job.test.ts:66, the `soak:evaluate` JOB body (vitest is its execution vehicle; NOT a test of anything — its output is the  |
| `extra-soak-record-writer-object-proto` | observability-soak | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-3 | test/soak/recorder/run-soak.mjs:353, main() — `await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)`. OUTSIDE the assigned file; not co |
| `binance-unknown-frame-keys-array` | binance-outbound | MEDIUM | CONFIRMED NOTE | MEDIUM / NOTE | — (diagnostic key list inside a detail string) | packages/binance-adapter/src/frames.ts:645, decodeFrame (final UNKNOWN branch: `keys: ${JSON.stringify(Object.keys(payload).slice(0, 20))}`) |
| `dataset-manifest-encode-ordered-literal` | parquet | CRITICAL | CONFIRMED HIGH | HIGH / HIGH | SER-2 | packages/storage-parquet/src/dataset-manifest.ts:399 encodeDatasetManifest (and datasetManifestDigest at :404, which hashes the same bytes) |
| `retention-receipt-encode-ordered-literal` | parquet | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-2 | packages/storage-parquet/src/retention-receipt.ts:79 encodeRetentionReceipt (and retentionReceiptDigest at :84) |
| `wal-frame-line-encode-object-literal` | parquet | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-2 | packages/storage-parquet/src/wal-format.ts:313 encodeFrameLine |
| `wal-frame-line-object-prototype` | wal | CRITICAL | CONFIRMED CRITICAL | CRITICAL / CRITICAL | SER-2 | packages/storage-wal/src/segment-format.ts:74 encodeLine, reached through encodeFrameLine (called at writer.ts:574 inside WalWriter.enqueue) |
| `wal-manifest-artifact-object-prototype` | wal | CRITICAL | REACH-REFUTED→NOTE | CRITICAL / NOTE | SER-2 | packages/storage-wal/src/manifest.ts:243 encodeSegmentManifest (via writeSegmentManifest, called from segment-writer.ts:414 finalize, writer.ts:1539 f |
| `wal-header-line-object-prototype` | wal | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-2 | packages/storage-wal/src/segment-format.ts:74 encodeLine, reached through encodeHeaderLine (segment-writer.ts:131 ActiveSegment.open, from writer.ts # |
| `wal-footer-line-object-prototype` | wal | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-2 | packages/storage-wal/src/segment-format.ts:74 encodeLine, reached through encodeFooterLine (segment-writer.ts:352 finalize) |
| `wal-capacity-reserve-cached-under-pollution` | wal | MEDIUM | CONFIRMED MEDIUM | NOTE / MEDIUM | SER-2 | packages/storage-wal/src/writer.ts:280-313 headerReserveBytes / footerReserveBytes (they measure encodeHeaderLine/encodeFooterLine output, i.e. segmen |
| `publisher-admission-byte-bound` | decisions | CRITICAL | CONFIRMED HIGH | CRITICAL / HIGH | SER-3 | apps/data-gateway/src/publisher.ts:240 envelopeByteSize (consumed by GatewayPublisher.enqueue at :309-:311) |
| `control-api-response-body` | decisions | HIGH | CONFIRMED HIGH | HIGH / HIGH | SER-3 | apps/control-api/src/api.ts:195 json() (every ApiResponse body: state reads, mutation receipts carrying auditRecordId, and problem() refusals) |
| `control-http-refusal-bodies` | decisions | MEDIUM | REACH-REFUTED→NOTE | NOTE / NOTE | SER-3 (uniformity) | apps/control-api/src/http.ts:108 (413 CONTROL_BODY_TOO_LARGE) and :127 (400 CONTROL_BODY_NOT_JSON), inside startControlHttpServer's request handler |
| `gateway-feed-stall-incident-detail-rtds` | gateway-runtime | HIGH | CONFIRMED NOTE | HIGH / NOTE | — (message) | apps/data-gateway/src/feeds/rtds.ts:254 RtdsFeedDriver.onEvent (FeedStale branch) |
| `gateway-feed-stall-incident-detail-polymarket` | gateway-runtime | HIGH | CONFIRMED NOTE | MEDIUM / NOTE | — (message) | apps/data-gateway/src/feeds/polymarket.ts:210 PolymarketFeedDriver.onEvent (FeedStale branch) |
| `gateway-feed-stall-incident-detail-binance` | gateway-runtime | HIGH | CONFIRMED NOTE | MEDIUM / NOTE | — (message) | apps/data-gateway/src/feeds/binance.ts:270 BinanceFeedDriver.#dispatchEmission (FeedStale branch, reached via tick() -> feed.checkStaleness) |
| `publisher-admission-byte-bound-OUT-OF-ASSIGNMENT` | gateway-runtime | CRITICAL | DUP→publisher-admission-byte-bound | — / — | — | apps/data-gateway/src/publisher.ts:240 envelopeByteSize (called from GatewayPublisher.enqueue admission check at :311) — NOT in my assigned file list  |
| `pg-submission-attempts-signed-payload` | indirect | CRITICAL | DUP→pg-prepare-value-signed-payload | — / — | — | packages/storage-postgres/src/repositories/orders.ts:140 createOrderRepository().recordSubmissionAttempt — signed_payload handed as an object; seriali |
| `pg-order-events-payload` | indirect | CRITICAL | DUP→pg-prepare-value-order-events-payload | — / — | — | packages/storage-postgres/src/repositories/orders.ts:270 createOrderRepository().appendOrderEvent — payload handed as an object to pg's Bind |
| `pg-ops-audit-state-documents` | indirect | CRITICAL | CONFIRMED MEDIUM | CRITICAL / MEDIUM | SER-3 | apps/control-api/src/adapters/postgres-audit-sink.ts:159-160 (#appendKillSwitch prior_state/resulting_state) and :177-178 (#appendConfigChange previou |
| `pg-strategy-decisions-model-outputs-state-patch` | indirect | CRITICAL | REACH-REFUTED→NOTE | HIGH / NOTE | SER-2 (uniformity) | apps/trader/src/adapters/postgres-store.ts:98-99 PostgresTraderStore.persistDecision — model_outputs and state_patch handed as objects to pg's Bind |
| `pg-strategy-configs-parameters-and-params-schema` | indirect | CRITICAL | DUP→pg-prepare-value-configs-parameters + pg-prepare-value-params-schema | — / — | — | packages/storage-postgres/src/repositories/strategy.ts:130 createConfig (parameters, decimal-guarded then handed through) and :89 createDefinition (pa |
| `pg-submission-response-payload` | indirect | CRITICAL | DUP→pg-prepare-value-response-payload | — / — | — | packages/storage-postgres/src/repositories/orders.ts:176 recordSubmissionResponse — response_payload (JsonInput object, deliberately not decimal-guard |
| `pg-catalog-raw-metadata` | indirect | HIGH | DUP→pg-prepare-value-raw-metadata-and-default | — / — | — | packages/storage-postgres/src/repositories/catalog.ts:102 registerMarket — raw_metadata: input.rawMetadata ?? {} (object) to pg's Bind |
| `pg-bigint-verdict-flip-at-driver` | indirect | MEDIUM | REACH-REFUTED→NOTE | MEDIUM / NOTE | SER-2 (closed by the TEXT rule) | pg@8.23.0 lib/utils.js prepareObject (JSON.stringify) — reached by every plain-JsonInput column write that has no decimal walk: orders.ts:176 response |

Duplicates (`DUP→`) are the indirect critic re-finding a site the `postgres`
area had already measured end-to-end (same repository line, same driver
route), and the gateway-runtime agent re-finding `publisher.ts:240`; the
verified twin's verdict stands for both.

## What was NOT measured (residuals, named)

- **PostgreSQL's acceptance of the substituted bytes** — inferred from the DDL
  (no `jsonb_typeof`/shape CHECK on any of the written `jsonb` columns; only
  `internal.jsonb_contains_number` on `strategy.decisions.model_outputs`). The
  chain was cut at `pg`'s bind-time `valueMapper` (`prepareValue`), the last
  transformation before the wire; a live PostgreSQL round-trip needs the
  testcontainers suite, which cannot run in this WSL (no Docker).
- **Venue-side reaction to a hijacked frame/body** (Polymarket RTDS/CLOB,
  Coinbase) — needs a network exchange, forbidden.
- **`test/soak/recorder/run-soak.mjs` as a process under pollution** and the
  `soak:evaluate` job run as itself — replicated line-for-line in probes
  instead (vitest IPC constraint).
- End-to-end consequence of the collapsed ledger projection in `apps/trader`
  (`loop.ts:869/1681`, `allocation.ts:503`) — inferred from reading; the key
  sites were measured at the package boundary.

## Out-of-class observation (verified by reading, owned as a follow-up)

`apps/trader/src/adapters/postgres-store.ts:210-217` `writePnlSnapshot` inserts
`toPnlSnapshotRow()`'s **camelCase** keys (`accountRef`, `grossTradingPnl`, …)
into `accounting.pnl_snapshots`, whose columns are **snake_case**
(`gross_trading_pnl`, migration `0006_accounting.up.sql:840`), behind
`.values(row as never)`. The adapter's header says it is typecheck-pinned only
with no integration evidence; at runtime PostgreSQL would refuse the column
name and `#contained` would turn every snapshot write into `UNAVAILABLE`
(§4.2: a trading halt). Not this class; recorded for a `TRDR-2` round.

## The remediation shape (what SER-1/2/3 implement)

One primitive, three consumer rounds. `packages/risk/src/plain-json.ts`
(`encodePlainJson`) is the ECMA-262 25.5.2 restatement over OWN DATA that
`packages/event-bus`'s `encodeWireJson` already is — moved to the canonical
own-data home named by the GOV-2A ruling, with an `indent` option for the
pretty-printed on-disk artifacts and a plain-container rule (a `Date`/`Map`/
class instance is refused rather than silently `{}`). Consumers: layer-2
packages import it downward (workspace link + lockfile importer block, the
`WP-170-FU1` precedent); `ledger`/`pnl` over the existing S5/S6 rows with the
surface clause widened; apps freely. Every `jsonb` write hands `pg` a
pre-serialized STRING (a string primitive never reaches `prepareObject`, which
also closes the sibling `toPostgres` lookup); every outbound frame/body and
every persisted artifact is encoded by the primitive; every Map key is built
by it. Bytes are byte-identical to today's for every in-type input, so no
golden, on-disk format, or re-parser changes.

Probe files and raw observations: session scratchpad
`sweep-*.probe.ts` / `verify-tojson-*.probe.ts` (not committed; the
implementing rounds re-derive their pins from the sites named above).

