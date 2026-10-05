/**
 * WP-320: every venue fact the heartbeat controller acts on is cited, and its
 * quote appears verbatim (whitespace-normalized) in its dated report; and the
 * constants are the quoted figures.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_CADENCE_MS,
  HEARTBEAT_OPERATION_ID,
  HEARTBEAT_PRIORITY,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_VENUE_FACTS,
  VENUE_CANCELLATION_CHECK_INTERVAL_MS,
} from "./venue-facts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const normalize = (text: string): string => text.replace(/\s+/gu, " ");

describe("cited heartbeat venue facts", () => {
  for (const fact of Object.values(HEARTBEAT_VENUE_FACTS)) {
    it(`${fact.id} is quoted verbatim from ${fact.source} ${fact.section}`, () => {
      expect(fact.source).toMatch(/^docs\/venue\/verified-\d{4}-\d{2}-\d{2}\.md$/u);
      expect(normalize(readFileSync(path.join(REPO_ROOT, fact.source), "utf8"))).toContain(normalize(fact.quote));
    });
  }

  it("the constants are the quoted figures", () => {
    expect(HEARTBEAT_VENUE_FACTS.CADENCE.quote).toContain("every **5 seconds**");
    expect(HEARTBEAT_CADENCE_MS).toBe(5_000);
    expect(HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP.quote).toContain("within 10 seconds");
    expect(HEARTBEAT_TIMEOUT_MS).toBe(10_000);
    expect(HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP.quote).toContain("runs every five seconds");
    expect(VENUE_CANCELLATION_CHECK_INTERVAL_MS).toBe(5_000);
  });

  it("the heartbeat's budget operation is the one the WP-310 contract snapshot defines as kind HEARTBEAT", () => {
    const snapshot = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json"), "utf8"),
    ) as { operations: { operationId: string; kind: string }[]; policy: { headroomPermille: Record<string, number> } };
    expect(snapshot.operations.find((operation) => operation.operationId === HEARTBEAT_OPERATION_ID)?.kind).toBe("HEARTBEAT");
    expect(HEARTBEAT_PRIORITY).toBe("ORDER_HEARTBEAT");
    expect(snapshot.policy.headroomPermille[HEARTBEAT_PRIORITY]).toBe(0);
  });

  it("NON-VACUOUS: a quote that is not in its source is caught", () => {
    expect(normalize(readFileSync(path.join(REPO_ROOT, "docs/venue/verified-2026-09-16.md"), "utf8"))).not.toContain("Send a heartbeat every **3 seconds**");
  });
});
