/**
 * `PROVENANCE-1` (`H1R1-PROVENANCE`) — every persisted decision carries its
 * triggering event's DISPATCH POSITION: the envelope's own §7.1 `eventId`,
 * `gatewayEpoch` and `ingestSeq`.
 *
 * H1 run 1 measured all 37,546 decisions with `gateway_epoch`, `ingest_seq`
 * and `feature_snapshot_id` NULL and only `source_event_id` set
 * (`docs/handoffs/H1-RUN-1.md`, finding 7). The cause was in the core loop:
 * `#buildEvaluationInput` gave the runtime `sourceEvent: { eventId }` and
 * nothing else, so the record the store binds (`decisionRow`) had no position
 * to write. The research worker's durable dispatch frontier reads exactly
 * those two columns, so no trader-responsible window could classify and no
 * raw WAL under one could expire (ADR-028 Amendment 1, rule 6).
 *
 * The REAL assembled core (the fixture's books, features, runtime, Static
 * Bracket, risk, planner, simulated venue, ledger); the store is the
 * in-memory double, so the property is read at the store PORT — what reaches
 * `persistDecision` — and the PostgreSQL files read the same values back from
 * the table.
 *
 * NON-VACUOUS: on `c5157c3` every assertion on `gatewayEpoch` / `ingestSeq`
 * below fails (`undefined`).
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { IngestedEvent } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import { GATEWAY_EPOCH, MARKET_ID, YES_TOKEN, ingested, recordedEvents } from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun } from "./support/run.js";

/** The envelope fields a decision's `sourceEvent` must equal. */
function positionOf(event: IngestedEvent): { eventId: string; gatewayEpoch: string; ingestSeq: string } {
  return {
    eventId: event.envelope.eventId,
    gatewayEpoch: event.envelope.gatewayEpoch,
    ingestSeq: event.envelope.ingestSeq,
  };
}

/** An event re-stamped with a dispatch position of its own, the recorded identity left as it was. */
function restamped(event: IngestedEvent, gatewayEpoch: string, ingestSeq: string, causationId?: string): IngestedEvent {
  const envelope: EventEnvelope<unknown> = {
    ...event.envelope,
    gatewayEpoch,
    ingestSeq,
    ...(causationId === undefined ? {} : { causationId }),
  };
  return { envelope, identity: event.identity };
}

describe("every persisted decision carries its triggering envelope's dispatch position (PROVENANCE-1)", () => {
  it("an event-triggered decision's sourceEvent is { eventId, gatewayEpoch, ingestSeq } of the event that triggered it", async () => {
    const events = recordedEvents();
    const run = await driveRecordedRun();
    const byId = new Map(events.map((event) => [event.envelope.eventId, event]));
    const decisions = run.parts.store.decisions.map((entry) => entry.record);

    const triggered = decisions.filter((record) => record.sourceEvent !== undefined);
    // The run evaluates on the events after both books arrived (the snapshots and the level change).
    expect(triggered.length).toBeGreaterThanOrEqual(3);
    for (const record of triggered) {
      const event = byId.get(record.sourceEvent?.eventId ?? "");
      expect(event, `decision ${String(record.evaluationSeq)} names an event the run never consumed`).toBeDefined();
      if (event === undefined) continue;
      expect({ ...record.sourceEvent }).toStrictEqual(positionOf(event));
    }
    // Every event-triggered decision carries the fixture's epoch, and its positions are the events'.
    expect(new Set(triggered.map((record) => record.sourceEvent?.gatewayEpoch))).toStrictEqual(new Set([GATEWAY_EPOCH]));
    expect(triggered.map((record) => record.sourceEvent?.ingestSeq)).toStrictEqual(
      triggered.map((record) => byId.get(record.sourceEvent?.eventId ?? "")?.envelope.ingestSeq),
    );
  });

  it("a decision the loop ORIGINATES (onFill, onOrderUpdate) carries no source event at all — not a blank position", async () => {
    const run = await driveRecordedRun();
    const originated = run.parts.store.decisions
      .map((entry) => entry.record)
      .filter((record) => record.callback === "onFill" || record.callback === "onOrderUpdate");
    // The fixture's entry fills, so there is at least the onFill delivery.
    expect(originated.length).toBeGreaterThanOrEqual(1);
    for (const record of originated) expect(record.sourceEvent).toBeUndefined();
  });

  it("the position is the ENVELOPE's own §7.1 fields, not the recorded identity the venue anchors to", async () => {
    // The live feed mints the recorded identity beside the envelope; the two
    // need not agree, and the decision must carry the envelope's (§7.1).
    const epoch = "018f4a7e-5555-7abc-8def-00000000beef";
    const events = recordedEvents().map((event) =>
      restamped(event, epoch, String(1000 + Number(event.envelope.ingestSeq))),
    );
    const run = assembleOrThrow();
    for (const event of events) expect(run.trader.loop.ingest(event)).toBe(true);
    await run.trader.loop.drain();
    const triggered = run.parts.store.decisions
      .map((entry) => entry.record)
      .filter((record) => record.sourceEvent !== undefined);
    expect(triggered.length).toBeGreaterThanOrEqual(3);
    for (const record of triggered) {
      expect(record.sourceEvent?.gatewayEpoch).toBe(epoch);
      expect(Number(record.sourceEvent?.ingestSeq)).toBeGreaterThan(1000);
      const event = events.find((candidate) => candidate.envelope.eventId === record.sourceEvent?.eventId);
      expect(record.sourceEvent?.ingestSeq).toBe(event?.envelope.ingestSeq);
      // ... and not the identity's.
      expect(record.sourceEvent?.ingestSeq).not.toBe(event?.identity.ingestSeq);
    }
  });

  it("a FRAME-coalesced evaluation carries the position of the frame's LAST event that owed it (ADR-024)", async () => {
    // Open the market and arm on both books, then ONE venue frame of two
    // level changes (one causationId): the loop evaluates once, at the
    // frame's close, as the second event.
    const opening = recordedEvents().slice(0, 5);
    const at = "2026-03-04T12:00:03.000Z";
    const first = restamped(
      ingested(
        "BookLevelChanged",
        { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, side: "BID", price: "0.32", size: "180" },
        { receivedAt: at, ingestSeq: 20 },
      ),
      GATEWAY_EPOCH,
      "20",
      `raw:${GATEWAY_EPOCH}:19`,
    );
    const second = restamped(
      ingested(
        "BookLevelChanged",
        { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, side: "BID", price: "0.31", size: "250" },
        { receivedAt: at, ingestSeq: 21 },
      ),
      GATEWAY_EPOCH,
      "21",
      `raw:${GATEWAY_EPOCH}:19`,
    );
    const run = assembleOrThrow();
    for (const event of [...opening, first, second]) expect(run.trader.loop.ingest(event)).toBe(true);
    await run.trader.loop.drain();
    const fromFrame = run.parts.store.decisions
      .map((entry) => entry.record)
      .filter((record) => record.sourceEvent?.eventId === first.envelope.eventId || record.sourceEvent?.eventId === second.envelope.eventId);
    // Exactly the one frame-close evaluation, keyed to the frame's last event.
    expect(fromFrame.map((record) => ({ ...record.sourceEvent }))).toStrictEqual([positionOf(second)]);
  });
});
