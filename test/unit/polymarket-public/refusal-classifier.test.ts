/**
 * `encodeOutboundJson`'s REFUSAL CLASSIFIER UNDER A HOSTILE THROWN VALUE
 * (`SER-3` review round 1, finding M1).
 *
 * `src/outbound-json.ts` catches whatever `encodePlainJson` throws and restates
 * the encoder's refusal as a `PublicMarketConfigurationError`. The catch block
 * sees two populations: the encoder's own `NotPlainJson`, and — when the value
 * is a `Proxy` — whatever the value's traps threw. The classifier must be TOTAL
 * over both, read the thrown value as OWN DATA only, and re-throw anything it
 * does not classify AS ITSELF.
 *
 * THE MUTANT THIS FILE EXISTS TO KILL, named by the review: replacing
 * `plainJsonRefusalKind`'s own-data read with
 * `const kind = error instanceof NotPlainJson ? error.kind : undefined;`. That
 * survived every suite in this repository (public: 20 files / 409 tests;
 * coinbase: 11 / 115), because the only foreign-error pin in the round threw an
 * ordinary `RangeError`, which `instanceof` classifies exactly as the own-data
 * read does. `instanceof` WALKS THE THROWN VALUE'S PROTOTYPE CHAIN, so it is
 * distinguished only by a thrown value whose `getPrototypeOf` is code: the
 * reviewer's probe is an input `Proxy` that throws ANOTHER `Proxy` whose own
 * `getPrototypeOf` trap counts and throws a sentinel. At this tip the original
 * thrown value comes back BY IDENTITY with the trap run 0 times; the mutant
 * runs the trap and lets the sentinel escape in its place.
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
import { PublicMarketConfigurationError } from "../../../packages/polymarket-public/src/errors.js";
import { encodeOutboundJson } from "../../../packages/polymarket-public/src/outbound-json.js";

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
 * An input whose FIRST reflective operation inside the encoder throws `thrown`.
 *
 * `encodePlainJson` reaches `Object.getPrototypeOf` before any other trap
 * (`typeof` and `Array.isArray` do not trap), so this is the earliest point at
 * which caller code can run inside it.
 */
function inputThrowing(thrown: unknown): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw thrown;
    },
  });
}

function encode(value: unknown): unknown {
  return caught(() => encodeOutboundJson(value, "RTDS subscribe frame"));
}

describe("encodeOutboundJson re-throws a hostile thrown value as itself, running none of its code", () => {
  it("preserves a thrown Proxy whose getPrototypeOf trap throws a sentinel, and never runs that trap", () => {
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
    const thrown = encode(inputThrowing(hostileThrown));
    armed = false;
    expect(thrown === hostileThrown).toBe(true);
    expect(thrown).toBe(hostileThrown);
    expect(thrown === sentinel).toBe(false);
    expect(prototypeCalls).toBe(0);
  });

  it("preserves the round-4 shape too: a thrown Proxy whose getPrototypeOf trap re-throws the Proxy itself", () => {
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
    const thrown = encode(inputThrowing(hostile));
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
    expect(encode(inputThrowing(withGetter))).toBe(withGetter);
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
    const thrown = encode(inputThrowing(throwingDescriptor));
    armed = false;
    expect(thrown).toBe(throwingDescriptor);
    // Exactly the one wrapped read, whose throw was caught inside the classifier.
    expect(descriptorCalls).toBe(1);

    // A revoked Proxy throws from the same read, for the same answer.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(encode(inputThrowing(revocable.proxy))).toBe(revocable.proxy);
  });

  it("re-throws a thrown primitive and a thrown ordinary Error as themselves", () => {
    for (const thrown of ["a string", 42, null, undefined, Symbol("s"), new Error("ordinary")]) {
      expect(encode(inputThrowing(thrown))).toBe(thrown);
    }
  });
});

describe("the classification is STRUCTURAL (the residual, pinned as measured)", () => {
  it("restates a forged own string `kind` from the closed vocabulary — reachable only through a Proxy trap", () => {
    for (const kind of PLAIN_JSON_REFUSAL_KINDS) {
      const forged = Object.create(null) as Record<string, unknown>;
      forged["kind"] = kind;
      forged["path"] = "value.forged";
      const thrown = encode(inputThrowing(forged));
      expect(thrown, kind).toBeInstanceOf(PublicMarketConfigurationError);
      expect(thrown === forged, kind).toBe(false);
      const error = thrown as PublicMarketConfigurationError;
      expect(error.code, kind).toBe("PUBLIC_MARKET_CONFIGURATION");
      expect(error.details["kind"], kind).toBe(kind);
      expect(error.details["path"], kind).toBe("value.forged");
    }
  });

  it("re-throws a thrown value whose own `kind` is outside the vocabulary, or not a string, as itself", () => {
    for (const kind of ["OTHER", "bigint", "", 1, null, undefined, Symbol("BIGINT"), ["BIGINT"]]) {
      const lookalike = Object.create(null) as Record<string, unknown>;
      lookalike["kind"] = kind;
      expect(encode(inputThrowing(lookalike)), String(typeof kind)).toBe(lookalike);
    }
    // An INHERITED `kind` is not own data.
    const inherited = Object.create({ kind: "BIGINT" }) as object;
    expect(encode(inputThrowing(inherited))).toBe(inherited);
  });

  it("restates the encoder's genuine refusal by the same read, for every kind this package can reach", () => {
    const cases: readonly { readonly value: unknown; readonly kind: string; readonly path: string }[] = [
      { value: { assets_ids: [1n] }, kind: "BIGINT", path: "value.assets_ids[0]" },
      { value: { when: new Date(0) }, kind: "NON_PLAIN", path: "value.when" },
      { value: undefined, kind: "UNDEFINED_ROOT", path: "value" },
    ];
    for (const item of cases) {
      const thrown = encode(item.value);
      expect(thrown, item.kind).toBeInstanceOf(PublicMarketConfigurationError);
      expect((thrown as PublicMarketConfigurationError).details["kind"], item.kind).toBe(item.kind);
      expect((thrown as PublicMarketConfigurationError).details["path"], item.kind).toBe(item.path);
    }
  });
});
