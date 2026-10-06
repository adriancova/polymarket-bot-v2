/**
 * `V2-1` (ADR-030 Amendment 2 rule 1; `docs/venue/protocol-v2-migration-plan.md`
 * rows A3 and D3) — the series-window door reads a Gamma market's `version`
 * and `positionIds`, and the CLOB's undocumented `v`, AS STATED, from the
 * public V2 captures of `VENUE-4` (`test/fixtures/venue/protocol-v2/`). No
 * request leaves the process.
 *
 * What is pinned:
 *
 * 1. The documented V2 market (S-D16, `gamma-market-v2-docs-example`): `version`
 *    `"v2"`, `clobTokenIds` null, `positionIds` the two decimal strings, in
 *    order. The documented V2 event (S-D17) keeps its 31-byte condition id as
 *    Gamma serves it.
 * 2. A live V1 window (S-G04, `gamma-market-v1-btc15m`): `version` `"v1"`,
 *    `positionIds` ABSENT, `clobTokenIds` the JSON-encoded string, unchanged.
 * 3. `positionIds` is read as stated: absent, `null`, a JSON-encoded string
 *    (not an array: UNREADABLE), and a non-string element (`null` in place).
 * 4. The CLOB market info (S-L01, S-L10): `t[]` carries the V2 position ids
 *    with "Up"/"Down" (O.3); `v` is read into `undocumentedProtocolVersion`
 *    as stated — `"v2"`, `"v1"`, absent, `null`, another type.
 * 5. The V1 recorded page (`./fixtures/series-window.json`) reads `version`
 *    `"v1"` and no `positionIds` on all twelve events.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readClobMarketInfoBody, readGammaSeriesEventsBody } from "@polymarket-bot/polymarket-public";
import { describe, expect, it } from "vitest";

import { loadLocalFixture } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const protocolV2 = resolve(here, "../../fixtures/venue/protocol-v2");

/** A `protocol-v2/` capture, strict JSON (its README). */
function capture(name: string): string {
  return readFileSync(resolve(protocolV2, `${name}.jsonc`), "utf8");
}

function capturedObject(name: string): Record<string, unknown> {
  return JSON.parse(capture(name)) as Record<string, unknown>;
}

/** One keyset page holding one event with `market` as its only market. */
function pageWith(market: Record<string, unknown>): string {
  return JSON.stringify({ events: [{ id: "1", title: "t", seriesSlug: "s", series: [{ id: "10192" }], markets: [market] }], next_cursor: "" });
}

function marketReadingOf(market: Record<string, unknown>) {
  const verdict = readGammaSeriesEventsBody(pageWith(market));
  if (verdict.status !== "ok") throw new Error(verdict.issues.join("; "));
  const reading = verdict.events[0]?.market;
  if (reading === undefined || reading === null) throw new Error("no market reading");
  return reading;
}

describe("V2-1: the door reads Market.version and Market.positionIds as stated (F-38-F-41)", () => {
  it("the documented V2 market (S-D16): version v2, clobTokenIds null, positionIds the two ids in order", () => {
    const example = capturedObject("gamma-market-v2-docs-example");
    const reading = marketReadingOf(example);
    expect(reading.version).toEqual({ kind: "VALUE", value: "v2" });
    expect(reading.clobTokenIds).toBeNull();
    expect(reading.positionIds).toEqual({
      kind: "VALUE",
      value: [
        "651150819117105875331414918119047680898421632356043490229292782433651916800",
        "651150819117105875331414918119047680898421632356043490229292782433651916801",
      ],
    });
    expect(reading.outcomes).toBe('["Yes", "No"]');
    expect(Object.isFrozen(reading.positionIds)).toBe(true);
  });

  it("the documented V2 event (S-D17): its market's 31-byte condition id is read as Gamma serves it (62 hex digits)", () => {
    const verdict = readGammaSeriesEventsBody(JSON.stringify({ events: [capturedObject("gamma-event-v2-docs-example")], next_cursor: "" }));
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    const market = verdict.events[0]?.market;
    expect(market?.conditionId).toBe("0x017089ce3ba22aaa0a4cba8250b8c8e1eb0000000000000000000000000000");
    expect(market?.conditionId?.length).toBe(64);
    expect(market?.version).toEqual({ kind: "VALUE", value: "v2" });
    expect(market?.positionIds.kind).toBe("VALUE");
  });

  it("a live V1 window (S-G04): version v1, positionIds ABSENT, clobTokenIds the JSON-encoded string", () => {
    const reading = marketReadingOf(capturedObject("gamma-market-v1-btc15m"));
    expect(reading.version).toEqual({ kind: "VALUE", value: "v1" });
    expect(reading.positionIds).toEqual({ kind: "ABSENT" });
    expect(JSON.parse(reading.clobTokenIds ?? "[]")).toEqual([
      "25070934348813416902477876984955073880416401960631253331845590271167412497744",
      "111614563957165270026378011809694313565736745512637881727398424401624030147043",
    ]);
  });

  it("reads positionIds and version as stated — absent, null, a JSON-encoded string, a non-string element — never defaulted", () => {
    const example = capturedObject("gamma-market-v2-docs-example");
    const absent = { ...example };
    delete absent["positionIds"];
    delete absent["version"];
    expect(marketReadingOf(absent).positionIds).toEqual({ kind: "ABSENT" });
    expect(marketReadingOf(absent).version).toEqual({ kind: "ABSENT" });
    expect(marketReadingOf({ ...example, positionIds: null, version: null }).positionIds).toEqual({ kind: "NULL" });
    expect(marketReadingOf({ ...example, version: null }).version).toEqual({ kind: "NULL" });
    const encoded = marketReadingOf({ ...example, positionIds: JSON.stringify(example["positionIds"]) });
    expect(encoded.positionIds).toEqual({ kind: "UNREADABLE", detail: "a string" });
    expect(marketReadingOf({ ...example, positionIds: { 0: "1" } }).positionIds).toEqual({ kind: "UNREADABLE", detail: "an object" });
    expect(marketReadingOf({ ...example, positionIds: [1, "2", null] }).positionIds).toEqual({ kind: "VALUE", value: [null, "2", null] });
    expect(marketReadingOf({ ...example, version: 2 }).version).toEqual({ kind: "UNREADABLE", detail: "a number" });
    expect(marketReadingOf({ ...example, version: "V2" }).version).toEqual({ kind: "VALUE", value: "V2" });
  });

  it("the V1 recorded page (S-G03): every window reads version v1 and no positionIds", () => {
    const fixture = loadLocalFixture("fixtures/series-window.json");
    const verdict = readGammaSeriesEventsBody(JSON.stringify(fixture.examples[0]?.payload));
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    expect(verdict.events.map((event) => event.market?.version)).toEqual(Array.from({ length: 12 }, () => ({ kind: "VALUE", value: "v1" })));
    expect(verdict.events.map((event) => event.market?.positionIds)).toEqual(Array.from({ length: 12 }, () => ({ kind: "ABSENT" })));
  });
});

