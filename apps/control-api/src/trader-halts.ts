/**
 * `CONTROL-2` — open TRADER HALTS, read from `ops.incidents` (closing
 * `H1R1-HALT-INVISIBLE`).
 *
 * ## The gap this closes
 *
 * A trader halt is a latch in the trader's own process: every halt stops the
 * pump and the process exits 75. H1's trader exited between two Prometheus
 * scrapes, so its halt reached no metric, no dashboard and no page. Since
 * `PROVENANCE-1` every halt whose record lands leaves OPEN `TRADER_HALT:<scope>`
 * rows in `ops.incidents` (`apps/trader/src/halt-record.ts`) that outlive the
 * process. This module reads them, so `GET /v1/health` and `GET /v1/metrics`
 * can say that a trader halted after the trader has gone.
 *
 * ## Which rows, and what "open" means
 *
 * - **Open** is `status <> 'RESOLVED'`: the predicate of the table's own partial
 *   index `incidents_open_idx` (`db/migrations/0007_ops.up.sql`). `OPEN` and
 *   `MITIGATING` both count. Only an operator's resolution — `RESOLVED`, which
 *   the table's checks tie to a `resolved_at` and a `resolution` — removes a
 *   row. This process never resolves one: it is READ-ONLY toward the trader and
 *   toward `ops.incidents` (the read runs in a `READ ONLY` transaction), and
 *   closing an incident is not its job.
 * - **The trader's rows** are every row whose `incident_key`, upper-cased,
 *   begins `TRADER_HALT:` — in every environment and for every account. The
 *   three keys the trader writes ({@link TRADER_HALT_INCIDENT_KEYS}) are counted
 *   by scope. Any OTHER key in that namespace (`TRADER_HALT:SOMETHING_NEW`, a
 *   different case) counts under the scope `UNRECOGNIZED` rather than being
 *   dropped: an open row in the trader's namespace is a halt until an operator
 *   says otherwise.
 *
 * ## Fail closed: four states, and NONE_OPEN only from a read that succeeded
 *
 * | State | When |
 * | --- | --- |
 * | `OPEN` | the most recent read passed the door and counted at least one open row |
 * | `NONE_OPEN` | the most recent read passed the door and counted none |
 * | `UNKNOWN` | no read yet; or the most recent read failed, timed out, or was refused by the door |
 * | `NOT_CONFIGURED` | this composition reads no `ops.incidents` ({@link AbsentTraderHaltSource}) |
 *
 * NOTHING IS RETAINED ACROSS A FAILED READ. A count from an earlier read is not
 * this read's count, and a retained zero would say "no halts" at exactly the
 * moment the table could not be read. So an unreadable table, a slow query, a
 * result the door refuses and a source that throws are each `UNKNOWN`, and the
 * open-halt counts are ABSENT until a read succeeds again. `NOT_CONFIGURED` is
 * not `NONE_OPEN` either: it says this process cannot see the rows.
 *
 * `NONE_OPEN` is "no open row", not "no halt": a halt whose record could not
 * land — the trader logged `HALT RECORD NOT DURABLE` or `HALT RECORD
 * UNCONFIRMED` (`PROV1-UNRECORDED-HALT`) — has no row to read. The health
 * answer says so.
 *
 * ## The door, and why the CACHE runs it
 *
 * What a source fetches is INPUT (ADR-020 §4): rows another process wrote,
 * through a driver this module does not control. A source only FETCHES
 * ({@link TraderHaltSource}); {@link TraderHaltCache} passes every fetch through
 * {@link readTraderHaltFetch} — the D1-D4 door (`doors.ts`) and then the
 * consistency checks below — so no source, however written, can hand this API
 * a result the door did not judge. (`health-source.ts` states that rule as a
 * contract on its sources; here it is structural.)
 *
 * The door refuses — and the state is `UNKNOWN` — when the fetch:
 *
 * - is not plain data, or fails its schema (an extra or missing column, a
 *   number where text belongs, a count that is not a decimal integer, more
 *   rows than {@link TRADER_HALT_LIST_LIMIT});
 * - names more scoped rows than its total;
 * - lists a number of rows other than the lesser of its total and the list
 *   limit (the two statements saw different data);
 * - lists more rows of a scope than that scope's count;
 * - lists a `RESOLVED` row, or a row outside the `TRADER_HALT:` namespace.
 *
 * ## Irregular rows are counted, never dropped
 *
 * A listed row whose columns are not the shape `halt-record.ts` writes — a
 * `MARKET` row with no market, a `STRATEGY_INSTANCE` row with no instance, a
 * `GLOBAL` row naming a market, a severity other than `PAGE`, an environment
 * other than `PAPER`, an unrecognized key — is still an open halt. It is counted
 * by its key and listed with its `irregularities` named.
 *
 * ## Text from the table is escaped for display
 *
 * Every string a listed row carries passes through `audit-text.ts`'s
 * `escapeAuditText` (injective and reversible): a `U+202E` or an `ESC` in a
 * halt's detail reaches an operator as a visible `\u{HEX}`, never raw.
 *
 * ## The metric families are the platform table's (`CONTROL-2` r1)
 *
 * `control_trader_halts_state`, `control_trader_halts_open` and
 * `control_trader_halt_reads_total` are `PLATFORM_METRIC_FAMILIES` entries
 * (`@polymarket-bot/observability`, category `halts`), so the PAGE rule
 * `TraderHaltOpenOrUnknown` (`infra/prometheus/trader-alerts.yaml`) and the
 * operations dashboard's "Open trader halts (ops.incidents)" panel are pinned
 * to them by that package's `trader-alerts.test.ts` and `dashboards.test.ts`.
 * {@link traderHaltSamples} is their only producer, and `trader-halts.test.ts`
 * pins that it emits exactly those three families with the labels the table
 * declares. (Round 0 declared them here, because `packages/**` was outside
 * the grant; the orchestrator granted the move on 2026-10-04.)
 */

