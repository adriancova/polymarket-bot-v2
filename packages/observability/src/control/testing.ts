/**
 * Fully-populated input fixtures for this package's own suites.
 *
 * "Fully populated" is the load-bearing property: `metric-families.test.ts`
 * proves that every declared family has a producer by rendering these and
 * comparing the emitted names against the table, so a fixture that left a
 * section empty would silently weaken that proof. Every map-valued field
 * therefore has at least two entries (so sorting is observable), every counter
 * has a distinct value (so a mis-wired mapping is visible rather than
 * coincidentally equal), and the two decimal strings are values a float64
 * cannot represent.
 *
 * Package-internal by design: it is not exported from `./index.js`, because a
 * production entry point that exports fixtures invites a production caller.
 */

import type { ControlPlaneMetricsInput, TraderHealthReportInput } from "./metric-shapes.js";

/**
 * A health report with every section populated.
 *
 * The numbers are deliberately all different: a mapping that read
 * `loop.eventsProcessed` where it meant `loop.eventsAccepted` would produce an
 * equal value under a fixture of zeros and pass.
 */
export function fullTraderHealthReport(
  overrides: Partial<TraderHealthReportInput> = {},
): TraderHealthReportInput {
  const base: TraderHealthReportInput = {
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    healthy: false,
    halts: [
      {
        scope: { kind: "GLOBAL" },
        code: "STORE_UNAVAILABLE",
        detail: "the durable store failed",
        at: "2026-09-05T00:00:01.000Z",
        action: "FULL_HALT",
      },
      {
        scope: { kind: "MARKET", marketId: "market-1" },
        code: "UNATTRIBUTED_ACTIVITY",
        detail: "unattributed actual activity",
        at: "2026-09-05T00:00:02.000Z",
        action: "RECONCILE_ACCOUNT",
      },
      {
        scope: { kind: "STRATEGY_INSTANCE", instanceId: "sb-1" },
        code: "OPERATOR_HALT",
        detail: "operator requested",
        at: "2026-09-05T00:00:03.000Z",
        action: "FULL_HALT",
      },
    ],
    queues: [
      {
        name: "market-events",
        currentDepth: 3,
        maximumDepth: 1024,
        oldestMessageAgeMs: 41,
        messagesDropped: 0,
        producerBlockedMs: 7,
        consumerLag: 2,
        accepted: 512,
        consumed: 510,
      },
      {
        // An EMPTY queue: `oldestMessageAgeMs` is null and must be OMITTED, not
        // rendered as 0. `samples.test.ts` asserts the omission.
        name: "fills",
        currentDepth: 0,
        maximumDepth: 256,
        oldestMessageAgeMs: null,
        messagesDropped: 0,
        producerBlockedMs: 0,
        consumerLag: 0,
        accepted: 9,
        consumed: 9,
      },
    ],
    loop: {
      eventsAccepted: 101,
      eventsProcessed: 102,
      eventsRefused: 103,
      featureSnapshots: 104,
      snapshotsUnavailable: 105,
      featureProjectionRefusals: 106,
      evaluations: 107,
      decisionsPersisted: 108,
      containedEvaluations: 109,
      refusedEvaluations: 110,
      deliveriesSuppressedByHalt: 111,
    },
    risk: {
      evaluations: 201,
      approvals: 202,
      refusals: 203,
      refusalsByCode: { RISK_STALE_INPUT: 5, RISK_NO_NET_EDGE: 9 },
      refusedExits: 204,
      refusedExitsByCode: { RISK_ENTRY_CUTOFF: 2, RISK_NO_NET_EDGE: 7 },
      recommendationsByAction: { CANCEL_RESTING_ORDERS: 1, RECONCILE_ACCOUNT: 3 },
    },
    execution: {
      plansBuilt: 301,
      plansRefused: 302,
      submissionsAccepted: 303,
      submissionsRefused: 304,
      fillsObserved: 305,
      duplicateFillsRefused: 306,
      cancelsRequested: 307,
      cancelsConfirmed: 308,
      cancelsRejected: 309,
      cancelsSilenceExceeded: 310,
      allocationsRefused: 311,
      reservationsReleasedOnRefusal: 312,
      observeOnlyIntents: 313,
    },
    accounting: {
      ledgerTransactions: 401,
      ledgerRefusals: 402,
      unattributedActivity: 403,
      unexplainedMovements: 404,
      pnlRecords: 405,
      realizedPnl: {
        // Two instances, keyed out of order so sorting is observable; each
        // value is one a float64 cannot represent (37 significant digits, and
        // 20). The account line is a fixture string too — this package never
        // adds decimals, it carries what the trader computed.
        byInstance: {
          "sb-2": "-0.1000000000000000055511151231257827",
          "sb-1": "12345678901234567890.12345",
        },
        account: "12345678901234567890.0234499999999999944488848768742173",
      },
    },
    seams: {
      fills: {
        remembered: 501,
        maximumRemembered: 502,
        admitted: 503,
        refused: 504,
        evictions: 505,
      },
      reservations: {
        open: 506,
        taken: 507,
        released: 508,
        // 0.1 + 0.2 in float64 is 0.30000000000000004. This value must survive
        // the exporter byte for byte.
        reservedCollateral: "0.30",
      },
      cancels: {
        pending: 509,
        requested: 510,
        confirmed: 511,
        rejected: 512,
        silenceExceeded: 513,
      },
      orderViews: { emitted: 514, repeats: 515, tracked: 516 },
      allocator: {
        open: 517,
        applied: 518,
        released: 519,
        // 20 significant digits: float64 carries ~15-17.
        reservedCollateral: "12345678901234567890.12345",
        refusalsByCode: { CAPITAL_CAP_EXCEEDED: 4, CAPITAL_LIVE_OWNERSHIP_MISSING: 6 },
      },
    },
    transport: {
      attached: true,
      sampleIntervalMs: 1000,
      samples: 601,
      sampleFailures: 602,
      sampledAt: "2026-09-05T00:00:03.500Z",
      sampleAgeMs: 603,
      headPosition: 604,
      consumerPosition: 605,
      committedPosition: 606,
      entriesBehindHead: 607,
      retentionMaxEvents: 608,
      lastEventAt: "2026-09-05T00:00:03.000Z",
      eventTimeLagMs: 609,
    },
    riskSeamCaveat: "WP-220 accepted residual: …",
    asOf: "2026-09-05T00:00:04.000Z",
  };
  return { ...base, ...overrides };
}

