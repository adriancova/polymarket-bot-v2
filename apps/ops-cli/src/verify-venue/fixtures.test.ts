/**
 * WP-000: validates that every sanitized venue fixture parses and matches its
 * source-specific recursive schema, that the frozen verification report
 * validates (sections + per-section official citations + pinned SDK links),
 * and that the skeleton's failure modes behave. Local files only — no network,
 * no credentials, no orders.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SDK_PERMALINK_PREFIX,
  SDK_REFERENCE_COMMIT,
  VENUE_CHECKS,
} from "./checks.js";
import type { VenueCheck } from "./checks.js";
import {
  VENUE_FIXTURE_ROOT,
  isCanonicalDecimalString,
  isCanonicalPriceString,
  isCredentialShapedKey,
  loadFixture,
  validateFixtureDocument,
} from "./fixtures.js";
import type {
  FieldSpec,
  FixtureExample,
  ObjectSpec,
  PayloadSpec,
} from "./fixtures.js";
import {
  CITATION_EXEMPT_SECTIONS,
  REQUIRED_REPORT_SECTIONS,
  formatVenueVerificationReport,
  loadAndValidateReport,
  reportHeadings,
  reportSectionHasOfficialCitation,
  reportSectionText,
  runVenueVerification,
  validateVerificationReport,
  venueVerificationExitCode,
} from "./index.js";

function listJsonFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...listJsonFiles(absolute));
    } else if (entry.endsWith(".json")) {
      files.push(relative(VENUE_FIXTURE_ROOT, absolute));
    }
  }
  return files.sort();
}

function checkById(id: string): VenueCheck {
  const check = VENUE_CHECKS.find((candidate) => candidate.id === id);
  expect(check, id).toBeDefined();
  return check as VenueCheck;
}

function specOf(id: string): PayloadSpec {
  return checkById(id).payloadSpec;
}

function examplesOf(relativePath: string): readonly FixtureExample[] {
  const result = loadFixture(relativePath, {});
  expect(result.fixture, result.errors.join("; ")).not.toBeNull();
  return result.fixture?.examples ?? [];
}

function exampleNamed(
  relativePath: string,
  name: string,
): Record<string, unknown> {
  const example = examplesOf(relativePath).find(
    (candidate) => candidate.name === name,
  );
  expect(example, `${relativePath}#${name}`).toBeDefined();
  return structuredClone(example?.payload as Record<string, unknown>);
}

function envelope(examples: unknown): Record<string, unknown> {
  return {
    fixture: "x/y",
    source: "https://docs.polymarket.com/x",
    retrieved: "2026-08-24",
    sanitized: true,
    notes: "n",
    examples,
  };
}

/**
 * Validates a single payload against a spec. `exampleName` selects the
 * variant for example-name-discriminated specs.
 */
function errorsFor(
  payload: Record<string, unknown>,
  spec: PayloadSpec,
  exampleName = "case",
): string[] {
  return validateFixtureDocument(
    envelope([{ name: exampleName, payload }]),
    "x/y",
    spec,
  ).errors;
}

const fixtureChecks = VENUE_CHECKS.filter((check) => check.kind === "fixture");

/** Top-level object specs of a payload spec (one per declared variant). */
function topLevelObjectSpecsOf(spec: PayloadSpec): readonly ObjectSpec[] {
  return "variants" in spec ? Object.values(spec.variants) : [spec];
}

interface ReachableObjectSpec {
  readonly path: string;
  readonly spec: ObjectSpec;
}

/**
 * Recursively collects EVERY object-shaped spec reachable from a payload spec,
 * descending through variants, nested `fields`, array `items`, `union`
 * alternatives, and map `values`.
 *
 * A non-recursive collector (which the round-3 revision used) only saw the
 * top-level variant objects, so a permissive NESTED schema — one that is
 * neither `strict` nor map-typed, or one whose fields are all optional —
 * would have escaped the catalog guards entirely.
 */
function reachableObjectSpecs(spec: PayloadSpec): readonly ReachableObjectSpec[] {
  const found: ReachableObjectSpec[] = [];
  const seen = new Set<unknown>();

  const visitField = (field: FieldSpec, path: string): void => {
    if (seen.has(field)) {
      return;
    }
    seen.add(field);
    if (field.type === "object") {
      visitObject(field, path);
      return;
    }
    if (field.type === "array" && field.items !== undefined) {
      visitField(field.items, `${path}[]`);
      return;
    }
    if (field.type === "union") {
      (field.oneOf ?? []).forEach((alternative, index) => {
        visitField(alternative, `${path}|${index}`);
      });
    }
  };

  const visitObject = (objectSpec: ObjectSpec, path: string): void => {
    found.push({ path, spec: objectSpec });
    for (const [key, field] of Object.entries(objectSpec.fields ?? {})) {
      visitField(field, `${path}.${key}`);
    }
    if (objectSpec.values !== undefined) {
      visitField(objectSpec.values, `${path}.*`);
    }
  };

  if ("variants" in spec) {
    for (const [name, variant] of Object.entries(spec.variants)) {
      visitObject(variant, `<${name}>`);
    }
  } else {
    visitObject(spec, "<root>");
  }
  return found;
}

interface ReachableFieldSpec {
  readonly path: string;
  readonly spec: FieldSpec;
}

/**
 * Recursively collects EVERY field spec reachable from a payload spec, through
 * the same edges as `reachableObjectSpecs` (variants, nested `fields`, array
 * `items`, `union` alternatives, map `values`).
 *
 * Used by the round-5 nullability guard: `optional` and `nullable` are
 * separate axes, and every `nullable` in the catalog has to be a documented
 * venue nullable rather than a convenient way to make a test go green.
 */
function reachableFieldSpecs(spec: PayloadSpec): readonly ReachableFieldSpec[] {
  const found: ReachableFieldSpec[] = [];
  const seen = new Set<unknown>();

  const visitField = (field: FieldSpec, path: string): void => {
    if (seen.has(field)) {
      return;
    }
    seen.add(field);
    found.push({ path, spec: field });
    if (field.type === "object") {
      visitObject(field, path);
      return;
    }
    if (field.type === "array" && field.items !== undefined) {
      visitField(field.items, `${path}[]`);
      return;
    }
    if (field.type === "union") {
      (field.oneOf ?? []).forEach((alternative, index) => {
        visitField(alternative, `${path}|${index}`);
      });
    }
  };

  const visitObject = (objectSpec: ObjectSpec, path: string): void => {
    for (const [key, field] of Object.entries(objectSpec.fields ?? {})) {
      visitField(field, `${path}.${key}`);
    }
    if (objectSpec.values !== undefined) {
      visitField(objectSpec.values, `${path}.*`);
    }
  };

  if ("variants" in spec) {
    for (const [name, variant] of Object.entries(spec.variants)) {
      visitObject(variant, `<${name}>`);
    }
  } else {
    visitObject(spec, "<root>");
  }
  return found;
}

