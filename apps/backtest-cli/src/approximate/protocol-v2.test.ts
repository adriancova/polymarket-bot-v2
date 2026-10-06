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
 *   outcome ids are 75-digit V2 ids, under either width of its condition id,
 *   and `approximateMarketsOf` carries them unchanged;
 * - the translation maps samples of a 75-digit id to its configured market,
 *   beside a V1 market of 77- and 78-digit ids, and every envelope passes the
 *   core's own wire door (`readEventEnvelope`);
 * - the V2 and V1 ids never resolve to each other's market;
 * - BLOCKED, and failing closed (V2-2 review finding V2-2-R1-01): the
 *   condition-id width boundary. A V2 condition id is `bytes31`, and `bytes32`
 *   boundaries carry it right-padded with one zero byte (F-43). Gamma documents
 *   the 31-byte form, which plan row A7 keeps as the window's identity; the
 *   market channel, and so the research tier's samples (`interpret.ts` copies
 *   the frame's `market`), carry the 32-byte form (F-62, S-W01). `#marketOf`
 *   compares the two literally, so a configuration in Gamma's form refuses the
 *   samples of its own ids (`APPROX_TRANSLATION_REFUSED`). The comparison lives
 *   in `translate.ts`, outside V2-2's test-only grant for this app; until a
 *   width rule is granted there, the refusal is pinned as the boundary's
 *   behaviour, with the genuine mismatches any such rule must go on refusing.
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

/**
 * The V2 canary's condition id at its two documented widths (F-43): the
 * 32-byte form the CLOB served (S-L01) and the market channel carries (F-62),
 * and the 31-byte form Gamma documents (F-40) and plan row A7 keeps as the
 * window's identity: the same value without its final zero byte.
 */
const V2_C32 = V2.c;
const V2_C31 = V2.c.slice(0, -2);
/** The documented Gamma V2 event's condition id: the width Gamma's example uses (S-D17, F-43). */
const GAMMA_DOCS_CONDITION = (
  JSON.parse(readFileSync(join(PROTOCOL_V2, "gamma-event-v2-docs-example.jsonc"), "utf8")) as {
    markets: { conditionId: string }[];
  }
).markets[0]?.conditionId;

