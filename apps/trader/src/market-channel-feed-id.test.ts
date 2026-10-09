/**
 * `C1-HALTS` (TAINT, the challenge's fail-safe configuration): the trader's
 * market-channel feed id — the feed whose market-less incidents taint a
 * gateway epoch (ADR-023 rule 4, narrowed 2026-10-08) — must be the data
 * gateway's Polymarket market-channel `feedId`. A mismatch is the UNSAFE
 * direction: the market channel's own WAL refusals and unknown event types
 * would stop tainting, and a book whose frames were lost could read fresh.
 * So the two shipped examples are pinned equal here, through the trader's own
 * door and accessor.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bookFreshnessBasisOf, marketChannelFeedIdOf, parseTraderConfig } from "@polymarket-bot/trading-core";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8")) as unknown;
}

describe("the trader's and the gateway's example configurations agree on the market-channel feed id", () => {
  it("the trader reads, through its own door, the id the gateway publishes the market channel under", () => {
    const trader = parseTraderConfig(readJson("infra/compose/trader/trader.config.example.json"));
    if (!trader.ok) throw new Error(`the example trader configuration was refused: ${trader.refusal.detail}`);
    const gateway = readJson("infra/compose/data-gateway/gateway.config.example.json") as {
      readonly polymarket?: { readonly feedId?: unknown };
    };
    // The example opts in to the basis that reads the taint at all.
    expect(bookFreshnessBasisOf(trader.config)).toBe("CONNECTION_CONFIRMED");
    expect(typeof gateway.polymarket?.feedId).toBe("string");
    expect(marketChannelFeedIdOf(trader.config)).toBe(gateway.polymarket?.feedId);
  });
});
