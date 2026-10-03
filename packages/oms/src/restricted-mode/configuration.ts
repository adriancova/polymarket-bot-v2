/**
 * Restricted-mode configuration snapshots (WP-310 deliverable 3; handoff
 * §9.13 "Limits are configuration snapshots with source and effective time").
 *
 * The matching-engine durations the detector uses are DATA, never constants:
 *
 * | Field | What it is | Where it comes from |
 * | --- | --- | --- |
 * | `postOnlyWindowMs` | how long post-only mode lasts after a restart, and after a post-only refusal that names no delay | the venue: "enters post-only mode for two minutes" (`VENUE_FACTS.POST_ONLY_AFTER_RESTART`) |
 * | `restartBackoff` | the bounded exponential backoff after a 425 without `Retry-After` | the venue: "Start at 1–2 seconds and increase the interval on each retry"; the official SDK example doubles and caps at 30 s (E-06) |
 * | `tradingUnavailableBackoff` | how long new submissions pause after a 503 without a documented code | policy: the venue says only "Pause new submissions" (E-05) |
 *
 * A snapshot is validated, never repaired. A {@link RestrictedModeTimeline}
 * answers which snapshot is in effect at an instant (the latest whose
 * `effectiveFrom` is at or before it); before the first one, nothing is, and
 * the detector reports `TRADING_UNAVAILABLE` (fail closed).
 *
 * `packages/oms` is layer 1: this module reads no clock. Instants are Unix
 * epoch milliseconds supplied by the caller; `effectiveFrom` is parsed with
 * pure `Date.UTC` arithmetic.
 */

import { readArray, readField } from "../guards.js";

export const RESTRICTED_MODE_CONFIGURATION_SCHEMA = "polymarket-bot/restricted-mode-configuration@1" as const;

/** `initialMs`, multiplied by `multiplier` per consecutive use, capped at `capMs`. */
export interface ModeBackoffPolicy {
  readonly initialMs: number;
  readonly multiplier: number;
  readonly capMs: number;
}

export interface RestrictedModeSource {
  readonly documents: readonly { readonly url: string; readonly retrievedAt: string }[];
  readonly report: string;
  readonly policyAuthority: string;
}

export interface RestrictedModeConfiguration {
  readonly schema: typeof RESTRICTED_MODE_CONFIGURATION_SCHEMA;
  readonly snapshotId: string;
  readonly effectiveFrom: string;
  readonly effectiveFromMs: number;
  readonly source: RestrictedModeSource;
  readonly postOnlyWindowMs: number;
  readonly restartBackoff: ModeBackoffPolicy;
  readonly tradingUnavailableBackoff: ModeBackoffPolicy;
}

export type RestrictedModeConfigurationResult =
  | { readonly ok: true; readonly value: RestrictedModeConfiguration }
  | { readonly ok: false; readonly problems: readonly string[] };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/u;
// eslint-disable-next-line no-control-regex
const TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const ISO_INSTANT = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

/** The smallest value of each `Date.UTC` field after the year: month index, day, hour, minute, second. */
const FIELD_MINIMA = Object.freeze([0, 1, 0, 0, 0]);

function utc(fields: readonly number[]): number {
  const [year = 0, ...rest] = fields;
  return Date.UTC(year, ...rest);
}

/**
 * A strict ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.sss]Z`, year 1000 or
 * later) → epoch milliseconds, or `undefined`. A field out of its calendar
 * range is refused, never rolled over.
 */
export function parseIsoInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;
  const [, y = "", mo = "", d = "", h = "", mi = "", s = "", frac] = match;
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  for (let index = 1; index < fields.length; index += 1) {
    const parent = fields.slice(0, index);
    const lower = utc([...parent, FIELD_MINIMA[index - 1] ?? 0]);
    const actual = utc(fields.slice(0, index + 1));
    const nextParent = [...parent];
    nextParent[index - 1] = (nextParent[index - 1] ?? 0) + 1;
    const upper = utc(nextParent);
    if (!(actual >= lower && actual < upper)) return undefined;
  }
  const ms = utc(fields) + (frac === undefined ? 0 : Number(frac));
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Own enumerable string keys of a plain (non-array) object, or `undefined`. */
function plainKeys(value: unknown): readonly string[] | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      keys.push(key);
    }
    return keys;
  } catch {
    return undefined;
  }
}

