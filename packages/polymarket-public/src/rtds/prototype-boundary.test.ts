/**
 * REGRESSION: the RTDS wire door does not route a frame by a `type` it never
 * declared (`docs/contracts/schema-boundary.md` §3, the `polymarket-public`
 * row; ADR-020 §1 class 1, "adoption").
 *
 * MEASURED AT BASE `5128d6c`: `RtdsEnvelopeSchema.safeParse` reads its declared
 * keys through the prototype chain, so a frame carrying `topic` and `payload`
 * but NO `type` parses as `type: "update"` when `Object.prototype` carries a
 * non-enumerable `type`, and `normalizeEnvelope` publishes a
 * `ReferenceTwapObserved` for a frame that never said it was an update.
 *
 * DEPLOYMENT READING, required whenever this row is quoted: nothing on the wire
 * can write `Object.prototype`. Reaching this needs code already executing in
 * the process. The row says "this check is not load-bearing against an attacker
 * already inside the process", not "a venue can turn this off". It still
 * matters because the recorder runs unattended, so nobody is watching when the
 * check stops firing.
 */

import { describe, expect, it } from "vitest";

import { normalizeRtdsFrame, type RtdsNormalizationContext } from "./normalize.js";
import { TwapObservationTracker } from "./observations.js";
import { RtdsEnvelopeSchema } from "./venue.js";

const BOTH_TOPICS = new Set(["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"]);

/** The documented 30-second example, verbatim from the official page. */
const THIRTY_UPDATE = {
  topic: "crypto_prices_twap_thirty",
  type: "update",
  timestamp: 1785178800123,
  payload: {
    symbol: "btc/usd",
    value: 65000.5,
    full_accuracy_value: "65000500000000000000000",
    timestamp: 1785178800000,
    window_s: 30,
  },
};

/** The same frame with the one field that ROUTES it deleted. */
const NO_TYPE = {
  topic: THIRTY_UPDATE.topic,
  timestamp: THIRTY_UPDATE.timestamp,
  payload: THIRTY_UPDATE.payload,
};

function context(): RtdsNormalizationContext {
  return {
    sourceChannel: "rtds:crypto-twap-ws",
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    subscribedTopics: BOTH_TOPICS,
    receivedEpochMs: 1785178800200,
    tracker: new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 }),
  };
}

function normalizeOne(value: unknown) {
  return normalizeRtdsFrame([value], context());
}

/**
 * Installs a NON-ENUMERABLE inherited property for the duration of `body`.
 *
 * Non-enumerable is the variant to design against (`schema-boundary.md` §2): it
 * is read by every property read the library performs and is invisible to every
 * enumeration-based guard.
 */
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

describe("rtds routing is decided by what the frame OWNS", () => {
  it("honest traffic is unchanged: the documented example still normalizes", () => {
    const { events, problems } = normalizeOne(THIRTY_UPDATE);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.value).toBe("65000.5");
  });

  it("a frame with no `type` is refused clean", () => {
    const { events, problems } = normalizeOne(NO_TYPE);
    expect(events).toEqual([]);
    expect(problems.map((problem) => problem.code)).toEqual(["RTDS_INVALID_ENVELOPE"]);
  });

  it("…and is STILL refused under a non-enumerable inherited `type`", () => {
    // Warm first: this is an adoption probe, not a cold-lazy one.
    normalizeOne(THIRTY_UPDATE);
    const { events, problems } = withInherited("type", "update", () => normalizeOne(NO_TYPE));
    expect(events).toEqual([]);
    expect(problems.map((problem) => problem.code)).toEqual(["RTDS_INVALID_ENVELOPE"]);
  });

  it("an honest frame under the same pollution normalizes identically", () => {
    const clean = normalizeOne(THIRTY_UPDATE);
    const polluted = withInherited("type", "update", () => normalizeOne(THIRTY_UPDATE));
    expect(JSON.stringify(polluted.events)).toBe(JSON.stringify(clean.events));
    expect(polluted.problems).toEqual(clean.problems);
  });

  // The row's second half: the TWAP payload's numeric checks are not FORMAT
  // checks and already hold under `skipChecks`. Pinned so the fix cannot
  // regress it.
  it("the payload's numeric checks still hold under inherited `skipChecks`", () => {
    const badWindow = {
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, window_s: "30" },
    };
    const { events, problems } = withInherited("skipChecks", true, () => normalizeOne(badWindow));
    expect(events).toEqual([]);
    expect(problems.map((problem) => problem.code)).toEqual(["RTDS_INVALID_TWAP_PAYLOAD"]);
  });

  // The schema itself is unchanged and still says what it said: this round
  // closes the DOOR, not the frozen shape (ADR-020 §3, the obligation is on
  // the door).
  it("the envelope schema still declares `type` required", () => {
    expect(RtdsEnvelopeSchema.safeParse({ topic: "t", payload: {} }).success).toBe(false);
  });
});
