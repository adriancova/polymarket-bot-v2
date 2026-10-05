/**
 * `CO2-N1` (ADR-031) — the process's own clock for files that feed this
 * suite's RECORDED fixtures to a trader.
 *
 * ## Why these files need it
 *
 * ADR-031 makes the trader's admission read its §12.1 clock once per
 * placement. An ENTRY whose event is older than `freshness.featuresMaxAgeMs`
 * at that reading is refused `RISK_FEATURES_STALE` (R3), and one whose
 * reading is inside the entry cutoff before the configured close is refused
 * `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` (R4). This suite's fixtures are stamped
 * `2026-03-04` (or `2026-05-01`). Fed through the host's own
 * `SystemPaperClock`, every entry in them is months late and its market long
 * closed, so every entry is refused: exactly what the guard is for, and not
 * what these files test (ADR-031 §1.8).
 *
 * ## What this module offers
 *
 * - {@link RebasedSystemPaperClock}: for a file that hands the trader its
 *   clock (`assembleDurableTrader({ clock })`). It is the host's clock — the
 *   process's own `SystemPaperClock`, read LIVE on every call — re-based so
 *   that the instant it is created reads as a recorded instant the caller
 *   names (the scenario's first event). From there it advances in real time,
 *   as the process's clock does. The offset is FIXED, so the lag the guard
 *   measures at an event is `max(0, W − E)`: W is the wall time elapsed since
 *   the clock was re-based, and E is the event's recorded offset from the
 *   anchor. That is how far the run's real progress has fallen behind the
 *   recorded pace since the re-basing, setup and publication time included.
 *   It is NOT the trader's processing delay of that event. An event recorded
 *   later than the anchor plus W reads lag 0: the clock is behind it
 *   (ADR-031 T7). So a scenario whose recorded events are minutes apart
 *   (`durable-two-brackets-postgres-redis.test.ts`, for example) is judged at
 *   lag 0 once its recorded time runs ahead of the wall time. Its monotonic
 *   reading is the host's, unchanged.
 * - {@link rebaseSystemPaperClock}: the same reading for a file that runs
 *   `startup()`, which builds its own `SystemPaperClock` and takes no clock
 *   port. It re-bases `SystemPaperClock.prototype.now` — and nothing else: not
 *   the global `Date`, so the database, the transport, the research worker
 *   and every identifier minted from `Date.now()` keep the real time — until
 *   restored.
 * - {@link shiftScenario}: the OTHER way to meet the guard, used by T4 with the
 *   unmodified `SystemPaperClock`: the fixture's instants, its market's open
 *   and its close, moved together relative to the host clock.
 *
 * Nothing here switches the guard off (ADR-031 R7): a run that falls further
 * behind its stream than the configured bound is refused here exactly as in
 * production.
 */

import type { Clock, IngestedEvent } from "@polymarket-bot/trader";
import { vi } from "vitest";

import { SystemPaperClock } from "../../../../apps/trader/src/main.js";

/**
 * The instant of the fixture's FIRST recorded event (`fixture.ts`
 * `recordedEvents`, a reference print two seconds before the open): the
 * anchor for a file that feeds those events. `admission-process-clock.test.ts`
 * holds the two equal.
 */
export const FIXTURE_FIRST_EVENT_AT = "2026-03-04T11:59:58.000Z";

/** The host's reading, through the process's own clock — captured before anything can re-base it. */
const hostNow: (this: SystemPaperClock) => string = SystemPaperClock.prototype.now;

function hostEpochMs(clock: SystemPaperClock): number {
  return Date.parse(hostNow.call(clock));
}

/** The process's own `SystemPaperClock`, read live and re-based so its creation reads as `anchor`. */
export class RebasedSystemPaperClock implements Clock {
  readonly #host = new SystemPaperClock();
  readonly #offsetMs: number;

  constructor(anchor: string) {
    const anchorMs = Date.parse(anchor);
    if (Number.isNaN(anchorMs)) throw new Error(`not an instant: ${anchor}`);
    this.#offsetMs = hostEpochMs(this.#host) - anchorMs;
  }

  now(): string {
    return new Date(hostEpochMs(this.#host) - this.#offsetMs).toISOString();
  }

  monotonicNs(): bigint {
    return this.#host.monotonicNs();
  }
}

/**
 * Re-bases every `SystemPaperClock`'s `now()` — the one `startup()` builds
 * included — so that this call's instant reads as `anchor`, advancing in real
 * time from there. Answers the restore.
 */
export function rebaseSystemPaperClock(anchor: string): { readonly restore: () => void } {
  const anchorMs = Date.parse(anchor);
  if (Number.isNaN(anchorMs)) throw new Error(`not an instant: ${anchor}`);
  const offsetMs = hostEpochMs(new SystemPaperClock()) - anchorMs;
  const spy = vi.spyOn(SystemPaperClock.prototype, "now").mockImplementation(function (this: SystemPaperClock): string {
    return new Date(hostEpochMs(this) - offsetMs).toISOString();
  });
  return {
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** `instant` moved by `deltaMs`, in the strict-UTC millisecond form. */
export function shifted(instant: string, deltaMs: number): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`not an instant: ${instant}`);
  return new Date(ms + deltaMs).toISOString();
}

/**
 * The fixture's events and configuration document, every instant moved by
 * `deltaMs` together: each envelope's and identity's `receivedAt`, a
 * `MarketOpened`'s `openedAt`, and each market's `openTime` and `closeTime`.
 * Nothing else changes, so the scenario is the same one, `deltaMs` later.
 */
export function shiftScenario(
  events: readonly IngestedEvent[],
  document: Record<string, unknown>,
  deltaMs: number,
): { readonly events: readonly IngestedEvent[]; readonly document: Record<string, unknown> } {
  const moved = events.map((event): IngestedEvent => {
    const payload = event.envelope.payload;
    const openedAt =
      event.envelope.eventType === "MarketOpened" && typeof payload === "object" && payload !== null && "openedAt" in payload
        ? { ...payload, openedAt: shifted(String((payload as { readonly openedAt: unknown }).openedAt), deltaMs) }
        : payload;
    return {
      envelope: { ...event.envelope, receivedAt: shifted(event.envelope.receivedAt, deltaMs), payload: openedAt },
      identity: { ...event.identity, receivedAt: shifted(event.identity.receivedAt, deltaMs) },
    };
  });
  const markets = (document["markets"] as readonly Record<string, unknown>[]).map((market) => ({
    ...market,
    openTime: shifted(String(market["openTime"]), deltaMs),
    closeTime: shifted(String(market["closeTime"]), deltaMs),
  }));
  return { events: moved, document: { ...document, markets } };
}