describe("venue fixture catalog", () => {
  it("covers every required verification category", () => {
    const ids = VENUE_CHECKS.map((check) => check.id);
    expect(ids).toEqual([...new Set(ids)]);
    for (const required of [
      "sdk-and-runtime",
      "order-schemas-and-types",
      "market-ws-book",
      "market-ws-price-change",
      "market-ws-tick-size",
      "market-ws-last-trade",
      "market-ws-best-bid-ask",
      "market-ws-lifecycle",
      "user-ws-order-lifecycle",
      "user-ws-trade-settlement",
      "rest-trade-settlement",
      "heartbeat",
      "fees-and-rewards",
      "per-market-parameters",
      "rate-limits",
      "restricted-modes",
      "geoblock",
      "position-operations",
      "chainlink-twap-rtds",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("every fixture file on disk is claimed by exactly one check", () => {
    const onDisk = listJsonFiles(VENUE_FIXTURE_ROOT);
    const claimed = fixtureChecks
      .flatMap((check) => [...check.fixtures])
      .sort();
    expect(claimed).toEqual([...new Set(claimed)]);
    expect(onDisk).toEqual(claimed);
  });

  it("no reachable object schema is permissive (non-strict, non-mapped) at ANY nesting level", () => {
    for (const check of fixtureChecks) {
      for (const { path, spec } of reachableObjectSpecs(check.payloadSpec)) {
        expect(
          spec.strict === true || spec.values !== undefined,
          `${check.id} ${path} silently accepts unknown keys`,
        ).toBe(true);
        expect(
          Object.keys(spec.fields ?? {}).length > 0 ||
            spec.values !== undefined,
          `${check.id} ${path} declares neither fields nor a map value spec`,
        ).toBe(true);
      }
    }
  });

  it("every reachable object schema with fields has a required field at ANY nesting level", () => {
    // Guards against the "everything optional" vacuity mode at every depth: an
    // object (top-level variant, nested object, array element, union
    // alternative, or map value) whose fields are all optional would accept an
    // empty object. Map-only schemas (`values`, no `fields`) are exempt: an
    // empty map is a legitimate value, and their entries are typed instead.
    for (const check of fixtureChecks) {
      for (const { path, spec } of reachableObjectSpecs(check.payloadSpec)) {
        const fields = Object.values(spec.fields ?? {});
        if (fields.length === 0) {
          continue;
        }
        const required = fields.filter((field) => field.optional !== true);
        expect(
          required.length,
          `${check.id} ${path} has no required field`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every reachable map value spec is typed, never `unknown`", () => {
    // An `unknown` map value spec would re-open the hole that typing the
    // nested structures closed: every entry would validate vacuously.
    for (const check of fixtureChecks) {
      for (const { path, spec } of reachableObjectSpecs(check.payloadSpec)) {
        if (spec.values === undefined) {
          continue;
        }
        expect(
          spec.values.type,
          `${check.id} ${path} declares an untyped map value spec`,
        ).not.toBe("unknown");
      }
    }
  });

  it("the recursive walker reaches strictly deeper than the top-level variants", () => {
    // Regression guard for the walker itself: if it silently degenerated to
    // the old top-level-only collector, the guards above would pass vacuously.
    const feesSpec = specOf("fees-and-rewards");
    const reachablePaths = reachableObjectSpecs(feesSpec).map(
      (entry) => entry.path,
    );
    expect(reachablePaths.length).toBeGreaterThan(
      topLevelObjectSpecsOf(feesSpec).length,
    );
    // Nested object, array element, and map value specs must all be reached.
    expect(reachablePaths).toContain(
      "<liquidity-rewards-market-settings>.single_sided_midpoint_band",
    );
    expect(reachablePaths).toContain(
      "<liquidity-rewards-market-settings>.market_settings_example.clobRewards[]",
    );
    expect(
      reachableObjectSpecs(specOf("rate-limits")).map((entry) => entry.path),
    ).toContain("<ip-limits-snapshot>.trading_dual_limits.*");
  });

  it("the permissive-schema guard actually fails on a permissive nested schema", () => {
    // Mutation probe: a nested object that is neither strict nor map-typed,
    // and an all-optional nested object, must both be reported by the walker.
    const permissive: PayloadSpec = {
      strict: true,
      fields: {
        outer: {
          type: "object",
          fields: { inner: { type: "string", optional: true } },
        },
      },
    };
    const specs = reachableObjectSpecs(permissive);
    const nested = specs.find((entry) => entry.path === "<root>.outer");
    expect(nested).toBeDefined();
    expect(
      nested?.spec.strict === true || nested?.spec.values !== undefined,
    ).toBe(false);
    const requiredFields = Object.values(nested?.spec.fields ?? {}).filter(
      (field) => field.optional !== true,
    );
    expect(requiredFields.length).toBe(0);
  });
});

describe("venue fixture structural validation", () => {
  for (const check of fixtureChecks) {
    for (const fixturePath of check.fixtures) {
      it(`${fixturePath} parses and matches its schema (${check.id})`, () => {
        const result = loadFixture(fixturePath, check.payloadSpec);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.fixture?.sanitized).toBe(true);
        expect(result.fixture?.retrieved).toBe("2026-08-24");
        expect(result.fixture?.examples.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("canonical decimal and price validation", () => {
  it("accepts canonical forms", () => {
    for (const value of ["0", "1", "0.5", "0.05", "-1.5", "33343.4", "120"]) {
      expect(isCanonicalDecimalString(value), value).toBe(true);
    }
  });

  for (const bad of [
    "-0",
    "01.23",
    "1.50",
    "1.",
    "+1",
    "1e5",
    "1E5",
    ".5",
    "0.50",
    "00",
    "1,5",
    "",
  ]) {
    it(`rejects non-canonical decimal ${JSON.stringify(bad)}`, () => {
      expect(isCanonicalDecimalString(bad)).toBe(false);
    });
  }

  it("bounds prices to [0, 1]", () => {
    expect(isCanonicalPriceString("0")).toBe(true);
    expect(isCanonicalPriceString("1")).toBe(true);
    expect(isCanonicalPriceString("0.08")).toBe(true);
    expect(isCanonicalPriceString("1.5")).toBe(false);
    expect(isCanonicalPriceString("2")).toBe(false);
    expect(isCanonicalPriceString("-0.5")).toBe(false);
    expect(isCanonicalPriceString("0.50")).toBe(false);
  });

  // The price bound must be decided lexically on the canonical string. A
  // `Number()`-based bound underflows "-0.000…001" to -0 (accepting a negative
  // price) and rounds "1.000…001" to 1 (accepting a price above 1).
  it("rejects negative prices that underflow binary floating point", () => {
    const underflow = `-0.${"0".repeat(400)}1`;
    expect(Number(underflow)).toBe(-0);
    expect(isCanonicalDecimalString(underflow)).toBe(true);
    expect(isCanonicalPriceString(underflow)).toBe(false);
  });

  it("rejects prices above 1 that round down to 1 in binary floating point", () => {
    const overflow = `1.${"0".repeat(400)}1`;
    expect(Number(overflow)).toBe(1);
    expect(isCanonicalDecimalString(overflow)).toBe(true);
    expect(isCanonicalPriceString(overflow)).toBe(false);
  });

  for (const boundary of ["0", "1", "0.0000000000000000000000001", "0.9999999"]) {
    it(`accepts in-range price boundary ${JSON.stringify(boundary)}`, () => {
      expect(isCanonicalPriceString(boundary)).toBe(true);
    });
  }

  for (const outOfRange of [
    "1.0000000000000000000000001",
    "-0.0000000000000000000000001",
    "2",
    "10",
    "-1",
  ]) {
    it(`rejects out-of-range price ${JSON.stringify(outOfRange)}`, () => {
      expect(isCanonicalPriceString(outOfRange)).toBe(false);
    });
  }

  it("rejects underflowing prices inside a schema, not just in isolation", () => {
    const payload = exampleNamed("market-ws/best-bid-ask.json", "best-bid-ask");
    payload["best_bid"] = `-0.${"0".repeat(400)}1`;
    expect(
      errorsFor(payload, specOf("market-ws-best-bid-ask")).some((error) =>
        error.includes("best_bid"),
      ),
    ).toBe(true);
  });

  it("rejects out-of-range and non-canonical prices inside schemas", () => {
    const errors = errorsFor(
      {
        event_type: "last_trade_price",
        market: "m",
        asset_id: "a",
        price: "1.5",
        size: "-0",
        side: "SELL",
        timestamp: "1",
      },
      specOf("market-ws-last-trade"),
    );
    expect(errors.some((error) => error.includes("within [0, 1]"))).toBe(true);
    expect(
      errors.some((error) => error.includes("canonical decimal string")),
    ).toBe(true);
  });
});

describe("heartbeat protocol shapes", () => {
  const examples = examplesOf("heartbeat/heartbeat.json");
  const byName = new Map(examples.map((example) => [example.name, example]));

  it("bootstrap request carries an EMPTY heartbeat id", () => {
    expect(
      byName.get("bootstrap-request-empty-id")?.payload["heartbeat_id"],
    ).toBe("");
  });

  it("bootstrap response returns a new non-empty id", () => {
    const id = byName.get("bootstrap-response-new-id")?.payload[
      "heartbeat_id"
    ];
    expect(typeof id).toBe("string");
    expect(id).not.toBe("");
  });

  it("each successful response rotates the id", () => {
    const sent = byName.get("continuation-request")?.payload["heartbeat_id"];
    const next = byName.get("continuation-response-rotated-id")?.payload[
      "heartbeat_id"
    ];
    expect(sent).toBe(
      byName.get("bootstrap-response-new-id")?.payload["heartbeat_id"],
    );
    expect(next).not.toBe(sent);
  });

  it("invalid-id recovery response carries error_msg and the expected id", () => {
    const recovery = byName.get("response-400-invalid-id-recovery")?.payload;
    expect(recovery?.["error_msg"]).toBe("Invalid Heartbeat ID");
    expect(typeof recovery?.["heartbeat_id"]).toBe("string");
    expect(recovery?.["heartbeat_id"]).not.toBe("");
  });

  it("timeout semantics are documented in the fixture notes", () => {
    const result = loadFixture("heartbeat/heartbeat.json", {});
    expect(result.fixture?.notes).toContain("10 seconds");
    expect(result.fixture?.notes).toContain("5 seconds");
  });

  it("rejects an error_msg on a heartbeat variant that has no error field", () => {
    expect(
      errorsFor(
        { heartbeat_id: "sanitized-heartbeat-id-0001", error_msg: "boom" },
        specOf("heartbeat"),
        "continuation-request",
      ).some((error) => error.includes("unexpected key")),
    ).toBe(true);
  });
});

describe("restricted-mode shapes", () => {
  const examples = examplesOf("orders/restricted-modes.json");
  const byName = new Map(examples.map((example) => [example.name, example]));

  it("425 restart example carries only the documented status (no invented body)", () => {
    const example = byName.get(
      "http-425-engine-restarting-body-undocumented",
    );
    expect(example?.payload["http_status"]).toBe(425);
    expect(example?.payload).not.toHaveProperty("body");
  });

  it("the 425 documented-absence variant rejects an invented body", () => {
    // The undocumented 425 body (report item U-9) is modeled as an explicit
    // strict variant with no body, so a fabricated body fails validation
    // rather than passing through an all-optional schema.
    expect(
      errorsFor(
        { http_status: 425, body: { error: "invented" } },
        specOf("restricted-modes"),
        "http-425-engine-restarting-body-undocumented",
      ).some((error) => error.includes("body: unexpected key")),
    ).toBe(true);
  });

  it("503 cancel-only body uses the documented 'error' field", () => {
    const body = byName.get("http-503-cancel-only")?.payload["body"] as
      | Record<string, unknown>
      | undefined;
    expect(body?.["error"]).toBe(
      "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed.",
    );
    expect(body).not.toHaveProperty("error_msg");
  });

  it("503 post-only body carries error, code=post_only_mode, retry_after_seconds, and Retry-After header", () => {
    const example = byName.get("http-503-post-only");
    const body = example?.payload["body"] as Record<string, unknown>;
    expect(body["error"]).toBe(
      "post-only mode: only post-only orders and cancels are allowed",
    );
    expect(body["code"]).toBe("post_only_mode");
    expect(typeof body["retry_after_seconds"]).toBe("number");
    const headers = example?.payload["headers"] as Record<string, unknown>;
    expect(headers).toHaveProperty("Retry-After");
  });

  it("rejects a restricted-mode body missing the documented 'error' field", () => {
    const errors = errorsFor(
      { http_status: 503, body: { error_msg: "wrong field name" } },
      specOf("restricted-modes"),
      "http-503-cancel-only",
    );
    expect(
      errors.some((error) => error.includes("body.error: missing required key")),
    ).toBe(true);
  });

  it("rejects a non-numeric Retry-After header value", () => {
    const payload = exampleNamed(
      "orders/restricted-modes.json",
      "http-503-post-only",
    );
    (payload["headers"] as Record<string, unknown>)["Retry-After"] = "soon";
    expect(
      errorsFor(payload, specOf("restricted-modes"), "http-503-post-only").some(
        (error) => error.includes("headers.Retry-After"),
      ),
    ).toBe(true);
  });
});

describe("raw user-stream trade events (official SDK UserTradeEventSchema)", () => {
  const spec = specOf("user-ws-trade-settlement");
  const examples = examplesOf("user-ws/trade-settlement.json");

  it("covers the five plain user-channel wire statuses", () => {
    const statuses = examples.map((example) => example.payload["status"]);
    for (const status of [
      "MATCHED",
      "MINED",
      "CONFIRMED",
      "RETRYING",
      "FAILED",
    ]) {
      expect(statuses).toContain(status);
    }
    expect(statuses).not.toContain("MATCHED_NOT_BROADCASTED");
  });

  it("every trade event carries the SDK-required type and owner", () => {
    for (const example of examples) {
      expect(example.payload["type"]).toBe("TRADE");
      expect(typeof example.payload["owner"]).toBe("string");
    }
  });

  const validTrade = (): Record<string, unknown> =>
    structuredClone(examples[0]?.payload as Record<string, unknown>);

  it("fails when top-level type is missing", () => {
    const payload = validTrade();
    delete payload["type"];
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes(".type: missing required key"),
      ),
    ).toBe(true);
  });

  it("fails when top-level owner is missing", () => {
    const payload = validTrade();
    delete payload["owner"];
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes(".owner: missing required key"),
      ),
    ).toBe(true);
  });

  for (const field of ["owner", "asset_id", "side"]) {
    it(`fails when a maker order omits required ${field}`, () => {
      const payload = validTrade();
      const makers = payload["maker_orders"] as Array<
        Record<string, unknown>
      >;
      delete makers[0]?.[field];
      expect(
        errorsFor(payload, spec).some((error) =>
          error.includes(`maker_orders[0].${field}: missing required key`),
        ),
      ).toBe(true);
    });
  }

  it("rejects the REST-only MATCHED_NOT_BROADCASTED status on the user stream", () => {
    const payload = validTrade();
    payload["status"] = "MATCHED_NOT_BROADCASTED";
    expect(
      errorsFor(payload, spec).some((error) => error.includes("not in enum")),
    ).toBe(true);
  });

  // --- SDK wire-type fidelity (pinned reference commit) -------------------

  it("accepts the wire EMPTY STRING for optional decimals (OptionalDecimalStringSchema)", () => {
    const payload = validTrade();
    payload["fee_rate_bps"] = "";
    expect(errorsFor(payload, spec)).toEqual([]);
  });

  it("accepts an empty maker-order fee_rate_bps", () => {
    const payload = validTrade();
    const makers = payload["maker_orders"] as Array<Record<string, unknown>>;
    (makers[0] as Record<string, unknown>)["fee_rate_bps"] = "";
    expect(errorsFor(payload, spec)).toEqual([]);
  });

  it("still rejects a malformed non-empty optional decimal", () => {
    const payload = validTrade();
    payload["fee_rate_bps"] = "0.50";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("fee_rate_bps"),
      ),
    ).toBe(true);
  });

  it("rejects a fractional bucket_index (SDK z.number().int())", () => {
    const payload = validTrade();
    payload["bucket_index"] = 0.5;
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("bucket_index: expected integer"),
      ),
    ).toBe(true);
  });

  it("rejects a fractional maker-order outcome_index (SDK z.number().int())", () => {
    const payload = validTrade();
    const makers = payload["maker_orders"] as Array<Record<string, unknown>>;
    (makers[0] as Record<string, unknown>)["outcome_index"] = 1.25;
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("outcome_index: expected integer"),
      ),
    ).toBe(true);
  });

  for (const epochField of ["timestamp", "match_time", "last_update"]) {
    it(`rejects a non-digit ${epochField} (SDK /^\\d+$/ epoch schema)`, () => {
      const payload = validTrade();
      payload[epochField] = "2026-08-24T00:00:00Z";
      expect(
        errorsFor(payload, spec).some((error) =>
          error.includes(`${epochField}: expected a digit string`),
        ),
      ).toBe(true);
    });
  }

  it("accepts the SDK `matchtime` alias and validates it as an epoch digit string", () => {
    const payload = validTrade();
    payload["matchtime"] = "1782753360";
    expect(errorsFor(payload, spec)).toEqual([]);
    payload["matchtime"] = "not-an-epoch";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("matchtime: expected a digit string"),
      ),
    ).toBe(true);
  });

  it("rejects a field that is not in the frozen SDK schema", () => {
    const payload = validTrade();
    payload["totally_made_up_field"] = 1;
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("totally_made_up_field: unexpected key"),
      ),
    ).toBe(true);
  });

  it("rejects an unknown key inside a maker order", () => {
    const payload = validTrade();
    const makers = payload["maker_orders"] as Array<Record<string, unknown>>;
    (makers[0] as Record<string, unknown>)["invented"] = true;
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("maker_orders[0].invented: unexpected key"),
      ),
    ).toBe(true);
  });
});

