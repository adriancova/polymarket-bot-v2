/**
 * `assertDecimalSafeJson` — the runtime half of "no `number` in a document that
 * may carry an economic value" (§6 invariant 1, `docs/contracts/domain.md` §4).
 *
 * The type is the compile-time half and protects code `tsc` sees; this guard is
 * what protects the boundary from a document that arrived as `unknown` — from
 * `JSON.parse`, from a venue, or from a test.
 */

import { describe, expect, it } from "vitest";

import { DecimalSafeJsonError } from "./errors.js";
import { assertDecimalSafeJson, decimalSafeJson } from "./json.js";

function rejectionOf(value: unknown): DecimalSafeJsonError {
  try {
    assertDecimalSafeJson(value, "signed_payload");
  } catch (error) {
    if (error instanceof DecimalSafeJsonError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the document to be rejected.");
}

describe("assertDecimalSafeJson", () => {
  it("accepts a document whose economic values are canonical decimal strings", () => {
    expect(() =>
      assertDecimalSafeJson(
        { price: "0.42", size: "10", negRisk: false, note: null, legs: [{ size: "1" }] },
        "signed_payload",
      ),
    ).not.toThrow();
  });

  it("rejects a number at the top level", () => {
    const error = rejectionOf({ price: 0.42 });
    expect(error.code).toBe("ECONOMIC_JSON_NUMBER");
    expect(error.field).toBe("signed_payload");
    expect(error.path).toBe(".price");
  });

  it("rejects a number nested in an object", () => {
    expect(rejectionOf({ order: { price: 0.42 } }).path).toBe(".order.price");
  });

  it("rejects a number nested in an array", () => {
    expect(rejectionOf({ legs: [{ size: 10 }] }).path).toBe(".legs[0].size");
  });

  it("rejects an integer, not only a fraction", () => {
    // `10` is exactly representable, and is still the wrong type: the value that
    // matters is the one after arithmetic, and §7.3 has exactly one spelling.
    expect(rejectionOf({ size: 10 }).code).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("rejects zero", () => {
    expect(rejectionOf({ fee: 0 }).code).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("rejects a bigint, which JSON cannot represent", () => {
    expect(rejectionOf({ size: 10n }).code).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("rejects a number smuggled in as pre-serialized JSON", () => {
    const error = rejectionOf('{"price":0.42}');
    expect(error.code).toBe("ECONOMIC_JSON_NUMBER");
    expect(error.path).toBe(".price");
  });

  it("accepts pre-serialized JSON with no numbers, including an array", () => {
    expect(() => assertDecimalSafeJson('[{"size":"1"}]', "signed_payload")).not.toThrow();
  });

  it("rejects pre-serialized text that is not JSON", () => {
    expect(rejectionOf("not json").code).toBe("ECONOMIC_JSON_MALFORMED");
  });

  it("rejects a value JSON.stringify would silently drop", () => {
    expect(rejectionOf({ callback: () => "x" }).code).toBe("ECONOMIC_JSON_MALFORMED");
    expect(rejectionOf({ missing: undefined }).code).toBe("ECONOMIC_JSON_MALFORMED");
  });

  it("treats an absent document as nothing to check", () => {
    expect(() => assertDecimalSafeJson(null, "payload")).not.toThrow();
    expect(() => assertDecimalSafeJson(undefined, "payload")).not.toThrow();
  });

  it("names the field it was given, so an operator knows which payload failed", () => {
    try {
      assertDecimalSafeJson({ price: 1 }, "order_events.payload");
      throw new Error("unreachable");
    } catch (error) {
      expect((error as DecimalSafeJsonError).message).toMatch(/order_events\.payload\.price/u);
    }
  });
});

describe("decimalSafeJson", () => {
  it("returns the document it checked", () => {
    const document = { price: "0.42" };
    expect(decimalSafeJson(document, "signed_payload")).toBe(document);
  });

  it("throws instead of returning when the document carries a number", () => {
    expect(() => decimalSafeJson({ price: 0.42 } as never, "signed_payload")).toThrow(
      DecimalSafeJsonError,
    );
  });
});
