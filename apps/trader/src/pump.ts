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
 *
 * ## A requested stop (`TRADER-SIGNALS`)
 *
 * `stopRequested` is read at the top of every iteration, AFTER the halt
 * check, so a latched halt always wins: a stop never turns a `HALTED` return
 * into a `STOPPED` one. Once it answers `true` the pump reads NO new batch and
 * returns `STOPPED`. The batch in hand when the request arrived — the signal
 * reaches the process between two awaits, so a batch already polled is in
 * hand — is not dropped: it was ingested, drained with every durable write
 * awaited, and its position recorded, all in the iteration that read it,
 * before the check runs. On the pipelined path the last batch's position is
 * recorded (`settle`) once its rows are durable, before `STOPPED` is
 * returned, exactly as at `MAX_POLLS`. The rule above holds either way: no
 * position is recorded ahead of a durable decision.
 *
 * The feed's batches end on frame boundaries (`adapters/redis-feed.ts`), so
 * the batch in hand is whole frames; the one exception, a frame longer than a
 * batch, is handed out in parts, and its unread remainder was never
 * delivered, so its position was never recorded and a consumer resuming
 * reads it whole.
 */

import type { HaltController } from "@polymarket-bot/trading-core";
import type { CoreLoop } from "@polymarket-bot/trading-core";
import type { FeedMark, MarketEventFeed } from "@polymarket-bot/trading-core";

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
    | "HALTED"
    /**
     * `TRADER-SIGNALS`: a stop was requested (`stopRequested`) with no halt
     * latched; no batch was read after it, and the batch in hand finished its
     * durable writes and recorded its position first. A new value of this
     * union, not a new run status: the word is the one `strategy.runs.status`
     * already uses for a run an operator ended (`internal.run_status`).
     */
    | "STOPPED";
}

export interface PumpOptions {
  readonly loop: CoreLoop;
  readonly feed: MarketEventFeed;
  readonly halts: HaltController;
  /** Upper bound on poll iterations. Required: an unbounded loop is not testable. */
  readonly maxPolls: number;
  /** Stop on the first empty batch. */
  readonly untilIdle?: boolean;
  /**
   * `TRADER-SIGNALS`: answers `true` once a stop is requested (SIGINT or
   * SIGTERM). Read before every poll, after the halt check; see the module
   * header. Absent: the pump never stops for a request.
   */
  readonly stopRequested?: () => boolean;
}

/**
 * Polls, ingests, drains and commits until a bound is reached or a halt latches.
 *
 * TOTAL with respect to the ports: `MarketEventFeed` answers data, so a
 * transport outage never throws through here — it becomes a halt record an
 * operator can read.
 */