describe("REST trade reads (official SDK ClobTradeSchema)", () => {
  const spec = specOf("rest-trade-settlement");
  const examples = examplesOf("orders/rest-trades.json");

  it("models MATCHED_NOT_BROADCASTED in the REST layer only (C-3)", () => {
    const statuses = examples.map((example) => example.payload["status"]);
    expect(statuses).toContain("TRADE_STATUS_MATCHED_NOT_BROADCASTED");
    for (const status of statuses) {
      expect(String(status).startsWith("TRADE_STATUS_")).toBe(true);
    }
  });

  it("rejects plain (user-channel) status values in the REST layer", () => {
    const payload = structuredClone(
      examples[0]?.payload as Record<string, unknown>,
    );
    payload["status"] = "MATCHED";
    expect(
      errorsFor(payload, spec).some((error) => error.includes("not in enum")),
    ).toBe(true);
  });

  // ClobTradeSchema requires every field; the websocket event does not.
  for (const required of [
    "asset_id",
    "bucket_index",
    "fee_rate_bps",
    "id",
    "last_update",
    "maker_address",
    "maker_orders",
    "market",
    "match_time",
    "outcome",
    "owner",
    "price",
    "side",
    "size",
    "status",
    "taker_order_id",
    "trader_side",
    "transaction_hash",
  ]) {
    it(`requires ${required} on every REST trade`, () => {
      const payload = structuredClone(
        examples[0]?.payload as Record<string, unknown>,
      );
      delete payload[required];
      expect(
        errorsFor(payload, spec).some((error) =>
          error.includes(`${required}: missing required key`),
        ),
      ).toBe(true);
    });
  }

  it("rejects an outcome_index on a REST maker order (websocket-only field)", () => {
    const payload = structuredClone(
      examples[0]?.payload as Record<string, unknown>,
    );
    const makers = payload["maker_orders"] as Array<Record<string, unknown>>;
    (makers[0] as Record<string, unknown>)["outcome_index"] = 0;
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("maker_orders[0].outcome_index: unexpected key"),
      ),
    ).toBe(true);
  });

  for (const required of ["maker_address", "outcome"]) {
    it(`requires ${required} on a REST maker order (SDK MakerOrderSchema)`, () => {
      const payload = structuredClone(
        examples[0]?.payload as Record<string, unknown>,
      );
      const makers = payload["maker_orders"] as Array<Record<string, unknown>>;
      delete (makers[0] as Record<string, unknown>)[required];
      expect(
        errorsFor(payload, spec).some((error) =>
          error.includes(`maker_orders[0].${required}: missing required key`),
        ),
      ).toBe(true);
    });
  }

  it("accepts a REST bucket_index that is not an integer (SDK z.number())", () => {
    // Deliberate divergence from the websocket schema, which uses .int().
    const payload = structuredClone(
      examples[0]?.payload as Record<string, unknown>,
    );
    payload["bucket_index"] = 0.5;
    expect(errorsFor(payload, spec)).toEqual([]);
  });

  it("rejects a market id that is not a 31/32-byte hex string", () => {
    const payload = structuredClone(
      examples[0]?.payload as Record<string, unknown>,
    );
    payload["market"] = "0xdeadbeef";
    expect(
      errorsFor(payload, spec).some((error) => error.includes("market")),
    ).toBe(true);
  });
});

describe("user order events (official SDK UserOrderEventSchema)", () => {
  const spec = specOf("user-ws-order-lifecycle");

  it("every order event carries the full raw wire field set", () => {
    for (const example of examplesOf("user-ws/order-lifecycle.json")) {
      for (const field of [
        "event_type",
        "type",
        "id",
        "owner",
        "market",
        "asset_id",
        "side",
        "original_size",
        "size_matched",
        "price",
        "status",
        "timestamp",
      ]) {
        expect(
          example.payload,
          `${example.name} missing ${field}`,
        ).toHaveProperty(field);
      }
    }
  });

  it("order lifecycle covers PLACEMENT, UPDATE, and CANCELLATION", () => {
    const types = examplesOf("user-ws/order-lifecycle.json").map(
      (example) => example.payload["type"],
    );
    for (const type of ["PLACEMENT", "UPDATE", "CANCELLATION"]) {
      expect(types).toContain(type);
    }
  });

  it("validates the SDK-optional fields omitted by the frozen examples", () => {
    const payload = exampleNamed(
      "user-ws/order-lifecycle.json",
      "placement-live",
    );
    payload["order_type"] = "GTX";
    payload["associate_trades"] = [1];
    payload["created_at"] = "yesterday";
    const errors = errorsFor(payload, spec);
    expect(errors.some((error) => error.includes("order_type"))).toBe(true);
    expect(
      errors.some((error) => error.includes("associate_trades[0]")),
    ).toBe(true);
    expect(errors.some((error) => error.includes("created_at"))).toBe(true);
  });

  it("accepts the SDK-optional fields when well formed", () => {
    const payload = exampleNamed(
      "user-ws/order-lifecycle.json",
      "placement-live",
    );
    payload["order_type"] = "GTD";
    payload["order_owner"] = "00000000-0000-0000-0000-000000000000";
    payload["associate_trades"] = ["00000000-0000-0000-0000-00000000t001"];
    payload["created_at"] = "1782753357";
    payload["expiration"] = "1782753957";
    payload["maker_address"] = "0x0000000000000000000000000000000000000000";
    expect(errorsFor(payload, spec)).toEqual([]);
  });

  it("rejects a field that is not in the frozen SDK order schema", () => {
    const payload = exampleNamed(
      "user-ws/order-lifecycle.json",
      "placement-live",
    );
    payload["fee_rate_bps"] = "0";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("fee_rate_bps: unexpected key"),
      ),
    ).toBe(true);
  });
});

describe("market lifecycle events (discriminated SDK schemas)", () => {
  const spec = specOf("market-ws-lifecycle");

  it("requires the SDK-required id on new_market", () => {
    const payload = exampleNamed("market-ws/lifecycle.json", "new-market");
    delete payload["id"];
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("id: missing required key"),
      ),
    ).toBe(true);
  });

  it("requires the SDK-required id on market_resolved", () => {
    const payload = exampleNamed("market-ws/lifecycle.json", "market-resolved");
    delete payload["id"];
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("id: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects new_market-only fields on a market_resolved event", () => {
    const payload = exampleNamed("market-ws/lifecycle.json", "market-resolved");
    payload["outcomes"] = ["Yes", "No"];
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("outcomes: unexpected key"),
      ),
    ).toBe(true);
  });

  it("rejects an undeclared event_type variant", () => {
    const payload = exampleNamed("market-ws/lifecycle.json", "new-market");
    payload["event_type"] = "market_paused";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("no schema variant declared"),
      ),
    ).toBe(true);
  });

  it("validates nested event_message and typed optional fields", () => {
    const payload = exampleNamed("market-ws/lifecycle.json", "new-market");
    payload["event_message"] = { ticker: "abc" };
    payload["active"] = "yes";
    payload["condition_id"] = "0xzz";
    const errors = errorsFor(payload, spec);
    expect(
      errors.some((error) =>
        error.includes("event_message.id: missing required key"),
      ),
    ).toBe(true);
    expect(errors.some((error) => error.includes("active"))).toBe(true);
    expect(errors.some((error) => error.includes("condition_id"))).toBe(true);
  });
});

describe("order placement responses (official SDK OrderResponsePayloadSchema)", () => {
  const spec = specOf("order-schemas-and-types");
  const examples = examplesOf("orders/order-responses.json");

  it("covers live, matched, delayed, and unmatched statuses plus failures", () => {
    const statuses = examples.map((example) => example.payload["status"]);
    for (const status of ["live", "matched", "delayed", "unmatched"]) {
      expect(statuses).toContain(status);
    }
    expect(
      examples.filter((example) => example.payload["success"] === false)
        .length,
    ).toBeGreaterThan(0);
  });

  it("delayed order response is pending: zero amounts and no trades/hashes", () => {
    const delayed = examples.find(
      (example) => example.payload["status"] === "delayed",
    );
    expect(delayed?.payload["makingAmount"]).toBe("0");
    expect(delayed?.payload["takingAmount"]).toBe("0");
    expect(delayed?.payload["tradeIDs"]).toEqual([]);
    expect(delayed?.payload["transactionsHashes"]).toEqual([]);
  });

  it("failure responses omit transactionsHashes and tradeIDs (official optionality)", () => {
    const failures = examples.filter(
      (example) => example.payload["success"] === false,
    );
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.payload).not.toHaveProperty("transactionsHashes");
      expect(failure.payload).not.toHaveProperty("tradeIDs");
    }
  });

  it("accepts the empty-string making/taking amounts the API serializes", () => {
    const payload = exampleNamed(
      "orders/order-responses.json",
      "error-insufficient-balance-or-allowance",
    );
    expect(payload["makingAmount"]).toBe("");
    expect(errorsFor(payload, spec)).toEqual([]);
  });

  it("rejects a non-canonical, non-empty amount", () => {
    const payload = exampleNamed("orders/order-responses.json", "limit-live");
    payload["makingAmount"] = "0.50";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("makingAmount"),
      ),
    ).toBe(true);
  });

  it("rejects a field outside the frozen SDK response payload", () => {
    const payload = exampleNamed("orders/order-responses.json", "limit-live");
    payload["code"] = "unknown";
    expect(
      errorsFor(payload, spec).some((error) =>
        error.includes("code: unexpected key"),
      ),
    ).toBe(true);
  });
});

