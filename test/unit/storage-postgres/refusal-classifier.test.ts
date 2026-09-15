/**
 * `encodeJsonbText`'s REFUSAL CLASSIFIER UNDER A HOSTILE THROWN VALUE
 * (`SER-2` review, M1).
 *
 * `json.ts` `encodeJsonbText` catches whatever `encodePlainJson` throws and
 * restates the encoder's refusal in this package's `DecimalSafeJsonError`
 * vocabulary. The catch block sees two populations: the encoder's own
 * `NotPlainJson`, and — when the document or a member of it is a `Proxy` —
 * whatever that value's traps threw. The classifier must be TOTAL over both,
 * read the thrown value as OWN DATA only, and re-throw anything it does not
 * classify AS ITSELF.
 *
 * THE MUTANT THIS FILE EXISTS TO KILL: replacing the own-data read in
 * `plainJsonRefusalKind` with `return error instanceof NotPlainJson ?
 * error.kind : undefined;`. The review measured that mutant surviving every
 * relevant suite (21 files / 369 tests, plus `test:fault` 11 / 89), because no
 * test handed the encoder a value that throws a hostile value from inside it.
 * `instanceof` walks the thrown value's prototype chain, so a thrown `Proxy`
 * with a throwing `getPrototypeOf` trap makes the CLASSIFICATION throw and the
 * trap's value replaces the original.
 *
 * The first test is that exact pair; the two after it are the controls for the
 * other two ways a classifier could run caller code (a getter, a throwing
 * descriptor trap). The shape and the controls follow the `SER-1` precedent,
 * `packages/event-bus/src/envelope-door-classifier.test.ts`.
 *
 * REACHABILITY, stated honestly: a repository's document arrives from
 * `JSON.parse`, from a domain literal or from a caller of this package's API,
 * and a `Proxy` is not among them today — but `encodeJsonbText` is exported and
 * takes `Readonly<Record<string, unknown>>`, so the discipline is the
 * boundary's, not the caller's.
 *
 * A thrown `Proxy` is DISARMED after the call so that, should an assertion
 * fail, vitest's formatter can render it without running the trap.
 */

import { describe, expect, it } from "vitest";

import { PLAIN_JSON_REFUSAL_KINDS } from "../../../packages/risk/src/plain-json.js";
import { DecimalSafeJsonError } from "../../../packages/storage-postgres/src/errors.js";
import { encodeJsonbText } from "../../../packages/storage-postgres/src/json.js";

const NOTHING_THROWN = Symbol("nothing thrown");
const FIELD = "order_events.payload";

function caught(run: () => unknown): unknown {
  try {
    run();
    return NOTHING_THROWN;
  } catch (error) {
    return error;
  }
}

/**
 * A document whose FIRST reflective operation inside the encoder throws
 * `thrown`. `serializeValue` reaches `Object.getPrototypeOf` before any other
 * trap (`typeof` and `Array.isArray` do not trap), so this is the earliest
 * point at which caller code can run inside `encodePlainJson`.
 */
function documentThrowing(thrown: unknown): Readonly<Record<string, unknown>> {
  return new Proxy({}, {
    getPrototypeOf() {
      throw thrown;
    },
  }) as Readonly<Record<string, unknown>>;
}

