/**
 * WP-340: ONE LIVE-SHAPED PROCESS over the mock CLOB, composed from the real
 * Wave 3 packages, and the world that survives its crashes.
 *
 * ## What is real
 *
 * - WP-260's `SecureVenueClient` (`createSecureVenueClientForTesting`: the
 *   run-mode gate runs on a live-SHAPED literal context, the mock signer is
 *   sealed by the package, the signed order is cross-checked against the
 *   request and the account, every answer is classified by WP-260's own
 *   mapping), over the fake-SDK seam the mock CLOB scripts;
 *   `SignedOrderEnvelope.fromPersistedPayload` restores signed orders;
 * - WP-270's `OrderManager`, WP-300's `ReservationService` (in memory),
 *   WP-290's `ReconciliationCoordinator`, its `ReconciliationJournal` and
 *   the real `Ledger`;
 * - WP-280's `createUserStreamManager` (live-shaped context, the mock
 *   channel as its socket port), whose outputs go to the coordinator;
 * - optionally WP-310's `VenueModeDetector` in front of the OMS's venue port
 *   (`withModeDetection`, `venueModeSource`).
 *
 * ## What is doubled
 *
 * The venue (the mock CLOB), the OMS store (WP-270's `MemoryStore`), the
 * payload cipher (WP-270's `MockCipher`), the journal's sink and the clock
 * (WP-320's `ManualTime`): the ports a live composition binds to PostgreSQL,
 * an AEAD key and the system clock. Nothing reaches a network, a database or
 * a key.
 *
 * ## Crashes
 *
 * Every port call an incarnation makes is counted by WP-290's `Incarnation`
 * (imported read-only): store transactions and loads, the cipher, the
 * reservations, the reconciliation requests, the OMS's venue calls, the
 * coordinator's reads, journal appends, ledger calls and halts, AND the
 * SDK-level steps beneath WP-260's client that the mock CLOB exposes as
 * checkpoints: the signer call (mid-signing), the venue's receipt
 * (mid-transmission), the venue's answer (mid-answer) and the heartbeat. A
 * kill plan stops the process BEFORE or AFTER the k-th call; every later
 * call of that incarnation throws, so it can neither write, send nor read,
 * and its sockets are severed. The world carries on, and a fresh
 * incarnation restarts through the store.
 */

import { compareDecimal } from "../../../../packages/decimal/src/index.js";
import { buildUnattributedCorrection, projectedHoldings, projectLedger, ReconciliationJournal } from "../../../../packages/ledger/src/index.js";
import {
  OrderManager,
  ReconciliationCoordinator,
  VenueModeDetector,
  venueModeSource,
  withModeDetection,
  type HaltPort,
  type OmsReservationPort,
  type OmsStore,
  type OmsVenuePort,
  type OrderManagerDependencies,
  type PayloadCipher,
  type ReconciledOms,
  type VenueMode,
} from "../../../../packages/oms/src/index.js";
import { SignedOrderEnvelope, type RateLimitObservation, type SecureVenueClient } from "../../../../packages/polymarket-secure/src/index.js";
import { createUserStreamManager, type UserStreamManager, type UserStreamOutput } from "../../../../packages/polymarket-secure/src/user-stream/index.js";
import { createMockSignerHandle, createSecureVenueClientForTesting, type MockSignerProbe } from "../../../../packages/polymarket-secure/src/testing/index.js";
import { LIVE_SHAPED_CONTEXT, ManualTime } from "../../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import {
  ACCOUNT,
  Incarnation,
  Killed,
  MARKET,
  MARKET_NO,
  NO,
  PUSD,
  YES,
  consistencyProblems,
  remainingBookingsOf,
  syncLedger,
  universe,
  type KillPlan,
  type Universe,
} from "../../reconciliation/support/harness.js";
import { WP280_MARKET } from "../../reconciliation/support/wp280.js";

import { MockClob, type Checkpoint } from "./mock-clob.js";
import { loadSdkErrors } from "./sdk-errors.js";
import { MockUserChannel, deliverAll, type ChannelChaos } from "./user-channel.js";

export { ACCOUNT, Incarnation, Killed, MARKET, MARKET_NO, NO, PUSD, YES, type KillPlan };

