/**
 * Driving the assembled trader: one function every acceptance test uses, so
 * every test drives the REAL loop the same way the process does.
 */

import type { PaperTrader } from "@polymarket-bot/trader";
import type { IngestedEvent } from "@polymarket-bot/trader";
import { vi } from "vitest";

import { MARKET_ID, YES_TOKEN, assemble, ingested, recordedEvents, type Assembled } from "./fixture.js";

export interface Run {
  readonly parts: Assembled;
  readonly trader: PaperTrader;
}

/** Assembles, or throws with the refusal an operator would see. */
export function assembleOrThrow(
  options: Parameters<typeof assemble>[0] = {},
): Run {
  const { result, parts } = assemble(options);
  if (!result.ok) {
    throw new Error(
      `${result.refusal.code}: ${result.refusal.detail}\n  ${result.refusal.issues.join("\n  ")}`,
    );
  }
  if (parts === undefined) throw new Error("assembled without parts");
  return { parts, trader: result.trader };
}

/** Ingests the recorded events and drains the loop, exactly as `main` does. */
export async function driveRecordedRun(
  options: Parameters<typeof assemble>[0] = {},
): Promise<Run> {
  const run = assembleOrThrow(options);
  for (const event of recordedEvents()) {
    run.trader.loop.ingest(event);
  }
  await run.trader.loop.drain();
  return run;
}

/**
 * `C1-HALTS`: PAUSES the instance for real WITHOUT a halt — the runtime's
 * watchdog. Until `C1-HALTS` the suites reached "paused and not halted" by
 * latching `RUNTIME_PERSISTENCE_FAILED` and RELEASING the halt; no release
 * exists any more (every halt ends the run). Here the trader's monotonic clock
 * jumps 10 s per read while ONE non-crossing YES level change (ingestSeq 7,
 * 12:00:04) is evaluated: the evaluation overruns its budget, the runtime
 * CONTAINS it and pauses the instance — permanently, as the runtime documents.
 * Call it after {@link recordedEvents}; the trade that follows must use a
 * later `ingestSeq` ({@link restingTradeAfterPause}).
 */
export async function pauseInstanceByWatchdog(run: Run): Promise<void> {
  let now = 1_000_000_000_000n;
  const jump = vi.spyOn(run.parts.clock, "monotonicNs").mockImplementation(() => {
    now += 10_000_000_000n;
    return now;
  });
  try {
    run.trader.loop.ingest(
      ingested(
        "BookLevelChanged",
        { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, side: "BID", price: "0.31", size: "310" },
        { receivedAt: "2026-03-04T12:00:04.000Z", ingestSeq: 7 },
      ),
    );
    await run.trader.loop.drain();
  } finally {
    jump.mockRestore();
  }
}

/** The trade that fills the resting entry, after {@link pauseInstanceByWatchdog} (ingestSeq 8). */
export function restingTradeAfterPause(): IngestedEvent {
  return ingested(
    "PublicTradeObserved",
    { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, price: "0.32", size: "20" },
    { receivedAt: "2026-03-04T12:00:05.000Z", ingestSeq: 8 },
  );
}
