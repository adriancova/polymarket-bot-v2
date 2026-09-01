/**
 * Loading the incident windows a compaction run excludes.
 *
 * §10.2 puts data-quality incidents in PostgreSQL (`data.data_quality_incidents`),
 * and that is where they will come from once a component owns writing them.
 * Today nothing does, so the worker reads them from a JSON file supplied by an
 * operator and **states that** rather than pretending a database is the source.
 *
 * The alternative — silently compacting with no exclusions at all — would
 * produce a dataset manifest whose `excludedIncidentWindows` list is empty and
 * indistinguishable from "there were no incidents". A file that is configured
 * but unreadable is therefore a hard failure, not a warning.
 */

import { readFile } from "node:fs/promises";

import type { IncidentKind, IncidentWindow } from "@polymarket-bot/storage-parquet";
import { validateIncidentWindows } from "@polymarket-bot/storage-parquet";

const INCIDENT_KINDS: readonly IncidentKind[] = [
  "gap",
  "staleness",
  "corruption",
  "resync",
  "queue-overflow",
  "capacity-exceeded",
  "other",
];

export class IncidentWindowFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentWindowFileError";
  }
}

function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new IncidentWindowFileError(`${where}: ${field} must be a non-empty string`);
  }
  return value;
}

/** Parse a JSON array of incident windows. */
export function parseIncidentWindowDocument(value: unknown): readonly IncidentWindow[] {
  if (!Array.isArray(value)) {
    throw new IncidentWindowFileError("incident window document must be a JSON array");
  }
  const windows = value.map((entry, index) => {
    const where = `window ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new IncidentWindowFileError(`${where}: must be a JSON object`);
    }
    const source = entry as Record<string, unknown>;
    const kind = source["kind"];
    if (typeof kind !== "string" || !INCIDENT_KINDS.includes(kind as IncidentKind)) {
      throw new IncidentWindowFileError(
        `${where}: kind must be one of ${INCIDENT_KINDS.join(", ")}`,
      );
    }
    const closedAt = source["closedAt"];
    if (closedAt !== null && typeof closedAt !== "string") {
      throw new IncidentWindowFileError(`${where}: closedAt must be a string or null`);
    }
    return {
      incidentId: requireString(source, "incidentId", where),
      kind: kind as IncidentKind,
      gatewayEpoch: requireString(source, "gatewayEpoch", where),
      fromIngestSeq: requireString(source, "fromIngestSeq", where),
      toIngestSeq: requireString(source, "toIngestSeq", where),
      openedAt: requireString(source, "openedAt", where),
      closedAt: closedAt ?? null,
      reason: requireString(source, "reason", where),
    } satisfies IncidentWindow;
  });

  const problems = validateIncidentWindows(windows);
  if (problems.length > 0) {
    throw new IncidentWindowFileError(
      `incident windows are malformed: ${problems
        .map((problem) => `${problem.incidentId} (${problem.problem})`)
        .join("; ")}`,
    );
  }
  return windows;
}

/**
 * Read incident windows from a file.
 *
 * A `null` path means "no windows configured", which is a decision. A path that
 * does not exist is an error, because it means someone configured exclusions
 * that are not being applied.
 */
export async function loadIncidentWindows(
  path: string | null,
): Promise<readonly IncidentWindow[]> {
  if (path === null) {
    return [];
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new IncidentWindowFileError(
      `incident window file ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new IncidentWindowFileError(
      `incident window file ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseIncidentWindowDocument(parsed);
}