/** What survives every crash: the venue, the OMS store, the journal's durable events, the ledger, the inventory and time. */
export interface LiveWorld {
  readonly time: ManualTime;
  readonly u: Universe;
  readonly clob: MockClob;
  /** Every quarantine the recovery driver released as a KNOWN FINDING (`releaseKnownFindings`), with its break id. */
  readonly findings: { readonly finding: "WP340-F1"; readonly breakId: string; readonly detail: string }[];
}

/**
 * WP340-F1 (STOPPED; `findings.test.ts`): an observation the stream delivered while a placement's answer was unknown is
 * RETAINED by the OMS, and drained only AFTER the reconciliation's PRESENT answer adopted the venue's terminal state;
 * the stale `LIVE` then reads as "a terminal order was observed LIVE", a halting EVIDENCE_CONFLICT alert, and WP-290
 * quarantines the market (`OMS_HALTING_ALERT`, operator-releasable). The detail text below is that alert's, verbatim.
 */
export const WP340_F1_DETAIL = "a terminal order was observed LIVE";
/** The alert a restarted OMS raises for a conflict its store still holds open (WP-270's recovery), verbatim. */
export const RECOVERED_CONFLICT_DETAIL = "recovered with an open evidence conflict";

/**
 * Is this quarantine WP340-F1? Its alert says so, or it is the recovered alert of a conflict whose every durable
 * record has F1's shape: an `EVIDENCE_CONFLICT` order event out of a TERMINAL state (FILLED or CANCELED) caused by an
 * observation of `LIVE` (WP-270 persists the conflicting observation in the event's payload).
 */
export function isWp340F1(world: LiveWorld, view: { readonly breakClass: string; readonly status: string; readonly detail: string; readonly orderId: string | null }): boolean {
  if (view.breakClass !== "OMS_HALTING_ALERT" || view.status !== "QUARANTINED") return false;
  if (view.detail.endsWith(WP340_F1_DETAIL)) return true;
  if (!view.detail.endsWith(RECOVERED_CONFLICT_DETAIL) || view.orderId === null) return false;
  const conflicts = world.u.store.snapshotSync().events.filter((event) => event.orderId === view.orderId && event.eventType === "EVIDENCE_CONFLICT");
  return (
    conflicts.length > 0 &&
    conflicts.every((event) => (event.previousState === "FILLED" || event.previousState === "CANCELED") && event.payload !== null && event.payload["status"] === "LIVE")
  );
}

export async function liveWorld(options: { readonly pusd?: string; readonly cancelAllScope?: "CREDENTIAL" | "ACCOUNT" } = {}): Promise<LiveWorld> {
  const time = new ManualTime();
  const errors = await loadSdkErrors();
  const base = universe({ pusd: options.pusd ?? "1000" });
  // The coordinator's clock and the venue's epoch read the one time line (WP-320's live-process convention).
  Object.defineProperty(base.clock, "t", {
    get: () => time.epochMs(),
    set: () => {
      throw new Error("this suite drives time through ManualTime");
    },
    configurable: true,
  });
  const clob = new MockClob({ time, errors, collateral: options.pusd ?? "1000", collateralAssetId: PUSD });
  if (options.cancelAllScope !== undefined) clob.cancelAllScope = options.cancelAllScope;
  const u: Universe = { ...base, world: clob };
  return { time, u, clob, findings: [] };
}

/**
 * The operator's review of a KNOWN finding, and nothing else: every quarantined `OMS_HALTING_ALERT` whose detail is
 * WP340-F1's is released (`ReconciliationCoordinator.releaseQuarantine`, which resumes nothing by itself: it queues a
 * MANUAL_REQUEST run that must pass on its own) and recorded in `world.findings`. Any other quarantine stays. Returns how
 * many were released.
 */
export async function releaseKnownFindings(world: LiveWorld, node: LiveNode): Promise<number> {
  let released = 0;
  for (const view of node.journal.unresolvedBreaks()) {
    if (!isWp340F1(world, view)) continue;
    const result = await node.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-wp340", reason: "WP340-F1 reviewed: a retained stream observation drained after a terminal answer" });
    if (!result.ok) continue;
    released += 1;
    world.findings.push({ finding: "WP340-F1", breakId: view.breakId, detail: view.detail });
  }
  return released;
}