import { z } from "zod";
import type { PlatformMetricSample } from "@polymarket-bot/observability";

import { escapeAuditText } from "./audit-text.js";
import { buildDoor } from "./doors.js";

/** The namespace every trader halt row's `incident_key` begins with (matched upper-cased). */
export const TRADER_HALT_INCIDENT_KEY_PREFIX = "TRADER_HALT:" as const;

/**
 * The three keys the trader writes — `apps/trader/src/halt-record.ts`'s
 * `HALT_INCIDENT_KEYS`, mirrored because `docs/contracts/dependency-direction.md`
 * F10 forbids importing an app. `test/integration/control-api/trader-halt-shape.test.ts`
 * imports the trader's own constant and pins the two equal, and drives the
 * trader's REAL row builder through this module's door.
 */
export const TRADER_HALT_INCIDENT_KEYS = Object.freeze({
  GLOBAL: "TRADER_HALT:GLOBAL",
  MARKET: "TRADER_HALT:MARKET",
  STRATEGY_INSTANCE: "TRADER_HALT:STRATEGY_INSTANCE",
} as const);

/** The scopes an open halt is counted under. `UNRECOGNIZED` is every other key in the namespace. */
export const TRADER_HALT_SCOPES = ["GLOBAL", "MARKET", "STRATEGY_INSTANCE", "UNRECOGNIZED"] as const;
export type TraderHaltScope = (typeof TRADER_HALT_SCOPES)[number];

/** The four states (module header). */
export const TRADER_HALT_STATES = ["OPEN", "NONE_OPEN", "UNKNOWN", "NOT_CONFIGURED"] as const;
export type TraderHaltState = (typeof TRADER_HALT_STATES)[number];

/** How a read ended, for `control_trader_halt_reads_total`. */
export const TRADER_HALT_READ_OUTCOMES = ["OK", "REFUSED", "UNAVAILABLE"] as const;
export type TraderHaltReadOutcome = (typeof TRADER_HALT_READ_OUTCOMES)[number];

