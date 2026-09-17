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
 *    when it is full.
 * 2. **Read the body through the door** (D1-D4), bounded in size by the
 *    transport before it ever gets here.
 * 3. **Refuse a mode-raise attempt BY NAME**, and audit it. This runs before
 *    authorization on purpose: an authenticated operator who lacks
 *    `KILL_SWITCH` and sends `{"runMode":"LIVE"}` should be recorded as having
 *    attempted the mode raise, which is the more interesting fact.
 * 4. **Authorize** against the route's explicit grant (§15).
 * 5. **Act**, through the control plane, which audits before it applies.
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
 * (`refreshHealthOnRead`); a `none` source is never read, so its metrics body
 * is byte-identical to `WP-240`'s (no `control_trader_health_reads_total`
 * line, `control_trader_health_available 0`).
 */

import {
  controlPlaneSamples,
  renderExpositionFor,
  traderHealthSamples,
  PLATFORM_METRIC_FAMILIES,
  type PlatformMetricSample,
} from "@polymarket-bot/observability";
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import { hasGrant, type OperatorCredential, type OperatorGrant, type OperatorRegistry } from "./auth.js";
import type { ControlPlane, KillSwitchRelease, MutationContext } from "./control-plane.js";
import {
  buildDoor,
  ownBoolean,
  ownString,
  type DoorResult,
} from "./doors.js";
import type { TraderHealthCache } from "./health-source.js";
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
  /** Already-parsed JSON body, or `undefined` for a body-less request. */
  readonly body: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** The clock and id source the API refuses to invent. */
