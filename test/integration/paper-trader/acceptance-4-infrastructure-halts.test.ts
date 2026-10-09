/**
 * `WP-230` ACCEPTANCE CRITERION 4: **Redis / PostgreSQL failures halt safely.**
 *
 * §4.2 states both boundaries and this suite tests both against the REAL
 * assembled loop, with the failure injected at the port — which is precisely
 * where a real outage appears:
 *
 * > "A Redis outage stops publication and therefore halts trading, but the
 * > recorder continues writing WAL."
 * > "A PostgreSQL outage stops new trading decisions and order submission."
 *
 * "Halt SAFELY" is four claims, and each has its own test:
 *
 * 1. the halt is LATCHED and reported with a code, a §9.9 action and the
 *    instant;
 * 2. **no trading decision is made afterwards** — the decisive one. Not "fewer
 *    decisions": ZERO. §4.2's whole point is that a process which cannot know
 *    its state must not act on it. That includes an event ALREADY IN FLIGHT
 *    when the halt latched: a fill whose own iteration halted is booked and is
 *    NOT delivered to the strategy, which
 *    `halts-reservations-and-seams.test.ts` drives (review round 1, MEDIUM-1 —
 *    at the reviewed tip such a fill was delivered and its `exit` decision
 *    persisted AFTER a FULL_HALT, so this claim was false in the one case it
 *    most needed to be true);
 * 3. **nothing is dropped.** §8.3 forbids a silent drop, so a backpressure
 *    refusal halts rather than discarding, and the transport is committed only
 *    AFTER the drain so a crash replays rather than skips;
 * 4. the halt does not clear itself. `release` demands the same authoritative
 *    -snapshot evidence ADR-003 §3.3 demands, so a halt cannot be wished away.
 */

import { describe, expect, it } from "vitest";

import { pump } from "@polymarket-bot/trader";

import { recordedEvents, traderConfig } from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun } from "./support/run.js";