const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);
const V2_MARKET: ApproximateMarket = {
  marketId: "019b1e00-0000-7000-8000-0000000000a2",
  // The samples' own 32-byte form (F-62), so that only the token id (acceptance
  // 5) is under test here. Gamma's 31-byte form, the identity A7 keeps, does not
  // replay today: see "the condition-id width boundary is BLOCKED" below.
  conditionId: V2_C32,
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

  it("the canary's condition id has the two documented widths, and Gamma's example uses the 31-byte one", () => {
    expect(V2_C32).toMatch(/^0x[0-9a-f]{62}00$/u);
    expect(V2_C31).toMatch(/^0x[0-9a-f]{62}$/u);
    expect(`${V2_C31}00`).toBe(V2_C32);
    expect(GAMMA_DOCS_CONDITION).toMatch(/^0x[0-9a-f]{62}$/u);
    // A V1 condition id is 32 bytes and is not a padded V2 one.
    expect(V1.c).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(V1.c.endsWith("00")).toBe(false);
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

  it("accepts the market under Gamma's 31-byte condition id too, and carries it unchanged (the door is not the block)", () => {
    const config = JSON.parse(readFileSync(join(STATIC_BRACKET, "trader-config.json"), "utf8")) as {
      markets: Record<string, unknown>[];
    };
    const [market] = config.markets;
    if (market === undefined) throw new Error("the static-bracket configuration names no market");
    config.markets = [{ ...market, conditionId: V2_C31, yesTokenId: V2_YES, noTokenId: V2_NO }];
    const parsed = parseTraderConfig(config);
    if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
    const marketId = parsed.config.markets[0]?.marketId ?? "";
    const markets = approximateMarketsOf(parsed.config, new Map([[marketId, "9000002"]]));
    expect(markets.ok && markets.markets.map((entry) => entry.conditionId)).toEqual([V2_C31]);
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

describe("the condition-id width boundary is BLOCKED, and fails closed (V2-2-R1-01; F-43, F-62, A7, C-19)", () => {
  const at = T0 + 60_010;

  /** The two markets of the A16 proof, with the V2 one configured under `conditionId`. */
  function configuredUnder(conditionId: string): ResearchSampleTranslator {
    return new ResearchSampleTranslator({ markets: [V1_MARKET, { ...V2_MARKET, conditionId }], digestSha256: sha256Hex });
  }

  /** A V2 book sample and a V2 trade sample, as the research tier records them, under `conditionId`. */
  function v2Samples(conditionId: string): FixtureSample[] {
    return [
      fullBook(r("50", at), { spanStartMs: T0, conditionId, tokenId: V2_YES, bids: [["0.32", "200"]], asks: [["0.34", "30"]] }),
      trade(r("50", at), { conditionId, tokenId: V2_YES, price: "0.33", size: "5", side: "SELL" }),
    ];
  }

  function expectRefused(configured: string, sampled: string, sample: FixtureSample): void {
    const result = configuredUnder(configured).translate(frameOf("50", at, [sample]), "1");
    expect(result.ok, `${sample.table}: configured ${configured}, sampled ${sampled}`).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("APPROX_TRANSLATION_REFUSED");
    expect(result.refusal.detail).toContain("under another condition id than the configuration's");
    expect(result.refusal.details).toEqual({
      releaseIngestSeq: "50",
      tokenId: V2_YES,
      sampleConditionId: sampled,
      configuredConditionId: configured,
    });
  }

  it("BLOCKED: a configuration in Gamma's 31-byte form refuses the 32-byte samples of its own 75-digit ids, and emits nothing", () => {
    // The same condition at its two documented widths (F-43), so a width rule in
    // `translate.ts` would replay these samples. None is granted to V2-2: the
    // translation stops the run rather than guess (`#marketOf`).
    for (const sample of v2Samples(V2_C32)) expectRefused(V2_C31, V2_C32, sample);
  });

  it("the same samples replay once the configuration names their own 32-byte form (identity is the token's)", () => {
    const result = configuredUnder(V2_C32).translate(frameOf("50", at, v2Samples(V2_C32)), "1");
    if (!result.ok) throw new Error(`refused: ${result.refusal.detail}`);
    expect(result.envelopes.map((envelope) => [envelope.eventType, (envelope.payload as { internalMarketId: string }).internalMarketId])).toEqual([
      ["BookSnapshot", V2_MARKET.marketId],
      ["PublicTradeObserved", V2_MARKET.marketId],
    ]);
  });

  it("genuine mismatches are refused under either configured width; a width rule must go on refusing each", () => {
    const cases: readonly (readonly [configured: string, sampled: string, why: string])[] = [
      [V2_C31, `${V2_C31}01`, "a 32-byte id whose final byte is not zero is no padded 31-byte id (F-43, S-D04 line 54)"],
      [V2_C31, `${V2_C31}0`, "63 hex digits is neither documented width"],
      [V2_C31, V2_C31.slice(0, -2), "a 30-byte prefix is another id"],
      [V2_C31, `0x${V2_C32.slice(2).toUpperCase()}`, "another spelling: the comparison is exact, never case-folded"],
      [V2_C31, `0x${"ab".repeat(31)}00`, "another condition's padded form"],
      [V2_C31, V1.c, "the V1 window's condition"],
      [V2_C32, `${V2_C31}01`, "a non-zero final byte, against the 32-byte configuration"],
      [V2_C32, V1.c, "the V1 window's condition, against the 32-byte configuration"],
    ];
    for (const [configured, sampled, why] of cases) {
      expect(sampled, why).not.toBe(configured);
      for (const sample of v2Samples(sampled)) expectRefused(configured, sampled, sample);
    }
  });
});