/**
 * How many open rows one read LISTS, newest first. The COUNTS are exact
 * whatever the number of rows; a read with more open rows than this lists the
 * newest and says `truncated`.
 */
export const TRADER_HALT_LIST_LIMIT = 50;

/**
 * The longest a source's failure detail is carried (UTF-16 code units, before
 * escaping). A driver error is caller-adjacent text of unbounded length.
 */
export const TRADER_HALT_DETAIL_MAX = 500;

// --- the door ----------------------------------------------------------------

/** A row count as PostgreSQL renders `count(*)::text`: a canonical decimal integer, at most 15 digits (a safe integer). */
const CountText = z.string().regex(/^(?:0|[1-9][0-9]{0,14})$/u);

const text = (max: number) => z.string().min(1).max(max);
const nullable = <S extends z.ZodType>(schema: S) => z.union([schema, z.literal(null)]);

/** The one row of the counting statement (`adapters/postgres-trader-halts.ts`). */
const CountsRow = z.strictObject({
  total: CountText,
  global: CountText,
  market: CountText,
  strategy_instance: CountText,
});

/**
 * One listed row, in the table's own column names. Bounds follow the column
 * domains (`internal.code` 64, `internal.identifier` 200 and `internal.detail`
 * 2000 code points — twice that in UTF-16 units); a text that does not fit was
 * not written by this schema and is refused.
 */
const IncidentRow = z.strictObject({
  incident_id: text(64),
  incident_key: text(64),
  environment: text(32),
  account_ref: nullable(text(400)),
  severity: text(16),
  status: text(16),
  failure_class: text(64),
  action: nullable(text(64)),
  market_id: nullable(text(64)),
  instance_id: nullable(text(64)),
  detail: z.string().max(4000),
  opened_at: text(64),
});

const TraderHaltFetchSchema = z.strictObject({
  counts: z.array(CountsRow).length(1),
  rows: z.array(IncidentRow).max(TRADER_HALT_LIST_LIMIT),
});

type FetchedCounts = z.output<typeof CountsRow>;
type FetchedRow = z.output<typeof IncidentRow>;
interface FetchedHalts {
  readonly counts: readonly FetchedCounts[];
  readonly rows: readonly FetchedRow[];
}

/**
 * D3: the value is the MATERIALIZED tree (`doors.ts`); the schema only judged
 * it. The tree is prototype-free and structurally correct, so this cast is the
 * D3 step, not a shortcut around it.
 */
const TraderHaltFetchDoor = buildDoor(
  TraderHaltFetchSchema,
  "ops.incidents trader halt read",
  (materialized): FetchedHalts => materialized as FetchedHalts,
);

/** One open trader halt row, as the health answer lists it. Every string is display-escaped. */
export interface OpenTraderHaltRow {
  readonly incidentId: string;
  readonly incidentKey: string;
  readonly scope: TraderHaltScope;
  readonly status: string;
  readonly severity: string;
  readonly environment: string;
  readonly accountRef: string | null;
  readonly failureClass: string;
  readonly action: string | null;
  readonly marketId: string | null;
  readonly instanceId: string | null;
  readonly detail: string;
  readonly openedAt: string;
  /** How the row differs from the shape `halt-record.ts` writes; empty for a regular row. */
  readonly irregularities: readonly string[];
}

/** What one successful read found. */
export interface OpenTraderHalts {
  /** Every open row in the namespace. Exact. */
  readonly total: number;
  /** {@link total} by scope; every scope present, zero included. Exact. */
  readonly byScope: Readonly<Record<TraderHaltScope, number>>;
  /** The newest open rows, at most {@link TRADER_HALT_LIST_LIMIT}. */
  readonly listed: readonly OpenTraderHaltRow[];
  /** `true` when {@link total} is more than the rows listed. */
  readonly truncated: boolean;
  /** How many LISTED rows carry an irregularity. */
  readonly irregular: number;
}

