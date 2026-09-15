/**
 * `venue-facts.ts`'s REFUSAL CLASSIFIER UNDER A HOSTILE THROWN VALUE
 * (`SER-3` review round 1, finding M1).
 *
 * `encodeFrame` catches whatever `encodePlainJson` throws and restates the
 * encoder's refusal as a `CoinbaseConfigurationError`. The catch block sees two
 * populations: the encoder's own `NotPlainJson`, and — when a value in the
 * frame is a `Proxy` — whatever that value's traps threw. The classifier must
 * be TOTAL over both, read the thrown value as OWN DATA only, and re-throw
 * anything it does not classify AS ITSELF.
 *
 * THE MUTANT THIS FILE EXISTS TO KILL, named by the review: replacing
 * `plainJsonRefusalKind`'s own-data read with
 * `const kind = error instanceof NotPlainJson ? error.kind : undefined;`. That
 * survived every suite in this repository (coinbase: 11 files / 115 tests;
 * public: 20 / 409), because no test handed a builder a value that throws a
 * HOSTILE value from inside the encoder. `instanceof` WALKS THE THROWN VALUE'S
 * PROTOTYPE CHAIN, so the distinguishing probe is the reviewer's: a value whose
 * `getPrototypeOf` trap throws ANOTHER `Proxy` whose own `getPrototypeOf` trap
 * counts and throws a sentinel. At this tip the original thrown value comes
 * back BY IDENTITY with the trap run 0 times; the mutant runs the trap and lets
 * the sentinel escape in its place.
 *
 * HOW THE HOSTILE VALUE GETS IN. `encodeFrame` is private, and the frame it
 * encodes is a literal over `channel` and `[...productIds]`. A `Proxy` element
 * in `productIds` is therefore the only route, and it needs a cast — the
 * parameter is `readonly string[]`. That cast is the test's, never a
 * production shape: the point is not that a caller would do this, it is that
 * the classifier must not run the thrown value's code when one does.
 *
 * The shape, the controls and the structural residual follow
 * `packages/event-bus/src/envelope-door-classifier.test.ts` (the `SER-1`
 * precedent) exactly, over this package's vocabulary.
 *
 * A thrown `Proxy` is DISARMED after the call so that, should an assertion
 * fail, vitest's formatter can render it without running the trap.
 */

import { describe, expect, it } from "vitest";

import { PLAIN_JSON_REFUSAL_KINDS } from "../../../packages/risk/src/plain-json.js";
import { CoinbaseConfigurationError } from "../../../packages/coinbase-adapter/src/errors.js";
import {
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  COINBASE_CHANNELS,
} from "../../../packages/coinbase-adapter/src/venue-facts.js";

const NOTHING_THROWN = Symbol("nothing thrown");

function caught(run: () => unknown): unknown {
  try {
    run();
    return NOTHING_THROWN;
  } catch (error) {
    return error;
  }
}

/**
 * A product id whose FIRST reflective operation inside the encoder throws
 * `thrown`.
 *
 * `encodePlainJson` reaches `Object.getPrototypeOf` before any other trap
 * (`typeof` and `Array.isArray` do not trap), so this is the earliest point at
 * which caller code can run inside it.
 */
function productThrowing(thrown: unknown): string {
  return new Proxy({}, {
    getPrototypeOf() {
      throw thrown;
    },
  }) as unknown as string;
}

/** Builds the subscribe frame whose `product_ids` carries the hostile element. */
function build(thrown: unknown): unknown {
  return caught(() => buildSubscribeFrame(COINBASE_CHANNELS.ticker, [productThrowing(thrown)]));
}

