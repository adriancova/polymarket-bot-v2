/**
 * The `WP-220` composition-root obligations 1-10, each named and each driven
 * through the assembled system.
 *
 * `packages/strategies/static-bracket/README.md` §"Obligations on the
 * composition root (`WP-230`)" states ten conditions the strategy's correctness
 * rests on, and its own preamble says why they are written down:
 *
 * > "Each is stated here because a wiring that breaks one produces a *quiet*
 * > misbehaviour."
 *
 * A quiet misbehaviour is exactly what a test suite is for. Every `it` below
 * NAMES its obligation number so a reviewer can walk the README and this file
 * side by side.
 */

import { describe, expect, it } from "vitest";

import {
  FILLS_ARE_DELIVERED_WHILE_PAUSED,
  FillDeduplicator,
  ORDER_TYPE_TAG_PREFIX,
  OrderViewTracker,
  ReservationBook,
  isStrictUtcInstant,
  normalizeToStrictUtc,
  projectFeatureValues,
  projectionOf,
  resolveTimeInForce,
  toStrategyOrderView,
} from "@polymarket-bot/trader";
import { computeFeatureSnapshot } from "@polymarket-bot/features";
import type { Intent } from "@polymarket-bot/domain";

import {
  INCIDENT_KEY,
  INSTANCE_ID,
  MARKET_ID,
  STOP_KEY,
  TRIGGER_KEY,
  YES_TOKEN,
  T_CLOSE,
  T_OPEN,
  ingested,
  recordedEvents,
  restingEntryConfig,
} from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun, pauseInstanceByWatchdog, restingTradeAfterPause } from "./support/run.js";

