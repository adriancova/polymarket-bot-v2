/**
 * `V2-3`: the `/v2/resolutions` door reads a body AS STATED (ADR-030
 * Amendment 2 rules 4 and 5; ADR-009 §8, note of 2026-10-05), on the public
 * captures of `VENUE-4` (`test/fixtures/venue/protocol-v2/data-v2-resolutions-*.jsonc`,
 * strict JSON, each the raw response byte for byte) and on synthetic bodies.
 *
 * What is pinned:
 * - the four rule-5 fields of a row, each as stated (absent, `null`, another
 *   type, a value), and nothing else read;
 * - `payouts` elements exactly as `JSON.parse` left them: numbers stay numbers
 *   (`1e6` IS 1000000, ADR-009 §8 item 3), strings stay strings — the SDK's
 *   collateral-unit `["1","0"]` (F-78) is two STRINGS, never a scaled number;
 * - the envelope: `{"data": null}` and `{"data": []}` are the envelope
 *   (documented misses, F-65, F-57); a body without `data`, or with `data` of
 *   another type, is NOT_ENVELOPE; a body that is not JSON is NOT_JSON;
 * - TOTAL and frozen: no input throws.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readDataApiResolutionsBody } from "./door.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../test/fixtures/venue/protocol-v2");
const capture = (name: string): string => readFileSync(resolve(FIXTURES, `${name}.jsonc`), "utf8");

describe("V2-3: the door reads the recorded /v2/resolutions captures as stated", () => {
  it("S-A11 (data-v2-resolutions-v2-resolved): one row — its condition, status resolved, payouts [1000000,0] as numbers, resolved_at", () => {
    expect(readDataApiResolutionsBody(capture("data-v2-resolutions-v2-resolved"))).toEqual({
      status: "ENVELOPE",
      rows: [
        {
          kind: "ROW",
          conditionId: { kind: "VALUE", value: "0x015ecdbafe90dfcb60b2f38afe44f4be85000000000000000000000000000000" },
          status: { kind: "VALUE", value: "resolved" },
          payouts: { kind: "VALUE", value: [{ kind: "NUMBER", value: 1_000_000 }, { kind: "NUMBER", value: 0 }] },
          resolvedAt: { kind: "VALUE", value: "2026-10-05T21:35:56Z" },
        },
      ],
    });
  });

  it("S-A10 (data-v2-resolutions-v1-resolved): a resolved V1 window, payouts [0,1000000]", () => {
    const reading = readDataApiResolutionsBody(capture("data-v2-resolutions-v1-resolved"));
    expect(reading).toMatchObject({
      status: "ENVELOPE",
      rows: [
        {
          kind: "ROW",
          conditionId: { kind: "VALUE", value: "0x156b8d520e362e159d70d7428f08371ecc9dc91d3437a903d97ae97908f73bec" },
          status: { kind: "VALUE", value: "resolved" },
          payouts: { kind: "VALUE", value: [{ kind: "NUMBER", value: 0 }, { kind: "NUMBER", value: 1_000_000 }] },
          resolvedAt: { kind: "VALUE", value: "2026-10-05T23:00:53Z" },
        },
      ],
    });
  });

  it("S-L04 (data-v2-resolutions-v2-active): an open market — status active, NO payouts, NO resolved_at", () => {
    expect(readDataApiResolutionsBody(capture("data-v2-resolutions-v2-active"))).toEqual({
      status: "ENVELOPE",
      rows: [
        {
          kind: "ROW",
          conditionId: { kind: "VALUE", value: "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000" },
          status: { kind: "VALUE", value: "active" },
          payouts: { kind: "ABSENT" },
          resolvedAt: { kind: "ABSENT" },
        },
      ],
    });
  });

  it("S-L05 (data-v2-resolutions-62hex-invalid): the 400 body is JSON without data — NOT_ENVELOPE", () => {
    expect(readDataApiResolutionsBody(capture("data-v2-resolutions-62hex-invalid"))).toMatchObject({ status: "NOT_ENVELOPE" });
  });
});

describe("V2-3: payouts exactly as JSON.parse left them (ADR-009 §8 item 3)", () => {
  const payoutsOf = (payouts: string) => {
    const reading = readDataApiResolutionsBody(`{"data":[{"condition_id":"0x1","status":"resolved","payouts":${payouts},"resolved_at":"x"}]}`);
    if (reading.status !== "ENVELOPE" || reading.rows === null || reading.rows[0]?.kind !== "ROW") throw new Error("not a row");
    return reading.rows[0].payouts;
  };

  it("the SDK's collateral-unit tuple [\"1\",\"0\"] (F-78) reads as two STRINGS — never a number, never scaled", () => {
    expect(payoutsOf('["1","0"]')).toEqual({ kind: "VALUE", value: [{ kind: "STRING", value: "1" }, { kind: "STRING", value: "0" }] });
  });

  it("[1,0] reads as the numbers one and zero — not a million", () => {
    expect(payoutsOf("[1,0]")).toEqual({ kind: "VALUE", value: [{ kind: "NUMBER", value: 1 }, { kind: "NUMBER", value: 0 }] });
  });

  it("a spelling that parses to the same integer is that integer: 1e6 and 1000000.0 are 1000000", () => {
    expect(payoutsOf("[1e6,0]")).toEqual({ kind: "VALUE", value: [{ kind: "NUMBER", value: 1_000_000 }, { kind: "NUMBER", value: 0 }] });
    expect(payoutsOf("[1000000.0,0]")).toEqual({ kind: "VALUE", value: [{ kind: "NUMBER", value: 1_000_000 }, { kind: "NUMBER", value: 0 }] });
  });

  it("every element of every length, as stated: a split, three elements, null, an object, a boolean", () => {
    expect(payoutsOf("[500000,500000]")).toEqual({ kind: "VALUE", value: [{ kind: "NUMBER", value: 500_000 }, { kind: "NUMBER", value: 500_000 }] });
    expect(payoutsOf("[1000000,0,0]")).toMatchObject({ kind: "VALUE", value: [{}, {}, {}] });
    expect(payoutsOf("[null,{},true]")).toEqual({
      kind: "VALUE",
      value: [
        { kind: "OTHER", detail: "null" },
        { kind: "OTHER", detail: "an object" },
        { kind: "OTHER", detail: "a boolean" },
      ],
    });
    expect(payoutsOf("[]")).toEqual({ kind: "VALUE", value: [] });
  });

  it("payouts that are null or not an array", () => {
    expect(payoutsOf("null")).toEqual({ kind: "NULL" });
    expect(payoutsOf('"[1000000,0]"')).toEqual({ kind: "UNREADABLE", detail: "a string" });
    expect(payoutsOf("{\"0\":1000000}")).toEqual({ kind: "UNREADABLE", detail: "an object" });
  });
});

describe("V2-3: the envelope (F-57, F-65), and every other body", () => {
  it('{"data": []} and {"data": null} are the documented misses: the envelope, no rows / null', () => {
    expect(readDataApiResolutionsBody('{"data":[]}')).toEqual({ status: "ENVELOPE", rows: [] });
    expect(readDataApiResolutionsBody('{"data":null}')).toEqual({ status: "ENVELOPE", rows: null });
  });

  it("a body without data, with data of another type, or not an object: NOT_ENVELOPE", () => {
    for (const body of ["{}", '{"rows":[]}', '{"data":{}}', '{"data":"x"}', '{"data":1}', "[]", "null", "1", '"data"']) {
      expect(readDataApiResolutionsBody(body).status).toBe("NOT_ENVELOPE");
    }
  });

  it("a body that is not JSON: NOT_JSON", () => {
    for (const body of ["", "<html>502</html>", "{", "{\"data\":[}", "undefined"]) {
      expect(readDataApiResolutionsBody(body).status).toBe("NOT_JSON");
    }
  });

  it("each row field as stated: absent, null, another type; a row that is not an object", () => {
    const reading = readDataApiResolutionsBody('{"data":[{"condition_id":null,"status":3,"resolved_at":false},"row",null]}');
    expect(reading).toEqual({
      status: "ENVELOPE",
      rows: [
        {
          kind: "ROW",
          conditionId: { kind: "NULL" },
          status: { kind: "UNREADABLE", detail: "a number" },
          payouts: { kind: "ABSENT" },
          resolvedAt: { kind: "UNREADABLE", detail: "a boolean" },
        },
        { kind: "NOT_A_ROW", detail: "a Resolution row is a JSON object; this element is a string" },
        { kind: "NOT_A_ROW", detail: "a Resolution row is a JSON object; this element is null" },
      ],
    });
  });

  it("reads own data only: an inherited data or status is not read (D1)", () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "data");
    Object.defineProperty(Object.prototype, "data", { value: [{ status: "resolved" }], configurable: true, writable: true });
    try {
      expect(readDataApiResolutionsBody("{}").status).toBe("NOT_ENVELOPE");
    } finally {
      if (original === undefined) delete (Object.prototype as Record<string, unknown>)["data"];
      else Object.defineProperty(Object.prototype, "data", original);
    }
  });

  it("every reading is frozen", () => {
    const reading = readDataApiResolutionsBody(capture("data-v2-resolutions-v2-resolved"));
    expect(Object.isFrozen(reading)).toBe(true);
    if (reading.status === "ENVELOPE" && reading.rows !== null) {
      expect(Object.isFrozen(reading.rows)).toBe(true);
      expect(Object.isFrozen(reading.rows[0])).toBe(true);
    }
  });
});