export type TraderHaltReadResult =
  | { readonly ok: true; readonly halts: OpenTraderHalts }
  | { readonly ok: false; readonly detail: string; readonly issues: readonly string[] };

/** The scope a key counts under: one of the trader's three keys exactly, else `UNRECOGNIZED`. */
export function traderHaltScopeOf(incidentKey: string): TraderHaltScope {
  switch (incidentKey) {
    case TRADER_HALT_INCIDENT_KEYS.GLOBAL:
      return "GLOBAL";
    case TRADER_HALT_INCIDENT_KEYS.MARKET:
      return "MARKET";
    case TRADER_HALT_INCIDENT_KEYS.STRATEGY_INSTANCE:
      return "STRATEGY_INSTANCE";
    default:
      return "UNRECOGNIZED";
  }
}

/** Whether `incidentKey` is in the trader halt namespace — the same test the read's `WHERE` applies. */
export function inTraderHaltNamespace(incidentKey: string): boolean {
  return incidentKey.toUpperCase().startsWith(TRADER_HALT_INCIDENT_KEY_PREFIX);
}

/** How a row differs from the shape `apps/trader/src/halt-record.ts` writes (module header). */
function irregularitiesOf(row: FetchedRow, scope: TraderHaltScope): readonly string[] {
  const found: string[] = [];
  switch (scope) {
    case "MARKET":
      if (row.market_id === null) found.push("a MARKET halt row names no market_id");
      if (row.instance_id !== null) found.push("a MARKET halt row names an instance_id");
      break;
    case "STRATEGY_INSTANCE":
      if (row.instance_id === null) found.push("a STRATEGY_INSTANCE halt row names no instance_id");
      if (row.market_id !== null) found.push("a STRATEGY_INSTANCE halt row names a market_id");
      break;
    case "GLOBAL":
      if (row.market_id !== null) found.push("a GLOBAL halt row names a market_id");
      break;
    case "UNRECOGNIZED":
      found.push(
        `incident_key ${escapeAuditText(row.incident_key)} is in the TRADER_HALT: namespace but is not one of the ` +
          "trader's three scope keys; it is counted as an open halt of scope UNRECOGNIZED",
      );
      break;
  }
  if (row.severity !== "PAGE") found.push(`severity ${escapeAuditText(row.severity)}, where every trader halt row is PAGE`);
  if (row.environment !== "PAPER") {
    found.push(`environment ${escapeAuditText(row.environment)}, where the trader runs PAPER only`);
  }
  return Object.freeze(found);
}

function shown(value: string): string;
function shown(value: string | null): string | null;
function shown(value: string | null): string | null {
  return value === null ? null : escapeAuditText(value);
}

function refused(detail: string, issues: readonly string[] = []): TraderHaltReadResult {
  return { ok: false, detail, issues: Object.freeze([...issues]) };
}

/**
 * Reads one fetch through the door, then checks it is self-consistent and
 * classifies it (module header). TOTAL: never throws.
 */