class Reader {
  readonly problems: string[] = [];

  fail(path: string, message: string): undefined {
    this.problems.push(`${path}: ${message}`);
    return undefined;
  }

  object(value: unknown, path: string, required: readonly string[]): ((key: string) => unknown) | undefined {
    const keys = plainKeys(value);
    if (keys === undefined) return this.fail(path, "must be a plain object of own data fields");
    for (const key of keys) if (!required.includes(key)) this.fail(`${path}.${key}`, "is not a field of this schema");
    for (const key of required) if (!keys.includes(key)) this.fail(`${path}.${key}`, "is required");
    return (key: string): unknown => {
      const read = readField(value, key);
      if (read.kind === "OPAQUE") {
        this.fail(`${path}.${key}`, "is not an own data field");
        return undefined;
      }
      return read.kind === "DATA" ? read.value : undefined;
    };
  }

  integer(value: unknown, path: string, minimum: number): number | undefined {
    return isIntegerAtLeast(value, minimum) ? value : this.fail(path, `must be a safe integer >= ${String(minimum)}`);
  }

  text(value: unknown, path: string): string | undefined {
    return typeof value === "string" && TEXT.test(value) ? value : this.fail(path, "must be non-empty text without control characters");
  }

  backoff(value: unknown, path: string): ModeBackoffPolicy | undefined {
    const get = this.object(value, path, ["initialMs", "multiplier", "capMs"]);
    if (get === undefined) return undefined;
    const initialMs = this.integer(get("initialMs"), `${path}.initialMs`, 1);
    const multiplier = this.integer(get("multiplier"), `${path}.multiplier`, 1);
    const capMs = this.integer(get("capMs"), `${path}.capMs`, 1);
    if (initialMs === undefined || multiplier === undefined || capMs === undefined) return undefined;
    // "increase the interval on each retry": a backoff that grows, and is bounded.
    if (multiplier === 1) return this.fail(`${path}.multiplier`, "must exceed 1");
    if (capMs < initialMs) return this.fail(`${path}.capMs`, "must be at least initialMs");
    return Object.freeze({ initialMs, multiplier, capMs });
  }
}

/** Validate one snapshot document. Never throws. */
export function parseRestrictedModeConfiguration(raw: unknown): RestrictedModeConfigurationResult {
  try {
    return parseUncontained(raw);
  } catch {
    return Object.freeze({ ok: false as const, problems: Object.freeze(["$: unreadable"]) });
  }
}