export interface NodeOptions {
  readonly plan?: KillPlan | null;
  /** The API-key label the process trades under (default `trader`). */
  readonly credential?: string;
  /** The process label the venue's log records (default the credential). */
  readonly source?: string;
  /** Compose WP-280's manager (default true). */
  readonly stream?: boolean;
  readonly chaos?: ChannelChaos;
  /** Put WP-310's restricted-mode detector in front of the venue port. */
  readonly modeDetection?: unknown;
  /** WP-260's `onRateLimitUpdate`: the secure client's sanitized observation of every answer's rate-limit headers. */
  readonly onRateLimitUpdate?: (observation: RateLimitObservation) => void;
  /** Wrap the OMS's venue port (e.g. WP-320's fence); applied outside the counting and the mode detection. */
  readonly wrapVenue?: (venue: OmsVenuePort) => OmsVenuePort;
  /** Wrap the OMS's persistence dependencies (e.g. WP-320's progress monitor). */
  readonly wrapDependencies?: (deps: OrderManagerDependencies) => OrderManagerDependencies;
  /**
   * A composition step run after the coordinator exists and BEFORE the OMS opens (WP-320's live root: the safety
   * composition is built over the coordinator and a lazy view of the OMS, then fences the OMS's venue). It may return
   * venue and dependency wraps, and a halt port WP-290's halts are routed to as well.
   */
  readonly compose?: (parts: {
    readonly coordinator: ReconciliationCoordinator;
    readonly inc: Incarnation;
    readonly client: SecureVenueClient;
    readonly oms: () => OrderManager | null;
  }) => { readonly wrapVenue?: (venue: OmsVenuePort) => OmsVenuePort; readonly wrapDependencies?: (deps: OrderManagerDependencies) => OrderManagerDependencies; readonly halts?: HaltPort };
}

export interface LiveNode {
  readonly inc: Incarnation;
  readonly client: SecureVenueClient;
  readonly signer: MockSignerProbe;
  readonly coordinator: ReconciliationCoordinator;
  readonly journal: ReconciliationJournal;
  /** `null` when the incarnation died while opening. */
  readonly oms: OrderManager | null;
  readonly stream: UserStreamManager | null;
  readonly channel: MockUserChannel | null;
  readonly detector: VenueModeDetector | null;
  /** Every stream output the process received, in order. */
  readonly outputs: UserStreamOutput[];
  /** End the incarnation (a crash already ended it; a clean stop ends it here): nothing it holds acts again. */
  reap(): void;
}

/** The OMS seen by the coordinator, with WP-290's oracle on every answer and every resume (R1–R3). */
function oracleOms(world: LiveWorld, oms: OrderManager): ReconciledOms {
  const { u, clob } = world;
  return {
    get paused() {
      return oms.paused;
    },
    get faulted() {
      return oms.faulted;
    },
    pause: () => oms.pause(),
    resume: () => {
      const result = oms.resume();
      if (result.ok) {
        u.resumes += 1;
        for (const problem of consistencyProblems(u, oms)) u.violations.push(`R1 (resumed while inconsistent): ${problem}`);
      }
      return result;
    },
    attempts: () => oms.attempts(),
    orders: () => oms.orders(),
    alerts: () => oms.alerts(),
    retainedEvidence: () => oms.retainedEvidence(),
    outstandingReconciliations: () => oms.outstandingReconciliations(),
    retryReconciliationRequests: () => {
      u.omsRetries += 1;
      return oms.retryReconciliationRequests();
    },
    applyReconciliation: async (raw: unknown) => {
      const answer = raw as { readonly submissionAttemptId: string; readonly verdict: string; readonly transmissionQuiescent?: boolean; readonly order?: { readonly venueOrderId: string } };
      const salt = oms.attempt(answer.submissionAttemptId)?.salt;
      clob.settleArrivals();
      const result = await oms.applyReconciliation(raw);
      if (result.ok && salt !== undefined) {
        if (answer.verdict === "ABSENT" && (clob.orders.has(salt) || clob.isPending(salt))) u.violations.push(`R2: ABSENT accepted for salt ${salt}, which the venue holds or may still receive`);
        if (answer.verdict === "PRESENT" && answer.order?.venueOrderId !== clob.venueOrderIdOf(salt)) u.violations.push(`R3: PRESENT accepted for salt ${salt} naming ${answer.order?.venueOrderId ?? "?"}`);
        u.accepted.push({ verdict: answer.verdict, attemptId: answer.submissionAttemptId, venueOrderId: answer.order?.venueOrderId ?? null, quiescent: answer.transmissionQuiescent === true });
      }
      return result;
    },
    applyOrderObservation: (raw: unknown) => oms.applyOrderObservation(raw),
    recordFill: (raw: unknown) => oms.recordFill(raw),
    applySettlement: (raw: unknown) => oms.applySettlement(raw),
    requestOrderReconciliation: (orderId: string) => oms.requestOrderReconciliation(orderId),
  };
}