describe("the frame builders re-throw a hostile thrown value as itself, running none of its code", () => {
  it("preserve a thrown Proxy whose getPrototypeOf trap throws a sentinel, and never run that trap", () => {
    let armed = true;
    let prototypeCalls = 0;
    const sentinel = new RangeError("escaped from the classification");
    const hostileThrown = new Proxy({}, {
      getPrototypeOf(target) {
        if (!armed) return Reflect.getPrototypeOf(target);
        prototypeCalls += 1;
        throw sentinel;
      },
    });
    const thrown = build(hostileThrown);
    armed = false;
    expect(thrown === hostileThrown).toBe(true);
    expect(thrown).toBe(hostileThrown);
    expect(thrown === sentinel).toBe(false);
    expect(prototypeCalls).toBe(0);
  });

  it("preserve the round-4 shape too: a thrown Proxy whose getPrototypeOf trap re-throws the Proxy itself", () => {
    let armed = true;
    let prototypeCalls = 0;
    let hostile: object = {};
    hostile = new Proxy({}, {
      getPrototypeOf(target) {
        if (!armed) return Reflect.getPrototypeOf(target);
        prototypeCalls += 1;
        if (prototypeCalls === 1) throw hostile;
        throw new RangeError("escape from instanceof");
      },
    });
    const thrown = build(hostile);
    armed = false;
    expect(thrown).toBe(hostile);
    expect(prototypeCalls).toBe(0);
  });

  it("control: a thrown object whose `kind` is an ACCESSOR answering a valid kind is re-thrown untouched, the getter run 0 times", () => {
    let getterCalls = 0;
    const withGetter = {
      get kind(): string {
        getterCalls += 1;
        return "BIGINT";
      },
    };
    expect(build(withGetter)).toBe(withGetter);
    expect(getterCalls).toBe(0);
  });

  it("control: a thrown Proxy whose getOwnPropertyDescriptor trap THROWS is re-thrown untouched (the wrapped read)", () => {
    let armed = true;
    let descriptorCalls = 0;
    const throwingDescriptor = new Proxy({}, {
      getOwnPropertyDescriptor(target, key) {
        if (!armed) return Reflect.getOwnPropertyDescriptor(target, key);
        descriptorCalls += 1;
        throw new TypeError("descriptor trap");
      },
    });
    const thrown = build(throwingDescriptor);
    armed = false;
    expect(thrown).toBe(throwingDescriptor);
    // Exactly the one wrapped read, whose throw was caught inside the classifier.
    expect(descriptorCalls).toBe(1);

    // A revoked Proxy throws from the same read, for the same answer.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(build(revocable.proxy)).toBe(revocable.proxy);
  });

  it("re-throw a thrown primitive and a thrown ordinary Error as themselves, on both builders", () => {
    for (const thrown of ["a string", 42, null, undefined, Symbol("s"), new Error("ordinary")]) {
      expect(build(thrown)).toBe(thrown);
      expect(
        caught(() => buildUnsubscribeFrame(COINBASE_CHANNELS.marketTrades, [productThrowing(thrown)])),
      ).toBe(thrown);
    }
  });
});

describe("the classification is STRUCTURAL (the residual, pinned as measured)", () => {
  it("restates a forged own string `kind` from the closed vocabulary — reachable only through a Proxy trap", () => {
    for (const kind of PLAIN_JSON_REFUSAL_KINDS) {
      const forged = Object.create(null) as Record<string, unknown>;
      forged["kind"] = kind;
      forged["path"] = "value.product_ids[0]";
      const thrown = build(forged);
      expect(thrown, kind).toBeInstanceOf(CoinbaseConfigurationError);
      expect(thrown === forged, kind).toBe(false);
      const error = thrown as CoinbaseConfigurationError;
      expect(error.code, kind).toBe("COINBASE_CONFIGURATION");
      expect(error.details["kind"], kind).toBe(kind);
      expect(error.details["path"], kind).toBe("value.product_ids[0]");
    }
  });

  it("re-throws a thrown value whose own `kind` is outside the vocabulary, or not a string, as itself", () => {
    for (const kind of ["OTHER", "bigint", "", 1, null, undefined, Symbol("BIGINT"), ["BIGINT"]]) {
      const lookalike = Object.create(null) as Record<string, unknown>;
      lookalike["kind"] = kind;
      expect(build(lookalike), String(typeof kind)).toBe(lookalike);
    }
    // An INHERITED `kind` is not own data.
    const inherited = Object.create({ kind: "BIGINT" }) as object;
    expect(build(inherited)).toBe(inherited);
  });

  it("restates the encoder's genuine refusal by the same read", () => {
    // A bigint product id: the encoder's own `NotPlainJson`, classified by the
    // same own-data read, restated in this package's vocabulary.
    const thrown = caught(() =>
      buildSubscribeFrame(COINBASE_CHANNELS.ticker, [1n as unknown as string]),
    );
    expect(thrown).toBeInstanceOf(CoinbaseConfigurationError);
    const error = thrown as CoinbaseConfigurationError;
    expect(error.message).toBe("the subscribe frame is not plain JSON data and was not built");
    expect(error.details["kind"]).toBe("BIGINT");
    expect(error.details["path"]).toBe("value.product_ids[0]");
    expect(typeof error.details["problem"]).toBe("string");
  });
});
