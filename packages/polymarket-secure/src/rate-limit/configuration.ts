/**
 * Rate-limit configuration snapshots (WP-310 deliverable 1; handoff §9.13:
 * "Limits are configuration snapshots with source and effective time. Do not
 * hardcode the example values."; ADR-007 §9; verified-2026-09-16.md §8,
 * "they must be stored as configuration with source and effective time,
 * never hardcoded").
 *
 * NOTHING IN THIS MODULE KNOWS A LIMIT. Every venue number (each IP endpoint
 * class's windows, each signer tier's refill rate and burst, whether its
 * cancel bucket may go negative, the relayer window, every operation's token
 * cost) and every scheduling policy number (headroom per priority class, the
 * 429 fallback backoff, the bound on a header-derived wait, the queue bound)
 * arrives in a snapshot document. `no-hardcoded-limits.test.ts` scans this
 * directory's sources and fails on any numeric literal other than 0, 1 and
 * the named unit constants.
 *
 * A snapshot is VALIDATED, never repaired: an unknown field, a missing one,
 * a fractional or non-positive limit, a duplicate id, an operation that names
 * an undeclared class, or an operation whose kind and bucket disagree refuses
 * the whole document with the paths at fault. A refused snapshot never takes
 * effect. So does a figure too large for the budget to keep exact
 * (`units.ts`): a token figure (a window's limit, a rate, a burst, a cost)
 * above `MAX_TOKEN_MAGNITUDE`, or a duration (a window, a backoff, the
 * header-wait bound) above `MAX_DURATION_MS`.
 *
 * A {@link RateLimitConfigurationTimeline} holds several snapshots and
 * answers which one is in effect at an instant: the one with the latest
 * `effectiveFrom` at or before it. A later snapshot therefore takes effect at
 * exactly its effective time, and before the first one nothing is in effect
 * (the budget then refuses every request: fail closed).
 */

import { isIntegerWithin, ownKeys, parseIsoInstant, readList, readOwn } from "./plain-data.js";
import { isOperationKind, PRIORITY_LADDER, type OperationKind, type PriorityClass } from "./priority.js";
import { MAX_DURATION_MS, MAX_TOKEN_MAGNITUDE } from "./units.js";

/** The one schema this module reads. */
export const RATE_LIMIT_CONFIGURATION_SCHEMA = "polymarket-bot/rate-limit-configuration@1" as const;

/** Unit: headroom is given in thousandths of a budget's capacity. */
export const PER_MILLE = 1000;

/** One sliding window: at most `limit` requests in any `windowMs` (venue report §8: "sliding time windows"). */
export interface SlidingWindowLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/** An IP endpoint class (Cloudflare, per IP): one or more windows, e.g. a burst and a sustained limit. */
export interface IpEndpointClassConfig {
  readonly classId: string;
  readonly windows: readonly SlidingWindowLimit[];
}

/** One per-signer volume tier: the order and cancel token buckets (venue report §8, D-21). */
export interface SignerTierConfig {
  readonly tier: string;
  readonly orderTokensPerSecond: number;
  readonly orderBurst: number;
  readonly cancelTokensPerSecond: number;
  readonly cancelBurst: number;
  /** Whether the post-cancel debit of cancel-all / cancel-market-orders may put the cancel bucket into debt (D-21). */
  readonly negativeCancelBalance: boolean;
}

export type SignerBucket = "ORDER" | "CANCEL";

/**
 * An operation's token cost in its signer bucket: `base` per request, plus
 * `perEntry` per batch entry (orders in a batch, ids in a batch cancel), plus
 * `perCanceled` per order the venue reports canceled, debited after the
 * result is known (cancel-all, cancel-market-orders; D-21).
 */
export interface TokenCostRule {
  readonly base: number;
  readonly perEntry: number;
  readonly perCanceled: number;
}

export interface OperationConfig {
  readonly operationId: string;
  readonly kind: OperationKind;
  /** Every IP endpoint class one request of this operation counts against (one request each). */
  readonly ipEndpointClasses: readonly string[];
  /** The per-signer bucket it draws from: `ORDER` for a placement, `CANCEL` for a cancel, `null` otherwise. */
  readonly signerBucket: SignerBucket | null;
  /** `true` exactly for kind `RELAYER`: it also counts against the relayer budget. */
  readonly relayer: boolean;
  /** Present exactly when `signerBucket` is not `null`. */
  readonly tokenCost: TokenCostRule | null;
}

