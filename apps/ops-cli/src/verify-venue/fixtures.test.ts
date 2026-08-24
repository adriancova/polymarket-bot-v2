/**
 * WP-000: validates that every sanitized venue fixture parses and matches its
 * source-specific schema, that the frozen verification report validates, and
 * that the skeleton's failure modes behave. Local files only — no network,
 * no credentials, no orders.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { VENUE_CHECKS } from "./checks.js";
import {
  VENUE_FIXTURE_ROOT,
  loadFixture,
  validateFixtureDocument,
} from "./fixtures.js";
import type { FixtureExample } from "./fixtures.js";
import {
  formatVenueVerificationReport,
  loadAndValidateReport,
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

function examplesOf(relativePath: string): readonly FixtureExample[] {
  const result = loadFixture(relativePath, {});
  expect(result.fixture, result.errors.join("; ")).not.toBeNull();
  return result.fixture?.examples ?? [];
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

const fixtureChecks = VENUE_CHECKS.filter((check) => check.kind === "fixture");

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
});

describe("venue fixture structural validation", () => {
  for (const check of fixtureChecks) {
    for (const fixturePath of check.fixtures) {
      it(`${fixturePath} parses and matches its schema (${check.id})`, () => {
        const result = loadFixture(fixturePath, check.payloadSchema);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.fixture?.sanitized).toBe(true);
        expect(result.fixture?.retrieved).toBe("2026-08-24");
        expect(result.fixture?.examples.length).toBeGreaterThan(0);
      });
    }
  }
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
});

describe("user-stream events", () => {
  it("trade settlement covers all six documented settlement states", () => {
    const statuses = examplesOf("user-ws/trade-settlement.json").map(
      (example) => example.payload["status"],
    );
    for (const status of [
      "MATCHED_NOT_BROADCASTED",
      "MATCHED",
      "MINED",
      "CONFIRMED",
      "RETRYING",
      "FAILED",
    ]) {
      expect(statuses).toContain(status);
    }
  });

  it("the MATCHED_NOT_BROADCASTED wire string is flagged UNVERIFIED", () => {
    const example = examplesOf("user-ws/trade-settlement.json").find(
      (candidate) => candidate.payload["status"] === "MATCHED_NOT_BROADCASTED",
    );
    expect(example?.name).toContain("UNVERIFIED");
  });

  it("every order event carries the full documented wire field set", () => {
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
        "outcome",
        "status",
        "timestamp",
      ]) {
        expect(example.payload, `${example.name} missing ${field}`).toHaveProperty(
          field,
        );
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
});

describe("order placement responses", () => {
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
    const doc = envelope([
      { name: "bad", payload: { side: "HOLD", price: 0.5, live: "yes" } },
    ]);
    const { errors } = validateFixtureDocument(doc, "x/y", {
      side: { type: "string", enum: ["BUY", "SELL"] },
      price: { type: "decimal-string" },
      live: { type: "boolean" },
      missing: { type: "string" },
    });
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
    const schema = {
      hash: { type: "string", optional: true },
    } as const;
    const okDoc = envelope([{ name: "a", payload: {} }]);
    expect(validateFixtureDocument(okDoc, "x/y", schema).errors).toEqual([]);
    const badDoc = envelope([{ name: "a", payload: { hash: 5 } }]);
    expect(
      validateFixtureDocument(badDoc, "x/y", schema).errors.length,
    ).toBeGreaterThan(0);
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
  ]) {
    it(`fails validation when a fixture contains a non-placeholder "${secretKey}"`, () => {
      const doc = envelope([
        {
          name: "leaky",
          payload: { nested: { [secretKey]: "realistic-secret-value-123" } },
        },
      ]);
      const { errors } = validateFixtureDocument(doc, "x/y", {});
      expect(
        errors.some((error) =>
          error.includes("must be a sanitized placeholder"),
        ),
      ).toBe(true);
    });
  }

  it("allows sanitized placeholders in credential-shaped fields", () => {
    const doc = envelope([
      {
        name: "clean",
        payload: {
          owner: "00000000-0000-0000-0000-000000000000",
          apiKey: "sanitized-api-key",
          signature: "",
        },
      },
    ]);
    expect(validateFixtureDocument(doc, "x/y", {}).errors).toEqual([]);
  });
});

describe("verification report validation", () => {
  it("the frozen report exists and validates", () => {
    const { content, validation } = loadAndValidateReport();
    expect(content).not.toBeNull();
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
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
      "## 1. Something\nUNVERIFIED\n",
    );
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) => error.includes("missing required section")),
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
});

describe("runVenueVerification", () => {
  const report = runVenueVerification();

  it("passes against the frozen fixtures and report without network access", () => {
    expect(report.reportValidation.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.results.length).toBe(VENUE_CHECKS.length);
  });

  it("documented-only checks report DOCUMENTED, never a vacuous PASS", () => {
    const documented = report.results.filter(
      (result) => result.check.kind === "documented",
    );
    expect(documented.length).toBeGreaterThan(0);
    for (const result of documented) {
      expect(result.status).toBe("DOCUMENTED");
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
