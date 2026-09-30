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
 * ## The core is taken structurally, and who constructs it
 *
 * The shared core — books, features, the strategy runtime, Static Bracket,
 * the allocator, the risk engine, the planner, the ledger and the PnL fold —
 * is assembled by `createPaperTrader`, which lives in the layer-1 package
 * `@polymarket-bot/trading-core` since `CORE-MOVE` (ADR-022). Its own
 * `ports.ts` states the design: "the difference between a PAPER run against
 * Redis and a BACKTEST replay against a dataset is which implementations are
 * handed to `createPaperTrader` — not a second code path". Since `BACKTEST-2`
 * this app depends on that package downward (layer 3 → layer 1) and its `run`
 * command constructs the core itself (`assembly.ts`), so a second loop
 * written here would be exactly the second code path §12.1 forbids.
 * {@link ReplayDrivenLoop} stays the STRUCTURAL surface of the core's
 * `CoreLoop` — the methods `pump.ts` calls, plus the end-of-run check — so the
 * driver's own contract can be pinned against a double (`core-loop.test.ts`);
 * the real `CoreLoop` satisfies it uncast, which `assembly.ts` shows by
 * handing it in. The one caller that builds this driver in shipped code is
 * that assembly.
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
 * ## A halt inside the core STOPS the replay, as it stops the live pump (BT1-R3)
 *
 * The core latches halts and gates its own decisions on them; its accounting
 * is deliberately not gated ("the books stay truthful; the strategy does not
 * act"). The live pump RETURNS `HALTED` at a latched halt, at two points —
 * before it polls, when one is already latched (`apps/trader/src/pump.ts:84-86`),
 * and after the drain that latched one (`:127-130`) — so the process stops
 * feeding a core that may no longer decide. `BACKTEST-1` left this driver
 * delivering every recorded event after a halt, so fills for orders resting at
 * the venue could still book into a halted core, which the pump never lets
 * happen, and no test pinned it (BT1-R3).
 *
 * DECIDED (`BACKTEST-2`): this driver stops at the SAME two points, given the
 * core's halt latch (`halts`, the pump's own option). It refuses to ingest a
 * recorded event into a core that is already halted, and it stops the replay
 * after the drain that latched a halt. The stop is a refusal of the run
 * (`SIMULATION_INTERNAL`, the code the backpressure stop below already uses)
 * naming every latched halt as `CODE@SCOPE` and the event it stopped at, so a
 * halted replay is reported as a halted replay, never silently as a short one
 * (§8.3). No later recorded event reaches the core or the venue: `runReplay`
 * returns at the first refusal its hook answers. `runBacktest` still runs the
 * core's end-of-run accounting check once, as for any run refused part-way.
 *
 * A caller that hands NO `halts` gets no halt stop — the driver cannot see a
 * latch it was not given — and keeps `BACKTEST-1`'s behaviour. The shipped
 * caller, the `run` command's assembly (`assembly.ts`), always hands the
 * core's own `trader.halts`.
 *
 * The other stop is unchanged: the loop REFUSING an event at its bounded
 * ingest queue. §8.3 forbids dropping it, the loop has already latched
 * `QUEUE_BACKPRESSURE`, and continuing would replay a stream with a hole in it. *
 * ## One drain per recorded FRAME (`THROUGHPUT-2`, ADR-024)
 *
 * The core evaluates once per venue frame, and treats the end of what one
 * drain was handed as the end of a frame (`@polymarket-bot/trading-core`
 * `CoreLoop.drain`) — the same obligation the live Redis feed meets. A
 * recorded raw frame is one record, and a normalizer may derive several
 * envelopes from it (a two-token `price_change`), all stamped with the
 * record's identity; the core groups them by that identity
 * (`trading-core` `frames.ts`). So given a {@link ReplayFraming}, this driver
 * ingests each envelope as it arrives but DRAINS only at the last envelope of
 * its record: the core then evaluates the frame once, fully applied, exactly
 * as the live trader evaluates the frame the gateway published from that
 * record. Every envelope of one record carries the record's recorded instant
 * and identity, so deferring its drain to the record's last envelope moves
 * neither the replay clock nor the venue's position. Without a framing (a
 * caller that did not wrap its normalizer) every envelope is drained at once,
 * as before. The `run` command's assembly always wires one.
 */

import {
  simulationFailure,
  simulationOk,
  type EventEnvelope,
  type NormalizeOutcome,
  type RecordedEventIdentity,
  type ReplayClock,
  type ReplayCoreLoop,
  type ReplayEventContext,
  type ReplayNormalizer,
  type ReplayRecord,
  type SimulationResult,
} from "@polymarket-bot/simulation";

/**
 * One event as the core loop receives it: the §7.1 envelope plus the recorded
 * identity every simulated outcome is anchored to.
 *
 * Structurally the core's `IngestedEvent` (`@polymarket-bot/trading-core`
 * `ports.ts`), restated here so the driver's contract can be pinned against a
 * double (see the module header). Both are built from `packages/simulation`'s
 * own `EventEnvelope` and `RecordedEventIdentity`, so the two declarations
 * cannot drift on any field the core reads.
 */
export interface ReplayIngestedEvent {
  readonly envelope: EventEnvelope<unknown>;
  readonly identity: RecordedEventIdentity;
}

/**
 * The methods of the shared core this driver calls — the two
 * `apps/trader/src/pump.ts` calls on `CoreLoop`, and the end-of-run check.
 *
 * `ingest` offers one event to the loop's bounded queue and answers whether it
 * was accepted; `drain` processes every queued event in delivery order and
 * never sorts (§8.4).
 */