export async function pump(options: PumpOptions): Promise<PumpResult> {
  if (options.loop.groupCommits && options.feed.mark !== undefined) {
    return await pumpPipelined(options);
  }
  let polls = 0;
  let ingested = 0;

  for (let iteration = 0; iteration < options.maxPolls; iteration += 1) {
    if (options.halts.anyHalt) {
      return { polls, ingested, stopped: "HALTED" };
    }
    // `TRADER-SIGNALS`: every batch read so far was drained durably and its
    // position recorded in its own iteration, so nothing is left in hand.
    if (options.stopRequested?.() === true) {
      return { polls, ingested, stopped: "STOPPED" };
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

/**
 * `THROUGHPUT-1a` — the pump for a GROUP-COMMITTING loop over a feed that can
 * mark positions: durability is PIPELINED one batch deep.
 *
 * The per-row path wrote every decision at its event, so a batch's rows were
 * durable when its drain returned, and the pump recorded its position right
 * then. A group-committing loop commits a batch's rows in a few transactions
 * (`loop.ts`, `GROUP_COMMIT_*`); waiting for them at every drain would leave
 * the process idle while PostgreSQL works. So this loop:
 *
 * 1. drains batch k WITHOUT waiting for its rows (the commits are requested,
 *    and run in one serialized chain while the next batch is read and
 *    evaluated);
 * 2. marks batch k's position and takes the loop's `durabilityMark()`;
 * 3. and only then — after reading and draining batch k+1 — waits for batch
 *    k's mark and records batch k's position.
 *
 * The rule the per-row path had is unchanged: A POSITION IS RECORDED ONLY
 * AFTER EVERY DECISION OF THE EVENTS BEFORE IT IS DURABLE. What changes is how
 * far behind the rows the recorded position may be — one batch more — which
 * after a crash means one more batch is read again (at-least-once, as before;
 * a restart is a new run, `BOOT-1`). Nothing is recorded after a halt; an
 * idle poll drains durably and records at once, so a quiet stream's position
 * catches up immediately; and every return other than `HALTED` records the
 * last batch first, so a caller sees what it always saw.
 */
async function pumpPipelined(options: PumpOptions): Promise<PumpResult> {
  const { loop, feed, halts } = options;
  let polls = 0;
  let ingested = 0;
  let pending: { readonly durable: Promise<boolean>; readonly mark: FeedMark } | undefined;

  /** Records the pending batch's position once its rows are durable. `false`: halted. */
  const settle = async (): Promise<boolean> => {
    if (pending === undefined) return true;
    const { durable, mark } = pending;
    pending = undefined;
    if (!(await durable) || halts.anyHalt) return false;
    const committed = await feed.commit(mark);
    if (!committed.ok) {
      halts.halt(
        { kind: "GLOBAL" },
        "TRANSPORT_UNAVAILABLE",
        `the event transport could not record the consumed position ` +
          `(${committed.failure.detail}); a consumer that cannot checkpoint would resume from ` +
          "an unknown position, which ADR-003 §3.4 rules out",
        loop.health().asOf,
      );
      return false;
    }
    return true;
  };

  for (let iteration = 0; iteration < options.maxPolls; iteration += 1) {
    if (halts.anyHalt) {
      return { polls, ingested, stopped: "HALTED" };
    }
    // `TRADER-SIGNALS`: the batch in hand was drained; its rows become durable
    // and its position is recorded here, as at `MAX_POLLS`, before the stop.
    if (options.stopRequested?.() === true) {
      if (!(await settle())) return { polls, ingested, stopped: "HALTED" };
      return { polls, ingested, stopped: "STOPPED" };
    }
    polls += 1;
    const batch = await feed.poll();
    if (!batch.ok) {
      halts.halt(
        { kind: "GLOBAL" },
        batch.failure.kind === "RESYNC_REQUIRED" ? "TRANSPORT_RESYNC_REQUIRED" : "TRANSPORT_UNAVAILABLE",
        batch.failure.kind === "RESYNC_REQUIRED"
          ? `the event transport requires a hard resync (${batch.failure.detail}); ADR-003 §3.3 ` +
            "forbids silent catch-up from an incomplete stream and §7.1 requires a new " +
            "authoritative snapshot before affected markets resume, so trading halts"
          : `the event transport is unavailable (${batch.failure.detail}); §4.2 makes a Redis ` +
            "outage a trading halt — no decision may be made on state that is no longer arriving",
        loop.health().asOf,
      );
      return { polls, ingested, stopped: "HALTED" };
    }

    if (batch.value.length === 0) {
      // An idle poll drains DURABLY (the default), then records any pending
      // batch: a quiet stream's rows and position are never left waiting.
      await loop.drain();
      if (!(await settle())) return { polls, ingested, stopped: "HALTED" };
      if (options.untilIdle === true) {
        return { polls, ingested, stopped: "IDLE" };
      }
      continue;
    }

    for (const event of batch.value) {
      if (!loop.ingest(event)) {
        return { polls, ingested, stopped: "HALTED" };
      }
      ingested += 1;
    }

    await loop.drain({ awaitDurable: false });
    if (halts.anyHalt) {
      return { polls, ingested, stopped: "HALTED" };
    }
    const mark = feed.mark?.();
    const durable = loop.durabilityMark();
    // The PREVIOUS batch: its rows have had this whole batch's read and drain
    // to become durable.
    if (!(await settle())) return { polls, ingested, stopped: "HALTED" };
    pending = mark === undefined ? undefined : { durable, mark };
  }

  if (!(await settle())) return { polls, ingested, stopped: "HALTED" };
  return { polls, ingested, stopped: "MAX_POLLS" };
}