/** A control-plane snapshot with every section populated. */
export function fullControlPlaneInput(
  overrides: Partial<ControlPlaneMetricsInput> = {},
): ControlPlaneMetricsInput {
  const base: ControlPlaneMetricsInput = {
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
    allowRealOrders: false,
    modeRaiseAttemptsRefused: 2,
    traderHealthAvailable: true,
    traderHealthCurrent: false,
    traderHealthReadsByOutcome: { OK: 11, REFUSED: 1, UNAVAILABLE: 3 },
    strategyInstancesByState: { PAUSED: 1, RUNNING: 2 },
    pausedInstanceIds: ["sb-2"],
    killSwitches: [
      { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" },
      { scope: "MARKET", scopeRef: "market-1", action: "CANCEL_MARKET" },
    ],
    authenticationFailuresByReason: { MISSING_CREDENTIAL: 4, UNKNOWN_CREDENTIAL: 2 },
    authorizationFailuresByGrant: { KILL_SWITCH: 1, STRATEGY_CONTROL: 3 },
    mutationsByActionAndOutcome: [
      { action: "STRATEGY_PAUSE", outcome: "APPLIED", count: 5 },
      { action: "KILL_SWITCH_ENGAGE", outcome: "REFUSED", count: 2 },
    ],
    auditRecords: 7,
    auditCapacity: 4096,
    auditAppendFailures: 1,
  };
  return { ...base, ...overrides };
}
