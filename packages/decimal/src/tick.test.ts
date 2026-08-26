import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mulDecimal } from "./arithmetic.js";
import { InvalidDecimalStringError, InvalidTickSizeError } from "./errors.js";
import { assertTickConformant, isTickConformant } from "./tick.js";
import { canonicalDecimalArbitrary } from "./testing/arbitraries.js";

describe("exact tick conformance (handoff §7.3, §16.2)", () => {
  const conformant: ReadonlyArray<readonly [string, string]> = [
    ["0.07", "0.01"],
    ["0.29", "0.01"],
    ["0.5", "0.01"],
    ["0.001", "0.001"],
    ["0", "0.01"],
    ["1", "0.01"],
    ["-0.07", "0.01"],
    ["100", "5"],
    ["0.9999", "0.0001"],
    ["12.3", "0.1"],
  ];

  it.each(conformant)("accepts %j on a %j grid", (value, tick) => {
    expect(isTickConformant(value, tick)).toBe(true);
    expect(assertTickConformant(value, tick)).toBe(value);
  });

  const violating: ReadonlyArray<readonly [string, string]> = [
    ["0.075", "0.01"],
    ["0.001", "0.01"],
    ["0.999", "0.01"],
    ["-0.075", "0.01"],
    ["101", "5"],
    ["0.00005", "0.0001"],
    ["12.35", "0.1"],
  ];

  it.each(violating)("rejects %j on a %j grid", (value, tick) => {
    expect(isTickConformant(value, tick)).toBe(false);
    expect(() => assertTickConformant(value, tick, "price")).toThrow(InvalidTickSizeError);
  });

  it("is exact where JavaScript modulo is not", () => {
    // 0.07 % 0.01 === 0.009999999999999998 in IEEE-754 binary floating point.
    expect(0.07 % 0.01).not.toBe(0);
    expect(isTickConformant("0.07", "0.01")).toBe(true);

    expect(0.29 % 0.01).not.toBe(0);
    expect(isTickConformant("0.29", "0.01")).toBe(true);
  });

  it("rejects a non-positive tick size", () => {
    expect(() => isTickConformant("0.5", "0")).toThrow(InvalidTickSizeError);
    expect(() => isTickConformant("0.5", "-0.01")).toThrow(InvalidTickSizeError);
  });

  it("reports every tick failure with the matching code", () => {
    // Wave 0 closeout L9: one throw site carried `DECIMAL_INEXACT` while the
    // class was `InvalidTickSizeError`. Class and code now agree everywhere in
    // this module; `errors.test.ts` holds the package-wide taxonomy test.
    for (const operation of [
      () => isTickConformant("0.5", "0"),
      () => isTickConformant("0.5", "-0.01"),
      () => assertTickConformant("0.075", "0.01", "price"),
    ]) {
      try {
        operation();
        throw new Error("expected InvalidTickSizeError");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(InvalidTickSizeError);
        expect((error as InvalidTickSizeError).code).toBe("DECIMAL_INVALID_TICK");
      }
    }
  });

  it("requires canonical inputs", () => {
    expect(() => isTickConformant("0.50", "0.01")).toThrow(InvalidDecimalStringError);
    expect(() => isTickConformant("0.5", "0.010")).toThrow(InvalidDecimalStringError);
    expect(() => isTickConformant(0.5 as unknown as string, "0.01")).toThrow(
      InvalidDecimalStringError,
    );
  });

  it("accepts every exact integer multiple of a tick", () => {
    fc.assert(
      fc.property(
        canonicalDecimalArbitrary({ maxIntegerDigits: 4, maxFractionDigits: 0 }),
        fc.constantFrom("0.01", "0.001", "0.1", "1", "0.0001"),
        (multiplier, tick) => {
          expect(isTickConformant(mulDecimal(multiplier, tick), tick)).toBe(true);
        },
      ),
    );
  });
});