describe("nested contract validation (negative cases)", () => {
  it("rejects malformed book levels", () => {
    const errors = errorsFor(
      {
        event_type: "book",
        market: "m",
        asset_id: "a",
        timestamp: "1",
        bids: [{ price: "1.50", size: "10" }],
        asks: [{ price: "0.09" }],
      },
      specOf("market-ws-book"),
    );
    expect(errors.some((error) => error.includes("bids[0].price"))).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("asks[0].size: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects an unknown key inside a book level", () => {
    const payload = exampleNamed("market-ws/book-snapshot.json", "book-snapshot");
    (payload["bids"] as Array<Record<string, unknown>>)[0] = {
      price: "0.07",
      size: "5000",
      depth: 3,
    };
    expect(
      errorsFor(payload, specOf("market-ws-book")).some((error) =>
        error.includes("bids[0].depth: unexpected key"),
      ),
    ).toBe(true);
  });

  it("rejects malformed price changes", () => {
    const errors = errorsFor(
      {
        event_type: "price_change",
        market: "m",
        timestamp: "1",
        price_changes: [
          { asset_id: "a", price: "0.08", size: "10", side: "HOLD" },
          { asset_id: "a", price: "2", size: "10", side: "BUY" },
        ],
      },
      specOf("market-ws-price-change"),
    );
    expect(
      errors.some((error) => error.includes("price_changes[0].side")),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("price_changes[1].price")),
    ).toBe(true);
  });

  it("rejects malformed rate-limit tier entries", () => {
    const errors = errorsFor(
      {
        effective_date: "2026-08-24",
        token_costs: {},
        batch_admission: "x",
        tiers: [
          {
            tier: "Standard",
            volume_30d_usd: "0",
            order_tokens_per_s: "forty",
            order_burst: 60,
            cancel_tokens_per_s: 80,
          },
        ],
      },
      specOf("rate-limits"),
      "per-signer-token-buckets-snapshot",
    );
    expect(
      errors.some((error) => error.includes("tiers[0].order_tokens_per_s")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("tiers[0].cancel_burst: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects a fractional rate-limit token rate", () => {
    const payload = exampleNamed(
      "rate-limits/rate-limits.json",
      "per-signer-token-buckets-snapshot",
    );
    (payload["tiers"] as Array<Record<string, unknown>>)[0] = {
      tier: "Standard",
      volume_30d_usd: "0",
      order_tokens_per_s: 40.5,
      order_burst: 60,
      cancel_tokens_per_s: 80,
      cancel_burst: 120,
    };
    expect(
      errorsFor(
        payload,
        specOf("rate-limits"),
        "per-signer-token-buckets-snapshot",
      ).some((error) => error.includes("order_tokens_per_s: expected integer")),
    ).toBe(true);
  });

  // The review probe: a boolean header value produced ZERO errors before the
  // header bag was typed.
  it("rejects a BOOLEAN rate-limit header value", () => {
    const errors = errorsFor(
      {
        headers: {
          "Poly-RateLimit-Remaining": true,
          "Poly-RateLimit-Reset": "1782753360",
          "Poly-RateLimit-Tier": "standard",
        },
      },
      specOf("rate-limits"),
      "response-headers-success",
    );
    expect(
      errors.some((error) =>
        error.includes("headers.Poly-RateLimit-Remaining"),
      ),
    ).toBe(true);
  });

  it("rejects a non-numeric rate-limit reset header and an undocumented header name", () => {
    const errors = errorsFor(
      {
        headers: {
          "Poly-RateLimit-Remaining": "57",
          "Poly-RateLimit-Reset": "soon",
          "Poly-RateLimit-Tier": "standard",
          "X-Invented-Header": "1",
        },
      },
      specOf("rate-limits"),
      "response-headers-success",
    );
    expect(
      errors.some((error) => error.includes("headers.Poly-RateLimit-Reset")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("headers.X-Invented-Header: unexpected key"),
      ),
    ).toBe(true);
  });

  it("rejects non-integer IP limits and malformed dual-limit entries", () => {
    const errors = errorsFor(
      {
        effective_date: "2026-08-24",
        enforcement: "x",
        limits_per_10s: { general: "lots" },
        trading_dual_limits: {
          "POST /order": true,
          "DELETE /order": { burst_per_10s: 5000 },
        },
      },
      specOf("rate-limits"),
      "ip-limits-snapshot",
    );
    expect(
      errors.some((error) => error.includes("limits_per_10s.general")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes('trading_dual_limits.POST /order: expected object'),
      ),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("sustained_per_10min: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects a non-decimal fee-table value", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "fee-model-snapshot",
    );
    (payload["taker_fee_rate_by_category"] as Record<string, unknown>)[
      "crypto"
    ] = false;
    expect(
      errorsFor(payload, specOf("fees-and-rewards"), "fee-model-snapshot").some(
        (error) => error.includes("taker_fee_rate_by_category.crypto"),
      ),
    ).toBe(true);
  });

  it("rejects non-canonical rebate tier rates and malformed nested reward settings", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    const settings = payload["market_settings_example"] as Record<
      string,
      unknown
    >;
    (settings["clobRewards"] as Array<Record<string, unknown>>)[0] = {
      id: "sanitized-reward-id-0001",
      conditionId: "0xnothex",
      assetAddress: "0x0000000000000000000000000000000000000000",
      rewardsAmount: "10000",
      rewardsDailyRate: "100",
      startDate: "2026-07-01",
    };
    const errors = errorsFor(
      payload,
      specOf("fees-and-rewards"),
      "liquidity-rewards-market-settings",
    );
    expect(
      errors.some((error) => error.includes("clobRewards[0].conditionId")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("clobRewards[0].endDate: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects an example whose name has no declared schema variant", () => {
    expect(
      errorsFor({}, specOf("fees-and-rewards"), "brand-new-snapshot").some(
        (error) => error.includes("no schema variant declared"),
      ),
    ).toBe(true);
  });

  it("rejects malformed position transaction outcomes and requests", () => {
    const errors = errorsFor(
      {
        operation: "split",
        description: "d",
        onchain_function: "splitPosition(...)",
        request: {
          collateralToken: "0x0000000000000000000000000000000000000000",
          conditionId: "c",
          amount: "01.5",
        },
        transaction_outcome: { transactionHash: "0x00" },
      },
      specOf("position-operations"),
    );
    expect(
      errors.some((error) =>
        error.includes("request.parentCollectionId: missing required key"),
      ),
    ).toBe(true);
    expect(errors.some((error) => error.includes("request.amount"))).toBe(true);
    expect(
      errors.some((error) =>
        error.includes(
          "transaction_outcome.transactionId: missing required key",
        ),
      ),
    ).toBe(true);
  });

  // Round-4 HIGH(c): the official positions page types the outcome handle as
  // `outcome.transactionId: TransactionId | null` (Python `str | None`)
  // (https://docs.polymarket.com/trading/positions/manage, accessed
  // 2026-08-26), so a null relayer id is VALID.
  it("accepts a null TransactionOutcome.transactionId and still accepts a string", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "redeem-request-and-outcome",
    );
    const outcome = payload["transaction_outcome"] as Record<string, unknown>;
    expect(errorsFor(payload, specOf("position-operations"))).toEqual([]);
    outcome["transactionId"] = null;
    expect(errorsFor(payload, specOf("position-operations"))).toEqual([]);
  });

  it("still rejects a non-string, non-null TransactionOutcome.transactionId", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "redeem-request-and-outcome",
    );
    (payload["transaction_outcome"] as Record<string, unknown>)[
      "transactionId"
    ] = 42;
    expect(
      errorsFor(payload, specOf("position-operations")).some((error) =>
        error.includes("transaction_outcome.transactionId: expected string"),
      ),
    ).toBe(true);
  });

  it("freezes a null-transactionId outcome example in the positions fixture", () => {
    const example = examplesOf("positions/split-merge-redeem.json").find(
      (candidate) => candidate.name === "redeem-outcome-null-transaction-id",
    );
    expect(example).toBeDefined();
    const outcome = example?.payload["transaction_outcome"] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(outcome, "transactionId")).toBe(true);
    expect(outcome["transactionId"]).toBeNull();
  });

  // Round-4 HIGH(d): the official market-details definition types
  // `endDate: IsoCalendarDateString | null`
  // (https://docs.polymarket.com/market-data/market-details, accessed
  // 2026-08-26) — null when the program has no end date.
  it("accepts a null clobRewards[].endDate and still accepts a date string", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    const settings = payload["market_settings_example"] as Record<
      string,
      unknown
    >;
    const rewards = settings["clobRewards"] as Array<Record<string, unknown>>;
    expect(
      errorsFor(
        payload,
        specOf("fees-and-rewards"),
        "liquidity-rewards-market-settings",
      ),
    ).toEqual([]);
    rewards[0]!["endDate"] = null;
    expect(
      errorsFor(
        payload,
        specOf("fees-and-rewards"),
        "liquidity-rewards-market-settings",
      ),
    ).toEqual([]);
  });

  it("still rejects a non-string, non-null clobRewards[].endDate", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    const settings = payload["market_settings_example"] as Record<
      string,
      unknown
    >;
    (settings["clobRewards"] as Array<Record<string, unknown>>)[0]!["endDate"] =
      20260731;
    expect(
      errorsFor(
        payload,
        specOf("fees-and-rewards"),
        "liquidity-rewards-market-settings",
      ).some((error) =>
        error.includes("clobRewards[0].endDate: expected string"),
      ),
    ).toBe(true);
  });

  it("freezes a null-endDate clobRewards entry in the fees fixture", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    const rewards = (
      payload["market_settings_example"] as Record<string, unknown>
    )["clobRewards"] as Array<Record<string, unknown>>;
    const openEnded = rewards.find((reward) => reward["endDate"] === null);
    expect(openEnded).toBeDefined();
    expect(Object.hasOwn(openEnded ?? {}, "endDate")).toBe(true);
  });

  // --- Round-4b: clobRewards decimal layer -------------------------------
  //
  // The official market-details page publishes two layers for the reward
  // amounts (https://docs.polymarket.com/market-data/market-details, accessed
  // 2026-08-26): the SDK-parsed model types `rewardsAmount` /
  // `rewardsDailyRate` / `rewardsMinSize` as `DecimalString` (Python
  // `Decimal`) and prints them QUOTED, while the raw Gamma tab types them
  // `number` and prints them UNQUOTED. `ClobRewardsSchema` uses
  // `DecimalishSchema` (a `string | number` input union that always OUTPUTS a
  // decimal string), so both are real. This fixture claims the PARSED layer,
  // so an un-parsed JSON number must fail here.

  const rewardSettings = (): {
    payload: Record<string, unknown>;
    settings: Record<string, unknown>;
    rewards: Array<Record<string, unknown>>;
  } => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    const settings = payload["market_settings_example"] as Record<
      string,
      unknown
    >;
    return {
      payload,
      settings,
      rewards: settings["clobRewards"] as Array<Record<string, unknown>>,
    };
  };

  const rewardErrors = (payload: Record<string, unknown>): string[] =>
    errorsFor(
      payload,
      specOf("fees-and-rewards"),
      "liquidity-rewards-market-settings",
    );

  it("freezes the reward decimals as STRINGS, never JSON numbers", () => {
    const { settings, rewards } = rewardSettings();
    expect(typeof settings["rewardsMinSize"]).toBe("string");
    expect(rewards.length).toBeGreaterThan(0);
    for (const reward of rewards) {
      expect(typeof reward["rewardsAmount"]).toBe("string");
      expect(typeof reward["rewardsDailyRate"]).toBe("string");
    }
    // The documented example lexemes are already canonical per handoff §7.3,
    // so the frozen values are the page's own strings, not rewritten ones.
    expect(rewards[0]?.["rewardsAmount"]).toBe("10000");
    expect(rewards[0]?.["rewardsDailyRate"]).toBe("100");
    expect(settings["rewardsMinSize"]).toBe("100");
  });

  for (const field of ["rewardsAmount", "rewardsDailyRate"]) {
    it(`rejects a JSON number for clobRewards[].${field} (parsed layer is DecimalString)`, () => {
      const { payload, rewards } = rewardSettings();
      expect(rewardErrors(payload)).toEqual([]);
      rewards[0]![field] = 10000;
      expect(
        rewardErrors(payload).some(
          (error) =>
            error.includes(`clobRewards[0].${field}`) &&
            error.includes("expected canonical decimal string"),
        ),
      ).toBe(true);
    });

    for (const malformed of ["10000.00", "1e4", "+100", "", "01"]) {
      it(`rejects malformed decimal ${JSON.stringify(malformed)} for clobRewards[].${field}`, () => {
        const { payload, rewards } = rewardSettings();
        rewards[0]![field] = malformed;
        expect(
          rewardErrors(payload).some(
            (error) =>
              error.includes(`clobRewards[0].${field}`) &&
              error.includes("expected canonical decimal string"),
          ),
        ).toBe(true);
      });
    }

    it(`rejects null for clobRewards[].${field} (required, non-nullable)`, () => {
      const { payload, rewards } = rewardSettings();
      rewards[0]![field] = null;
      expect(
        rewardErrors(payload).some(
          (error) =>
            error.includes(`clobRewards[0].${field}`) &&
            error.includes("null is not an accepted value"),
        ),
      ).toBe(true);
    });
  }

  it("rejects a JSON number for rewardsMinSize (DecimalString | null)", () => {
    const { payload, settings } = rewardSettings();
    settings["rewardsMinSize"] = 100;
    expect(
      rewardErrors(payload).some(
        (error) =>
          error.includes("rewardsMinSize") &&
          error.includes("expected canonical decimal string"),
      ),
    ).toBe(true);
  });

  it("keeps rewardsMaxSpread a NUMBER (number/float in every representation)", () => {
    const { payload, settings } = rewardSettings();
    settings["rewardsMaxSpread"] = "3";
    expect(
      rewardErrors(payload).some(
        (error) =>
          error.includes("rewardsMaxSpread") &&
          error.includes("expected finite number"),
      ),
    ).toBe(true);
  });

  it("accepts a non-EVM-address clobRewards[].assetAddress (documented plain string)", () => {
    // Both the page (`assetAddress: string`, Python `asset_address: str`) and
    // `ClobRewardsSchema` (`assetAddress: z.string()`) type this as a bare
    // string, in deliberate contrast to the branded sibling `conditionId`. An
    // earlier revision narrowed it to a 20-byte EVM address, which the venue
    // never documented.
    const { payload, rewards } = rewardSettings();
    rewards[0]!["assetAddress"] = "sanitized-non-address-asset";
    expect(rewardErrors(payload)).toEqual([]);
  });

  it("still rejects a non-string clobRewards[].assetAddress", () => {
    const { payload, rewards } = rewardSettings();
    rewards[0]!["assetAddress"] = 42;
    expect(
      rewardErrors(payload).some((error) =>
        error.includes("clobRewards[0].assetAddress: expected string"),
      ),
    ).toBe(true);
  });

  it("requires a string clobRewards[].id (branded ClobRewardIdSchema)", () => {
    const { payload, rewards } = rewardSettings();
    rewards[0]!["id"] = 1;
    expect(
      rewardErrors(payload).some((error) =>
        error.includes("clobRewards[0].id: expected string"),
      ),
    ).toBe(true);
  });

  it("requires clobRewards[].startDate to be present and a string", () => {
    const { payload, rewards } = rewardSettings();
    rewards[0]!["startDate"] = 20260701;
    expect(
      rewardErrors(payload).some((error) =>
        error.includes("clobRewards[0].startDate: expected string"),
      ),
    ).toBe(true);
    delete rewards[0]!["startDate"];
    expect(
      rewardErrors(payload).some((error) =>
        error.includes("clobRewards[0].startDate: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects a null clobRewards[].startDate (only endDate is nullable)", () => {
    const { payload, rewards } = rewardSettings();
    rewards[0]!["startDate"] = null;
    expect(
      rewardErrors(payload).some(
        (error) =>
          error.includes("clobRewards[0].startDate") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects a non-address value in the published contract map", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "contract-addresses-polygon-snapshot",
    );
    (payload["contracts"] as Record<string, unknown>)["pUSD"] = 42;
    expect(
      errorsFor(payload, specOf("position-operations")).some((error) =>
        error.includes("contracts.pUSD"),
      ),
    ).toBe(true);
  });

  it("rejects a truncated contract address", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "contract-addresses-polygon-snapshot",
    );
    (payload["contracts"] as Record<string, unknown>)["pUSD"] = "0xC011a7";
    expect(
      errorsFor(payload, specOf("position-operations")).some((error) =>
        error.includes("contracts.pUSD"),
      ),
    ).toBe(true);
  });

  // Round-4 HIGH(a): map entries were previously skipped when null/undefined,
  // so a map declared as decimals, integers, dual-limit objects, or EVM
  // addresses silently accepted `null`. Every entry is now validated against
  // the declared value spec.
  it("rejects a null value in the decimal-typed fee table", () => {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "fee-model-snapshot",
    );
    (payload["taker_fee_rate_by_category"] as Record<string, unknown>)[
      "crypto"
    ] = null;
    expect(
      errorsFor(payload, specOf("fees-and-rewards"), "fee-model-snapshot").some(
        (error) =>
          error.includes("taker_fee_rate_by_category.crypto") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects a null value in the integer-typed IP limit map", () => {
    const payload = exampleNamed(
      "rate-limits/rate-limits.json",
      "ip-limits-snapshot",
    );
    (payload["limits_per_10s"] as Record<string, unknown>)["general"] = null;
    expect(
      errorsFor(payload, specOf("rate-limits"), "ip-limits-snapshot").some(
        (error) =>
          error.includes("limits_per_10s.general") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects a null dual-limit object in the trading limit map", () => {
    const payload = exampleNamed(
      "rate-limits/rate-limits.json",
      "ip-limits-snapshot",
    );
    const dual = payload["trading_dual_limits"] as Record<string, unknown>;
    const firstKey = Object.keys(dual)[0] as string;
    dual[firstKey] = null;
    expect(
      errorsFor(payload, specOf("rate-limits"), "ip-limits-snapshot").some(
        (error) =>
          error.includes(`trading_dual_limits.${firstKey}`) &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects a null contract address in the published contract map", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "contract-addresses-polygon-snapshot",
    );
    (payload["contracts"] as Record<string, unknown>)["pUSD"] = null;
    expect(
      errorsFor(payload, specOf("position-operations")).some(
        (error) =>
          error.includes("contracts.pUSD") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects an undefined map entry", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "contract-addresses-polygon-snapshot",
    );
    (payload["contracts"] as Record<string, unknown>)["pUSD"] = undefined;
    expect(
      errorsFor(payload, specOf("position-operations")).some(
        (error) =>
          error.includes("contracts.pUSD") &&
          error.includes("undefined is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("accepts a null map entry only where the value spec declares nullable", () => {
    const nullableMap: PayloadSpec = {
      fields: { tag: { type: "string" } },
      values: { type: "decimal-string", nullable: true },
    };
    expect(errorsFor({ tag: "t", a: "1.5", b: null }, nullableMap)).toEqual([]);
    const strictMap: PayloadSpec = {
      fields: { tag: { type: "string" } },
      values: { type: "decimal-string" },
    };
    expect(
      errorsFor({ tag: "t", a: "1.5", b: null }, strictMap).some((error) =>
        error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("rejects malformed negative-risk event flags", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "neg-risk-conversion-note",
    );
    payload["event_flags"] = { enableNegRisk: "true" };
    const errors = errorsFor(payload, specOf("position-operations"));
    expect(
      errors.some((error) =>
        error.includes("event_flags.enableNegRisk: expected boolean"),
      ),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("event_flags.negRiskAugmented: missing required key"),
      ),
    ).toBe(true);
  });

  it("rejects an amount on the redeem request (indexSets-only shape)", () => {
    const payload = exampleNamed(
      "positions/split-merge-redeem.json",
      "redeem-request-and-outcome",
    );
    (payload["request"] as Record<string, unknown>)["amount"] = "1";
    expect(
      errorsFor(payload, specOf("position-operations")).some((error) =>
        error.includes("request.amount: unexpected key"),
      ),
    ).toBe(true);
  });

  it("rejects malformed RTDS payloads", () => {
    const errors = errorsFor(
      {
        topic: "crypto_prices_twap_thirty",
        type: "update",
        timestamp: 1785178800123,
        payload: {
          symbol: "btc/usd",
          value: 65000.5,
          full_accuracy_value: 65000,
          timestamp: 1,
        },
      },
      specOf("chainlink-twap-rtds"),
      "twap-update-30s",
    );
    expect(
      errors.some((error) => error.includes("payload.full_accuracy_value")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("payload.window_s: missing required key"),
      ),
    ).toBe(true);
  });

  it("validates RTDS subscribe subscriptions[] entries", () => {
    const errors = errorsFor(
      {
        action: "subscribe",
        subscriptions: [
          { topic: 12345, type: "update", filters: "{}" },
          { topic: "crypto_prices_twap_thirty", type: "snapshot", filters: "{}" },
          { topic: "crypto_prices_twap_sixty", type: "update", filters: 7 },
        ],
      },
      specOf("chainlink-twap-rtds"),
      "subscribe-request",
    );
    expect(
      errors.some((error) => error.includes("subscriptions[0].topic")),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("subscriptions[1].type")),
    ).toBe(true);
    // `filters` is optional, but a PRESENT `filters` is still type-checked.
    expect(
      errors.some((error) =>
        error.includes("subscriptions[2].filters: expected string"),
      ),
    ).toBe(true);
  });

  // Round-4 HIGH(b): `filters` was wrongly mandatory and the previous negative
  // test enforced that wrong behavior. The official Chainlink TWAP page states
  // "Omit it to receive every available symbol"
  // (https://docs.polymarket.com/market-data/chainlink-twap, accessed
  // 2026-08-26), so the omitted form is VALID and is asserted positively here.
  it("accepts an RTDS subscription that omits filters (all symbols)", () => {
    for (const exampleName of [
      "subscribe-request",
      "subscribe-request-all-symbols-no-filters",
    ]) {
      expect(
        errorsFor(
          {
            action: "subscribe",
            subscriptions: [
              { topic: "crypto_prices_twap_sixty", type: "update" },
            ],
          },
          specOf("chainlink-twap-rtds"),
          exampleName,
        ),
        exampleName,
      ).toEqual([]);
    }
  });

  it("freezes an omitted-filters subscribe example in the RTDS fixture", () => {
    const example = examplesOf("rtds/twap-update.json").find(
      (candidate) => candidate.name === "subscribe-request-all-symbols-no-filters",
    );
    expect(example).toBeDefined();
    const subscriptions = example?.payload["subscriptions"] as Array<
      Record<string, unknown>
    >;
    expect(subscriptions.length).toBeGreaterThan(0);
    for (const subscription of subscriptions) {
      expect(Object.hasOwn(subscription, "filters")).toBe(false);
    }
  });

  it("rejects an RTDS subscribe frame with no subscriptions key", () => {
    expect(
      errorsFor(
        { action: "subscribe" },
        specOf("chainlink-twap-rtds"),
        "subscribe-request",
      ).some((error) => error.includes("subscriptions: missing required key")),
    ).toBe(true);
  });

  it("rejects an empty RTDS payload (no all-optional pass)", () => {
    expect(
      errorsFor({}, specOf("chainlink-twap-rtds"), "twap-update-30s").length,
    ).toBeGreaterThan(0);
  });

  it("rejects an empty geoblock payload", () => {
    expect(errorsFor({}, specOf("geoblock")).length).toBeGreaterThan(0);
  });
});

// --- Round-5 HIGH: `optional` governs key absence only ---------------------
//
// An earlier revision accepted `null` whenever EITHER `nullable` or `optional`
// was true (`fixtures.ts` `validateObjectSpec`), so four fields accepted a
// `null` that no official source documents. Two of them (`transactionsHashes`,
// `tradeIDs`) are `z.array(z.string()).default([])` in the SDK, which
// substitutes the default for an ABSENT key and rejects an explicit `null`, so
// accepting it was a defect measured against the SDK itself. See report §17.
describe("optional versus nullable (round-5 HIGH)", () => {
  it("rejects an explicit null for an optional-but-not-nullable field", () => {
    const spec = {
      fields: {
        required: { type: "string" },
        optionalOnly: { type: "string", optional: true },
      },
    } as const satisfies PayloadSpec;
    // Absent: fine. Explicit null: not fine.
    expect(errorsFor({ required: "x" }, spec)).toEqual([]);
    expect(
      errorsFor({ required: "x", optionalOnly: null }, spec).some((error) =>
        error.includes(
          "optionalOnly: null is not an accepted value (the spec must declare nullable; optional governs key absence only)",
        ),
      ),
    ).toBe(true);
  });

  it("accepts an explicit null only when the spec declares BOTH optional and nullable", () => {
    const spec = {
      fields: {
        required: { type: "string" },
        documentedNullish: {
          type: "boolean",
          optional: true,
          nullable: true,
        },
      },
    } as const satisfies PayloadSpec;
    expect(errorsFor({ required: "x" }, spec)).toEqual([]);
    expect(errorsFor({ required: "x", documentedNullish: null }, spec)).toEqual(
      [],
    );
    expect(errorsFor({ required: "x", documentedNullish: true }, spec)).toEqual(
      [],
    );
    expect(
      errorsFor({ required: "x", documentedNullish: "yes" }, spec).length,
    ).toBeGreaterThan(0);
  });

  // The Chainlink TWAP page documents exactly two forms for `filters`:
  // omission ("Omit it to receive every available symbol") and the compact
  // JSON string. `null` is not among them.
  // https://docs.polymarket.com/market-data/chainlink-twap (accessed 2026-08-26)
  it("rejects a null RTDS subscriptions[].filters", () => {
    const payload = exampleNamed("rtds/twap-update.json", "subscribe-request");
    const subscriptions = payload["subscriptions"] as Array<
      Record<string, unknown>
    >;
    subscriptions[0]!["filters"] = null;
    expect(
      errorsFor(
        payload,
        specOf("chainlink-twap-rtds"),
        "subscribe-request",
      ).some(
        (error) =>
          error.includes("subscriptions[0].filters") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("still accepts an RTDS subscription that OMITS filters", () => {
    const payload = exampleNamed(
      "rtds/twap-update.json",
      "subscribe-request-all-symbols-no-filters",
    );
    expect(
      errorsFor(
        payload,
        specOf("chainlink-twap-rtds"),
        "subscribe-request-all-symbols-no-filters",
      ),
    ).toEqual([]);
  });

  // SDK `OrderResponsePayloadSchema` (re-read verbatim at the pinned commit
  // 2026-08-26): `tradeIDs: z.array(z.string()).default([])` and
  // `transactionsHashes: z.array(z.string()).default([])`. `.default()` fills
  // an ABSENT key; an explicit null fails to parse.
  for (const arrayField of ["transactionsHashes", "tradeIDs"]) {
    it(`rejects a null ${arrayField} on an order response (SDK .default([]))`, () => {
      const payload = exampleNamed("orders/order-responses.json", "limit-live");
      payload[arrayField] = null;
      expect(
        errorsFor(payload, specOf("order-schemas-and-types")).some(
          (error) =>
            error.includes(arrayField) &&
            error.includes("null is not an accepted value"),
        ),
      ).toBe(true);
    });

    it(`still accepts an order response that OMITS ${arrayField}`, () => {
      const payload = exampleNamed("orders/order-responses.json", "limit-live");
      delete payload[arrayField];
      expect(errorsFor(payload, specOf("order-schemas-and-types"))).toEqual([]);
    });
  }

  it("rejects a null market-book hash", () => {
    const payload = exampleNamed("market-ws/book-snapshot.json", "book-snapshot");
    payload["hash"] = null;
    expect(
      errorsFor(payload, specOf("market-ws-book")).some(
        (error) =>
          error.includes("hash") &&
          error.includes("null is not an accepted value"),
      ),
    ).toBe(true);
  });

  it("still accepts a market-book snapshot that OMITS hash", () => {
    const payload = exampleNamed("market-ws/book-snapshot.json", "book-snapshot");
    delete payload["hash"];
    expect(errorsFor(payload, specOf("market-ws-book"))).toEqual([]);
  });

  // Catalog guard: `nullable` may not be blanket-added to keep tests green.
  // Every entry below is a field whose OFFICIAL published type documents the
  // null, cited in report §17. Adding a nullable anywhere else fails here.
  it("every nullable field in the catalog is a documented venue nullable", () => {
    const nullablePaths = fixtureChecks
      .flatMap((check) =>
        reachableFieldSpecs(check.payloadSpec)
          .filter((entry) => entry.spec.nullable === true)
          .map((entry) => `${check.id} ${entry.path}`),
      )
      .sort();
    expect(nullablePaths).toEqual([
      // `holdingRewardsEnabled?: boolean | null` and
      // `endDate: IsoCalendarDateString | null`
      // (https://docs.polymarket.com/market-data/market-details, 2026-08-26)
      "fees-and-rewards <liquidity-rewards-market-settings>.market_settings_example.clobRewards[].endDate",
      "fees-and-rewards <liquidity-rewards-market-settings>.market_settings_example.holdingRewardsEnabled",
      // `outcome.transactionId: TransactionId | null`
      // (https://docs.polymarket.com/trading/positions/manage, 2026-08-26)
      "position-operations <split>.transaction_outcome.transactionId",
      // SDK `MakerOrderSchema.fee_rate_bps` is `.nullable()` (clob/account.ts)
      "rest-trade-settlement <root>.maker_orders[].fee_rate_bps",
    ]);
  });

  it("the nullability guard sees a nullable added anywhere in a nested spec", () => {
    // Mutation probe for the guard itself: a nullable buried three levels deep
    // must be reported, otherwise the guard above could pass vacuously.
    const nested: PayloadSpec = {
      strict: true,
      fields: {
        outer: {
          type: "object",
          strict: true,
          fields: {
            items: {
              type: "array",
              items: {
                type: "object",
                strict: true,
                fields: { leaf: { type: "string", nullable: true } },
              },
            },
          },
        },
      },
    };
    expect(
      reachableFieldSpecs(nested)
        .filter((entry) => entry.spec.nullable === true)
        .map((entry) => entry.path),
    ).toEqual(["<root>.outer.items[].leaf"]);
  });
});

// --- Round-5 MEDIUM-1: MarketRewards.holdingRewardsEnabled -----------------
//
// The strict `market_settings_example` spec enumerated only `rewardsMinSize`,
// `rewardsMaxSpread`, and `clobRewards`, so a valid parsed `MarketRewards`
// object carrying `holdingRewardsEnabled` was rejected as an unexpected key.
// Published type: `holdingRewardsEnabled?: boolean | null` (Python
// `bool | None`; Gamma field table `boolean`; SDK `z.boolean().nullish()`).
// https://docs.polymarket.com/market-data/market-details and
// https://github.com/Polymarket/ts-sdk/blob/7fdbed42484b5d279c71aa36d3757d18968260da/packages/bindings/src/gamma/market.ts
// (both re-fetched read-only 2026-08-26).
describe("MarketRewards.holdingRewardsEnabled (round-5 MEDIUM-1)", () => {
  function rewardSettings(): {
    payload: Record<string, unknown>;
    settings: Record<string, unknown>;
  } {
    const payload = exampleNamed(
      "fees/fee-reward-parameters.json",
      "liquidity-rewards-market-settings",
    );
    return {
      payload,
      settings: payload["market_settings_example"] as Record<string, unknown>,
    };
  }

  function rewardErrors(payload: Record<string, unknown>): string[] {
    return errorsFor(
      payload,
      specOf("fees-and-rewards"),
      "liquidity-rewards-market-settings",
    );
  }

  for (const accepted of [true, false, null]) {
    it(`accepts holdingRewardsEnabled: ${JSON.stringify(accepted)}`, () => {
      const { payload, settings } = rewardSettings();
      settings["holdingRewardsEnabled"] = accepted;
      expect(rewardErrors(payload)).toEqual([]);
    });
  }

  it("accepts an omitted holdingRewardsEnabled (the Gamma example omits it)", () => {
    const { payload, settings } = rewardSettings();
    delete settings["holdingRewardsEnabled"];
    expect(rewardErrors(payload)).toEqual([]);
  });

  it("rejects a string holdingRewardsEnabled (published type is boolean)", () => {
    const { payload, settings } = rewardSettings();
    settings["holdingRewardsEnabled"] = "true";
    expect(
      rewardErrors(payload).some((error) =>
        error.includes("holdingRewardsEnabled: expected boolean"),
      ),
    ).toBe(true);
  });

  it("freezes the boolean form in the fees fixture", () => {
    const { settings } = rewardSettings();
    expect(Object.hasOwn(settings, "holdingRewardsEnabled")).toBe(true);
    expect(typeof settings["holdingRewardsEnabled"]).toBe("boolean");
  });

  it("enumerates the COMPLETE published MarketRewards field list", () => {
    // `MarketRewards = { clobRewards?, rewardsMinSize?, rewardsMaxSpread?,
    // holdingRewardsEnabled? }`. A strict spec that omits one of them rejects
    // a valid parsed object, which is how MEDIUM-1 manifested.
    const marketSettings = reachableObjectSpecs(specOf("fees-and-rewards")).find(
      (entry) =>
        entry.path ===
        "<liquidity-rewards-market-settings>.market_settings_example",
    );
    expect(marketSettings).toBeDefined();
    expect(Object.keys(marketSettings?.spec.fields ?? {}).sort()).toEqual([
      "clobRewards",
      "holdingRewardsEnabled",
      "rewardsMaxSpread",
      "rewardsMinSize",
    ]);
  });
});

describe("market data details", () => {
  it("price-change fixture includes the (UNVERIFIED) zero-size level-removal example", () => {
    const removal = examplesOf("market-ws/price-change.json").find((example) =>
      example.name.startsWith("level-removed"),
    );
    expect(removal?.name).toContain("UNVERIFIED");
    const changes = removal?.payload["price_changes"] as Array<
      Record<string, unknown>
    >;
    expect(changes[0]?.["size"]).toBe("0");
  });

  it("RTDS updates carry full_accuracy_value as a decimal string", () => {
    const updates = examplesOf("rtds/twap-update.json").filter(
      (example) => example.payload["type"] === "update",
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      const inner = update.payload["payload"] as Record<string, unknown>;
      expect(typeof inner["full_accuracy_value"]).toBe("string");
      expect(inner["full_accuracy_value"]).toMatch(/^\d+$/);
      expect([30, 60]).toContain(inner["window_s"]);
    }
  });

  it("the frozen best-bid-ask example still carries non-empty quotes", () => {
    // The SDK types these as optional empty-able decimals; the frozen fixture
    // must still demonstrate the populated form.
    const payload = exampleNamed("market-ws/best-bid-ask.json", "best-bid-ask");
    expect(payload["best_bid"]).not.toBe("");
    expect(payload["best_ask"]).not.toBe("");
  });
});

describe("rate limits", () => {
  const examples = examplesOf("rate-limits/rate-limits.json");

  it("records every documented signer tier", () => {
    const buckets = examples.find(
      (example) => example.name === "per-signer-token-buckets-snapshot",
    );
    const tiers = (
      buckets?.payload["tiers"] as Array<Record<string, unknown>>
    ).map((tier) => tier["tier"]);
    expect(tiers).toEqual([
      "Standard",
      "Copper",
      "Bronze",
      "Silver",
      "Gold",
      "Platinum",
      "Diamond",
      "Elite",
    ]);
  });

  it("keeps POST /orders and DELETE /orders sustained limits separate and exact", () => {
    const ip = examples.find((example) => example.name === "ip-limits-snapshot");
    const dual = ip?.payload["trading_dual_limits"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(dual["POST /orders"]?.["sustained_per_10min"]).toBe(21000);
    expect(dual["DELETE /orders"]?.["sustained_per_10min"]).toBe(15000);
  });
});

describe("position operations", () => {
  const examples = examplesOf("positions/split-merge-redeem.json");

  it("covers split, merge, and redeem with TransactionOutcome handles", () => {
    for (const operation of ["split", "merge", "redeem"]) {
      const example = examples.find(
        (candidate) => candidate.payload["operation"] === operation,
      );
      expect(example, operation).toBeDefined();
      const outcome = example?.payload["transaction_outcome"] as Record<
        string,
        unknown
      >;
      expect(typeof outcome["transactionHash"]).toBe("string");
      expect(typeof outcome["transactionId"]).toBe("string");
    }
  });

  it("records the published Polygon contract addresses", () => {
    const addresses = examples.find(
      (example) => example.payload["operation"] === "contract-addresses",
    );
    const contracts = addresses?.payload["contracts"] as Record<
      string,
      unknown
    >;
    expect(contracts["pUSD"]).toBe(
      "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    );
    expect(contracts["ConditionalTokens"]).toBe(
      "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    );
    expect(contracts["CtfCollateralAdapter"]).toBe(
      "0xAdA100Db00Ca00073811820692005400218FcE1f",
    );
    expect(contracts["NegRiskCtfCollateralAdapter"]).toBe(
      "0xadA2005600Dec949baf300f4C6120000bDB6eAab",
    );
  });
});

describe("SDK source pinning", () => {
  it("every SDK-sourced fixture cites the pinned reference commit", () => {
    const sdkFixtures = listJsonFiles(VENUE_FIXTURE_ROOT).filter(
      (relativePath) => {
        const result = loadFixture(relativePath, {});
        return (
          result.fixture?.source.startsWith(
            "https://github.com/Polymarket/ts-sdk/",
          ) === true
        );
      },
    );
    expect(sdkFixtures.length).toBeGreaterThan(0);
    for (const relativePath of sdkFixtures) {
      const source = loadFixture(relativePath, {}).fixture?.source ?? "";
      expect(source, relativePath).toContain(SDK_REFERENCE_COMMIT);
      expect(
        source.startsWith(SDK_PERMALINK_PREFIX),
        `${relativePath} source must start with ${SDK_PERMALINK_PREFIX}`,
      ).toBe(true);
    }
  });

  it("no fixture cites a mutable SDK branch link", () => {
    for (const relativePath of listJsonFiles(VENUE_FIXTURE_ROOT)) {
      const fixture = loadFixture(relativePath, {}).fixture;
      expect(fixture?.source, relativePath).not.toContain("ts-sdk/blob/main/");
      expect(fixture?.notes, relativePath).not.toContain("ts-sdk/blob/main/");
    }
  });
});

describe("validation failure modes", () => {
  it("rejects a non-object document (malformed JSON shape)", () => {
    const { errors } = validateFixtureDocument("not-json-object", "x/y", {});
    expect(errors).toContain("document is not a JSON object");
  });

  it("rejects unparseable fixture files", () => {
    const result = loadFixture("does-not-exist.json", {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("failed to read/parse");
  });

  it("rejects path traversal outside the fixture root", () => {
    const result = loadFixture("../../package.json", {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("traversal");
  });

  it("rejects spoofed non-official source URLs", () => {
    const doc = {
      ...envelope([{ name: "a", payload: {} }]),
      source: "https://docs.polymarket.com.evil.example/trading",
    };
    const { errors } = validateFixtureDocument(doc, "x/y", {});
    expect(errors).toContain("source must cite an official Polymarket URL");
  });

  it("rejects wrong field types and enum violations", () => {
    const errors = errorsFor(
      { side: "HOLD", price: 0.5, live: "yes" },
      {
        fields: {
          side: { type: "string", enum: ["BUY", "SELL"] },
          price: { type: "decimal-string" },
          live: { type: "boolean" },
          missing: { type: "string" },
        },
      },
    );
    expect(errors.some((error) => error.includes("not in enum"))).toBe(true);
    expect(
      errors.some((error) => error.includes("canonical decimal string")),
    ).toBe(true);
    expect(errors.some((error) => error.includes("expected boolean"))).toBe(
      true,
    );
    expect(
      errors.some((error) => error.includes("missing required key")),
    ).toBe(true);
  });

  it("accepts absent optional fields but validates them when present", () => {
    const spec = {
      fields: { hash: { type: "string", optional: true } },
    } as const satisfies PayloadSpec;
    expect(errorsFor({}, spec)).toEqual([]);
    expect(errorsFor({ hash: 5 }, spec).length).toBeGreaterThan(0);
  });

  it("distinguishes nullable (present, may be null) from optional (may be absent)", () => {
    const spec = {
      fields: {
        nullableField: { type: "string", nullable: true },
        optionalField: { type: "string", optional: true },
        requiredField: { type: "string" },
      },
    } as const satisfies PayloadSpec;
    expect(
      errorsFor(
        { nullableField: null, requiredField: "x" },
        spec,
      ),
    ).toEqual([]);
    expect(
      errorsFor({ requiredField: "x" }, spec).some((error) =>
        error.includes("nullableField: missing required key"),
      ),
    ).toBe(true);
    expect(
      errorsFor(
        { nullableField: "a", requiredField: null },
        spec,
      ).some((error) => error.includes("requiredField: null is not an accepted value")),
    ).toBe(true);
  });

  it("rejects unknown keys only when the schema is strict", () => {
    const lenient = { fields: { a: { type: "string" } } } as const;
    const strict = {
      fields: { a: { type: "string" } },
      strict: true,
    } as const;
    expect(errorsFor({ a: "x", b: 1 }, lenient)).toEqual([]);
    expect(
      errorsFor({ a: "x", b: 1 }, strict).some((error) =>
        error.includes("b: unexpected key"),
      ),
    ).toBe(true);
  });

  for (const secretKey of [
    "apiKey",
    "api_key",
    "apiSecret",
    "api_secret",
    "secret",
    "clientSecret",
    "passphrase",
    "privateKey",
    "private_key",
    "signature",
    "signatures",
    "signedOrder",
    "signed_payload",
    "mnemonic",
    "seed",
    "seedPhrase",
    "seed_phrase",
    "authorization",
    "Authorization",
    "owner",
    "order_owner",
    "trade_owner",
    "POLY_API_KEY",
    "POLY-API-KEY",
    "poly_api_key",
    "POLY_PASSPHRASE",
    "Poly-Passphrase",
    "POLY_SIGNATURE",
    "poly-signature",
    "POLY_ADDRESS",
    "Poly-Address",
    "POLY_TIMESTAMP",
    "POLY_NONCE",
    "SIGNER_PRIVATE_KEY",
    "signerPrivateKey",
    // Documented Polymarket names added in round 3.
    "POLYMARKET_PRIVATE_KEY",
    "polymarket_private_key",
    "POLYMARKET_WALLET_ADDRESS",
    "POLY_BUILDER_API_KEY",
    "POLY_BUILDER_PASSPHRASE",
    "POLY_BUILDER_SIGNATURE",
    "POLY_BUILDER_TIMESTAMP",
    "POLYMARKET_BUILDER_CODE",
    // Documented on the official SDK migration page (accessed 2026-08-26):
    // builderApiKey({ key, secret, passphrase }) reads these three names.
    "POLYMARKET_BUILDER_API_KEY",
    "POLYMARKET_BUILDER_SECRET",
    "POLYMARKET_BUILDER_PASSPHRASE",
    // Obvious variants that must not slip through an exact-match list.
    "builderApiKey",
    "builder_code",
    "WALLET_PRIVATE_KEY",
    "deployer_private_key",
    "POLYMARKET_API_SECRET",
    "secretKey",
    "privKey",
    "pk",
  ]) {
    it(`fails validation when a fixture contains a non-placeholder "${secretKey}"`, () => {
      const errors = errorsFor(
        { nested: { [secretKey]: "realistic-secret-value-123" } },
        {},
      );
      expect(
        errors.some((error) =>
          error.includes("must be a sanitized placeholder"),
        ),
      ).toBe(true);
    });
  }

  /**
   * Every name below is documented on an official Polymarket page, re-verified
   * 2026-08-26. The round-3 record wrongly stated that
   * `POLYMARKET_BUILDER_API_KEY` was NOT in current official documentation; it
   * is, on the SDK migration page, together with `POLYMARKET_BUILDER_SECRET`
   * and `POLYMARKET_BUILDER_PASSPHRASE`. See report §16 for per-name sources.
   */
  const DOCUMENTED_CREDENTIAL_NAMES: readonly {
    readonly name: string;
    readonly kind: "secret" | "account-identifying" | "public-attribution";
    readonly source: string;
  }[] = [
    {
      name: "POLYMARKET_PRIVATE_KEY",
      kind: "secret",
      source: "https://docs.polymarket.com/trading/quickstart",
    },
    {
      name: "SIGNER_PRIVATE_KEY",
      kind: "secret",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLYMARKET_BUILDER_API_KEY",
      kind: "secret",
      source:
        "https://docs.polymarket.com/getting-started/migrate-from-previous-sdks",
    },
    {
      name: "POLYMARKET_BUILDER_SECRET",
      kind: "secret",
      source:
        "https://docs.polymarket.com/getting-started/migrate-from-previous-sdks",
    },
    {
      name: "POLYMARKET_BUILDER_PASSPHRASE",
      kind: "secret",
      source:
        "https://docs.polymarket.com/getting-started/migrate-from-previous-sdks",
    },
    {
      name: "POLY_API_KEY",
      kind: "secret",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLY_PASSPHRASE",
      kind: "secret",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLY_SIGNATURE",
      kind: "secret",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLY_BUILDER_API_KEY",
      kind: "secret",
      source:
        "https://docs.polymarket.com/api-reference/relayer/submit-a-transaction",
    },
    {
      name: "POLY_BUILDER_PASSPHRASE",
      kind: "secret",
      source:
        "https://docs.polymarket.com/api-reference/relayer/submit-a-transaction",
    },
    {
      name: "POLY_BUILDER_SIGNATURE",
      kind: "secret",
      source:
        "https://docs.polymarket.com/api-reference/relayer/submit-a-transaction",
    },
    {
      name: "POLY_BUILDER_TIMESTAMP",
      kind: "secret",
      source:
        "https://docs.polymarket.com/api-reference/relayer/submit-a-transaction",
    },
    {
      name: "POLYMARKET_WALLET_ADDRESS",
      kind: "account-identifying",
      source: "https://docs.polymarket.com/trading/quickstart",
    },
    {
      name: "POLY_ADDRESS",
      kind: "account-identifying",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLY_TIMESTAMP",
      kind: "account-identifying",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
    {
      name: "POLYMARKET_BUILDER_CODE",
      kind: "public-attribution",
      source: "https://docs.polymarket.com/trading/place-orders",
    },
  ];

  it("classifies every documented credential/attribution name as credential-shaped", () => {
    for (const { name } of DOCUMENTED_CREDENTIAL_NAMES) {
      expect(isCredentialShapedKey(name), name).toBe(true);
    }
  });

  it("classifies documented names case- and separator-insensitively", () => {
    for (const { name } of DOCUMENTED_CREDENTIAL_NAMES) {
      const camel = name
        .toLowerCase()
        .replace(/_(.)/g, (_match, char: string) => char.toUpperCase());
      const dashed = name.replace(/_/g, "-");
      expect(isCredentialShapedKey(camel), camel).toBe(true);
      expect(isCredentialShapedKey(dashed), dashed).toBe(true);
    }
  });

  it("the frozen report documents every credential name with its own source", () => {
    const { content } = loadAndValidateReport();
    expect(content).not.toBeNull();
    const report = content ?? "";
    for (const { name, source } of DOCUMENTED_CREDENTIAL_NAMES) {
      expect(report, name).toContain(name);
      expect(report, `${name} source ${source}`).toContain(source);
    }
  });

  it("the frozen report separates secret material from public builder attribution", () => {
    const { content } = loadAndValidateReport();
    const report = content ?? "";
    // POLYMARKET_BUILDER_CODE is a public builder-profile identifier sent as
    // `builderCode` alongside an order; it is scanned so no real builder's
    // value is embedded, but it is not secret material and the report must
    // say so rather than lumping it in with keys and passphrases.
    expect(report).toContain("public builder attribution");
    const attribution = DOCUMENTED_CREDENTIAL_NAMES.filter(
      (entry) => entry.kind === "public-attribution",
    ).map((entry) => entry.name);
    expect(attribution).toEqual(["POLYMARKET_BUILDER_CODE"]);
  });

  it("does not classify ordinary venue field names as credentials", () => {
    for (const key of [
      "asset_id",
      "maker_address",
      "auth",
      "transaction_hash",
      "best_bid",
      "conditionId",
      "assetAddress",
      "collateralToken",
    ]) {
      expect(isCredentialShapedKey(key), key).toBe(false);
    }
  });

  it("allows sanitized placeholders in credential-shaped fields", () => {
    const errors = errorsFor(
      {
        owner: "00000000-0000-0000-0000-000000000000",
        apiKey: "sanitized-api-key",
        POLY_SIGNATURE: "",
        POLY_ADDRESS: "0x0000000000000000000000000000000000000000",
        POLYMARKET_PRIVATE_KEY: "",
      },
      {},
    );
    expect(errors).toEqual([]);
  });
});

/**
 * The synthetic baseline uses the REAL required-section list imported from
 * `index.ts`. Round-5 review finding MEDIUM-2: this file previously carried
 * its OWN hardcoded copy, so the two lists could (and did) drift — §7.1 and
 * §16 were ungated in the implementation and the tests could not notice.
 */
const EXEMPT_SECTIONS: readonly string[] = CITATION_EXEMPT_SECTIONS.map(
  (entry) => entry.section,
);

function syntheticReport(
  overrides: Readonly<Record<string, string>> = {},
): string {
  const body = REQUIRED_REPORT_SECTIONS.map((section) => {
    const text =
      overrides[section] ??
      (EXEMPT_SECTIONS.includes(section)
        ? "Prose about this repository, carrying no venue fact.\n"
        : "Source: https://docs.polymarket.com/x\n");
    return `## ${section}. Heading\n${text}`;
  }).join("\n");
  return `${body}\nUNVERIFIED inventory placeholder\n`;
}

/**
 * Returns the frozen report with every official URL inside ONE section's own
 * text replaced, leaving the rest of the document untouched. This is the
 * reviewer's round-5 probe: strip §7.1's or §16's citations and the validator
 * must fail.
 */
function reportWithSectionCitationsStripped(
  content: string,
  section: string,
): string {
  const text = reportSectionText(content, section);
  expect(text, `section ${section} must exist`).not.toBeNull();
  const stripped = (text ?? "").replace(
    /https?:\/\/[^\s)\]>`"']+/g,
    "<citation-redacted>",
  );
  return content.replace(text ?? "", stripped);
}

describe("verification report validation", () => {
  it("the frozen report exists and validates", () => {
    const { content, validation } = loadAndValidateReport();
    expect(content).not.toBeNull();
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("the frozen report cites no mutable SDK branch link", () => {
    const { content } = loadAndValidateReport();
    expect(content).not.toBeNull();
    expect(content ?? "").not.toContain("ts-sdk/blob/main/");
  });

  it("every required section of the frozen report carries its own citation", () => {
    const { content } = loadAndValidateReport();
    const exempt = CITATION_EXEMPT_SECTIONS.map((entry) => entry.section);
    for (const section of REQUIRED_REPORT_SECTIONS) {
      if (exempt.includes(section)) {
        continue;
      }
      expect(
        reportSectionHasOfficialCitation(content ?? "", section),
        `section ${section}`,
      ).toBe(true);
    }
  });

  it("the synthetic baseline report validates", () => {
    expect(validateVerificationReport(syntheticReport()).errors).toEqual([]);
  });

  it("fails when the report file is missing", () => {
    const { validation } = loadAndValidateReport(
      "docs/venue/verified-9999-01-01.md",
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toContain("unavailable");
  });

  it("fails when a required section is missing", () => {
    const validation = validateVerificationReport(
      "## 1. Something\nhttps://docs.polymarket.com/x\nUNVERIFIED\n",
    );
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) =>
        error.includes("missing required section"),
      ),
    ).toBe(true);
  });

  it("fails a report with headings but no citations at all", () => {
    const validation = validateVerificationReport(
      syntheticReport(
        Object.fromEntries(
          REQUIRED_REPORT_SECTIONS.map((section) => [section, "UNVERIFIED\n"]),
        ),
      ),
    );
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) => error.includes("no citations")),
    ).toBe(true);
  });

  // Review finding HIGH-1: UNVERIFIED must never substitute for evidence.
  it("FAILS a report where every section is UNVERIFIED and a single section carries the only URL", () => {
    const overrides: Record<string, string> = Object.fromEntries(
      REQUIRED_REPORT_SECTIONS.map((section) => [section, "UNVERIFIED\n"]),
    );
    overrides["1"] = "UNVERIFIED https://docs.polymarket.com/x\n";
    const validation = validateVerificationReport(syntheticReport(overrides));
    expect(validation.ok).toBe(false);
    const exempt = CITATION_EXEMPT_SECTIONS.map((entry) => entry.section);
    for (const section of REQUIRED_REPORT_SECTIONS) {
      if (section === "1" || exempt.includes(section)) {
        continue;
      }
      expect(
        validation.errors.some((error) =>
          error.includes(`report section ${section} has no official citation`),
        ),
        `section ${section} must be reported as uncited`,
      ).toBe(true);
    }
  });

  it("an UNVERIFIED marker alone does not satisfy a single section", () => {
    const validation = validateVerificationReport(
      syntheticReport({ "2": "UNVERIFIED: no official source exists.\n" }),
    );
    expect(
      validation.errors.some((error) =>
        error.includes("report section 2 has no official citation"),
      ),
    ).toBe(true);
  });

  it("reportSectionHasOfficialCitation ignores UNVERIFIED markers", () => {
    const content = "## 2. Orders\nUNVERIFIED, nothing else here\n";
    expect(reportSectionHasOfficialCitation(content, "2")).toBe(false);
  });

  it("citation exemptions are explicitly enumerated with a rationale", () => {
    expect(CITATION_EXEMPT_SECTIONS.length).toBeGreaterThan(0);
    // §10 is a bare container heading; §13 is the safety attestation; §15 is
    // the in-repo integration plan. Nothing else may be exempt: every venue
    // fact must carry its own citation.
    expect(CITATION_EXEMPT_SECTIONS.map((entry) => entry.section)).toEqual([
      "10",
      "13",
      "15",
    ]);
    for (const entry of CITATION_EXEMPT_SECTIONS) {
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  // --- Round-5 MEDIUM-2: §7.1 and §16 were outside the gate ---------------
  //
  // `REQUIRED_REPORT_SECTIONS` previously held only the check sections plus
  // §11–§13, so the reviewer could strip every URL from §7.1 (parsed/raw
  // reward-layer decision) or §16 (credential and authentication facts) and
  // validation still passed. Neither is citation-exempt administrative prose.
  for (const section of ["7.1", "16", "16.1", "2.1", "14"]) {
    it(`FAILS when section ${section} loses its own citations`, () => {
      const { content } = loadAndValidateReport();
      expect(content).not.toBeNull();
      const stripped = reportWithSectionCitationsStripped(
        content ?? "",
        section,
      );
      const validation = validateVerificationReport(stripped);
      expect(validation.ok).toBe(false);
      expect(
        validation.errors.some((error) =>
          error.includes(
            `report section ${section} has no official citation of its own`,
          ),
        ),
        validation.errors.join("; "),
      ).toBe(true);
    });
  }

  it("gates a parent and its subsections independently (7 does not cover 7.1)", () => {
    const { content } = loadAndValidateReport();
    const stripped = reportWithSectionCitationsStripped(content ?? "", "7.1");
    // §7 keeps its own citation; only §7.1 is reported.
    expect(reportSectionHasOfficialCitation(stripped, "7")).toBe(true);
    expect(reportSectionHasOfficialCitation(stripped, "7.1")).toBe(false);
    // ...and the reverse: a subsection's citation never rescues its parent.
    const parentStripped = reportWithSectionCitationsStripped(
      content ?? "",
      "7",
    );
    expect(reportSectionHasOfficialCitation(parentStripped, "7")).toBe(false);
    expect(reportSectionHasOfficialCitation(parentStripped, "7.1")).toBe(true);
  });

  it("every ##/### heading in the frozen report is covered by the gate", () => {
    const { content } = loadAndValidateReport();
    const headings = reportHeadings(content ?? "");
    expect(headings.length).toBeGreaterThan(20);
    for (const heading of headings) {
      expect(heading.section, `"${heading.title}" is unnumbered`).not.toBeNull();
      expect(
        REQUIRED_REPORT_SECTIONS.includes(heading.section ?? "") ||
          EXEMPT_SECTIONS.includes(heading.section ?? ""),
        `section ${heading.section ?? "?"} escapes the evidence gate`,
      ).toBe(true);
    }
  });

  it("FAILS when a new section is appended without classifying it", () => {
    const { content } = loadAndValidateReport();
    const validation = validateVerificationReport(
      `${content ?? ""}\n## 99. Newly added venue facts\n\nNo citation here.\n`,
    );
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) =>
        error.includes("report section 99 is not covered by the evidence gate"),
      ),
    ).toBe(true);
  });

  it("FAILS on an unnumbered heading, which has no stable gate anchor", () => {
    const validation = validateVerificationReport(
      `${syntheticReport()}\n## Appendix of assorted claims\n\nno number\n`,
    );
    expect(
      validation.errors.some((error) =>
        error.includes(
          'report heading "Appendix of assorted claims" has no section number',
        ),
      ),
    ).toBe(true);
  });

  it("fails when a required section lacks its own official citation", () => {
    const content = [
      "## 1. SDK\nhttps://docs.polymarket.com/getting-started\n",
      "## 2. Orders\nno citation here, no marker\n",
    ].join("\n");
    const validation = validateVerificationReport(content);
    expect(
      validation.errors.some((error) =>
        error.includes("section 2 has no official citation of its own"),
      ),
    ).toBe(true);
  });

  it("fails on non-official citations", () => {
    const validation = validateVerificationReport(
      "see https://example.com/unofficial\n",
    );
    expect(
      validation.errors.some((error) =>
        error.includes("non-official citation"),
      ),
    ).toBe(true);
  });

  it("fails on an SDK citation that is not pinned to the reference commit", () => {
    const validation = validateVerificationReport(
      syntheticReport({
        "1":
          "Source: https://github.com/Polymarket/ts-sdk/blob/main/packages/bindings/src/shared.ts\n",
      }),
    );
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) =>
        error.includes("not pinned to reference commit"),
      ),
    ).toBe(true);
  });

  it("accepts an SDK citation pinned to the reference commit", () => {
    const validation = validateVerificationReport(
      syntheticReport({
        "1": `Source: ${SDK_PERMALINK_PREFIX}packages/bindings/src/shared.ts\n`,
      }),
    );
    expect(validation.errors).toEqual([]);
  });
});

describe("runVenueVerification", () => {
  const report = runVenueVerification();

  it("passes against the frozen fixtures and report without network access", () => {
    expect(report.reportValidation.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.results.length).toBe(VENUE_CHECKS.length);
  });

  it("documented-only checks report DOCUMENTED backed by section evidence", () => {
    const documented = report.results.filter(
      (result) => result.check.kind === "documented",
    );
    expect(documented.length).toBeGreaterThan(0);
    for (const result of documented) {
      expect(result.status).toBe("DOCUMENTED");
      expect(result.errors).toEqual([]);
    }
  });

  it("overall PASS requires fixture-backed evidence", () => {
    expect(
      report.results.some((result) => result.status === "PASS"),
    ).toBe(true);
  });

  it("maps pass/fail to exit codes 0/1", () => {
    expect(venueVerificationExitCode(report)).toBe(0);
    expect(
      venueVerificationExitCode({
        ...report,
        ok: false,
      }),
    ).toBe(1);
  });

  it("formats a report with distinct PASS/DOCUMENTED markers and errors", () => {
    const text = formatVenueVerificationReport(report);
    expect(text).toContain("Overall: PASS");
    expect(text).toContain("[PASS]");
    expect(text).toContain("[DOCUMENTED]");
    expect(text).toContain("report-documented only (no fixture evidence)");
    const failing = formatVenueVerificationReport({
      ...report,
      ok: false,
      reportValidation: { ok: false, errors: ["boom"] },
    });
    expect(failing).toContain("Report validation: INVALID");
    expect(failing).toContain("boom");
    expect(failing).toContain("Overall: FAIL");
  });
});
