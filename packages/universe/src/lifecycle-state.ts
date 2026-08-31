/**
 * The market lifecycle vocabulary.
 *
 * The five states are WP-040's `internal.market_lifecycle_state`
 * (`db/migrations/0001_foundation.up.sql`), derived there from the §7.4
 * lifecycle events. They live in their own module because both the parameter
 * snapshot (§10.1 `market_parameter_history.status`) and the lifecycle
 * projection use them, and a shared vocabulary must not create an import cycle
 * between the two.
 *
 * FOUR of the five are EVENT-DRIVEN — `DISCOVERED`, `OPEN`, `CLOSING` and
 * `RESOLVED` each correspond to an observed §7.4 event. `CLOSED` has no event:
 * the frozen domain contracts carry `MarketClosing` (closing is scheduled or
 * observed) and `MarketResolved`, and nothing that asserts "the trading window
 * has now ended". It is therefore DERIVED from the scheduled close instant and
 * an "as of" instant the caller supplies — see `effectiveLifecycleState` in
 * `lifecycle.ts` — and never stored as a transition. Because it is derived
 * from a SCHEDULE, it asserts only "the announced close instant has elapsed",
 * never "the venue stopped trading" (round-1 review, M3): the schedule can be
 * wrong in either direction, and readiness treats derived `CLOSED` as an
 * activation stop while observation continues. Inventing a
 * `MarketClosed` event to make it storable would be exactly the "work around a
 * missing contract by inventing a shape" that this package must not do; the gap
 * is reported in `docs/handoffs/WP-110.md` instead.
 */

import { z } from "zod";

export const MarketLifecycleStateSchema = z.enum([
  "DISCOVERED",
  "OPEN",
  "CLOSING",
  "CLOSED",
  "RESOLVED",
]);
export type MarketLifecycleState = z.infer<typeof MarketLifecycleStateSchema>;

/** The states an observed §7.4 event can put a market into. */
export const EVENT_DRIVEN_LIFECYCLE_STATES = [
  "DISCOVERED",
  "OPEN",
  "CLOSING",
  "RESOLVED",
] as const satisfies readonly MarketLifecycleState[];

export type EventDrivenLifecycleState = (typeof EVENT_DRIVEN_LIFECYCLE_STATES)[number];

/** Ordering used to detect a regression. `CLOSED` sits between closing and resolved. */
const LIFECYCLE_ORDER: Readonly<Record<MarketLifecycleState, number>> = Object.freeze({
  DISCOVERED: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
  RESOLVED: 4,
});

/** Monotonic rank of a lifecycle state; a market never moves to a lower rank. */
export function lifecycleRank(state: MarketLifecycleState): number {
  return LIFECYCLE_ORDER[state];
}
