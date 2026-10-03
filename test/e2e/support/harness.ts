/**
 * `WP-250`'s harness: assembles the REAL merged composition and drives the
 * scenario through it.
 *
 * ## What is real, and what is not
 *
 * REAL, in every test in this tree: `packages/order-book`, `packages/features`,
 * `packages/strategy-runtime`, `packages/strategies/static-bracket`,
 * `packages/capital-allocator`, `packages/risk`, `packages/execution-planner`,
 * `packages/simulation`'s `SimulatedVenue`, `packages/ledger`, `packages/pnl`,
 * and `apps/trader`'s whole composition root and core loop.
 *
 * DOUBLED, and only these: the §12.1 `Clock`, the §4.2 event transport and the
 * §4.2 durable store — using `apps/trader`'s OWN in-memory implementations
 * (`@polymarket-bot/trader/testing`), which are the same doubles the shipped
 * process's integration suite uses. Nothing in this tree re-implements any
 * subject behaviour.
 *
 * ## The venue wiring is PRODUCTION's, not a fixture's
 *
 * `apps/trader/src/main.ts` gives the `SimulatedVenue` a `books` provider that
 * looks the market up through the trader on every read, and an `ExecutionPolicy`
 * whose `timeInForceFor` asks the trader for the value it recorded at plan time
 * and THROWS when there is none. Since `BACKTEST-2` this harness does not
 * reproduce either shape: it calls the core's ONE venue builder,
 * `buildSimulatedVenue` (ADR-022 D5), the call `main.ts` makes, so the seam
 * under test is the shipped one — a venue that answered either question itself
 * would be a second authority. What this harness still states is WHERE the
 * venue's settings come from (the operator document, read defensively, below)
 * and its one test-only option, `venueRetention`.
 *
 * ## One harness, any scenario (`BRACKET-1b`, E1)
 *
 * The scenario is a value ({@link Scenario}): its events, its operator
 * document, its constants and its golden. Every entry point defaults to the
 * original `WP-250` scenario ({@link PAPER_E2E_SCENARIO}), so a caller that
 * names none drives exactly the run it always drove.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. Nothing here opens a socket,
 * reads an ambient environment variable or touches the filesystem.
 */

import {
  readFeeScheduleSnapshot,
  type FeeScheduleSnapshot,
  type SimulatedFill,
  type SimulatedOrder,
  type SimulatedVenue,
  type SimulatedVenueOptions,
} from "@polymarket-bot/simulation";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  PER_FRAME_EVALUATION_CADENCE,
  buildSimulatedVenue,
  createPaperTrader,
  type CreateTraderResult,
  type EvaluationCadenceOption,
  type PaperTrader,
  type TraderStore,
} from "@polymarket-bot/trader";
import { ManualClock, MemoryEventFeed, MemoryTraderStore } from "@polymarket-bot/trader/testing";

import { PAPER_E2E_SCENARIO, paperEnvironment } from "./scenario.js";
import type { Scenario } from "./scenario-contract.js";

/** Everything the harness holds after a successful assembly. */
export interface Assembled {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly feed: MemoryEventFeed;
  readonly clock: ManualClock;
}

export interface AssembleOptions {
  /** The scenario to assemble and drive; the original `WP-250` one when absent. */
  readonly scenario?: Scenario;
  /** An operator document to use INSTEAD of the scenario's own. */
  readonly config?: Record<string, unknown>;
  readonly env?: Record<string, string | undefined>;
  readonly idNamespace?: string;
  /**
   * Bounds for the simulated venue's retained HISTORY (`SIM-2`), for a test
   * that must make the venue evict. Absent — as in every golden run — the
   * venue keeps its own defaults (`DEFAULT_VENUE_RETENTION`).
   */
  readonly venueRetention?: SimulatedVenueOptions["retention"];
  /**
   * `DURABLE-1`: the store the TRADER is handed, built around the harness's
   * in-memory store (the integration fixture's `wrapStore`, carried here).
   * Absent — as in every golden run — the trader writes to that store
   * directly. `parts.store` is always the in-memory store itself.
   */
  readonly wrapStore?: (store: MemoryTraderStore) => TraderStore;
  /**
   * `CADENCE-1` (ADR-026 D1.6): the evaluation cadence. Absent — as in every
   * golden run — the scenario's golden is REPRODUCED: the per-frame cadence it
   * was recorded under (ADR-024), declared with the golden's path
   * ({@link goldenReproduction}). A test of the cadence itself passes the
   * PAPER cadence (`PAPER_EVALUATION_CADENCE`).
   */
  readonly evaluationCadence?: EvaluationCadenceOption;
}

/**
 * `CADENCE-1` (ADR-026 D1.6): the cadence a scenario's golden was recorded
 * under — ADR-024's per-frame cadence, the value 0 — declared as a
 * reproduction of that golden, named by its repository path.
 */
export function goldenReproduction(scenario: Scenario): EvaluationCadenceOption {
  return { ...PER_FRAME_EVALUATION_CADENCE, reproduces: `test/replay-golden/paper-e2e/${scenario.goldenFile}` };
}

/** A string field of an unparsed document, or a stated fallback. */
function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Assembles the system. Returns the composition root's own result, refusal and
 * all, because a refusal is an outcome this suite may need to READ rather than
 * an exception it should hide.
 */
