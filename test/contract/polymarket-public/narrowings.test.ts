/**
 * ADR-002 §7 / `docs/contracts/protected-contracts.md` §9: the `WP-000`
 * fixture-only narrowings must NOT be inherited by a runtime parser.
 *
 * Each narrowing gets a POSITIVE test — an input the frozen fixture catalogue
 * would reject, which this adapter must accept — plus, where it applies, a test
 * that the accepted value is mapped to ABSENT before the domain boundary rather
 * than forwarded as `null` or `""`. That second half matters as much as the
 * first: "an adapter that forwards a raw `null` … into a domain schema has
 * skipped its own job".
 *
 * **One row is discharged in substance but not literally, and says so.**
 * Narrowing 3 (the condition-id byte length) is bounded here at the frozen
 * domain identifier cap of 200 characters, which §9's wording does not
 * sanction. Round-1 finding M2: the tests below assert that ACTUAL boundary —
 * accepted up to 200, reported as a typed problem past it — instead of
 * probing only lengths that happen to fit. The reconciliation is a
 * contract-owner item, not something this package may decide by editing
 * `packages/domain`.
 *
 * Two rows of the binding list have no surface in this package, and saying so
 * is part of discharging them:
 *
 * - **Trade-status spellings.** `TradeStatus` appears on the authenticated user
 *   channel and on REST trade reads, neither of which exists here. The public
 *   market channel's `last_trade_price` carries no status field at all.
 * - **The rewards block and Gamma reward decimals.** Those are Gamma market
 *   metadata, owned by the catalogue (`WP-110`), not by this feed. The
 *   JSON-number acceptance the row requires is nevertheless implemented once,
 *   in `normalizeVenueDecimal`, and is tested below so the obligation is
 *   discharged by behaviour rather than by a promise.
 */

import {
  normalizeMarketEvents,
  normalizeVenueDecimal,
  parseMarketEvent,
} from "@polymarket-bot/polymarket-public";
import {
  staticMarketDirectory,
  type TestMarketDefinition,
} from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

const MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000001",
  conditionId: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  yesTokenId: "1",
  noTokenId: "2",
};

/** A market whose condition id is 31 bytes, which the fixture catalogue rejects. */
const SHORT_CONDITION_MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000002",
  conditionId: `0x${"a".repeat(62)}`,
  yesTokenId: "3",
  noTokenId: "4",
};

function run(values: readonly unknown[]) {
  return normalizeMarketEvents(values, {
    directory: staticMarketDirectory({
      known: [MARKET, SHORT_CONDITION_MARKET],
      registrable: [SHORT_CONDITION_MARKET],
    }),
  });
}

