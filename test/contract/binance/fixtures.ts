/**
 * Fixture loading and validation for the Binance contract suite (`WP-080`).
 *
 * EVERY FIXTURE IS VALIDATED BEFORE IT IS USED. A fixture file that has drifted
 * out of the shape below fails the suite instead of silently exercising nothing,
 * which is the failure mode a fixture-driven suite is otherwise prone to: a
 * typo'd key turns an assertion into a no-op.
 *
 * The validation is hand-written rather than schema-driven on purpose: this tree
 * is not a workspace package, so it resolves only what the repository root
 * installs, and `zod` is a dependency of `packages/domain`, not of the root.
 * Adding it to the root manifest to validate test data would edit a protected
 * path for a test-only convenience.
 *
 * PROVENANCE IS PART OF THE DATA. `AGENTS.md` forbids inventing venue behavior,
 * so every file and every frame records where it came from:
 *
 * - `OFFICIAL_EXAMPLE` — copied field for field from a documented payload block.
 * - `OFFICIAL_EXAMPLE_WITH_PLACEHOLDER_FILLED` — a documented example whose
 *   printf placeholders (`%s`) are not JSON values; the placeholder is filled and
 *   the substitution is stated in the file's `notes`.
 * - `SYNTHETIC_DERIVED` — a documented frame SHAPE arranged into a sequence or
 *   deviation the venue publishes no example of. Labelled so no reader mistakes
 *   it for evidence of what Binance sends.
 *
 * OFFLINE. Nothing here reaches the network; the files are read from disk.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIRECTORY = join(HERE, "fixtures");

export const FIXTURE_PROVENANCES = [
  "OFFICIAL_EXAMPLE",
  "OFFICIAL_EXAMPLE_WITH_PLACEHOLDER_FILLED",
  "SYNTHETIC_DERIVED",
] as const;

export type FixtureProvenance = (typeof FIXTURE_PROVENANCES)[number];

export type FixtureSource = {
  readonly document: string;
  readonly url: string;
  readonly accessedAt: string;
};

export type FixtureFrame = {
  readonly label: string;
  readonly provenance: FixtureProvenance;
  readonly expectedKind: string;
  readonly expectedClassification: string;
  readonly expectedSequenceOutcome?: string;
  readonly json?: unknown;
  readonly text?: string;
};

export type FramesFixture = {
  readonly fixtureId: string;
  readonly kind: "frames";
  readonly provenance: FixtureProvenance;
  readonly source: FixtureSource;
  readonly notes: readonly string[];
  /**
   * Whether the frames form ONE stream, in order.
   *
   * `true` means the file is a transcript: frame N is interpreted against the
   * state frames 1..N-1 left behind, which is what makes a duplicate a
   * duplicate. `false` (the default) means each frame is an independent example
   * and must be driven through a fresh feed — otherwise a file that shows the
   * same documented payload twice, once raw and once wrapped, would report the
   * second copy as a duplicate and say nothing about the wrapper.
   */
  readonly sequential: boolean;
  readonly frames: readonly FixtureFrame[];
};

export type SessionStep =
  | { readonly step: "OPEN"; readonly connectionId: string; readonly advanceMs: number }
  | {
      readonly step: "CLOSE";
      readonly advanceMs: number;
      readonly code?: number;
      readonly reason?: string;
    }
  | {
      readonly step: "FRAME";
      readonly label: string;
      readonly advanceMs: number;
      readonly expectedClassification: string;
      readonly json?: unknown;
      readonly text?: string;
    };

export type SessionFixture = {
  readonly fixtureId: string;
  readonly kind: "session";
  readonly provenance: FixtureProvenance;
  readonly source: FixtureSource;
  readonly notes: readonly string[];
  readonly steps: readonly SessionStep[];
};

export type BinanceFixture = FramesFixture | SessionFixture;

class FixtureError extends Error {}

