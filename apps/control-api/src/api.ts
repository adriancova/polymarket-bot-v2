/**
 * The API's HANDLER SEAM — routing, authentication, authorization, the request
 * doors, and the responses — with no `node:http` anywhere in it.
 *
 * ## Why the seam is transport-free
 *
 * `http.ts` is fifty lines of socket plumbing over this module. Everything that
 * decides anything lives here, as a function from a plain request record to a
 * plain response record, so:
 *
 * - the integration suite drives the REAL decision path over real HTTP (through
 *   `http.ts`) **and** the unit suites drive the same functions directly, with
 *   no doubled subject behaviour in either;
 * - a refusal is a value, not a thrown exception that some middleware might
 *   render differently;
 * - nothing about authentication or the mode-raise refusal depends on a
 *   framework's ordering.
 *
 * ## The order of operations is the security property
 *
 * For every request, in this order:
 *
 * 1. **Authenticate.** An unauthenticated request is refused `401` and reaches
 *    nothing. It writes NO audit record — it never reached the control plane —
 *    and is counted on `control_authentication_failures_total` instead. That
 *    boundary is deliberate: an audit log an anonymous caller can fill is an
 *    audit log an anonymous caller can exhaust, and this one refuses mutations
 *    when it is full. A body the transport refused (`413`/`415`/`400`) is
 *    refused HERE too, with `401`: the transport's refusal travels as data
 *    ({@link ApiRequest.transportRefusal}) and is answered only after step 5.
 * 2. **Read the body**, bounded in size by the transport before it ever gets
 *    here (and, for the routes that act on it, through its door in step 6).
 * 3. **Refuse a mode-raise attempt BY NAME** — from every authenticated
 *    caller, on every route, known or not, whatever content type its body
 *    declared (a body that parses as JSON is checked even when the transport
 *    will refuse it `415`). It is AUDITED only when the caller
 *    holds a MUTATION grant ({@link MUTATION_GRANTS}); a caller without one is
 *    refused identically and COUNTED (`control_mode_raise_attempts_refused_total`)
 *    but writes no record. This runs before authorization on purpose: an
 *    operator holding `STRATEGY_CONTROL` who sends `{"runMode":"LIVE"}` to the
 *    kill-switch route should be recorded as having attempted the mode raise,
 *    which is the more interesting fact. It is NOT audited for a READ-only
 *    caller because that is `WP-240` r1 M-3: a reader whose refusals were
 *    appended could fill the audit log, and a full log refuses every mutation,
 *    the kill switch included (`CONTROL-1`; `README.md`, "The audit budget").
 * 4. **Resolve the route** in {@link CONTROL_API_ROUTE_TABLE}: an unknown path
 *    is `404`, a known path under the wrong method is `405` with an `Allow`
 *    header (`CONTROL-1`, L-4).
 * 5. **Authorize** against the route's explicit grant (§15). Then, in a
 *    composition where no trader observes a mutation
 *    ({@link ControlApiOptions.mutationsReachTrader} `false`, the shipped PAPER
 *    process; `C1-OPS`), a mutating route is refused `501 CONTROL_NOT_WIRED`,
 *    audited as in step 6, before anything below runs.
 * 6.**Answer the transport's refusal, read the route parameter and the body
 *    through their doors**, then **act**, through the control plane, which
 *    audits before it applies. On a MUTATING route every refusal from here on
 *    is AUDITED (`CONTROL-1` r1, closing `CONTROL1-J-M2`) — save the control
 *    plane's GATED refusal, item 7 below: the caller has
 *    authenticated and holds the route's mutation grant, so its refusal is an
 *    operator fact, and it is recorded through `ControlPlane.refuseRequest` in
 *    the audit budget's ORDINARY tier — a full tier leaves the refusal standing
 *    and counts it `NOT_AUDITED`. A READ route's refusal is not audited: a
 *    read is never audited, accepted or refused.
 *
 * What writes NO audit record, exhaustively: an unauthenticated request (1); a
 * mode-raise attempt from a caller holding no mutation grant (3); a request the
 * router does not serve, `404`/`405` (4 — authorization is per route, and there
 * is no route); an authenticated caller lacking the route's grant (5); a read
 * route's transport refusal (6); a request the HTTP server refuses before
 * any handler runs — Node's own `408`/`400`, or a client that disconnects
 * mid-body (`http.ts`); and the control plane's GATED refusal (7): a
 * strengthening engage or halting pause of a switch or instance whose earlier
 * protected append is still unsettled, refused `503 CONTROL_NOT_AUDITABLE`
 * without offering a record (`control-plane.ts`, "One unsettled protected
 * append per state key"; `CONTROL-1b` r2, closing `CONTROL1B-R2-J-L1`). A
 * mutation-grant holder's mode-raise attempt is audited
 * at step 3 whatever route it named, so none of 4-6 applies to it. `README.md`,
 * "2. Every mutation is audited", lists the same.
 *
 * ## The route table IS the router (`CONTROL-1`, L-5)
 *
 * Dispatch looks a request up in {@link CONTROL_API_ROUTE_TABLE} and nowhere
 * else, and an exhaustive `switch` over the table's `kind` names the handler —
 * so a route cannot be served without being listed, nor listed without being
 * served (a missing handler is a type error). {@link CONTROL_API_ROUTES} and
 * {@link MUTATION_GRANTS} are DERIVED from the table, so the README's route
 * list, the route-inventory test and the audit gate in step 3 all read the
 * router itself rather than a hand-kept copy of it.
 *
 * ## What is NOT here, and cannot be
 *
 * No route names a run mode, a real-order flag, a live-micro cap, a signer, a
 * wallet operation, an order, or a cancel. §4.1: this process "never has the
 * signing key". §15's four action classes are answered in `auth.ts`'s
 * INTERPRETATION §5.
 *
 * ## Refresh-on-read, and why not a timer (`TRDR-3`, `WP-240` r1 M-2)
 *
 * The trader health cache was constructed and NEVER refreshed by the shipped
 * process (measured: `test/integration/control-api/health-refresh-wiring.test.ts`).
 * Two ways to wire it were weighed:
 *
 * - **A bounded interval** — a `setInterval` on an `unref`'d timer. It makes
 *   reads instant and polls the trader at a fixed rate whoever is reading.
 *   Against it: this process does nothing unprompted — `ApiEnvironment`
 *   supplies the clock and the ids so no behaviour is a function of wall time
 *   the audit cannot see (`WP-240`'s posture); a timer makes the report an
 *   operator gets "the state as of the last tick", which a `15 s` Prometheus
 *   scrape then samples on a second, unrelated cadence; it needs a floor, a
 *   config field and a shutdown path; and it polls a trader nobody is reading.
 * - **Refresh-on-read** (chosen) — an AUTHORIZED `GET /v1/health` or
 *   `GET /v1/metrics` refreshes the cache FIRST, bounded by the source's own
 *   timeout, then answers. The report an operator or a scrape receives is the
 *   trader's answer AT THAT REQUEST, `control_trader_health_current` means "the
 *   read this scrape just did passed", and nothing runs between requests. The
 *   cost is one loopback round trip per read, bounded by `traderHealth.timeoutMs`;
 *   a burst of reads is a burst of loopback GETs, which is why the refresh is
 *   SINGLE-FLIGHT (concurrent reads await one in-flight refresh) and why it
 *   runs only AFTER authentication and authorization — an anonymous or
 *   unauthorized caller can make this process ask the trader nothing.
 *
 * The mechanism is enabled by `main.ts` for an `http` source only
 * (`refreshHealthOnRead`); a `none` source is never read, so it adds no
 * `control_trader_health_reads_total` line and `control_trader_health_available`
 * reads 0.
 *
 * `CONTROL-2` reads the open trader halts in `ops.incidents` the same way
 * (`trader-halts.ts`): a CONFIGURED halt source is read on every authorized
 * health and metrics request, single-flight, in parallel with the health
 * refresh, bounded by the source's own timeout; an unconfigured one is never
 * read. The metrics body therefore always carries `control_trader_halts_state`
 * — the state is explicit, so a deployment that reads nothing says
 * `NOT_CONFIGURED` rather than nothing — and the open counts only after a read
 * that succeeded.
 *
 * ## The answer deadline (`CONTROL-2`, closing `CTL2-F1`)
 *
 * Both refreshes are bounded by their SOURCES' bounds, and those are
 * configuration (`traderHealth.timeoutMs` up to 60 s). A read that waited for
 * the slower of them could outlast the Prometheus scrape that asked for it: the
 * scrape is abandoned, the `UNKNOWN` the halt read would have said never
 * reaches Prometheus, `TraderHaltOpenOrUnknown` cannot fire, and the panel keeps
 * the last `NONE_OPEN` it saw. So every authorized health and metrics read
 * answers within {@link READ_REFRESH_DEADLINE_MS} of starting its refreshes,
 * whatever they do — below the scrape fragment's explicit `scrape_timeout`
 * (`infra/prometheus/control-api-scrape.yaml`, pinned by
 * `test/integration/control-api/trader-halt-shape.test.ts`). A refresh still
 * in flight at the deadline is answered as what it is — not current — and
 * never as an earlier read's result:
 *
 * - the trader halts are `UNKNOWN`, reason `OVERDUE` (`trader-halts.ts`,
 *   `overdueTraderHaltView`), not the cache's earlier view;
 * - the trader health is not current (`control_trader_health_current` 0, and
 *   `current: false` on `/v1/health`); a report retained from an earlier read
 *   is still shown, as after a failed read, and its `asOf` says how old it is.
 *
 * The refreshes run on: single-flight, a later read joins one still in flight,
 * and the caches record and count it when it settles. The halt read's own bound
 * is capped below the deadline (`adapters/postgres-trader-halts.ts`,
 * `TRADER_HALT_READ_TIMEOUT_MAX_MS`), so a database that does not answer is
 * `UNAVAILABLE` by the read's own timer and `OVERDUE` is the backstop for a
 * source that does not keep its bound.
 */