export function readTraderHaltFetch(input: unknown): TraderHaltReadResult {
  try {
    const door = TraderHaltFetchDoor(input);
    if (!door.ok) return refused(door.refusal.detail, door.refusal.issues);
    const fetched = door.value;

    const countRow = fetched.counts[0];
    if (countRow === undefined) return refused("the counting statement returned no row");
    const total = Number(countRow.total);
    const named = {
      GLOBAL: Number(countRow.global),
      MARKET: Number(countRow.market),
      STRATEGY_INSTANCE: Number(countRow.strategy_instance),
    };
    const namedTotal = named.GLOBAL + named.MARKET + named.STRATEGY_INSTANCE;
    if (namedTotal > total) {
      return refused(
        `the read counted ${String(namedTotal)} scoped rows but only ${String(total)} rows in all; a read that ` +
          "contradicts itself is not a count this process will report",
      );
    }
    const byScope: Record<TraderHaltScope, number> = Object.assign(Object.create(null) as object, {
      GLOBAL: named.GLOBAL,
      MARKET: named.MARKET,
      STRATEGY_INSTANCE: named.STRATEGY_INSTANCE,
      UNRECOGNIZED: total - namedTotal,
    }) as Record<TraderHaltScope, number>;

    const expectedListed = Math.min(total, TRADER_HALT_LIST_LIMIT);
    if (fetched.rows.length !== expectedListed) {
      return refused(
        `the read listed ${String(fetched.rows.length)} rows where its own count says ${String(expectedListed)}; ` +
          "the count and the list did not see the same rows",
      );
    }

    const listedByScope = new Map<TraderHaltScope, number>();
    const listed: OpenTraderHaltRow[] = [];
    let irregular = 0;
    for (const row of fetched.rows) {
      if (row.status === "RESOLVED") {
        return refused(`a RESOLVED row (${escapeAuditText(row.incident_id)}) was listed as open`);
      }
      if (!inTraderHaltNamespace(row.incident_key)) {
        return refused(
          `a row outside the ${TRADER_HALT_INCIDENT_KEY_PREFIX} namespace (${escapeAuditText(row.incident_key)}) was listed`,
        );
      }
      const scope = traderHaltScopeOf(row.incident_key);
      listedByScope.set(scope, (listedByScope.get(scope) ?? 0) + 1);
      const irregularities = irregularitiesOf(row, scope);
      if (irregularities.length > 0) irregular += 1;
      listed.push(
        Object.freeze({
          incidentId: shown(row.incident_id),
          incidentKey: shown(row.incident_key),
          scope,
          status: shown(row.status),
          severity: shown(row.severity),
          environment: shown(row.environment),
          accountRef: shown(row.account_ref),
          failureClass: shown(row.failure_class),
          action: shown(row.action),
          marketId: shown(row.market_id),
          instanceId: shown(row.instance_id),
          detail: shown(row.detail),
          openedAt: shown(row.opened_at),
          irregularities,
        }),
      );
    }
    for (const scope of TRADER_HALT_SCOPES) {
      const count = listedByScope.get(scope) ?? 0;
      if (count > byScope[scope]) {
        return refused(
          `the read listed ${String(count)} ${scope} rows but counted ${String(byScope[scope])}; the count and the ` +
            "list did not see the same rows",
        );
      }
    }

    return {
      ok: true,
      halts: Object.freeze({
        total,
        byScope: Object.freeze(byScope),
        listed: Object.freeze(listed),
        truncated: total > listed.length,
        irregular,
      }),
    };
  } catch (cause) {
    return refused("reading the trader halt rows failed unexpectedly and was contained (fail closed)", [
      cause instanceof Error ? cause.message : String(cause),
    ]);
  }
}

// --- the sources -------------------------------------------------------------

/** What a source fetched: the raw result, judged by the cache's door — or why nothing was fetched. */
export type TraderHaltFetch =
  | { readonly fetched: true; readonly result: unknown }
  | { readonly fetched: false; readonly detail: string };

/**
 * Where open trader halts come from.
 *
 * A source FETCHES and never judges: {@link TraderHaltCache} runs the door. A
 * source is TOTAL (a failure is `{ fetched: false }`, never a throw — the cache
 * contains one anyway) and BOUNDED (it answers within its own bound whatever
 * its store does). `configured` is `false` only for {@link AbsentTraderHaltSource}.
 */
export interface TraderHaltSource {
  readonly configured: boolean;
  fetch(): Promise<TraderHaltFetch>;
}

/**
 * The explicit "this composition reads no `ops.incidents`" source. Never
 * fetched: the state is `NOT_CONFIGURED`, which is not `NONE_OPEN`.
 */
export class AbsentTraderHaltSource implements TraderHaltSource {
  readonly configured = false;
  readonly #why: string;

  constructor(why = "no trader halt source is configured") {
    this.#why = why;
  }

  /** Why nothing is read, for the health answer. */
  get why(): string {
    return this.#why;
  }