function fail(file: string, path: string, message: string): never {
  throw new FixtureError(`fixture ${file} :: ${path} ${message}`);
}

function asRecord(file: string, path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(file, path, "must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(
  file: string,
  path: string,
  record: Record<string, unknown>,
  key: string,
  minimumLength = 1,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < minimumLength) {
    fail(file, `${path}.${key}`, `must be a string of at least ${String(minimumLength)} characters`);
  }
  return value;
}

function optionalString(
  file: string,
  path: string,
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string") {
    fail(file, `${path}.${key}`, "must be a string when present");
  }
  return value;
}

function optionalInteger(
  file: string,
  path: string,
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(file, `${path}.${key}`, "must be a safe integer when present");
  }
  return value;
}

function requireNonNegativeInteger(
  file: string,
  path: string,
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(file, `${path}.${key}`, "must be a non-negative safe integer");
  }
  return value;
}

function requireOptionalBoolean(
  file: string,
  path: string,
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "boolean") {
    fail(file, `${path}.${key}`, "must be a boolean when present");
  }
  return value;
}

function requireProvenance(
  file: string,
  path: string,
  record: Record<string, unknown>,
): FixtureProvenance {
  const value = requireString(file, path, record, "provenance");
  const known: readonly string[] = FIXTURE_PROVENANCES;
  if (!known.includes(value)) {
    fail(file, `${path}.provenance`, `must be one of ${FIXTURE_PROVENANCES.join(", ")}`);
  }
  return value as FixtureProvenance;
}

function requireSource(file: string, record: Record<string, unknown>): FixtureSource {
  const source = asRecord(file, "source", record["source"]);
  const url = requireString(file, "source", source, "url");
  if (!url.startsWith("https://")) {
    fail(file, "source.url", "must be an https URL naming the official documentation");
  }
  const accessedAt = requireString(file, "source", source, "accessedAt");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(accessedAt)) {
    fail(file, "source.accessedAt", "must be an ISO calendar date (YYYY-MM-DD)");
  }
  return {
    document: requireString(file, "source", source, "document", 10),
    url,
    accessedAt,
  };
}

function requireNotes(file: string, record: Record<string, unknown>): readonly string[] {
  const notes = record["notes"];
  if (!Array.isArray(notes) || notes.length === 0) {
    fail(file, "notes", "must be a non-empty array of strings");
  }
  return notes.map((note, index) => {
    if (typeof note !== "string" || note.length === 0) {
      fail(file, `notes[${String(index)}]`, "must be a non-empty string");
    }
    return note;
  });
}

/** Exactly one of `json` / `text`, so a frame's payload form is never ambiguous. */
function requirePayloadForm(
  file: string,
  path: string,
  record: Record<string, unknown>,
): { readonly json?: unknown; readonly text?: string } {
  const hasJson = "json" in record;
  const hasText = "text" in record;
  if (hasJson === hasText) {
    fail(file, path, "must state exactly one of `json` or `text`");
  }
  if (hasText) {
    const text = record["text"];
    if (typeof text !== "string") {
      fail(file, `${path}.text`, "must be a string");
    }
    return { text };
  }
  return { json: record["json"] };
}

function parseFrame(file: string, index: number, value: unknown): FixtureFrame {
  const path = `frames[${String(index)}]`;
  const record = asRecord(file, path, value);
  const sequenceOutcome = optionalString(file, path, record, "expectedSequenceOutcome");
  return {
    label: requireString(file, path, record, "label"),
    provenance: requireProvenance(file, path, record),
    expectedKind: requireString(file, path, record, "expectedKind"),
    expectedClassification: requireString(file, path, record, "expectedClassification"),
    ...(sequenceOutcome === undefined ? {} : { expectedSequenceOutcome: sequenceOutcome }),
    ...requirePayloadForm(file, path, record),
  };
}

