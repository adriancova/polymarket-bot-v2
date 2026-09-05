/**
 * Driving the assembled trader: one function every acceptance test uses, so
 * every test drives the REAL loop the same way the process does.
 */

import type { PaperTrader } from "@polymarket-bot/trader";

import { assemble, recordedEvents, type Assembled } from "./fixture.js";

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
