/**
 * The WIRE door's ADR-020 conformance battery.
 *
 * `docs/contracts/schema-boundary.md` §3 records two rows that meet at this
 * door: `packages/domain` remains LIVE; `packages/event-bus` is CLOSED.
 * Both classes remain pinned here as regressions at the trader's own boundary:
 *
 * - `packages/domain` (frozen): "`skipChecks` makes both primitives accept
 *   `"NOT-A-UUID"` / `"yesterday"`". The row's own owner assignment is "closed
 *   by ADR-020 §3 **at each door**, not by editing the frozen package", and this
 *   is one of those doors;
 * - `packages/event-bus`: "under non-enumerable `skipChecks` an envelope with
 *   `eventId: "not-a-uuid"`, `receivedAt: "yesterday"` is accepted. Returns the
 *   caller's own object" — CLOSED by `WP-060-FU1` (`d869868`, 2026-09-11), so
 *   the transport now hands over a frozen prototype-free record. The cases
 *   below still run against this door, which is the trader's own boundary and
 *   does not assume a well-behaved sender.
 */

import { afterEach, describe, expect, it } from "vitest";

import { CONSUMED_EVENTS, readEventEnvelope } from "./event-door.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";

function validEnvelope(): Record<string, unknown> {
  return {
    eventId: "018f4a7e-6666-7abc-8def-000000000001",
    eventType: "BookSnapshot",
    schemaVersion: 1,
    source: "polymarket",
    sourceChannel: "market",
    receivedAt: "2026-03-04T12:00:01.000Z",
    receivedMonotonicNs: "1000000",
    gatewayEpoch: EPOCH,
    ingestSeq: "2",
    subscriptionGeneration: 1,
    payload: {
      internalMarketId: MARKET,
      tokenId: "111",
      bids: [{ price: "0.32", size: "200" }],
      asks: [{ price: "0.34", size: "200" }],
    },
  };
}

function pollute(key: string, value: unknown): () => void {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = false;
  descriptor.configurable = true;
  Object.defineProperty(Object.prototype, key, descriptor);
  return () => {
    delete (Object.prototype as Record<string, unknown>)[key];
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("readEventEnvelope", () => {
  it("accepts a valid envelope and answers a FROZEN, PROTOTYPE-FREE value (D3/D4)", () => {
    const read = readEventEnvelope(validEnvelope());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.envelope.eventType).toBe("BookSnapshot");
    expect(Object.isFrozen(read.envelope)).toBe(true);
    expect(Object.getPrototypeOf(read.envelope)).toBeNull();
  });

  it("REFUSES an event type this trader does not consume, BY NAME", () => {
    const read = readEventEnvelope({ ...validEnvelope(), eventType: "FeedConnected" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("EVENT_TYPE_NOT_CONSUMED");
    expect(read.refusal.detail).toContain("silent under-processing");
  });

  it("REFUSES an envelope with no readable routing pair", () => {
    const envelope = validEnvelope();
    delete envelope["eventType"];
    const read = readEventEnvelope(envelope);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("EVENT_UNROUTABLE");
  });

  it("REFUSES a malformed payload against the FROZEN §7.1 contract", () => {
    const envelope = validEnvelope();
    (envelope["payload"] as Record<string, unknown>)["bids"] = "not-a-list";
    const read = readEventEnvelope(envelope);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("EVENT_INVALID");
  });

  it("D1 — REFUSES a getter-bearing envelope, whose reads can disagree", () => {
    const envelope = validEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, "ingestSeq", {
      get: () => String((reads += 1)),
      enumerable: true,
      configurable: true,
    });
    const read = readEventEnvelope(envelope);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("EVENT_NOT_DATA");
  });

  it("D1 — REFUSES a Proxy", () => {
    const read = readEventEnvelope(
      new Proxy(validEnvelope(), { get: (target, key) => Reflect.get(target, key) as unknown }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("EVENT_NOT_DATA");
  });

  describe("the pollution battery — the two LIVE rows, as regressions", () => {
    it("`packages/domain` row: under skipChecks, a garbage eventId is STILL refused", () => {
      const envelope = { ...validEnvelope(), eventId: "NOT-A-UUID" };
      expect(readEventEnvelope(envelope).ok).toBe(false);
      cleanups.push(pollute("skipChecks", true));
      const polluted = readEventEnvelope(envelope);
      expect(polluted.ok).toBe(false);
      if (polluted.ok) return;
      expect(polluted.refusal.code).toBe("EVENT_INVALID");
    });

    it("`packages/event-bus` row: under skipChecks, `receivedAt: \"yesterday\"` is STILL refused", () => {
      const envelope = { ...validEnvelope(), receivedAt: "yesterday" };
      expect(readEventEnvelope(envelope).ok).toBe(false);
      cleanups.push(pollute("skipChecks", true));
      expect(readEventEnvelope(envelope).ok).toBe(false);
    });

    it("ADOPTION: a non-enumerable inherited required field does not satisfy the envelope", () => {
      const envelope = validEnvelope();
      delete envelope["gatewayEpoch"];
      expect(readEventEnvelope(envelope).ok).toBe(false);
      cleanups.push(pollute("gatewayEpoch", EPOCH));
      expect(readEventEnvelope(envelope).ok).toBe(false);
    });

    it("a VALID envelope reads to the SAME bytes under pollution", () => {
      const clean = readEventEnvelope(validEnvelope());
      expect(clean.ok).toBe(true);
      cleanups.push(pollute("skipChecks", true));
      cleanups.push(pollute("gatewayEpoch", "attacker-epoch"));
      const polluted = readEventEnvelope(validEnvelope());
      expect(polluted.ok).toBe(true);
      if (!clean.ok || !polluted.ok) return;
      expect(polluted.envelope.gatewayEpoch).toBe(EPOCH);
      expect(JSON.stringify(polluted.envelope)).toBe(JSON.stringify(clean.envelope));
    });

    it("NO THROW ESCAPES — including on the REFUSAL path under an inherited `get`", () => {
      // Measured first, asserted after: vitest's own assertion path builds
      // descriptor literals and throws under an inherited `get`, so an
      // assertion made while polluted would measure the assertion library.
      const inputs: readonly unknown[] = [
        undefined,
        null,
        7,
        "wire",
        [],
        {},
        validEnvelope(),
        { ...validEnvelope(), payload: { bogus: true } },
      ];
      const removeGet = pollute("get", () => undefined);
      const removeSkip = pollute("skipChecks", true);
      const thrown: string[] = [];
      const answers: boolean[] = [];
      for (const input of inputs) {
        try {
          answers.push(readEventEnvelope(input).ok);
        } catch (cause) {
          thrown.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
      removeSkip();
      removeGet();
      expect(thrown).toEqual([]);
      expect(answers).toHaveLength(inputs.length);
    });
  });

  it("the consumed set is the loop's own, and every entry resolves to a real contract", () => {
    // The door BUILDS an arena copy per consumed contract at module load, so an
    // entry the registry does not carry would already have failed the import.
    expect(CONSUMED_EVENTS.length).toBeGreaterThan(0);
    for (const consumed of CONSUMED_EVENTS) {
      expect(consumed.schemaVersion).toBe(1);
      expect(consumed.eventType.length).toBeGreaterThan(0);
    }
    expect(CONSUMED_EVENTS.map((consumed) => consumed.eventType)).toContain("BookSnapshot");
    expect(CONSUMED_EVENTS.map((consumed) => consumed.eventType)).toContain(
      "ReferenceTradeObserved",
    );
  });
});
