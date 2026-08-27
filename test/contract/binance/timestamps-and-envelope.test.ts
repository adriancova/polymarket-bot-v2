/**
 * `WP-080` acceptance 2: venue and receipt timestamps are preserved.
 *
 * "Preserved" means BOTH survive and stay DISTINCT: a venue timestamp is the
 * venue's statement about when something happened; a receipt stamp is this
 * process's statement about when it learned. §7.1 gives them separate envelope
 * fields, and §6 invariant 15 forbids replay from using information that was not
 * available at the time — which is only checkable if the two are never merged.
 *
 * This file also proves the emissions are envelope-ready: adding exactly the
 * three gateway-assigned fields turns each one into a document the frozen
 * contract accepts.
 */

import {
  DOMAIN_EVENT_REGISTRY,
  type EventEnvelope,
} from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { frameText, framesFixture } from "./fixtures.js";
import { createHarness, open } from "./support.js";

const TRADE = framesFixture("trade-documented");
const BOOK_TICKER = framesFixture("book-ticker-documented");

const GATEWAY_EPOCH = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const EVENT_IDS = [
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a01",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a02",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a03",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a04",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a05",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a06",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a07",
  "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a08",
];

describe("venue and receipt timestamps", () => {
  it("keeps the trade's venue instant and the receipt instant apart", () => {
    const harness = createHarness({}, { startAt: "2026-08-27T10:00:00.000Z" });
    open(harness, "conn-timestamps");
    const frame = TRADE.frames[0];
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }
    const receipt = harness.clock.advance(250);
    const outcome = harness.feed.onFrame(frameText(frame), receipt);
    const emission = outcome.emissions.find(
      (entry) => entry.eventType === "ReferenceTradeObserved",
    );
    if (emission === undefined) {
      throw new Error("expected a ReferenceTradeObserved emission");
    }

    // `T` in the documented example is 1672515782136 ms.
    expect(emission.venueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(emission.receivedAt).toBe("2026-08-27T10:00:00.250Z");
    expect(emission.receivedMonotonicNs).toBe(receipt.receivedMonotonicNs);
    expect(emission.venueTimestamp).not.toBe(emission.receivedAt);
  });

  it("omits the venue timestamp for top of book, which carries none", () => {
    const harness = createHarness();
    open(harness, "conn-timestamps");
    const frame = BOOK_TICKER.frames[0];
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }
    const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
    const emission = outcome.emissions.find(
      (entry) => entry.eventType === "ReferenceTopOfBookChanged",
    );
    if (emission === undefined) {
      throw new Error("expected a ReferenceTopOfBookChanged emission");
    }
    expect("venueTimestamp" in emission).toBe(false);
    // The receipt stamp is still there — it is simply not a venue statement.
    expect(emission.receivedAt.length).toBeGreaterThan(0);
    expect(emission.receivedMonotonicNs.length).toBeGreaterThan(0);
  });

  it("reads the same epoch differently under a MICROSECOND connection", () => {
    const frame = TRADE.frames[0];
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }

    const millis = createHarness();
    open(millis, "conn-ms");
    const msEmission = millis.feed
      .onFrame(frameText(frame), millis.clock.advance(1))
      .emissions.find((entry) => entry.eventType === "ReferenceTradeObserved");

    const micros = createHarness({ timeUnit: "MICROSECOND" });
    open(micros, "conn-us");
    const usEmission = micros.feed
      .onFrame(frameText(frame), micros.clock.advance(1))
      .emissions.find((entry) => entry.eventType === "ReferenceTradeObserved");

    expect(msEmission?.venueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(usEmission?.venueTimestamp).toBe("1970-01-20T08:35:15.782136Z");
  });

  it("reports the signed venue-to-receipt lag as a queryable metric", () => {
    const harness = createHarness({}, { startAt: "2022-12-31T19:43:02.000Z" });
    open(harness, "conn-lag");
    const frame = TRADE.frames[0];
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }
    harness.feed.onFrame(frameText(frame), harness.clock.advance(500));

    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.lastVenueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(metrics.lastVenueToReceiptLagMs).toBe(364);
  });
});

describe("emissions are envelope-ready", () => {
  it("becomes a valid §7.1 envelope once the gateway adds its three fields", () => {
    const harness = createHarness();
    open(harness, "conn-envelope");
    for (const frame of [...TRADE.frames, ...BOOK_TICKER.frames]) {
      const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
      harness.emissions.push(...outcome.emissions);
    }

    expect(harness.emissions.length).toBeGreaterThan(0);
    harness.emissions.forEach((emission, index) => {
      const envelope = {
        ...emission,
        eventId: EVENT_IDS[index % EVENT_IDS.length],
        gatewayEpoch: GATEWAY_EPOCH,
        ingestSeq: String(index + 1),
      } as unknown as EventEnvelope<unknown>;

      const parsed = DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope);
      expect(parsed.eventType, `emission ${String(index)}`).toBe(emission.eventType);
    });
  });

  it("assigns no ordering field itself (ADR-002 §2.1: nothing else defines order)", () => {
    const harness = createHarness();
    open(harness, "conn-ordering");
    const frame = TRADE.frames[0];
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }
    const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
    for (const emission of [...outcome.emissions, ...harness.emissions]) {
      expect("gatewayEpoch" in emission).toBe(false);
      expect("ingestSeq" in emission).toBe(false);
      expect("eventId" in emission).toBe(false);
    }
  });

  it("restates the venue in the payload and agrees with the envelope source", () => {
    const harness = createHarness();
    open(harness, "conn-provenance");
    for (const frame of [...TRADE.frames, ...BOOK_TICKER.frames]) {
      const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
      for (const emission of outcome.emissions) {
        expect(emission.source).toBe("binance");
        const payload = emission.payload as { venue?: unknown };
        if ("venue" in payload) {
          expect(payload.venue).toBe("binance");
        }
      }
    }
  });
});
