/**
 * `ROLLOVER-1` — the series-admission reads and their door, driven by the
 * RECORDED bodies in `./fixtures/series-window.json` (VENUE-SETL-1's S-G03,
 * S-K03a, S-K04a) and an offline HTTP double. No request leaves the process.
 *
 * What is pinned:
 *
 * 1. The recorded Gamma keyset page is read whole: twelve events, a next
 *    cursor, and for each event exactly the documented fields the admission
 *    judge reads, numbers as their exact decimal text.
 * 2. The recorded CLOB market-info bodies are read: the explicit token↔outcome
 *    pairing in the venue's order, `itode`, `mts`, `mos`, `mbf`, `tbf`, `fd`.
 * 3. Readings are not verdicts: absent, `null` and wrong-typed fields are
 *    REPORTED, an exponent-form number is UNREADABLE, and a body the door
 *    cannot read whole is `invalid` — never a throw, never a partial page.
 * 4. The fetchers send only documented parameters (`series_id`, `closed`,
 *    `order`, `ascending`, `limit`, `end_date_min`, `after_cursor`; never
 *    `series_slug`, never `offset`), journal-friendly: the raw layer RETURNS a
 *    non-2xx, and only a transport failure throws.
 * 5. **`ROLLOVER-1` r5 (R5-ASTRA-01)** — the door reads each market's OWN
 *    `negRisk` (S-D23 lines 305, 313-315: "a market-level property"), false
 *    on every recorded window, and reports it as stated (true, `null`,
 *    absent, unreadable), never defaulted and never taken from the event.
 */

import {
  clobMarketInfoUrl,
  gammaSeriesEventsUrl,
  PublicMarketConfigurationError,
  readClobMarketInfoBody,
  readGammaSeriesEventsBody,
  requestClobMarketInfo,
  requestGammaSeriesEvents,
  SeriesWindowUnavailableError,
} from "@polymarket-bot/polymarket-public";
import { stubHttpClient } from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

import { loadLocalFixture } from "./fixtures.js";

const fixture = loadLocalFixture("fixtures/series-window.json");
const [keysetExample, clob2215, clob2230] = fixture.examples;
if (keysetExample === undefined || clob2215 === undefined || clob2230 === undefined) {
  throw new Error("the series-window fixture lost an example");
}
const keysetBody = JSON.stringify(keysetExample.payload);

describe("readGammaSeriesEventsBody — the recorded keyset page (S-G03)", () => {
  it("reads the whole page: twelve one-market events of series 10192 and a next cursor", () => {
    const verdict = readGammaSeriesEventsBody(keysetBody);
    expect(verdict.status).toBe("ok");
    if (verdict.status !== "ok") return;
    expect(verdict.events).toHaveLength(12);
    expect(verdict.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    for (const event of verdict.events) {
      expect(event.eventSeriesIds).toEqual(["10192"]);
      expect(event.eventSeriesSlug).toBe("btc-up-or-down-15m");
      expect(event.marketCount).toBe(1);
      expect(event.market?.question).toBe(event.eventTitle);
    }
  });

  it("reads the first window's documented fields exactly, numbers as exact decimals", () => {
    const verdict = readGammaSeriesEventsBody(keysetBody);
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    const [first] = verdict.events;
    expect(first?.eventId).toBe("1127115");
    expect(first?.eventTitle).toBe("Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET");
    expect(first?.eventNegRisk).toBe(false);
    const market = first?.market;
    expect(market?.marketId).toBe("5255913");
    expect(market?.conditionId).toBe("0x5e196ca7c84c54fb1482ca206df477bba1fb3d8c813580c3838186cedde32b29");
    expect(market?.outcomes).toBe('["Up", "Down"]');
    expect(JSON.parse(market?.clobTokenIds ?? "[]")).toEqual([
      "82133233861314798028087473521332912369939570267929634486524845895982963276831",
      "77032538501070316350656311299825606177844598103814694895686056289307323150761",
    ]);
    expect(market?.eventStartTime).toBe("2026-10-04T22:15:00Z");
    expect(market?.endDate).toBe("2026-10-04T22:30:00Z");
    expect(market?.orderPriceMinTickSize).toEqual({ kind: "VALUE", value: "0.001" });
    expect(market?.orderMinSize).toEqual({ kind: "VALUE", value: "5" });
    // F-18: `secondsDelay` is absent on this series — reported as absent, never 0.
    expect(market?.secondsDelay).toEqual({ kind: "ABSENT" });
    expect(market?.feesEnabled).toBe(true);
    expect(market?.feeSchedule).toEqual({
      rate: { kind: "VALUE", value: "0.07" },
      exponent: { kind: "VALUE", value: "1" },
      takerOnly: true,
      rebateRate: { kind: "VALUE", value: "0.2" },
    });
    expect(market?.makerBaseFee).toEqual({ kind: "VALUE", value: "1000" });
    expect(market?.takerBaseFee).toEqual({ kind: "VALUE", value: "1000" });
    expect(market?.resolutionSource).toBe("https://data.chain.link/streams/btc-usd-twap-60s-streams");
  });

  it("emits frozen readings and reads no undocumented key (startDate, feeType, eventMetadata, cryptoMarketConfig)", () => {
    const verdict = readGammaSeriesEventsBody(keysetBody);
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    const first = verdict.events[0];
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.market)).toBe(true);
    const keys = JSON.stringify(first);
    for (const undocumented of ["startDate", "feeType", "eventMetadata", "cryptoMarketConfig", "priceToBeat"]) {
      expect(keys).not.toContain(undocumented);
    }
  });
});

