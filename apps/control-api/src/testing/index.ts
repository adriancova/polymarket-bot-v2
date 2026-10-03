/**
 * Test-only builders for `apps/control-api`.
 *
 * Exported as a package subpath so `test/integration/control-api/**` can drive
 * the REAL API without redefining its fixtures — the `apps/trader/src/testing`
 * precedent. Nothing in `src/` outside this directory imports it.
 *
 * **No fixture here carries a credential value that could be mistaken for a
 * real one.** Every token is obviously fake and says so in its own text.
 */

import type { InMemoryControlAuditLog, TraderHealthReportInput } from "@polymarket-bot/observability";

import { ControlApi, type ApiEnvironment } from "../api.js";
import { createBudgetedAuditLog, type SafetyReservedAuditSink } from "../audit-budget.js";
import { OperatorRegistry, type OperatorGrant } from "../auth.js";
import { ControlPlane } from "../control-plane.js";
import type { TraderHealthDocument } from "../health-door.js";
import { InMemoryTraderHealthSource, TraderHealthCache } from "../health-source.js";
import { CONTROL_API_RUN_MODE, REPOSITORY_MAXIMUM_RUN_MODE } from "../safety.js";

/**
 * Obviously-fake operator tokens, long enough to pass the weakness check.
 *
 * The string says what it is. A fixture credential that LOOKED plausible would
 * be a credential someone eventually pastes into a deployment.
 */
export const FAKE_OPERATOR_TOKEN =
  "fake-paper-operator-token-not-a-credential-0001" as const;
export const FAKE_READER_TOKEN =
  "fake-paper-readonly-token-not-a-credential-0002" as const;

/** A deterministic clock and id source: same sequence in, same audit log out. */
export class ScriptedEnvironment implements ApiEnvironment {
  #instant = 0;
  #record = 0;