/** A bounded exponential backoff: `initialMs`, multiplied by `multiplier` per consecutive use, capped at `capMs`. */
export interface BackoffPolicy {
  readonly initialMs: number;
  readonly multiplier: number;
  readonly capMs: number;
}

export interface RateLimitPolicy {
  /** The tier a signer's buckets use until `Poly-RateLimit-Tier` names a known one (D-22: read it, never assume it). */
  readonly assumedSignerTier: string;
  /**
   * Per priority class, the thousandths of a budget's capacity the class must
   * leave unused after its own draw: a lower class cannot drain the capacity
   * that a higher class may need next. Non-decreasing down the ladder.
   */
  readonly headroomPermille: Readonly<Record<PriorityClass, number>>;
  /** The backoff on a 429 that carries neither `Retry-After` nor a usable `Poly-RateLimit-Reset`. */
  readonly rateLimitedFallback: BackoffPolicy;
  /** The longest wait a `Poly-RateLimit-Reset` value may impose; a later one is capped and flagged. */
  readonly maxHeaderWaitMs: number;
  /** The most requests the budget queues at once. */
  readonly maxQueuedRequests: number;
}

export interface SourceDocument {
  readonly url: string;
  readonly retrievedAt: string;
}

/** Where the snapshot's numbers come from. */
export interface ConfigurationSource {
  /** The official documents the venue numbers were read from (handoff §1.2). */
  readonly documents: readonly SourceDocument[];
  /** The dated verification report that recorded them (e.g. `docs/venue/verified-2026-09-30.md §8`). */
  readonly report: string;
  /** Who set the policy numbers. */
  readonly policyAuthority: string;
}

export interface RateLimitConfiguration {
  readonly schema: typeof RATE_LIMIT_CONFIGURATION_SCHEMA;
  readonly snapshotId: string;
  /** ISO-8601 UTC, as written. */
  readonly effectiveFrom: string;
  /** `effectiveFrom` as epoch milliseconds. */
  readonly effectiveFromMs: number;
  readonly source: ConfigurationSource;
  readonly ipEndpointClasses: readonly IpEndpointClassConfig[];
  readonly relayer: { readonly windows: readonly SlidingWindowLimit[] };
  readonly signerTiers: readonly SignerTierConfig[];
  readonly operations: readonly OperationConfig[];
  readonly policy: RateLimitPolicy;
}

export type ConfigurationResult =
  | { readonly ok: true; readonly value: RateLimitConfiguration }
  | { readonly ok: false; readonly problems: readonly string[] };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/u;
// eslint-disable-next-line no-control-regex
const TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/u;

/** A reader that records every problem with its path, and keeps reading. */
class Reader {
  readonly problems: string[] = [];

  fail(path: string, message: string): undefined {
    this.problems.push(`${path}: ${message}`);
    return undefined;
  }