import {
  controlPlaneSamples,
  renderExpositionFor,
  traderHealthSamples,
  PLATFORM_METRIC_FAMILIES,
  type PlatformMetricSample,
} from "@polymarket-bot/observability";
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import { boundAuditText } from "./audit-text.js";
import { hasGrant, type OperatorCredential, type OperatorGrant, type OperatorRegistry } from "./auth.js";
import {
  REFUSAL_AUDIT_MAX_ISSUES,
  type ControlPlane,
  type KillSwitchRelease,
  type MutatingAuditAction,
  type MutationContext,
  type RequestRefusalStage,
} from "./control-plane.js";
import {
  buildDoor,
  ownBoolean,
  ownString,
  type DoorRefusal,
  type DoorResult,
} from "./doors.js";
import type { TraderHealthCache } from "./health-source.js";
import { readInstanceIdParameter } from "./instance-id.js";
import {
  overdueTraderHaltView,
  traderHaltSamples,
  traderHaltsDocument,
  type TraderHaltCache,
  type TraderHaltView,
} from "./trader-halts.js";
import {
  CONTROL_KILL_SWITCH_ACTIONS,
  CONTROL_KILL_SWITCH_SCOPES,
  forbiddenControlKeysIn,
  type ControlKillSwitchAction,
  type ControlKillSwitchScope,
} from "./vocabulary.js";
import { z } from "zod";

/** A transport-free request. */
export interface ApiRequest {
  readonly method: string;
  /** Path only, no query string. */
  readonly path: string;
  readonly authorization: string | undefined;
  /**
   * Already-parsed JSON body, or `undefined` for a body-less request. With a
   * {@link ApiRequest.transportRefusal} it is the body only when it parsed as
   * JSON despite an undeclared type (`415`), and it is then read for ONE
   * purpose: the by-name mode-raise refusal (step 3). Nothing acts on it.
   */
  readonly body: unknown;
  /**
   * A refusal the transport decided while reading the body (`http.ts`):
   * `413`, `415`, or `400` not-JSON. It is ANSWERED only after authentication,
   * the mode-raise refusal, routing and the route's authorization — so a caller
   * learns nothing about its body before it has authenticated — and on a
   * mutating route it is AUDITED as a refusal (`CONTROL-1` r1, closing
   * `CONTROL1-J-M2`; module header, step 6).
   */
  readonly transportRefusal?: TransportRefusal;
}

/** The refusals `http.ts` decides while reading a body. */
export type TransportRefusalCode =
  | "CONTROL_BODY_TOO_LARGE"
  | "CONTROL_UNSUPPORTED_MEDIA_TYPE"
  | "CONTROL_BODY_NOT_JSON";

/** One transport refusal, typed, carried through the authorization boundary. */
export interface TransportRefusal {
  readonly code: TransportRefusalCode;
  readonly detail: string;
  readonly issues: readonly string[];
  /**
   * The exact response the transport rendered for it (`http.ts`'s own-data
   * refusal body), returned verbatim once the request has been authorized.
   */
  readonly response: ApiResponse;
}

