/**
 * The live-safety composition (WP-320 deliverable 3): the fencing authority,
 * the seven-input health lease, kill-switch enforcement, venue eligibility,
 * the D6 lapse recovery and the live gate, assembled for a LIVE composition
 * root.
 *
 * ## NOT WIRED INTO `main.ts` (disclosed)
 *
 * `apps/trader/src/main.ts` builds the PAPER trader and is not this package's
 * path. Nothing in this repository calls {@link createLiveSafety}: it is
 * exposed, from `./index.ts`, for the live composition that a later,
 * separately authorized package writes. It reads the process's RUN-MODE
 * CONTEXT first (`runMode`, `maximumRunMode`, `allowRealOrders`, the context
 * `assertSignerGate` reads) and refuses unless the run mode submits real
 * orders, does not exceed the ceiling, and real orders are allowed (r1,
 * finding I8). So under the repository's defaults (`MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`) no process whose composition root passes its
 * true context can build one. As with the signer gate, a root that lies about
 * its own context is not detectable here.
 *
 * ## How a live composition root uses it
 *
 * ```text
 * const omsProgress = new OmsProgressMonitor({ clock });   // r1 I5: the OMS input's evidence
 * let oms = null;                                           // opened below, over the fenced venue
 * const safety = createLiveSafety({
 *   runModeContext,                                        // RUN_MODE, MAX_RUN_MODE, ALLOW_REAL_ORDERS (r1 I8)
 *   oms: { get faulted() { … oms … }, orders: …, requestOrderReconciliation: … }, // a view bound to `oms` once open
 *   killSwitch: { …, releaseSettleMs, releaseFinality },   // r2 X2: POSITIVE evidence a release was applied
 *   fencing: { ttlMs, … },                                // r2 X1: ttlMs ≤ FENCING_LEASE_MAX_TTL_MS, the bound every successor waits out
 *   omsProgress, accountRef, …ports,
 * });
 * oms = await OrderManager.open(omsProgress.dependencies({   // r2 X4: store, reservations AND cipher timed
 *   store, reservations, cipher,
 *   venue: safety.fenceVenue(secureClient, refusals, classifier), // per-order scope (r1 I2); placements tracked (r2 X3)
 *   …,
 * }));
 * let fence = await safety.acquireFence();                  // ADR-008 §1–§2; LAPSED_WAITING: ask again after remainingMs
 * const controller = createOrderHeartbeatController({      // polymarket-secure, ADR-033 D4
 *   runModeContext, transport,                             // the transport: ADR-033 D5, open
 *   gate: safety.heartbeatGate,                            // fence AND health lease (D1 item 2)
 *   heartbeatIds: safety.heartbeatIdSink,                  // ADR-008 §4
 *   initialHeartbeatId: fence.inheritedHeartbeatId ?? "",
 *   onEvent: safety.onHeartbeatEvent, budget, clock, timers,
 * });
 * safety.attachHeartbeat(controller);
 * safety.start(); controller.start();                      // starts lapsed (D6)
 * // WP-290's halts: read from `coordinator.quarantinedBreaks()` by the gate at every ask (C1-OMS06)
 * // every decision: safety.gate({ kind: "NEW_ENTRY" | "REDUCTION", marketId, instanceId })
 * // every budget poll's events: controller.onBudgetEvents(events)
 * // every periodic reconcile: safety.recordReconcileReport(report, calledAtMs)
 * // market data / user stream evidence: safety.recordProof("MARKET_DATA" | "USER_DATA", atMs)
 * ```
 *
 * The composition passes ONE monotonic clock to this class and to the
 * controller: D6's lapse end is timed by the controller and recovered here.
 *
 * ## The heartbeat gate (ADR-033 D1 item 2)
 *
 * `{ permitted: true }` only while ALL hold, each read at that moment: the
 * fence is held with its transmit margin; the health lease's seven inputs
 * prove themselves (kill-switch state among them: an engaged GLOBAL or
 * own-ACCOUNT switch that ends trading fails it, a MARKET or
 * STRATEGY_INSTANCE switch never does); and no explicit stop is in force
 * (§9.9's "Stop heartbeat", `ops-cli stop-heartbeat`, or a live-fencing
 * conflict, each latched until an operator releases it, D1 item 4).
 *
 * ## The health inputs, and who proves each
 *
 * | Input | Proved by |
 * | --- | --- |
 * | MARKET_DATA, USER_DATA | the composition: {@link LiveSafety.recordProof} on fresh evidence |
 * | EVENT_LOOP | this class's event-loop probe (a timer that must fire on time) |
 * | OMS | the OMS not faulted, AND its progress monitor (`oms-progress.ts`): nothing until its store, reservation port AND cipher are all instrumented (r2 X4), then proved at the start of its oldest call still pending on any of them, so a hung persistence call ages it out (r1 I5) |
 * | DATABASE | every fence renewal and kill-switch read that succeeds; each failure fails it |
 * | RECONCILER | ONLY a reconcile report with a run that PASSED and resumed, proved at the instant before the `reconcile()` call that ran it; a FAILED or QUARANTINED run proves nothing, so a reconciler that keeps failing ages the input out and the heartbeat stops (r1 I3; §9.9 "Account state unknown → Stop heartbeat") |
 * | KILL_SWITCH | the latest kill-switch read: succeeded, and not ending trading |
 *
 * ## Kill-switch cancels: an OBLIGATION, held until the scope is quiescent (r1 I2; r2 X3)
 *
 * After every successful read, each cancel an engaged switch asks for
 * (`kill-switch.ts`) is a standing obligation, discharged through the
 * injected {@link KillSwitchCancelPort} (`true` = accepted):
 *
 * | Pass | When |
 * | --- | --- |
 * | `FIRST` | at every read until the port first accepts it |
 * | `CONFIRMING` | once, at the first read at least one refresh interval after the latest acceptance (r1 I2) |
 * | `AFTER_SETTLE` | at the first read after a placement IN THE DIRECTIVE'S SCOPE settled at or after the latest accepted request STARTED (r2 X3), whatever the spacing |
 * | `RETAINED` | after the confirming pass, at most once per refresh interval, while a placement in the scope is still pending, or while the OMS shows an order that rests or may rest at the venue and that is not PROVED to be outside the scope (r2 X3; r3 J1) |
 *
 * ### Every request is a numbered ATTEMPT with a deadline (r3, finding J2)
 *
 * The port is the composition's (WP-260's client puts no deadline on a venue
 * call, `oms-progress.ts`), so a request may never answer. At round 2 the
 * obligation waited on its request for good: one cancel that never settled
 * stopped every later cancel of that switch, while health stayed green and a
 * MARKET or STRATEGY_INSTANCE switch kept the heartbeat running (both
 * verifiers' reproduction: one call, the order resting, twelve more
 * heartbeats in 60 s). Now:
 *
 * - each request is an attempt with its own number; the obligation waits on at
 *   most ONE attempt, and only that attempt's answer may discharge a pass;
 * - an attempt not answered within `cancelTimeoutMs` (default: one refresh
 *   interval; at most the KILL_SWITCH input's maximum age) is ABANDONED by the
 *   first read that finds it so: journalled (`outcome: "ABANDONED"`), paged
 *   once per obligation (`KILL_SWITCH_CANCEL_UNANSWERED`), and the
 *   obligation's due pass — which the abandoned attempt did not discharge —
 *   is requested again at that same read;
 * - an abandoned attempt's answer, when it comes, is DISCARDED (journalled as
 *   `KILL_SWITCH_CANCEL_LATE_ANSWER_DISCARDED`): it neither discharges a pass
 *   nor touches the newer attempt;
 * - the attempts of one read run side by side, so one directive's silence
 *   never delays another's request.
 *
 * Paging is the operator's signal; it is not the enforcement. A MARKET or
 * STRATEGY_INSTANCE switch still never stops the heartbeat (ADR-033 D1
 * item 3): the venue would cancel every order under the credentials.
 *
 * ### A cancel stranded BENEATH the OMS (r4, finding CX320-R4-01)
 *
 * The attempt deadline above bounds the composition's own request, not the
 * venue call beneath it. When the port is bound through the OMS (as
 * `KillSwitchCancelPort` allows), WP-270's `OrderManager.requestCancel`
 * persists `CANCEL_PENDING` and then awaits the venue's cancel with no
 * deadline of its own (WP-260's client sets none either, `oms-progress.ts`);
 * and the OMS refuses to cancel an order already `CANCEL_PENDING`
 * (`OMS_CANCEL_NOT_APPLICABLE`). At round 3 a venue cancel that never answered
 * therefore stranded the order: every later pass of the obligation was
 * accepted and removed nothing, the order rested, and a MARKET or
 * STRATEGY_INSTANCE switch kept the heartbeat running (both verifiers'
 * reproduction, with the placing OMS and with WP-290's real coordinator: 61
 * port calls, one venue cancel, the order `CANCEL_PENDING` in the OMS and
 * `LIVE` at the venue, health green, twelve more heartbeats in 60 s). Now, at
 * every successful read:
 *
 * - the composition notes, per OMS order, the instant a read first saw it
 *   `CANCEL_PENDING` (continuously since: an order seen in any other state, or
 *   gone, is forgotten);
 * - an order that has been `CANCEL_PENDING` for at least `cancelTimeoutMs`
 *   since then, and that may be in the scope of a current obligation (the
 *   same scope rule as the venue evidence below), is sent to the OMS's own
 *   `SafetyOms.requestOrderReconciliation` — WP-270: it "also clears a cancel
 *   whose answer never came: a late cancel answer is then recorded only" — so
 *   the order goes to `RECONCILING` (an authoritative read is requested), and
 *   the OMS may cancel it again;
 * - it is released BEFORE the read's passes are asked, so this read's pass
 *   may already cancel it again; the obligation stays open throughout
 *   (`CANCEL_PENDING` and `RECONCILING` rest or may rest), and only the OMS's
 *   view showing the scope quiescent — venue evidence — closes it;
 * - each request is journalled
 *   (`KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED`), the obligation
 *   pages `KILL_SWITCH_CANCEL_STRANDED` once, and an order whose request has
 *   not settled is not asked again; a new `CANCEL_PENDING` after the request
 *   is a new cancel, whose deadline starts when a read first sees it.
 *
 * It works whatever venue port the OMS was opened over. Every
 * `KILL_SWITCH_CANCEL_REQUESTED` entry also records whether the OMS still
 * showed the scope resting when its outcome was recorded
 * (`scopeStillResting`): an ACCEPTED pass is a request the port took, never
 * evidence that the scope is clear.
 *
 * Why: every order transmitted AFTER the switch was observed is refused by the
 * per-order fence (`fenced-venue.ts`), but a placement handed to the venue
 * BEFORE it — queued beneath the fence (WP-310's rate-limit ladder ranks
 * `EMERGENCY_CANCEL` above `NEW_ORDER`, so a queued placement can be granted
 * after the cancels), or simply slow — can land after any fixed number of
 * sweeps. At round 1 the obligation ended after the confirming sweep, and such
 * a placement rested indefinitely under a MARKET or STRATEGY_INSTANCE
 * FULL_HALT while the account's heartbeat kept it alive (r2 X3, reproduced
 * with the real OMS). The fenced venue now reports every placement it hands
 * to the venue until it settles ({@link LiveSafety.fenceVenue}); a placement
 * still pending keeps the obligation open, and its settling — accepted,
 * refused or unknown — calls for another cancel requested after it. Venue
 * evidence closes it: the OMS's own view (`SafetyOms.orders()`, which WP-270
 * keeps from venue answers and reconciliation) must show no order in the
 * scope in a state that rests or may rest at the venue (`SENDING`,
 * `ACKNOWLEDGED`, `LIVE`, `DELAYED`, `PARTIALLY_FILLED`, `CANCEL_PENDING`,
 * `SUBMISSION_UNKNOWN`, `RECONCILING`); an unreadable view keeps it open.
 *
 * ### STRATEGY_INSTANCE scope: missing attribution is NOT "clear" (r3, finding J1)
 *
 * WP-270's order view carries a market but no strategy instance. At round 2 an
 * instance directive therefore read "nothing resting" from the OMS, and its
 * obligation ended after the confirming or settling pass: an instance order
 * already resting whose cancel was accepted but that still rested, or a
 * placement whose answer was lost (`SUBMISSION_UNKNOWN`) and that
 * reconciliation later showed `LIVE`, rested under the instance's FULL_HALT
 * while the heartbeat kept it alive (both verifiers' reproduction with the
 * real OMS). Now an order resting or unknown in the OMS's view is OUTSIDE an
 * instance's scope only when the injected {@link OrderInstanceAttribution}
 * AFFIRMATIVELY attributes it to another instance. With no port bound, a
 * port that answers anything but an identifier, or one that throws, the
 * order counts as the instance's: the obligation is held while the OMS shows
 * any order of the account resting or unknown — the account's quiescence is
 * then the evidence. (Tracking only the markets of the instance's tracked
 * placements would miss its orders that were already resting.)
 *
 * ### Which switch carries the obligation
 *
 * Every engaged switch that ends trading in its scope does, including a
 * release that is not final — `PENDING` inside its settle window,
 * `UNCONFIRMED`, `VOIDED` (`kill-switch.ts`) — under the release row's own
 * event id from the first read that sees it: so no read between an engage and
 * a FINAL release lacks one (r3, finding J3: at round 2 a `PENDING` release
 * asked for no cancel, and the engage's obligation was dropped while the
 * scope's submissions stayed blocked). An obligation is dropped when its
 * switch is no longer engaged: released with positive finality, or superseded
 * by a newer row of its scope, which carries its own.
 */