  /** The object's own fields, checked against exactly `required` (+ `optional`). */
  object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): ((key: string) => unknown) | undefined {
    const keys = ownKeys(value);
    if (keys === undefined) return this.fail(path, "must be a plain object of own data fields");
    for (const key of keys) {
      if (!required.includes(key) && !optional.includes(key)) this.fail(`${path}.${key}`, "is not a field of this schema");
    }
    for (const key of required) {
      if (!keys.includes(key)) this.fail(`${path}.${key}`, "is required");
    }
    return (key: string): unknown => {
      const read = readOwn(value, key);
      if (read.kind === "OPAQUE") {
        this.fail(`${path}.${key}`, "is not an own data field");
        return undefined;
      }
      return read.kind === "DATA" ? read.value : undefined;
    };
  }

  list(value: unknown, path: string, nonEmpty: boolean): readonly unknown[] | undefined {
    const list = readList(value);
    if (list === undefined) return this.fail(path, "must be an array of own data entries");
    if (nonEmpty && list.length === 0) return this.fail(path, "must not be empty");
    return list;
  }

  identifier(value: unknown, path: string): string | undefined {
    return typeof value === "string" && IDENTIFIER.test(value) ? value : this.fail(path, "must be an identifier");
  }

  text(value: unknown, path: string): string | undefined {
    return typeof value === "string" && TEXT.test(value) ? value : this.fail(path, "must be non-empty text without control characters");
  }

  /** An integer in `[minimum, maximum]`; `maximum` defaults to `Number.MAX_SAFE_INTEGER` (no bound but safety). */
  integer(value: unknown, path: string, minimum: number, maximum: number = Number.MAX_SAFE_INTEGER): number | undefined {
    return isIntegerWithin(value, minimum, maximum) ? value : this.fail(path, `must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }

  /** A token figure: kept exactly in thousandths of a token by the budget. */
  tokens(value: unknown, path: string, minimum: number): number | undefined {
    return this.integer(value, path, minimum, MAX_TOKEN_MAGNITUDE);
  }

  /** A duration in milliseconds: added to instants by the budget. */
  duration(value: unknown, path: string): number | undefined {
    return this.integer(value, path, 1, MAX_DURATION_MS);
  }

  boolean(value: unknown, path: string): boolean | undefined {
    return typeof value === "boolean" ? value : this.fail(path, "must be a boolean");
  }

  instant(value: unknown, path: string): number | undefined {
    const ms = parseIsoInstant(value);
    return ms === undefined ? this.fail(path, "must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS[.sss]Z)") : ms;
  }
}

function readWindows(r: Reader, value: unknown, path: string): SlidingWindowLimit[] | undefined {
  const list = r.list(value, path, true);
  if (list === undefined) return undefined;
  const out: SlidingWindowLimit[] = [];
  list.forEach((entry, index) => {
    const at = `${path}[${String(index)}]`;
    const get = r.object(entry, at, ["limit", "windowMs"]);
    if (get === undefined) return;
    const limit = r.tokens(get("limit"), `${at}.limit`, 1);
    const windowMs = r.duration(get("windowMs"), `${at}.windowMs`);
    if (limit !== undefined && windowMs !== undefined) out.push(Object.freeze({ limit, windowMs }));
  });
  return out;
}

function readBackoff(r: Reader, value: unknown, path: string): BackoffPolicy | undefined {
  const get = r.object(value, path, ["initialMs", "multiplier", "capMs"]);
  if (get === undefined) return undefined;
  const initialMs = r.duration(get("initialMs"), `${path}.initialMs`);
  const multiplier = r.integer(get("multiplier"), `${path}.multiplier`, 1);
  const capMs = r.duration(get("capMs"), `${path}.capMs`);
  if (initialMs === undefined || multiplier === undefined || capMs === undefined) return undefined;
  // "increase it after each failed attempt" (verified-2026-09-16.md §9): a backoff that grows.
  if (multiplier === 1) return r.fail(`${path}.multiplier`, "must exceed 1");
  if (capMs < initialMs) return r.fail(`${path}.capMs`, "must be at least initialMs");
  return Object.freeze({ initialMs, multiplier, capMs });
}

function unique(r: Reader, ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) r.fail(path, `duplicate id ${id} (ids are compared case-insensitively)`);
    seen.add(key);
  }
}

/**
 * Validate one snapshot document. Never throws; a refusal lists every
 * problem with its path. The result is deeply frozen.
 */
export function parseRateLimitConfiguration(raw: unknown): ConfigurationResult {
  try {
    return parseUncontained(raw);
  } catch {
    return Object.freeze({ ok: false as const, problems: Object.freeze(["$: unreadable"]) });
  }
}

function parseUncontained(raw: unknown): ConfigurationResult {
  const r = new Reader();
  const get = r.object(raw, "$", [
    "schema",
    "snapshotId",
    "effectiveFrom",
    "source",
    "ipEndpointClasses",
    "relayer",
    "signerTiers",
    "operations",
    "policy",
  ]);
  if (get === undefined) return Object.freeze({ ok: false as const, problems: Object.freeze([...r.problems]) });

  if (get("schema") !== RATE_LIMIT_CONFIGURATION_SCHEMA) r.fail("$.schema", `must be ${RATE_LIMIT_CONFIGURATION_SCHEMA}`);
  const snapshotId = r.identifier(get("snapshotId"), "$.snapshotId");
  const effectiveFromRaw = get("effectiveFrom");
  const effectiveFromMs = r.instant(effectiveFromRaw, "$.effectiveFrom");

  // Source.
  let source: ConfigurationSource | undefined;
  const getSource = r.object(get("source"), "$.source", ["documents", "report", "policyAuthority"]);
  if (getSource !== undefined) {
    const documents: SourceDocument[] = [];
    const list = r.list(getSource("documents"), "$.source.documents", true);
    list?.forEach((entry, index) => {
      const at = `$.source.documents[${String(index)}]`;
      const getDoc = r.object(entry, at, ["url", "retrievedAt"]);
      if (getDoc === undefined) return;
      const url = getDoc("url");
      const retrievedAt = getDoc("retrievedAt");
      if (typeof url !== "string" || !HTTPS_URL.test(url)) r.fail(`${at}.url`, "must be an https URL");
      const retrievedMs = r.instant(retrievedAt, `${at}.retrievedAt`);
      if (typeof url === "string" && HTTPS_URL.test(url) && retrievedMs !== undefined) {
        documents.push(Object.freeze({ url, retrievedAt: retrievedAt as string }));
      }
    });
    const report = r.text(getSource("report"), "$.source.report");
    const policyAuthority = r.text(getSource("policyAuthority"), "$.source.policyAuthority");
    if (report !== undefined && policyAuthority !== undefined) {
      source = Object.freeze({ documents: Object.freeze(documents), report, policyAuthority });
    }
  }

  // IP endpoint classes.
  const ipEndpointClasses: IpEndpointClassConfig[] = [];
  r.list(get("ipEndpointClasses"), "$.ipEndpointClasses", true)?.forEach((entry, index) => {
    const at = `$.ipEndpointClasses[${String(index)}]`;
    const getClass = r.object(entry, at, ["classId", "windows"]);
    if (getClass === undefined) return;
    const classId = r.identifier(getClass("classId"), `${at}.classId`);
    const windows = readWindows(r, getClass("windows"), `${at}.windows`);
    if (classId !== undefined && windows !== undefined) ipEndpointClasses.push(Object.freeze({ classId, windows: Object.freeze(windows) }));
  });
  unique(r, ipEndpointClasses.map((entry) => entry.classId), "$.ipEndpointClasses");

  // Relayer.
  let relayer: { readonly windows: readonly SlidingWindowLimit[] } | undefined;
  const getRelayer = r.object(get("relayer"), "$.relayer", ["windows"]);
  if (getRelayer !== undefined) {
    const windows = readWindows(r, getRelayer("windows"), "$.relayer.windows");
    if (windows !== undefined) relayer = Object.freeze({ windows: Object.freeze(windows) });
  }

  // Signer tiers.
  const signerTiers: SignerTierConfig[] = [];
  r.list(get("signerTiers"), "$.signerTiers", true)?.forEach((entry, index) => {
    const at = `$.signerTiers[${String(index)}]`;
    const getTier = r.object(entry, at, [
      "tier",
      "orderTokensPerSecond",
      "orderBurst",
      "cancelTokensPerSecond",
      "cancelBurst",
      "negativeCancelBalance",
    ]);
    if (getTier === undefined) return;
    const tier = r.identifier(getTier("tier"), `${at}.tier`);
    const orderTokensPerSecond = r.tokens(getTier("orderTokensPerSecond"), `${at}.orderTokensPerSecond`, 1);
    const orderBurst = r.tokens(getTier("orderBurst"), `${at}.orderBurst`, 1);
    const cancelTokensPerSecond = r.tokens(getTier("cancelTokensPerSecond"), `${at}.cancelTokensPerSecond`, 1);
    const cancelBurst = r.tokens(getTier("cancelBurst"), `${at}.cancelBurst`, 1);
    const negativeCancelBalance = r.boolean(getTier("negativeCancelBalance"), `${at}.negativeCancelBalance`);
    if (
      tier !== undefined &&
      orderTokensPerSecond !== undefined &&
      orderBurst !== undefined &&
      cancelTokensPerSecond !== undefined &&
      cancelBurst !== undefined &&
      negativeCancelBalance !== undefined
    ) {
      signerTiers.push(Object.freeze({ tier, orderTokensPerSecond, orderBurst, cancelTokensPerSecond, cancelBurst, negativeCancelBalance }));
    }
  });
  unique(r, signerTiers.map((entry) => entry.tier), "$.signerTiers");

  // Operations.
  const classIds = new Set(ipEndpointClasses.map((entry) => entry.classId));
  const operations: OperationConfig[] = [];
  r.list(get("operations"), "$.operations", true)?.forEach((entry, index) => {
    const at = `$.operations[${String(index)}]`;
    const getOp = r.object(entry, at, ["operationId", "kind", "ipEndpointClasses", "signerBucket", "relayer", "tokenCost"]);
    if (getOp === undefined) return;
    const operationId = r.identifier(getOp("operationId"), `${at}.operationId`);
    const kindRaw = getOp("kind");
    const kind = isOperationKind(kindRaw) ? kindRaw : r.fail(`${at}.kind`, "must be HEARTBEAT, CANCEL, READ, PLACEMENT or RELAYER");
    const classes: string[] = [];
    r.list(getOp("ipEndpointClasses"), `${at}.ipEndpointClasses`, true)?.forEach((id, classIndex) => {
      const path = `${at}.ipEndpointClasses[${String(classIndex)}]`;
      if (typeof id !== "string" || !classIds.has(id)) r.fail(path, "must name a declared IP endpoint class");
      else if (classes.includes(id)) r.fail(path, "is listed twice");
      else classes.push(id);
    });
    const bucketRaw = getOp("signerBucket");
    const signerBucket: SignerBucket | null | undefined =
      bucketRaw === null || bucketRaw === "ORDER" || bucketRaw === "CANCEL" ? bucketRaw : r.fail(`${at}.signerBucket`, "must be ORDER, CANCEL or null");
    const relayerFlag = r.boolean(getOp("relayer"), `${at}.relayer`);
    // The kind, the bucket and the relayer flag must agree: each signer has an order
    // bucket and a cancel bucket (venue report §8), placements draw on the first and
    // cancels on the second, and nothing else draws on either.
    if (kind !== undefined && signerBucket !== undefined) {
      const expected: SignerBucket | null = kind === "PLACEMENT" ? "ORDER" : kind === "CANCEL" ? "CANCEL" : null;
      if (signerBucket !== expected) r.fail(`${at}.signerBucket`, `must be ${String(expected)} for kind ${kind}`);
    }
    if (kind !== undefined && relayerFlag !== undefined && relayerFlag !== (kind === "RELAYER")) {
      r.fail(`${at}.relayer`, "must be true exactly for kind RELAYER");
    }
    let tokenCost: TokenCostRule | null | undefined;
    const costRaw = getOp("tokenCost");
    if (signerBucket === null) {
      tokenCost = costRaw === null ? null : r.fail(`${at}.tokenCost`, "must be null when there is no signer bucket");
    } else if (signerBucket !== undefined) {
      const getCost = r.object(costRaw, `${at}.tokenCost`, ["base", "perEntry", "perCanceled"]);
      if (getCost !== undefined) {
        const base = r.tokens(getCost("base"), `${at}.tokenCost.base`, 0);
        const perEntry = r.tokens(getCost("perEntry"), `${at}.tokenCost.perEntry`, 0);
        const perCanceled = r.tokens(getCost("perCanceled"), `${at}.tokenCost.perCanceled`, 0);
        if (base !== undefined && perEntry !== undefined && perCanceled !== undefined) {
          // Every request costs at least one token before any post-hoc debit.
          if (base + perEntry < 1) r.fail(`${at}.tokenCost`, "base + perEntry must be at least 1");
          else tokenCost = Object.freeze({ base, perEntry, perCanceled });
        }
      }
    }
    if (
      operationId !== undefined &&
      kind !== undefined &&
      signerBucket !== undefined &&
      relayerFlag !== undefined &&
      tokenCost !== undefined
    ) {
      operations.push(
        Object.freeze({ operationId, kind, ipEndpointClasses: Object.freeze(classes), signerBucket, relayer: relayerFlag, tokenCost }),
      );
    }
  });
  unique(r, operations.map((entry) => entry.operationId), "$.operations");

  // Policy.
  let policy: RateLimitPolicy | undefined;
  const getPolicy = r.object(get("policy"), "$.policy", [
    "assumedSignerTier",
    "headroomPermille",
    "rateLimitedFallback",
    "maxHeaderWaitMs",
    "maxQueuedRequests",
  ]);
  if (getPolicy !== undefined) {
    const assumedSignerTier = r.identifier(getPolicy("assumedSignerTier"), "$.policy.assumedSignerTier");
    if (assumedSignerTier !== undefined && !signerTiers.some((tier) => tier.tier === assumedSignerTier)) {
      r.fail("$.policy.assumedSignerTier", "must name a declared signer tier");
    }
    const headroom: Partial<Record<PriorityClass, number>> = {};
    const getHeadroom = r.object(getPolicy("headroomPermille"), "$.policy.headroomPermille", PRIORITY_LADDER);
    if (getHeadroom !== undefined) {
      let previous = 0;
      for (const priority of PRIORITY_LADDER) {
        const path = `$.policy.headroomPermille.${priority}`;
        const value = r.integer(getHeadroom(priority), path, 0);
        if (value === undefined) continue;
        if (value >= PER_MILLE) r.fail(path, `must be below ${String(PER_MILLE)}`);
        // A higher class may always dig at least as deep as a lower one.
        if (value < previous) r.fail(path, "must not be below the headroom of a class above it on the ladder");
        previous = value;
        headroom[priority] = value;
      }
    }
    const rateLimitedFallback = readBackoff(r, getPolicy("rateLimitedFallback"), "$.policy.rateLimitedFallback");
    const maxHeaderWaitMs = r.duration(getPolicy("maxHeaderWaitMs"), "$.policy.maxHeaderWaitMs");
    const maxQueuedRequests = r.integer(getPolicy("maxQueuedRequests"), "$.policy.maxQueuedRequests", 1);
    if (
      assumedSignerTier !== undefined &&
      Object.keys(headroom).length === PRIORITY_LADDER.length &&
      rateLimitedFallback !== undefined &&
      maxHeaderWaitMs !== undefined &&
      maxQueuedRequests !== undefined
    ) {
      policy = Object.freeze({
        assumedSignerTier,
        headroomPermille: Object.freeze(headroom as Record<PriorityClass, number>),
        rateLimitedFallback,
        maxHeaderWaitMs,
        maxQueuedRequests,
      });
    }
  }

  // A request's own cost plus its class's headroom must fit each budget it
  // draws on, or it could never be admitted; that is checked per request
  // (`budget.ts`). Here: a class's headroom must leave room for one request.
  if (policy !== undefined) {
    const worst = policy.headroomPermille.METADATA_ANALYTICS;
    for (const entry of ipEndpointClasses) {
      for (const window of entry.windows) {
        if (Math.floor((window.limit * worst) / PER_MILLE) + 1 > window.limit) {
          r.fail(`$.ipEndpointClasses.${entry.classId}`, "a window is too small to admit one request under the largest headroom");
        }
      }
    }
  }

  if (
    r.problems.length > 0 ||
    snapshotId === undefined ||
    effectiveFromMs === undefined ||
    source === undefined ||
    relayer === undefined ||
    policy === undefined
  ) {
    if (r.problems.length === 0) r.fail("$", "is incomplete");
    return Object.freeze({ ok: false as const, problems: Object.freeze([...r.problems]) });
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      schema: RATE_LIMIT_CONFIGURATION_SCHEMA,
      snapshotId,
      effectiveFrom: effectiveFromRaw as string,
      effectiveFromMs,
      source,
      ipEndpointClasses: Object.freeze(ipEndpointClasses),
      relayer,
      signerTiers: Object.freeze(signerTiers),
      operations: Object.freeze(operations),
      policy,
    }),
  });
}

/**
 * The snapshots in effect over time. Immutable; {@link with} returns a new
 * timeline. Effective times are distinct, and so are snapshot ids.
 */
export class RateLimitConfigurationTimeline {
  readonly #snapshots: readonly RateLimitConfiguration[];

  private constructor(snapshots: readonly RateLimitConfiguration[]) {
    this.#snapshots = Object.freeze([...snapshots].sort((a, b) => a.effectiveFromMs - b.effectiveFromMs));
    Object.freeze(this);
  }

  static empty(): RateLimitConfigurationTimeline {
    return new RateLimitConfigurationTimeline([]);
  }

  /** A timeline with `snapshot` added, or the reason it cannot be. */
  with(snapshot: RateLimitConfiguration): { readonly ok: true; readonly value: RateLimitConfigurationTimeline } | { readonly ok: false; readonly problem: string } {
    if (this.#snapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
      return { ok: false, problem: `snapshot ${snapshot.snapshotId} is already on the timeline` };
    }
    if (this.#snapshots.some((entry) => entry.effectiveFromMs === snapshot.effectiveFromMs)) {
      return { ok: false, problem: `another snapshot takes effect at ${snapshot.effectiveFrom}` };
    }
    return { ok: true, value: new RateLimitConfigurationTimeline([...this.#snapshots, snapshot]) };
  }

  /** The snapshot in effect at `atMs`: the latest whose `effectiveFromMs` is at or before it. */
  activeAt(atMs: number): RateLimitConfiguration | undefined {
    let active: RateLimitConfiguration | undefined;
    for (const snapshot of this.#snapshots) {
      if (snapshot.effectiveFromMs <= atMs) active = snapshot;
      else break;
    }
    return active;
  }

  /** The first effective time strictly after `atMs`, if any. */
  nextChangeAfter(atMs: number): number | undefined {
    return this.#snapshots.find((snapshot) => snapshot.effectiveFromMs > atMs)?.effectiveFromMs;
  }

  get snapshots(): readonly RateLimitConfiguration[] {
    return this.#snapshots;
  }
}
