/**
 * WP-000: validates that every sanitized venue fixture parses and matches its
 * expected structural shape. Local files only — no network, no credentials,
 * no orders.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { VENUE_CHECKS } from "./checks.js";
import { VENUE_FIXTURE_ROOT, loadFixture } from "./fixtures.js";
import { runVenueVerification } from "./index.js";

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
    const claimed = fixtureChecks.flatMap((check) => [...check.fixtures]).sort();
    expect(claimed).toEqual([...new Set(claimed)]);
    expect(onDisk).toEqual(claimed);
  });
});

describe("venue fixture structural validation", () => {
  for (const check of fixtureChecks) {
    for (const fixturePath of check.fixtures) {
      it(`${fixturePath} parses and matches its expected shape (${check.id})`, () => {
        const result = loadFixture(fixturePath, check.requiredPayloadKeys);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.fixture).not.toBeNull();
        expect(result.fixture?.sanitized).toBe(true);
        expect(result.fixture?.retrieved).toBe("2026-08-24");
        expect(result.fixture?.examples.length).toBeGreaterThan(0);
      });
    }
  }

  it("user-ws trade settlement covers all documented settlement states", () => {
    const result = loadFixture("user-ws/trade-settlement.json", []);
    const statuses = result.fixture?.examples.map(
      (example) => example.payload["status"],
    );
    for (const status of [
      "MATCHED",
      "MINED",
      "CONFIRMED",
      "RETRYING",
      "FAILED",
    ]) {
      expect(statuses).toContain(status);
    }
  });

  it("order responses cover live, matched, delayed, and unmatched statuses plus errors", () => {
    const result = loadFixture("orders/order-responses.json", []);
    const statuses = result.fixture?.examples.map(
      (example) => example.payload["status"],
    );
    for (const status of ["live", "matched", "delayed", "unmatched"]) {
      expect(statuses).toContain(status);
    }
    const failures = result.fixture?.examples.filter(
      (example) => example.payload["success"] === false,
    );
    expect(failures?.length).toBeGreaterThan(0);
  });

  it("delayed order response is pending: zero amounts and no trades/hashes", () => {
    const result = loadFixture("orders/order-responses.json", []);
    const delayed = result.fixture?.examples.find(
      (example) => example.payload["status"] === "delayed",
    );
    expect(delayed).toBeDefined();
    expect(delayed?.payload["makingAmount"]).toBe("0");
    expect(delayed?.payload["takingAmount"]).toBe("0");
    expect(delayed?.payload["tradeIDs"]).toEqual([]);
    expect(delayed?.payload["transactionsHashes"]).toEqual([]);
  });

  it("price-change fixture includes the (UNVERIFIED) zero-size level-removal example", () => {
    const result = loadFixture("market-ws/price-change.json", []);
    const removal = result.fixture?.examples.find((example) =>
      example.name.startsWith("level-removed"),
    );
    expect(removal).toBeDefined();
    expect(removal?.name).toContain("UNVERIFIED");
    const changes = removal?.payload["price_changes"] as Array<
      Record<string, unknown>
    >;
    expect(changes[0]?.["size"]).toBe("0");
  });

  it("position operations cover split, merge, and redeem", () => {
    const result = loadFixture("positions/split-merge-redeem.json", []);
    const operations = result.fixture?.examples.map(
      (example) => example.payload["operation"],
    );
    for (const operation of ["split", "merge", "redeem"]) {
      expect(operations).toContain(operation);
    }
  });
});

describe("runVenueVerification", () => {
  it("passes against the frozen fixture set without any network access", () => {
    const report = runVenueVerification();
    expect(report.ok).toBe(true);
    expect(report.results.length).toBe(VENUE_CHECKS.length);
    for (const result of report.results) {
      expect(result.ok).toBe(true);
    }
  });
});
