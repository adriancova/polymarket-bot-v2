/**
 * The replay-side driver of the shared paper core (BACKTEST-1, GOV-2B B3).
 *
 * `packages/simulation`'s `runReplay` positions the replay clock and the
 * simulated venue at every recorded event and then hands the event to a
 * caller-supplied {@link ReplayCoreLoop}. At base `1aa2238` nothing in the
 * repository supplied one: the hook was declared here (`run.ts`) and consumed
 * there (`replay.ts`), and every replay verified and drove the dataset with NO
 * decision, NO order and NO fill — handoff §7 checklist item 4's replay half
 * did not exist.
 *
 * This module is the half of that composition this app can own: it turns one
 * delivered replay event into one `ingest` + `drain` of a deterministic core
 * loop, exactly as `apps/trader/src/pump.ts` turns one polled transport batch
 * into `ingest` + `drain` of the same loop. §12.1: "Everything between event
 * input and the `ExecutionVenue` interface is shared with the live path." The
 * loop is not constructed here (see below); it is DRIVEN here.
 *
 * ## The core is taken structurally, and why it is not constructed here
 *
 * The shared core — books, features, the strategy runtime, Static Bracket,
 * the allocator, the risk engine, the planner, the ledger and the PnL fold —
 * is assembled by `apps/trader`'s `createPaperTrader`, whose own `ports.ts`
 * states the design: "the difference between a PAPER run against Redis and a
 * BACKTEST replay against a dataset is which implementations are handed to
 * `createPaperTrader` — not a second code path". That composition lives in a
 * layer-3 application, and `docs/contracts/dependency-direction.md` §2 rules
 * that "Nothing may depend on an app" (`check:deps` F13). So this app cannot
 * import it, and a second loop written here would be exactly the second code
 * path §12.1 forbids. {@link ReplayDrivenLoop} is therefore the STRUCTURAL
 * surface of `apps/trader`'s `CoreLoop` — the two methods `pump.ts` calls —
 * and the caller that holds both apps (today: the replay-golden suite under
 * `test/unit/simulation/`) hands the real loop in. Moving the composition
 * below layer 3 so that the CLI binary can construct it itself is the
 * follow-up the BACKTEST-1 round records in its handoff; nothing here changes
 * when it lands except who calls {@link replayDrivenCoreLoop}.
 *
 * ## Time enters only from recorded events
 *
 * The loop takes a §12.1 `Clock`. The one handed to it must be
 * `packages/simulation`'s {@link ReplayClock}, and this driver ADVANCES it to
 * the recorded instant of every event BEFORE the event is ingested, so every
 * `clock.now()` / `clock.monotonicNs()` the core reads while processing an
 * event answers that event's own recorded `receivedAt` /
 * `receivedMonotonicNs` (§6 invariant 15: a replay knows nothing the live
 * process did not know at the same point). A monotonic regression is the
 * clock's refusal (`REPLAY_CLOCK_NOT_MONOTONE`) and stops the run.
 *
 * ## A halt inside the core does not stop the replay
 *
 * `apps/trader`'s loop latches halts and gates its own decisions on them; the
 * accounting is deliberately not gated ("the books stay truthful; the strategy
 * does not act"). The live pump RETURNS on a halt so the process can exit for
 * an operator. A replay's operator reads the artefact, so this driver keeps
 * delivering every recorded event and the halt records reach the artefact
 * through the loop's own health surface — a halted replay is reported as a
 * halted replay, never silently as a short one (§8.3). The ONE thing that does
 * stop the run is the loop REFUSING an event at its bounded ingest queue: §8.3
 * forbids dropping it, the loop has already latched `QUEUE_BACKPRESSURE`, and
 * continuing would replay a stream with a hole in it.
 */

import {
  simulationFailure,
  simulationOk,
  type EventEnvelope,
  type RecordedEventIdentity,
  type ReplayClock,
  type ReplayCoreLoop,
  type ReplayEventContext,
  type SimulationResult,
} from "@polymarket-bot/simulation";

/**
 * One event as the core loop receives it: the §7.1 envelope plus the recorded
 * identity every simulated outcome is anchored to.
 *
 * Structurally `apps/trader`'s `IngestedEvent` (`ports.ts`), restated here
 * because this app may not import that one (see the module header). Both are
 * built from `packages/simulation`'s own `EventEnvelope` and
 * `RecordedEventIdentity`, so the two declarations cannot drift on any field
 * the core reads.
 */
export interface ReplayIngestedEvent {
  readonly envelope: EventEnvelope<unknown>;
  readonly identity: RecordedEventIdentity;
}

/**
 * The two methods of the shared core this driver calls — the same two
 * `apps/trader/src/pump.ts` calls on `CoreLoop`.
 *
 * `ingest` offers one event to the loop's bounded queue and answers whether it
 * was accepted; `drain` processes every queued event in delivery order and
 * never sorts (§8.4).
 */