  fetch(): Promise<TraderHaltFetch> {
    return Promise.resolve({ fetched: false, detail: this.#why });
  }
}

/** A source over a result a composition (or a suite) holds. Its result still goes through the door. */
export class InMemoryTraderHaltSource implements TraderHaltSource {
  readonly configured = true;
  #next: TraderHaltFetch;
  #fetches = 0;

  constructor(result?: unknown) {
    this.#next =
      result === undefined
        ? { fetched: false, detail: "no trader halt result has been supplied to this source" }
        : { fetched: true, result };
  }

  /** The next fetch answers `result`. */
  set(result: unknown): void {
    this.#next = { fetched: true, result };
  }

  /** The next fetch fails with `detail`. */
  fail(detail: string): void {
    this.#next = { fetched: false, detail };
  }

  /** How many times this source has been fetched. */
  get fetches(): number {
    return this.#fetches;
  }

  fetch(): Promise<TraderHaltFetch> {
    this.#fetches += 1;
    return Promise.resolve(this.#next);
  }
}

// --- the cache ---------------------------------------------------------------

/** What the most recent read says (module header, "Fail closed"). */
export type TraderHaltView =
  | { readonly state: "OPEN" | "NONE_OPEN"; readonly halts: OpenTraderHalts }
  | {
      readonly state: "UNKNOWN";
      readonly reason: "NOT_READ" | "UNAVAILABLE" | "REFUSED";
      readonly detail: string;
      readonly issues: readonly string[];
    }
  | { readonly state: "NOT_CONFIGURED"; readonly detail: string };

function bounded(detail: string): string {
  return detail.length > TRADER_HALT_DETAIL_MAX ? `${detail.slice(0, TRADER_HALT_DETAIL_MAX)}…` : detail;
}

/**
 * Holds what the MOST RECENT read said, and counts reads by outcome.
 *
 * Unlike `TraderHealthCache`, it retains NOTHING across a failed read (module
 * header): a failed read is `UNKNOWN`, and no earlier count survives it.
 */
export class TraderHaltCache {
  readonly #source: TraderHaltSource;
  #view: TraderHaltView;
  readonly #reads = new Map<TraderHaltReadOutcome, number>();

  constructor(source: TraderHaltSource) {
    this.#source = source;
    this.#view = source.configured
      ? Object.freeze({
          state: "UNKNOWN" as const,
          reason: "NOT_READ" as const,
          detail: "ops.incidents has not been read yet",
          issues: Object.freeze([]),
        })
      : Object.freeze({
          state: "NOT_CONFIGURED" as const,
          detail: source instanceof AbsentTraderHaltSource ? source.why : "no trader halt source is configured",
        });
  }

  /** Whether a read is ever made. A source that is not configured is never fetched. */
  get configured(): boolean {
    return this.#source.configured;
  }

  /** Reads the source once, judges what it fetched, and replaces the view. Never throws. */
  async refresh(): Promise<TraderHaltView> {
    if (!this.#source.configured) return this.#view;
    let fetched: TraderHaltFetch;
    try {
      fetched = await this.#source.fetch();
    } catch (cause) {
      fetched = {
        fetched: false,
        detail: `the trader halt source threw (contained): ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    let outcome: TraderHaltReadOutcome;
    if (!fetched.fetched) {
      outcome = "UNAVAILABLE";
      this.#view = Object.freeze({
        state: "UNKNOWN" as const,
        reason: "UNAVAILABLE" as const,
        detail: escapeAuditText(bounded(fetched.detail)),
        issues: Object.freeze([]),
      });
    } else {
      const read = readTraderHaltFetch(fetched.result);
      if (read.ok) {
        outcome = "OK";
        this.#view = Object.freeze({ state: read.halts.total > 0 ? ("OPEN" as const) : ("NONE_OPEN" as const), halts: read.halts });
      } else {
        outcome = "REFUSED";
        this.#view = Object.freeze({
          state: "UNKNOWN" as const,
          reason: "REFUSED" as const,
          detail: escapeAuditText(bounded(read.detail)),
          issues: Object.freeze(read.issues.slice(0, 16).map((issue) => escapeAuditText(bounded(issue)))),
        });
      }
    }
    this.#reads.set(outcome, (this.#reads.get(outcome) ?? 0) + 1);
    return this.#view;
  }

  /** What the most recent read says. */
  view(): TraderHaltView {
    return this.#view;
  }

  /** Reads by outcome, sorted, for the metrics surface and the health answer. */
  readCounts(): Readonly<Record<string, number>> {
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const key of [...this.#reads.keys()].sort()) out[key] = this.#reads.get(key) ?? 0;
    return Object.freeze(out);
  }
}

// --- the health answer -------------------------------------------------------

const STATE_NOTES: Readonly<Record<TraderHaltState, string>> = Object.freeze({
  OPEN:
    "A trader halted and no operator has resolved its ops.incidents row: every TRADER_HALT row whose status is " +
    "not RESOLVED is counted here, read on this request. This process never resolves one.",
  NONE_OPEN:
    "This request's read of ops.incidents found no open TRADER_HALT row. That is not proof of no halt: a halt " +
    "whose record could not land (the trader logged HALT RECORD NOT DURABLE or HALT RECORD UNCONFIRMED) has no row.",
  UNKNOWN:
    "Open trader halts are UNKNOWN: the most recent read of ops.incidents did not produce a count this process " +
    "trusts. This is NOT 'no halts'.",
  NOT_CONFIGURED:
    "This process reads no ops.incidents, so open trader halts are NOT visible here. This is NOT 'no halts': read " +
    "the open TRADER_HALT rows of ops.incidents directly.",
});

/**
 * The `traderHalts` section of `GET /v1/health`: plain own data, so the
 * response encoder serializes it exactly (`api.ts`, `json`).
 */
export function traderHaltsDocument(cache: TraderHaltCache): Readonly<Record<string, unknown>> {
  const view = cache.view();
  const base = {
    state: view.state,
    configured: cache.configured,
    reads: cache.readCounts(),
    note: STATE_NOTES[view.state],
  };
  switch (view.state) {
    case "OPEN":
    case "NONE_OPEN":
      return {
        ...base,
        openTotal: view.halts.total,
        openByScope: view.halts.byScope,
        truncated: view.halts.truncated,
        irregular: view.halts.irregular,
        listed: view.halts.listed,
        detail: null,
        issues: [],
      };
    case "UNKNOWN":
      return {
        ...base,
        openTotal: null,
        openByScope: null,
        truncated: null,
        irregular: null,
        listed: null,
        detail: `${view.reason}: ${view.detail}`,
        issues: view.issues,
      };
    case "NOT_CONFIGURED":
      return {
        ...base,
        openTotal: null,
        openByScope: null,
        truncated: null,
        irregular: null,
        listed: null,
        detail: view.detail,
        issues: [],
      };
  }
}

// --- the metrics -------------------------------------------------------------

/**
 * The samples of the three trader-halt families (`PLATFORM_METRIC_FAMILIES`,
 * category `halts`) for the cache's current view: the state always, one
 * sample per state; the open counts only after a read that succeeded.
 */
export function traderHaltSamples(cache: TraderHaltCache): readonly PlatformMetricSample[] {
  const view = cache.view();
  const samples: PlatformMetricSample[] = TRADER_HALT_STATES.map((state) => ({
    name: "control_trader_halts_state",
    value: state === view.state ? 1 : 0,
    labels: { state },
  }));
  if (view.state === "OPEN" || view.state === "NONE_OPEN") {
    for (const scope of TRADER_HALT_SCOPES) {
      samples.push({ name: "control_trader_halts_open", value: view.halts.byScope[scope], labels: { scope } });
    }
  }
  const reads = cache.readCounts();
  for (const outcome of Object.keys(reads)) {
    samples.push({ name: "control_trader_halt_reads_total", value: reads[outcome] ?? 0, labels: { outcome } });
  }
  return samples;
}