function parseStep(file: string, index: number, value: unknown): SessionStep {
  const path = `steps[${String(index)}]`;
  const record = asRecord(file, path, value);
  const step = requireString(file, path, record, "step");
  const advanceMs = requireNonNegativeInteger(file, path, record, "advanceMs");

  if (step === "OPEN") {
    return { step: "OPEN", connectionId: requireString(file, path, record, "connectionId"), advanceMs };
  }
  if (step === "CLOSE") {
    const code = optionalInteger(file, path, record, "code");
    const reason = optionalString(file, path, record, "reason");
    return {
      step: "CLOSE",
      advanceMs,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (step === "FRAME") {
    return {
      step: "FRAME",
      label: requireString(file, path, record, "label"),
      advanceMs,
      expectedClassification: requireString(file, path, record, "expectedClassification"),
      ...requirePayloadForm(file, path, record),
    };
  }
  return fail(file, `${path}.step`, "must be OPEN, CLOSE, or FRAME");
}

function parseFixture(file: string, value: unknown): BinanceFixture {
  const record = asRecord(file, "(root)", value);
  const fixtureId = requireString(file, "(root)", record, "fixtureId");
  const kind = requireString(file, "(root)", record, "kind");
  const provenance = requireProvenance(file, "(root)", record);
  const source = requireSource(file, record);
  const notes = requireNotes(file, record);

  if (kind === "frames") {
    const frames = record["frames"];
    if (!Array.isArray(frames) || frames.length === 0) {
      fail(file, "frames", "must be a non-empty array");
    }
    return {
      fixtureId,
      kind: "frames",
      provenance,
      source,
      notes,
      sequential: requireOptionalBoolean(file, "(root)", record, "sequential") ?? false,
      frames: frames.map((frame, index) => parseFrame(file, index, frame)),
    };
  }
  if (kind === "session") {
    const steps = record["steps"];
    if (!Array.isArray(steps) || steps.length === 0) {
      fail(file, "steps", "must be a non-empty array");
    }
    return {
      fixtureId,
      kind: "session",
      provenance,
      source,
      notes,
      steps: steps.map((step, index) => parseStep(file, index, step)),
    };
  }
  return fail(file, "(root).kind", "must be `frames` or `session`");
}

/** Every fixture file in the directory, validated, in a stable order. */
export function loadAllFixtures(): readonly { file: string; fixture: BinanceFixture }[] {
  const files = readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new FixtureError(`no fixtures found in ${FIXTURE_DIRECTORY}`);
  }
  return files.map((file) => ({
    file,
    fixture: parseFixture(file, JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), "utf8"))),
  }));
}

/** Loads one fixture file by id, failing loudly if it is missing. */
export function loadFixture(fixtureId: string): BinanceFixture {
  const found = loadAllFixtures().find((entry) => entry.fixture.fixtureId === fixtureId);
  if (found === undefined) {
    throw new FixtureError(`no fixture with id ${fixtureId}`);
  }
  return found.fixture;
}

export function framesFixture(fixtureId: string): FramesFixture {
  const fixture = loadFixture(fixtureId);
  if (fixture.kind !== "frames") {
    throw new FixtureError(`fixture ${fixtureId} is a ${fixture.kind} fixture, not a frames fixture`);
  }
  return fixture;
}

export function sessionFixture(fixtureId: string): SessionFixture {
  const fixture = loadFixture(fixtureId);
  if (fixture.kind !== "session") {
    throw new FixtureError(
      `fixture ${fixtureId} is a ${fixture.kind} fixture, not a session fixture`,
    );
  }
  return fixture;
}

/**
 * Renders a fixture entry as the exact string a socket would deliver.
 *
 * `text` is used verbatim so a malformed fixture stays malformed; `json` is
 * serialized, which is what makes the documented payload blocks readable in the
 * file instead of being buried in an escaped string.
 */
export function frameText(entry: {
  readonly json?: unknown;
  readonly text?: string | undefined;
}): string {
  if (entry.text !== undefined) {
    return entry.text;
  }
  return JSON.stringify(entry.json);
}
