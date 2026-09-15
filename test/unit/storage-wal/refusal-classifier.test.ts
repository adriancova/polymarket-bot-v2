/**
 * THE WAL LINE ENCODER'S REFUSAL CLASSIFIER UNDER A HOSTILE THROWN VALUE
 * (`SER-2` review, M1).
 *
 * `segment-format.ts` `encodeLine` catches whatever `encodePlainJson` throws
 * and restates the encoder's refusal as this package's
 * `WalSegmentIntegrityError("record is not JSON-serializable")`. The catch
 * block sees two populations: the encoder's own `NotPlainJson`, and — when a
 * member of the record is a `Proxy` — whatever that value's traps threw. The
 * classifier must be TOTAL over both, read the thrown value as OWN DATA only,
 * and re-throw anything it does not classify AS ITSELF.
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
 * REACHABILITY, stated honestly: every record this package encodes is a
 * literal `segment-format.ts` builds from a validated `RawFrameRecord`, a
 * header or a footer, so a `Proxy` member is not reachable through the
 * writer's own API — these tests hand `encodeHeaderLine`/`encodeFrameLine` one
 * directly. The pin is about the CLASSIFIER's discipline, which is what a
 * containment boundary owes regardless of today's callers.
 *
 * A thrown `Proxy` is DISARMED after the call so that, should an assertion
 * fail, vitest's formatter can render it without running the trap.
 */

import { describe, expect, it } from "vitest";

import { PLAIN_JSON_REFUSAL_KINDS } from "../../../packages/risk/src/plain-json.js";
import { WalSegmentIntegrityError } from "../../../packages/storage-wal/src/errors.js";
import type { RawFrameRecord } from "../../../packages/storage-wal/src/raw-frame.js";
import {
  buildSegmentHeader,
  encodeFrameLine,
  encodeHeaderLine,
} from "../../../packages/storage-wal/src/segment-format.js";
import type { WalSegmentHeader } from "../../../packages/storage-wal/src/segment-format.js";

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
 * A member value whose FIRST reflective operation inside the encoder throws
 * `thrown`. `serializeValue` reaches `Object.getPrototypeOf` before any other
 * trap (`typeof` and `Array.isArray` do not trap), so this is the earliest
 * point at which caller code can run inside `encodePlainJson`.
 */
function memberThrowing(thrown: unknown): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw thrown;
    },
  });
}

/** A valid header with one member replaced by `value`. */
function headerCarrying(value: unknown): WalSegmentHeader {
  return {
    ...buildSegmentHeader({
      segmentId: "0190a3e0-0000-7000-8000-000000000001-000000",
      gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
      segmentIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    segmentId: value as string,
  };
}

/** A valid frame record with `payloadUtf8` replaced by `value`. */
function frameCarrying(value: unknown): RawFrameRecord {
  return {
    gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
    ingestSeq: "1",
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: "conn-1",
    subscriptionGeneration: 0,
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: "1000000",
    payloadUtf8: value as string,
    payloadSha256: "a".repeat(64),
  };
}

describe("encodeLine re-throws a hostile thrown value as itself, running none of its code", () => {
  it("preserves a thrown Proxy whose getPrototypeOf trap throws a sentinel, and never runs that trap", () => {
    // The review's probe: the member's trap throws a SECOND Proxy whose own
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
    const thrown = caught(() => encodeHeaderLine(headerCarrying(memberThrowing(hostileThrown))));
    armed = false;
    expect(thrown === hostileThrown).toBe(true);
    expect(thrown === sentinel).toBe(false);
    expect(prototypeCalls).toBe(0);
  });

  it("does the same on the frame line, which shares the one encoder", () => {
    let armed = true;
    let prototypeCalls = 0;
    const hostileThrown = new Proxy({}, {
      getPrototypeOf(target) {
        if (!armed) return Reflect.getPrototypeOf(target);
        prototypeCalls += 1;
        throw new RangeError("escaped from the classification");
      },
    });
    const thrown = caught(() => encodeFrameLine(frameCarrying(memberThrowing(hostileThrown))));
    armed = false;
    expect(thrown).toBe(hostileThrown);
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
    const thrown = caught(() => encodeHeaderLine(headerCarrying(memberThrowing(withGetter))));
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
    const thrown = caught(() => encodeHeaderLine(headerCarrying(memberThrowing(throwingDescriptor))));
    armed = false;
    expect(thrown).toBe(throwingDescriptor);
    // Exactly the one wrapped read, whose throw was caught inside the classifier.
    expect(descriptorCalls).toBe(1);

    // A revoked Proxy throws from the same read, for the same answer.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(caught(() => encodeHeaderLine(headerCarrying(memberThrowing(revocable.proxy))))).toBe(
      revocable.proxy,
    );
  });

  it("re-throws a thrown primitive and a thrown ordinary Error as themselves", () => {
    for (const thrown of ["a string", 42, null, undefined, Symbol("s"), new Error("ordinary")]) {
      expect(caught(() => encodeHeaderLine(headerCarrying(memberThrowing(thrown))))).toBe(thrown);
    }
  });
});

describe("the classification is STRUCTURAL (pinned as it behaves, not as one might wish)", () => {
  it("restates a forged own string `kind` from the closed vocabulary — reachable only through a Proxy trap", () => {
    // The forgery is a null-prototype object with one own data property;
    // nothing about it is a `NotPlainJson`, and the classifier cannot tell.
    // Pinning it keeps `segment-format.ts`'s comment honest about the
    // distinction the own-data read does and does not make.
    for (const kind of PLAIN_JSON_REFUSAL_KINDS) {
      const forged = Object.create(null) as Record<string, unknown>;
      forged["kind"] = kind;
      forged["path"] = "value.segmentId";
      forged["problem"] = "forged";
      const thrown = caught(() => encodeHeaderLine(headerCarrying(memberThrowing(forged))));
      expect(thrown, kind).toBeInstanceOf(WalSegmentIntegrityError);
      expect((thrown as WalSegmentIntegrityError).message, kind).toBe(
        "record is not JSON-serializable",
      );
      expect((thrown as WalSegmentIntegrityError).details["kind"], kind).toBe(kind);
    }
  });

  it("re-throws a thrown value whose own `kind` is outside the vocabulary, or not a string, as itself", () => {
    for (const kind of ["OTHER", "bigint", "", 1, null, undefined, Symbol("BIGINT"), ["BIGINT"]]) {
      const lookalike = Object.create(null) as Record<string, unknown>;
      lookalike["kind"] = kind;
      expect(
        caught(() => encodeHeaderLine(headerCarrying(memberThrowing(lookalike)))),
        String(typeof kind),
      ).toBe(lookalike);
    }
    // An INHERITED `kind` is not own data.
    const inherited = Object.create({ kind: "BIGINT" }) as object;
    expect(caught(() => encodeHeaderLine(headerCarrying(memberThrowing(inherited))))).toBe(
      inherited,
    );
  });

  it("restates the encoder's genuine refusal by the same read", () => {
    // The production-shaped refusal: a member JSON cannot represent.
    const thrown = caught(() => encodeFrameLine(frameCarrying(1n)));
    expect(thrown).toBeInstanceOf(WalSegmentIntegrityError);
    const details = (thrown as WalSegmentIntegrityError).details;
    expect(details["kind"]).toBe("BIGINT");
    expect(details["path"]).toBe("value.payloadUtf8");
    expect(typeof details["problem"]).toBe("string");
  });
});