describe("V2-1: the CLOB market info — t[] carries the V2 position ids (O.3), and v is read as an undocumented cross-check (C-21)", () => {
  it("the V2 canary (S-L01): t[] the position ids, Up then Down; v \"v2\"; the series' parameters", () => {
    const verdict = readClobMarketInfoBody(capture("clob-markets-v2"));
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    expect(verdict.reading.tokens).toEqual([
      { tokenId: "663574927012476832975694178961957910328055987427402067619466963999000625152", outcome: "Up" },
      { tokenId: "663574927012476832975694178961957910328055987427402067619466963999000625153", outcome: "Down" },
    ]);
    expect(verdict.reading.undocumentedProtocolVersion).toEqual({ kind: "VALUE", value: "v2" });
    expect(verdict.reading.minimumTickSize).toEqual({ kind: "VALUE", value: "0.01" });
    expect(verdict.reading.minimumOrderSize).toEqual({ kind: "VALUE", value: "5" });
    expect(verdict.reading.takerOrderDelayEnabled).toBe(true);
  });

  it("the V1 window (S-L10): v \"v1\"", () => {
    const verdict = readClobMarketInfoBody(capture("clob-markets-v1"));
    expect(verdict.status === "ok" && verdict.reading.undocumentedProtocolVersion).toEqual({ kind: "VALUE", value: "v1" });
  });

  it("reads v as stated: absent, null, another type", () => {
    const body = capturedObject("clob-markets-v2");
    const without = { ...body };
    delete without["v"];
    const read = (value: Record<string, unknown>) => {
      const verdict = readClobMarketInfoBody(JSON.stringify(value));
      if (verdict.status !== "ok") throw new Error("unreadable");
      return verdict.reading.undocumentedProtocolVersion;
    };
    expect(read(without)).toEqual({ kind: "ABSENT" });
    expect(read({ ...body, v: null })).toEqual({ kind: "NULL" });
    expect(read({ ...body, v: 2 })).toEqual({ kind: "UNREADABLE", detail: "a number" });
    expect(read({ ...body, v: ["v2"] })).toEqual({ kind: "UNREADABLE", detail: "an array" });
  });

  it("the 31-byte form of the canary's condition id is the 404 S-L02 recorded (F-70): the reason the read is padded", () => {
    const provenance = JSON.parse(capture("clob-markets-v2-62hex-not-found.provenance")) as { url: string; http_status: string };
    const condition = provenance.url.slice(provenance.url.lastIndexOf("/") + 1);
    expect(condition).toMatch(/^0x[0-9a-f]{62}$/u);
    expect(provenance.http_status).toBe("404");
    const answered = JSON.parse(capture("clob-markets-v2.provenance")) as { url: string; http_status: string };
    expect(answered.url.endsWith(`/clob-markets/${condition}00`)).toBe(true);
    expect(answered.http_status).toBe("200");
  });
});