export interface ApiResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /**
   * The `Allow` header, on a `405` only (RFC 9110 §15.5.6 requires it there).
   * `http.ts` writes it; every other response leaves it absent.
   */
  readonly allow?: string;
}

/** The clock and id source the API refuses to invent. */
export interface ApiEnvironment {
  /** Strict-UTC instant for this request. */
  now(): string;
  /** A fresh, sortable, unique audit record id. */
  nextAuditRecordId(): string;
}

/**
 * `CONTROL-2` (`CTL2-F1`): the longest an authorized `GET /v1/health` or
 * `GET /v1/metrics` waits for its refreshes before it answers (module header,
 * "The answer deadline"). Below the control-api scrape job's explicit
 * `scrape_timeout` of 10 s, with room for rendering and the transport; above
 * the halt read's own longest bound, so a halt read that keeps its bound is
 * always settled by it.
 */
export const READ_REFRESH_DEADLINE_MS = 8_000;

/** Which of this answer's refreshes had not settled by the answer deadline. */
interface OverdueRefreshes {
  readonly health: boolean;
  readonly halts: boolean;
}

/** `work` settled (its rejection propagates), or `ms` passed — whichever is first. The timer is unreferenced. */
function settledOrDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return Promise.race([work.then(() => undefined), deadline]).finally(() => {
    clearTimeout(timer);
  });
}

export interface ControlApiOptions {
  readonly operators: OperatorRegistry;
  readonly controlPlane: ControlPlane;
  readonly health: TraderHealthCache;
  readonly environment: ApiEnvironment;
  /** The audit sink's bound, for the metrics surface. */
  readonly auditCapacity: number;
  /** How many records the audit sink currently holds, if it can say. */
  auditSize(): number;
  /**
   * `TRDR-3`: refresh the trader health cache before an authorized
   * `GET /v1/health` / `GET /v1/metrics` answers (module header,
   * "Refresh-on-read"). Absent or `false` — every `WP-240` harness — reads
   * the cache as it stands, byte-identical to before this round.
   */
  readonly refreshHealthOnRead?: boolean;
  /**
   * `CONTROL-2` (closing `H1R1-HALT-INVISIBLE`): the open trader halts in
   * `ops.incidents` (`trader-halts.ts`). REQUIRED, so every composition states
   * its halt source — an `AbsentTraderHaltSource` says `NOT_CONFIGURED`, which
   * is never "no halts". A configured source is READ on every authorized
   * `GET /v1/health` and `GET /v1/metrics` (module header, "Refresh-on-read"),
   * single-flight, and never by an unauthorized caller.
   */
  readonly traderHalts: TraderHaltCache;
  /**
   * `CTL2-F1`: the answer deadline of an authorized health or metrics read, in
   * milliseconds — an integer from 1 to {@link READ_REFRESH_DEADLINE_MS}, which
   * is also the default and what `main.ts` composes. A suite passes a shorter
   * one; nothing may pass a longer one (the constructor throws `RangeError`).
   */
  readonly refreshDeadlineMs?: number;
  /**
   * `C1-OPS` (COMPLEXITY-1, CONTROL-API option (a)): whether a running trader
   * observes this process's mutations. REQUIRED and never defaulted, so every
   * composition states it. `false` — the shipped PAPER `main.ts` — answers
   * every AUTHORIZED request to a mutating route `501 CONTROL_NOT_WIRED`,
   * audited as a refusal, after the mode-raise refusal (step 3) and
   * authorization (step 5) and before anything else: an engage answered `200`
   * would tell the operator a halt took effect that no trader reads. The test
   * harnesses pass `true`, so the control plane the live composition will use
   * stays measured. Set it `true` only in a composition that binds a durable
   * audit sink AND a trader that reads it.
   */
  readonly mutationsReachTrader: boolean;
}

/** `C1-OPS`: the audit action each mutating route's `501 CONTROL_NOT_WIRED` refusal records. */
const NOT_WIRED_ACTION: Readonly<Partial<Record<RouteKind, MutatingAuditAction>>> = Object.freeze({
  STRATEGY_PAUSE: "STRATEGY_PAUSE",
  STRATEGY_RESUME: "STRATEGY_RESUME",
  KILL_SWITCH_ENGAGE: "KILL_SWITCH_ENGAGE",
  KILL_SWITCH_RELEASE: "KILL_SWITCH_RELEASE",
});

const NOT_WIRED_DETAIL =
  "no running trader observes this process's controls, so nothing was paused, resumed, engaged or released. " +
  "To stop a PAPER trader, press Ctrl-C or send it SIGTERM; a second signal forces exit 130 " +
  "(docs/runbooks/paper-operations.md)";

// --- the request doors ------------------------------------------------------

const ReasonSchema = z.string().min(3).max(1024);

const StrategyRequestSchema = z.strictObject({ reason: ReasonSchema });

const KillSwitchEngageSchema = z.strictObject({
  scope: z.enum(CONTROL_KILL_SWITCH_SCOPES),
  /**
   * Absent for `GLOBAL`, required otherwise. Modelled as a union with `null`
   * rather than an optional key: an OPTIONAL key is the exact class ADR-020 §1
   * records as adoptable from the prototype, and the §10.6 constraint that
   * depends on it (`kill_switch_events_scope_ref`) is a database CHECK an
   * inherited value would defeat before the insert ever ran.
   */
  scopeRef: z.union([z.string().min(1).max(256), z.literal(null)]),
  action: z.enum(CONTROL_KILL_SWITCH_ACTIONS),
  reason: ReasonSchema,
});

const KillSwitchReleaseSchema = z.strictObject({
  scope: z.enum(CONTROL_KILL_SWITCH_SCOPES),
  scopeRef: z.union([z.string().min(1).max(256), z.literal(null)]),
  /**
   * The literal `true`. Not a boolean: `false` must not be *expressible* as an
   * accepted value, so the schema itself is the evidence requirement and the
   * control plane's own check is the second layer.
   */
  authoritativeSnapshotApplied: z.literal(true),
  reason: ReasonSchema,
});

interface StrategyRequest {
  readonly reason: string;
}
interface KillSwitchEngageRequest {
  readonly scope: ControlKillSwitchScope;
  readonly scopeRef: string | null;
  readonly action: ControlKillSwitchAction;
  readonly reason: string;
}
interface KillSwitchReleaseRequest {
  readonly scope: ControlKillSwitchScope;
  readonly scopeRef: string | null;
  readonly release: KillSwitchRelease;
  readonly reason: string;
}

const strategyDoor = buildDoor(
  StrategyRequestSchema,
  "strategy control request",
  (materialized): StrategyRequest => ({ reason: ownString(materialized, "reason") ?? "" }),
);

