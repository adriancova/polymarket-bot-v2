/**
 * Support for `backtest-static-bracket-replay.test.ts` (BACKTEST-1, GOV-2B B3):
 * the committed fixture, the assembly of the SHARED paper core behind the
 * shipped replay root, and the canonical artefact the determinism claim is
 * made about.
 *
 * ## What is real, and what is not
 *
 * REAL: `apps/backtest-cli`'s `runBacktest` (the shipped replay root — the
 * manifest door, the filesystem archive reader, the Parquet decode, the
 * checksum verification, the dispatch ordering, `packages/simulation`'s
 * `runReplay`, the replay clock, the §12.4 serialization), its
 * `normalizedEnvelopeNormalizer` and its `replayDrivenCoreLoop`; and
 * `apps/trader`'s WHOLE composition root and core loop — `createPaperTrader`
 * over the real books, feature engine, strategy runtime, Static Bracket,
 * capital allocator, risk engine, execution planner, `SimulatedVenue`, ledger
 * and PnL engine. Nothing between the recorded frame and the ledger posting is
 * a copy, a subset or a re-implementation of the paper trader's path: it IS
 * `CoreLoop.ingest` + `CoreLoop.drain`, called by the shipped driver in the
 * live pump's own order.
 *
 * DOUBLED, and only this: the §4.2 durable store, using `apps/trader`'s OWN
 * in-memory `MemoryTraderStore` (`@polymarket-bot/trader/testing`), the same
 * double the shipped process's integration suite and `test/e2e` use. Replay
 * is in-memory by definition — its durable output is the artefact — and a
 * PostgreSQL adapter here would make a determinism test depend on a database.
 * The two seams the live trader wires that replay does NOT wire, and why each
 * absence is honest:
 *
 * | Live seam | Replay | Why |
 * | --- | --- | --- |
 * | `RedisMarketEventFeed` + `pump` | `runReplay` → `replayDrivenCoreLoop` | the recorded dataset IS the feed; the driver calls the same two loop methods the pump calls |
 * | a wall `Clock` | `packages/simulation`'s `ReplayClock`, advanced only by recorded events | §6 invariant 15: a replay knows nothing the live process did not know at the same point |
 * | `PostgresTraderStore` | `MemoryTraderStore` | see above |
 *
 * ## Why the core is assembled HERE and not inside the CLI binary
 *
 * `createPaperTrader` lives in `apps/trader`, a layer-3 application, and
 * `docs/contracts/dependency-direction.md` §2 rules that "Nothing may depend on
 * an app" (`check:deps` F13). `apps/backtest-cli` therefore cannot import it,
 * and this file — which sits outside every workspace package, like
 * `test/unit/trader/**`'s relative imports of `apps/trader/src` — is the one
 * place in the repository that may hold both apps at once. The CLI ships the
 * driver; the composition below is the caller the driver's own header names.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. The only file read is the
 * committed fixture, through the shipped archive adapter.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizedEnvelopeNormalizer,
  replayDrivenCoreLoop,
  runBacktest,
  sha256Hex,
  type BacktestOutcome,
} from "../../../apps/backtest-cli/src/index.js";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  createPaperTrader,
  projectionOf,
  type AccountingChecks,
  type DecisionTrace,
  type PaperTrader,
  type TraceLink,
} from "../../../apps/trader/src/index.js";
import { MemoryTraderStore } from "../../../apps/trader/src/testing/index.js";
import {
  SimulatedVenue,
  createReplayClock,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type PlannedOrderView,
  type ReplayClock,
  type ReplayRunPins,
  type SimulatedFill,
  type SimulatedOrder,
  type TimeInForce,
} from "../../../packages/simulation/src/index.js";
import type { DatasetRow } from "../../../packages/storage-parquet/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The committed fixture. Its README carries provenance and derivations. */
export const FIXTURE_DIRECTORY = join(REPO_ROOT, "test", "replay-golden", "backtest", "static-bracket");
export const FRAMES_FILE = "frames.json";
export const PARQUET_OBJECT_FILE = "part-00000.parquet";
export const MANIFEST_FILE = "dataset-manifest.json";
export const RUN_PINS_FILE = "run-pins.json";
export const TRADER_CONFIG_FILE = "trader-config.json";
export const EXPECTED_ARTIFACT_FILE = "expected-artifact.txt";

