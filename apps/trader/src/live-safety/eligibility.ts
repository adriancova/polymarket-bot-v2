/**
 * Venue eligibility: the geoblock check and the account's closed-only mode
 * (WP-320 deliverable; handoff §0.2, §6 invariant 18, §9.12; ADR-008 §7).
 *
 * > "Venue eligibility is checked before real trading. A blocked, close-only,
 * > failed, or ambiguous result prevents new live entries." — §6 invariant 18
 *
 * BOTH CHECKS GO THROUGH INJECTED PORTS, and no binding of either exists in
 * this repository: PAPER only, and this package never calls the venue. The
 * facts, all documentary (no round has called either endpoint):
 *
 * - **Geoblock** (`docs/venue/verified-2026-09-30.md` §10.1, W.6;
 *   `verified-2026-09-16.md` §10.1; fixture
 *   `test/fixtures/venue/geoblock/geoblock.json`): `GET
 *   https://polymarket.com/api/geoblock`, "on `polymarket.com`, not the API
 *   servers", answers `{blocked, ip, country, region}` — `blocked` boolean,
 *   `ip` string, `country` "ISO 3166-1 alpha-2", `region` "Region/state code".
 *   "**Block completely** means no new orders and no closing of existing
 *   positions. **Close-only** means users can close existing positions but
 *   cannot open new ones." The endpoint's one boolean does not say WHICH tier
 *   blocked it, and tier membership is a volatile snapshot that "must be
 *   re-read, never hardcoded" (ADR-008 §7): "the live gate uses the
 *   endpoint's `blocked` answer, never a hard-coded jurisdiction list"
 *   (`verified-2026-09-30.md` §10.1, E-08). No country list appears here.
 * - **Account closed-only mode** (`verified-2026-09-16.md` §9, D-24;
 *   `verified-2026-09-30.md` W.6): `GET /auth/ban-status/closed-only`
 *   (authenticated) answers `{"closed_only": false}`; "`closed_only: true`
 *   means the account can only reduce or close existing positions; new
 *   position-opening orders are rejected". D-24 asks `WP-320` to treat it
 *   "exactly like the geographic close-only tier: no new live entries,
 *   reductions allowed".
 *
 * ## The verdict
 *
 * New live entries are permitted only when BOTH checks' LATEST attempts
 * succeeded, were read exactly as documented, say "not blocked" /
 * "not closed-only", and started no longer ago than the configured maximum
 * age. Every other state blocks new entries and names itself: never checked,
 * stale, failed (a port that threw or rejected), ambiguous (any shape but the
 * documented one: a missing or extra field, a non-boolean flag, a country
 * that is not two capital letters), blocked, closed-only. The latest attempt
 * decides: a failure after a success blocks at once.
 *
 * Reductions are NOT blocked here. A close-only result must permit protected
 * reduction and redemption paths (ADR-008 §7); a complete block is enforced
 * by the venue ("Orders submitted from blocked regions will be rejected",
 * `verified-2026-09-16.md` §10.1). Because the endpoint cannot tell the two
 * tiers apart, a blocked answer reports the tier as `UNDETERMINED` for the
 * operator, and collapses neither way.
 */

import type { MonotonicClock } from "./ports.js";

/** The geoblock endpoint, behind a port: answers the response body, parsed from JSON. A throw or rejection is a failure. */
export interface GeoblockPort {
  check(): Promise<unknown>;
}

/** The account's closed-only check (`fetchClosedOnlyMode`), behind a port: answers the response body `{ closed_only }`. */
export interface ClosedOnlyPort {
  read(): Promise<unknown>;
}

export type GeoblockReading =
  | { readonly kind: "ELIGIBLE"; readonly country: string; readonly region: string }
  /** `blocked: true`: a complete block or a close-only tier; the endpoint does not say which. */
  | { readonly kind: "BLOCKED"; readonly tier: "UNDETERMINED"; readonly country: string; readonly region: string }
  | { readonly kind: "AMBIGUOUS"; readonly why: string };

export type ClosedOnlyReading = { readonly kind: "OPEN" } | { readonly kind: "CLOSE_ONLY" } | { readonly kind: "AMBIGUOUS"; readonly why: string };