const engageDoor = buildDoor(
  KillSwitchEngageSchema,
  "kill-switch request",
  (materialized): KillSwitchEngageRequest => ({
    scope: (ownString(materialized, "scope") ?? "") as ControlKillSwitchScope,
    scopeRef: ownString(materialized, "scopeRef") ?? null,
    action: (ownString(materialized, "action") ?? "") as ControlKillSwitchAction,
    reason: ownString(materialized, "reason") ?? "",
  }),
);

const releaseDoor = buildDoor(
  KillSwitchReleaseSchema,
  "kill-switch release request",
  (materialized): KillSwitchReleaseRequest => ({
    scope: (ownString(materialized, "scope") ?? "") as ControlKillSwitchScope,
    scopeRef: ownString(materialized, "scopeRef") ?? null,
    release: {
      // Read from the MATERIALIZED tree (D3). The schema proved it is `true`;
      // this reads the value the schema judged rather than trusting the literal.
      authoritativeSnapshotApplied: (ownBoolean(materialized, "authoritativeSnapshotApplied") ??
        false) as true,
      reason: ownString(materialized, "reason") ?? "",
    },
    reason: ownString(materialized, "reason") ?? "",
  }),
);

// --- the route table ----------------------------------------------------------

/** What a route does; the exhaustive `switch` in `ControlApi` maps each to its handler. */
type RouteKind =
  | "RUN_STATE"
  | "STRATEGIES"
  | "KILL_SWITCHES"
  | "HEALTH"
  | "METRICS"
  | "STRATEGY_PAUSE"
  | "STRATEGY_RESUME"
  | "KILL_SWITCH_ENGAGE"
  | "KILL_SWITCH_RELEASE";

/** One route this API serves. */
export interface ControlApiRoute {
  readonly method: "GET" | "POST";
  /** The path template; `:instanceId` is the one parameter. */
  readonly path: string;
  /** The explicit §15 grant the route requires. */
  readonly grant: OperatorGrant;
  /** True when the route can change control-plane state. */
  readonly mutates: boolean;
}

interface RouteDefinition extends ControlApiRoute {
  readonly kind: RouteKind;
}

const ROUTE_DEFINITIONS: readonly RouteDefinition[] = Object.freeze(
  (
    [
      { kind: "RUN_STATE", method: "GET", path: "/v1/run-state", grant: "READ", mutates: false },
      { kind: "STRATEGIES", method: "GET", path: "/v1/strategies", grant: "READ", mutates: false },
      { kind: "KILL_SWITCHES", method: "GET", path: "/v1/kill-switch", grant: "READ", mutates: false },
      { kind: "HEALTH", method: "GET", path: "/v1/health", grant: "READ", mutates: false },
      { kind: "METRICS", method: "GET", path: "/v1/metrics", grant: "READ", mutates: false },
      {
        kind: "STRATEGY_PAUSE",
        method: "POST",
        path: "/v1/strategies/:instanceId/pause",
        grant: "STRATEGY_CONTROL",
        mutates: true,
      },
      {
        kind: "STRATEGY_RESUME",
        method: "POST",
        path: "/v1/strategies/:instanceId/resume",
        grant: "STRATEGY_CONTROL",
        mutates: true,
      },
      { kind: "KILL_SWITCH_ENGAGE", method: "POST", path: "/v1/kill-switch", grant: "KILL_SWITCH", mutates: true },
      {
        kind: "KILL_SWITCH_RELEASE",
        method: "POST",
        path: "/v1/kill-switch/release",
        grant: "KILL_SWITCH",
        mutates: true,
      },
    ] as const satisfies readonly RouteDefinition[]
  ).map((route): RouteDefinition => Object.freeze({ ...route })),
);

/** The route table, as the README and the inventory tests read it. Derived from the router. */
export const CONTROL_API_ROUTE_TABLE: readonly ControlApiRoute[] = Object.freeze(
  ROUTE_DEFINITIONS.map(({ method, path, grant, mutates }) => Object.freeze({ method, path, grant, mutates })),
);

/** The routes this API serves, `"METHOD /path"`. Derived from the router (`CONTROL-1`, L-5). */
export const CONTROL_API_ROUTES: readonly string[] = Object.freeze(
  ROUTE_DEFINITIONS.map((route) => `${route.method} ${route.path}`),
);

/**
 * The grants some MUTATING route requires — what "mutation authority" means
 * for step 3's audit gate. Derived from the router, sorted.
 */
export const MUTATION_GRANTS: readonly OperatorGrant[] = Object.freeze(
  [...new Set(ROUTE_DEFINITIONS.filter((route) => route.mutates).map((route) => route.grant))].sort(),
);

/** True when the operator holds at least one {@link MUTATION_GRANTS} grant. */
export function holdsMutationAuthority(operator: OperatorCredential): boolean {
  return MUTATION_GRANTS.some((grant) => hasGrant(operator, grant));
}

type RouteResolution =
  | { readonly found: "ROUTE"; readonly route: RouteDefinition; readonly rawInstanceId: string | undefined }
  | { readonly found: "METHOD_NOT_ALLOWED"; readonly allow: readonly string[] }
  | { readonly found: "NONE" };

/**
 * Matches a path against a template segment by segment. A `:parameter`
 * segment matches one NON-EMPTY raw segment (still percent-encoded); every
 * other segment matches itself exactly — case, and all.
 */