/** The format id of the artefact this suite freezes. Bump = re-derive the golden. */
export const ARTIFACT_FORMAT_ID = "polymarket-bot/backtest-static-bracket-replay/v1";

/**
 * The `idNamespace` handed to `createPaperTrader`. `DeterministicIdFactory`
 * folds it into every minted approved-intent, plan, attempt, ledger and PnL
 * id, so it is a seed the golden bytes are frozen against.
 */
export const ID_NAMESPACE = "backtest-1-static-bracket-replay";

/** One recorded frame of the normalized-stream recording, as `frames.json` states it. */
export interface FixtureFrame {
  readonly ingestSeq: string;
  readonly source: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly envelope: {
    readonly eventType: string;
    readonly schemaVersion: number;
    readonly sourceChannel: string;
    readonly venueTimestamp?: string;
    readonly payload: unknown;
  };
}

export interface FixtureFrames {
  readonly fixture: string;
  readonly gatewayEpoch: string;
  readonly segmentId: string;
  readonly objectKey: string;
  readonly frames: readonly FixtureFrame[];
}

export interface Fixture {
  readonly frames: FixtureFrames;
  readonly manifest: { readonly eventRange: { readonly first: { readonly receivedAt: string } } };
  readonly runPins: ReplayRunPins;
  readonly traderConfig: Record<string, unknown>;
  readonly parquetBytes: Uint8Array;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), "utf8")) as T;
}

export function loadFixture(): Fixture {
  const buffer = readFileSync(join(FIXTURE_DIRECTORY, PARQUET_OBJECT_FILE));
  return {
    frames: readJson<FixtureFrames>(FRAMES_FILE),
    manifest: readJson<Fixture["manifest"]>(MANIFEST_FILE),
    runPins: readJson<ReplayRunPins>(RUN_PINS_FILE),
    traderConfig: readJson<Record<string, unknown>>(TRADER_CONFIG_FILE),
    parquetBytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  };
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/**
 * The dataset rows `frames.json` denotes — the derivation the fixture's
 * Parquet object was written from, repeated so the test can pin the committed
 * bytes against it.
 *
 * The `frameLine*` fields describe a WAL line that never existed on disk (the
 * fixture is synthetic; its README says so): they are the byte accounting of
 * `JSON.stringify(record) + "\n"`, so they are checkable rather than random.
 */
export function datasetRowsOf(frames: FixtureFrames): readonly DatasetRow[] {
  let offset = 0;
  return frames.frames.map((frame, index) => {
    const payloadUtf8 = JSON.stringify(frame.envelope);
    const record = {
      gatewayEpoch: frames.gatewayEpoch,
      ingestSeq: frame.ingestSeq,
      source: frame.source,
      endpoint: frame.endpoint,
      connectionId: frame.connectionId,
      subscriptionGeneration: frame.subscriptionGeneration,
      receivedAt: frame.receivedAt,
      receivedMonotonicNs: frame.receivedMonotonicNs,
      payloadUtf8,
      payloadSha256: sha256Hex(utf8(payloadUtf8)),
    };
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line, "utf8");
    const row: DatasetRow = {
      datasetRowOrdinal: index,
      segmentId: frames.segmentId,
      segmentIndex: 0,
      segmentRecordIndex: index,
      record,
      frameLineByteOffset: offset,
      frameLineByteLength: length,
      frameLineSha256: sha256Hex(utf8(line)),
      replayEligible: true,
      exclusionReason: null,
    };
    offset += length;
    return row;
  });
}

/**
 * The PAPER-only environment both roots are started in. The four repository
 * floors are stated as VALUES so a reader can see them; `apps/backtest-cli`'s
 * `checkBacktestSafety` and `apps/trader`'s `checkPaperTraderSafety` each
 * refuse anything above them, and neither can raise them.
 */
export function paperEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