  now(): string {
    this.#instant += 1;
    // One second per call from 2026-09-05T00:00:00Z. Byte-identical to the
    // earlier `00:00:${n}` spelling for the first 59 calls, and still a valid
    // strict-UTC instant after them (`CONTROL-1`'s adversarial suite makes
    // hundreds of calls; the old spelling produced `00:00:350.000Z`).
    return new Date(Date.UTC(2026, 8, 5, 0, 0, this.#instant)).toISOString();
  }

  nextAuditRecordId(): string {
    this.#record += 1;
    // Shaped like a UUIDv7 (version nibble 7, variant nibble 8) so a fixture
    // record id would satisfy `internal.uuid_v7` if it ever reached the
    // database. It does not — the in-memory sink is what these suites use.
    return `01930000-0000-7000-8000-${String(this.#record).padStart(12, "0")}`;
  }
}

export interface HarnessOptions {
  readonly auditCapacity?: number;
  /**
   * The audit budget's safety reserve (`audit-budget.ts`). Defaults to `0` —
   * `WP-240`'s single bound, which the pre-`CONTROL-1` suites measure. The
   * configuration door refuses `0`, so the SHIPPED composition always has a
   * reserve; a suite measuring the budget passes one explicitly.
   */
  readonly auditSafetyReserve?: number;
  readonly operators?: readonly {
    readonly operatorId: string;
    readonly token: string;
    readonly grants: readonly OperatorGrant[];
  }[];
  readonly healthDocument?: unknown;
}

export interface Harness {
  readonly api: ControlApi;
  readonly controlPlane: ControlPlane;
  readonly audit: InMemoryControlAuditLog;
  /** The budget the control plane writes through, in front of {@link Harness.audit}. */
  readonly auditBudget: SafetyReservedAuditSink;
  readonly health: TraderHealthCache;
  readonly healthSource: InMemoryTraderHealthSource;
  readonly environment: ScriptedEnvironment;
}

/**
 * Builds the REAL API over the REAL control plane and the REAL append-only log,
 * behind the REAL audit budget — the composition `main.ts` builds, through the
 * same `createBudgetedAuditLog`.
 *
 * The only doubled thing is the trader health SOURCE, which stands in for a
 * process this repository cannot start from here (see `health-source.ts`).
 * Nothing else is a stub.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const { log: audit, sink: auditBudget } = createBudgetedAuditLog({
    capacity: options.auditCapacity ?? 64,
    safetyReserve: options.auditSafetyReserve ?? 0,
  });
  const environment = new ScriptedEnvironment();
  const controlPlane = new ControlPlane({
    audit: auditBudget,
    runMode: CONTROL_API_RUN_MODE,
    maximumRunMode: CONTROL_API_RUN_MODE,
    repositoryMaximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
    // As `main.ts`: a void record's instant and id come from the API's
    // environment. The in-memory log answers at once, so this draws nothing
    // from the scripted sequence unless an append outlives its bound.
    auditRecordSource: environment,
  });
  const healthSource = new InMemoryTraderHealthSource(options.healthDocument);
  const health = new TraderHealthCache(healthSource);

  const api = new ControlApi({
    operators: new OperatorRegistry([
      ...(options.operators ?? [
        {
          operatorId: "operator-a",
          token: FAKE_OPERATOR_TOKEN,
          grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const,
        },
        { operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] as const },
      ]),
    ]),
    controlPlane,
    health,
    environment,
    auditCapacity: options.auditCapacity ?? 64,
    auditSize: () => audit.size,
  });

  return { api, controlPlane, audit, auditBudget, health, healthSource, environment };
}

/** `Authorization` header value for a token. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/**
 * A complete trader health document.
 *
 * Structurally what `apps/trader`'s `HealthSnapshot` serializes to. The
 * INTEGRATION suite does not use this — it builds one from the real
 * `HealthState` class — so this fixture is the unit suites' input and the
 * drift between the two is exactly what that integration test measures.
 */
export function healthDocument(
  overrides: Partial<TraderHealthReportInput> = {},
): TraderHealthReportInput {
  const base: TraderHealthDocument = {
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    healthy: true,
    halts: [],
    queues: [
      {
        name: "market-events",
        currentDepth: 2,
        maximumDepth: 1024,
        oldestMessageAgeMs: 17,
        messagesDropped: 0,
        producerBlockedMs: 0,
        consumerLag: 1,
        accepted: 40,
        consumed: 39,
      },
    ],
    loop: {
      eventsAccepted: 40,
      eventsProcessed: 39,
      eventsRefused: 0,
      featureSnapshots: 12,
      snapshotsUnavailable: 3,
      featureProjectionRefusals: 0,
      evaluations: 12,
      decisionsPersisted: 12,
      containedEvaluations: 0,
      refusedEvaluations: 0,
      deliveriesSuppressedByHalt: 0,
    },
    risk: {
      evaluations: 6,
      approvals: 4,
      refusals: 2,
      refusalsByCode: { RISK_NO_NET_EDGE: 2 },
      refusedExits: 1,
      refusedExitsByCode: { RISK_NO_NET_EDGE: 1 },
      recommendationsByAction: {},
    },
    execution: {
      plansBuilt: 4,
      plansRefused: 0,
      submissionsAccepted: 4,
      submissionsRefused: 0,
      fillsObserved: 3,
      duplicateFillsRefused: 1,
      cancelsRequested: 1,
      cancelsConfirmed: 1,
      cancelsRejected: 0,
      cancelsSilenceExceeded: 0,
      allocationsRefused: 0,
      reservationsReleasedOnRefusal: 0,
      observeOnlyIntents: 2,
    },
    accounting: {
      ledgerTransactions: 7,
      ledgerRefusals: 0,
      unattributedActivity: 0,
      unexplainedMovements: 0,
      pnlRecords: 3,
      // `TRDR-3`: exact decimal strings, as the trader's health surface
      // carries them; `account` is the trader's exact sum.
      realizedPnl: { byInstance: { "sb-1": "-1.2" }, account: "-1.2" },
    },
    seams: {
      fills: { remembered: 3, maximumRemembered: 4096, admitted: 3, refused: 1, evictions: 0 },
      reservations: { open: 1, taken: 4, released: 3, reservedCollateral: "12.50" },
      cancels: { pending: 0, requested: 1, confirmed: 1, rejected: 0, silenceExceeded: 0 },
      orderViews: { emitted: 9, repeats: 2, tracked: 4 },
      allocator: {
        open: 1,
        applied: 4,
        released: 3,
        reservedCollateral: "12.50",
        refusalsByCode: {},
      },
      // `TRDR-4`: the trader loop's per-order state and its audit logs'
      // bounded retention, as `CoreLoop.health()` always publishes them.
      orders: {
        tracked: 1,
        settled: 3,
        tombstones: 3,
        maximumTombstones: 100_000,
        tombstoneEvictions: 0,
        unownedFills: 0,
        lateFillsAfterSettlement: 0,
        settleMismatches: 0,
      },
      retention: {
        decisions: { retained: 12, maximumRetained: 100_000, evicted: 0 },
        traces: { retained: 3, maximumRetained: 50_000, evicted: 0 },
        provenance: { retained: 4, maximumRetained: 50_000, evicted: 0 },
      },
      // `FOLD-1`: the trader loop's held accounting state, as
      // `CoreLoop.health()` always publishes it — the PAPER cadence, three
      // posted fills, no check due yet, nothing refused.
      folds: {
        checkEveryFills: 50,
        pnlCheck: false,
        fillsPosted: 3,
        ledgerChecks: 0,
        pnlChecks: 0,
        fillsAtLastCheck: null,
        ledgerMismatches: 0,
        pnlMismatches: 0,
        pnlRefusals: {},
      },
    },
    // `THROUGHPUT-1a`: the input stream's lag, as a trader with a sampler
    // attached reports it — 250 events behind the head, 1.5 s behind the
    // market.
    transport: {
      attached: true,
      sampleIntervalMs: 1000,
      samples: 42,
      sampleFailures: 0,
      sampledAt: "2026-09-05T00:00:11.400Z",
      sampleAgeMs: 600,
      headPosition: 5250,
      consumerPosition: 5000,
      committedPosition: 4990,
      entriesBehindHead: 250,
      retentionMaxEvents: 100_000,
      lastEventAt: "2026-09-05T00:00:10.500Z",
      eventTimeLagMs: 1500,
    },
    riskSeamCaveat: "WP-220 accepted residual: protective exits are classified ENTRY.",
    asOf: "2026-09-05T00:00:10.000Z",
  };
  return { ...base, ...overrides };
}