describe("ROLLOVER-1 r5 (R5-ASTRA-01): the door reads the MARKET's own negRisk (S-D23 lines 305, 313-315)", () => {
  it("reads each recorded window's own Market.negRisk (false on all twelve), beside its event's flag", () => {
    const verdict = readGammaSeriesEventsBody(keysetBody);
    if (verdict.status !== "ok") throw new Error("unreadable fixture");
    expect(verdict.events.map((event) => event.market?.negRisk)).toEqual(Array.from({ length: 12 }, () => false));
    expect(verdict.events.map((event) => event.eventNegRisk)).toEqual(Array.from({ length: 12 }, () => false));
  });

  it("reads Market.negRisk as stated — true, null, absent, a string — never defaulted and never taken from the event", () => {
    const first = (keysetExample.payload as { events: Record<string, unknown>[] }).events[0];
    if (first === undefined) throw new Error("the series-window fixture lost its first event");
    const cases: readonly (readonly [string, boolean, (market: Record<string, unknown>) => void, unknown])[] = [
      ["true under an event of false", false, (market) => (market["negRisk"] = true), true],
      ["null", false, (market) => (market["negRisk"] = null), null],
      ["absent under an event of true", true, (market) => delete market["negRisk"], "ABSENT"],
      ["a string", false, (market) => (market["negRisk"] = "false"), "UNREADABLE"],
    ];
    for (const [label, eventFlag, mutate, expected] of cases) {
      const event = structuredClone(first);
      event["negRisk"] = eventFlag;
      mutate((event["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>);
      const verdict = readGammaSeriesEventsBody(JSON.stringify({ events: [event], next_cursor: "" }));
      expect(verdict.status, label).toBe("ok");
      if (verdict.status !== "ok") continue;
      expect(verdict.events[0]?.market?.negRisk, label).toBe(expected);
      expect(verdict.events[0]?.eventNegRisk, label).toBe(eventFlag);
    }
  });
});

describe("readClobMarketInfoBody — the recorded CLOB market info (S-K03a, S-K04a)", () => {
  it("reads the explicit pairing in the venue's order, itode, mts, mos, base fees and fd", () => {
    const verdict = readClobMarketInfoBody(JSON.stringify(clob2215.payload));
    expect(verdict.status).toBe("ok");
    if (verdict.status !== "ok") return;
    expect(verdict.reading.tokens).toEqual([
      { tokenId: "82133233861314798028087473521332912369939570267929634486524845895982963276831", outcome: "Up" },
      { tokenId: "77032538501070316350656311299825606177844598103814694895686056289307323150761", outcome: "Down" },
    ]);
    expect(verdict.reading.takerOrderDelayEnabled).toBe(true);
    expect(verdict.reading.minimumTickSize).toEqual({ kind: "VALUE", value: "0.001" });
    expect(verdict.reading.minimumOrderSize).toEqual({ kind: "VALUE", value: "5" });
    expect(verdict.reading.makerBaseFee).toEqual({ kind: "VALUE", value: "1000" });
    expect(verdict.reading.takerBaseFee).toEqual({ kind: "VALUE", value: "1000" });
    expect(verdict.reading.fees).toEqual({
      rate: { kind: "VALUE", value: "0.07" },
      exponent: { kind: "VALUE", value: "1" },
      takerOnly: true,
    });
    const upcoming = readClobMarketInfoBody(JSON.stringify(clob2230.payload));
    expect(upcoming.status === "ok" && upcoming.reading.minimumTickSize).toEqual({ kind: "VALUE", value: "0.01" });
  });

  it("reports an omitted itode as ABSENT — the venue documents it \"omitted when false\"", () => {
    const body = { ...(clob2215.payload as Record<string, unknown>) };
    delete body["itode"];
    const verdict = readClobMarketInfoBody(JSON.stringify(body));
    expect(verdict.status === "ok" && verdict.reading.takerOrderDelayEnabled).toBe("ABSENT");
  });
});

describe("readings are not verdicts: the door reports, refuses whole, and never throws", () => {
  it("reports absent, null and wrong-typed fields as such, and an exponent-form number as UNREADABLE", () => {
    const page = {
      events: [
        {
          id: "1",
          title: 7,
          seriesSlug: null,
          series: [{ id: "10192" }, "nope"],
          markets: [
            {
              id: "2",
              orderPriceMinTickSize: 1e-7,
              orderMinSize: null,
              secondsDelay: 0,
              feesEnabled: "true",
              feeSchedule: "flat",
              makerBaseFee: [1000],
            },
          ],
        },
      ],
    };
    const verdict = readGammaSeriesEventsBody(JSON.stringify(page));
    expect(verdict.status).toBe("ok");
    if (verdict.status !== "ok") return;
    const event = verdict.events[0];
    expect(event?.eventTitle).toBeNull();
    expect(event?.eventSeriesSlug).toBeNull();
    expect(event?.eventSeriesIds).toEqual(["10192", null]);
    expect(event?.eventNegRisk).toBe("ABSENT");
    expect(event?.market?.orderPriceMinTickSize.kind).toBe("UNREADABLE");
    expect(event?.market?.orderMinSize).toEqual({ kind: "NULL" });
    expect(event?.market?.secondsDelay).toEqual({ kind: "VALUE", value: "0" });
    expect(event?.market?.feesEnabled).toBe("UNREADABLE");
    expect(event?.market?.feeSchedule).toBeNull();
    expect(event?.market?.makerBaseFee.kind).toBe("UNREADABLE");
    expect(event?.market?.conditionId).toBeNull();
    expect(verdict.nextCursor).toBeNull();
  });

  it("refuses a body it cannot read whole: not JSON, not an object, no events array, a non-object event", () => {
    for (const body of ["", "{", "[]", "null", '{"events": {}}', '{"events": [1]}', '{"next_cursor": "x"}']) {
      expect(readGammaSeriesEventsBody(body).status, body).toBe("invalid");
    }
    for (const body of ["", "[1]", '"x"']) {
      expect(readClobMarketInfoBody(body).status, body).toBe("invalid");
    }
  });

  it("reads an empty page as no events and no cursor (the last page)", () => {
    const verdict = readGammaSeriesEventsBody('{"events": [], "next_cursor": ""}');
    expect(verdict).toEqual({ status: "ok", events: [], nextCursor: null });
  });
});

describe("the fetchers send only documented parameters, and journal-friendly", () => {
  it("builds the keyset URL from series_id, closed, order, ascending, limit, end_date_min and after_cursor only", () => {
    const url = new URL(
      gammaSeriesEventsUrl({ gammaSeriesId: "10192", endDateMin: "2026-10-04T22:00:00.000Z", limit: 20, afterCursor: "abc_-" }),
    );
    expect(url.origin).toBe("https://gamma-api.polymarket.com");
    expect(url.pathname).toBe("/events/keyset");
    expect([...url.searchParams.keys()]).toEqual([
      "series_id",
      "closed",
      "order",
      "ascending",
      "limit",
      "end_date_min",
      "after_cursor",
    ]);
    expect(url.searchParams.get("series_id")).toBe("10192");
    expect(url.searchParams.get("closed")).toBe("false");
    expect(url.searchParams.get("end_date_min")).toBe("2026-10-04T22:00:00.000Z");
    expect(url.searchParams.has("series_slug")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("refuses an argument no documented request takes", () => {
    const base = { gammaSeriesId: "10192", endDateMin: "2026-10-04T22:00:00.000Z", limit: 20 };
    for (const bad of [
      { ...base, gammaSeriesId: "btc-up-or-down-15m" },
      { ...base, limit: 0 },
      { ...base, limit: 101 },
      { ...base, endDateMin: "2026-10-04" },
      { ...base, afterCursor: "" },
    ]) {
      expect(() => gammaSeriesEventsUrl(bad), JSON.stringify(bad)).toThrow(PublicMarketConfigurationError);
    }
    expect(() => clobMarketInfoUrl("")).toThrow(PublicMarketConfigurationError);
    expect(clobMarketInfoUrl("0xab", "http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/clob-markets/0xab");
  });

  it("returns a non-2xx as received, and throws only on a transport failure", async () => {
    const { client, exchanges } = stubHttpClient(() => ({ status: 503, body: "busy" }));
    const response = await requestGammaSeriesEvents({
      http: client,
      query: { gammaSeriesId: "10192", endDateMin: "2026-10-04T22:00:00.000Z", limit: 20 },
    });
    expect(response).toEqual({ url: exchanges[0]?.request.url, status: 503, bodyUtf8: "busy" });
    expect(exchanges[0]?.request.method).toBe("GET");
    const failing = stubHttpClient(() => {
      throw new Error("ECONNRESET");
    });
    await expect(requestClobMarketInfo({ http: failing.client, conditionId: "0xab" })).rejects.toBeInstanceOf(
      SeriesWindowUnavailableError,
    );
  });
});