export interface ApiEnvironment {
  /** Strict-UTC instant for this request. */
  now(): string;
  /** A fresh, sortable, unique audit record id. */
  nextAuditRecordId(): string;
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
}

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
  /** The one refresh in flight, shared by concurrent authorized reads (`#readFresh`). */
  #refreshInFlight: Promise<unknown> | undefined;

  constructor(options: ControlApiOptions) {
    this.#options = options;
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

    // 3 (pre-empting authorization, deliberately — see the module header).
    if (request.body !== undefined) {
      const forbidden = forbiddenControlKeysIn(request.body);
      if (forbidden.length > 0) {
        await this.#options.controlPlane.refuseModeRaise(forbidden, {
          actor: operator.operatorId,
          at: this.#options.environment.now(),
          auditRecordId: this.#options.environment.nextAuditRecordId(),
          reason: `request to ${request.method} ${request.path} named ${forbidden.join(", ")}`,
        });
        return problem(
          403,
          "CONTROL_MODE_RAISE_REFUSED",
          "this API cannot raise a run mode, enable real orders, raise a live-micro cap, or " +
            "reference a signer: §11's ceiling is a startup value and is not writable here, and " +
            "§4.1 gives this process no signing key. The request named " +
            `${forbidden.join(", ")} and is refused by name; the attempt has been audited.`,
          forbidden,
        );
      }
    }

    const route = `${request.method} ${request.path}`;

    switch (route) {
      case "GET /v1/run-state":
        return this.#read(operator, () => json(200, this.#options.controlPlane.runState()));

      case "GET /v1/strategies":
        return this.#read(operator, () =>
          json(200, { strategies: this.#options.controlPlane.strategies() }),
        );

      case "GET /v1/kill-switch":
        return this.#read(operator, () =>
          json(200, { killSwitches: this.#options.controlPlane.killSwitches() }),
        );

      case "GET /v1/health":
        return await this.#readFresh(operator, () => this.#health());

      case "GET /v1/metrics":
        return await this.#readFresh(operator, () => this.#metrics());

      case "POST /v1/kill-switch":
        return this.#engage(operator, request);

      case "POST /v1/kill-switch/release":
        return this.#release(operator, request);

      default:
        break;
    }

    const strategy = /^\/v1\/strategies\/([^/]+)\/(pause|resume)$/u.exec(request.path);
    if (strategy !== null && request.method === "POST") {
      return this.#strategy(operator, request, decodeURIComponent(strategy[1] ?? ""), strategy[2] === "pause");
    }

    return problem(
      404,
      "CONTROL_NO_SUCH_ROUTE",
      `${route} is not a route this API serves. It serves run-state reads, strategy pause/resume, ` +
        "§14.1 kill-switch engage/release, the health read and the metrics surface — and nothing " +
        "that places an order, moves a wallet, or changes a run mode.",
    );
  }

  #read(operator: OperatorCredential, produce: () => ApiResponse): ApiResponse {
    const refusal = this.#authorize(operator, "READ");
    return refusal ?? produce();
  }

  /**
   * An authorized read that REFRESHES the trader health cache first when the
   * composition asked for it (module header, "Refresh-on-read"). The refusal
   * path is `#read`'s: an unauthorized operator triggers no trader request.
   * Single-flight: concurrent reads share one in-flight refresh, so a burst of
   * scrapes is one loopback GET. A refresh never throws — the cache answers
   * every failure as data and counts it — so `produce` always runs.
   */
  async #readFresh(operator: OperatorCredential, produce: () => ApiResponse): Promise<ApiResponse> {
    const refusal = this.#authorize(operator, "READ");
    if (refusal !== undefined) return refusal;
    if (this.#options.refreshHealthOnRead === true) {
      this.#refreshInFlight ??= this.#options.health.refresh().finally(() => {
        this.#refreshInFlight = undefined;
      });
      await this.#refreshInFlight;
    }
    return produce();
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
    request: ApiRequest,
    instanceId: string,
    pause: boolean,
  ): Promise<ApiResponse> {
    const refusal = this.#authorize(operator, "STRATEGY_CONTROL");
    if (refusal !== undefined) return refusal;

    const parsed: DoorResult<StrategyRequest> = strategyDoor(request.body);
    if (!parsed.ok) return doorProblem(parsed.refusal);
    if (instanceId === "") {
      return problem(400, "CONTROL_INVALID_ROUTE_PARAMETER", "the strategy instance id is empty");
    }

    const context = this.#context(operator, parsed.value.reason);
    const result = pause
      ? await this.#options.controlPlane.pauseStrategy(instanceId, context)
      : await this.#options.controlPlane.resumeStrategy(instanceId, context);
    return result.ok
      ? json(200, { strategy: result.value, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  async #engage(operator: OperatorCredential, request: ApiRequest): Promise<ApiResponse> {
    const refusal = this.#authorize(operator, "KILL_SWITCH");
    if (refusal !== undefined) return refusal;

    const parsed: DoorResult<KillSwitchEngageRequest> = engageDoor(request.body);
    if (!parsed.ok) return doorProblem(parsed.refusal);

    const context = this.#context(operator, parsed.value.reason);
    const result = await this.#options.controlPlane.engageKillSwitch(
      { scope: parsed.value.scope, scopeRef: parsed.value.scopeRef, action: parsed.value.action },
      context,
    );
    return result.ok
      ? json(200, { killSwitch: result.value, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  async #release(operator: OperatorCredential, request: ApiRequest): Promise<ApiResponse> {
    const refusal = this.#authorize(operator, "KILL_SWITCH");
    if (refusal !== undefined) return refusal;

    const parsed: DoorResult<KillSwitchReleaseRequest> = releaseDoor(request.body);
    if (!parsed.ok) return doorProblem(parsed.refusal);

    const context = this.#context(operator, parsed.value.reason);
    const result = await this.#options.controlPlane.releaseKillSwitch(
      { scope: parsed.value.scope, scopeRef: parsed.value.scopeRef, release: parsed.value.release },
      context,
    );
    return result.ok
      ? json(200, { released: result.value.released, auditRecordId: context.auditRecordId })
      : mutationProblem(result.code, result.detail);
  }

  #health(): ApiResponse {
    const report = this.#options.health.last();
    const refreshing = this.#options.refreshHealthOnRead === true;
    return json(200, {
      available: this.#options.health.available,
      current: this.#options.health.current,
      reads: this.#options.health.readCounts(),
      report: report ?? null,
      note:
        report === undefined
          ? "No trader health report has passed this API's door. " +
            (refreshing
              ? "This read asked the configured trader health endpoint and got no usable report " +
                "(see reads); the trader serves GET /health on the loopback when its " +
                "TRADER_HEALTH_BIND/TRADER_HEALTH_PORT are set, and pointing traderHealth.http at " +
                "it is this deployment's composition obligation."
              : "This deployment configured traderHealth.kind = none, so nothing is read; wiring " +
                "the trader's loopback GET /health as an http source is the composition obligation " +
                "this configuration has not discharged.")
          : `The report's asOf field states how old it is${
              this.#options.health.current
                ? refreshing
                  ? " (this read refreshed it)"
                  : ""
                : "; the most recent read FAILED and this report is retained from an earlier one"
            }. Economic values in it are EXACT decimal strings and are never converted to numbers ` +
            "by this process.",
    });
  }

  #metrics(): ApiResponse {
    const samples: PlatformMetricSample[] = [
      ...controlPlaneSamples({
        ...this.#options.controlPlane.runState(),
        allowRealOrders: false,
        modeRaiseAttemptsRefused: this.#options.controlPlane.modeRaiseAttemptsRefused,
        traderHealthAvailable: this.#options.health.available,
        traderHealthCurrent: this.#options.health.current,
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
  // serve it safely. Everything else the caller can fix.
  return problem(code === "CONTROL_NOT_AUDITABLE" ? 503 : 409, code, detail);
}

/** The routes this API serves, for the README and the route-inventory test. */
export const CONTROL_API_ROUTES: readonly string[] = Object.freeze([
  "GET /v1/run-state",
  "GET /v1/strategies",
  "GET /v1/kill-switch",
  "GET /v1/health",
  "GET /v1/metrics",
  "POST /v1/strategies/:instanceId/pause",
  "POST /v1/strategies/:instanceId/resume",
  "POST /v1/kill-switch",
  "POST /v1/kill-switch/release",
]);