import type { EligibilityVerdict, ClosedOnlyPort, GeoblockPort } from "./eligibility.js";
import { VenueEligibility } from "./eligibility.js";
import { evaluateLiveGate, type GateDecision, type GateRequest } from "./entry-gate.js";
import { fenceVenuePort, type FenceRefusals, type PlacementClassifier, type PlacementScope, type PlacementTracker, type PlacementVenuePort } from "./fenced-venue.js";
import { assertLiveFencingContext, FencingAuthority, type AcquireResult, type FencingLeasePort, type RunModeContext } from "./fencing-authority.js";
import { EventLoopProbe, HealthLease, ProofBoard, type HealthInput, type HealthProofReading, type HealthVerdict } from "./health-lease.js";
import { KillSwitchMonitor, scopeIdKey, type CancelDirective, type KillSwitchReader, type KillSwitchReleaseFinality, type KillSwitchSnapshot } from "./kill-switch.js";
import { LapseRecovery } from "./lapse-recovery.js";
import type { OmsProgressMonitor } from "./oms-progress.js";
import type { HeartbeatView, LiveSafetyAlerts, LiveSafetyJournal, MonotonicClock, SafetyCoordinator, SafetyOms, SafetyOrderView, SafetyTimers } from "./ports.js";

/**
 * Carries out a kill switch's cancel (bound by the composition to the OMS or the secure client at `EMERGENCY_CANCEL`).
 * `true` = accepted. A request not answered within `cancelTimeoutMs` is abandoned and requested again (r3 J2; module
 * header), so the binding must tolerate a repeated request for the same scope. Bound through the OMS, an order the
 * OMS holds `CANCEL_PENDING` cannot be cancelled again by id; one stranded there past `cancelTimeoutMs` is released by
 * the composition through `SafetyOms.requestOrderReconciliation` (r4 CX320-R4-01; module header).
 */
