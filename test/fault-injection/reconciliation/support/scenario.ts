/**
 * Small helpers shared by the WP-290 acceptance suites: a process that has
 * passed its STARTUP run, and the assertions that state "submissions stay
 * paused" in full.
 */

import { expect } from "vitest";

import type { OrderManager } from "../../../../packages/oms/src/index.js";
import { group, ticket } from "../../../unit/oms/support/harness.js";

import { boot, universe, YES, type Process, type Universe } from "./harness.js";
import type { Transmission } from "./world.js";

export const G_YES = group(9001, { tokenId: YES, plannedShares: "5" });

export interface Ready {
  readonly u: Universe;
  readonly p: Process;
  readonly oms: OrderManager;
}

/** A process past its STARTUP run, trading resumed, with one group registered. */
export async function ready(options: Parameters<typeof universe>[0] = {}): Promise<Ready> {
  const u = universe(options);
  const p = await boot(u);
  const startup = await p.coordinator.reconcile();
  expect(startup.resumed, "the STARTUP run resumes an empty, consistent account").toBe(true);
  const oms = p.oms as OrderManager;
  expect((await oms.registerGroup(G_YES)).ok).toBe(true);
  return { u, p, oms };
}

export function sequence(list: readonly Transmission[], then: Transmission = "ACCEPT_LIVE"): () => Transmission {
  let index = 0;
  return () => list[index++] ?? then;
}

let nextTicket = 500;

/** Submit one BUY of 1 share at 0.5 in G_YES; returns the attempt id, or `null` when refused. */
export async function submitOne(oms: OrderManager, overrides: Parameters<typeof ticket>[1] = {}): Promise<string | null> {
  nextTicket += 1;
  const result = await oms.submit(ticket(G_YES, { n: nextTicket, shares: "1", ...overrides }));
  return result.ok ? result.value.submissionAttemptId : null;
}

/**
 * The full statement of "submissions stay paused": the run did not resume, the
 * OMS is paused and refuses a new submission with `OMS_PAUSED`, the
 * coordinator holds, and the named break is unresolved in the journal.
 */
export async function expectPaused(ready: Ready, resumed: boolean, breakClass: string): Promise<void> {
  const { p, oms } = ready;
  expect(resumed, `${breakClass}: the run did not resume`).toBe(false);
  expect(oms.paused, `${breakClass}: the OMS is paused`).toBe(true);
  expect(p.coordinator.status().holding, `${breakClass}: the coordinator holds`).toBe(true);
  const classes = p.journal.unresolvedBreaks().map((view) => view.breakClass);
  expect(classes, `${breakClass}: the break is unresolved`).toContain(breakClass);
  nextTicket += 1;
  const refused = await oms.submit(ticket(G_YES, { n: nextTicket, shares: "1" }));
  expect(refused.ok, `${breakClass}: a new submission is refused`).toBe(false);
  if (!refused.ok) expect(refused.refusal.code).toBe("OMS_PAUSED");
}

/** Run reconciliation `times` times, advancing the clock past the horizon each time; `true` if any run resumed. */
export async function reconcileRounds(ready: Ready, times: number): Promise<boolean> {
  let resumed = false;
  for (let round = 0; round < times; round += 1) {
    resumed = (await ready.p.coordinator.reconcile()).resumed || resumed;
    if (resumed) return true;
    ready.u.clock.t += ready.u.policy.quiescenceHorizonMs + 1;
  }
  return resumed;
}
