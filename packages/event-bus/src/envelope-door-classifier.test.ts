/**
 * THE ADAPTER'S REFUSAL CLASSIFIER UNDER A HOSTILE THROWN VALUE (`SER-1`
 * review, findings M2 and L1).
 *
 * `encodeWireJson` catches whatever `encodePlainJson` throws and restates the
 * encoder's refusal in this module's `NotWireData` vocabulary. The catch block
 * sees two populations: the encoder's own `NotPlainJson`, and — when the value
 * is a `Proxy` — whatever the value's traps threw. The classifier must be
 * TOTAL over both, read the thrown value as OWN DATA only, and re-throw
 * anything it does not classify AS ITSELF.
 *
 * The mutant this file exists to kill: replacing the own-data read with
 * `error instanceof NotPlainJson`. That survived every other test in the
 * repository (the review measured it), because no test handed the adapter a
 * value that throws a hostile value from inside the encoder. `instanceof`
 * walks the thrown value's prototype chain (`./brand.ts`, round 4), so a
 * thrown `Proxy` with a throwing `getPrototypeOf` trap makes the
 * CLASSIFICATION throw, and the trap's value replaces the original.
 *
 * The first test below is that exact pair; the two after it are the controls
 * for the other two ways a classifier could run caller code (a getter, a
 * throwing descriptor trap). The last block pins the L1 residual as measured:
 * the classification is STRUCTURAL — an own string `kind` from the closed
 * vocabulary is the whole test — so a forged `kind` thrown from inside the
 * encoder IS restated. That is reachable only through a `Proxy` trap, which
 * the materialized-input precondition of the sole production caller
 * (`encodeEnvelope` → `readOwnWireValue`) excludes; pinning it keeps the
 * adapter's comment honest rather than claiming a distinction it cannot make.
 *
 * A thrown `Proxy` here is DISARMED after the call so that, should an
 * assertion fail, vitest's formatter can render it without running the trap.
 */
import { MAX_PLAIN_JSON_DEPTH, PLAIN_JSON_REFUSAL_KINDS } from "@polymarket-bot/risk/plain-json";
import type { PlainJsonRefusalKind } from "@polymarket-bot/risk/plain-json";
import { describe, expect, it } from "vitest";

import { encodeWireJson, MAX_WIRE_DEPTH, readOwnWireValue } from "./envelope-door.js";

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
 * An input whose FIRST reflective operation inside the encoder throws
 * `thrown`. The encoder reaches `Object.getPrototypeOf` before any other trap
 * (`typeof` and `Array.isArray` do not trap), so this is the earliest point at
 * which caller code can run inside `encodePlainJson`.
 */
function inputThrowing(thrown: unknown): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw thrown;
    },
  });
}

/** The six restatements the adapter makes, keyed by the encoder's `kind`. */
const RESTATED: Readonly<Record<PlainJsonRefusalKind, string>> = Object.freeze({
  UNDEFINED_ROOT: "the value has no JSON representation",
  BIGINT: "a bigint has no JSON representation",
  EXECUTABLE: "an envelope must contain data, not executable or symbolic values",
  ACCESSOR: "an accessor property is code rather than envelope data",
  NON_PLAIN: "a non-plain prototype is not envelope data",
  DEPTH: `nested deeper than ${String(MAX_WIRE_DEPTH)} levels`,
});