function parseUncontained(raw: unknown): RestrictedModeConfigurationResult {
  const r = new Reader();
  const get = r.object(raw, "$", [
    "schema",
    "snapshotId",
    "effectiveFrom",
    "source",
    "postOnlyWindowMs",
    "restartBackoff",
    "tradingUnavailableBackoff",
  ]);
  if (get === undefined) return Object.freeze({ ok: false as const, problems: Object.freeze([...r.problems]) });
  if (get("schema") !== RESTRICTED_MODE_CONFIGURATION_SCHEMA) r.fail("$.schema", `must be ${RESTRICTED_MODE_CONFIGURATION_SCHEMA}`);
  const snapshotIdRaw = get("snapshotId");
  const snapshotId = typeof snapshotIdRaw === "string" && IDENTIFIER.test(snapshotIdRaw) ? snapshotIdRaw : r.fail("$.snapshotId", "must be an identifier");
  const effectiveFromRaw = get("effectiveFrom");
  const effectiveFromMs = parseIsoInstant(effectiveFromRaw) ?? r.fail("$.effectiveFrom", "must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS[.sss]Z)");

  let source: RestrictedModeSource | undefined;
  const getSource = r.object(get("source"), "$.source", ["documents", "report", "policyAuthority"]);
  if (getSource !== undefined) {
    const documents: { readonly url: string; readonly retrievedAt: string }[] = [];
    const list = readArray(getSource("documents"), Number.MAX_SAFE_INTEGER);
    if (list === undefined || list.length === 0) r.fail("$.source.documents", "must be a non-empty array of own data entries");
    list?.forEach((entry, index) => {
      const at = `$.source.documents[${String(index)}]`;
      const getDoc = r.object(entry, at, ["url", "retrievedAt"]);
      if (getDoc === undefined) return;
      const url = getDoc("url");
      const retrievedAt = getDoc("retrievedAt");
      const urlOk = typeof url === "string" && HTTPS_URL.test(url);
      const retrievedOk = parseIsoInstant(retrievedAt) !== undefined;
      if (!urlOk) r.fail(`${at}.url`, "must be an https URL");
      if (!retrievedOk) r.fail(`${at}.retrievedAt`, "must be an ISO-8601 UTC instant");
      if (urlOk && retrievedOk) documents.push(Object.freeze({ url, retrievedAt: retrievedAt as string }));
    });
    const report = r.text(getSource("report"), "$.source.report");
    const policyAuthority = r.text(getSource("policyAuthority"), "$.source.policyAuthority");
    if (report !== undefined && policyAuthority !== undefined) source = Object.freeze({ documents: Object.freeze(documents), report, policyAuthority });
  }

  const postOnlyWindowMs = r.integer(get("postOnlyWindowMs"), "$.postOnlyWindowMs", 1);
  const restartBackoff = r.backoff(get("restartBackoff"), "$.restartBackoff");
  const tradingUnavailableBackoff = r.backoff(get("tradingUnavailableBackoff"), "$.tradingUnavailableBackoff");

  if (
    r.problems.length > 0 ||
    snapshotId === undefined ||
    effectiveFromMs === undefined ||
    source === undefined ||
    postOnlyWindowMs === undefined ||
    restartBackoff === undefined ||
    tradingUnavailableBackoff === undefined
  ) {
    if (r.problems.length === 0) r.fail("$", "is incomplete");
    return Object.freeze({ ok: false as const, problems: Object.freeze([...r.problems]) });
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      schema: RESTRICTED_MODE_CONFIGURATION_SCHEMA,
      snapshotId,
      effectiveFrom: effectiveFromRaw as string,
      effectiveFromMs,
      source,
      postOnlyWindowMs,
      restartBackoff,
      tradingUnavailableBackoff,
    }),
  });
}

/** The snapshots in effect over time. Immutable; effective times and ids are distinct. */
export class RestrictedModeTimeline {
  readonly #snapshots: readonly RestrictedModeConfiguration[];

  private constructor(snapshots: readonly RestrictedModeConfiguration[]) {
    this.#snapshots = Object.freeze([...snapshots].sort((a, b) => a.effectiveFromMs - b.effectiveFromMs));
    Object.freeze(this);
  }

  static empty(): RestrictedModeTimeline {
    return new RestrictedModeTimeline([]);
  }

  with(snapshot: RestrictedModeConfiguration): { readonly ok: true; readonly value: RestrictedModeTimeline } | { readonly ok: false; readonly problem: string } {
    if (this.#snapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
      return { ok: false, problem: `snapshot ${snapshot.snapshotId} is already on the timeline` };
    }
    if (this.#snapshots.some((entry) => entry.effectiveFromMs === snapshot.effectiveFromMs)) {
      return { ok: false, problem: `another snapshot takes effect at ${snapshot.effectiveFrom}` };
    }
    return { ok: true, value: new RestrictedModeTimeline([...this.#snapshots, snapshot]) };
  }

  /** The latest snapshot whose `effectiveFromMs` is at or before `atMs`. */
  activeAt(atMs: number): RestrictedModeConfiguration | undefined {
    let active: RestrictedModeConfiguration | undefined;
    for (const snapshot of this.#snapshots) {
      if (snapshot.effectiveFromMs <= atMs) active = snapshot;
      else break;
    }
    return active;
  }

  get snapshots(): readonly RestrictedModeConfiguration[] {
    return this.#snapshots;
  }
}
