/**
 * REGRESSION: a Coinbase frame is routed by the `channel` it OWNS
 * (`docs/contracts/schema-boundary.md` §3, the `coinbase-adapter` row;
 * ADR-020 §1 class 1, "adoption").
 *
 * MEASURED AT BASE `5128d6c`: `CoinbaseFrameEnvelopeSchema.safeParse` reads
 * `channel` through the prototype chain, so a frame that declares no channel at
 * all classifies as `TICKER` under a non-enumerable inherited
 * `channel: "ticker"` — a frame routed as a channel it never declared, into a
 * recorded dataset.
 *
 * DEPLOYMENT READING: nothing on the wire can write `Object.prototype`; this
 * needs code already executing in the process. The row states that the check is
 * not load-bearing against an attacker already inside the process, not that a
 * venue can turn it off. It matters because the recorder is unattended.
 */

import { describe, expect, it } from "vitest";

import { classifyFrame } from "./frames.js";

const TICKER_EVENTS = [
  {
    type: "update",
    tickers: [
      {
        product_id: "BTC-USD",
        best_bid: "64000.10",
        best_ask: "64000.20",
        best_bid_quantity: "1",
        best_ask_quantity: "2",
      },
    ],
  },
];

/** An honest ticker frame, as documented. */
const HONEST_TICKER = JSON.stringify({
  channel: "ticker",
  timestamp: "2023-02-09T20:19:35.39625135Z",
  sequence_num: 7,
  events: TICKER_EVENTS,
});

/** The same frame with the one field that ROUTES it deleted. */
const NO_CHANNEL = JSON.stringify({
  timestamp: "2023-02-09T20:19:35.39625135Z",
  sequence_num: 7,
  events: TICKER_EVENTS,
});

function withInherited<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

describe("coinbase routing is decided by what the frame OWNS", () => {
  it("honest traffic is unchanged: a documented ticker frame still classifies", () => {
    const classified = classifyFrame(HONEST_TICKER);
    expect(classified.kind).toBe("TICKER");
  });

  it("a frame with no `channel` is refused clean", () => {
    const classified = classifyFrame(NO_CHANNEL);
    expect(classified.kind).toBe("REJECTED");
    if (classified.kind !== "REJECTED") throw new Error("unreachable");
    expect(classified.rejection).toBe("SHAPE");
  });

  it("…and is STILL refused under a non-enumerable inherited `channel`", () => {
    classifyFrame(HONEST_TICKER); // warm: this is an adoption probe
    const classified = withInherited("channel", "ticker", () => classifyFrame(NO_CHANNEL));
    expect(classified.kind).toBe("REJECTED");
    if (classified.kind !== "REJECTED") throw new Error("unreachable");
    expect(classified.rejection).toBe("SHAPE");
  });

  it("an honest frame under the same pollution classifies identically", () => {
    const clean = classifyFrame(HONEST_TICKER);
    const polluted = withInherited("channel", "market_trades", () =>
      classifyFrame(HONEST_TICKER),
    );
    expect(JSON.stringify(polluted)).toBe(JSON.stringify(clean));
  });

  // The other declared envelope keys are the same class, and `sequence_num` is
  // what gap detection is built on.
  it("neither `sequence_num` nor `timestamp` can be supplied from the prototype", () => {
    const noSequence = JSON.stringify({
      channel: "ticker",
      timestamp: "2023-02-09T20:19:35.39625135Z",
      events: TICKER_EVENTS,
    });
    const noTimestamp = JSON.stringify({
      channel: "ticker",
      sequence_num: 7,
      events: TICKER_EVENTS,
    });
    expect(withInherited("sequence_num", 7, () => classifyFrame(noSequence)).kind).toBe(
      "REJECTED",
    );
    expect(
      withInherited("timestamp", "2023-02-09T20:19:35.39625135Z", () =>
        classifyFrame(noTimestamp),
      ).kind,
    ).toBe("REJECTED");
  });

  // D2-INDEPENDENCE, and this is the property the door has INSTEAD of an
  // arena (see `./wire-door.ts`). One inherited `skipChecks` turns every
  // `.min()` in every schema in the process into a no-op (ADR-020 §1
  // class 4), so `channel: z.string().min(1)` stops refusing an empty
  // channel. The routing read restates the bound and is not switchable off.
  it("an empty `channel` is refused even with every `zod` format check disabled", () => {
    const emptyChannel = JSON.stringify({
      channel: "",
      timestamp: "2023-02-09T20:19:35.39625135Z",
      sequence_num: 7,
      events: TICKER_EVENTS,
    });
    const classified = withInherited("skipChecks", true, () => classifyFrame(emptyChannel));
    expect(classified.kind).toBe("REJECTED");
  });

  // The per-channel shapes adopt too: a trade with no `size` is an economic
  // field arriving from the prototype.
  it("a market-trades frame cannot take a trade `size` from the prototype", () => {
    const noSize = JSON.stringify({
      channel: "market_trades",
      timestamp: "2023-02-09T20:19:35.39625135Z",
      sequence_num: 8,
      events: [
        {
          type: "update",
          trades: [
            {
              trade_id: "12345",
              product_id: "BTC-USD",
              price: "64000.25",
              side: "BUY",
              time: "2023-02-09T20:19:35.39625135Z",
            },
          ],
        },
      ],
    });
    const classified = withInherited("size", "999999", () => classifyFrame(noSize));
    expect(classified.kind).toBe("REJECTED");
  });
});