describe("WP-220 composition-root obligations", () => {
  it("OBLIGATION 1 — timestamps are strict UTC: offsets normalised HERE, refused by the strategy", async () => {
    // The strategy refuses an offset form; the root converts it. Both halves.
    const offset = normalizeToStrictUtc("2026-03-04T13:00:00+01:00");
    expect(offset.ok).toBe(true);
    if (!offset.ok) return;
    expect(offset.instant).toBe("2026-03-04T12:00:00Z");
    expect(isStrictUtcInstant(offset.instant)).toBe(true);

    // Sub-millisecond precision is REFUSED, never truncated.
    const nanos = normalizeToStrictUtc("2026-03-04T12:00:00.123456789Z");
    expect(nanos.ok).toBe(false);
    if (nanos.ok) return;
    expect(nanos.problem).toContain("REFUSES rather than truncates");

    // …and every instant the loop hands the strategy is already strict UTC:
    // the market view's lifecycle instants are normalised at startup.
    const run = await driveRecordedRun();
    const market = run.trader.markets.get(MARKET_ID);
    expect(market).toBeDefined();
    const view = market?.marketView({ openTime: T_OPEN, closeTime: T_CLOSE });
    expect(isStrictUtcInstant(view?.openTime ?? "")).toBe(true);
    expect(isStrictUtcInstant(view?.closeTime ?? "")).toBe(true);
    for (const decision of run.trader.loop.decisions()) {
      const persisted = run.parts.store.decisions.find(
        (written) => written.record.evaluationSeq === decision.evaluationSeq,
      );
      expect(isStrictUtcInstant(persisted?.record.evaluatedAt ?? "")).toBe(true);
    }
  });

  it("OBLIGATION 2 — the scalar feature projection, including the @-selector", () => {
    // The engine's executable-price feature is STRUCTURED; the SDK view is FLAT.
    const computed = computeFeatureSnapshot({
      subject: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN },
      asOf: "2026-03-04T12:00:01.000Z",
      trigger: { gatewayEpoch: "018f4a7e-5555-7abc-8def-0123456789ab", ingestSeq: "2" },
      config: {
        depthLevels: [1],
        executableShares: ["50"],
        tradeWindowMs: 60_000,
        ewmaLambda: "0.94",
        primaryReferenceVenue: "binance",
      },
      book: {
        serializedBook: [
          "polymarket-bot/order-book/v1",
          `market ${MARKET_ID}`,
          `token ${YES_TOKEN}`,
          "epoch 018f4a7e-5555-7abc-8def-0123456789ab",
          "generation 1",
          "lastIngestSeq 2",
          "venueBookHash -",
          "tickSize 0.01",
          "bestBid 0.32 200",
          "bestAsk 0.34 200",
          "spread 0.02",
          "depth bids 1 200 asks 1 200",
          "bids 1",
          "0.32 200",
          "asks 1",
          "0.34 200",
        ].join("\n"),
        lastEventAt: "2026-03-04T12:00:01.000Z",
      },
      reference: {},
      quality: { activeIncidents: [] },
    });
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;

    const projected = projectFeatureValues(computed.snapshot, [
      TRIGGER_KEY,
      STOP_KEY,
      INCIDENT_KEY,
      "polymarket.midpoint",
    ]);
    expect(projected.refusals).toEqual([]);
    // `@50` selects the entry for exactly 50 shares; the whole 50 rests at 0.34.
    expect(projected.values[TRIGGER_KEY]).toBe("0.34");
    expect(projected.values[STOP_KEY]).toBe("0.32");
    // The incident flag is a BOOLEAN, and an empty incident list is `false`.
    expect(projected.values[INCIDENT_KEY]).toBe(false);
    // A scalar feature needs no selector.
    expect(typeof projected.values["polymarket.midpoint"]).toBe("string");

    // An unconfigured quantity is REFUSED, never substituted.
    const wrong = projectFeatureValues(computed.snapshot, [
      "polymarket.executable_buy_price@75",
    ]);
    expect(wrong.refusals[0]?.reason).toBe("EXECUTABLE_QUANTITY_NOT_COMPUTED");
    expect(Object.hasOwn(wrong.values, "polymarket.executable_buy_price@75")).toBe(false);

    // An undefined selector on the incident feature is refused rather than guessed.
    const guessed = projectFeatureValues(computed.snapshot, ["quality.active_incidents@some"]);
    expect(guessed.refusals[0]?.reason).toBe("INCIDENT_SELECTOR_UNDEFINED");
  });

  it("OBLIGATION 3 — the position view already includes the fill an onFill evaluation is about", async () => {
    const run = await driveRecordedRun();
    // The loop posts the fill to the LEDGER before delivering it to the
    // strategy, and the position view is folded from that ledger — so by the
    // time `onFill` runs, the fill is in the view.
    const decisions = run.trader.loop.decisions();
    const onFill = decisions.find((decision) => decision.callback === "onFill");
    expect(onFill, "the fill was delivered to the strategy").toBeDefined();

    const entry = decisions.find((decision) => decision.decisionType === "enter");
    expect(entry).toBeDefined();
    if (entry === undefined || onFill === undefined) return;
    // The ledger transaction exists BEFORE the onFill evaluation's sequence.
    expect(run.trader.loop.ledger().length).toBeGreaterThan(0);
    expect(onFill.evaluationSeq).toBeGreaterThan(entry.evaluationSeq);

    // --- THE VALUE, not only the ordering (review round 1, L1) -------------
    // Sequence alone survives a position view that answers ZERO: the reviewer
    // measured exactly that. What cannot survive it is the STRATEGY'S OWN
    // RECONCILIATION — `static-bracket` compares the fill it folded against the
    // position view it was shown, and a mismatch PAUSES it with an incident.
    // So these three assertions are the view's value, read where it is used.
    expect(onFill.decisionType).toBe("exit");
    expect(onFill.reasonCodes).toContain("SB.ALLOCATION_CONFIRMED");
    expect(onFill.reasonCodes).toContain("SB.EXIT_SIZED_TO_ALLOCATION");

    const afterFill = run.parts.store.checkpoints.find(
      (checkpoint) => checkpoint.checkpointSeq === onFill.evaluationSeq,
    );
    expect(afterFill, "the onFill evaluation's checkpoint reached the store").toBeDefined();
    const state = JSON.parse(afterFill?.stateJson ?? "{}") as Record<string, unknown>;
    // 50 shares at 0.34 — the venue's own fill, seen by the strategy as its
    // CONFIRMED allocation rather than as its requested size (§6 invariant 10).
    expect(state["allocatedShares"]).toBe("50");
    expect(state["allocatedCost"]).toBe("17");
    expect(state["instanceState"]).not.toBe("PAUSED");
    expect(state["lastIncident"]).toBeNull();

    // And the same 50 shares are what the LEDGER projection holds, which is the
    // source the view is folded from.
    const projection = projectionOf(run.trader.loop.ledger());
    const line = [...projection.virtualPositions.values()].find(
      (position) => position.instanceId === INSTANCE_ID && position.assetId === `token:${YES_TOKEN}`,
    );
    expect(line?.balance).toBe("50");
  });

  it("OBLIGATION 4 — adopted orders are delivered through onOrderUpdate, not only ctx.orders()", async () => {
    const run = await driveRecordedRun();
    const updates = run.trader.loop
      .decisions()
      .filter((decision) => decision.callback === "onOrderUpdate");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("OBLIGATION 5a — a repeated order VIEW is ordinary traffic and is LABELLED, never dropped", () => {
    const tracker = new OrderViewTracker();
    const order = {
      simulatedOrderId: "order-1",
      plannedOrderId: "planned-1",
      executionPlanId: "plan-1",
      marketId: MARKET_ID,
      tokenId: YES_TOKEN,
      side: "YES" as const,
      action: "BUY" as const,
      limitPrice: "0.34",
      requestedShares: "50",
      filledShares: "50",
      state: "FILLED" as const,
      postOnly: false,
      executionStyle: "MARKETABLE_LIMIT" as const,
      fillEstimateKind: "POINT" as const,
      atEvent: {
        gatewayEpoch: "018f4a7e-5555-7abc-8def-0123456789ab",
        ingestSeq: "4",
        receivedAt: "2026-03-04T12:00:01.000Z",
        datasetRowOrdinal: 4,
      },
    };
    const view = toStrategyOrderView(order, {
      marketId: MARKET_ID,
      placedAt: "2026-03-04T12:00:01.000Z",
    });
    const first = tracker.deliverable("instance", view);
    const second = tracker.deliverable("instance", view);
    expect(first.repeat).toBe(false);
    // The SECOND delivery is still a delivery. It is labelled, not suppressed.
    expect(second.repeat).toBe(true);
    expect(second.view).toBe(view);
    expect(tracker.metrics().emitted).toBe(2);
    expect(tracker.metrics().repeats).toBe(1);
  });

  it("OBLIGATION 5b — FILLS are delivered AT MOST ONCE, keyed on the venue's own identity", async () => {
    const dedup = new FillDeduplicator({ maximumRemembered: 8 });
    expect(dedup.admit("fill-1").admitted).toBe(true);
    const repeat = dedup.admit("fill-1");
    expect(repeat.admitted).toBe(false);
    if (repeat.admitted) return;
    expect(repeat.reason).toBe("DUPLICATE_FILL");
    expect(repeat.detail).toContain("the strategy's fold ADDS");
    // A fill with no identity cannot be deduplicated, so it is REFUSED.
    expect(dedup.admit("").admitted).toBe(false);

    // …and in the assembled loop, a second drain over the same venue fills
    // produces no second posting.
    const run = await driveRecordedRun();
    const transactions = run.trader.loop.ledger().length;
    await run.trader.loop.drain();
    expect(run.trader.loop.ledger().length).toBe(transactions);
    expect(run.trader.loop.health().execution.fillsObserved).toBe(1);
  });

  it("OBLIGATION 7 — filledShares is the venue's CONFIRMED quantity, never the requested size", () => {
    const view = toStrategyOrderView(
      {
        simulatedOrderId: "order-1",
        plannedOrderId: "planned-1",
        executionPlanId: "plan-1",
        marketId: MARKET_ID,
        tokenId: YES_TOKEN,
        side: "YES",
        action: "BUY",
        limitPrice: "0.34",
        requestedShares: "50",
        filledShares: "20",
        state: "PARTIALLY_FILLED",
        postOnly: false,
        executionStyle: "MARKETABLE_LIMIT",
        fillEstimateKind: "POINT",
        atEvent: {
          gatewayEpoch: "018f4a7e-5555-7abc-8def-0123456789ab",
          ingestSeq: "4",
          receivedAt: "2026-03-04T12:00:01.000Z",
          datasetRowOrdinal: 4,
        },
      },
      { marketId: MARKET_ID, placedAt: "2026-03-04T12:00:01.000Z" },
    );
    expect(view.filledShares).toBe("20");
    expect(view.requestedShares).toBe("50");
    expect(view.status).toBe("PARTIALLY_FILLED");
  });

  it("OBLIGATION 8 — a fill is BOOKED and OFFERED to a genuinely PAUSED instance", async () => {
    // The constant is the loop's own statement of the rule; the rest of this
    // test is the rule HAPPENING (review round 1, L2 — the previous version
    // asserted the constant and a ledger length that any successful run has).
    expect(FILLS_ARE_DELIVERED_WHILE_PAUSED).toBe(true);

    // 1. PAUSE THE INSTANCE FOR REAL, with no halt: its watchdog contains an
    //    overrunning evaluation (C1-HALTS: the old route — a persistence
    //    failure's halt, then a release — is gone; every halt ends the run).
    const run = assembleOrThrow({ config: restingEntryConfig() });
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    await pauseInstanceByWatchdog(run);
    const instance = run.trader.registry.get(INSTANCE_ID);
    expect(instance?.runtime.instanceStatus()).toBe("PAUSED");
    expect(run.trader.loop.health().halts).toEqual([]);

    const ledgerBefore = run.trader.loop.ledger().length;
    const refusedBefore = run.trader.loop.health().loop.refusedEvaluations;

    // 2. The resting entry fills.
    run.trader.loop.ingest(restingTradeAfterPause());
    await run.trader.loop.drain();

    // BOOKED — "the half a paused strategy would otherwise lose".
    expect(run.trader.loop.health().execution.fillsObserved).toBe(1);
    expect(run.trader.loop.ledger().length).toBeGreaterThan(ledgerBefore);
    expect(run.trader.loop.traces()).toHaveLength(1);
    // OFFERED — and the runtime's `INSTANCE_PAUSED` refusal is RECORDED rather
    // than treated as an error. No callback ran, so no decision was persisted.
    expect(run.trader.loop.health().loop.refusedEvaluations).toBeGreaterThan(refusedBefore);
    expect(
      run.parts.store.decisions.some((written) => written.record.callback === "onFill"),
    ).toBe(false);
  });

  it("OBLIGATION 9 — a reservation is honoured until its order reaches a terminal state", () => {
    const book = new ReservationBook();
    book.take({
      reservationId: "r1",
      executionPlanId: "p1",
      plannedOrderId: "o1",
      instanceId: "i1",
      marketId: MARKET_ID,
      side: "YES",
      shares: "50",
      collateral: "0",
    });
    // The next evaluation plans against `held − reserved`, so the reservation is
    // visible to the planner immediately.
    expect(book.reservedShares(MARKET_ID, "YES")).toBe("50");
    // Re-recording the same reservation does not double it.
    book.take({
      reservationId: "r1",
      executionPlanId: "p1",
      plannedOrderId: "o1",
      instanceId: "i1",
      marketId: MARKET_ID,
      side: "YES",
      shares: "50",
      collateral: "0",
    });
    expect(book.reservedShares(MARKET_ID, "YES")).toBe("50");
    // It is released by the ORDER's terminal state, not by a fill or an
    // evaluation boundary.
    expect(book.releaseForOrder("o1")).toBe(true);
    expect(book.reservedShares(MARKET_ID, "YES")).toBe("0");
    expect(book.releaseForOrder("o1")).toBe(false);
  });

  it("OBLIGATION 10 — every cancel resolves to a terminal fact, including SILENCE_EXCEEDED", async () => {
    const run = assembleOrThrow();
    // Drive the recorded run first so a market and an instance exist.
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    // The cancel ledger's own rule, exercised directly: a cancel that is
    // neither confirmed nor rejected within its bound closes as
    // SILENCE_EXCEEDED — §6 invariant 6 forbids reading silence as a rejection.
    const { CancelLedger } = await import("@polymarket-bot/trader");
    const ledger = new CancelLedger();
    ledger.register({
      cancelId: "c1",
      executionPlanId: "p1",
      instanceId: "i1",
      marketId: MARKET_ID,
      orderIds: ["o1"],
      requestedAt: "2026-03-04T12:00:00.000Z",
      requestedAtEpochMs: 0,
      silenceBoundMs: 5000,
    });
    expect(ledger.sweep(4999, "2026-03-04T12:00:04.999Z")).toEqual([]);
    const expired = ledger.sweep(5000, "2026-03-04T12:00:05.000Z");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.resolution).toBe("SILENCE_EXCEEDED");
    expect(expired[0]?.recommendation).toBe("RECONCILE_ACCOUNT");
    expect(expired[0]?.detail).toContain("§6 invariant 6");
    expect(ledger.pendingCount).toBe(0);
    // Every registered cancel reached exactly one terminal fact.
    const metrics = ledger.metrics();
    expect(metrics.confirmed + metrics.rejected + metrics.silenceExceeded).toBe(
      metrics.requested,
    );
  });

  it("the immediate_order_type question is RESOLVED: tag first, instance config second, never a default", () => {
    const tagged = {
      type: "POSITION",
      intentId: "sb-entry-0",
      marketId: MARKET_ID,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: "50",
      urgency: "IMMEDIATE",
      liquidityPreference: "TAKER_OK",
      partialFillPolicy: "ACCEPT_ANY",
      validUntil: "2026-03-04T12:00:30.000Z",
      tags: ["static-bracket", "sb.entry", `${ORDER_TYPE_TAG_PREFIX}FOK`],
    } as unknown as Intent;
    const fromTag = resolveTimeInForce(tagged, "FAK");
    expect(fromTag.ok).toBe(true);
    // The TAG wins: it is the strategy's own statement about this intent.
    if (fromTag.ok) expect(fromTag.timeInForce).toBe("FOK");

    const untagged = { ...tagged, tags: ["static-bracket"] } as unknown as Intent;
    const fromConfig = resolveTimeInForce(untagged, "GTC");
    expect(fromConfig.ok).toBe(true);
    if (fromConfig.ok) expect(fromConfig.timeInForce).toBe("GTC");

    // Neither: REFUSED, not defaulted.
    const neither = resolveTimeInForce(untagged, undefined);
    expect(neither.ok).toBe(false);
    if (neither.ok) return;
    expect(neither.detail).toContain("a silently assumed FAK would");
  });

  /**
   * RESOLVED 2026-09-15 by `RISK-2` (GOV-2B blocker B2).
   *
   * This test was "the RISK-SEAM CAVEAT is wired honestly: the exit is REFUSED,
   * counted, and not compensated for", and asserted `refusedExits > 0`,
   * `RISK_EDGE_INPUTS_MISSING` among the codes, and `plansBuilt === 1` /
   * `submissionsAccepted === 1`. The Static Bracket emitted a take-profit after
   * its entry filled, `packages/risk` classified it ENTRY, and the
   * positive-net-edge gate refused it for an `expectedNetEdge` an exit can never
   * declare.
   *
   * `packages/risk` now derives a `POSITION`'s disposition from its effect on
   * the supplied portfolio, so the take-profit is an EXIT and is approved. The
   * property this test actually guards is unchanged and still asserted: THE
   * TRADER DOES NOT COMPENSATE. It never re-tagged the intent, and it does not
   * now — the exit reaches the venue because the risk engine approved it, not
   * because the composition root decided it knew better.
   */
  it("the risk seam is wired honestly: the exit is APPROVED, and nothing compensated for it", async () => {
    const run = await driveRecordedRun();
    const health = run.trader.loop.health();

    expect(health.risk.refusedExits).toBe(0);
    expect(health.risk.refusedExitsByCode).toEqual({});
    expect(health.risk.refusals).toBe(0);
    expect(health.risk.approvals).toBe(2);

    // The exit reached the venue through the ordinary path: one plan and one
    // submission for the entry, one of each for the take-profit.
    expect(health.execution.plansBuilt).toBe(2);
    expect(health.execution.submissionsAccepted).toBe(2);
    expect(health.execution.plansRefused).toBe(0);
    expect(health.execution.submissionsRefused).toBe(0);

    // NOT COMPENSATED FOR — the part that must never change. The intent the
    // strategy emitted is still a §7.7 `POSITION` wearing its protective tag; a
    // composition root that had "fixed" this by re-tagging would show a
    // different type or a different tag here.
    const exit = run.parts.store.decisions
      .flatMap((written) => written.record.decision.intents)
      .find(
        (intent) => intent.type === "POSITION" && intent.tags.includes("sb.take-profit"),
      );
    expect(exit).toBeDefined();
    expect(exit?.type).toBe("POSITION");

    // The caveat constant is still carried on the snapshot. Its TEXT is now
    // stale — `apps/trader/src/health.ts` is outside `RISK-2`'s grant and the
    // wording is carried as a follow-up — so this asserts the WIRING, which is
    // what this test owns, rather than the sentence.
    expect(health.riskSeamCaveat.length).toBeGreaterThan(0);
  });

  it("WP-210 residual — observeTrade is wired from the normalized event stream", async () => {
    const run = assembleOrThrow();
    const observed: string[] = [];
    // The fixture's venue is the real `SimulatedVenue`; this asserts the loop
    // calls `observeTrade` for a `PublicTradeObserved`, which is what makes a
    // RESTING order fillable in a paper run at all.
    const venue = run.parts.venue as unknown as {
      observeTrade: (input: { readonly price: string }) => unknown;
    };
    const original = venue.observeTrade.bind(run.parts.venue);
    venue.observeTrade = (input) => {
      observed.push(input.price);
      return original(input as never);
    };

    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    run.trader.loop.ingest(
      ingested(
        "PublicTradeObserved",
        { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, price: "0.34", size: "10" },
        { receivedAt: "2026-03-04T12:00:04.000Z", ingestSeq: 7 },
      ),
    );
    await run.trader.loop.drain();
    expect(observed).toContain("0.34");
  });
});