export function assemble(options: AssembleOptions = {}): {
  readonly result: CreateTraderResult;
  readonly parts: Assembled | undefined;
} {
  const scenario = options.scenario ?? PAPER_E2E_SCENARIO;
  const document = options.config ?? scenario.traderConfig();
  const clock = new ManualClock(scenario.clockStart);
  const store = new MemoryTraderStore();
  const feed = new MemoryEventFeed();

  /**
   * The venue's three inputs, read from the OPERATOR DOCUMENT as `main.ts`
   * reads them — defensively, because the venue is constructed BEFORE
   * `createPaperTrader` runs its doors and a refusal test hands this function a
   * document that is about to be refused.
   *
   * The fallbacks below are never used by a document that starts a trader:
   * `parseTraderConfig` requires every one of these fields and refuses a
   * document without them, so a venue built on a fallback is a venue that is
   * discarded moments later along with the refusal. Reading them defensively
   * rather than asserting them keeps `createPaperTrader` the SINGLE authority
   * on what a valid configuration is — a second opinion here would be a door
   * this suite invented.
   */
  const simulation = (document["simulation"] ?? {}) as Record<string, unknown>;
  // The cast is safe BECAUSE `readFeeScheduleSnapshot` is a DOOR: it validates
  // every field of whatever it is handed and answers a refusal rather than
  // throwing. Declaring the parameter as the validated type is the simulator's
  // choice; handing it an unparsed document is exactly what it exists for.
  const feeDocument = (simulation["feeSchedule"] ?? scenario.feeSnapshot()) as FeeScheduleSnapshot;
  const readFees = readFeeScheduleSnapshot(feeDocument);
  const fees = readFees.ok ? readFees : readFeeScheduleSnapshot(scenario.feeSnapshot());
  if (!fees.ok) {
    throw new Error(
      `the scenario's own fee snapshot was refused by the simulator: ${fees.refusal.code}`,
    );
  }

  // The venue `main.ts` builds, through the same builder; only the settings'
  // source (this document, read defensively above) and `venueRetention` are
  // this harness's own.
  const built = buildSimulatedVenue({
    clock,
    settings: {
      fillModelVersion: readString(simulation["fillModelVersion"], "tier0.unconfigured"),
      fillModelParametersHash: readString(simulation["fillModelParametersHash"], "0".repeat(64)),
      feeSchedule: fees.value,
      startingCash: readString(simulation["startingCash"], "0"),
    },
    ...(options.venueRetention === undefined ? {} : { retention: options.venueRetention }),
  });
  if (!built.ok) {
    throw new Error(
      `the venue builder refused the fee snapshot the simulator had accepted: ${built.refusal.code}`,
    );
  }
  const venue = built.venue;

  const result = createPaperTrader({
    env: options.env ?? paperEnvironment(),
    config: document,
    clock,
    venue: venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"],
    store: options.wrapStore === undefined ? store : options.wrapStore(store),
    idNamespace: options.idNamespace ?? scenario.idNamespace,
    // `FOLD-1` (orchestrator call O1): this harness checks the loop's held
    // ledger view AND its held PnL streams against their rebuilds from zero
    // after EVERY fill. A mismatch latches a GLOBAL halt, which the golden's
    // `health.halts` would show.
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    // `CADENCE-1`: the golden's reproduction unless the caller says otherwise.
    evaluationCadence: options.evaluationCadence ?? goldenReproduction(scenario),
  });
  if (!result.ok) return { result, parts: undefined };
  built.wiring.trader = result.trader;
  return { result, parts: { trader: result.trader, venue, store, feed, clock } };
}

export interface Run {
  /** The scenario this run was driven by — what the artefact capture reads it against. */
  readonly scenario: Scenario;
  readonly parts: Assembled;
  readonly trader: PaperTrader;
  /** The venue's orders at the end of the run, in the venue's own order. */
  readonly orders: readonly SimulatedOrder[];
  /** The venue's fills at the end of the run, in production order. */
  readonly fills: readonly SimulatedFill[];
}

/** Assembles, or throws with the refusal an operator would have seen. */
export function assembleOrThrow(options: AssembleOptions = {}): Assembled {
  const { result, parts } = assemble(options);
  if (!result.ok) {
    throw new Error(
      `${result.refusal.code}: ${result.refusal.detail}\n  ${result.refusal.issues.join("\n  ")}`,
    );
  }
  if (parts === undefined) throw new Error("assembled without parts");
  return parts;
}

/**
 * Ingests the scenario's recorded events and drains the loop, exactly as the
 * shipped `pump` does: offer to the bounded queue, then drain.
 */
export async function driveScenario(options: AssembleOptions = {}): Promise<Run> {
  const scenario = options.scenario ?? PAPER_E2E_SCENARIO;
  const parts = assembleOrThrow(options);
  for (const event of scenario.events()) {
    const accepted = parts.trader.loop.ingest(event);
    if (!accepted) {
      throw new Error(
        `the bounded ingest queue refused ${event.envelope.eventType} ` +
          `(${event.envelope.eventId}); §8.3 forbids dropping it, so the run cannot continue`,
      );
    }
  }
  await parts.trader.loop.drain();
  // `FOLD-1`: the end-of-run rebuild check, as every run ends with one.
  parts.trader.loop.checkAccountingRebuild("END_OF_RUN");
  return {
    scenario,
    parts,
    trader: parts.trader,
    orders: parts.venue.ordersSnapshot(),
    fills: parts.venue.fills,
  };
}