export interface ReplayDrivenLoop {
  ingest(event: ReplayIngestedEvent): boolean;
  drain(): Promise<void>;
  /**
   * `FOLD-1` — the core's END-OF-RUN accounting rebuild check (the core's
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

/**
 * The core's halt latch, as far as this driver reads it — structurally the
 * core's `HaltController` (`trader.halts`), which `pump.ts` takes as `halts`.
 */
export interface ReplayDriverHalts {
  /** True when the core is halted at any scope at all — the pump's own test. */
  readonly anyHalt: boolean;
  /** Every latched halt, for the refusal that names them. */
  records(): readonly { readonly code: string; readonly scope: { readonly kind: string } }[];
}

/**
 * `THROUGHPUT-2` (ADR-024): which delivered envelope is the LAST of its
 * recorded record — so the driver drains once per recorded frame. Built by
 * {@link recordFraming}; learns each record's envelopes through the
 * normalizer it wraps.
 */
export interface ReplayFraming {
  /**
   * The same normalizer — same `normalizerVersion`, same answer for every
   * record — that also tells this framing which envelope ends each record.
   * Hand THIS to the replay (`runBacktest`'s `normalizer`).
   */
  wrap(normalizer: ReplayNormalizer): ReplayNormalizer;
  /**
   * Does this delivered envelope end its record? `true` for a record the
   * wrapped normalizer never answered for (nothing is ever held back that
   * the framing cannot account for).
   */
  closesFrame(context: ReplayEventContext): boolean;
}

/** The record identity a framing keys by: `(gatewayEpoch, ingestSeq)`, unique per record. */
function recordKey(frame: { readonly gatewayEpoch: string; readonly ingestSeq: string }): string {
  return `${frame.gatewayEpoch}:${frame.ingestSeq}`;
}

/**
 * A {@link ReplayFraming} over the records a replay normalizes. It keeps, per
 * record not yet fully delivered, the `eventId` of the record's last
 * envelope — bounded by the records in flight (one, since the event source
 * delivers a record's envelopes before it normalizes the next).
 */
export function recordFraming(): ReplayFraming {
  const lastEnvelopeOf = new Map<string, string>();
  return {
    wrap(normalizer: ReplayNormalizer): ReplayNormalizer {
      return {
        normalizerVersion: normalizer.normalizerVersion,
        normalize(record: ReplayRecord): NormalizeOutcome {
          const outcome = normalizer.normalize(record);
          if (outcome.ok) {
            const last = outcome.envelopes[outcome.envelopes.length - 1];
            if (outcome.envelopes.length > 1 && last !== undefined) {
              lastEnvelopeOf.set(recordKey(record.frame), last.eventId);
            }
          }
          return outcome;
        },
      };
    },
    closesFrame(context: ReplayEventContext): boolean {
      const key = recordKey(context.record.frame);
      const last = lastEnvelopeOf.get(key);
      if (last === undefined) return true;
      if (last !== context.envelope.eventId) return false;
      lastEnvelopeOf.delete(key);
      return true;
    },
  };
}

/** Inputs to {@link replayDrivenCoreLoop}. */
export interface ReplayDrivenCoreLoopOptions {
  /** The shared core — the core's `CoreLoop`, taken structurally. */
  readonly loop: ReplayDrivenLoop;
  /**
   * The §12.1 clock the core was constructed with. It is advanced to each
   * recorded event here, before the event is ingested.
   */
  readonly clock: ReplayClock;
  /**
   * BT1-R3: the core's halt latch (`trader.halts`). Given, the driver stops
   * the replay where the live pump returns `HALTED` (module header). Absent,
   * it cannot see a halt and delivers every recorded event.
   */
  readonly halts?: ReplayDriverHalts;
  /**
   * `THROUGHPUT-2`: drain once per recorded frame (module header). Absent:
   * every envelope is drained as it arrives, as before.
   */
  readonly framing?: ReplayFraming;
}

/** The latched halts, as `CODE@SCOPE`, in the latch's own stable order. */
function describeHalts(halts: ReplayDriverHalts): string {
  return halts
    .records()
    .map((record) => `${record.code}@${record.scope.kind}`)
    .join(",");
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

  const halts = options.halts;
  // Read LIVE on every call: the drain between the two reads can latch one.
  const halted = (): boolean => halts?.anyHalt === true;
  const haltedAt = (
    context: ReplayEventContext,
    when: "before ingesting" | "after draining",
  ): SimulationResult<null> =>
    simulationFailure(
      "SIMULATION_INTERNAL",
      `the shared core is halted (${halts === undefined ? "" : describeHalts(halts)}) ${when} this ` +
        "recorded event; the live pump returns HALTED at this point (apps/trader/src/pump.ts), so the " +
        "replay stops here rather than feeding a halted core the rest of the recording (BT1-R3)",
      {
        halts: halts === undefined ? "" : describeHalts(halts),
        stoppedAt: when === "before ingesting" ? "BEFORE_INGEST" : "AFTER_DRAIN",
        eventId: context.envelope.eventId,
        eventType: context.envelope.eventType,
        ingestSeq: context.identity.ingestSeq,
        datasetRowOrdinal: context.identity.datasetRowOrdinal,
      },
    );

  const coreLoop: ReplayCoreLoop = async (
    context: ReplayEventContext,
  ): Promise<SimulationResult<null>> => {
    // `pump.ts:84-86`: a latched halt stops the pump before it polls again.
    if (halted()) return haltedAt(context, "before ingesting");

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

    // `THROUGHPUT-2`: an envelope that does not end its recorded frame is
    // queued, not drained — the core evaluates the frame at its last envelope.
    if (options.framing !== undefined && !options.framing.closesFrame(context)) {
      return simulationOk(null);
    }

    await options.loop.drain();
    drains += 1;
    // `pump.ts:127-130`: the drain that latched a halt is the pump's last.
    if (halted()) return haltedAt(context, "after draining");
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