/** Boot one process: the journal (replayed), the secure client, the coordinator, the OMS (opened from the store), the binding (STARTUP), then the user stream. */
export async function bootNode(world: LiveWorld, options: NodeOptions = {}): Promise<LiveNode> {
  const { u, clob, time } = world;
  const inc = new Incarnation(options.plan ?? null);
  const checkpoint: Checkpoint = (name, run) => inc.call(name, run);
  const credential = options.credential ?? "trader";
  const source = options.source ?? credential;
  const opened = ReconciliationJournal.open({
    accountRef: ACCOUNT,
    history: [...u.journalEvents],
    sink: { append: (event) => inc.call("journal.append", async () => void u.journalEvents.push(event)) },
  });
  if (!opened.ok) throw new Error(`the journal history did not replay: ${opened.refusal.message}`);
  const journal = opened.value;
  const { handle, probe } = createMockSignerHandle();
  const client = await createSecureVenueClientForTesting(
    { runModeContext: LIVE_SHAPED_CONTEXT, signer: handle, ...(options.onRateLimitUpdate === undefined ? {} : { onRateLimitUpdate: options.onRateLimitUpdate }) },
    clob.sdk(credential, { source, checkpoint, alive: () => inc.alive }),
  );
  const reads = clob.readPort();
  // Where WP-290's halts are ALSO routed (the composition step's port), once it ran.
  const routed: { halts: HaltPort | undefined } = { halts: undefined };
  const coordinator = new ReconciliationCoordinator({
    reads: {
      listOpenOrders: () => inc.call("read.openOrders", () => reads.listOpenOrders()),
      readOrder: (id) => inc.call("read.order", () => reads.readOrder(id)),
      listTrades: () => inc.call("read.trades", () => reads.listTrades()),
      readPositions: () => inc.call("read.positions", () => reads.readPositions()),
      readCollateral: () => inc.call("read.collateral", () => reads.readCollateral()),
      readApprovals: () => inc.call("read.approvals", () => reads.readApprovals()),
      readWalletMember: (member) => inc.call("read.walletMember", () => reads.readWalletMember(member)),
    },
    journal,
    holdings: {
      projected: () =>
        inc.call("ledger.projected", async () => {
          syncLedger(u);
          return projectedHoldings(projectLedger(u.ledger), ACCOUNT);
        }),
      remainingBookings: (fills) => inc.call("ledger.bookings", async () => remainingBookingsOf(u, fills)),
      bookUnattributed: (booking) =>
        inc.call("ledger.book", async () => {
          const built = buildUnattributedCorrection({
            ledgerTransactionId: booking.ledgerTransactionId,
            reconciliationRunId: booking.reconciliationRunId,
            environment: "PAPER",
            accountRef: ACCOUNT,
            assetId: booking.assetId,
            assetKind: booking.assetKind,
            marketId: booking.marketId,
            delta: booking.delta,
            occurredAt: "2026-10-03T00:00:00.000Z",
            venueClearingAccount: "clearing-venue",
            attributionClearingAccount: "clearing-attribution",
          });
          if (!built.ok) return { ok: false };
          const appended = u.ledger.append(built.value);
          if (!appended.ok) return { ok: false };
          u.ledger = appended.value.ledger;
          return { ok: true };
        }),
    },
    halts: {
      haltMarket: (request) =>
        inc.callSync("halt.market", () => {
          u.halts.push(request);
          routed.halts?.haltMarket(request);
        }),
      haltAccount: (request) =>
        inc.callSync("halt.account", () => {
          u.halts.push({ ...request, marketId: null });
          routed.halts?.haltAccount(request);
        }),
    },
    clock: { now: () => time.epochMs() },
    newId: u.coordinatorIds,
    marketOfToken: (tokenId) => (tokenId === YES ? MARKET : tokenId === NO ? MARKET_NO : null),
    tokenOfGroup: (executionGroupId) => u.store.snapshotSync().groups.get(executionGroupId)?.tokenId ?? null,
    policy: u.policy,
  });

  // The OMS's venue: WP-260's client, every call counted; optionally WP-310's detector and an outer wrap (the fence).
  const counted: OmsVenuePort = {
    createLimitOrder: (request) => inc.call("venue.sign", () => client.createLimitOrder(request)),
    postOrder: (order) => inc.call("venue.post", () => client.postOrder(order as unknown as SignedOrderEnvelope)),
    postOrders: (orders) => inc.call("venue.postBatch", () => client.postOrders(orders as unknown as readonly SignedOrderEnvelope[])),
    cancelOrder: (orderId) => inc.call("venue.cancel", () => client.cancelOrder(orderId)),
  };
  let detector: VenueModeDetector | null = null;
  let venue: OmsVenuePort = counted;
  let venueMode: () => VenueMode = () => "NORMAL";
  if (options.modeDetection !== undefined) {
    const created = VenueModeDetector.create([options.modeDetection]);
    if (!created.ok) throw new Error(`the restricted-mode configuration did not load: ${created.problems.join("; ")}`);
    detector = created.value;
    venue = withModeDetection(counted, detector, () => time.epochMs());
    venueMode = venueModeSource(detector, () => time.epochMs());
  }
  let oms: OrderManager | null = null;
  const composed = options.compose?.({ coordinator, inc, client, oms: () => oms }) ?? {};
  routed.halts = composed.halts;
  if (options.wrapVenue !== undefined) venue = options.wrapVenue(venue);
  if (composed.wrapVenue !== undefined) venue = composed.wrapVenue(venue);
  const store: OmsStore = {
    apply: (writes) => inc.call(`store.apply[${writes.map((write) => write.kind).join(",")}]`, () => u.store.apply(writes)),
    load: () => inc.call("store.load", () => u.store.load()),
  };
  const cipher: PayloadCipher = {
    encrypt: (text) => inc.call("cipher.encrypt", () => u.cipher.encrypt(text)),
    decrypt: (payload) => inc.call("cipher.decrypt", () => u.cipher.decrypt(payload)),
  };
  const reservations: OmsReservationPort = {
    reserve: (input) => inc.call("inventory.reserve", () => u.inventory.service.reserve(input)),
    consume: (input) => inc.call("inventory.consume", () => u.inventory.service.consume(input)),
    release: (input) => inc.call("inventory.release", () => u.inventory.service.release(input)),
  };
  let deps: OrderManagerDependencies = {
    venue,
    restoreSignedOrder: (payload) => SignedOrderEnvelope.fromPersistedPayload(payload),
    store,
    cipher,
    reservations,
    reconciler: { request: (request) => inc.callSync("reconciler.request", () => coordinator.omsRequester.request(request)) },
    newId: u.omsIds,
    requestToken: u.requestToken,
    venueMode,
    collateralAssetId: PUSD,
  };
  if (options.wrapDependencies !== undefined) deps = options.wrapDependencies(deps);
  if (composed.wrapDependencies !== undefined) deps = composed.wrapDependencies(deps);
  try {
    const result = await OrderManager.open(deps);
    if (result.ok) oms = result.value;
    else if (inc.alive) throw new Error(`open refused while alive: ${result.refusal.code}`);
  } catch (error) {
    if (!(error instanceof Killed) && inc.alive) throw error;
  }
  if (oms !== null) coordinator.bindOms(oracleOms(world, oms));

  const outputs: UserStreamOutput[] = [];
  let stream: UserStreamManager | null = null;
  let channel: MockUserChannel | null = null;
  if (options.stream !== false && inc.alive) {
    channel = new MockUserChannel({ clob, time, credential, alive: () => inc.alive, chaos: options.chaos ?? deliverAll() });
    stream = createUserStreamManager({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport: channel,
      timers: { now: () => time.epochMs(), setTimeout: (callback, delayMs) => time.setTimeout(callback, delayMs), clearTimeout: (handle) => time.clearTimeout(handle) },
      markets: [WP280_MARKET],
      onOutput: (output) => {
        if (!inc.alive) return;
        outputs.push(output);
        coordinator.onUserStreamOutput(output);
      },
    });
    coordinator.bindUserStream(stream);
    stream.start();
    // The transport opens on the time line: let it open and subscribe before the process does anything else.
    await time.advance(0);
  }
  const node: LiveNode = {
    inc,
    client,
    signer: probe,
    coordinator,
    journal,
    oms,
    stream,
    channel,
    detector,
    outputs,
    reap: () => {
      inc.alive = false;
      channel?.sever();
      try {
        stream?.stop();
      } catch {
        // A dead process's manager may fail to stop cleanly; it is severed either way.
      }
    },
  };
  return node;
}