describe("encodeJsonbText re-throws a hostile thrown value as itself, running none of its code", () => {
  it("preserves a thrown Proxy whose getPrototypeOf trap throws a sentinel, and never runs that trap", () => {
    // The review's probe: the document's trap throws a SECOND Proxy whose own
    // `getPrototypeOf` trap counts and throws a sentinel. An `instanceof`
    // classifier walks that second Proxy's chain, runs the trap, and lets the
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
    const thrown = caught(() => encodeJsonbText(documentThrowing(hostileThrown), FIELD));
    armed = false;
    expect(thrown === hostileThrown).toBe(true);
    expect(thrown === sentinel).toBe(false);
    expect(prototypeCalls).toBe(0);
  });

  it("preserves a thrown Proxy whose getPrototypeOf trap re-throws the Proxy itself", () => {
    // The `WP-060-FU1` round-4 shape: the first walk re-throws the hostile
    // value, a second walk throws something else.
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
    const thrown = caught(() => encodeJsonbText(documentThrowing(hostile), FIELD));
    armed = false;
    expect(thrown).toBe(hostile);
    expect(prototypeCalls).toBe(0);
  });

  it("control: a thrown object whose `kind` is an ACCESSOR answering a valid kind is re-thrown untouched, the getter run 0 times", () => {
    // A property READ (`error.kind`) would run the getter, see "BIGINT" and
    // restate it as ECONOMIC_JSON_NUMBER; the own-data read sees an accessor
    // descriptor and classifies nothing.
    let getterCalls = 0;
    const withGetter = {
      get kind(): string {
        getterCalls += 1;
        return "BIGINT";
      },
    };
    const thrown = caught(() => encodeJsonbText(documentThrowing(withGetter), FIELD));
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
    const thrown = caught(() => encodeJsonbText(documentThrowing(throwingDescriptor), FIELD));
    armed = false;
    expect(thrown).toBe(throwingDescriptor);
    // Exactly the one wrapped read, whose throw was caught inside the classifier.
    expect(descriptorCalls).toBe(1);

    // A revoked Proxy throws from the same read, for the same answer.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(caught(() => encodeJsonbText(documentThrowing(revocable.proxy), FIELD))).toBe(
      revocable.proxy,
    );
  });

  it("re-throws a thrown primitive and a thrown ordinary Error as themselves", () => {
    for (const thrown of ["a string", 42, null, undefined, Symbol("s"), new Error("ordinary")]) {
      expect(caught(() => encodeJsonbText(documentThrowing(thrown), FIELD))).toBe(thrown);
    }
  });
});

describe("the classification is STRUCTURAL (pinned as it behaves, not as one might wish)", () => {
  it("restates a forged own string `kind` from the closed vocabulary — reachable only through a Proxy trap", () => {
    // The forgery is a null-prototype object with own data properties; nothing
    // about it is a `NotPlainJson`, and the classifier cannot tell. `BIGINT` is
    // the guard's own "not a number" wording; every other kind is the
    // "not representable" restatement.
    for (const kind of PLAIN_JSON_REFUSAL_KINDS) {
      const forged = Object.create(null) as Record<string, unknown>;
      forged["kind"] = kind;
      forged["path"] = "value.amount";
      forged["problem"] = "forged";
      const thrown = caught(() => encodeJsonbText(documentThrowing(forged), FIELD));
      expect(thrown, kind).toBeInstanceOf(DecimalSafeJsonError);
      const error = thrown as DecimalSafeJsonError;
      expect(error.code, kind).toBe(kind === "BIGINT" ? "ECONOMIC_JSON_NUMBER" : "ECONOMIC_JSON_MALFORMED");
      expect(error.field, kind).toBe(FIELD);
      expect(error.path, kind).toBe(".amount");
    }
  });

  it("re-throws a thrown value whose own `kind` is outside the vocabulary, or not a string, as itself", () => {
    for (const kind of ["OTHER", "bigint", "", 1, null, undefined, Symbol("BIGINT"), ["BIGINT"]]) {
      const lookalike = Object.create(null) as Record<string, unknown>;
      lookalike["kind"] = kind;
      expect(
        caught(() => encodeJsonbText(documentThrowing(lookalike), FIELD)),
        String(typeof kind),
      ).toBe(lookalike);
    }
    // An INHERITED `kind` is not own data.
    const inherited = Object.create({ kind: "BIGINT" }) as object;
    expect(caught(() => encodeJsonbText(documentThrowing(inherited), FIELD))).toBe(inherited);
  });

  it("restates the encoder's genuine refusal by the same read", () => {
    // The production-shaped refusal: a bigint the guard never saw, in an
    // UNGUARDED document. The message is the guard's existing wording.
    const thrown = caught(() => encodeJsonbText({ amount: 1n }, FIELD));
    expect(thrown).toBeInstanceOf(DecimalSafeJsonError);
    const error = thrown as DecimalSafeJsonError;
    expect(error.code).toBe("ECONOMIC_JSON_NUMBER");
    expect(error.message).toBe(
      `${FIELD}.amount is a bigint, which JSON cannot represent. Use a decimal string.`,
    );
  });
});
