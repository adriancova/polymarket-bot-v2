/**
 * `THROUGHPUT-1a` — the recorded burst, as the benchmark publishes it.
 *
 * The fixture is H1 run 1's last 100,000 stream envelopes, one JSON object per
 * line in stream order, plus the run's `MarketOpened` envelope, which is
 * PREPENDED: the burst starts mid-stream, and a trader that never saw its
 * market open would leave it `PENDING` and evaluate nothing the H1 trader
 * evaluated.
 *
 * ## The one transformation, and why it is needed
 *
 * The recorded envelopes name the market H1's registration minted
 * (`payload.internalMarketId`). A benchmark registers its OWN market in a fresh
 * database (REGISTER-1's command mints the id), so every envelope that names
 * the H1 market is rewritten to name the minted one. Nothing else changes: the
 * event ids, the gateway epochs, the ingest sequences, the `receivedAt`
 * instants and every other payload field are the recorded ones, and the
 * rewrite is applied identically to the base and the candidate runs that are
 * compared. `remapMarketId` is the whole of it.
 */

import { readFile } from "node:fs/promises";

import type { EventEnvelope } from "@polymarket-bot/domain";

/** The market id H1 run 1's registration minted, as the recorded envelopes name it. */
export const H1_MARKET_ID = "01a0eed4-9faf-7911-bb58-c8e64ab55859";

/** Reads a JSONL fixture: one §7.1 envelope per non-empty line, in stream order. */
export async function readEnvelopes(path: string, limit?: number): Promise<EventEnvelope<unknown>[]> {
  const text = await readFile(path, "utf8");
  const envelopes: EventEnvelope<unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (limit !== undefined && envelopes.length >= limit) break;
    envelopes.push(JSON.parse(line) as EventEnvelope<unknown>);
  }
  return envelopes;
}

/** Reads one envelope from a JSON file (the fixture's `market-opened-h1.json`). */
export async function readEnvelope(path: string): Promise<EventEnvelope<unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as EventEnvelope<unknown>;
}

/**
 * The envelopes with every `payload.internalMarketId` equal to `from` replaced
 * by `to`. Returns NEW envelope objects; the input is not mutated. An envelope
 * whose payload names no market (a reference feed's event) is returned as is.
 */
export function remapMarketId(
  envelopes: readonly EventEnvelope<unknown>[],
  from: string,
  to: string,
): EventEnvelope<unknown>[] {
  return envelopes.map((envelope) => {
    const payload = envelope.payload;
    if (typeof payload !== "object" || payload === null) return envelope;
    if ((payload as Record<string, unknown>)["internalMarketId"] !== from) return envelope;
    return { ...envelope, payload: { ...(payload as Record<string, unknown>), internalMarketId: to } };
  });
}

/**
 * Where the replayable part of a mid-stream burst begins.
 *
 * `packages/order-book` refuses a `BookLevelChanged` for a token whose book has
 * no authoritative baseline yet (`ORDER_BOOK_NO_BASELINE_SNAPSHOT`). Until
 * `C1-HALTS` the trader halted that market (`BOOK_DESYNCHRONIZED`), which
 * stopped the pump; since then the book waits for its first snapshot instead,
 * and the refusal is only counted. A burst cut from the middle of a live
 * stream opens with level changes whose baseline snapshot lies before the cut
 * (H1's burst: 334 of them, before the first `BookSnapshot` at
 * 21:02:07.125Z). The benchmark still replays from the first index at which
 * every change has its baseline, so its measured workload is unchanged.
 *
 * Answers the smallest index `c` such that, in `burst[c..]`, no token has a
 * `BookLevelChanged` before its first `BookSnapshot`. The benchmark replays
 * `burst[c..]`: a CONTIGUOUS SUFFIX of the recorded stream, reordered and
 * filtered in no way (a filtered stream would be one that never existed).
 */
export function firstBaselineIndex(burst: readonly EventEnvelope<unknown>[]): number {
  const firstSnapshot = new Map<string, number>();
  burst.forEach((envelope, index) => {
    const tokenId = tokenOf(envelope);
    if (envelope.eventType === "BookSnapshot" && tokenId !== undefined && !firstSnapshot.has(tokenId)) {
      firstSnapshot.set(tokenId, index);
    }
  });
  let cut = 0;
  burst.forEach((envelope, index) => {
    const tokenId = tokenOf(envelope);
    if (envelope.eventType !== "BookLevelChanged" || tokenId === undefined) return;
    const snapshot = firstSnapshot.get(tokenId);
    if (snapshot === undefined) {
      throw new Error(`token ${tokenId} has level changes and no BookSnapshot anywhere in the burst`);
    }
    if (index < snapshot && index + 1 > cut) cut = index + 1;
  });
  return cut;
}

function tokenOf(envelope: EventEnvelope<unknown>): string | undefined {
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const tokenId = (payload as Record<string, unknown>)["tokenId"];
  return typeof tokenId === "string" ? tokenId : undefined;
}

/** `MarketOpened` first, then the burst, as the benchmark publishes them. */
export function withMarketOpened(
  marketOpened: EventEnvelope<unknown>,
  burst: readonly EventEnvelope<unknown>[],
): EventEnvelope<unknown>[] {
  return [marketOpened, ...burst];
}