function matchTemplate(
  template: string,
  path: string,
): { readonly rawInstanceId: string | undefined } | undefined {
  const want = template.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return undefined;
  let rawInstanceId: string | undefined;
  for (let index = 0; index < want.length; index += 1) {
    const expected = want[index] ?? "";
    const actual = got[index] ?? "";
    if (expected.startsWith(":")) {
      if (actual === "") return undefined;
      rawInstanceId = actual;
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return { rawInstanceId };
}

function resolveRoute(method: string, path: string): RouteResolution {
  const allow = new Set<string>();
  for (const route of ROUTE_DEFINITIONS) {
    const matched = matchTemplate(route.path, path);
    if (matched === undefined) continue;
    if (route.method === method) {
      return { found: "ROUTE", route, rawInstanceId: matched.rawInstanceId };
    }
    allow.add(route.method);
  }
  return allow.size > 0 ? { found: "METHOD_NOT_ALLOWED", allow: [...allow].sort() } : { found: "NONE" };
}

// --- responses --------------------------------------------------------------

/**
 * One JSON response, its body encoded from OWN DATA (`SER-3`, 2026-09-15).
 *
 * Every body this API answers with — the run-state read, the kill-switch
 * list, a mutation receipt carrying its `auditRecordId`, a refusal — went
 * through `JSON.stringify(value, null, 2)` at base, which resolves `toJSON`
 * through the prototype chain. Measured at `main` `d6e05bf` and reproduced
 * independently (`docs/handoffs/SER-0-sweep.md`, `control-api-response-body`):
 * under an inherited `Object.prototype.toJSON` every body was the bare string
 * `"POLLUTED"`; under `Array.prototype` the kill-switch list read
 * `{"killSwitches": "POLLUTED"}` while a switch was engaged. An operator
 * reads these bodies to decide whether a halt is in force.
 *
 * `encodePlainJson` (`@polymarket-bot/risk/plain-json`) is byte-identical to
 * the clean `JSON.stringify` for plain data and never consults `toJSON`.
 * Every value handed here is plain: the control plane's frozen literals (built
 * from `[...map.values()]`, so ordinary containers whatever a caller holds),
 * the null-prototype counter records `sortedCounts`/`readCounts` return —
 * which this encoder accepts for the same reason `JSON.stringify` serializes
 * them, there being no inherited meaning to consult — the health cache's
 * door-materialized report, and the problem records built here. A value it
 * refuses is a defect in this process, and `handle()`'s outer guard turns the
 * throw into the `CONTROL_INTERNAL_ERROR` refusal — whose own body is a plain
 * record this encoder cannot refuse.
 *
 * TWO QUALIFICATIONS THE `SER-3` REVIEW MEASURED (round 1), both pinned in
 * `test/unit/control-api/response-encoder-bound.test.ts`:
 *
 * - The door bound and the encoder bound (both `MAX_DEPTH`, 64) compose at the
 *   ROOT depth only. `#health()` embeds the report one level down, so a tree
 *   the door accepts at exactly 64 is refused here; today's fixed health
 *   schema — a handful of levels — is what makes that unreachable, not the
 *   alignment of the two constants.
 * - `ControlPlane` and `TraderHealthCache` are nominal (they carry `#` private
 *   fields), so no foreign IMPLEMENTATION is assignable to `ControlApiOptions`
 *   and no caller's container type arrives through them. (A subclass could
 *   override a method; this repository has none, and a subclass is code in
 *   this process rather than a caller's value.) The one seam that is an
 *   INTERFACE is `TraderHealthSource`; its contract — an `OK` report is the
 *   door's materialized output — is stated where it is implemented
 *   (`health-source.ts`).
 */
function json(status: number, value: unknown): ApiResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: `${encodePlainJson(value, { indent: 2 })}\n`,
  };
}

function problem(status: number, code: string, detail: string, issues: readonly string[] = []): ApiResponse {
  return json(status, { code, detail, issues });
}

// --- the API ----------------------------------------------------------------

export class ControlApi {
  readonly #options: ControlApiOptions;
  readonly #authenticationFailures = new Map<string, number>();
  readonly #authorizationFailures = new Map<string, number>();
  /** The one refresh in flight, shared by concurrent authorized reads (`#fresh`). */
  #refreshInFlight: Promise<unknown> | undefined;
  /** The one trader halt read in flight, shared the same way (`CONTROL-2`). */
  #haltReadInFlight: Promise<unknown> | undefined;
  /** `CTL2-F1`: the answer deadline (module header). */
  readonly #refreshDeadlineMs: number;