/** Run `step` and absorb the kill (a `Killed` from a dead incarnation ends the scenario; anything else is a failure). */
export async function survive(node: LiveNode, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (!(error instanceof Killed) && node.inc.alive) throw error;
  }
}

/**
 * Reconcile until the coordinator resumes, advancing the shared time past the quiescence horizon between attempts
 * (stream timers, the venue's checks and late arrivals all run in that time). `true` once a run resumed.
 */
export async function reconcileUntilResumed(world: LiveWorld, node: LiveNode, rounds = 10): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    // A TIMELY stream: every frame the venue already published is delivered before the run reads (a frame that
    // lags a read is the stream suite's subject, not this helper's).
    await world.time.advance(0);
    let resumed = false;
    try {
      resumed = (await node.coordinator.reconcile()).resumed;
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
    if (resumed && node.oms !== null && !node.oms.paused) return true;
    await world.time.advance(world.u.policy.quiescenceHorizonMs + 1);
  }
  return false;
}

/**
 * What a live composition does after a restart (WP-270's §9.11 step 9, as its crash harness drives it): once the
 * account resumed, every attempt the OMS holds ABSENT on the restart path is resent as the SAME signed order (restored
 * through `SignedOrderEnvelope.fromPersistedPayload`, transmitted through WP-260's client), or abandoned when the OMS
 * refuses that; a recovered, never-transmitted SIGNED attempt is sent as it is. Every abandonment the OMS accepts is
 * checked against the venue (S6: the salt is neither live nor travelling). Then it reconciles until resumed again.
 */