export interface KillSwitchCancelPort {
  cancel(directive: CancelDirective): Promise<unknown>;
}

/**
 * The strategy instance an OMS order carries out (r3, finding J1; module header), from the composition's own records
 * (WP-270's `OrderView` has none: e.g. its `orderId` or `executionGroupId` mapped to the decision that produced it).
 * ONLY an answer that is an identifier counts; anything else, or a throw, leaves the order in every instance's scope.
 * Synchronous and side-effect free: it is asked at every read for every order resting or unknown in the OMS's view.
 */
export interface OrderInstanceAttribution {
  instanceOf(order: SafetyOrderView): unknown;
}

/** The OMS order states that rest, or may rest, at the venue: an order in one keeps a cancel obligation open (r2 X3). */
export const VENUE_RESTING_OR_UNKNOWN_STATES = Object.freeze([
  "SENDING",
  "ACKNOWLEDGED",
  "LIVE",
  "DELAYED",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "SUBMISSION_UNKNOWN",
  "RECONCILING",
] as const);

/** A kill-switch cancel obligation (module header, "Kill-switch cancels"). */
interface CancelObligation {
  /** Monotonic instant the latest ACCEPTED request STARTED (read before the port was called). */
  lastRequestAtMs: number;
  /** Monotonic instant the latest acceptance was seen (the port answered). */
  lastAcceptedAtMs: number;
  /** Whether the confirming pass has been accepted. */
  confirmed: boolean;
}

/** The ONE request an obligation is waiting on (r3 J2): only its answer may discharge a pass. */
interface CancelAttempt {
  readonly attempt: number;
  readonly pass: CancelPass;
  /** Monotonic instant it was requested (read just before the port was called). */
  readonly requestedAtMs: number;
}

/** The sources of an explicit heartbeat stop (ADR-033 D1 item 4). */
export const HEARTBEAT_STOP_SOURCES = Object.freeze(["INCIDENT_CONTROLLER", "OPS_CLI", "LIVE_FENCING_CONFLICT"] as const);
export type HeartbeatStopSource = (typeof HEARTBEAT_STOP_SOURCES)[number];

type CancelPass = "FIRST" | "CONFIRMING" | "AFTER_SETTLE" | "RETAINED";

/**
 * The health inputs the composition proves itself with {@link LiveSafety.recordProof}; the others are this class's.
 * RECONCILER is NOT among them: only {@link LiveSafety.recordReconcileReport} proves it, from a passing run (r1 I3).
 */
export const COMPOSITION_PROVED_INPUTS = Object.freeze(["MARKET_DATA", "USER_DATA", "DATABASE"] as const);
export type CompositionProvedInput = (typeof COMPOSITION_PROVED_INPUTS)[number];

export interface LiveSafetyOptions {
  /**
   * The process's run-mode context (`RUN_MODE`, `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`), checked FIRST: a run mode that
   * does not submit real orders, one above the ceiling, or real orders not allowed, is refused before anything else
   * is read (ADR-010 §1; r1 I8).
   */
  readonly runModeContext: RunModeContext;
  readonly accountRef: string;
  readonly holderId: string;
  readonly holderHostname?: string | null;
  readonly holderPid?: number | null;
  readonly clock: MonotonicClock;
  readonly timers: SafetyTimers;
  readonly fencing: {
    readonly store: FencingLeasePort;
    readonly ttlMs: number;
    readonly renewIntervalMs: number;
    readonly safetyMarginMs: number;
    readonly transmitMarginMs: number;
  };
  readonly health: {
    /** Per input, the oldest proof accepted. */
    readonly maxAgeMs: Readonly<Record<HealthInput, number>>;
    readonly eventLoop: { readonly intervalMs: number; readonly maxLagMs: number };
  };
  readonly killSwitch: {
    readonly reader: KillSwitchReader;
    readonly refreshIntervalMs: number;
    readonly cancels: KillSwitchCancelPort;
    /**
     * How long a release row must have been visible before it releases (`kill-switch.ts`, r1 I6). It must exceed the
     * control plane's `auditAppendTimeoutMs` plus the time its VOID record usually takes to land.
     */
    readonly releaseSettleMs: number;
    /**
     * POSITIVE evidence that the control plane applied a release (`kill-switch.ts`, r2 X2). Required: a settled,
     * unvoided release row with no such evidence stays enforced as the switch it releases, in full.
     */
    readonly releaseFinality: KillSwitchReleaseFinality;
    /**
     * How long a cancel request may go unanswered before it is abandoned and requested again (r3 J2; module header),
     * and how long an order in a switch's scope may stay `CANCEL_PENDING` in the OMS before its reconciliation is
     * requested (r4 CX320-R4-01). Default: `refreshIntervalMs`. At most the KILL_SWITCH input's maximum age: no cancel
     * stalls longer than the switch state it enforces may be stale. It should exceed the cancel path's normal latency,
     * or every request is abandoned (and repeated) before it answers.
     */
    readonly cancelTimeoutMs?: number;
    /**
     * Which strategy instance an OMS order carries out (r3 J1; module header). Optional: without it, every order
     * resting or unknown in the OMS's view holds every STRATEGY_INSTANCE cancel obligation open.
     */
    readonly instanceAttribution?: OrderInstanceAttribution;
  };
  readonly eligibility: { readonly geoblock: GeoblockPort; readonly closedOnly: ClosedOnlyPort; readonly refreshIntervalMs: number; readonly maxAgeMs: number };
  readonly oms: SafetyOms;
  /**
   * The OMS's port-call progress (`oms-progress.ts`): its store, reservation port and cipher must all have been wrapped
   * by it (r1 I5; r2 X4), or the OMS input proves nothing.
   */
  readonly omsProgress: OmsProgressMonitor;
  readonly coordinator: SafetyCoordinator;
  readonly recovery: { readonly notRunPollMs: number; readonly failedRunSpacingMs: number };
  readonly journal: LiveSafetyJournal;
  readonly alerts: LiveSafetyAlerts;
}

export interface LiveSafetyStatus {
  readonly fence: ReturnType<FencingAuthority["check"]>;
  readonly health: HealthVerdict;
  readonly killSwitch: KillSwitchSnapshot;
  readonly eligibility: EligibilityVerdict;
  readonly explicitStops: readonly string[];
  readonly heartbeatAttached: boolean;
  readonly recoveryBlocksEntries: boolean;
  readonly reconciliationHalts: { readonly account: boolean; readonly markets: readonly string[] };
}

/**
 * The live gate's reconciliation halts (C1-OMS06), derived from WP-290's journal at every ask, never latched here: a
 * QUARANTINED break of MARKET scope with a market halts new entries in that market; any other halts them in the whole
 * account. So an operator's `releaseQuarantine` lifts exactly that break's halt. A coordinator that cannot read its
 * journal throws, and the throw reaches the gate, which refuses the entry (`HALTS_UNREADABLE`).
 */
function reconciliationHaltsOf(breaks: ReturnType<SafetyCoordinator["quarantinedBreaks"]>): { readonly account: boolean; readonly markets: ReadonlySet<string> } {
  const markets = new Set<string>();
  let account = false;
  for (const view of breaks) {
    if (view.scope === "MARKET" && typeof view.marketId === "string") markets.add(view.marketId);
    else account = true;
  }
  return { account, markets };
}

