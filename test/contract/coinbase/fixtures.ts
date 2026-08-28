/**
 * Fixture catalogue loader for the Coinbase contract suite.
 *
 * Reads every `*.json` in `./fixtures`, validates the provenance wrapper, and
 * exposes the frames as the exact text the adapter would receive from a socket.
 *
 * The wrapper is validated by hand rather than with zod, because these files sit
 * outside every workspace package and pulling a validator in through an alias
 * would put a dependency in the test tree that the tests do not otherwise need.
 * The checks below are the whole schema; a fixture that violates one fails
 * loading, which fails the suite.
 *
 * DISCOVERY IS BY DIRECTORY LISTING, NOT BY A HARD-CODED LIST. A fixture added
 * without a test is still parsed and provenance-checked by
 * `fixtures.test.ts`, so a new file cannot slip in unvalidated.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type FixtureProvenance = {
  readonly kind: "DOCUMENTED_EXAMPLE" | "SYNTHETIC_COMPLETION";
  readonly basedOn?: string | null;
  readonly source: string;
  readonly section: string;
  readonly accessedAt: string;
  readonly modifications: readonly string[];
};

/**
 * The classification arm the adapter must place this frame in.
 *
 * Declared per fixture rather than inferred from the file name, because "this
 * is a malformed fixture" and "this frame fails to parse" are different claims:
 * `malformed-nonpositive-size` parses perfectly as `market_trades` and fails at
 * the decimal boundary instead. Writing the arm down keeps that distinction
 * visible in the catalogue.
 */
export type FixtureClassification =
  | "MARKET_TRADES"
  | "TICKER"
  | "HEARTBEATS"
  | "CONTROL"
  | "UNKNOWN_CHANNEL"
  | "REJECTED";

const CLASSIFICATIONS: readonly FixtureClassification[] = [
  "MARKET_TRADES",
  "TICKER",
  "HEARTBEATS",
  "CONTROL",
  "UNKNOWN_CHANNEL",
  "REJECTED",
];

export type CoinbaseFixture = {
  readonly id: string;
  readonly fileName: string;
  readonly provenance: FixtureProvenance;
  readonly classification: FixtureClassification;
  readonly expectation: string;
  /** The frame as a JSON value, when the fixture is JSON. */
  readonly frame?: unknown;
  /** The frame as raw text, for fixtures that are deliberately not JSON. */
  readonly rawText?: string;
};

function fail(fileName: string, problem: string): never {
  throw new Error(`fixture ${fileName}: ${problem}`);
}

