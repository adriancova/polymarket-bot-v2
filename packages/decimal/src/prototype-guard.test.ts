/**
 * NON-VACUITY for the index-name guard, and the guard's own unit behaviour.
 *
 * `test/unit/decimal/index-name-pollution.test.ts` is the BOUND: it asserts
 * that no answer this package gives moves under a property at an array-index
 * name. That assertion is only worth anything if the pollution it installs
 * actually reaches the class — and the whole content of `WP-200-FU1`'s NOTE-1
 * is that everybody had assumed it did not. So this file drives `decimal.js`
 * DIRECTLY, with a constructor configured exactly like `arithmetic.ts`'s
 * `ExactDecimal`, and requires the LIBRARY still to be broken. It lives inside
 * the package because `decimal.js` is this package's own dependency and the
 * root test tree cannot resolve it (`docs/contracts/dependency-direction.md`
 * §3 F15 — no manifest change was made for a test).
 *
 * If a future `decimal.js` fixes the class upstream, this file fails, and that
 * is the correct outcome: the guard's cost and its comment would then be
 * describing a defect that no longer exists, and the round that upgrades the
 * library (ADR-020 §7 makes that a contract change) must re-measure and decide.
 */
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { addDecimal, subDecimal } from "./arithmetic.js";
import { withNeutralIndexNames } from "./prototype-guard.js";

/** Exactly `arithmetic.ts`'s `ExactDecimal` configuration, driven unguarded. */
const RAW = Decimal.clone({
  defaults: true,
  precision: 1e9,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_DOWN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
});

function quietly(run: () => unknown): string {
  try {
    return String(run());
  } catch (error) {
    const thrown = error as { constructor: { name: string }; message?: unknown };
    return `THREW ${thrown.constructor.name}: ${String(thrown.message)}`;
  }
}

describe("NON-VACUITY: the library underneath still has the defect", () => {
  it('answers 9 for 100 + -100 under a data property at Object.prototype["0"]', () => {
    const clean = new RAW("100").plus(new RAW("-100")).toFixed();
    let polluted: string;
    let guarded: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => new RAW("100").plus(new RAW("-100")).toFixed());
      guarded = quietly(() => addDecimal("100", "-100"));
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(clean).toBe("0");
    // The LIBRARY fabricates: the root cause is `P.minus`'s `if (!xd[0])`
    // reading a hole after the leading-zero strip empties the digit array.
    expect(polluted).toBe("9");
    // The WRAPPER does not. This is the whole round, in two lines.
    expect(guarded).toBe("0");
  });

  it("fabricates a FRACTIONAL value too, so the class is not confined to integers", () => {
    let polluted: string;
    let guarded: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => new RAW("0.3").minus(new RAW("0.3")).toFixed());
      guarded = quietly(() => subDecimal("0.3", "0.3"));
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(polluted).toBe("0.0000009");
    expect(guarded).toBe("0");
  });

  it("throws on a FRESH PARSE under a get-only accessor — no zero result involved", () => {
    // `parseDecimal` does `x.d = []` then `x.d.push(...)`, and `push` is `Set`.
    // This is why the `WP-220` M2 framing ("exactly-zero results") understated
    // the class: at this shape every parse in the process fails.
    let polluted: string;
    let guarded: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        get: () => "9",
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => new RAW("1.5").toFixed());
      guarded = quietly(() => addDecimal("1", "2"));
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(polluted.startsWith("THREW TypeError")).toBe(true);
    expect(guarded).toBe("3");
  });

  it("fabricates at index 1 as well, changing a DIVISION by a factor of ten", () => {
    let polluted: string;
    let guarded: string;
    try {
      Object.defineProperty(Object.prototype, "1", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      polluted = quietly(() => new RAW("2").div(new RAW("4")).toFixed());
      guarded = quietly(() => addDecimal("2", "2"));
    } finally {
      Reflect.deleteProperty(Object.prototype, "1");
    }
    expect(polluted).toBe("5.000000225");
    expect(guarded).toBe("4");
  });
});

describe("`withNeutralIndexNames` itself", () => {
  it("returns the operation's value and propagates its throw", () => {
    expect(withNeutralIndexNames(() => 41 + 1)).toBe(41 + 1);
    const boom = new Error("from the operation");
    expect(() =>
      withNeutralIndexNames(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it("makes a HOLE read as `undefined` and an absent index WRITABLE, while polluted", () => {
    // The two halves of the class, at the primitive level, measured from inside
    // the window. No `expect` runs here — the answers are collected as data and
    // asserted after the prototype is restored (the ledger battery's rule 1).
    let holeRead: unknown;
    let wroteOk = false;
    let holeReadPolluted: unknown;
    let wroteOkPolluted = false;
    try {
      Object.defineProperty(Object.prototype, "0", {
        get: () => "9",
        enumerable: false,
        configurable: true,
      });
      const outside: unknown[] = [];
      holeReadPolluted = outside[0];
      try {
        outside[0] = 1;
        wroteOkPolluted = true;
      } catch {
        wroteOkPolluted = false;
      }
      withNeutralIndexNames(() => {
        const inside: unknown[] = [];
        holeRead = inside[0];
        try {
          inside[0] = 1;
          wroteOk = true;
        } catch {
          wroteOk = false;
        }
        return 0;
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    // Outside the window the class is live …
    expect(holeReadPolluted).toBe("9");
    expect(wroteOkPolluted).toBe(false);
    // … and inside it, a hole is a hole and an index is writable.
    expect(holeRead).toBeUndefined();
    expect(wroteOk).toBe(true);
  });

  it("NESTS without losing the original", () => {
    let inner: unknown;
    let afterInner: unknown;
    let restored: string | null;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: true,
        enumerable: false,
        configurable: true,
      });
      withNeutralIndexNames(() => {
        withNeutralIndexNames(() => {
          inner = ([] as unknown[])[0];
          return 0;
        });
        // The inner call found nothing to neutralize and must not have undone
        // the outer one on its way out.
        afterInner = ([] as unknown[])[0];
        return 0;
      });
      restored = (([] as unknown[])[0] ?? null) as string | null;
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(inner).toBeUndefined();
    expect(afterInner).toBeUndefined();
    expect(restored).toBe("9");
  });
});