export class LiveSafetyConfigurationError extends Error {
  override readonly name = "LiveSafetyConfigurationError";
  constructor(readonly field: string) {
    super(`live-safety configuration refused: ${field}`);
    Object.freeze(this);
  }
}

function interval(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new LiveSafetyConfigurationError(field);
  return value;
}

export class LiveSafety {
  readonly #options: LiveSafetyOptions;
  readonly #fence: FencingAuthority;
  readonly #board: ProofBoard;
  readonly #health: HealthLease;
  readonly #eventLoop: EventLoopProbe;
  readonly #killSwitch: KillSwitchMonitor;
  readonly #eligibility: VenueEligibility;
  readonly #recovery: LapseRecovery;
  readonly #stops = new Map<HeartbeatStopSource, string>();
  /** Per cancel key (switch event and directive): its obligation, once the port has first accepted it. */
  readonly #cancels = new Map<string, CancelObligation>();
  /** Per cancel key: the one attempt its obligation is waiting on (r3 J2). */
  readonly #cancelAttempts = new Map<string, CancelAttempt>();
  #nextCancelAttempt = 0;
  /** Cancel keys already paged as unanswered (once per obligation; r3 J2). */
  readonly #cancelsPaged = new Set<string>();
  readonly #cancelTimeoutMs: number;
  /** Per OMS order id: the monotonic instant a kill-switch read first saw it CANCEL_PENDING, continuously since (r4). */
  readonly #cancelPendingSince = new Map<string, number>();
  /** OMS order ids whose stranded-cancel reconciliation request has not settled (r4). */
  readonly #strandedRequests = new Set<string>();
  /** Cancel keys already paged as holding a stranded cancel (once per obligation; r4). */
  readonly #strandedPaged = new Set<string>();
  /** Kill-switch event ids already paged for a reference not in its scope's canonical form (r4 R4-L1). */
  readonly #refNoticesPaged = new Set<string>();
  /** Placements the fenced venue has handed to the venue and that have not settled: handle → their scopes (r2 X3). */
  readonly #placements = new Map<number, readonly PlacementScope[]>();
  #nextPlacement = 0;
  /** When a placement last settled (monotonic): any, per market, per strategy instance (r2 X3). */
  #lastSettleAny = Number.NEGATIVE_INFINITY;
  readonly #lastSettleByMarket = new Map<string, number>();
  readonly #lastSettleByInstance = new Map<string, number>();
  readonly #tracker: PlacementTracker;
  /** Whether the latest kill-switch read succeeded (true before the first: the first failure pages). */
  #killSwitchReadable = true;
  #heartbeat: HeartbeatView | null = null;
  #started = false;
  readonly #handles = new Set<unknown>();

  /** The heartbeat controller's gate (ADR-033 D1 item 2): the fence AND the health lease AND no explicit stop. */
  readonly heartbeatGate: { evaluate(): { readonly permitted: true } | { readonly permitted: false; readonly reasons: readonly string[] } };
  /** The controller's heartbeat-id sink: persisted on the held lease (ADR-008 §4). */
  readonly heartbeatIdSink: { persist(heartbeatId: string): Promise<boolean> };
  /** The controller's event listener. */
  readonly onHeartbeatEvent: (event: unknown) => void;

