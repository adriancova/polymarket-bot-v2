/**
 * Polymarket Protocol V2 on the approximate backtest's readers (`V2-2`: plan
 * row A16, acceptance 5).
 *
 * A V2 position id is a 75-digit decimal string (`docs/venue/verified-2026-10-05.md`
 * F-44); the readers here take token ids as opaque strings from the trader
 * configuration and from research-tier samples (`translate.ts`: token to
 * configured market). The ids below are `VENUE-4`'s: the V2 canary's position
 * ids and the V1 window's token ids of the same round, from
 * `test/fixtures/venue/protocol-v2/clob-markets-v2.jsonc` and `clob-markets-v1.jsonc`
 * (S-L01, S-L10).
 *
 * Pinned:
 * - the trader configuration door (`parseTraderConfig`) accepts a market whose
 *   outcome ids are 75-digit V2 ids, and `approximateMarketsOf` carries them;
 * - the translation maps samples of a 75-digit id to its configured market,
 *   beside a V1 market of 77- and 78-digit ids, and every envelope passes the
 *   core's own wire door (`readEventEnvelope`);
 * - the V2 and V1 ids never resolve to each other's market.
 *
 * NO NETWORK. NO DOCKER. The captures are read from the repository.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTraderConfig, readEventEnvelope } from "@polymarket-bot/trading-core";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../archive.js";
import type { ReleaseFrame } from "./research-source.js";
import { ResearchSampleTranslator, approximateMarketsOf, type ApproximateMarket } from "./translate.js";
import { EPOCH, depth, fullBook, trade, type FixtureSample } from "./test-support.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROTOCOL_V2 = join(REPO_ROOT, "test", "fixtures", "venue", "protocol-v2");
const STATIC_BRACKET = join(REPO_ROOT, "test", "replay-golden", "backtest", "static-bracket");

interface ClobMarketRecord {
  readonly c: string;
  readonly t: readonly { readonly t: string; readonly o: string }[];
}

function clobMarket(name: string): ClobMarketRecord {
  return JSON.parse(readFileSync(join(PROTOCOL_V2, name), "utf8")) as ClobMarketRecord;
}

const V2 = clobMarket("clob-markets-v2.jsonc");
const V1 = clobMarket("clob-markets-v1.jsonc");
const V2_YES = V2.t[0]?.t ?? "";
const V2_NO = V2.t[1]?.t ?? "";
const V1_YES = V1.t[0]?.t ?? "";
const V1_NO = V1.t[1]?.t ?? "";

const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);
const V2_MARKET: ApproximateMarket = {
  marketId: "019b1e00-0000-7000-8000-0000000000a2",
  // The 32-byte form the market channel, and so the research tier's samples, carry (F-62).
  conditionId: V2.c,
  yesTokenId: V2_YES,
  noTokenId: V2_NO,
  openTime: new Date(T0).toISOString(),
  closeTime: new Date(T0 + 900_000).toISOString(),
  gammaMarketId: "9000002",
};
const V1_MARKET: ApproximateMarket = {
  marketId: "019b1e00-0000-7000-8000-0000000000a1",
  conditionId: V1.c,
  yesTokenId: V1_YES,
  noTokenId: V1_NO,
  openTime: new Date(T0).toISOString(),
  closeTime: new Date(T0 + 900_000).toISOString(),
  gammaMarketId: "9000001",
};

function frameOf(seq: string, atMs: number, samples: readonly FixtureSample[]): ReleaseFrame {
  return {
    releaseOrdinal: 0,
    gatewayEpoch: EPOCH,
    releaseIngestSeq: seq,
    availableAt: new Date(atMs).toISOString(),
    availableAtEpochMs: atMs,
    releaseSegmentId: `${EPOCH}-000000`,
    samples: samples.map((sample, index) => ({ table: sample.table, row: sample.row, datasetId: "fixture", sampleOrdinal: index })),
  };
}

const r = (seq: string, atMs: number) => ({ ordinal: 0, seq, atMs });

describe("the ids are the ones F-44 reports (non-vacuity)", () => {
  it("V2 position ids are 75 digits; the same round's V1 token ids are 77 and 78", () => {
    expect([V2_YES, V2_NO].map((id) => id.length)).toEqual([75, 75]);
    expect([V1_YES, V1_NO].map((id) => id.length).sort()).toEqual([77, 78]);
    expect(V2.t.map((entry) => entry.o)).toEqual(["Up", "Down"]);
  });
});

describe("the trader configuration door accepts a 75-digit V2 id (A16)", () => {
  it("parses the static-bracket configuration with its market's ids replaced by V2 position ids", () => {
    const config = JSON.parse(readFileSync(join(STATIC_BRACKET, "trader-config.json"), "utf8")) as {
      markets: Record<string, unknown>[];
    };
    const [market] = config.markets;
    if (market === undefined) throw new Error("the static-bracket configuration names no market");
    config.markets = [{ ...market, conditionId: V2.c, yesTokenId: V2_YES, noTokenId: V2_NO }];
    const parsed = parseTraderConfig(config);
    if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
    expect(parsed.config.markets.map((entry) => [entry.yesTokenId, entry.noTokenId])).toEqual([[V2_YES, V2_NO]]);
    const marketId = parsed.config.markets[0]?.marketId ?? "";
    const markets = approximateMarketsOf(parsed.config, new Map([[marketId, "9000002"]]));
    expect(markets.ok).toBe(true);
    if (markets.ok) {
      expect(markets.markets.map((entry) => [entry.yesTokenId, entry.noTokenId, entry.conditionId])).toEqual([
        [V2_YES, V2_NO, V2.c],
      ]);
    }
  });
});

describe("the translation maps a 75-digit id to its configured market (A16)", () => {
  function translator(): ResearchSampleTranslator {
    return new ResearchSampleTranslator({ markets: [V1_MARKET, V2_MARKET], digestSha256: sha256Hex });
  }

  it("books and trades of V2 and V1 ids become envelopes of their own markets, and each passes the core's door", () => {
    const at = T0 + 60_010;
    const samples: FixtureSample[] = [
      fullBook(r("50", at), { spanStartMs: T0, conditionId: V2.c, tokenId: V2_YES, bids: [["0.32", "200"]], asks: [["0.34", "30"]] }),
      depth(r("50", at), { spanStartMs: T0 + 59_000, conditionId: V2.c, tokenId: V2_NO, bids: [["0.65", "10"]], asks: [["0.67", "10"]] }),
      fullBook(r("50", at), { spanStartMs: T0, conditionId: V1.c, tokenId: V1_YES, bids: [["0.5", "1"]], asks: [["0.51", "1"]] }),
      trade(r("50", at), { conditionId: V2.c, tokenId: V2_YES, price: "0.33", size: "5", side: "SELL" }),
      trade(r("50", at), { conditionId: V1.c, tokenId: V1_NO, price: "0.49", size: "2", side: "BUY", entryIndex: 1 }),
    ];
    const t = translator();
    const result = t.translate(frameOf("50", at, samples), "1");
    if (!result.ok) throw new Error(`refused: ${result.refusal.detail}`);
    const seen = result.envelopes.map((envelope) => {
      const payload = envelope.payload as { internalMarketId: string; tokenId: string };
      return [envelope.eventType, payload.tokenId, payload.internalMarketId];
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        ["BookSnapshot", V2_YES, V2_MARKET.marketId],
        ["BookSnapshot", V2_NO, V2_MARKET.marketId],
        ["BookSnapshot", V1_YES, V1_MARKET.marketId],
        ["PublicTradeObserved", V2_YES, V2_MARKET.marketId],
        ["PublicTradeObserved", V1_NO, V1_MARKET.marketId],
      ]),
    );
    expect(seen).toHaveLength(5);
    for (const envelope of result.envelopes) expect(readEventEnvelope(envelope).ok, envelope.eventType).toBe(true);
    expect(t.counts()).toMatchObject({ bookSnapshots: 3, publicTrades: 2, unconfiguredMarketSamples: 0 });
  });

  it("a 75-digit id the configuration does not name is skipped and counted, never matched to a V1 market", () => {
    const at = T0 + 1_000;
    const t = new ResearchSampleTranslator({ markets: [V1_MARKET], digestSha256: sha256Hex });
    const result = t.translate(
      frameOf("5", at, [trade(r("5", at), { conditionId: V2.c, tokenId: V2_YES, price: "0.5", size: "1" })]),
      "1",
    );
    expect(result.ok && result.envelopes).toEqual([]);
    expect(t.counts().unconfiguredMarketSamples).toBe(1);
  });
});
