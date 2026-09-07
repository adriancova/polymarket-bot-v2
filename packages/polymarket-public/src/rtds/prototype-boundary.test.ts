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

/**
 * The ENUMERABLE variant of the same class (review round 1, finding F1).
 *
 * A door that copied inherited enumerable keys after its own-key loop passed
 * every test this file carried. Callers warm the schemas with an honest
 * normalization FIRST: enumerable pollution during a schema's first parse
 * permanently poisons it (ADR-020 §1 class 7).
 */
function withInheritedEnumerable<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

/** The documented frame with one key removed, from the envelope or the payload. */
function without(key: string, from: "envelope" | "payload"): unknown {
  const envelope: Record<string, unknown> = { ...THIRTY_UPDATE };
  if (from === "envelope") {
    delete envelope[key];
    return envelope;
  }
  const payload: Record<string, unknown> = { ...THIRTY_UPDATE.payload };
  delete payload[key];
  envelope["payload"] = payload;
  return envelope;
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

  // REVIEW ROUND 1, FINDING F4 — THE SHARPEST CELLS OF THIS ROW, which the
  // first pass left unpinned. Measured at base `5128d6c`:
  //
  //   * an inherited `full_accuracy_value` published a `ReferenceTwapObserved`
  //     carrying `value:"999000"` — a FABRICATED ECONOMIC VALUE, the one field
  //     ADR-001 §8.3 lets this adapter read for exact decimals;
  //   * an inherited `topic` produced `feedId:"crypto_prices_twap_thirty"` on a
  //     frame that declared no topic at all — a recorded series identity for an
  //     update that never named one.
  //
  // Both are now refused, and so are `symbol`, the observation instant and the
  // whole payload.
  it("no ECONOMIC value and no feedId can be supplied from the prototype", () => {
    normalizeOne(THIRTY_UPDATE); // warm

    // The economic cell. `999000000000000000000` is E18 for 999.
    const noValue = without("full_accuracy_value", "payload");
    expect(normalizeOne(noValue).problems.map((p) => p.code)).toEqual([
      "RTDS_INVALID_TWAP_PAYLOAD",
    ]);
    const injected = withInherited("full_accuracy_value", "999000000000000000000", () =>
      normalizeOne(noValue),
    );
    expect(injected.events).toEqual([]);
    expect(injected.problems.map((p) => p.code)).toEqual(["RTDS_INVALID_TWAP_PAYLOAD"]);

    // The identity cell: no topic, therefore no feedId.
    const noTopic = without("topic", "envelope");
    const routed = withInherited("topic", "crypto_prices_twap_thirty", () =>
      normalizeOne(noTopic),
    );
    expect(routed.events).toEqual([]);
    expect(routed.problems.map((p) => p.code)).toEqual(["RTDS_INVALID_ENVELOPE"]);
  });

  it("every declared envelope and payload key is refused when only the prototype supplies it", () => {
    normalizeOne(THIRTY_UPDATE); // warm
    const survivors: string[] = [];
    const cells: readonly (readonly [string, "envelope" | "payload", unknown])[] = [
      ["topic", "envelope", "crypto_prices_twap_thirty"],
      ["type", "envelope", "update"],
      ["payload", "envelope", THIRTY_UPDATE.payload],
      ["symbol", "payload", "btc/usd"],
      ["full_accuracy_value", "payload", "999000000000000000000"],
      ["timestamp", "payload", 1_785_178_800_000],
      ["window_s", "payload", 30],
    ];
    for (const [key, from, value] of cells) {
      const frame = without(key, from);
      // Clean: the frame is refused with the key genuinely gone.
      if (normalizeOne(frame).events.length > 0) survivors.push(`${key} (clean)`);
      for (const install of [withInherited, withInheritedEnumerable]) {
        const outcome = install(key, value, () => normalizeOne(frame));
        if (outcome.events.length > 0) {
          survivors.push(`${key} (${install === withInherited ? "inherited" : "enumerable"})`);
        }
      }
    }
    expect(survivors).toEqual([]);
  });

  // REVIEW ROUND 1, FINDING F1. The ENUMERABLE variant of the routing cell,
  // spelled out separately so the row's own shape stays legible.
  it("an ENUMERABLE inherited `type` does not route a frame either", () => {
    normalizeOne(THIRTY_UPDATE); // warm
    const outcome = withInheritedEnumerable("type", "update", () => normalizeOne(NO_TYPE));
    expect(outcome.events).toEqual([]);
    expect(outcome.problems.map((problem) => problem.code)).toEqual(["RTDS_INVALID_ENVELOPE"]);

    // AND WHAT ENUMERABLE POLLUTION DOES TO AN HONEST FRAME HERE, stated
    // rather than assumed: it is refused, by the FROZEN domain contract, and
    // this is base-identical because `packages/domain` is untouched by this
    // round. `ReferenceTwapObservedContract.payloadSchema` is a strict object,
    // and `z.strictObject` DOES see an enumerable inherited unknown key
    // (`schema-boundary.md` §2 — it is blind only to a non-enumerable one), so
    // every enumerable key on `Object.prototype` becomes an
    // `unrecognized_keys` issue on the normalized payload.
    //
    // That is an AVAILABILITY class, never a permission one: the observation is
    // refused and reported with its raw evidence, never published wrong. It is
    // recorded here so the difference between the two variants is measured
    // rather than discovered later.
    const polluted = withInheritedEnumerable("type", "update", () => normalizeOne(THIRTY_UPDATE));
    expect(polluted.events).toEqual([]);
    expect(polluted.problems.map((problem) => problem.code)).toEqual([
      "RTDS_PAYLOAD_CONTRACT_VIOLATION",
    ]);
    // …and it is the pollution, not the door: with it gone the same frame
    // publishes.
    expect(normalizeOne(THIRTY_UPDATE).events).toHaveLength(1);
  });

  // REVIEW ROUND 1, FINDING F2. ADR-020's 2026-09-06 amendment: a warm schema
  // still builds its issues lazily per refusal, and that path reads through the
  // prototype chain. With `./wire-door.ts`'s containment deleted, an inherited
  // non-enumerable `_zod` turns this refusal into a bare `TypeError` — a throw
  // in a message loop, which is how an event gets dropped.
  it("a refusal that cannot be CONSTRUCTED is still a problem, not a throw", () => {
    normalizeOne(THIRTY_UPDATE); // warm
    for (const key of ["_zod", "value"] as const) {
      const outcome = withInherited(key, {}, () => normalizeOne(NO_TYPE));
      expect(outcome.events, key).toEqual([]);
      expect(outcome.problems.map((problem) => problem.code), key).toEqual([
        "RTDS_INVALID_ENVELOPE",
      ]);
    }
  });

  // The schema itself is unchanged and still says what it said: this round
  // closes the DOOR, not the frozen shape (ADR-020 §3, the obligation is on
  // the door).
  it("the envelope schema still declares `type` required", () => {
    expect(RtdsEnvelopeSchema.safeParse({ topic: "t", payload: {} }).success).toBe(false);
  });
});