export async function drainAfterRestart(world: LiveWorld, node: LiveNode, rounds = 3): Promise<boolean> {
  const oms = node.oms;
  if (oms === null) return false;
  let resumed = await reconcileUntilResumedOrReviewed(world, node);
  for (let round = 0; round < rounds && resumed; round += 1) {
    let acted = false;
    for (const attempt of oms.attempts()) {
      if (attempt.absentConfirmed && !attempt.inFlight && attempt.state === "RECONCILING") {
        acted = true;
        const resent = await oms.retransmitSameSignedOrder(attempt.submissionAttemptId);
        if (!resent.ok) await abandonChecked(world, oms, attempt.submissionAttemptId, attempt.salt);
      } else if (attempt.state === "SIGNED") {
        acted = true;
        if (attempt.signedPayloadAvailable) await oms.transmitSigned(attempt.submissionAttemptId);
        else await abandonChecked(world, oms, attempt.submissionAttemptId, attempt.salt);
      }
    }
    if (!acted) break;
    node.coordinator.trigger("PERIODIC_TIMER");
    resumed = await reconcileUntilResumedOrReviewed(world, node);
  }
  return resumed;
}

/** Reconcile until resumed; when held only by WP340-F1 quarantines, release those (the operator's review) and go on. */
export async function reconcileUntilResumedOrReviewed(world: LiveWorld, node: LiveNode): Promise<boolean> {
  let resumed = await reconcileUntilResumed(world, node);
  for (let review = 0; review < 3 && !resumed; review += 1) {
    if ((await releaseKnownFindings(world, node)) === 0) break;
    resumed = await reconcileUntilResumed(world, node);
  }
  return resumed;
}

async function abandonChecked(world: LiveWorld, oms: OrderManager, attemptId: string, salt: string): Promise<void> {
  const result = await oms.abandonAttempt(attemptId);
  if (!result.ok) return;
  const order = world.clob.orders.get(salt);
  if ((order !== undefined && order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0) || world.clob.isPending(salt)) {
    world.u.violations.push(`S6: abandonment accepted for salt ${salt}, which is live or travelling`);
  }
}
