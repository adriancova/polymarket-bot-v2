/**
 * Binding narrowing rules, asserted as behaviour rather than trusted as prose.
 *
 * `docs/contracts/protected-contracts.md` §9 and ADR-002 §7: the `WP-000`
 * fixture catalog is deliberately stricter than the venue in places, and **a
 * runtime parser that inherits that strictness rejects valid venue traffic**.
 * The rules that touch RTDS are pinned here, each with its source.
 */

import {
  TwapObservationTracker,
  buildSubscriptionEntry,
  normalizeRtdsFrame,
  type RtdsNormalizationContext,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

import { frozenExample } from "./fixtures.js";

function context(): RtdsNormalizationContext {
  return {
    sourceChannel: "rtds:crypto-twap-ws",
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    subscribedTopics: new Set(["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"]),
    receivedEpochMs: 1785178800500,
    tracker: new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 }),
  };
}

const UPDATE = frozenExample("twap-update-30s") as {
  topic: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

describe("`filters` is OPTIONAL — the WP-000 round-4 correction", () => {
  it("omits the key rather than sending null or an empty string", () => {
    // Venue report §17: RTDS `filters` "has two documented forms and only two:
    // omit it … or send the compact JSON string. `null` is not among them."
    const entry = buildSubscriptionEntry({ windowSeconds: 30 });
    expect(entry).toEqual({ topic: "crypto_prices_twap_thirty", type: "update" });
    expect(JSON.stringify(entry)).not.toContain("filters");
  });

  it("matches the frozen omitted-filters example exactly", () => {
    const frozen = frozenExample("subscribe-request-all-symbols-no-filters") as {
      subscriptions: readonly unknown[];
    };
    expect(buildSubscriptionEntry({ windowSeconds: 60 })).toEqual(frozen.subscriptions[0]);
  });
});

describe("fixture-only strictness is not inherited by this runtime parser", () => {
  it("accepts an absent publisher timestamp, which the SDK type allows", () => {
    // The page's Python type is `timestamp: datetime | None`, so an envelope
    // without one is documented traffic, not a defect.
    const envelope = { topic: UPDATE.topic, type: UPDATE.type, payload: UPDATE.payload };
    expect(Object.hasOwn(envelope, "timestamp")).toBe(false);
    const { events, problems } = normalizeRtdsFrame([envelope], context());
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.provenance.venueTimestamp).toBeUndefined();
  });

  it("accepts a null publisher timestamp rather than rejecting the observation", () => {
    const { events, problems } = normalizeRtdsFrame([{ ...UPDATE, timestamp: null }], context());
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("accepts an undocumented extra key instead of rejecting the frame", () => {
    // A frozen fixture catalog may be strict about unknown keys; a runtime
    // parser that rejected a frame because the venue added a field would drop
    // valid traffic (§9, ADR-002 §7).
    const { events, problems } = normalizeRtdsFrame(
      [
        {
          ...UPDATE,
          sequence: 12,
          payload: { ...UPDATE.payload, source_feed_id: "0xabc" },
        },
      ],
      context(),
    );
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("imposes no symbol vocabulary of its own on inbound updates", () => {
    // No symbol enumeration is published ("Omit a symbol filter to receive
    // every available pair"), so an unfamiliar symbol is data, not an error.
    for (const symbol of ["sol/usd", "btc/eur", "xrp/usd", "wsteth/usd"]) {
      const { events, problems } = normalizeRtdsFrame(
        [{ ...UPDATE, payload: { ...UPDATE.payload, symbol } }],
        context(),
      );
      expect(problems).toEqual([]);
      expect(events[0]?.payload.symbol).toBe(symbol);
    }
  });

  it("still refuses what the domain itself refuses", () => {
    // Permissiveness stops at the domain boundary: `symbol` is bounded by
    // `NonEmptyStringSchema`, and an over-long one is a typed problem rather
    // than a contract violation raised later.
    const { events, problems } = normalizeRtdsFrame(
      [{ ...UPDATE, payload: { ...UPDATE.payload, symbol: "x".repeat(201) } }],
      context(),
    );
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_INVALID_SYMBOL");
  });
});

describe("the SDK's epoch-like tolerance is NOT inherited by the observation time", () => {
  // The opposite direction from the rules above, and it is the point: §9's
  // binding is that fixture-only STRICTNESS must not be inherited, not that
  // every tolerance found anywhere in the SDK must be. `payload.timestamp` is
  // documented as unix ms by the current page's direct-RTDS example and by the
  // frozen report §10.3, and it decides `windowEndAt`, `windowStartAt`,
  // ordering and duplicate identity — so it is read as unix ms and nothing
  // else (round-1 review finding M1).

  it("refuses a date-like observation timestamp instead of dating the window from it", () => {
    for (const timestamp of ["2026-07-27T19:00:00Z", "2026-07-27", "1785178800000.0"]) {
      const { events, problems } = normalizeRtdsFrame(
        [{ ...UPDATE, payload: { ...UPDATE.payload, timestamp } }],
        context(),
      );
      expect(events).toEqual([]);
      expect(problems[0]?.code).toBe("RTDS_INVALID_OBSERVATION_TIMESTAMP");
    }
  });

  it("never reinterprets a small observation timestamp as seconds", () => {
    // The generic parser multiplies anything below 1e12 by 1000. Here the value
    // is read as the milliseconds the venue documents, so the window it dates
    // is 1970 — wrong on its face and caught by any freshness threshold —
    // instead of a rescaled 2026 instant that would look right and be invented.
    const { events, problems } = normalizeRtdsFrame(
      [{ ...UPDATE, payload: { ...UPDATE.payload, timestamp: 1785178800 } }],
      context(),
    );
    expect(problems).toEqual([]);
    expect(events[0]?.payload.windowEndAt).toBe("1970-01-21T15:52:58.800Z");
  });

  it("keeps the tolerant reading for the publisher timestamp, which decides nothing", () => {
    const { events, problems } = normalizeRtdsFrame(
      [{ ...UPDATE, timestamp: "2026-07-27T19:00:00.123Z" }],
      context(),
    );
    expect(problems).toEqual([]);
    expect(events[0]?.provenance.venueTimestamp).toBe("2026-07-27T19:00:00.123Z");
    // And the observation time it did NOT come from is still the frozen one.
    expect(events[0]?.payload.windowEndAt).toBe("2026-07-27T19:00:00.000Z");
  });
});

describe("the exact-decimal boundary", () => {
  it("never lets a JavaScript number carry an economic value", () => {
    const { events } = normalizeRtdsFrame([UPDATE], context());
    expect(typeof events[0]?.payload.value).toBe("string");
    // And the canonical form is what the domain schema accepts, not a venue
    // spelling: no trailing zeros, no leading plus.
    expect(events[0]?.payload.value).toBe("65000.5");
  });

  it("accepts a non-canonical E18 spelling and canonicalizes it", () => {
    const { events } = normalizeRtdsFrame(
      [
        {
          ...UPDATE,
          payload: { ...UPDATE.payload, full_accuracy_value: "+065000500000000000000000" },
        },
      ],
      context(),
    );
    expect(events[0]?.payload.value).toBe("65000.5");
  });
});