describe("narrowing 1 — `null` where the SDK declares `.nullish()`", () => {
  const nullBearingBook = {
    event_type: "book",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    bids: [{ price: "0.08", size: "1" }],
    asks: [{ price: "0.09", size: "2" }],
    hash: null,
    timestamp: null,
    min_order_size: null,
    tick_size: null,
    neg_risk: null,
    last_trade_price: null,
  };

  it("accepts a book whose every optional field is null", () => {
    // `checks.ts` rejects a `null` for each of these. A runtime parser that
    // copied that strictness would reject valid venue traffic.
    expect(parseMarketEvent(nullBearingBook).status).toBe("parsed");
    const { events, problems } = run([nullBearingBook]);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("maps every accepted `null` to ABSENT before the domain boundary", () => {
    const { events } = run([nullBearingBook]);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("venueBookHash");
    expect(events[0]?.provenance).not.toHaveProperty("venueTimestamp");
    // Nothing null reached the payload at all.
    expect(JSON.stringify(payload)).not.toContain("null");
  });

  it("accepts a null-bearing price change and a null-bearing trade", () => {
    const { events, problems } = run([
      {
        event_type: "price_change",
        market: MARKET.conditionId,
        price_changes: [
          {
            asset_id: MARKET.yesTokenId,
            price: "0.08",
            size: "1",
            side: "BUY",
            hash: null,
            best_bid: null,
            best_ask: null,
          },
        ],
        timestamp: null,
      },
      {
        event_type: "last_trade_price",
        market: MARKET.conditionId,
        asset_id: MARKET.yesTokenId,
        price: "0.08",
        size: "10",
        fee_rate_bps: null,
        side: "BUY",
        timestamp: null,
        transaction_hash: null,
      },
    ]);
    expect(problems).toEqual([]);
    expect(events.map((event) => event.eventType)).toEqual([
      "BookLevelChanged",
      "PublicTradeObserved",
    ]);
  });

  it("accepts a lifecycle event whose nullish arrays are null", () => {
    const { events, problems } = run([
      {
        event_type: "market_resolved",
        id: "1",
        market: MARKET.conditionId,
        assets_ids: null,
        winning_asset_id: MARKET.noTokenId,
        winning_outcome: null,
        timestamp: "1782753357257",
        tags: null,
      },
    ]);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({ outcome: "NO_WIN" });
  });
});

describe("narrowing 2 — the wire empty string for an optional decimal", () => {
  it("accepts `\"\"` and maps it to ABSENT, never to zero", () => {
    // The SDK comment is verbatim: "The websocket serializes absent optional
    // decimals as an empty string … `best_bid`/`best_ask` when there is none".
    const { events, problems } = run([
      {
        event_type: "best_bid_ask",
        market: MARKET.conditionId,
        asset_id: MARKET.yesTokenId,
        best_bid: "",
        best_ask: "",
        spread: "",
        timestamp: "1782753357257",
      },
    ]);
    expect(problems).toEqual([]);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("bestBidPrice");
    expect(payload).not.toHaveProperty("bestAskPrice");
    expect(payload).not.toMatchObject({ bestBidPrice: "0" });
  });
});

describe("narrowing 3 — the 31/32-byte condition-id bound", () => {
  /**
   * The §9 row reads "Accept any hex condition id `ConditionIdResponseSchema`
   * accepts (no 31/32-byte bound at runtime)". The fixture catalogue's
   * narrowing is genuinely not inherited — every length below is accepted —
   * but the row is NOT discharged literally, and round-1 finding M2 is that
   * this suite used to imply it was:
   *
   * `normalizeVenueConditionId` is bounded at 200 characters, which is
   * `packages/domain`'s frozen `ConditionIdSchema` bound (`MAX_IDENTIFIER_LENGTH`),
   * not the venue's. The tests below assert the ACTUAL boundary rather than a
   * comfortable subset of it, and the reconciliation of that cap with §9 is a
   * contract-owner item (`IMPLEMENTATION_STATUS.md`, contract-owner item 3);
   * `packages/domain` is frozen and outside this package's allowed paths.
   */
  const DOMAIN_IDENTIFIER_CAP = 200;

  function announceMarket(conditionId: string) {
    const market: TestMarketDefinition = { ...SHORT_CONDITION_MARKET, conditionId };
    return normalizeMarketEvents(
      [
        {
          event_type: "new_market",
          id: "1",
          market: conditionId,
          assets_ids: [market.yesTokenId, market.noTokenId],
          outcomes: ["Yes", "No"],
          timestamp: "1782753357257",
        },
      ],
      { directory: staticMarketDirectory({ registrable: [market] }) },
    );
  }

  it("accepts a 31-byte hex condition id", () => {
    // `ConditionIdResponseSchema` "validates hex syntax without constraining
    // the condition ID byte length".
    const { events, problems } = run([
      {
        event_type: "market_resolved",
        id: "1",
        market: SHORT_CONDITION_MARKET.conditionId,
        assets_ids: [SHORT_CONDITION_MARKET.yesTokenId],
        winning_asset_id: SHORT_CONDITION_MARKET.yesTokenId,
        winning_outcome: "Yes",
        timestamp: "1782753357257",
      },
    ]);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({
      conditionId: SHORT_CONDITION_MARKET.conditionId,
      outcome: "YES_WIN",
    });
  });

  it("accepts every hex length up to the domain identifier bound, on the path that CHECKS it", () => {
    // `book` and `market_resolved` take their condition id from the catalogue,
    // so they never exercise this rule; `new_market` is the one event whose
    // `market` field is normalized, which is why the boundary is probed here.
    for (const length of [4, 42, 66, 98, DOMAIN_IDENTIFIER_CAP]) {
      const conditionId = `0x${"c".repeat(length - 2)}`;
      const { events, problems } = announceMarket(conditionId);
      expect(problems, `${String(length)} characters`).toEqual([]);
      expect(events[0]?.payload, `${String(length)} characters`).toMatchObject({ conditionId });
    }
  });

  it("REJECTS beyond 200 characters — a domain bound, not a venue fact — as an observable problem", () => {
    for (const length of [DOMAIN_IDENTIFIER_CAP + 1, 400]) {
      const conditionId = `0x${"c".repeat(length - 2)}`;
      // Never a throw: a length failure in a message loop that threw would be
      // the dropped event §8.3 forbids.
      expect(() => announceMarket(conditionId)).not.toThrow();
      const { events, problems } = announceMarket(conditionId);
      expect(events, `${String(length)} characters`).toEqual([]);
      expect(problems, `${String(length)} characters`).toHaveLength(1);
      expect(problems[0]?.code).toBe("INVALID_CONDITION_ID");
      // ...and never a silent drop: the raw event rides on the problem.
      expect(problems[0]?.raw).toMatchObject({ event_type: "new_market", market: conditionId });
      expect(problems[0]?.detail).toContain("200");
    }
  });

  it("does not claim the §9 row is discharged: the bound is recorded, not hidden", () => {
    // A test that only ever probed lengths BELOW the cap would report this
    // narrowing as fully inherited-not, which is what round 1 caught. The cap
    // is asserted explicitly so a change to it fails here.
    const atCap = `0x${"c".repeat(DOMAIN_IDENTIFIER_CAP - 2)}`;
    const pastCap = `${atCap}c`;
    expect(atCap).toHaveLength(DOMAIN_IDENTIFIER_CAP);
    expect(announceMarket(atCap).problems).toEqual([]);
    expect(announceMarket(pastCap).problems[0]?.code).toBe("INVALID_CONDITION_ID");
  });
});

describe("narrowing 4 — Gamma decimals arriving as JSON numbers", () => {
  it("accepts both published forms and normalizes to a canonical decimal string", () => {
    // ADR-001 §8.2: the SDK bridges them with `DecimalishSchema`. This package
    // parses no Gamma body, but the obligation is discharged by the one
    // normalizer both paths would use.
    expect(normalizeVenueDecimal(10_000)).toEqual({ status: "ok", value: "10000" });
    expect(normalizeVenueDecimal("10000")).toEqual({ status: "ok", value: "10000" });
    expect(normalizeVenueDecimal(0.2)).toEqual({ status: "ok", value: "0.2" });
    expect(normalizeVenueDecimal("0.20")).toEqual({ status: "ok", value: "0.2" });
  });
});

describe("narrowing 5 — epoch-like timestamps pinned to epoch forms", () => {
  const withTimestamp = (timestamp: unknown) => ({
    event_type: "book",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    bids: [],
    asks: [],
    timestamp,
  });

  it("accepts every form the SDK accepts, including the date-like string", () => {
    // `EPOCH_LIKE` in the fixture catalogue accepts a digit string or an
    // integer only; `EpochLikeToIsoDateTimeStringSchema` also accepts a
    // date-like string.
    const cases: readonly [unknown, string][] = [
      ["1782753357257", "2026-06-29T17:15:57.257Z"],
      [1782753357257, "2026-06-29T17:15:57.257Z"],
      [1782753357, "2026-06-29T17:15:57.000Z"],
      ["2026-06-29T17:15:57.257000Z", "2026-06-29T17:15:57.257Z"],
      ["2026-06-29", "2026-06-29T00:00:00.000Z"],
    ];
    for (const [timestamp, expected] of cases) {
      const { events, problems } = run([withTimestamp(timestamp)]);
      expect(problems, JSON.stringify(timestamp)).toEqual([]);
      expect(events[0]?.provenance.venueTimestamp, JSON.stringify(timestamp)).toBe(expected);
    }
  });
});

describe("narrowing 6 — enumerated free-string fields", () => {
  it("treats an unrecognized side as first-class UNKNOWN, not as a parse failure", () => {
    // The event still parses at the wire layer, and the unknown value is
    // reported with the raw frame attached, so the caller can open a
    // data-quality incident with its evidence.
    const event = {
      event_type: "price_change",
      market: MARKET.conditionId,
      price_changes: [
        { asset_id: MARKET.yesTokenId, price: "0.08", size: "1", side: "MIDDLE" },
      ],
      timestamp: "1782753357257",
    };
    expect(parseMarketEvent(event).status).toBe("parsed");

    const { events, problems } = run([event]);
    expect(events).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("UNKNOWN_SIDE");
    expect(problems[0]?.detail).toContain("MIDDLE");
    expect(problems[0]?.raw).toMatchObject({ side: "MIDDLE" });
  });

  it("treats an unmodelled event type as UNKNOWN rather than as corruption", () => {
    const { events, problems } = run([{ event_type: "some_future_event", payload: 1 }]);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("UNKNOWN_EVENT_TYPE");
    expect(problems[0]?.venueEventType).toBe("some_future_event");
  });

  it("ignores unknown keys instead of rejecting an event that grew one", () => {
    // Every SDK market-channel schema is a `z.object`, not a strict object. A
    // parser that rejected an added field would drop real data the day the
    // venue ships a feature. (The DOMAIN contracts stay strict — ADR-002 §3.)
    const { problems, events } = run([
      {
        event_type: "book",
        market: MARKET.conditionId,
        asset_id: MARKET.yesTokenId,
        bids: [],
        asks: [],
        some_new_field_the_venue_added: { nested: true },
      },
    ]);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });
});

describe("narrowing 7 — canonical decimal spellings", () => {
  it("accepts the non-canonical spellings the wire actually carries", () => {
    // The `[0, 1]` price bound is a domain constraint and stays; what must not
    // be inherited is the requirement that the WIRE be canonical.
    const { events, problems } = run([
      {
        event_type: "book",
        market: MARKET.conditionId,
        asset_id: MARKET.yesTokenId,
        bids: [{ price: "0.080", size: "1.500" }],
        asks: [{ price: ".090", size: "+2" }],
        last_trade_price: "0.090",
      },
    ]);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({
      bids: [{ price: "0.08", size: "1.5" }],
      asks: [{ price: "0.09", size: "2" }],
    });
  });

  it("still fails loudly on a price outside the unit interval", () => {
    const { events, problems } = run([
      {
        event_type: "book",
        market: MARKET.conditionId,
        asset_id: MARKET.yesTokenId,
        bids: [{ price: "1.5", size: "1" }],
        asks: [],
      },
    ]);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("PRICE_OUT_OF_RANGE");
  });
});