const GEOBLOCK_FIELDS = ["blocked", "country", "ip", "region"] as const;
const COUNTRY = /^[A-Z]{2}$/u;
const MAX_FIELD_LENGTH = 64;

function printable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Exactly these own data properties of a plain object, or `undefined`. */
function exactFields(body: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(body);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(body);
    if (keys.length !== fields.length) return undefined;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(body, field);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      out[field] = descriptor.value;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Read the geoblock endpoint's body exactly as documented; anything else is AMBIGUOUS. */
export function readGeoblock(body: unknown): GeoblockReading {
  const fields = exactFields(body, GEOBLOCK_FIELDS);
  if (fields === undefined) return Object.freeze({ kind: "AMBIGUOUS" as const, why: "NOT_THE_DOCUMENTED_SHAPE" });
  const { blocked, ip, country, region } = fields;
  if (typeof blocked !== "boolean") return Object.freeze({ kind: "AMBIGUOUS" as const, why: "BLOCKED_NOT_BOOLEAN" });
  if (typeof ip !== "string" || ip.length < 1 || ip.length > MAX_FIELD_LENGTH || !printable(ip)) return Object.freeze({ kind: "AMBIGUOUS" as const, why: "IP_UNREADABLE" });
  if (typeof country !== "string" || !COUNTRY.test(country)) return Object.freeze({ kind: "AMBIGUOUS" as const, why: "COUNTRY_UNREADABLE" });
  if (typeof region !== "string" || region.length > MAX_FIELD_LENGTH || !printable(region)) return Object.freeze({ kind: "AMBIGUOUS" as const, why: "REGION_UNREADABLE" });
  return blocked
    ? Object.freeze({ kind: "BLOCKED" as const, tier: "UNDETERMINED" as const, country, region })
    : Object.freeze({ kind: "ELIGIBLE" as const, country, region });
}

/** Read the closed-only body exactly as documented (`{"closed_only": false}`); anything else is AMBIGUOUS. */
export function readClosedOnly(body: unknown): ClosedOnlyReading {
  const fields = exactFields(body, ["closed_only"]);
  if (fields === undefined) return Object.freeze({ kind: "AMBIGUOUS" as const, why: "NOT_THE_DOCUMENTED_SHAPE" });
  const flag = fields["closed_only"];
  if (flag === false) return Object.freeze({ kind: "OPEN" as const });
  if (flag === true) return Object.freeze({ kind: "CLOSE_ONLY" as const });
  return Object.freeze({ kind: "AMBIGUOUS" as const, why: "CLOSED_ONLY_NOT_BOOLEAN" });
}

type Attempt<R> =
  | { readonly kind: "NEVER" }
  | { readonly kind: "FAILED"; readonly startedAtMs: number }
  | { readonly kind: "READ"; readonly reading: R; readonly startedAtMs: number };

export interface EligibilityVerdict {
  readonly newEntriesPermitted: boolean;
  /** Closed codes: `GEOBLOCK_*` and `ACCOUNT_CLOSED_ONLY_*`. Empty when permitted. */
  readonly reasons: readonly string[];
  /** `UNDETERMINED` when the geoblock answered blocked (complete block or close-only: the endpoint does not say). */
  readonly geoblockTier: "NOT_BLOCKED" | "UNDETERMINED" | "UNKNOWN";
}

export class EligibilityConfigurationError extends Error {
  override readonly name = "EligibilityConfigurationError";
  constructor(readonly field: string) {
    super(`venue eligibility configuration refused: ${field}`);
    Object.freeze(this);
  }
}

/**
 * Runs both checks on demand ({@link VenueEligibility.refresh}), each one at a
 * time, timed from the instant before it started, and keeps the LATEST
 * attempt of each.
 */
export class VenueEligibility {
  readonly #geoblock: GeoblockPort;
  readonly #closedOnly: ClosedOnlyPort;
  readonly #clock: MonotonicClock;
  readonly #maxAgeMs: number;
  #geo: Attempt<GeoblockReading> = Object.freeze({ kind: "NEVER" as const });
  #closed: Attempt<ClosedOnlyReading> = Object.freeze({ kind: "NEVER" as const });
  #inFlight: Promise<void> | null = null;

  constructor(options: { readonly geoblock: GeoblockPort; readonly closedOnly: ClosedOnlyPort; readonly clock: MonotonicClock; readonly maxAgeMs: number }) {
    if (typeof options.geoblock?.check !== "function") throw new EligibilityConfigurationError("geoblock");
    if (typeof options.closedOnly?.read !== "function") throw new EligibilityConfigurationError("closedOnly");
    if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 1) throw new EligibilityConfigurationError("maxAgeMs");
    this.#geoblock = options.geoblock;
    this.#closedOnly = options.closedOnly;
    this.#clock = options.clock;
    this.#maxAgeMs = options.maxAgeMs;
  }

  /** Run both checks now (or join the run in progress). */
  refresh(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    const run = Promise.all([this.#checkGeoblock(), this.#checkClosedOnly()]).then(() => undefined);
    const tracked = run.finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  /** Whether new live entries are permitted NOW, with every reason they are not. */
  verdict(): EligibilityVerdict {
    let now: number | null;
    try {
      const value = this.#clock.monotonicMs();
      now = Number.isFinite(value) ? value : null;
    } catch {
      now = null;
    }
    const reasons: string[] = [];
    const geo = this.#geo;
    let geoblockTier: EligibilityVerdict["geoblockTier"] = "UNKNOWN";
    if (geo.kind === "NEVER") reasons.push("GEOBLOCK_UNCHECKED");
    else if (geo.kind === "FAILED") reasons.push("GEOBLOCK_FAILED");
    else {
      if (geo.reading.kind === "AMBIGUOUS") reasons.push(`GEOBLOCK_AMBIGUOUS_${geo.reading.why}`);
      if (geo.reading.kind === "BLOCKED") {
        reasons.push("GEOBLOCK_BLOCKED");
        geoblockTier = "UNDETERMINED";
      }
      if (geo.reading.kind === "ELIGIBLE") geoblockTier = "NOT_BLOCKED";
      if (now === null || now < geo.startedAtMs || now - geo.startedAtMs > this.#maxAgeMs) reasons.push("GEOBLOCK_STALE");
    }
    const closed = this.#closed;
    if (closed.kind === "NEVER") reasons.push("ACCOUNT_CLOSED_ONLY_UNCHECKED");
    else if (closed.kind === "FAILED") reasons.push("ACCOUNT_CLOSED_ONLY_FAILED");
    else {
      if (closed.reading.kind === "AMBIGUOUS") reasons.push(`ACCOUNT_CLOSED_ONLY_AMBIGUOUS_${closed.reading.why}`);
      if (closed.reading.kind === "CLOSE_ONLY") reasons.push("ACCOUNT_CLOSED_ONLY");
      if (now === null || now < closed.startedAtMs || now - closed.startedAtMs > this.#maxAgeMs) reasons.push("ACCOUNT_CLOSED_ONLY_STALE");
    }
    return Object.freeze({ newEntriesPermitted: reasons.length === 0, reasons: Object.freeze(reasons), geoblockTier });
  }

  #started(): number | null {
    try {
      const value = this.#clock.monotonicMs();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  async #checkGeoblock(): Promise<void> {
    const startedAtMs = this.#started();
    if (startedAtMs === null) {
      this.#geo = Object.freeze({ kind: "FAILED" as const, startedAtMs: Number.NEGATIVE_INFINITY });
      return;
    }
    try {
      const body = await this.#geoblock.check();
      this.#geo = Object.freeze({ kind: "READ" as const, reading: readGeoblock(body), startedAtMs });
    } catch {
      this.#geo = Object.freeze({ kind: "FAILED" as const, startedAtMs });
    }
  }

  async #checkClosedOnly(): Promise<void> {
    const startedAtMs = this.#started();
    if (startedAtMs === null) {
      this.#closed = Object.freeze({ kind: "FAILED" as const, startedAtMs: Number.NEGATIVE_INFINITY });
      return;
    }
    try {
      const body = await this.#closedOnly.read();
      this.#closed = Object.freeze({ kind: "READ" as const, reading: readClosedOnly(body), startedAtMs });
    } catch {
      this.#closed = Object.freeze({ kind: "FAILED" as const, startedAtMs });
    }
  }
}