export interface ReplayDrivenLoop {
  ingest(event: ReplayIngestedEvent): boolean;
  drain(): Promise<void>;
  /**
   * `FOLD-1` — the core's END-OF-RUN accounting rebuild check (`apps/trader`'s
   * `CoreLoop.checkAccountingRebuild`: its held ledger view, and its PnL
   * streams when that core checks them, against a rebuild from zero; a
   * mismatch latches the core's own GLOBAL halt).
   *
   * REQUIRED (`FOLD1-R1-3`): a core this driver drives keeps accounting, and
   * every run of it ends with this check — {@link replayDrivenCoreLoop} binds
   * it to the `coreLoop` it builds, and `runBacktest` runs it, so no caller
   * can leave it out. A structural double supplies one too.
   */
  checkAccountingRebuild(trigger: "END_OF_RUN"): unknown;
}

/** Inputs to {@link replayDrivenCoreLoop}. */
export interface ReplayDrivenCoreLoopOptions {
  /** The shared core — `apps/trader`'s `CoreLoop`, taken structurally. */
  readonly loop: ReplayDrivenLoop;
  /**
   * The §12.1 clock the core was constructed with. It is advanced to each
   * recorded event here, before the event is ingested.
   */
  readonly clock: ReplayClock;
}

/** What the driver counted, for a report. Never used to make a decision. */
export interface ReplayDriverObservations {
  readonly eventsIngested: number;
  readonly drains: number;
}

/** A {@link ReplayCoreLoop} plus the counters it kept. */
export interface ReplayDrivenCoreLoop {
  readonly coreLoop: ReplayCoreLoop;
  observations(): ReplayDriverObservations;
  /**
   * `FOLD-1` — the END OF THE RUN: runs the core's end-of-run accounting
   * rebuild check. BOUND to {@link coreLoop} (`FOLD1-R1-3`): `runBacktest`,
   * handed that `coreLoop`, calls it once the replay returns — the caller
   * wires nothing. Published for a caller that drives `runReplay` itself.
   */
  endOfRun(): void;
}

/**
 * `FOLD1-R1-3`: each driver's end-of-run check, keyed by the `coreLoop` it
 * built. A WeakMap, so the binding cannot be forged by a hand-built hook and
 * keeps nothing alive; {@link endOfRunBoundTo} is how `runBacktest` finds it.
 */
const END_OF_RUN_BY_CORE_LOOP = new WeakMap<ReplayCoreLoop, () => void>();

/**
 * The end-of-run check bound to a `coreLoop` {@link replayDrivenCoreLoop}
 * built, or `undefined` for any other hook — which `runBacktest` refuses to
 * drive, because it cannot know whether that core keeps accounting.
 */
export function endOfRunBoundTo(coreLoop: ReplayCoreLoop): (() => void) | undefined {
  return END_OF_RUN_BY_CORE_LOOP.get(coreLoop);
}

/**
 * Builds the `coreLoop` hook `runBacktest` / `runReplay` take, over a real
 * core loop and its replay clock.
 *
 * Per delivered event, in this order and with no branch on the event's
 * content: advance the clock to the event's recorded instant; offer the
 * envelope and its recorded identity to the loop; drain the loop. The order
 * is the live pump's, and it is what makes an `onFill` evaluation see the
 * position that includes the fill it is about (`WP-220` obligation 3): the
 * drain runs to completion — evaluation, allocation, risk, planning,
 * submission, the fill harvest and the accounting — before the next recorded
 * event exists.
 */
export function replayDrivenCoreLoop(options: ReplayDrivenCoreLoopOptions): ReplayDrivenCoreLoop {
  // `FOLD1-R1-3`: the type requires the check; a caller outside the type
  // system (or a cast) is refused here, before anything is driven, rather
  // than found out at the end of a run whose final check silently did not run.
  const loop: Partial<ReplayDrivenLoop> = options.loop;
  if (typeof loop.checkAccountingRebuild !== "function") {
    throw new TypeError(
      "replayDrivenCoreLoop: the core has no checkAccountingRebuild, so its run could not end with the " +
        "accounting rebuild check every run of a core ends with (FOLD-1); hand in the real CoreLoop",
    );
  }
  let eventsIngested = 0;
  let drains = 0;

  const coreLoop: ReplayCoreLoop = async (
    context: ReplayEventContext,
  ): Promise<SimulationResult<null>> => {
    const advanced = options.clock.advanceTo({
      receivedAt: context.record.frame.receivedAt,
      receivedMonotonicNs: context.record.frame.receivedMonotonicNs,
    });
    if (!advanced.ok) return advanced;

    const accepted = options.loop.ingest({
      envelope: context.envelope,
      identity: context.identity,
    });
    if (!accepted) {
      return simulationFailure(
        "SIMULATION_INTERNAL",
        "the shared core loop refused a recorded event at its bounded ingest queue; §8.3 " +
          "forbids dropping it and the loop has latched QUEUE_BACKPRESSURE, so the replay " +
          "stops here rather than continuing over a stream with a hole in it",
        {
          eventId: context.envelope.eventId,
          eventType: context.envelope.eventType,
          ingestSeq: context.identity.ingestSeq,
          datasetRowOrdinal: context.identity.datasetRowOrdinal,
        },
      );
    }
    eventsIngested += 1;

    await options.loop.drain();
    drains += 1;
    return simulationOk(null);
  };

  const endOfRun = (): void => {
    options.loop.checkAccountingRebuild("END_OF_RUN");
  };
  END_OF_RUN_BY_CORE_LOOP.set(coreLoop, endOfRun);

  return {
    coreLoop,
    observations: () => Object.freeze({ eventsIngested, drains }),
    endOfRun,
  };
}