  constructor(options: ControlApiOptions) {
    const deadline = options.refreshDeadlineMs ?? READ_REFRESH_DEADLINE_MS;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > READ_REFRESH_DEADLINE_MS) {
      throw new RangeError(
        `the refresh answer deadline must be an integer from 1 to ${String(READ_REFRESH_DEADLINE_MS)} ms, below the ` +
          "scrape timeout a Prometheus job gives this API",
      );
    }
    this.#options = options;
    this.#refreshDeadlineMs = deadline;
  }

  /** Authentication failures by reason, sorted, for the metrics surface. */
  authenticationFailures(): Readonly<Record<string, number>> {
    return sortedCounts(this.#authenticationFailures);
  }

  /** Authorization failures by the grant that was missing, sorted. */
  authorizationFailures(): Readonly<Record<string, number>> {
    return sortedCounts(this.#authorizationFailures);
  }

  /**
   * Handles one request. TOTAL: it returns a response for every input.
   *
   * A throw escaping here would be a 500 where a refusal belongs, so the whole
   * body is guarded — the same reason the doors are guarded (`doors.ts`, "the
   * outer guard is not decoration").
   */
  async handle(request: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.#handle(request);
    } catch (cause) {
      return problem(
        500,
        "CONTROL_INTERNAL_ERROR",
        "the request could not be completed and was contained; no state changed",
        [cause instanceof Error ? cause.message : String(cause)],
      );
    }
  }

  async #handle(request: ApiRequest): Promise<ApiResponse> {
    // 1. AUTHENTICATE. Nothing below this line runs for an anonymous caller.
    const authenticated = this.#options.operators.authenticate(request.authorization);
    if (!authenticated.ok) {
      this.#authenticationFailures.set(
        authenticated.reason,
        (this.#authenticationFailures.get(authenticated.reason) ?? 0) + 1,
      );
      return problem(
        401,
        "CONTROL_UNAUTHENTICATED",
        // Names the CLASS of failure and nothing about what was presented.
        `the request presented no usable operator credential (${authenticated.reason})`,
      );
    }
    const operator = authenticated.operator;

    // 3 (pre-empting routing and authorization, deliberately — module header).
    if (request.body !== undefined) {
      const forbidden = forbiddenControlKeysIn(request.body);
      if (forbidden.length > 0) return this.#refuseModeRaise(operator, request, forbidden);
    }

    // 4. RESOLVE the route in the table — the only router there is.
    const resolved = resolveRoute(request.method, request.path);
    if (resolved.found === "NONE") {
      return problem(
        404,
        "CONTROL_NO_SUCH_ROUTE",
        `${request.method} ${request.path} is not a route this API serves. It serves run-state reads, ` +
          "strategy pause/resume, §14.1 kill-switch engage/release, the health read and the metrics " +
          "surface — and nothing that places an order, moves a wallet, or changes a run mode.",
      );
    }
    if (resolved.found === "METHOD_NOT_ALLOWED") {
      const allow = resolved.allow.join(", ");
      return {
        ...problem(
          405,
          "CONTROL_METHOD_NOT_ALLOWED",
          `${request.path} is served for ${allow} only; ${request.method} is not a method this API ` +
            "accepts there, and nothing that places an order, moves a wallet, or changes a run mode is " +
            "served anywhere.",
        ),
        allow,
      };
    }
    const route = resolved.route;

    // 5. AUTHORIZE against the route's explicit grant. An unauthorized caller
    //    reaches no door, no trader refresh and no control plane.
    const refusal = this.#authorize(operator, route.grant);
    if (refusal !== undefined) return refusal;

    // `C1-OPS`: no trader observes a mutation here, so none is acted on.
    const notWired = route.mutates && !this.#options.mutationsReachTrader ? NOT_WIRED_ACTION[route.kind] : undefined;
    if (notWired !== undefined) {
      const refused = { code: "CONTROL_NOT_WIRED", detail: NOT_WIRED_DETAIL, issues: [] };
      return this.#refusedBeforePlane(
        operator,
        route,
        notWired,
        { scope: "CONTROL_PLANE", scopeRef: null },
        "NOT_WIRED",
        refused,
        problem(501, refused.code, refused.detail),
      );
    }

    // 6. Read and act. A READ route answers a transport refusal as it stands —
    //    a read is never audited — and every MUTATING handler below answers it
    //    itself, audited, before anything else.
    if (!route.mutates && request.transportRefusal !== undefined) return request.transportRefusal.response;
    switch (route.kind) {
      case "RUN_STATE":
        return json(200, this.#options.controlPlane.runState());
      case "STRATEGIES":
        return json(200, { strategies: this.#options.controlPlane.strategies() });
      case "KILL_SWITCHES":
        return json(200, { killSwitches: this.#options.controlPlane.killSwitches() });
      case "HEALTH":
        return this.#fresh((overdue) => this.#health(overdue));
      case "METRICS":
        return this.#fresh((overdue) => this.#metrics(overdue));
      case "STRATEGY_PAUSE":
        return this.#strategy(operator, route, request, resolved.rawInstanceId ?? "", true);
      case "STRATEGY_RESUME":
        return this.#strategy(operator, route, request, resolved.rawInstanceId ?? "", false);
      case "KILL_SWITCH_ENGAGE":
        return this.#engage(operator, route, request);
      case "KILL_SWITCH_RELEASE":
        return this.#release(operator, route, request);
    }
  }

  /**
   * Step 6's refusal of an AUTHORIZED request to a mutating route, before it
   * reached a mutation method: recorded through `ControlPlane.refuseRequest`,
   * then answered with `response` — unchanged whether or not the record was
   * written (a refused record is counted `NOT_AUDITED`; the refusal stands).
   *
   * The record's reason names the route's TEMPLATE, not the request's path, so
   * nothing a caller spelled reaches it unbounded.
   */
  async #refusedBeforePlane(
    operator: OperatorCredential,
    route: RouteDefinition,
    action: MutatingAuditAction,
    target: { readonly scope: string; readonly scopeRef: string | null },
    stage: RequestRefusalStage,
    refusal: { readonly code: string; readonly detail: string; readonly issues: readonly string[] },
    response: ApiResponse,
  ): Promise<ApiResponse> {
    await this.#options.controlPlane.refuseRequest(
      action,
      target,
      stage,
      refusal,
      this.#context(
        operator,
        `request to ${route.method} ${route.path} refused before it reached the control plane (${refusal.code})`,
      ),
    );
    return response;
  }

  /**
   * Step 3: the by-name refusal of a mode-raise attempt (acceptance 1), and
   * whether it is AUDITED (`CONTROL-1`, closing `WP-240` r1 M-3).
   *
   * Every authenticated caller gets the same `403` and the same counter. Only a
   * caller holding a MUTATION grant gets an audit record — and the refusal says
   * which happened, including when the audit budget refused the record, so it
   * never claims an audit that was not written.
   */
  async #refuseModeRaise(
    operator: OperatorCredential,
    request: ApiRequest,
    forbidden: readonly string[],
  ): Promise<ApiResponse> {
    const named = forbidden.join(", ");
    let recorded: string;
    if (holdsMutationAuthority(operator)) {
      const outcome = await this.#options.controlPlane.refuseModeRaise(forbidden, {
        actor: operator.operatorId,
        at: this.#options.environment.now(),
        auditRecordId: this.#options.environment.nextAuditRecordId(),
        reason: modeRaiseReason(request.method, request.path, forbidden),
      });
      recorded = outcome.audited
        ? "the attempt has been audited."
        : outcome.unconfirmed
          ? `the attempt has been counted; its audit record was NOT confirmed within the append bound ` +
            `(${outcome.code}) and may still land, and nothing changed.`
          : `the attempt has been counted; it could NOT be audited (${outcome.code}), and nothing changed.`;
    } else {
      this.#options.controlPlane.countModeRaiseWithoutAudit();
      recorded =
        `the attempt has been counted and NOT audited: operator ${operator.operatorId} holds no ` +
        `mutation grant (${MUTATION_GRANTS.join(", ")}), and an audit log a caller without mutation ` +
        "authority could append to is one it could exhaust, refusing every mutation, the kill switch " +
        "included (README, 'The audit budget').";
    }
    return problem(
      403,
      "CONTROL_MODE_RAISE_REFUSED",
      "this API cannot raise a run mode, enable real orders, raise a live-micro cap, or " +
        "reference a signer: §11's ceiling is a startup value and is not writable here, and " +
        "§4.1 gives this process no signing key. The request named " +
        `${named} and is refused by name; ${recorded}`,
      forbidden,
    );
  }

  /**
   * An authorized read that REFRESHES the trader health cache first when the
   * composition asked for it (module header, "Refresh-on-read"). Authorization
   * has already happened in `#handle`, so an unauthorized operator triggers no
   * trader request. Single-flight: concurrent reads share one in-flight
   * refresh, so a burst of scrapes is one loopback GET. A refresh never throws
   * — the cache answers every failure as data and counts it — so `produce`
   * always runs.
   *
   * `CTL2-F1`: `produce` runs once both refreshes have settled OR the answer
   * deadline has passed, whichever is first (module header, "The answer
   * deadline"), and is told which refresh it did not wait for.
   */
  async #fresh(produce: (overdue: OverdueRefreshes) => ApiResponse): Promise<ApiResponse> {
    let healthRead: Promise<unknown> | undefined;
    if (this.#options.refreshHealthOnRead === true) {
      this.#refreshInFlight ??= this.#options.health.refresh().finally(() => {
        this.#refreshInFlight = undefined;
      });
      healthRead = this.#refreshInFlight;
    }
    // `CONTROL-2`: a configured trader halt source is read on the same
    // authorized reads, single-flight; one that is not configured is never
    // read, and its state stays NOT_CONFIGURED. The cache never throws.
    let haltRead: Promise<unknown> | undefined;
    if (this.#options.traderHalts.configured) {
      this.#haltReadInFlight ??= this.#options.traderHalts.refresh().finally(() => {
        this.#haltReadInFlight = undefined;
      });
      haltRead = this.#haltReadInFlight;
    }
    let healthSettled = healthRead === undefined;
    let haltsSettled = haltRead === undefined;
    if (!healthSettled || !haltsSettled) {
      await settledOrDeadline(
        Promise.all([
          healthRead?.then(() => {
            healthSettled = true;
          }),
          haltRead?.then(() => {
            haltsSettled = true;
          }),
        ]),
        this.#refreshDeadlineMs,
      );
    }
    return produce({ health: !healthSettled, halts: !haltsSettled });
  }

  /** `CTL2-F1`: the halt view this answer renders — the cache's, or OVERDUE when this request's read is outstanding. */
  #haltView(overdue: OverdueRefreshes): TraderHaltView {
    return overdue.halts ? overdueTraderHaltView(this.#refreshDeadlineMs) : this.#options.traderHalts.view();
  }

  #authorize(operator: OperatorCredential, grant: OperatorGrant): ApiResponse | undefined {
    if (hasGrant(operator, grant)) return undefined;
    this.#authorizationFailures.set(grant, (this.#authorizationFailures.get(grant) ?? 0) + 1);
    return problem(
      403,
      "CONTROL_UNAUTHORIZED",
      `operator ${operator.operatorId} does not hold the ${grant} grant; §15 requires EXPLICIT ` +
        "authorization, so authenticating grants nothing by itself",
    );
  }

  #context(operator: OperatorCredential, reason: string): MutationContext {
    return {
      actor: operator.operatorId,
      at: this.#options.environment.now(),
      auditRecordId: this.#options.environment.nextAuditRecordId(),
      reason,
    };
  }

  async #strategy(
    operator: OperatorCredential,
    route: RouteDefinition,
    request: ApiRequest,
    rawInstanceId: string,
    pause: boolean,
  ): Promise<ApiResponse> {
    const action: MutatingAuditAction = pause ? "STRATEGY_PAUSE" : "STRATEGY_RESUME";
    // The route parameter through ITS door (`instance-id.ts`): total, so a
    // malformed escape is a 400 rather than a contained 500 (L-1), and the
    // grammar is applied to the DECODED id, so `%2F` cannot re-admit `/` (L-2).
    const parameter = readInstanceIdParameter(rawInstanceId);
    // A refusal's audit target is the decoded id when it passed its door, and
    // NOTHING the caller spelled otherwise — so `a%2Fb` is never a scopeRef.
    const target = { scope: "STRATEGY_INSTANCE", scopeRef: parameter.ok ? parameter.value : null };

    const transport = request.transportRefusal;
    if (transport !== undefined) {
      return this.#refusedBeforePlane(operator, route, action, target, "TRANSPORT", transport, transport.response);
    }
    if (!parameter.ok) {
      const refused = { code: "CONTROL_INVALID_ROUTE_PARAMETER", detail: parameter.detail, issues: [] };
      return this.#refusedBeforePlane(
        operator,
        route,
        action,
        target,
        "ROUTE_PARAMETER",
        refused,
        problem(400, refused.code, refused.detail),
      );
    }
    const instanceId = parameter.value;

    const parsed: DoorResult<StrategyRequest> = strategyDoor(request.body);
    if (!parsed.ok) return this.#doorRefused(operator, route, action, target, parsed.refusal);

    const context = this.#context(operator, parsed.value.reason);
    const result = pause
      ? await this.#options.controlPlane.pauseStrategy(instanceId, context)
      : await this.#options.controlPlane.resumeStrategy(instanceId, context);
    return result.ok
      ? json(200, { strategy: result.value, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  /**
   * A body door's refusal on a mutating route: audited, then answered with the
   * `400` the door's refusal has always produced.
   */
  async #doorRefused(
    operator: OperatorCredential,
    route: RouteDefinition,
    action: MutatingAuditAction,
    target: { readonly scope: string; readonly scopeRef: string | null },
    refusal: DoorRefusal,
  ): Promise<ApiResponse> {
    return this.#refusedBeforePlane(
      operator,
      route,
      action,
      target,
      "REQUEST_BODY",
      { code: `CONTROL_${refusal.code}`, detail: refusal.detail, issues: refusal.issues },
      doorProblem(refusal),
    );
  }

  async #engage(operator: OperatorCredential, route: RouteDefinition, request: ApiRequest): Promise<ApiResponse> {
    // A kill-switch body that never passed its door names no §14.1 scope this
    // process read, so its refusal is recorded against the control plane.
    const target = { scope: "CONTROL_PLANE", scopeRef: null };
    const transport = request.transportRefusal;
    if (transport !== undefined) {
      return this.#refusedBeforePlane(
        operator,
        route,
        "KILL_SWITCH_ENGAGE",
        target,
        "TRANSPORT",
        transport,
        transport.response,
      );
    }
    const parsed: DoorResult<KillSwitchEngageRequest> = engageDoor(request.body);
    if (!parsed.ok) return this.#doorRefused(operator, route, "KILL_SWITCH_ENGAGE", target, parsed.refusal);

    const context = this.#context(operator, parsed.value.reason);
    const result = await this.#options.controlPlane.engageKillSwitch(
      { scope: parsed.value.scope, scopeRef: parsed.value.scopeRef, action: parsed.value.action },
      context,
    );
    return result.ok
      ? json(200, { killSwitch: result.value, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  async #release(operator: OperatorCredential, route: RouteDefinition, request: ApiRequest): Promise<ApiResponse> {
    const target = { scope: "CONTROL_PLANE", scopeRef: null };
    const transport = request.transportRefusal;
    if (transport !== undefined) {
      return this.#refusedBeforePlane(
        operator,
        route,
        "KILL_SWITCH_RELEASE",
        target,
        "TRANSPORT",
        transport,
        transport.response,
      );
    }
    // A release with `authoritativeSnapshotApplied: false`, or without it, is
    // refused HERE by the schema's literal `true` — and, since `CONTROL-1` r1,
    // audited here too, with the door's issues naming the field.
    const parsed: DoorResult<KillSwitchReleaseRequest> = releaseDoor(request.body);
    if (!parsed.ok) return this.#doorRefused(operator, route, "KILL_SWITCH_RELEASE", target, parsed.refusal);

    const context = this.#context(operator, parsed.value.reason);
    const result = await this.#options.controlPlane.releaseKillSwitch(
      { scope: parsed.value.scope, scopeRef: parsed.value.scopeRef, release: parsed.value.release },
      context,
    );
    return result.ok
      ? json(200, { released: result.value.released, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  #health(overdue: OverdueRefreshes): ApiResponse {
    const report = this.#options.health.last();
    const refreshing = this.#options.refreshHealthOnRead === true;
    // `CTL2-F1`: a refresh this answer did not wait for is not current.
    const current = !overdue.health && this.#options.health.current;
    const deadline = `the ${String(this.#refreshDeadlineMs)} ms answer deadline`;
    return json(200, {
      available: this.#options.health.available,
      current,
      reads: this.#options.health.readCounts(),
      report: report ?? null,
      // `CONTROL-2`: open trader halts from ops.incidents — a separate fact
      // from the report above, which a trader that has exited no longer serves.
      traderHalts: traderHaltsDocument(this.#options.traderHalts, this.#haltView(overdue)),
      note:
        report === undefined
          ? "No trader health report has passed this API's door. " +
            (refreshing
              ? "This read asked the configured trader health endpoint and got no usable report " +
                (overdue.health ? `within ${deadline} ` : "") +
                "(see reads); the trader serves GET /health on the loopback when its " +
                "TRADER_HEALTH_BIND/TRADER_HEALTH_PORT are set, and pointing traderHealth.http at " +
                "it is this deployment's composition obligation."
              : "This deployment configured traderHealth.kind = none, so nothing is read; wiring " +
                "the trader's loopback GET /health as an http source is the composition obligation " +
                "this configuration has not discharged.")
          : `The report's asOf field states how old it is${
              current
                ? refreshing
                  ? " (this read refreshed it)"
                  : ""
                : overdue.health
                  ? `; this read's refresh did not answer within ${deadline}, and this report is retained from an ` +
                    "earlier read"
                  : "; the most recent read FAILED and this report is retained from an earlier one"
            }. Economic values in it are EXACT decimal strings and are never converted to numbers ` +
            "by this process.",
    });
  }

  #metrics(overdue: OverdueRefreshes): ApiResponse {
    const samples: PlatformMetricSample[] = [
      ...controlPlaneSamples({
        ...this.#options.controlPlane.runState(),
        allowRealOrders: false,
        modeRaiseAttemptsRefused: this.#options.controlPlane.modeRaiseAttemptsRefused,
        traderHealthAvailable: this.#options.health.available,
        // `CTL2-F1`: a refresh this answer did not wait for is not current.
        traderHealthCurrent: !overdue.health && this.#options.health.current,
        traderHealthReadsByOutcome: this.#options.health.readCounts(),
        strategyInstancesByState: countStates(this.#options.controlPlane),
        pausedInstanceIds: this.#options.controlPlane
          .strategies()
          .filter((entry) => entry.state === "PAUSED")
          .map((entry) => entry.instanceId),
        killSwitches: this.#options.controlPlane.killSwitches().map((entry) => ({
          scope: entry.scope,
          scopeRef: entry.scopeRef,
          action: entry.action,
        })),
        authenticationFailuresByReason: this.authenticationFailures(),
        authorizationFailuresByGrant: this.authorizationFailures(),
        mutationsByActionAndOutcome: this.#options.controlPlane.mutationCounts(),
        auditRecords: this.#options.auditSize(),
        auditCapacity: this.#options.auditCapacity,
        auditAppendFailures: this.#options.controlPlane.auditAppendFailures,
      }),
    ];

    const report = this.#options.health.last();
    if (report !== undefined) samples.push(...traderHealthSamples(report));
    // `CONTROL-2`: the trader halt families, always present (the state is
    // explicit); the open counts only after a read that succeeded — and
    // (`CTL2-F1`) UNKNOWN, never an earlier read's state, while this
    // request's read is outstanding.
    samples.push(...traderHaltSamples(this.#options.traderHalts, this.#haltView(overdue)));

    return {
      status: 200,
      contentType: "text/plain; version=0.0.4; charset=utf-8",
      body: renderExpositionFor(PLATFORM_METRIC_FAMILIES, samples),
    };
  }
}

function countStates(plane: ControlPlane): Readonly<Record<string, number>> {
  const counts = new Map<string, number>([
    ["RUNNING", 0],
    ["PAUSED", 0],
  ]);
  for (const entry of plane.strategies()) {
    counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  }
  return sortedCounts(counts);
}

function sortedCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key) ?? 0;
  return Object.freeze(out);
}

/** How much of a request's method and path a mode-raise record's reason keeps. */
export const MODE_RAISE_REASON_MAX_METHOD = 16;
export const MODE_RAISE_REASON_MAX_PATH = 128;

/**
 * The reason a mode-raise attempt's audit record carries (`CONTROL-1b`,
 * closing `CONTROL-1` follow-up 3b): the method and path, each BOUNDED, and the
 * forbidden keys — at most `REFUSAL_AUDIT_MAX_ISSUES` of them, then how many
 * more. At `CONTROL-1` it held the whole path and every key, so its size was
 * the caller's choice up to the transport's limits. The control plane cuts the
 * whole reason to `REFUSAL_AUDIT_MAX_TEXT` again, and escapes it, so this is
 * the legible bound and that is the fence.
 */
function modeRaiseReason(method: string, path: string, forbidden: readonly string[]): string {
  const shown = forbidden.slice(0, REFUSAL_AUDIT_MAX_ISSUES);
  const more = forbidden.length - shown.length;
  return (
    `request to ${boundAuditText(method, MODE_RAISE_REASON_MAX_METHOD)} ` +
    `${boundAuditText(path, MODE_RAISE_REASON_MAX_PATH)} named ${shown.join(", ")}` +
    (more > 0 ? ` and ${String(more)} more` : "")
  );
}

function doorProblem(refusal: {
  readonly code: string;
  readonly detail: string;
  readonly issues: readonly string[];
}): ApiResponse {
  return problem(400, `CONTROL_${refusal.code}`, refusal.detail, refusal.issues);
}

function mutationProblem(code: string, detail: string): ApiResponse {
  // A mutation the control plane refused because it could not be AUDITED is a
  // 503, not a 400: the request was well-formed and the system is unable to
  // serve it safely. Everything else — including `CONTROL_UNKNOWN_INSTANCE`,
  // the strategy twin of `CONTROL_NOT_ENGAGED` (`CONTROL-1`, M-1) — is a 409
  // the caller can act on.
  return problem(code === "CONTROL_NOT_AUDITABLE" ? 503 : 409, code, detail);
}