function loadOne(fileName: string): CoinbaseFixture {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, fileName), "utf8"));
  if (typeof raw !== "object" || raw === null) {
    fail(fileName, "is not a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) {
    fail(fileName, "has no string id");
  }
  if (`${id}.json` !== fileName) {
    fail(fileName, `id "${id}" does not match its file name`);
  }
  const expectation = record["expectation"];
  if (typeof expectation !== "string" || expectation.length === 0) {
    fail(fileName, "has no expectation; a fixture must state what it is for");
  }
  const classification = record["classification"];
  if (
    typeof classification !== "string" ||
    !(CLASSIFICATIONS as readonly string[]).includes(classification)
  ) {
    fail(fileName, `classification must be one of ${CLASSIFICATIONS.join(", ")}`);
  }

  const provenanceValue = record["provenance"];
  if (typeof provenanceValue !== "object" || provenanceValue === null) {
    fail(fileName, "has no provenance record");
  }
  const provenanceRecord = provenanceValue as Record<string, unknown>;
  const kind = provenanceRecord["kind"];
  if (kind !== "DOCUMENTED_EXAMPLE" && kind !== "SYNTHETIC_COMPLETION") {
    fail(fileName, `provenance.kind must be DOCUMENTED_EXAMPLE or SYNTHETIC_COMPLETION`);
  }
  const source = provenanceRecord["source"];
  if (typeof source !== "string" || !source.startsWith("https://docs.cdp.coinbase.com/")) {
    fail(fileName, "provenance.source must be an official docs.cdp.coinbase.com URL");
  }
  const section = provenanceRecord["section"];
  if (typeof section !== "string" || section.length === 0) {
    fail(fileName, "provenance.section must name where in the page the claim lives");
  }
  const accessedAt = provenanceRecord["accessedAt"];
  if (typeof accessedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(accessedAt)) {
    fail(fileName, "provenance.accessedAt must be an ISO date");
  }
  const modifications = provenanceRecord["modifications"];
  if (!Array.isArray(modifications) || modifications.some((m) => typeof m !== "string")) {
    fail(fileName, "provenance.modifications must be an array of strings");
  }
  if (kind === "DOCUMENTED_EXAMPLE" && modifications.length > 0) {
    fail(fileName, "a DOCUMENTED_EXAMPLE may not list modifications");
  }
  if (kind === "SYNTHETIC_COMPLETION" && modifications.length === 0) {
    fail(fileName, "a SYNTHETIC_COMPLETION must list every change it made");
  }

  const hasFrame = "frame" in record;
  const hasRawText = "rawText" in record;
  if (hasFrame === hasRawText) {
    fail(fileName, "must carry exactly one of frame or rawText");
  }
  if (hasRawText && typeof record["rawText"] !== "string") {
    fail(fileName, "rawText must be a string");
  }

  const basedOn = provenanceRecord["basedOn"];
  if (basedOn !== undefined && basedOn !== null && typeof basedOn !== "string") {
    fail(fileName, "provenance.basedOn must be a fixture id, null, or absent");
  }

  return {
    id,
    fileName,
    provenance: {
      kind,
      ...(basedOn === undefined ? {} : { basedOn: basedOn as string | null }),
      source,
      section,
      accessedAt,
      modifications: modifications as readonly string[],
    },
    classification: classification as FixtureClassification,
    expectation,
    ...(hasFrame ? { frame: record["frame"] } : {}),
    ...(hasRawText ? { rawText: record["rawText"] as string } : {}),
  };
}

/** Every fixture in the catalogue, sorted by id for a stable test order. */
export const FIXTURES: readonly CoinbaseFixture[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(loadOne);

const BY_ID = new Map(FIXTURES.map((fixture) => [fixture.id, fixture]));

/** Looks a fixture up, failing loudly rather than returning `undefined`. */
export function fixture(id: string): CoinbaseFixture {
  const found = BY_ID.get(id);
  if (found === undefined) {
    throw new Error(`no fixture "${id}"; catalogue: ${[...BY_ID.keys()].join(", ")}`);
  }
  return found;
}

/**
 * The fixture as the exact text a socket would deliver.
 *
 * `JSON.stringify` of the stored value, because the stored value IS the frame:
 * the wrapper's own formatting is not part of the venue's message.
 */
export function frameText(id: string): string {
  const found = fixture(id);
  if (found.rawText !== undefined) {
    return found.rawText;
  }
  return JSON.stringify(found.frame);
}

/**
 * The fixture's frame with a different `sequence_num`.
 *
 * Every documented example prints `"sequence_num": 0` because each is shown in
 * isolation, so composing several documented frames into one connection's
 * stream requires re-sequencing. This is the same modification the synthetic
 * fixtures record in prose; doing it here keeps the documented fixtures
 * byte-faithful instead of forking them.
 */
export function frameTextWithSequence(id: string, sequenceNum: number): string {
  const found = fixture(id);
  if (found.frame === undefined) {
    throw new Error(`fixture "${id}" has no JSON frame to re-sequence`);
  }
  return JSON.stringify({
    ...(found.frame as Record<string, unknown>),
    sequence_num: sequenceNum,
  });
}

/**
 * The fixture's frame with a different envelope `timestamp`.
 *
 * Same purpose as {@link frameTextWithSequence}: one documented frame with one
 * envelope field replaced, done visibly in code rather than by forking the
 * fixture. Used where the assertion is only about the envelope's own time — the
 * channel's payload is irrelevant to it, so a dedicated fixture per channel
 * would add a file and no evidence.
 */
export function frameTextWithTimestamp(id: string, timestamp: string): string {
  const found = fixture(id);
  if (found.frame === undefined) {
    throw new Error(`fixture "${id}" has no JSON frame to re-time`);
  }
  return JSON.stringify({
    ...(found.frame as Record<string, unknown>),
    timestamp,
  });
}
