/**
 * The live-safety composition reaches the OMS, the coordinator, the heartbeat
 * controller and the fencing store through STRUCTURAL ports (`apps/trader`
 * declares no dependency on `@polymarket-bot/oms` or
 * `@polymarket-bot/polymarket-secure`). This file proves, at compile time (the
 * suite's script typechecks it first) and at run time, that the REAL objects
 * satisfy them, in both directions where the composition hands an object
 * back.
 */

import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_STOP_SOURCES,
  VENUE_CANCELLATION_CHECK_INTERVAL_MS as LIVE_SAFETY_SWEEP_MS,
  type FencingLeasePort,
  type HeartbeatView,
  type LiveSafety,
  type OmsProgressMonitor,
  type PlacementClassifier,
  type SafetyCoordinator,
  type SafetyOms,
} from "../../../apps/trader/src/live-safety/index.js";
import type {
  CancelOutcome,
  LimitOrderRequest,
  OmsReservationPort,
  OmsStore,
  OmsVenuePort,
  OrderManager,
  OrderManagerDependencies,
  PayloadCipher,
  PlacementOutcome,
  ReconciliationCoordinator,
  SignOutcome,
  SignedOrderHandle,
} from "../../../packages/oms/src/index.js";
import type { HeartbeatGate, HeartbeatIdSink, LapseCause, OrderHeartbeatController } from "../../../packages/polymarket-secure/src/heartbeat/index.js";
import { VENUE_CANCELLATION_CHECK_INTERVAL_MS as CONTROLLER_SWEEP_MS } from "../../../packages/polymarket-secure/src/heartbeat/index.js";
import type { FencingLeaseStore } from "../../../packages/storage-postgres/src/fencing/index.js";

// --- compile-time conformance (each assignment is a type check) --------------------------------------------------

export function omsIsASafetyOms(oms: OrderManager): SafetyOms {
  return oms;
}

export function coordinatorIsASafetyCoordinator(coordinator: ReconciliationCoordinator): SafetyCoordinator {
  return coordinator;
}

export function controllerIsAHeartbeatView(controller: OrderHeartbeatController): HeartbeatView {
  return controller;
}

export function storeIsAFencingLeasePort(store: FencingLeaseStore): FencingLeasePort {
  return store;
}

export function safetyGateIsTheControllersGate(safety: LiveSafety): HeartbeatGate {
  return safety.heartbeatGate;
}

export function safetySinkIsTheControllersSink(safety: LiveSafety): HeartbeatIdSink {
  return safety.heartbeatIdSink;
}

export function fencedVenueIsAnOmsVenuePort(
  safety: LiveSafety,
  venue: OmsVenuePort,
  refusals: { signRefused(reasons: readonly string[]): SignOutcome; placementRefused(reasons: readonly string[]): PlacementOutcome },
  classifier: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle>,
): OmsVenuePort {
  return safety.fenceVenue<LimitOrderRequest, SignOutcome, SignedOrderHandle, PlacementOutcome, CancelOutcome>(venue, refusals, classifier);
}

/** r1 I5: the progress monitor's wrapped store IS an `OmsStore` (what `OrderManager.open` takes). */
export function monitoredStoreIsAnOmsStore(monitor: OmsProgressMonitor, store: OmsStore): OmsStore {
  return monitor.store(store);
}

/** r2 X4: its wrapped reservation port IS an `OmsReservationPort`, and its wrapped cipher a `PayloadCipher`. */
export function monitoredReservationsAreAnOmsReservationPort(monitor: OmsProgressMonitor, port: OmsReservationPort): OmsReservationPort {
  return monitor.reservations(port);
}

export function monitoredCipherIsAPayloadCipher(monitor: OmsProgressMonitor, cipher: PayloadCipher): PayloadCipher {
  return monitor.cipher(cipher);
}

/** r2 X4: `dependencies()` takes, and gives back, WP-270's whole dependency object. */
export function monitoredDependenciesAreOrderManagerDependencies(monitor: OmsProgressMonitor, deps: OrderManagerDependencies): OrderManagerDependencies {
  return monitor.dependencies(deps);
}

/**
 * r2 X4: the keys of WP-270's `OrderManagerDependencies` whose value is (or has a method that returns) a Promise —
 * the ports the OMS awaits, and so the ones a hung call can wedge it on. Exactly the three the monitor times plus the
 * venue (module header of `oms-progress.ts`). A port WP-270 adds later fails this assignment until it is classified.
 */
type ReturnsPromise<T> = T extends (...args: never[]) => infer R ? (R extends PromiseLike<unknown> ? true : false) : false;
type HasAsyncMethod<T> = T extends (...args: never[]) => unknown ? ReturnsPromise<T> : true extends { [K in keyof T]: ReturnsPromise<T[K]> }[keyof T] ? true : false;
type AsyncPortsOf<T> = { [K in keyof T]-?: HasAsyncMethod<T[K]> extends true ? K : never }[keyof T];
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const OMS_ASYNC_PORTS_ARE_CLASSIFIED: Exactly<AsyncPortsOf<OrderManagerDependencies>, "store" | "reservations" | "cipher" | "venue"> = true;

// --- run-time agreements ---------------------------------------------------------------------------------------

describe("the structural ports agree with the real objects", () => {
  it("the 5 s sweep allowance is the same figure on both sides (S-D17: the cancellation check runs every five seconds)", () => {
    expect(LIVE_SAFETY_SWEEP_MS).toBe(CONTROLLER_SWEEP_MS);
  });

  it("r2 X4: the OMS's asynchronous dependency ports are the three the progress monitor times, plus the venue (compile-time; see the type above)", () => {
    expect(OMS_ASYNC_PORTS_ARE_CLASSIFIED).toBe(true);
  });

  it("the controller's lapse cause for a refused gate is the one the composition pages on", () => {
    const cause: LapseCause = "GATE_REFUSED";
    expect(cause).toBe("GATE_REFUSED");
    expect([...HEARTBEAT_STOP_SOURCES]).toEqual(["INCIDENT_CONTROLLER", "OPS_CLI", "LIVE_FENCING_CONFLICT"]);
  });
});