describe("encodeWireJson re-throws a hostile thrown value as itself, running none of its code", () => {
  it("preserves a thrown Proxy whose getPrototypeOf trap throws a sentinel, and never runs that trap", () => {
    // The review's probe: the input's trap throws a SECOND Proxy whose own
    // `getPrototypeOf` trap counts and throws a sentinel. An `instanceof`
    // classifier walks the second Proxy's chain, runs the trap, and lets the
    // sentinel escape in place of the original.
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
    const thrown = caught(() => encodeWireJson(inputThrowing(hostileThrown)));
    armed = false;
    expect(thrown === hostileThrown).toBe(true);
    expect(thrown).toBe(hostileThrown);
    expect(thrown === sentinel).toBe(false);
    expect(prototypeCalls).toBe(0);
  });

  it("preserves the round-4 shape too: a thrown Proxy whose getPrototypeOf trap re-throws the Proxy itself", () => {
    // `./brand.ts` records this shape from `WP-060-FU1` round 4: the first
    // walk re-throws the hostile value, a second walk throws something else.
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
    const thrown = caught(() => encodeWireJson(inputThrowing(hostile)));
    armed = false;
    expect(thrown).toBe(hostile);
    expect(prototypeCalls).toBe(0);
  });

  it("control: a thrown object whose `kind` is an ACCESSOR answering a valid kind is re-thrown untouched, the getter run 0 times", () => {
    // A property READ (`error.kind`) would run the getter, see "BIGINT" and
    // restate; the own-data read sees an accessor descriptor and classifies
    // nothing.
    let getterCalls = 0;
    const withGetter = {
      get kind(): string {
        getterCalls += 1;
        return "BIGINT";
      },
    };
    const thrown = caught(() => encodeWireJson(inputThrowing(withGetter)));
    expect(thrown).toBe(withGetter);
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
    const thrown = caught(() => encodeWireJson(inputThrowing(throwingDescriptor)));
    armed = false;
    expect(thrown).toBe(throwingDescriptor);
    // Exactly the one wrapped read, whose throw was caught inside the classifier.
    expect(descriptorCalls).toBe(1);

    // A revoked Proxy throws from the same read, for the same answer.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(caught(() => encodeWireJson(inputThrowing(revocable.proxy)))).toBe(revocable.proxy);
  });

  it("re-throws a thrown primitive and a thrown ordinary Error as themselves", () => {
    for (const thrown of ["a string", 42, null, undefined, Symbol("s"), new Error("ordinary")]) {
      expect(caught(() => encodeWireJson(inputThrowing(thrown)))).toBe(thrown);
    }
  });
});

describe("the classification is STRUCTURAL (the L1 residual, pinned as measured)", () => {
  it("restates a forged own string `kind` from the closed vocabulary — reachable only through a Proxy trap", () => {
    // Every kind, so the whole mapping table is pinned. The forgery is a
    // null-prototype object with one own data property; nothing about it is a
    // `NotPlainJson`, and the adapter cannot tell.
    for (const kind of PLAIN_JSON_REFUSAL_KINDS) {
      const forged = Object.create(null) as Record<string, unknown>;
      forged["kind"] = kind;
      const thrown = caught(() => encodeWireJson(inputThrowing(forged)));
      expect(thrown, kind).toBeInstanceOf(Error);
      expect(thrown === forged, kind).toBe(false);
      expect((thrown as Error).message, kind).toBe(RESTATED[kind]);
    }
  });

  it("re-throws a thrown value whose own `kind` is outside the vocabulary, or not a string, as itself", () => {
    for (const kind of ["OTHER", "bigint", "", 1, null, undefined, Symbol("BIGINT"), ["BIGINT"]]) {
      const lookalike = Object.create(null) as Record<string, unknown>;
      lookalike["kind"] = kind;
      expect(caught(() => encodeWireJson(inputThrowing(lookalike))), String(typeof kind)).toBe(lookalike);
    }
    // An INHERITED `kind` is not own data.
    const inherited = Object.create({ kind: "BIGINT" }) as object;
    expect(caught(() => encodeWireJson(inputThrowing(inherited)))).toBe(inherited);
  });

  it("restates the encoder's genuine refusal on a materialized tree by the same read", () => {
    // The production route: a tree `readOwnWireValue` built. The bigint is the
    // one refusal reachable there; DEPTH is reachable only from a value that
    // never went through the door.
    const bigint = caught(() => encodeWireJson(readOwnWireValue({ amount: 1n })));
    expect((bigint as Error).message).toBe(RESTATED.BIGINT);
    let chain: unknown = 0;
    for (let level = 0; level < MAX_WIRE_DEPTH + 1; level += 1) chain = { x: chain };
    expect((caught(() => encodeWireJson(chain)) as Error).message).toBe(RESTATED.DEPTH);
  });

  it("keeps this door's depth bound inside the encoder's supported domain", () => {
    // `encodePlainJson` refuses a `maxDepth` above `MAX_PLAIN_JSON_DEPTH` with
    // a `RangeError` at option validation; a bound outside the domain would
    // turn EVERY encode into that error.
    expect(MAX_WIRE_DEPTH).toBeGreaterThanOrEqual(1);
    expect(MAX_WIRE_DEPTH).toBeLessThanOrEqual(MAX_PLAIN_JSON_DEPTH);
    let chain: unknown = 0;
    for (let level = 0; level < MAX_WIRE_DEPTH; level += 1) chain = { x: chain };
    expect(encodeWireJson(chain)).toBe(JSON.stringify(chain));
  });
});