  private constructor(options: LiveSafetyOptions) {
    this.#options = options;
    this.#board = new ProofBoard({ clock: options.clock });
    if (typeof options.omsProgress !== "object" || options.omsProgress === null || typeof options.omsProgress.reading !== "function") {
      throw new LiveSafetyConfigurationError("omsProgress");
    }
    this.#fence = FencingAuthority.create({
      runModeContext: options.runModeContext,
      accountRef: options.accountRef,
      holderId: options.holderId,
      holderHostname: options.holderHostname ?? null,
      holderPid: options.holderPid ?? null,
      store: options.fencing.store,
      clock: options.clock,
      ttlMs: options.fencing.ttlMs,
      safetyMarginMs: options.fencing.safetyMarginMs,
      transmitMarginMs: options.fencing.transmitMarginMs,
    });
    const renew = interval(options.fencing.renewIntervalMs, "fencing.renewIntervalMs");
    // At least two renewal attempts fit inside every lease before its transmit margin.
    if (renew * 2 > options.fencing.ttlMs - options.fencing.safetyMarginMs - options.fencing.transmitMarginMs) throw new LiveSafetyConfigurationError("fencing.renewIntervalMs");
    interval(options.killSwitch.refreshIntervalMs, "killSwitch.refreshIntervalMs");
    interval(options.eligibility.refreshIntervalMs, "eligibility.refreshIntervalMs");
    if (options.killSwitch.refreshIntervalMs >= options.health.maxAgeMs.KILL_SWITCH) throw new LiveSafetyConfigurationError("killSwitch.refreshIntervalMs");
    if (options.eligibility.refreshIntervalMs >= options.eligibility.maxAgeMs) throw new LiveSafetyConfigurationError("eligibility.refreshIntervalMs");
    interval(options.killSwitch.releaseSettleMs, "killSwitch.releaseSettleMs");
    const finality: unknown = options.killSwitch.releaseFinality;
    if (typeof finality !== "object" || finality === null || typeof (finality as { isFinal?: unknown }).isFinal !== "function") {
      throw new LiveSafetyConfigurationError("killSwitch.releaseFinality");
    }
    // r3 J2: every cancel request has a deadline, no longer than the switch state it enforces may be stale.
    const cancelTimeout = options.killSwitch.cancelTimeoutMs ?? options.killSwitch.refreshIntervalMs;
    if (interval(cancelTimeout, "killSwitch.cancelTimeoutMs") > options.health.maxAgeMs.KILL_SWITCH) throw new LiveSafetyConfigurationError("killSwitch.cancelTimeoutMs");
    this.#cancelTimeoutMs = cancelTimeout;
    const attribution: unknown = options.killSwitch.instanceAttribution;
    if (attribution !== undefined && (typeof attribution !== "object" || attribution === null || typeof (attribution as { instanceOf?: unknown }).instanceOf !== "function")) {
      throw new LiveSafetyConfigurationError("killSwitch.instanceAttribution");
    }
    // A read slower than one refresh interval is abandoned by the next refresh: a hung read never freezes the state.
    this.#killSwitch = new KillSwitchMonitor({
      reader: options.killSwitch.reader,
      clock: options.clock,
      accountRef: options.accountRef,
      releaseSettleMs: options.killSwitch.releaseSettleMs,
      releaseFinality: options.killSwitch.releaseFinality,
      abandonAfterMs: options.killSwitch.refreshIntervalMs,
    });
    this.#eligibility = new VenueEligibility({
      geoblock: options.eligibility.geoblock,
      closedOnly: options.eligibility.closedOnly,
      clock: options.clock,
      maxAgeMs: options.eligibility.maxAgeMs,
      abandonAfterMs: options.eligibility.refreshIntervalMs,
    });
    this.#eventLoop = new EventLoopProbe({
      board: this.#board,
      clock: options.clock,
      timers: options.timers,
      intervalMs: options.health.eventLoop.intervalMs,
      maxLagMs: options.health.eventLoop.maxLagMs,
    });
    this.#health = new HealthLease({
      clock: options.clock,
      maxAgeMs: options.health.maxAgeMs,
      sources: {
        MARKET_DATA: this.#board.source("MARKET_DATA"),
        USER_DATA: this.#board.source("USER_DATA"),
        EVENT_LOOP: this.#board.source("EVENT_LOOP"),
        OMS: { read: (): HealthProofReading => this.#omsProof() },
        DATABASE: this.#board.source("DATABASE"),
        RECONCILER: this.#board.source("RECONCILER"),
        KILL_SWITCH: this.#killSwitch.proofSource(),
      },
    });
    this.#recovery = new LapseRecovery({
      oms: options.oms,
      coordinator: options.coordinator,
      clock: options.clock,
      timers: options.timers,
      journal: options.journal,
      alerts: options.alerts,
      heartbeat: () => this.#heartbeat,
      notRunPollMs: options.recovery.notRunPollMs,
      failedRunSpacingMs: options.recovery.failedRunSpacingMs,
      onReport: (report, calledAtMs) => {
        this.recordReconcileReport(report, calledAtMs);
      },
      gateReasonsNow: () => {
        const verdict = this.#heartbeatGate();
        return verdict.permitted ? [] : verdict.reasons;
      },
    });

    this.#tracker = Object.freeze({
      started: (scopes: readonly PlacementScope[]): unknown => this.#placementStarted(scopes),
      settled: (handle: unknown): void => {
        this.#placementSettled(handle);
      },
    });
    this.heartbeatGate = Object.freeze({ evaluate: () => this.#heartbeatGate() });
    this.heartbeatIdSink = Object.freeze({ persist: (heartbeatId: string) => this.#fence.recordHeartbeatId(heartbeatId) });
    this.onHeartbeatEvent = (event: unknown): void => {
      this.#onHeartbeatEvent(event);
    };
  }

  /**
   * @throws {LiveFencingRefusal} in every run mode that does not submit real orders (PAPER included), above the
   * process's ceiling, or without `allowRealOrders`, before anything else is read.
   */
  static create(options: LiveSafetyOptions): LiveSafety {
    assertLiveFencingContext(typeof options === "object" && options !== null ? options.runModeContext : undefined);
    return new LiveSafety(options);
  }

  /** Acquire the fence (a new grant and token). The heartbeat may resume the inherited id (ADR-008 §4). */
  async acquireFence(): Promise<AcquireResult> {
    const result = await this.#fence.acquire();
    const now = this.#now();
    if (result.kind === "ACQUIRED") {
      this.#record({ kind: "FENCE_ACQUIRED", fencingToken: result.fence.fencingToken, atMs: now ?? 0 });
      if (now !== null) this.#board.prove("DATABASE", now);
    }
    if (result.kind === "STORE_FAILED") this.#board.fail("DATABASE", "FENCE_ACQUIRE_FAILED");
    return result;
  }

  /** Release the fence (shutdown). Authority ends locally first. */
  async releaseFence(reason: string): Promise<boolean> {
    return this.#fence.release(reason);
  }

  attachHeartbeat(heartbeat: HeartbeatView): void {
    this.#heartbeat = heartbeat;
  }

  /** Start the refreshers: fence renewal, kill-switch reads, eligibility checks, the event-loop probe. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#eventLoop.start();
    this.#every(this.#options.fencing.renewIntervalMs, () => this.#renewFence());
    this.#every(this.#options.killSwitch.refreshIntervalMs, () => this.refreshKillSwitch());
    this.#every(this.#options.eligibility.refreshIntervalMs, () => this.refreshEligibility());
  }

  stop(): void {
    this.#started = false;
    this.#eventLoop.stop();
    this.#recovery.close();
    for (const handle of this.#handles) this.#options.timers.clearTimeout(handle);
    this.#handles.clear();
  }

  /** The live gate (`entry-gate.ts`): asked at decision time, and again per order by {@link LiveSafety.fenceVenue}. */
  gate(request: GateRequest): GateDecision {
    return evaluateLiveGate(
      {
        killSwitch: () => this.#killSwitch.snapshot(),
        fence: () => this.#fence.check(),
        health: () => this.#health.evaluate(),
        explicitStops: () => [...this.#stops.keys()],
        heartbeatLapsed: () => {
          const heartbeat = this.#heartbeat;
          return heartbeat === null ? true : heartbeat.isLapsed() !== false;
        },
        recoveryBlocksEntries: () => this.#recovery.blocksNewEntries(),
        eligibility: () => this.#eligibility.verdict(),
        reconciliationHalts: () => reconciliationHaltsOf(this.#options.coordinator.quarantinedBreaks()),
      },
      request,
    );
  }

  /**
   * The OMS's venue port behind the submission fence (`fenced-venue.ts`): every signing and every transmission (batch
   * members one by one) is judged by {@link LiveSafety.gate} with the order's own intent, market and instance, from
   * `classifier` (r1 I2); every placement handed to the venue is tracked until it settles, for the kill-switch cancel
   * obligations (r2 X3).
   */
  fenceVenue<TRequest, TSign, TOrder, TPlacement, TCancel>(
    venue: PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>,
    refusals: FenceRefusals<TSign, TPlacement>,
    classifier: PlacementClassifier<TRequest, TSign, TOrder>,
  ): PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel> {
    return fenceVenuePort(venue, (scope) => this.gate({ kind: scope.intent, marketId: scope.marketId, instanceId: scope.instanceId }), refusals, classifier, this.#tracker);
  }

  /** How many placements handed to the venue through {@link LiveSafety.fenceVenue} have not settled. */
  pendingPlacements(): number {
    return this.#placements.size;
  }

  /** The fence a live submission attempt is persisted with (§9.18), while held. */
  currentFence(): { readonly fencingLeaseId: string; readonly fencingToken: string } | null {
    return this.#fence.currentFence();
  }

  /** An explicit heartbeat stop (ADR-033 D1 item 4), latched until {@link LiveSafety.releaseHeartbeatStop}. */
  stopHeartbeat(source: HeartbeatStopSource, reason: string): void {
    if (!HEARTBEAT_STOP_SOURCES.includes(source)) return;
    this.#stops.set(source, typeof reason === "string" ? reason.slice(0, 500) : "");
    this.#record({ kind: "HEARTBEAT_STOP_ENGAGED", source, reason: this.#stops.get(source) ?? "", atMs: this.#now() ?? 0 });
  }

  releaseHeartbeatStop(source: HeartbeatStopSource, operatorRef: string): boolean {
    if (!this.#stops.delete(source)) return false;
    this.#record({ kind: "HEARTBEAT_STOP_RELEASED", source, operatorRef, atMs: this.#now() ?? 0 });
    return true;
  }

  /** Positive evidence for an input the composition proves (MARKET_DATA, USER_DATA, DATABASE), at `atMs` (monotonic). */
  recordProof(input: CompositionProvedInput, atMs: number): void {
    if (COMPOSITION_PROVED_INPUTS.includes(input)) this.#board.prove(input, atMs);
  }

  recordFailure(input: CompositionProvedInput, reason: string): void {
    if (COMPOSITION_PROVED_INPUTS.includes(input)) this.#board.fail(input, reason);
  }

  /**
   * A reconcile report (the composition's periodic timer, or D6's own calls), with the monotonic instant read just
   * BEFORE the `reconcile()` call that produced it. ONLY a run that PASSED and resumed the OMS proves the RECONCILER
   * input, and at `calledAtMs` (every run of the call started after it), never at receipt (r1 I3). A FAILED,
   * QUARANTINED or NOT_RUN report proves nothing: a reconciler that keeps failing ages the input out, and the
   * heartbeat stops (§9.9: "Account state unknown → Stop heartbeat"). An unreadable report fails the input.
   */
  recordReconcileReport(report: { readonly runs: readonly { readonly status: string; readonly resumed?: boolean }[] }, calledAtMs: number): void {
    let passed: boolean;
    try {
      passed = report.runs.some((run) => run.status === "PASSED" && run.resumed === true);
    } catch {
      this.#board.fail("RECONCILER", "REPORT_UNREADABLE");
      return;
    }
    if (passed) this.#board.prove("RECONCILER", calledAtMs);
  }

  /** Read the kill-switch rows now, then request every cancel an engaged switch asks for. */
  async refreshKillSwitch(): Promise<boolean> {
    const before = this.#now();
    const reading = this.#killSwitch.refresh();
    // A read that HUNG past the abandonment bound is unreadable state NOW (r1 I10): do not wait for its replacement,
    // which may hang too, to fail the input and page.
    const snapshot = this.#killSwitch.snapshot();
    if (!snapshot.known && snapshot.reason === "READ_TIMED_OUT") this.#killSwitchUnreadable("KILL_SWITCH_READ_TIMED_OUT");
    const ok = await reading;
    if (!ok) {
      this.#killSwitchUnreadable("KILL_SWITCH_READ_FAILED");
      return false;
    }
    this.#killSwitchReadable = true;
    if (before !== null) this.#board.prove("DATABASE", before);
    this.#pageRefNotices();
    await this.#enforceCancels();
    return true;
  }

  async refreshEligibility(): Promise<void> {
    await this.#eligibility.refresh();
  }

  status(): LiveSafetyStatus {
    return Object.freeze({
      fence: this.#fence.check(),
      health: this.#health.evaluate(),
      killSwitch: this.#killSwitch.snapshot(),
      eligibility: this.#eligibility.verdict(),
      explicitStops: Object.freeze([...this.#stops.keys()]),
      heartbeatAttached: this.#heartbeat !== null,
      recoveryBlocksEntries: this.#recovery.blocksNewEntries(),
      reconciliationHalts: this.#reconciliationHaltsStatus(),
    });
  }

  // -------------------------------------------------------------------------

  /** The reconciliation halts for {@link LiveSafety.status}: an unreadable journal reads as the account halted, as the gate refuses. */
  #reconciliationHaltsStatus(): LiveSafetyStatus["reconciliationHalts"] {
    try {
      const halts = reconciliationHaltsOf(this.#options.coordinator.quarantinedBreaks());
      return Object.freeze({ account: halts.account, markets: Object.freeze([...halts.markets]) });
    } catch {
      return Object.freeze({ account: true, markets: Object.freeze([]) });
    }
  }

  #heartbeatGate(): { readonly permitted: true } | { readonly permitted: false; readonly reasons: readonly string[] } {
    const reasons: string[] = [];
    try {
      const fence = this.#fence.check();
      if (!fence.held) reasons.push(`FENCE_${fence.reason}`);
    } catch {
      reasons.push("FENCE_UNREADABLE");
    }
    try {
      const health = this.#health.evaluate();
      if (!health.healthy) reasons.push(...health.reasons);
    } catch {
      reasons.push("HEALTH_UNREADABLE");
    }
    for (const source of this.#stops.keys()) reasons.push(`STOPPED_${source}`);
    if (reasons.length === 0) return Object.freeze({ permitted: true as const });
    return Object.freeze({ permitted: false as const, reasons: Object.freeze(reasons) });
  }

  #onHeartbeatEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const kind = Object.getOwnPropertyDescriptor(event, "kind");
    const value: unknown = kind !== undefined && "value" in kind ? kind.value : undefined;
    const field = (name: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(event, name);
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    };
    if (value === "LAPSE_STARTED") {
      const cause = field("cause");
      const reasons = field("gateReasons");
      const atMs = field("atMs");
      this.#recovery.onLapseStarted({
        cause: typeof cause === "string" ? cause : "UNREADABLE",
        gateReasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === "string") : [],
        atMs: typeof atMs === "number" ? atMs : (this.#now() ?? 0),
      });
      return;
    }
    if (value === "LAPSE_ENDED") {
      const confirmedAtMs = field("confirmedAtMs");
      // An unreadable confirmation time ends nothing: the block stays latched until a readable end.
      if (typeof confirmedAtMs === "number" && Number.isFinite(confirmedAtMs)) this.#recovery.onLapseEnded({ confirmedAtMs });
      return;
    }
    if (value === "LIVE_FENCING_CONFLICT") {
      // ADR-008 §4: repeated invalid ids are evidence of a second writer on these credentials. Page, and stop the
      // heartbeat until an operator has looked (the safe state: the venue cancels the credentials' resting orders).
      this.#page("LIVE_FENCING_CONFLICT", "repeated invalid heartbeat ids: another writer may hold these credentials");
      this.stopHeartbeat("LIVE_FENCING_CONFLICT", "repeated invalid heartbeat ids (ADR-008 §4)");
    }
  }

  /**
   * The OMS input (r1 I5): not faulted, AND the progress monitor's evidence — proved at the start of the oldest OMS
   * port call still pending (or now, when none is), so a call that never settles ages out of the lease. Reading
   * `faulted === false` alone proves nothing.
   */
  #omsProof(): HealthProofReading {
    const now = this.#now();
    if (now === null) return Object.freeze({ healthy: false as const, reason: "CLOCK_UNREADABLE" });
    try {
      if (this.#options.oms.faulted !== false) return Object.freeze({ healthy: false as const, reason: "FAULTED" });
      return this.#options.omsProgress.reading(now);
    } catch {
      return Object.freeze({ healthy: false as const, reason: "UNREADABLE" });
    }
  }

  /** Unreadable kill-switch state: the DATABASE input fails, and the transition into it pages once. */
  #killSwitchUnreadable(reason: string): void {
    this.#board.fail("DATABASE", reason);
    if (this.#killSwitchReadable) {
      this.#page("KILL_SWITCH_STATE_UNREADABLE", "the kill-switch rows could not be read; every submission is blocked and the heartbeat stops");
    }
    this.#killSwitchReadable = false;
  }

  /** r4 R4-L1: each engaged switch whose reference is not in its scope's canonical form (`kill-switch.ts`) is paged once. */
  #pageRefNotices(): void {
    const snapshot = this.#killSwitch.snapshot();
    if (!snapshot.known) return;
    const current = new Set<string>();
    for (const notice of snapshot.effects.refNotices) {
      current.add(notice.killSwitchEventId);
      if (this.#refNoticesPaged.has(notice.killSwitchEventId)) continue;
      this.#refNoticesPaged.add(notice.killSwitchEventId);
      const ref = JSON.stringify(notice.scopeRef.slice(0, 256));
      const effect =
        notice.kind === "UNRECOGNISED"
          ? "does not read as a UUID (internal market and strategy-instance ids are UUIDs), so it may match none of this process's orders"
          : notice.kind === "ACCOUNT_SPELLING"
            ? "differs from this process's account only in letter case or surrounding space, and is enforced as this account's"
            : `is enforced under its canonical form ${JSON.stringify(notice.enforcedAs)}`;
      this.#page("KILL_SWITCH_SCOPE_REF_NOT_CANONICAL", `kill switch ${notice.killSwitchEventId} (${notice.scope} ${ref}) ${effect}; engage and release it under its canonical reference`);
    }
    for (const id of [...this.#refNoticesPaged]) if (!current.has(id)) this.#refNoticesPaged.delete(id);
  }

  async #renewFence(): Promise<void> {
    const before = this.#now();
    const result = await this.#fence.renew();
    if (result === "RENEWED" && before !== null) this.#board.prove("DATABASE", before);
    if (result === "UNKNOWN") this.#board.fail("DATABASE", "FENCE_RENEW_FAILED");
    if (result === "LOST") this.#record({ kind: "FENCE_LOST", reason: this.#fence.lossReason() ?? "RENEW_LOST", atMs: this.#now() ?? 0 });
  }

  /**
   * Discharge the engaged switches' cancel obligations (module header, "Kill-switch cancels"). Each obligation is
   * asked once per read, its passes in the order of the table; an attempt past its deadline is abandoned and its pass
   * requested again (r3 J2); an obligation whose switch is no longer engaged is dropped. The read's attempts run side
   * by side.
   */
  async #enforceCancels(): Promise<void> {
    const snapshot = this.#killSwitch.snapshot();
    if (!snapshot.known) return;
    const readAtMs = snapshot.readStartedAtMs;
    const spacing = this.#options.killSwitch.refreshIntervalMs;
    const current = new Set<string>();
    const obligations: (readonly [string, CancelDirective])[] = [];
    for (const { directive, killSwitchEventId } of snapshot.effects.cancels) {
      const key = `${killSwitchEventId}:${directive.scope}:${directive.scope === "MARKET" ? directive.marketId : directive.scope === "STRATEGY_INSTANCE" ? directive.instanceId : ""}`;
      if (current.has(key)) continue;
      current.add(key);
      obligations.push([key, directive] as const);
    }
    // r4 CX320-R4-01: orders stranded CANCEL_PENDING beneath the OMS are released BEFORE the passes are asked, so this
    // read's pass may already cancel them again. Never allowed to stop the passes.
    let requests: Promise<void>[];
    try {
      requests = this.#releaseStrandedCancels(obligations);
    } catch {
      requests = [];
    }
    for (const [key, directive] of obligations) {
      const waiting = this.#cancelAttempts.get(key);
      if (waiting !== undefined) {
        const now = this.#now();
        // Still within its deadline: the obligation waits on it.
        if (now !== null && now - waiting.requestedAtMs < this.#cancelTimeoutMs) continue;
        this.#abandonCancelAttempt(key, directive, waiting, now);
      }
      const state = this.#cancels.get(key);
      let pass: CancelPass | null;
      if (state === undefined) pass = "FIRST";
      else if (this.#lastCoveredSettle(directive) >= state.lastRequestAtMs) pass = "AFTER_SETTLE";
      else if (readAtMs - state.lastAcceptedAtMs < spacing) pass = null;
      else if (!state.confirmed) pass = "CONFIRMING";
      else if (this.#pendingCovered(directive) || this.#omsShowsResting(directive)) pass = "RETAINED";
      else pass = null;
      if (pass === null) continue;
      // Registered NOW, before any await: a read running concurrently sees the obligation waiting on it.
      this.#nextCancelAttempt += 1;
      const attempt: CancelAttempt = Object.freeze({ attempt: this.#nextCancelAttempt, pass, requestedAtMs: this.#now() ?? readAtMs });
      this.#cancelAttempts.set(key, attempt);
      requests.push(this.#requestCancel(key, directive, attempt));
    }
    // A switch no longer engaged (released with finality, or superseded by a newer row) carries no obligation, and an
    // attempt still waiting for it is abandoned: its answer, when it comes, is discarded.
    for (const key of [...this.#cancels.keys()]) if (!current.has(key)) this.#cancels.delete(key);
    for (const key of [...this.#cancelAttempts.keys()]) if (!current.has(key)) this.#cancelAttempts.delete(key);
    for (const key of [...this.#cancelsPaged]) if (!current.has(key)) this.#cancelsPaged.delete(key);
    for (const key of [...this.#strandedPaged]) if (!current.has(key)) this.#strandedPaged.delete(key);
    this.#pruneSettles();
    await Promise.all(requests);
  }

  /**
   * r4, CX320-R4-01 (module header, "A cancel stranded BENEATH the OMS"): note the instant each OMS order was first
   * seen CANCEL_PENDING (continuously since), and send every one that has stayed so for `cancelTimeoutMs` and that may
   * be in the scope of a current obligation to the OMS's `requestOrderReconciliation`. Returns the requests.
   */
  #releaseStrandedCancels(obligations: readonly (readonly [string, CancelDirective])[]): Promise<void>[] {
    const now = this.#now();
    if (now === null) return [];
    let pending: SafetyOrderView[];
    try {
      pending = this.#options.oms.orders().filter((order) => order.state === "CANCEL_PENDING");
    } catch {
      // Unreadable: nothing is released, and every obligation stays open (`#omsShowsResting`).
      return [];
    }
    const pendingIds = new Set(pending.map((order) => order.orderId));
    for (const id of [...this.#cancelPendingSince.keys()]) if (!pendingIds.has(id)) this.#cancelPendingSince.delete(id);
    const requests: Promise<void>[] = [];
    for (const order of pending) {
      const since = this.#cancelPendingSince.get(order.orderId);
      if (since === undefined) {
        this.#cancelPendingSince.set(order.orderId, now);
        continue;
      }
      if (now - since < this.#cancelTimeoutMs || this.#strandedRequests.has(order.orderId)) continue;
      const covering = obligations.find(([, directive]) => this.#mayBeInScope(directive, order));
      // No engaged switch's obligation covers it: not this composition's to clear.
      if (covering === undefined) continue;
      const [key] = covering;
      // A CANCEL_PENDING seen after this request is a new cancel: its deadline starts when a read first sees it.
      this.#cancelPendingSince.delete(order.orderId);
      this.#strandedRequests.add(order.orderId);
      if (!this.#strandedPaged.has(key)) {
        this.#strandedPaged.add(key);
        this.#page(
          "KILL_SWITCH_CANCEL_STRANDED",
          `an order (${order.orderId}) in the scope of a kill-switch cancel (${key}) stayed CANCEL_PENDING for ${String(now - since)} ms: its cancel's answer never came; its reconciliation was requested so it can be cancelled again`,
        );
      }
      requests.push(this.#reconcileStranded(key, order.orderId, since));
    }
    return requests;
  }

  /** One stranded-cancel release (r4): journalled when it settles; the order may be asked again only after that. */
  async #reconcileStranded(key: string, orderId: string, cancelPendingSinceMs: number): Promise<void> {
    let accepted = false;
    try {
      accepted = (await this.#options.oms.requestOrderReconciliation(orderId)).ok === true;
    } catch {
      accepted = false;
    }
    this.#strandedRequests.delete(orderId);
    this.#record({ kind: "KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED", directive: key, orderId, cancelPendingSinceMs, accepted, atMs: this.#now() ?? 0 });
  }

  /** One attempt (r3 J2): only the attempt its obligation is still waiting on may discharge a pass. */
  async #requestCancel(key: string, directive: CancelDirective, attempt: CancelAttempt): Promise<void> {
    let accepted = false;
    try {
      accepted = (await this.#options.killSwitch.cancels.cancel(directive)) === true;
    } catch {
      accepted = false;
    }
    const atMs = this.#now();
    if (this.#cancelAttempts.get(key)?.attempt !== attempt.attempt) {
      // Abandoned past its deadline (or its switch is gone): a newer attempt, or none, owns the obligation.
      this.#record({ kind: "KILL_SWITCH_CANCEL_LATE_ANSWER_DISCARDED", directive: key, attempt: attempt.attempt, pass: attempt.pass, accepted, atMs: atMs ?? 0 });
      return;
    }
    this.#cancelAttempts.delete(key);
    if (accepted) {
      const acceptedAtMs = atMs ?? attempt.requestedAtMs;
      const latest = this.#cancels.get(key);
      if (latest === undefined) {
        this.#cancels.set(key, { lastRequestAtMs: attempt.requestedAtMs, lastAcceptedAtMs: acceptedAtMs, confirmed: false });
      } else {
        latest.lastRequestAtMs = Math.max(latest.lastRequestAtMs, attempt.requestedAtMs);
        latest.lastAcceptedAtMs = Math.max(latest.lastAcceptedAtMs, acceptedAtMs);
        if (attempt.pass === "CONFIRMING") latest.confirmed = true;
      }
    }
    this.#record({
      kind: "KILL_SWITCH_CANCEL_REQUESTED",
      directive: key,
      pass: attempt.pass,
      attempt: attempt.attempt,
      outcome: accepted ? "ACCEPTED" : "REFUSED",
      accepted,
      scopeStillResting: this.#omsShowsResting(directive),
      atMs: atMs ?? 0,
    });
  }

  /** An attempt past its deadline (r3 J2): journalled, paged once per obligation, and no longer waited on. */
  #abandonCancelAttempt(key: string, directive: CancelDirective, waiting: CancelAttempt, now: number | null): void {
    this.#cancelAttempts.delete(key);
    this.#record({
      kind: "KILL_SWITCH_CANCEL_REQUESTED",
      directive: key,
      pass: waiting.pass,
      attempt: waiting.attempt,
      outcome: "ABANDONED",
      accepted: false,
      scopeStillResting: this.#omsShowsResting(directive),
      atMs: now ?? 0,
    });
    if (this.#cancelsPaged.has(key)) return;
    this.#cancelsPaged.add(key);
    this.#page("KILL_SWITCH_CANCEL_UNANSWERED", `a kill-switch cancel (${key}) went unanswered for ${String(this.#cancelTimeoutMs)} ms; it was abandoned and the obligation requests it again`);
  }

  #placementStarted(scopes: readonly PlacementScope[]): number {
    this.#nextPlacement += 1;
    const handle = this.#nextPlacement;
    this.#placements.set(handle, Object.freeze([...scopes]));
    return handle;
  }

  #placementSettled(handle: unknown): void {
    if (typeof handle !== "number") return;
    const scopes = this.#placements.get(handle);
    if (scopes === undefined) return;
    this.#placements.delete(handle);
    // Unreadable: +∞, so every obligation it may cover asks again.
    const at = this.#now() ?? Number.POSITIVE_INFINITY;
    this.#lastSettleAny = Math.max(this.#lastSettleAny, at);
    for (const scope of scopes) {
      // Keyed in the form a directive names them (r4 R4-L1).
      const market = scopeIdKey(scope.marketId);
      const instance = scopeIdKey(scope.instanceId);
      this.#lastSettleByMarket.set(market, Math.max(this.#lastSettleByMarket.get(market) ?? Number.NEGATIVE_INFINITY, at));
      this.#lastSettleByInstance.set(instance, Math.max(this.#lastSettleByInstance.get(instance) ?? Number.NEGATIVE_INFINITY, at));
    }
  }

  /** When a placement the directive covers last settled. */
  #lastCoveredSettle(directive: CancelDirective): number {
    if (directive.scope === "ACCOUNT") return this.#lastSettleAny;
    if (directive.scope === "MARKET") return this.#lastSettleByMarket.get(directive.marketId) ?? Number.NEGATIVE_INFINITY;
    return this.#lastSettleByInstance.get(directive.instanceId) ?? Number.NEGATIVE_INFINITY;
  }

  /** Whether a placement the directive covers is still pending. */
  #pendingCovered(directive: CancelDirective): boolean {
    for (const scopes of this.#placements.values()) {
      for (const scope of scopes) {
        if (directive.scope === "ACCOUNT") return true;
        // A directive names its id in its matching form (r4 R4-L1): the placement's is read alike.
        if (directive.scope === "MARKET" && scopeIdKey(scope.marketId) === directive.marketId) return true;
        if (directive.scope === "STRATEGY_INSTANCE" && scopeIdKey(scope.instanceId) === directive.instanceId) return true;
      }
    }
    return false;
  }

  /**
   * Venue evidence: whether the OMS shows an order that rests, or may rest, at the venue and is not proved to be
   * outside the directive's scope. Unreadable is "yes".
   */
  #omsShowsResting(directive: CancelDirective): boolean {
    try {
      const resting: readonly string[] = VENUE_RESTING_OR_UNKNOWN_STATES;
      return this.#options.oms.orders().some((order) => resting.includes(order.state) && this.#mayBeInScope(directive, order));
    } catch {
      return true;
    }
  }

  /**
   * Whether an OMS order may be in the directive's scope. For STRATEGY_INSTANCE (r3 J1; module header): unless the
   * attribution port AFFIRMATIVELY names another instance — no port, a non-identifier answer and a throw all leave the
   * order in scope, because WP-270's order view carries no instance and missing attribution is not "clear". Ids are
   * compared in the form the directive names them (r4 R4-L1, `scopeIdKey`); an unreadable order is in scope.
   */
  #mayBeInScope(directive: CancelDirective, order: SafetyOrderView): boolean {
    if (directive.scope === "ACCOUNT") return true;
    if (directive.scope === "MARKET") {
      try {
        return scopeIdKey(order.marketId) === directive.marketId;
      } catch {
        return true;
      }
    }
    const attribution = this.#options.killSwitch.instanceAttribution;
    if (attribution === undefined) return true;
    let answer: unknown;
    try {
      answer = attribution.instanceOf(order);
    } catch {
      return true;
    }
    // Only an identifier attributes; anything else leaves the order in scope.
    if (typeof answer !== "string" || answer.length === 0 || answer.length > 200) return true;
    return scopeIdKey(answer) === directive.instanceId;
  }

  /** Settle times older than every obligation's latest request can no longer matter: forget them. */
  #pruneSettles(): void {
    let oldest = Number.POSITIVE_INFINITY;
    for (const state of this.#cancels.values()) oldest = Math.min(oldest, state.lastRequestAtMs);
    for (const map of [this.#lastSettleByMarket, this.#lastSettleByInstance]) {
      for (const [id, at] of map) if (at < oldest) map.delete(id);
    }
  }

  /**
   * Run `work` now and every `intervalMs`. Each tick calls it whether or not the previous call has settled: the
   * monitors join or abandon a read in progress themselves, the fence serializes its renewals, and a kill-switch
   * cancel attempt past its deadline is abandoned by the next read (r3 J2), so a hung call never stops the refreshes
   * or the obligations they carry.
   */
  #every(intervalMs: number, work: () => Promise<unknown>): void {
    const tick = (): void => {
      if (!this.#started) return;
      void work().catch(() => undefined);
      const handle = this.#options.timers.setTimeout(() => {
        this.#handles.delete(handle);
        tick();
      }, intervalMs);
      this.#handles.add(handle);
    };
    tick();
  }

  #now(): number | null {
    try {
      const value = this.#options.clock.monotonicMs();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  #record(entry: Parameters<LiveSafetyJournal["record"]>[0]): void {
    try {
      this.#options.journal.record(entry);
    } catch {
      // The journal's failure is the journal's to report.
    }
  }

  #page(page: Parameters<LiveSafetyAlerts["page"]>[0], detail: string): void {
    try {
      this.#options.alerts.page(page, detail);
    } catch {
      // A pager that throws loses the page.
    }
  }
}

/** The ONLY way to build the live-safety composition. Refuses every non-live run mode first. */
export function createLiveSafety(options: LiveSafetyOptions): LiveSafety {
  return LiveSafety.create(options);
}
