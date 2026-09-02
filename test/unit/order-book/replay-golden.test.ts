/**
 * WP-150 acceptance 1: "Fixture replay reconstructs the expected book
 * byte-for-byte."
 *
 * The fixture lives in `test/replay-golden/order-book/` with its provenance
 * documented in that directory's README (frozen WP-000 venue fixtures +
 * ADR-013's ratified semantics; synthetic values declared). The expected
 * serializations were derived BY HAND from the step semantics — they are the
 * oracle, not a recording of the implementation's own output.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Imported RELATIVELY through the package's own `exports` entry module
// (`packages/order-book/package.json` maps "." to `./src/index.ts`), because
// the root test tree declares no dependency on this workspace package and the
// root `package.json` is outside WP-150's allowed paths. This is the entry
// point, not a deep import.
import { MarketOutcomeBooks, serializeBook } from "../../../packages/order-book/src/index.js";
import type { BookIngestMeta } from "../../../packages/order-book/src/index.js";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "replay-golden",
  "order-book",
);

interface SnapshotStep {
  readonly kind: "snapshot";
  readonly meta: BookIngestMeta;
  readonly payload: unknown;
}

interface LevelChangeStep {
  readonly kind: "levelChange";
  readonly meta: BookIngestMeta;
  readonly payload: unknown;
}

interface TickSizeStep {
  readonly kind: "tickSize";
  readonly tickSize: string;
}

type ReplayStep = SnapshotStep | LevelChangeStep | TickSizeStep;

interface ReplayFixture {
  readonly fixture: string;
  readonly market: {
    readonly internalMarketId: string;
    readonly yesTokenId: string;
    readonly noTokenId: string;
  };
  readonly steps: readonly ReplayStep[];
  readonly expected: {
    readonly yesSerialization: readonly string[];
    readonly noSerialization: readonly string[];
  };
}

function loadFixture(name: string): ReplayFixture {
  const raw = readFileSync(resolve(FIXTURE_DIR, name), "utf8");
  const parsed = JSON.parse(raw) as ReplayFixture;
  // The suite must not pass vacuously on a truncated fixture.
  expect(parsed.fixture).toBe("order-book/replay-two-token-books");
  expect(parsed.steps.length).toBeGreaterThan(0);
  expect(parsed.expected.yesSerialization.length).toBeGreaterThan(0);
  expect(parsed.expected.noSerialization.length).toBeGreaterThan(0);
  return parsed;
}

function replay(fixture: ReplayFixture): MarketOutcomeBooks {
  const books = new MarketOutcomeBooks(fixture.market);
  for (const [index, step] of fixture.steps.entries()) {
    const outcome =
      step.kind === "snapshot"
        ? books.applySnapshot({ payload: step.payload, meta: step.meta })
        : step.kind === "levelChange"
          ? books.applyLevelChange({ payload: step.payload, meta: step.meta })
          : books.applyTickSizeChange({ tickSize: step.tickSize });
    // Every fixture step is a legitimate venue-shaped update; a refusal here
    // is a reconstruction defect, reported with the step for diagnosis.
    expect(outcome, `step ${String(index)} (${step.kind}) must apply`).toEqual({ applied: true });
  }
  return books;
}

describe("WP-150 acceptance 1 — replay-golden reconstruction", () => {
  it("acceptance 1: fixture replay reconstructs the expected book byte-for-byte", () => {
    const fixture = loadFixture("replay-two-token-books.json");
    const books = replay(fixture);

    const expectedYes = fixture.expected.yesSerialization.join("\n");
    const expectedNo = fixture.expected.noSerialization.join("\n");

    // Byte-for-byte: the canonical serialization must equal the hand-derived
    // oracle exactly — one spelling, one order, no tolerance.
    expect(serializeBook(books.yesBook)).toBe(expectedYes);
    expect(serializeBook(books.noBook)).toBe(expectedNo);
  });

  it("replay is deterministic: a second replay from fresh state yields identical bytes", () => {
    const fixture = loadFixture("replay-two-token-books.json");
    const first = replay(fixture);
    const second = replay(fixture);
    expect(serializeBook(second.yesBook)).toBe(serializeBook(first.yesBook));
    expect(serializeBook(second.noBook)).toBe(serializeBook(first.noBook));
  });

  it("the two token books are independent through the whole replay (§9.4)", () => {
    const fixture = loadFixture("replay-two-token-books.json");
    const books = replay(fixture);
    // The YES book never saw the NO book's synthetic levels and vice versa.
    expect(books.yesBook.levels("ASK").map((level) => level.price)).not.toContain("0.91");
    expect(books.noBook.levels("BID")).toEqual([]);
    expect(books.yesBook.updatesApplied()).toBe(4);
    expect(books.noBook.updatesApplied()).toBe(2);
  });
});