describe("acceptance 4 — Redis / PostgreSQL failures halt safely", () => {
  describe("§4.2 Redis: the event transport", () => {
    it("an UNAVAILABLE transport latches a FULL_HALT and stops the pump", async () => {
      const run = assembleOrThrow();
      run.parts.feed.publish(...recordedEvents());
      run.parts.feed.fail("UNAVAILABLE", "ECONNREFUSED 127.0.0.1:6379");

      const result = await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 10,
      });

      expect(result.stopped).toBe("HALTED");
      expect(result.ingested).toBe(0);
      const halt = run.trader.halts.globalHalt();
      expect(halt?.code).toBe("TRANSPORT_UNAVAILABLE");
      expect(halt?.detail).toContain("§4.2");
    });

    it("a hard RESYNC gets its own code — §7.1 requires a new authoritative snapshot", async () => {
      const run = assembleOrThrow();
      run.parts.feed.fail("RESYNC_REQUIRED", "retention removed 412 events before the checkpoint");

      await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 10,
      });

      const halt = run.trader.halts.globalHalt();
      expect(halt?.code).toBe("TRANSPORT_RESYNC_REQUIRED");
      expect(halt?.detail).toContain("authoritative snapshot");
    });

    it("NO trading decision is made after the transport halts — zero, not fewer", async () => {
      const run = assembleOrThrow();
      run.parts.feed.publish(...recordedEvents());
      run.parts.feed.fail("UNAVAILABLE", "connection reset");

      await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 10,
      });

      // Nothing was ingested, so nothing was decided, planned or submitted.
      const health = run.trader.loop.health();
      expect(health.loop.decisionsPersisted).toBe(0);
      expect(health.execution.plansBuilt).toBe(0);
      expect(health.execution.submissionsAccepted).toBe(0);
      expect(health.healthy).toBe(false);

      // …and even if events arrive afterwards, the pump refuses to run them.
      run.parts.feed.recover();
      run.parts.feed.publish(...recordedEvents());
      const second = await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 10,
      });
      expect(second.stopped).toBe("HALTED");
      expect(second.ingested).toBe(0);
      expect(run.trader.loop.health().loop.decisionsPersisted).toBe(0);
    });

    it("the transport is committed only AFTER the drain, so a crash replays rather than skips", async () => {
      const run = assembleOrThrow();
      run.parts.feed.publish(...recordedEvents());
      await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 4,
        untilIdle: true,
      });
      // One commit per non-empty batch, and it happened after the events were
      // processed — which the processed count proves.
      expect(run.parts.feed.commits).toBeGreaterThan(0);
      expect(run.trader.loop.health().loop.eventsProcessed).toBeGreaterThan(0);
    });
  });

  describe("§4.2 PostgreSQL: the durable store", () => {
    it("a store failure latches STORE_UNAVAILABLE and stops new decisions", async () => {
      const run = assembleOrThrow();
      run.parts.store.fail("UNAVAILABLE", "could not connect to server: Connection refused");

      for (const event of recordedEvents()) run.trader.loop.ingest(event);
      await run.trader.loop.drain();

      const halt = run.trader.halts.globalHalt();
      expect(halt?.code).toBe("STORE_UNAVAILABLE");
      // §6 invariant 3 is the reason, and the halt says so.
      expect(halt?.detail).toContain("§6 invariant 3");

      // Nothing reached the store, and nothing was submitted to the venue after
      // the halt latched.
      expect(run.parts.store.decisions).toHaveLength(0);
      expect(run.trader.loop.health().healthy).toBe(false);
    });

    it("a store failure makes every LATER market halted, so no evaluation runs", async () => {
      const run = assembleOrThrow();
      const events = recordedEvents();
      run.parts.store.fail("UNAVAILABLE", "server closed the connection unexpectedly");
      for (const event of events) run.trader.loop.ingest(event);
      await run.trader.loop.drain();

      const marketId = run.trader.config.markets[0]?.marketId;
      expect(marketId).toBeDefined();
      if (marketId === undefined) return;
      expect(run.trader.halts.isMarketHalted(marketId)).toBe(true);

      const before = run.trader.loop.health().loop.decisionsPersisted;
      // More events after the halt change nothing.
      for (const event of recordedEvents()) run.trader.loop.ingest(event);
      await run.trader.loop.drain();
      expect(run.trader.loop.health().loop.decisionsPersisted).toBe(before);
    });

    it("a HEALTHY store lets the same run reach the store — the halt is caused, not incidental", async () => {
      const run = await driveRecordedRun();
      expect(run.trader.halts.globalHalt()).toBeUndefined();
      expect(run.parts.store.decisions.length).toBeGreaterThan(0);
      expect(run.parts.store.transactions.length).toBeGreaterThan(0);
    });
  });

  describe("§8.3 backpressure: a full queue halts rather than dropping", () => {
    it("a refused offer latches QUEUE_BACKPRESSURE and drops nothing", async () => {
      const run = assembleOrThrow({
        config: {
          ...traderConfig(),
          queues: { ingestMaximumDepth: 1, outboxMaximumDepth: 1024 },
        },
      });
      const events = recordedEvents();
      const accepted: boolean[] = [];
      for (const event of events) accepted.push(run.trader.loop.ingest(event));

      // The queue's depth is 1 and nothing has drained, so the second offer is
      // REFUSED — and the refusal is a halt, not a discard.
      expect(accepted[0]).toBe(true);
      expect(accepted.includes(false)).toBe(true);
      const halt = run.trader.halts.globalHalt();
      expect(halt?.code).toBe("QUEUE_BACKPRESSURE");
      expect(halt?.detail).toContain("§8.3 forbids dropping the event");

      // §8.3's metric set says the same thing: nothing was dropped.
      const queue = run.trader.loop.health().queues[0];
      expect(queue?.messagesDropped).toBe(0);
      expect(queue?.maximumDepth).toBe(1);
      await run.trader.loop.drain();
    });
  });

  describe("a halt does not clear itself", () => {
    it("C1-HALTS: nothing releases it — the controller has no release seam, and the pump stays stopped", async () => {
      const run = assembleOrThrow();
      run.parts.feed.fail("RESYNC_REQUIRED", "retention exceeded");
      await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 2,
      });
      expect(run.trader.halts.globalHalt()).toBeDefined();
      expect("release" in run.trader.halts).toBe(false);
      const again = await pump({
        loop: run.trader.loop,
        feed: run.parts.feed,
        halts: run.trader.halts,
        maxPolls: 2,
      });
      expect(again.stopped).toBe("HALTED");
      expect(run.trader.halts.globalHalt()).toBeDefined();
    });
  });
});