/** Everything the assembly holds. */
export interface SharedCore {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly clock: ReplayClock;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Assembles the shared core exactly as `apps/trader/src/main.ts` and
 * `test/e2e/support/harness.ts` do — the venue built against a HOLDER the
 * trader fills the instant it exists, a `books` provider that looks the
 * market up through the trader on every read, and an `ExecutionPolicy` whose
 * `timeInForceFor` asks the trader for the value it recorded at plan time and
 * THROWS when there is none. A venue that answered either question itself
 * would be a second authority.
 *
 * The clock is `packages/simulation`'s replay clock, positioned at the
 * manifest's first recorded instant so `CoreLoop`'s constructor reads a
 * recorded value, and advanced from then on only by the shipped driver.
 */
export function assembleSharedCore(
  fixture: Fixture,
  accountingChecks: AccountingChecks = EVERY_FILL_ACCOUNTING_CHECKS,
): SharedCore {
  const clock = createReplayClock({
    receivedAt: fixture.manifest.eventRange.first.receivedAt,
    receivedMonotonicNs: "0",
  });
  if (!clock.ok) throw new Error(`the replay clock refused the manifest's first instant: ${clock.refusal.code}`);

  const simulation = (fixture.traderConfig["simulation"] ?? {}) as Record<string, unknown>;
  const fees = readFeeScheduleSnapshot(simulation["feeSchedule"] as FeeScheduleSnapshot);
  if (!fees.ok) throw new Error(`the fixture's fee snapshot was refused: ${fees.refusal.code}`);

  const wiring: { trader: PaperTrader | undefined } = { trader: undefined };
  const store = new MemoryTraderStore();
  const venue = new SimulatedVenue({
    clock: clock.value,
    // The ONE run mode `apps/trader/src/safety.ts` lets the core start in.
    // The plan carries it verbatim and the venue refuses a plan naming another
    // mode, so this is the core's mode, not a choice made here.
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: readString(simulation["fillModelVersion"], "tier0.unconfigured"),
      fillModelParametersHash: readString(simulation["fillModelParametersHash"], "0".repeat(64)),
    }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits(
      "no venue rate-limit budget is modelled: §9.13's budget is WP-310's package and does " +
        "not exist yet. This is the same disclosure apps/trader/src/main.ts carries.",
    ),
    policy: {
      timeInForceFor(order: PlannedOrderView): TimeInForce {
        const resolved = wiring.trader?.loop.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) {
          throw new Error(
            `no time-in-force was recorded for planned order ${order.plannedOrderId}; the ` +
              "composition root refuses to assume one (§12.1 ExecutionPolicy)",
          );
        }
        return resolved;
      },
      statedExpiryNsFor(): bigint | undefined {
        return undefined;
      },
      sameInstantAdditionsFor() {
        return "NOT_OBSERVED" as const;
      },
    },
    startingCash: readString(simulation["startingCash"], "0"),
    books: {
      book(input): BookView | undefined {
        const market = wiring.trader?.markets.get(input.marketId);
        if (market === undefined) return undefined;
        const tokenId = input.side === "YES" ? market.config.yesTokenId : market.config.noTokenId;
        return {
          internalMarketId: input.marketId,
          tokenId,
          top() {
            const top = market.bookFor(input.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market
              .bookFor(input.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });

  const created = createPaperTrader({
    env: paperEnvironment(),
    config: fixture.traderConfig,
    clock: clock.value,
    // UNCAST (SIM-2, `IF-19`): `SimulatedVenue` satisfies the loop's
    // `TraderVenue` port as written — `apps/trader/src/main.ts` passes it
    // uncast too — so a port change is a typecheck failure here, not a
    // runtime surprise. (This comment used to say main.ts cast it; it had
    // stopped doing so.)
    venue,
    store,
    idNamespace: ID_NAMESPACE,
    // `FOLD-1` (orchestrator call O1): the golden runs with the held ledger
    // view AND the held PnL streams checked against their rebuilds from zero
    // after EVERY fill (the default above); a mismatch latches a GLOBAL halt,
    // which the artefact's `halts=` line would show. A real backtest keeps
    // the PAPER cadence, which a caller may pass to pin exactly that.
    accountingChecks,
  });
  if (!created.ok) {
    throw new Error(
      `${created.refusal.code}: ${created.refusal.detail}\n  ${created.refusal.issues.join("\n  ")}`,
    );
  }
  wiring.trader = created.trader;
  return { trader: created.trader, venue, store, clock: clock.value };
}

/** What one replay through the shipped root left behind. */
export interface ReplayRun {
  readonly outcome: BacktestOutcome;
  /** Absent when the run was driven WITHOUT the shared core (the base-`1aa2238` behaviour). */
  readonly core: SharedCore | undefined;
  readonly driver: { readonly eventsIngested: number; readonly drains: number } | undefined;
}

/**
 * Replays the committed fixture through the SHIPPED root.
 *
 * `withCore: false` is the control arm — `runBacktest` exactly as base
 * `1aa2238` could run it, with no `coreLoop` and no venue — and it is kept in
 * the suite so the difference the round made is measured, not asserted.
 */
export async function replayThroughShippedRoot(options: {
  readonly withCore: boolean;
  readonly datasetDirectory?: string;
  /** `FOLD-1`: the core's check cadence; the every-fill test cadence when omitted. */
  readonly accountingChecks?: AccountingChecks;
}): Promise<ReplayRun> {
  const fixture = loadFixture();
  const datasetDirectory = options.datasetDirectory ?? FIXTURE_DIRECTORY;
  if (!options.withCore) {
    const outcome = await runBacktest({
      datasetDirectory,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: fixture.runPins,
      environment: paperEnvironment(),
    });
    return { outcome, core: undefined, driver: undefined };
  }
  const core = assembleSharedCore(fixture, options.accountingChecks);
  const driver = replayDrivenCoreLoop({ loop: core.trader.loop, clock: core.clock });
  const outcome = await runBacktest({
    datasetDirectory,
    normalizer: normalizedEnvelopeNormalizer(sha256Hex),
    runPins: fixture.runPins,
    environment: paperEnvironment(),
    // `FOLD-1` (`FOLD1-R1-3`): the driver bound the core's end-of-run rebuild
    // check to this coreLoop; the shipped root runs it — nothing to pass.
    coreLoop: driver.coreLoop,
    venue: core.venue,
  });
  return { outcome, core, driver: driver.observations() };
}

// ---------------------------------------------------------------------------
// The artefact
// ---------------------------------------------------------------------------

function decisionLine(decision: DecisionTrace): string {
  return [
    "decision",
    `seq=${String(decision.evaluationSeq)}`,
    `instance=${decision.instanceId}`,
    `run=${decision.runId}`,
    `callback=${decision.callback}`,
    `type=${decision.decisionType}`,
    `reasons=${decision.reasonCodes.join(",")}`,
    `intents=${decision.intentIds.join(",")}`,
    `snapshot=${decision.featureSnapshotRef}`,
    `sourceEvent=${decision.sourceEventId}`,
  ].join(" ");
}

function traceLine(trace: TraceLink): string {
  return [
    "trace",
    `sourceEvent=${trace.sourceEventId}`,
    `snapshot=${trace.featureSnapshotRef}`,
    `run=${trace.runId}`,
    `evaluationSeq=${String(trace.evaluationSeq)}`,
    `intent=${trace.intentId}`,
    `approved=${trace.approvedIntentId}`,
    `plan=${trace.executionPlanId}`,
    `attempt=${trace.submissionAttemptId}`,
    `order=${trace.venueOrderId}`,
    `fill=${trace.venueFillId}`,
    `ledgerFill=${trace.ledgerFillId}`,
    `transactions=${trace.ledgerTransactionIds.join(",")}`,
  ].join(" ");
}

/**
 * The canonical artefact: the §12.4 serialization the shipped root produced,
 * verbatim, followed by what the shared core produced — every persisted
 * decision, every §6 invariant 4 chain, the ledger projection, the §9.16
 * snapshots, the health counters and the store's write counts — one line per
 * fact, in production order. Nothing here is read from a clock, an environment
 * or the host: `DecisionTelemetry.evaluationDurationUs` is deliberately not
 * included for the reason `packages/strategy-runtime` gives ("machine-dependent
 * by nature").
 */
export function renderArtifact(run: ReplayRun): string {
  if (!run.outcome.ok) {
    throw new Error(`the replay was refused; there is no artefact to render: ${JSON.stringify(run.outcome)}`);
  }
  const lines: string[] = [ARTIFACT_FORMAT_ID, "--- simulation-run ---", run.outcome.result.serialization];
  if (run.core === undefined) {
    lines.push("--- core ---", "core absent", "end");
    return `${lines.join("\n")}\n`;
  }
  const loop = run.core.trader.loop;
  lines.push("--- decisions ---");
  for (const decision of loop.decisions()) lines.push(decisionLine(decision));
  lines.push("--- traces ---");
  for (const trace of loop.traces()) lines.push(traceLine(trace));

  const projection = projectionOf(loop.ledger());
  lines.push("--- ledger ---");
  lines.push(
    `ledger transactions=${String(projection.transactionCount)} ` +
      `unattributedActivity=${String(projection.unattributedActivity.length)} ` +
      `unexplainedMovements=${String(projection.unexplainedMovements.length)}`,
  );
  const positionKey = (line: { instanceId: string; marketId: string | null; assetId: string }): string =>
    `${line.instanceId}|${String(line.marketId)}|${line.assetId}`;
  const positions = [...projection.virtualPositions.values()].sort((a, b) =>
    positionKey(a) < positionKey(b) ? -1 : positionKey(a) > positionKey(b) ? 1 : 0,
  );
  for (const line of positions) {
    lines.push(
      `position instance=${line.instanceId} market=${String(line.marketId)} asset=${line.assetId} ` +
        `kind=${line.assetKind} balance=${line.balance}`,
    );
  }

  lines.push("--- pnl ---");
  for (const snapshot of run.core.store.pnlSnapshots) {
    lines.push(
      [
        "pnl",
        `scope=${snapshot.scope}`,
        `instance=${String(snapshot.instanceId)}`,
        `asOf=${snapshot.asOf}`,
        `realized=${snapshot.realizedPnl}`,
        `unrealizedMidpoint=${snapshot.unrealizedPnlMidpoint}`,
        `fees=${snapshot.feesPaid}`,
        `coreNet=${snapshot.coreNetPnl}`,
        `capitalCommitted=${snapshot.capitalCommitted}`,
      ].join(" "),
    );
  }

  const health = loop.health();
  lines.push("--- health ---");
  lines.push(
    [
      "health",
      `healthy=${String(health.healthy)}`,
      `halts=${health.halts.map((halt) => `${halt.code}@${halt.scope.kind}`).join(",")}`,
      `evaluations=${String(health.loop.evaluations)}`,
      `decisionsPersisted=${String(health.loop.decisionsPersisted)}`,
      `snapshotsUnavailable=${String(health.loop.snapshotsUnavailable)}`,
      `riskApprovals=${String(health.risk.approvals)}`,
      `riskRefusals=${String(health.risk.refusals)}`,
      `refusedExits=${String(health.risk.refusedExits)}`,
      `plansBuilt=${String(health.execution.plansBuilt)}`,
      `submissionsAccepted=${String(health.execution.submissionsAccepted)}`,
      `fillsObserved=${String(health.execution.fillsObserved)}`,
      `cancelsConfirmed=${String(health.execution.cancelsConfirmed)}`,
      `ledgerTransactions=${String(health.accounting.ledgerTransactions)}`,
      `pnlRecords=${String(health.accounting.pnlRecords)}`,
    ].join(" "),
  );
  lines.push("--- store ---");
  lines.push(
    `store decisions=${String(run.core.store.decisions.length)} ` +
      `checkpoints=${String(run.core.store.checkpoints.length)} ` +
      `ledgerTransactions=${String(run.core.store.transactions.length)} ` +
      `pnlSnapshots=${String(run.core.store.pnlSnapshots.length)}`,
  );
  lines.push("--- driver ---");
  lines.push(
    `driver eventsIngested=${String(run.driver?.eventsIngested ?? 0)} drains=${String(run.driver?.drains ?? 0)}`,
  );
  lines.push("end");
  return `${lines.join("\n")}\n`;
}

/** The venue's orders and fills, for assertions that read them directly. */
export function venueRecords(run: ReplayRun): {
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
} {
  if (run.core === undefined) return { orders: [], fills: [] };
  return { orders: run.core.venue.ordersSnapshot(), fills: run.core.venue.fills };
}
