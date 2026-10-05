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
 * separately authorized package writes. It refuses to exist in any run mode
 * that does not submit real orders, so under the repository's defaults
 * (`MAX_RUN_MODE=PAPER`) no process can build one.
 *
 * ## How a live composition root uses it
 *
 * ```text
 * const safety = createLiveSafety({ runMode, accountRef, …ports });
 * const fence = await safety.acquireFence();               // ADR-008 §1–§2
 * const controller = createOrderHeartbeatController({      // polymarket-secure, ADR-033 D4
 *   runModeContext, transport,                             // the transport: ADR-033 D5, open
 *   gate: safety.heartbeatGate,                            // fence AND health lease (D1 item 2)
 *   heartbeatIds: safety.heartbeatIdSink,                  // ADR-008 §4
 *   initialHeartbeatId: fence.inheritedHeartbeatId ?? "",
 *   onEvent: safety.onHeartbeatEvent, budget, clock, timers,
 * });
 * safety.attachHeartbeat(controller);
 * safety.start(); controller.start();                      // starts lapsed (D6)
 * // the OMS's venue port: safety.fenceVenue(secureClient, refusals)
 * // WP-290's halt port: safety.halts
 * // every decision: safety.gate({ kind: "NEW_ENTRY", marketId, instanceId })
 * // every budget poll's events: controller.onBudgetEvents(events)
 * // every periodic reconcile report: safety.recordReconcileReport(report)
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
 * | OMS | read at each evaluation: the OMS is not faulted |
 * | DATABASE | every fence renewal and kill-switch read that succeeds; each failure fails it |
 * | RECONCILER | every reconcile report in which a run actually ran (the composition's periodic timer, and D6's own calls) |
 * | KILL_SWITCH | the latest kill-switch read: succeeded, and not ending trading |
 *
 * ## Kill-switch cancels
 *
 * After every successful read, each cancel an engaged switch asks for
 * (`kill-switch.ts`) is handed to the injected {@link KillSwitchCancelPort}
 * once per engage, and again after every read until the port answers `true`.
 */

import type { EligibilityVerdict, ClosedOnlyPort, GeoblockPort } from "./eligibility.js";
import { VenueEligibility } from "./eligibility.js";
import { evaluateLiveGate, type GateDecision, type GateRequest } from "./entry-gate.js";
import { fenceVenuePort, type FenceRefusals, type PlacementVenuePort } from "./fenced-venue.js";
import { FencingAuthority, isLiveRunMode, LiveFencingRefusal, type AcquireResult, type FencingLeasePort } from "./fencing-authority.js";
import { EventLoopProbe, HealthLease, ProofBoard, type HealthInput, type HealthProofReading, type HealthVerdict } from "./health-lease.js";
import { KillSwitchMonitor, type CancelDirective, type KillSwitchReader, type KillSwitchSnapshot } from "./kill-switch.js";
import { LapseRecovery } from "./lapse-recovery.js";
import type { HeartbeatView, LiveSafetyAlerts, LiveSafetyJournal, MonotonicClock, SafetyCoordinator, SafetyOms, SafetyTimers } from "./ports.js";

/** Carries out a kill switch's cancel (bound by the composition to the OMS or the secure client at `EMERGENCY_CANCEL`). `true` = done. */
export interface KillSwitchCancelPort {
  cancel(directive: CancelDirective): Promise<unknown>;
}

/** The sources of an explicit heartbeat stop (ADR-033 D1 item 4). */
export const HEARTBEAT_STOP_SOURCES = Object.freeze(["INCIDENT_CONTROLLER", "OPS_CLI", "LIVE_FENCING_CONFLICT"] as const);
export type HeartbeatStopSource = (typeof HEARTBEAT_STOP_SOURCES)[number];

/** The health inputs the composition proves itself; the others are this class's. */
export const COMPOSITION_PROVED_INPUTS = Object.freeze(["MARKET_DATA", "USER_DATA", "RECONCILER", "DATABASE"] as const);
export type CompositionProvedInput = (typeof COMPOSITION_PROVED_INPUTS)[number];

export interface LiveSafetyOptions {
  /** Checked FIRST: a run mode that does not submit real orders is refused before anything else is read. */
  readonly runMode: string;
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
  readonly killSwitch: { readonly reader: KillSwitchReader; readonly refreshIntervalMs: number; readonly cancels: KillSwitchCancelPort };
  readonly eligibility: { readonly geoblock: GeoblockPort; readonly closedOnly: ClosedOnlyPort; readonly refreshIntervalMs: number; readonly maxAgeMs: number };
  readonly oms: SafetyOms;
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
  readonly #board = new ProofBoard();
  readonly #health: HealthLease;
  readonly #eventLoop: EventLoopProbe;
  readonly #killSwitch: KillSwitchMonitor;
  readonly #eligibility: VenueEligibility;
  readonly #recovery: LapseRecovery;
  readonly #stops = new Map<HeartbeatStopSource, string>();
  readonly #haltedMarkets = new Set<string>();
  readonly #cancelsDone = new Set<string>();
  #accountHalted = false;
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
  /** WP-290's `HaltPort`, routed into the live gate (`WP290-RESIDUALS`: "route the halt port"). Latched until an operator releases them. */
  readonly halts: { haltMarket(request: { readonly marketId: string }): void; haltAccount(request: unknown): void };

  private constructor(options: LiveSafetyOptions) {
    this.#options = options;
    this.#fence = FencingAuthority.create({
      runMode: options.runMode,
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
    this.#killSwitch = new KillSwitchMonitor({ reader: options.killSwitch.reader, clock: options.clock, accountRef: options.accountRef });
    this.#eligibility = new VenueEligibility({
      geoblock: options.eligibility.geoblock,
      closedOnly: options.eligibility.closedOnly,
      clock: options.clock,
      maxAgeMs: options.eligibility.maxAgeMs,
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
      onReport: (report) => {
        this.recordReconcileReport(report);
      },
    });

    this.heartbeatGate = Object.freeze({ evaluate: () => this.#heartbeatGate() });
    this.heartbeatIdSink = Object.freeze({ persist: (heartbeatId: string) => this.#fence.recordHeartbeatId(heartbeatId) });
    this.onHeartbeatEvent = (event: unknown): void => {
      this.#onHeartbeatEvent(event);
    };
    this.halts = Object.freeze({
      haltMarket: (request: { readonly marketId: string }): void => {
        if (typeof request === "object" && request !== null && typeof request.marketId === "string") this.#haltedMarkets.add(request.marketId);
        else this.#accountHalted = true;
      },
      haltAccount: (): void => {
        this.#accountHalted = true;
      },
    });
  }

  /**
   * @throws {LiveFencingRefusal} in every run mode that does not submit real orders (PAPER included), before anything else is read.
   */
  static create(options: LiveSafetyOptions): LiveSafety {
    const runMode: unknown = typeof options === "object" && options !== null ? options.runMode : undefined;
    if (!isLiveRunMode(runMode)) throw new LiveFencingRefusal(runMode);
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

  /** The live gate (`entry-gate.ts`). */
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
        reconciliationHalts: () => ({ account: this.#accountHalted, markets: this.#haltedMarkets }),
      },
      request,
    );
  }

  /** The OMS's venue port behind the submission fence (`fenced-venue.ts`). */
  fenceVenue<TRequest, TSign, TOrder, TPlacement, TCancel>(
    venue: PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>,
    refusals: FenceRefusals<TSign, TPlacement>,
  ): PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel> {
    return fenceVenuePort(venue, () => this.gate({ kind: "TRANSMISSION" }), refusals);
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

  /** An operator's release of the reconciliation halts routed through {@link LiveSafety.halts}. */
  releaseReconciliationHalts(): void {
    this.#accountHalted = false;
    this.#haltedMarkets.clear();
  }

  /** Positive evidence for an input the composition proves (MARKET_DATA, USER_DATA, RECONCILER, DATABASE), at `atMs` (monotonic). */
  recordProof(input: CompositionProvedInput, atMs: number): void {
    if (COMPOSITION_PROVED_INPUTS.includes(input)) this.#board.prove(input, atMs);
  }

  recordFailure(input: CompositionProvedInput, reason: string): void {
    if (COMPOSITION_PROVED_INPUTS.includes(input)) this.#board.fail(input, reason);
  }

  /** A reconcile report (the composition's periodic timer, or D6's own calls): a run that ran proves the RECONCILER input. */
  recordReconcileReport(report: { readonly runs: readonly { readonly status: string }[] }): void {
    const now = this.#now();
    if (now === null) return;
    try {
      if (report.runs.some((run) => run.status !== "NOT_RUN")) this.#board.prove("RECONCILER", now);
    } catch {
      this.#board.fail("RECONCILER", "REPORT_UNREADABLE");
    }
  }

  /** Read the kill-switch rows now, then request every cancel an engaged switch asks for. */
  async refreshKillSwitch(): Promise<boolean> {
    const before = this.#now();
    const ok = await this.#killSwitch.refresh();
    if (!ok) {
      this.#board.fail("DATABASE", "KILL_SWITCH_READ_FAILED");
      // Paged on the transition into unreadable, not on every failed read.
      if (this.#killSwitchReadable) {
        this.#page("KILL_SWITCH_STATE_UNREADABLE", "the kill-switch rows could not be read; every submission is blocked and the heartbeat stops");
      }
      this.#killSwitchReadable = false;
      return false;
    }
    this.#killSwitchReadable = true;
    if (before !== null) this.#board.prove("DATABASE", before);
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
      reconciliationHalts: Object.freeze({ account: this.#accountHalted, markets: Object.freeze([...this.#haltedMarkets]) }),
    });
  }

  // -------------------------------------------------------------------------

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

  #omsProof(): HealthProofReading {
    const now = this.#now();
    if (now === null) return Object.freeze({ healthy: false as const, reason: "CLOCK_UNREADABLE" });
    try {
      return this.#options.oms.faulted === false ? Object.freeze({ healthy: true as const, provenAtMs: now }) : Object.freeze({ healthy: false as const, reason: "FAULTED" });
    } catch {
      return Object.freeze({ healthy: false as const, reason: "UNREADABLE" });
    }
  }

  async #renewFence(): Promise<void> {
    const before = this.#now();
    const result = await this.#fence.renew();
    if (result === "RENEWED" && before !== null) this.#board.prove("DATABASE", before);
    if (result === "UNKNOWN") this.#board.fail("DATABASE", "FENCE_RENEW_FAILED");
    if (result === "LOST") this.#record({ kind: "FENCE_LOST", reason: this.#fence.lossReason() ?? "RENEW_LOST", atMs: this.#now() ?? 0 });
  }

  async #enforceCancels(): Promise<void> {
    const snapshot = this.#killSwitch.snapshot();
    if (!snapshot.known) return;
    for (const { directive, killSwitchEventId } of snapshot.effects.cancels) {
      const key = `${killSwitchEventId}:${directive.scope}:${directive.scope === "MARKET" ? directive.marketId : directive.scope === "STRATEGY_INSTANCE" ? directive.instanceId : ""}`;
      if (this.#cancelsDone.has(key)) continue;
      let accepted = false;
      try {
        accepted = (await this.#options.killSwitch.cancels.cancel(directive)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) this.#cancelsDone.add(key);
      this.#record({ kind: "KILL_SWITCH_CANCEL_REQUESTED", directive: key, accepted, atMs: this.#now() ?? 0 });
    }
  }

  #every(intervalMs: number, work: () => Promise<unknown>): void {
    let running = false;
    const tick = (): void => {
      if (!this.#started) return;
      if (!running) {
        running = true;
        void work()
          .catch(() => undefined)
          .finally(() => {
            running = false;
          });
      }
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
