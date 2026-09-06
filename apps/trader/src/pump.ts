/**
 * The event pump: the process's outer loop around the deterministic core loop.
 *
 * §8.1 separates the two deliberately — "The core loop must never wait on
 * external I/O. Database writes, Redis reads, and venue calls are handled
 * through bounded adapters and completion events." So the pump is where the
 * awaiting happens (`MarketEventFeed.poll`), and {@link CoreLoop.drain} is
 * where the deciding happens, over a bounded queue that already holds the
 * events.
 *
 * ## §4.2's Redis boundary, implemented here
 *
 * > "A Redis outage stops publication and therefore halts trading, but the
 * > recorder continues writing WAL."
 *
 * The recorder is `apps/data-gateway`'s and is untouched by anything here. What
 * this process owes the sentence is the first half: a transport failure LATCHES
 * A HALT and the loop makes no further trading decision. Two failure kinds, two
 * codes, because they mean different things:
 *
 * - `UNAVAILABLE` → `TRANSPORT_UNAVAILABLE`. The stream is gone; the books stop
 *   moving; every decision from here would be made on state that is now stale
 *   by an unknown amount;
 * - `RESYNC_REQUIRED` → `TRANSPORT_RESYNC_REQUIRED`. ADR-003 §3.3's hard
 *   resync: retention removed events this consumer never read. §7.1 requires a
 *   NEW AUTHORITATIVE SNAPSHOT before affected markets resume, so this is not
 *   something the pump may retry through — it stops, and recovery is an
 *   operator act with evidence (`HaltController.release`).
 *
 * A halt is a LATCH, so `pump` returns rather than spinning: a process that
 * kept polling a halted transport would look alive while deciding nothing.
 *
 * ## The commit is after the drain, not before it
 *
 * `MarketEventFeed.commit` records that everything delivered is consumed. It
 * runs AFTER `drain`, so a crash between the poll and the drain replays the
 * batch rather than losing it — at-least-once delivery into a loop whose fill
 * seam is already at-most-once (`fills.ts`) and whose order views are
 * explicitly repeat-safe (`orders.ts`). Committing first would convert a crash
 * into a silent gap, which is the one thing §8.3 forbids.
 */

import type { HaltController } from "./halt.js";
import type { CoreLoop } from "./loop.js";
import type { MarketEventFeed } from "./ports.js";

export interface PumpResult {
  /** Batches polled, including the one that failed. */
  readonly polls: number;
  /** Events handed to the core loop's bounded queue. */
  readonly ingested: number;
  /** Why the pump stopped. */
  readonly stopped:
    /** The caller's bound was reached with the process still healthy. */
    | "MAX_POLLS"
    /** The feed answered no events and `untilIdle` was requested. */
    | "IDLE"
    /** A halt is latched; no further trading decision will be made. */
    | "HALTED";
}

export interface PumpOptions {
  readonly loop: CoreLoop;
  readonly feed: MarketEventFeed;
  readonly halts: HaltController;
  /** Upper bound on poll iterations. Required: an unbounded loop is not testable. */
  readonly maxPolls: number;
  /** Stop on the first empty batch. */
  readonly untilIdle?: boolean;
}

/**
 * Polls, ingests, drains and commits until a bound is reached or a halt latches.
 *
 * TOTAL with respect to the ports: `MarketEventFeed` answers data, so a
 * transport outage never throws through here — it becomes a halt record an
 * operator can read.
 */
export async function pump(options: PumpOptions): Promise<PumpResult> {
  let polls = 0;
  let ingested = 0;

  for (let iteration = 0; iteration < options.maxPolls; iteration += 1) {
    if (options.halts.anyHalt) {
      return { polls, ingested, stopped: "HALTED" };
    }
    polls += 1;
    const batch = await options.feed.poll();
    if (!batch.ok) {
      options.halts.halt(
        { kind: "GLOBAL" },
        batch.failure.kind === "RESYNC_REQUIRED"
          ? "TRANSPORT_RESYNC_REQUIRED"
          : "TRANSPORT_UNAVAILABLE",
        batch.failure.kind === "RESYNC_REQUIRED"
          ? `the event transport requires a hard resync (${batch.failure.detail}); ADR-003 §3.3 ` +
            "forbids silent catch-up from an incomplete stream and §7.1 requires a new " +
            "authoritative snapshot before affected markets resume, so trading halts"
          : `the event transport is unavailable (${batch.failure.detail}); §4.2 makes a Redis ` +
            "outage a trading halt — no decision may be made on state that is no longer arriving",
        options.loop.health().asOf,
      );
      return { polls, ingested, stopped: "HALTED" };
    }

    if (batch.value.length === 0) {
      // The drain still runs: a previous batch may have left work, and the
      // cancel sweep is driven by processed events. An idle poll is not an idle
      // process.
      await options.loop.drain();
      if (options.untilIdle === true) {
        return { polls, ingested, stopped: "IDLE" };
      }
      continue;
    }

    for (const event of batch.value) {
      if (!options.loop.ingest(event)) {
        // §8.3: the queue refused, the loop latched `QUEUE_BACKPRESSURE`, and
        // the event is NOT dropped — it is simply never accepted, and the
        // process halts rather than continuing without it.
        return { polls, ingested, stopped: "HALTED" };
      }
      ingested += 1;
    }

    await options.loop.drain();
    if (options.halts.anyHalt) {
      return { polls, ingested, stopped: "HALTED" };
    }

    const committed = await options.feed.commit();
    if (!committed.ok) {
      options.halts.halt(
        { kind: "GLOBAL" },
        "TRANSPORT_UNAVAILABLE",
        `the event transport could not record the consumed position ` +
          `(${committed.failure.detail}); a consumer that cannot checkpoint would resume from ` +
          "an unknown position, which ADR-003 §3.4 rules out",
        options.loop.health().asOf,
      );
      return { polls, ingested, stopped: "HALTED" };
    }
  }

  return { polls, ingested, stopped: "MAX_POLLS" };
}
