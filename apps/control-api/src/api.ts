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
 * Every value handed here is plain: the control plane's frozen literals, the
 * health cache's materialized report, the problem records built here. A
 * value it refuses is a defect in this process, and `handle()`'s outer guard
 * turns the throw into the `CONTROL_INTERNAL_ERROR` refusal — whose own body
 * is a plain record this encoder cannot refuse.
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
        return this.#read(operator, () => this.#health());

      case "GET /v1/metrics":
        return this.#read(operator, () => this.#metrics());

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
    return json(200, {
      available: this.#options.health.available,
      reads: this.#options.health.readCounts(),
      report: report ?? null,
      note:
        report === undefined
          ? "No trader health report has passed this API's door. apps/trader does not expose an " +
            "HTTP health endpoint today; wiring one is a documented composition obligation, not a " +
            "claim this deployment has discharged."
          : "The report's asOf field states how old it is. Economic values in it are EXACT " +
            "decimal strings and are never converted to numbers by this process.",
    });
  }

  #metrics(): ApiResponse {
    const samples: PlatformMetricSample[] = [
      ...controlPlaneSamples({
        ...this.#options.controlPlane.runState(),
        allowRealOrders: false,
        modeRaiseAttemptsRefused: this.#options.controlPlane.modeRaiseAttemptsRefused,
        traderHealthAvailable: this.#options.health.available,
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
