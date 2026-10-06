/**
 * `ROLLOVER-1` — series auto-admission in the gateway (ADR-030; the user's
 * ruling A5 and Q1-Q4), end to end through the real `DataGateway` on the
 * repository's doubles: the recorded Gamma keyset page and CLOB market-info
 * bodies of VENUE-SETL-1 (`test/contract/polymarket-public/fixtures/series-window.json`)
 * on the injected HTTP port, a scripted market socket, an in-memory WAL and
 * transport. No socket, no network.
 *
 * What is proven:
 *
 * 1. **A matching window is admitted** — `MarketDiscovered@1`,
 *    `TradingParametersChanged@1` and `SeriesWindowAdmitted@1`, in that order,
 *    as one frame citing the JOURNALED CLOB response, whose raw frames were in
 *    the WAL first (acceptance 1's "journaled before derived"); the ledger
 *    records the admission CONFIRMED; only THEN are the window's tokens
 *    subscribed (the documented dynamic `subscribe`) and its market polled by
 *    the lifecycle feed. A window beyond the admission lead is not yet judged.
 * 2. **Any mismatch is refused, with an incident, once** — a changed fee rate,
 *    swapped outcomes, a DST-ambiguous title (U-34): no admission event, a
 *    REFUSED ledger record, `GATEWAY_SERIES_WINDOW_REFUSED`, never re-judged.
 * 3. **The cap** — a third due window is held while two are live
 *    (`GATEWAY_SERIES_CAP_REACHED`), and admitted after a live window's
 *    `market_resolved` tears it down (unsubscribed, no longer polled).
 * 4. **The mode** — the gateway refuses to start with admission configured in
 *    any run mode but PAPER and BACKTEST (acceptance 2).
 * 5. **A restart during admission** — an admission whose publication was
 *    halted stays an unconfirmed intent, attaches nothing, and is re-emitted
 *    UNCHANGED by the next epoch before the window is attached.
 * 6. **`ROLLOVER-1` r2 (R2-ASTRA-01, R2-ASTRA-02)** — a window unresolved past
 *    its bound is retired ONLY by its resolution: it stays ADMITTED,
 *    subscribed and in the directory however long it waits, it keeps its cap
 *    slot (the next window is deferred), and a `market_resolved` delivered
 *    late — even 80 minutes past its bound — is still published and retires
 *    it. r1 excluded such a window from the cap and abandoned the oldest one
 *    past the cap, after which its resolution could no longer be delivered.
 * 7. **`ROLLOVER-1` r2 (R2-FABLE-02)** — two r1 behaviours that no test held:
 *    a window's CLOB-failure incident is closed by its next successful read,
 *    and the replay re-emits an unconfirmed intent even past its bound.
 * 8. **`ROLLOVER-1` r3 (R3-ASTRA-01)** — a window is retired only once its
 *    resolution is PUBLISHED: a resolution a publication halt swallowed keeps
 *    the window ADMITTED, subscribed, registered and in its cap slot, with the
 *    resolution kept in the ledger; the next epoch re-publishes it unchanged
 *    (again and again while publication halts), and only then is the window
 *    retired `RESOLVED`, carrying the published resolution.
 * 9. **`ROLLOVER-1` r3 (R3-FABLE-01)** — the operator's named retirement: after
 *    a stop spanning both live windows' resolutions, `operatorRetirements`
 *    entries retire each window once it is past its bound (`OPERATOR`, with
 *    the reason, announced by an incident naming it), and the series resumes;
 *    an entry never overrides an owed resolution, and one naming no window is
 *    reported.
 * 10. **`ROLLOVER-1` r3 (R3-FABLE-02)** — the cap counts unconfirmed intents:
 *    with publication halted, a later due window is held, and gets no intent.
 * 11. **`ROLLOVER-1` r4 (R4-FABLE-01)** — a resolution whose ledger write AND
 *    publication both fail is not lost: it is held in memory, owed (its
 *    window keeps its slot, is not "unresolved", and no operator retirement
 *    applies), its PAGE says it is NOT in the ledger, and every cycle writes
 *    it again; once written, the next epoch re-publishes it and the window is
 *    retired `RESOLVED`. r3 wrote it once and kept it nowhere, while the PAGE
 *    said it was in the ledger.
 * 12. **`ROLLOVER-1` r5 (R5-ASTRA-01)** — negative-risk membership is judged
 *    on the MARKET (S-D23 lines 305, 313-315): a window whose own
 *    `markets[0].negRisk` is true under an event flag of false, `null`,
 *    absent or not a boolean, or whose event's flag contradicts it, is
 *    REFUSED with an incident naming the flag; its tokens are never
 *    subscribed, and the next window is admitted. r4 judged only the event's
 *    flag, and admitted each of the market cases.
 * 13. **`V2-1` (ADR-030 Amendment 2 rules 1-3)** — a Protocol V2 window, built
 *    from the documented example (S-D16) with the canary's observed ids, is
 *    admitted with the ids its `version` selects (`positionIds`, even beside
 *    a populated `clobTokenIds`); the CLOB read sends its condition id
 *    right-padded to 32 bytes, and `t[]` pairs on `clob-markets-v2.jsonc`;
 *    Gamma's 31-byte id stays the identity. Every unclear window is REFUSED by
 *    name with the existing incident: a missing or unknown version, ids not
 *    yet available, a version the review does not accept, a condition id of
 *    another width (no read is made), and a CLOB `v` that disagrees. The
 *    collision check reads the selected ids. The V1 admission output on
 *    `series-window.json` is byte-identical to `af3a1c9`'s.
 * 14. **`V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06)** — a
 *    V2 window whose accepted version selects ids not yet available is NOT
 *    YET ADMISSIBLE: no record, no incident, judged again at each poll; ids
 *    filled before its open admit it, exactly as at first sight; still absent
 *    or null when judged at or after its open (the read's receipt), it is
 *    REFUSED finally; every other refusal stays final, at once. And two
 *    `V2-1` pins (V21-FABLE-01, V21-FABLE-02): a condition id of another
 *    width spends no CLOB read budget, and when the selection fails the
 *    collision check reads the condition id only.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { ADMISSION_LEDGER_FILE_NAME, GatewayConfigurationError, incidentReferenceId } from "@polymarket-bot/data-gateway";
import {
  readClobMarketInfoBody,
  readGammaSeriesEventsBody,
  type PublicHttpRequest,
  type PublicHttpResponse,
} from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem, type MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { PROTOCOL_V2_SAMPLES, reviewedBtc15mSeriesDocument, RECORDED_WINDOW } from "@polymarket-bot/universe/testing";
import { judgeSeriesWindow, parseReviewedSeries, windowInternalMarketId } from "@polymarket-bot/universe";
import { describe, expect, it } from "vitest";

import { buildHarness, MARKET, polymarketRestBook, type Harness } from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../contract/polymarket-public/fixtures/series-window.json"), "utf8"),
) as { readonly examples: readonly { readonly payload: unknown }[] };
const [KEYSET_PAGE, CLOB_2215, CLOB_2230] = fixture.examples.map((example) => example.payload) as [
  { events: Record<string, unknown>[]; next_cursor: string },
  Record<string, unknown>,
  Record<string, unknown>,
];

/**
 * `V2-1` (plan row D5): a fixture market's trading ids, selected by its
 * `version` as the judge selects them (ADR-030 Amendment 2 rule 1; F-38):
 * `positionIds` for `"v2"`, the decoded `clobTokenIds` for `"v1"`, none else.
 */
function tradingIdsOf(market: Record<string, unknown>): readonly string[] {
  if (market["version"] === "v2") return market["positionIds"] as string[];
  if (market["version"] === "v1") return JSON.parse(String(market["clobTokenIds"])) as string[];
  return [];
}

/** `V2-1`: the public V2 captures of `VENUE-4` (`test/fixtures/venue/protocol-v2/`, strict JSON). */
function protocolV2Capture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(here, "../../fixtures/venue/protocol-v2", `${name}.jsonc`), "utf8")) as Record<string, unknown>;
}
/** S-L01: `GET /clob-markets/{64-hex}` for the V2 canary — `t[].t` its position ids, `"v":"v2"`. */
const CLOB_V2 = protocolV2Capture("clob-markets-v2");
/** S-D16: the documented V2 Gamma market — `version` "v2", `clobTokenIds` null, `positionIds` an array. */
const GAMMA_V2_EXAMPLE = protocolV2Capture("gamma-market-v2-docs-example");

/** Every recorded window's token → its condition id, for the CLOB book stub (the V2 canary's ids → its 32-byte `c`, as O.2 observed). */
const CONDITION_OF_TOKEN = new Map<string, string>([
  ...KEYSET_PAGE.events.flatMap((event) => {
    const market = (event["markets"] as Record<string, unknown>[])[0] ?? {};
    return tradingIdsOf(market).map((token): [string, string] => [token, String(market["conditionId"])]);
  }),
  ...(CLOB_V2["t"] as { t: string }[]).map((token): [string, string] => [token.t, String(CLOB_V2["c"])]),
]);

const GAMMA_BASE = "http://gamma.stub";
const CLOB_BASE = "http://clob.stub";
/** 2026-10-04T22:20:00Z: inside the recorded 22:15 window; the 22:30 window is 10 minutes ahead. */
const NOW_MS = Date.UTC(2026, 9, 4, 22, 20, 0);
const LEDGER_PATH = `/wal/${ADMISSION_LEDGER_FILE_NAME}`;

const WINDOW_2215 = {
  conditionId: RECORDED_WINDOW.conditionId,
  yes: RECORDED_WINDOW.yesTokenId,
  no: RECORDED_WINDOW.noTokenId,
  id: windowInternalMarketId(RECORDED_WINDOW.conditionId, Date.UTC(2026, 9, 4, 22, 15)),
};
const WINDOW_2230 = {
  conditionId: "0xf59bf1fe624a6f54cc4c8bcb08d077558a241a6a8050e2b729cfaa350a7c7bdc",
  yes: "28102873104420659727719004083961103866333312520675837829099603614881599190203",
  no: "12231147712917489193781763889175813105415311804974034851807200316222295637108",
  id: windowInternalMarketId("0xf59bf1fe624a6f54cc4c8bcb08d077558a241a6a8050e2b729cfaa350a7c7bdc", Date.UTC(2026, 9, 4, 22, 30)),
};

interface StubOptions {
  /** The keyset page served (the recorded one by default). */
  readonly page?: () => unknown;
  /** CLOB bodies by condition id (the recorded two by default). */
  readonly clob?: Readonly<Record<string, unknown>>;
}

/** The stub venue: the recorded reads, a ready Gamma market, CLOB books for any token. */
function venueStub(options: StubOptions = {}) {
  const requests: string[] = [];
  const clob = options.clob ?? { [WINDOW_2215.conditionId]: CLOB_2215, [WINDOW_2230.conditionId]: CLOB_2230 };
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    requests.push(request.url);
    if (request.url.startsWith(`${GAMMA_BASE}/events/keyset`)) {
      return { status: 200, body: JSON.stringify(options.page?.() ?? KEYSET_PAGE) };
    }
    if (request.url.startsWith(`${CLOB_BASE}/clob-markets/`)) {
      const condition = decodeURIComponent(request.url.slice(`${CLOB_BASE}/clob-markets/`.length));
      const body = clob[condition];
      return body === undefined ? { status: 404, body: '{"error":"not found"}' } : { status: 200, body: JSON.stringify(body) };
    }
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify({ active: true, closed: false, archived: false, acceptingOrders: true }) };
    }
    if (request.url.includes("/books")) {
      const tokens = (request.jsonBody as readonly { token_id: string }[] | undefined) ?? [];
      return { status: 200, body: JSON.stringify(tokens.map((entry) => polymarketRestBook(entry.token_id, CONDITION_OF_TOKEN.get(entry.token_id) ?? "0xunknown"))) };
    }
    return { status: 404, body: "{}" };
  };
  return { route, requests };
}

function admissionConfig(overrides: Record<string, unknown> = {}, series: unknown = reviewedBtc15mSeriesDocument()): Record<string, unknown> {
  return {
    markets: [],
    polymarket: { feedId: "polymarket-market", customFeatureEnabled: true, snapshotBaseUrl: CLOB_BASE },
    lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    seriesAdmission: {
      gammaBaseUrl: GAMMA_BASE,
      clobBaseUrl: CLOB_BASE,
      pollIntervalMs: 30_000,
      maximumPages: 1,
      admissionLeadSeconds: 900,
      series: [series],
    },
    ...overrides,
  };
}

async function started(stub = venueStub(), extra: Parameters<typeof buildHarness>[0] = {}): Promise<Harness> {
  const harness = await buildHarness({
    config: admissionConfig(),
    http: stub.route,
    clockStartMs: NOW_MS,
    ...extra,
  });
  harness.gateway.start();
  harness.polymarketSockets.current.open();
  await harness.settle();
  return harness;
}

function admissionTypes(harness: Harness): readonly string[] {
  return harness
    .published()
    .filter((envelope) => ["MarketDiscovered", "TradingParametersChanged", "SeriesWindowAdmitted"].includes(envelope.eventType))
    .map((envelope) => `${envelope.eventType}:${String((envelope.payload as Record<string, unknown>)["internalMarketId"])}`);
}

function ledger(fileSystem: MemoryFileSystem): Record<string, Record<string, unknown>> {
  const text = fileSystem.snapshot()[LEDGER_PATH];
  if (text === undefined) return {};
  return (JSON.parse(text) as { windows: Record<string, Record<string, unknown>> }).windows;
}

/** The JSON frames sent on the market sockets (the heartbeat's `PING` text is not one). */
function sentFrames(harness: Harness): readonly { assets_ids?: string[]; operation?: string }[] {
  return harness.polymarketSockets.sockets.flatMap((socket) =>
    socket.sent.filter((frame) => frame !== "PING").map((frame) => JSON.parse(frame) as { assets_ids?: string[]; operation?: string }),
  );
}

function subscribedTokens(harness: Harness): readonly string[] {
  return sentFrames(harness).flatMap((parsed) => (parsed.operation === "unsubscribe" ? [] : (parsed.assets_ids ?? [])));
}

function payloadOf(envelope: EventEnvelope<unknown> | undefined): Record<string, unknown> {
  return (envelope?.payload ?? {}) as Record<string, unknown>;
}

describe("ROLLOVER-1: a matching window is admitted, journaled first, then attached", () => {
  it("admits the two due recorded windows with the three contracts, as one frame citing the journaled CLOB read", async () => {
    const stub = venueStub();
    const harness = await started(stub);

    expect(admissionTypes(harness)).toEqual([
      `MarketDiscovered:${String(WINDOW_2215.id)}`,
      `TradingParametersChanged:${String(WINDOW_2215.id)}`,
      `SeriesWindowAdmitted:${String(WINDOW_2215.id)}`,
      `MarketDiscovered:${String(WINDOW_2230.id)}`,
      `TradingParametersChanged:${String(WINDOW_2230.id)}`,
      `SeriesWindowAdmitted:${String(WINDOW_2230.id)}`,
    ]);
    // The 22:45 window is 25 minutes ahead, beyond the 900 s lead: not judged.
    expect(stub.requests.filter((url) => url.includes("/clob-markets/"))).toHaveLength(2);

    const admitted = harness.publishedOfType("SeriesWindowAdmitted");
    const first = payloadOf(admitted[0]);
    expect(first).toEqual({
      internalMarketId: WINDOW_2215.id,
      conditionId: WINDOW_2215.conditionId,
      seriesId: "btc-15m-updown",
      seriesConfigHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
      yesTokenId: WINDOW_2215.yes,
      noTokenId: WINDOW_2215.no,
      scheduledOpenAt: "2026-10-04T22:15:00.000Z",
      scheduledCloseAt: "2026-10-04T22:30:00.000Z",
      tickSize: "0.001",
      windowTitle: "Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET",
    });
    expect(payloadOf(admitted[1])["tickSize"]).toBe("0.01");
    const parameters = payloadOf(harness.publishedOfType("TradingParametersChanged")[0]);
    expect(parameters["parametersVersion"]).toBe(1);
    expect(parameters["minimumOrderSize"]).toBe("5");

    // Journaled BEFORE derived: the cited raw frame is in the WAL, its
    // ingestSeq below the events', and it is the CLOB read of the window.
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    for (const envelope of harness.published().filter((entry) => entry.eventType === "SeriesWindowAdmitted" || entry.eventType === "MarketDiscovered")) {
      const causation = envelope.causationId;
      expect(causation).toMatch(/^raw:/u);
      const rawSeq = causation?.split(":").at(-1) ?? "";
      const raw = frames.find((frame) => frame.ingestSeq === rawSeq);
      expect(raw?.endpoint).toContain("/clob-markets/");
      expect(BigInt(rawSeq)).toBeLessThan(BigInt(envelope.ingestSeq));
    }
    expect(frames.some((frame) => frame.endpoint.startsWith(`${GAMMA_BASE}/events/keyset?series_id=10192&closed=false&order=endDate&ascending=true&limit=20&end_date_min=`))).toBe(true);

    // Attached only after publication: subscribed, and polled by the lifecycle feed.
    expect(subscribedTokens(harness)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no, WINDOW_2230.yes, WINDOW_2230.no]));
    // The dynamic subscribe opened a gap whose authoritative snapshot followed:
    // every BookSnapshot of a window is published AFTER its admission.
    const books = harness.publishedOfType("BookSnapshot").filter((envelope) => payloadOf(envelope)["internalMarketId"] === WINDOW_2215.id);
    expect(books.length).toBeGreaterThanOrEqual(1);
    const admissionSeq = BigInt(admitted[0]?.ingestSeq ?? "0");
    for (const book of books) expect(BigInt(book.ingestSeq)).toBeGreaterThan(admissionSeq);
    harness.timers.advance(10_000);
    await harness.settle();
    expect(stub.requests).toContain(`${GAMMA_BASE}/markets/5255913`);
    expect(harness.publishedOfType("MarketOpened").map((envelope) => payloadOf(envelope)["internalMarketId"])).toContain(WINDOW_2215.id);

    const records = ledger(harness.walFileSystem);
    expect(records[WINDOW_2215.conditionId]?.["status"]).toBe("ADMITTED");
    expect(records[WINDOW_2215.conditionId]?.["admissionConfirmedAt"]).toBeDefined();
    expect(harness.gateway.metrics().seriesAdmission?.windowsAdmitted).toBe(2);
    await harness.gateway.stop();
  });

  it("never judges a window twice: the next cycle admits nothing more for the same windows", async () => {
    const stub = venueStub();
    const harness = await started(stub);
    const before = admissionTypes(harness).length;
    harness.timers.advance(30_000);
    await harness.settle();
    expect(admissionTypes(harness)).toHaveLength(before);
    expect(stub.requests.filter((url) => url.includes("/clob-markets/"))).toHaveLength(2);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1: any mismatch is refused, with an incident, and waits for review", () => {
  function pageWith(mutate: (event: Record<string, unknown>, market: Record<string, unknown>) => void): () => unknown {
    return () => {
      const page = structuredClone(KEYSET_PAGE);
      const event = page.events[0] as Record<string, unknown>;
      const market = (event["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
      mutate(event, market);
      return page;
    };
  }

  for (const [name, mutate, mismatch] of [
    ["a fee rate the review did not accept", (_e: Record<string, unknown>, m: Record<string, unknown>) => {
      m["feeSchedule"] = { exponent: 1, rate: 0.0625, takerOnly: true, rebateRate: 0.2 };
    }, /feeSchedule\.rate/u],
    ["outcomes in the other order", (_e: Record<string, unknown>, m: Record<string, unknown>) => {
      m["outcomes"] = '["Down", "Up"]';
    }, /Market\.outcomes/u],
    ["another series", (e: Record<string, unknown>) => {
      e["seriesSlug"] = "eth-up-or-down-15m";
    }, /seriesSlug/u],
  ] as const) {
    it(`refuses ${name}: no admission event, a REFUSED record, an incident, never re-judged`, async () => {
      const stub = venueStub({ page: pageWith(mutate) });
      const harness = await started(stub);
      expect(admissionTypes(harness).filter((entry) => entry.endsWith(String(WINDOW_2215.id)))).toEqual([]);
      const record = ledger(harness.walFileSystem)[WINDOW_2215.conditionId];
      expect(record?.["status"]).toBe("REFUSED");
      expect(JSON.stringify(record?.["mismatches"])).toMatch(mismatch);
      const refused = harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.detail).toMatch(mismatch);
      // The incident envelope names the window by its derived id (no epoch taint).
      const opened = harness.publishedOfType("DataQualityIncidentOpened").find((envelope) => payloadOf(envelope)["reasonCode"] === "GATEWAY_SERIES_WINDOW_REFUSED");
      expect(payloadOf(opened)["affectedMarketIds"]).toEqual([WINDOW_2215.id]);
      // Never re-judged: the next cycle reads the page and asks the CLOB nothing new for it.
      const clobBefore = stub.requests.filter((url) => url.includes(WINDOW_2215.conditionId) && url.includes("/clob-markets/")).length;
      harness.timers.advance(30_000);
      await harness.settle();
      expect(stub.requests.filter((url) => url.includes(WINDOW_2215.conditionId) && url.includes("/clob-markets/")).length).toBe(clobBefore);
      expect(harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED")).toHaveLength(1);
      await harness.gateway.stop();
    });
  }

  it("refuses a window whose title repeats when daylight saving time ends (U-34)", async () => {
    const title = "Bitcoin Up or Down - November 1, 1:00AM-1:15AM ET";
    const page = pageWith((event, market) => {
      event["title"] = title;
      market["question"] = title;
      market["eventStartTime"] = "2026-11-01T05:00:00Z";
      market["endDate"] = "2026-11-01T05:15:00Z";
    });
    const harness = await started(venueStub({ page }), { clockStartMs: Date.UTC(2026, 10, 1, 4, 55) });
    expect(admissionTypes(harness)).toEqual([]);
    const record = ledger(harness.walFileSystem)[WINDOW_2215.conditionId];
    expect(record?.["status"]).toBe("REFUSED");
    expect(JSON.stringify(record?.["mismatches"])).toMatch(/2 UTC intervals/u);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1: the concurrent-window cap, and teardown", () => {
  it("holds a third due window while two are live, and admits it once a resolved window is torn down", async () => {
    const third = KEYSET_PAGE.events[2] as Record<string, unknown>;
    const thirdMarket = (third["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const thirdCondition = String(thirdMarket["conditionId"]);
    const thirdTokens = tradingIdsOf(thirdMarket) as [string, string];
    const clob = {
      [WINDOW_2215.conditionId]: CLOB_2215,
      [WINDOW_2230.conditionId]: CLOB_2230,
      [thirdCondition]: { ...CLOB_2230, t: [{ t: thirdTokens[0], o: "Up" }, { t: thirdTokens[1], o: "Down" }] },
    };
    const stub = venueStub({ clob });
    const harness = await started(stub);
    expect(harness.publishedOfType("SeriesWindowAdmitted")).toHaveLength(2);

    // 22:31: the 22:45 window is due (14 minutes ahead) — but two are live.
    harness.clock.advance(11 * 60_000);
    harness.timers.advance(30_000);
    await harness.settle();
    expect(harness.publishedOfType("SeriesWindowAdmitted")).toHaveLength(2);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toContain("GATEWAY_SERIES_CAP_REACHED");
    expect(stub.requests.some((url) => url.includes(thirdCondition))).toBe(false);
    // The cap is reached in the ordinary course of a run, so its incident
    // names the HELD window (a market no consumer runs) — never no market,
    // which would taint every book of the epoch (ADR-023 D2 rule 4).
    const cap = harness.publishedOfType("DataQualityIncidentOpened").find((envelope) => payloadOf(envelope)["reasonCode"] === "GATEWAY_SERIES_CAP_REACHED");
    expect(payloadOf(cap)["affectedMarketIds"]).toEqual([windowInternalMarketId(thirdCondition, Date.UTC(2026, 9, 4, 22, 45))]);

    // The 22:15 window resolves on the market channel: it is torn down on the
    // next cycle — unsubscribed, no longer polled — and the third is admitted.
    harness.polymarketSockets.current.message(
      JSON.stringify([
        {
          event_type: "market_resolved",
          id: "5255913",
          market: WINDOW_2215.conditionId,
          assets_ids: [WINDOW_2215.yes, WINDOW_2215.no],
          winning_asset_id: WINDOW_2215.yes,
          winning_outcome: "Up",
          timestamp: String(NOW_MS + 11 * 60_000),
        },
      ]),
    );
    await harness.settle();
    expect(harness.publishedOfType("MarketResolved")).toHaveLength(1);
    harness.timers.advance(30_000);
    await harness.settle();
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]?.["status"]).toBe("RETIRED");
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]?.["retiredReason"]).toBe("RESOLVED");
    const unsubscribed = harness.polymarketSockets.current.sent
      .map((frame) => JSON.parse(frame) as { operation?: string; assets_ids?: string[] })
      .filter((frame) => frame.operation === "unsubscribe")
      .flatMap((frame) => frame.assets_ids ?? []);
    expect(unsubscribed).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    expect(harness.publishedOfType("SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["conditionId"])).toContain(thirdCondition);
    expect(harness.gateway.metrics().seriesAdmission?.windowsRetiredResolved).toBe(1);
    expect(harness.gateway.metrics().directory?.admittedWindowsReleased).toBe(1);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1: admission refuses to start outside PAPER and BACKTEST (acceptance 2)", () => {
  for (const mode of ["LIVE", "LIVE_MICRO", "EXECUTION_PROBE", "SHADOW", "paper", null] as const) {
    it(`refuses run mode ${String(mode)}`, async () => {
      await expect(
        buildHarness({ config: admissionConfig(), http: venueStub().route, clockStartMs: NOW_MS, runMode: mode }),
      ).rejects.toBeInstanceOf(GatewayConfigurationError);
    });
  }

  it("starts in BACKTEST, and a gateway with no admission block starts in any mode", async () => {
    const backtest = await buildHarness({ config: admissionConfig(), http: venueStub().route, clockStartMs: NOW_MS, runMode: "BACKTEST" });
    await backtest.gateway.stop();
    const plain = await buildHarness({ config: { coinbase: { productIds: ["BTC-USD"] } }, runMode: "LIVE" });
    await plain.gateway.stop();
  });
});

describe("ROLLOVER-1: a restart during admission (ADR-030 Decision 5.2)", () => {
  it("keeps a halted admission as an unconfirmed intent, attaches nothing, and re-emits it unchanged next epoch", async () => {
    const walFileSystem = createMemoryFileSystem();
    const halted = await started(venueStub(), { walFileSystem, startupTransportFailure: "redis down" });
    expect(halted.published()).toEqual([]);
    const intent = ledger(walFileSystem)[WINDOW_2215.conditionId];
    expect(intent?.["status"]).toBe("ADMITTED");
    expect(intent?.["admissionConfirmedAt"]).toBeUndefined();
    expect(halted.incidents.map((incident) => incident.reasonCode)).toContain("GATEWAY_SERIES_ADMISSION_UNPUBLISHED");
    expect(subscribedTokens(halted)).toEqual([]);
    await halted.gateway.stop();

    const stub = venueStub();
    const restarted = await started(stub, { walFileSystem, idSeed: 1 });
    const admitted = restarted.publishedOfType("SeriesWindowAdmitted");
    expect(admitted.map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([WINDOW_2215.id, WINDOW_2230.id]);
    expect(payloadOf(admitted[0])["windowTitle"]).toBe(intent?.["window"] === undefined ? undefined : (intent["window"] as Record<string, unknown>)["windowTitle"]);
    // Re-emitted, not re-judged: no CLOB read in the new epoch for them.
    expect(stub.requests.filter((url) => url.includes("/clob-markets/"))).toEqual([]);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]?.["admissionConfirmedAt"]).toBeDefined();
    expect(subscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    expect(restarted.gateway.metrics().seriesAdmission?.admissionsReplayed).toBe(2);
    await restarted.gateway.stop();
  });

  it("re-attaches a confirmed live window at the next start without re-emitting it", async () => {
    const walFileSystem = createMemoryFileSystem();
    const first = await started(venueStub(), { walFileSystem });
    await first.gateway.stop();
    const restarted = await started(venueStub(), { walFileSystem, idSeed: 2 });
    expect(restarted.publishedOfType("SeriesWindowAdmitted")).toEqual([]);
    expect(subscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no, WINDOW_2230.yes, WINDOW_2230.no]));
    await restarted.gateway.stop();
  });
});

describe("ROLLOVER-1: an admission incident never names no market (ADR-023 D2 rule 4)", () => {
  it("a failed keyset read is counted, not published; only the STALL is market-less, as the lifecycle feed's is", async () => {
    let failing = true;
    const healthy = venueStub();
    const route = (request: PublicHttpRequest): PublicHttpResponse =>
      failing && request.url.startsWith(`${GAMMA_BASE}/events/keyset`) ? { status: 503, body: "{}" } : healthy.route(request);
    const harness = await started({ route, requests: healthy.requests });
    const admissionIncidents = () =>
      harness
        .publishedOfType("DataQualityIncidentOpened")
        .filter((envelope) => String(payloadOf(envelope)["feedId"]) === "polymarket-series-admission");
    expect(admissionIncidents()).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission?.requestFailures).toBe(1);
    expect(harness.gateway.metrics().seriesAdmission?.lastRequestFailure).toMatch(/^GATEWAY_SERIES_DISCOVERY_FAILED: .*HTTP 503/u);
    harness.timers.advance(30_000);
    await harness.settle();
    expect(admissionIncidents()).toEqual([]);
    // The third failure in a row is the stall: FeedStale and GATEWAY_FEED_STALL.
    harness.timers.advance(30_000);
    await harness.settle();
    expect(admissionIncidents().map((envelope) => payloadOf(envelope)["reasonCode"])).toEqual(["GATEWAY_FEED_STALL"]);
    expect(harness.publishedOfType("FeedStale").filter((envelope) => envelope.sourceChannel === "polymarket:series-admission-rest")).toHaveLength(1);
    // Recovery admits as usual.
    failing = false;
    harness.timers.advance(30_000);
    await harness.settle();
    expect(harness.publishedOfType("SeriesWindowAdmitted")).toHaveLength(2);
    await harness.gateway.stop();
  });

  it("a failed CLOB read names the window it was for", async () => {
    const stub = venueStub({ clob: { [WINDOW_2230.conditionId]: CLOB_2230 } });
    const harness = await started(stub);
    const failed = harness
      .publishedOfType("DataQualityIncidentOpened")
      .find((envelope) => payloadOf(envelope)["reasonCode"] === "GATEWAY_SERIES_CLOB_READ_FAILED");
    expect(payloadOf(failed)["affectedMarketIds"]).toEqual([WINDOW_2215.id]);
    expect(admissionTypes(harness).some((entry) => entry.endsWith(String(WINDOW_2230.id)))).toBe(true);
    await harness.gateway.stop();
  });

  it("a refused window with no start locator names its scope's reference id", async () => {
    const page = (): unknown => {
      const copy = structuredClone(KEYSET_PAGE);
      const market = ((copy.events[0] as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
      delete market["eventStartTime"];
      return copy;
    };
    const harness = await started(venueStub({ page }));
    const refused = harness
      .publishedOfType("DataQualityIncidentOpened")
      .find((envelope) => payloadOf(envelope)["reasonCode"] === "GATEWAY_SERIES_WINDOW_REFUSED");
    const ids = payloadOf(refused)["affectedMarketIds"] as string[];
    expect(ids).toEqual([incidentReferenceId(`polymarket-series-admission:${WINDOW_2215.conditionId}`)]);
    expect(ids[0]).toMatch(/^00000000-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await harness.gateway.stop();
  });
});

// ---------------------------------------------------------------------------
// ROLLOVER-1 r1: the remediation pins (R1-02, R1-03, R1-04 with R1-FABLE-01's
// N5, R1-FABLE-03, R1-FABLE-04). Each fails against the r0 candidate.
// ---------------------------------------------------------------------------

/** The keyset event at `index` of the recorded page, with its window's facts. */
function recordedEvent(index: number): { readonly conditionId: string; readonly yes: string; readonly no: string; readonly openMs: number } {
  const event = KEYSET_PAGE.events[index] as Record<string, unknown>;
  const market = (event["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const [yes, no] = tradingIdsOf(market) as [string, string];
  return { conditionId: String(market["conditionId"]), yes, no, openMs: Date.parse(String(market["eventStartTime"])) };
}

/** S-K04a's CLOB shape with the window's own condition and tokens (the r0 cap test's convention). */
function clobBodyFor(index: number): Record<string, unknown> {
  const window = recordedEvent(index);
  return { ...CLOB_2230, c: window.conditionId, t: [{ t: window.yes, o: "Up" }, { t: window.no, o: "Down" }] };
}

function unsubscribedTokens(harness: Harness): readonly string[] {
  return sentFrames(harness).flatMap((parsed) => (parsed.operation === "unsubscribe" ? (parsed.assets_ids ?? []) : []));
}

function incidentsNamed(harness: Harness, reasonCode: string): readonly (readonly string[])[] {
  return harness
    .publishedOfType("DataQualityIncidentOpened")
    .filter((envelope) => payloadOf(envelope)["reasonCode"] === reasonCode)
    .map((envelope) => payloadOf(envelope)["affectedMarketIds"] as string[]);
}

/** One admission cycle after moving the clock `ms` forward. */
async function cycleAfter(harness: Harness, ms: number): Promise<void> {
  harness.clock.advance(ms);
  harness.timers.advance(30_000);
  await harness.settle();
}

describe("ROLLOVER-1 r1 (R1-03): a window that closes during discovery is not admitted", () => {
  it("a CLOB read answered after the window's close admits nothing for it, records nothing, and admits the next window", async () => {
    // 22:29:59: the 22:15 window closes in one second; its CLOB read takes two.
    const clock: { current?: { advance(ms: number): void } } = {};
    const base = venueStub();
    const route = (request: PublicHttpRequest): PublicHttpResponse => {
      if (request.url.includes(`/clob-markets/${WINDOW_2215.conditionId}`)) clock.current?.advance(2_000);
      return base.route(request);
    };
    const harness = await buildHarness({ config: admissionConfig(), http: route, clockStartMs: Date.UTC(2026, 9, 4, 22, 29, 59) });
    clock.current = harness.clock;
    harness.gateway.start();
    harness.polymarketSockets.current.open();
    await harness.settle();

    expect(base.requests.filter((url) => url.includes(`/clob-markets/${WINDOW_2215.conditionId}`))).toHaveLength(1);
    expect(admissionTypes(harness).filter((entry) => entry.endsWith(String(WINDOW_2215.id)))).toEqual([]);
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]).toBeUndefined();
    expect(subscribedTokens(harness)).not.toContain(WINDOW_2215.yes);
    expect(harness.gateway.metrics().seriesAdmission?.windowsClosedBeforeAdmission).toBe(1);
    // The open window after it is admitted as usual, stamped with its own CLOB receipt.
    const admitted = harness.publishedOfType("SeriesWindowAdmitted");
    expect(admitted.map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([WINDOW_2230.id]);
    expect(Date.parse(String(admitted[0]?.receivedAt))).toBeLessThan(Date.parse("2026-10-04T22:45:00Z"));
    // Never offered again: the next cycle reads no CLOB for it (it is late).
    await cycleAfter(harness, 0);
    expect(base.requests.filter((url) => url.includes(`/clob-markets/${WINDOW_2215.conditionId}`))).toHaveLength(1);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1 r1 (R1-02): a locator on a day the calendar does not have is refused, never normalized", () => {
  it("February 30 under a March 2 title: REFUSED with the locator named, no admission", async () => {
    const title = "Bitcoin Up or Down - March 2, 5:15PM-5:30PM ET";
    const page = (): unknown => {
      const copy = structuredClone(KEYSET_PAGE);
      copy.events = [copy.events[0] as Record<string, unknown>];
      const event = copy.events[0] as Record<string, unknown>;
      const market = (event["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
      event["title"] = title;
      market["question"] = title;
      market["eventStartTime"] = "2026-02-30T22:15:00Z";
      market["endDate"] = "2026-02-30T22:30:00Z";
      return copy;
    };
    const harness = await started(venueStub({ page }), { clockStartMs: Date.UTC(2026, 2, 2, 22, 20) });
    expect(admissionTypes(harness)).toEqual([]);
    const record = ledger(harness.walFileSystem)[WINDOW_2215.conditionId];
    expect(record?.["status"]).toBe("REFUSED");
    expect(JSON.stringify(record?.["mismatches"])).toMatch(/start locator \(eventStartTime\) is absent or not an ISO-8601 instant/u);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toContain("GATEWAY_SERIES_WINDOW_REFUSED");
    await harness.gateway.stop();
  });
});

/** A `market_resolved` frame for one of the recorded windows (the market channel's documented shape, F-13). */
function marketResolvedFrame(window: { readonly conditionId: string; readonly yes: string; readonly no: string }, atMs: number): string {
  return JSON.stringify([
    {
      event_type: "market_resolved",
      id: "5255913",
      market: window.conditionId,
      assets_ids: [window.yes, window.no],
      winning_asset_id: window.yes,
      winning_outcome: "Up",
      timestamp: String(atMs),
    },
  ]);
}

function admittedIds(harness: Harness): readonly unknown[] {
  return harness.publishedOfType("SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"]);
}

function resolutionsOf(harness: Harness, internalMarketId: string | undefined): number {
  return harness.publishedOfType("MarketResolved").filter((envelope) => payloadOf(envelope)["internalMarketId"] === internalMarketId).length;
}

/** The CLOB body of every recorded window, by condition id (the recorded two, then S-K04a's shape for the rest). */
function everyClobBody(): Readonly<Record<string, unknown>> {
  const bodies: Record<string, unknown> = { [WINDOW_2215.conditionId]: CLOB_2215, [WINDOW_2230.conditionId]: CLOB_2230 };
  for (let index = 2; index < KEYSET_PAGE.events.length; index += 1) bodies[recordedEvent(index).conditionId] = clobBodyFor(index);
  return bodies;
}

describe("ROLLOVER-1 r1 (R1-04, N5) and r2 (R2-ASTRA-01, R2-ASTRA-02): an unresolved window is retired only by its resolution, and keeps its cap slot", () => {
  const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };

  it("R2-ASTRA-01: past its bound it stays ADMITTED and subscribed, names itself in an incident once, and KEEPS its cap slot — the next window is deferred; its late resolution retires it and frees the slot", async () => {
    const stub = venueStub({ clob: everyClobBody() });
    const harness = await started(stub, { config: admissionConfig({}, series) });
    // 22:20: the 22:15 window is admitted; the 22:30 window is due but the cap of 1 holds it.
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_CAP_REACHED")).toEqual([[WINDOW_2230.id]]);

    // 22:35: the 22:15 window closed at 22:30 and is unresolved 300 s later.
    await cycleAfter(harness, 15 * 60_000);
    const record = ledger(harness.walFileSystem)[WINDOW_2215.conditionId];
    expect(record?.["status"]).toBe("ADMITTED");
    expect(unsubscribedTokens(harness)).not.toContain(WINDOW_2215.yes);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_UNRESOLVED")).toEqual([[WINDOW_2215.id]]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ windowsAwaitingResolution: 1, windowsRetiredResolved: 0, liveWindows: 1 });
    // It KEEPS its cap slot: the open 22:30 window is NOT admitted in its place,
    // and its CLOB is never read while the cap holds it.
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    expect(stub.requests.some((url) => url.includes(`/clob-markets/${WINDOW_2230.conditionId}`))).toBe(false);
    // Held by the cap: the 22:30 window at 22:20 and at 22:35, the 22:45 window (now due) at 22:35.
    expect(harness.gateway.metrics().seriesAdmission?.windowsHeldByCap).toBe(3);
    // The incident is raised once, not every cycle.
    await cycleAfter(harness, 0);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_UNRESOLVED")).toEqual([[WINDOW_2215.id]]);

    // Its resolution arrives late: published, then it is retired RESOLVED and
    // unsubscribed, and the slot it frees admits the 22:30 window, still open.
    harness.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, harness.clock.nowMs()));
    await harness.settle();
    expect(resolutionsOf(harness, WINDOW_2215.id)).toBe(1);
    await cycleAfter(harness, 0);
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect(unsubscribedTokens(harness)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ windowsAwaitingResolution: 0, windowsRetiredResolved: 1 });
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id, WINDOW_2230.id]);
    await harness.gateway.stop();
  });

  it("R2-ASTRA-02: never abandoned — 80 minutes past its bound, every later window deferred, it stays ADMITTED, subscribed and in the directory; a market_resolved delivered then is still published, retires it, and the series resumes", async () => {
    const harness = await started(venueStub({ clob: everyClobBody() }), { config: admissionConfig({}, series) });
    await cycleAfter(harness, 15 * 60_000); // 22:35: the 22:15 window awaits its resolution
    await cycleAfter(harness, 15 * 60_000); // 22:50: r1 abandoned it here, for the window admitted in its place
    for (let index = 0; index < 4; index += 1) await cycleAfter(harness, 15 * 60_000); // to 23:50
    const records = ledger(harness.walFileSystem);
    expect(records[WINDOW_2215.conditionId]?.["status"]).toBe("ADMITTED");
    expect(Object.values(records).filter((entry) => entry["status"] === "RETIRED")).toEqual([]);
    expect(unsubscribedTokens(harness)).not.toContain(WINDOW_2215.yes);
    expect(harness.gateway.metrics().directory?.admittedWindowsReleased).toBe(0);
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_RESOLUTION_ABANDONED")).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ windowsAwaitingResolution: 1, liveWindows: 1 });

    // 23:50: the venue delivers the 22:15 window's resolution at last.
    harness.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, harness.clock.nowMs()));
    await harness.settle();
    expect(resolutionsOf(harness, WINDOW_2215.id)).toBe(1);
    await cycleAfter(harness, 0);
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    // The series resumes with the window open now (23:45-00:00), in the freed slot.
    const open = recordedEvent(6);
    expect(new Date(open.openMs).toISOString()).toBe("2026-10-04T23:45:00.000Z");
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id, windowInternalMarketId(open.conditionId, open.openMs)]);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1 r2 (R2-FABLE-02): two r1 behaviours, pinned", () => {
  it("R2-FABLE-02(a): a window's CLOB-failure incident is closed by its next successful read — fail, succeed (its ledger write then fails, so it is judged again), fail again: a SECOND incident names it", async () => {
    const walFileSystem = createMemoryFileSystem();
    let ledgerFails = false;
    const writeWholeFile = walFileSystem.writeWholeFile.bind(walFileSystem);
    walFileSystem.writeWholeFile = async (path: string, bytes: Uint8Array): Promise<void> => {
      if (ledgerFails && path === LEDGER_PATH) throw new Error("injected: the ledger file cannot be written");
      await writeWholeFile(path, bytes);
    };
    const page = (): unknown => {
      const copy = structuredClone(KEYSET_PAGE);
      copy.events = [copy.events[0] as Record<string, unknown>];
      return copy;
    };
    let clobFails = true;
    let clobAttempts = 0;
    const healthy = venueStub({ page });
    const route = (request: PublicHttpRequest): PublicHttpResponse => {
      if (request.url.includes("/clob-markets/")) clobAttempts += 1;
      return clobFails && request.url.includes("/clob-markets/") ? { status: 503, body: "{}" } : healthy.route(request);
    };
    const harness = await started({ route, requests: healthy.requests }, { walFileSystem });
    const clobReads = (): number => clobAttempts;

    // 1. The read fails: an incident names the window.
    expect(incidentsNamed(harness, "GATEWAY_SERIES_CLOB_READ_FAILED")).toEqual([[WINDOW_2215.id]]);
    // 2. The read succeeds and the window matches — but its admission cannot be
    //    recorded, so it is not admitted and is judged again next cycle.
    clobFails = false;
    ledgerFails = true;
    await cycleAfter(harness, 0);
    expect(clobReads()).toBe(2);
    expect(admissionTypes(harness)).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission?.ledgerWriteFailures).toBe(1);
    // 3. The read fails again: the first incident was closed by the successful
    //    read, so this failure opens a NEW one, naming the same window.
    clobFails = true;
    ledgerFails = false;
    await cycleAfter(harness, 0);
    expect(clobReads()).toBe(3);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_CLOB_READ_FAILED")).toEqual([[WINDOW_2215.id], [WINDOW_2215.id]]);
    // 4. It recovers and is admitted.
    clobFails = false;
    await cycleAfter(harness, 0);
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    await harness.gateway.stop();
  });

  it("R2-FABLE-02(b): the replay re-emits an unconfirmed intent even past its bound — unchanged, attached, awaiting its resolution in its cap slot; its late resolution then retires it", async () => {
    const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
    const walFileSystem = createMemoryFileSystem();
    // 22:20: the admission is written as an intent, but publication is halted.
    const halted = await started(venueStub(), { walFileSystem, startupTransportFailure: "redis down", config: admissionConfig({}, series) });
    const intent = ledger(walFileSystem)[WINDOW_2215.conditionId];
    expect(intent?.["status"]).toBe("ADMITTED");
    expect(intent?.["admissionConfirmedAt"]).toBeUndefined();
    await halted.gateway.stop();

    // The next epoch starts at 22:40: the window closed at 22:30, and its bound passed at 22:35.
    const stub = venueStub({ clob: everyClobBody() });
    const restarted = await started(stub, { walFileSystem, idSeed: 1, config: admissionConfig({}, series), clockStartMs: Date.UTC(2026, 9, 4, 22, 40) });
    // Re-emitted, unchanged and not re-judged (no CLOB read for it), and attached.
    const admitted = restarted.publishedOfType("SeriesWindowAdmitted");
    expect(admitted.map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([WINDOW_2215.id]);
    expect(payloadOf(admitted[0])["scheduledCloseAt"]).toBe((intent?.["window"] as Record<string, unknown> | undefined)?.["scheduledCloseAt"]);
    expect(stub.requests.some((url) => url.includes(`/clob-markets/${WINDOW_2215.conditionId}`))).toBe(false);
    expect(restarted.gateway.metrics().seriesAdmission?.admissionsReplayed).toBe(1);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "ADMITTED", admissionConfirmedAt: expect.any(String) });
    expect(subscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    // It awaits its resolution, named, in its cap slot: the open 22:30 window is deferred.
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_WINDOW_UNRESOLVED")).toEqual([[WINDOW_2215.id]]);
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ windowsAwaitingResolution: 1, liveWindows: 1 });

    // Its late resolution is delivered and retires it.
    restarted.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, restarted.clock.nowMs()));
    await restarted.settle();
    expect(resolutionsOf(restarted, WINDOW_2215.id)).toBe(1);
    await cycleAfter(restarted, 0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect(admittedIds(restarted)).toEqual([WINDOW_2215.id, WINDOW_2230.id]);
    await restarted.gateway.stop();
  });
});

describe("ROLLOVER-1 r1 (R1-FABLE-03): a failed CLOB read's incident names its own window", () => {
  it("two windows whose reads fail in one cycle open TWO incidents, each naming its own window (not one per series and reason)", async () => {
    let failing = true;
    const healthy = venueStub();
    const route = (request: PublicHttpRequest): PublicHttpResponse =>
      failing && request.url.includes("/clob-markets/") ? { status: 503, body: "{}" } : healthy.route(request);
    const harness = await started({ route, requests: healthy.requests });
    expect(incidentsNamed(harness, "GATEWAY_SERIES_CLOB_READ_FAILED")).toEqual([[WINDOW_2215.id], [WINDOW_2230.id]]);
    // A repeat of the same window's failure is suppressed while its incident is open.
    await cycleAfter(harness, 0);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_CLOB_READ_FAILED")).toEqual([[WINDOW_2215.id], [WINDOW_2230.id]]);
    // Both recover and are admitted.
    failing = false;
    await cycleAfter(harness, 0);
    expect(harness.publishedOfType("SeriesWindowAdmitted")).toHaveLength(2);
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1 r1 (R1-FABLE-04): at most maximumConcurrentWindows CLOB reads are attempted per series per cycle", () => {
  it("cap 1 and two due windows the review refuses: one read this cycle, the other next cycle", async () => {
    const page = (): unknown => {
      const copy = structuredClone(KEYSET_PAGE);
      for (const event of copy.events.slice(0, 2)) {
        const market = ((event as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
        market["feeSchedule"] = { exponent: 1, rate: 0.0625, takerOnly: true, rebateRate: 0.2 };
      }
      return copy;
    };
    const stub = venueStub({ page });
    const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1 };
    const harness = await started(stub, { config: admissionConfig({}, series) });
    const clobReads = (): number => stub.requests.filter((url) => url.includes("/clob-markets/")).length;
    expect(clobReads()).toBe(1);
    expect(harness.gateway.metrics().seriesAdmission?.windowsDeferredByReadBudget).toBe(1);
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]?.["status"]).toBe("REFUSED");
    expect(ledger(harness.walFileSystem)[WINDOW_2230.conditionId]).toBeUndefined();
    await cycleAfter(harness, 0);
    expect(clobReads()).toBe(2);
    expect(ledger(harness.walFileSystem)[WINDOW_2230.conditionId]?.["status"]).toBe("REFUSED");
    await harness.gateway.stop();
  });
});

// ---------------------------------------------------------------------------
// ROLLOVER-1 r3: the remediation pins (R3-ASTRA-01, R3-FABLE-01, R3-FABLE-02).
// ---------------------------------------------------------------------------

function unpublishedResolutions(harness: Harness): number {
  return harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_RESOLUTION_UNPUBLISHED").length;
}

/** Observer incidents (published or not — a halted publisher publishes none) naming `reasonCode`. */
function observedIncidents(harness: Harness, reasonCode: string): number {
  return harness.incidents.filter((incident) => incident.reasonCode === reasonCode).length;
}

describe("ROLLOVER-1 r3 (R3-ASTRA-01): a window is retired only once its resolution is PUBLISHED", () => {
  const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
  /** 22:32: the 22:15 window closed at 22:30; its market_resolved arrives now. */
  const RESOLVED_AT_MS = Date.UTC(2026, 9, 4, 22, 32);

  /** Epoch 1: W2215 admitted; publication halts; its resolution is dispatched but never published. */
  async function haltedAtResolution(walFileSystem: MemoryFileSystem): Promise<Harness> {
    const harness = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, config: admissionConfig({}, series) });
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    harness.clock.advance(RESOLVED_AT_MS - NOW_MS);
    harness.transport.setUnavailable(true);
    harness.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, RESOLVED_AT_MS));
    await harness.settle();
    return harness;
  }

  it("R3-ASTRA-01: a resolution the publisher did not publish leaves its window ADMITTED, subscribed, registered and in its cap slot, with the resolution kept; the next epoch re-publishes it unchanged, and only then is the window retired RESOLVED and the series moves on", async () => {
    const walFileSystem = createMemoryFileSystem();
    const halted = await haltedAtResolution(walFileSystem);
    expect(resolutionsOf(halted, WINDOW_2215.id)).toBe(0);
    // Cycles later (to 22:41, past the bound): still ADMITTED, with the resolution OWED.
    for (let index = 0; index < 3; index += 1) await cycleAfter(halted, 3 * 60_000);
    const owed = ledger(walFileSystem)[WINDOW_2215.conditionId];
    expect(owed?.["status"]).toBe("ADMITTED");
    expect(unpublishedResolutions(halted)).toBe(1);
    const kept = owed?.["resolution"] as Record<string, unknown> | undefined;
    expect(kept?.["payload"]).toEqual({ internalMarketId: WINDOW_2215.id, conditionId: WINDOW_2215.conditionId, outcome: "YES_WIN", resolvedAt: expect.any(String) as unknown });
    expect(kept?.["publishedAt"]).toBeUndefined();
    expect(kept?.["rawFrame"]).toEqual({ gatewayEpoch: halted.gateway.gatewayEpoch, ingestSeq: expect.stringMatching(/^[0-9]+$/u) as unknown });
    // Its route is kept: never unsubscribed, never released from the directory.
    expect(unsubscribedTokens(halted)).not.toContain(WINDOW_2215.yes);
    expect(halted.gateway.metrics().directory?.admittedWindowsReleased).toBe(0);
    // And its cap slot: the 22:30 window is never admitted, not even as an intent.
    expect(ledger(walFileSystem)[WINDOW_2230.conditionId]).toBeUndefined();
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsObserved: 1, resolutionsUnpublished: 1, resolutionsOwed: 1, windowsRetiredResolved: 0, liveWindows: 1 });
    // An owed resolution is not "unresolved": no such incident names it.
    expect(observedIncidents(halted, "GATEWAY_SERIES_WINDOW_UNRESOLVED")).toBe(0);
    await halted.gateway.stop();

    // Epoch 2 (22:42): re-attached, and the recorded resolution re-published, unchanged.
    const restarted = await started(venueStub({ clob: everyClobBody() }), {
      walFileSystem,
      idSeed: 1,
      config: admissionConfig({}, series),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 42),
    });
    expect(subscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    const republished = restarted.publishedOfType("MarketResolved");
    expect(republished.map((envelope) => payloadOf(envelope))).toEqual([kept?.["payload"]]);
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsReplayed: 1, resolutionsUnpublished: 0 });
    expect((ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"] as Record<string, unknown> | undefined)?.["publishedAt"]).toEqual(expect.any(String));
    // Only now is it retired RESOLVED — carrying the published resolution — and
    // unsubscribed, and the 22:30 window, still open, takes the freed slot.
    await cycleAfter(restarted, 0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({
      status: "RETIRED",
      retiredReason: "RESOLVED",
      resolution: { payload: kept?.["payload"], publishedAt: expect.any(String) as unknown },
    });
    expect(unsubscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    expect(admittedIds(restarted)).toEqual([WINDOW_2230.id]);
    await restarted.gateway.stop();
  });

  it("R3-ASTRA-01 (retry): while the re-publication halts too, the resolution stays owed and the window stays; a later epoch that publishes it retires it", async () => {
    const walFileSystem = createMemoryFileSystem();
    const halted = await haltedAtResolution(walFileSystem);
    await halted.gateway.stop();
    // Epoch 2 starts with the transport down: the re-publication halts as well.
    const down = await started(venueStub({ clob: everyClobBody() }), {
      walFileSystem,
      idSeed: 1,
      startupTransportFailure: "redis down",
      config: admissionConfig({}, series),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 42),
    });
    await cycleAfter(down, 60_000);
    expect(down.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsReplayed: 1, resolutionsUnpublished: 1, resolutionsOwed: 1 });
    const stillOwed = ledger(walFileSystem)[WINDOW_2215.conditionId];
    expect(stillOwed?.["status"]).toBe("ADMITTED");
    expect((stillOwed?.["resolution"] as Record<string, unknown> | undefined)?.["publishedAt"]).toBeUndefined();
    await down.gateway.stop();
    // Epoch 3: published, then retired.
    const healthy = await started(venueStub({ clob: everyClobBody() }), {
      walFileSystem,
      idSeed: 2,
      config: admissionConfig({}, series),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 44),
    });
    expect(resolutionsOf(healthy, WINDOW_2215.id)).toBe(1);
    await cycleAfter(healthy, 0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    await healthy.gateway.stop();
  });
});

describe("ROLLOVER-1 r3 (R3-FABLE-01): the operator's named retirement is the recovery for a resolution never observed", () => {
  const REASON = "gateway stopped 22:20-23:20 across both resolutions; checked resolved on polymarket.com";

  it("R3-FABLE-01: after a stop spanning both live windows' resolutions, each named window is retired OPERATOR once past its bound, with the reason and an incident naming it, and the series resumes", async () => {
    const walFileSystem = createMemoryFileSystem();
    // Sample review: cap 2, bound 3,600 s. 22:20: the 22:15 and 22:30 windows are admitted; then the gateway stops.
    const first = await started(venueStub({ clob: everyClobBody() }), { walFileSystem });
    expect(admittedIds(first)).toEqual([WINDOW_2215.id, WINDOW_2230.id]);
    await first.gateway.stop();

    // 23:20: both resolutions fell in the gap. The operator names both windows.
    const retirements = [
      { internalMarketId: WINDOW_2215.id, reason: REASON },
      { internalMarketId: WINDOW_2230.id, reason: REASON },
    ];
    const config = admissionConfig({
      seriesAdmission: { ...(admissionConfig()["seriesAdmission"] as Record<string, unknown>), operatorRetirements: retirements },
    });
    const restarted = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, idSeed: 7, config, clockStartMs: NOW_MS + 60 * 60_000 });
    // Neither is past its bound yet (22:30 + 3,600 s = 23:30; 22:45 + 3,600 s = 23:45): deferred, named, nothing admitted.
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED")).toEqual([[WINDOW_2215.id], [WINDOW_2230.id]]);
    expect(Object.values(ledger(walFileSystem)).map((record) => record["status"])).toEqual(["ADMITTED", "ADMITTED"]);
    expect(admittedIds(restarted)).toEqual([]);
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ operatorRetirementsDeferred: 2, windowsRetiredByOperator: 0 });

    // 23:35: the 22:15 window is past its bound — retired OPERATOR — and the open 23:30 window takes its slot.
    await cycleAfter(restarted, 15 * 60_000);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "OPERATOR", operatorReason: REASON });
    expect(ledger(walFileSystem)[WINDOW_2230.conditionId]?.["status"]).toBe("ADMITTED");
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR")).toEqual([[WINDOW_2215.id]]);
    const retiredIncident = restarted.incidents.find((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR");
    expect(retiredIncident?.detail).toContain(REASON);
    expect(unsubscribedTokens(restarted)).toEqual(expect.arrayContaining([WINDOW_2215.yes, WINDOW_2215.no]));
    const open2330 = recordedEvent(5);
    expect(admittedIds(restarted)).toEqual([windowInternalMarketId(open2330.conditionId, open2330.openMs)]);

    // 23:50: the 22:30 window too; the 23:45 window is admitted. No resolution is ever published for either.
    await cycleAfter(restarted, 15 * 60_000);
    expect(ledger(walFileSystem)[WINDOW_2230.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "OPERATOR", operatorReason: REASON });
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR")).toEqual([[WINDOW_2215.id], [WINDOW_2230.id]]);
    const open2345 = recordedEvent(6);
    expect(admittedIds(restarted)).toEqual([windowInternalMarketId(open2330.conditionId, open2330.openMs), windowInternalMarketId(open2345.conditionId, open2345.openMs)]);
    expect(restarted.publishedOfType("MarketResolved")).toEqual([]);
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ windowsRetiredByOperator: 2, windowsRetiredResolved: 0, operatorRetirementsDeferred: 0, operatorRetirementsUnmatched: 0 });
    await restarted.gateway.stop();
  });

  it("R3-FABLE-01: an operator's retirement never overrides an OWED resolution — it is re-published and retires the window RESOLVED — and one naming no window is reported, retiring nothing", async () => {
    const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
    const walFileSystem = createMemoryFileSystem();
    const halted = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, config: admissionConfig({}, series) });
    halted.clock.advance(12 * 60_000);
    halted.transport.setUnavailable(true);
    halted.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, halted.clock.nowMs()));
    await halted.settle();
    await halted.gateway.stop();

    const stranger = windowInternalMarketId(WINDOW_2230.conditionId, Date.UTC(2026, 9, 5, 9, 0)) ?? "";
    const config = admissionConfig(
      {
        seriesAdmission: {
          ...(admissionConfig()["seriesAdmission"] as Record<string, unknown>),
          series: [series],
          operatorRetirements: [
            { internalMarketId: WINDOW_2215.id, reason: REASON },
            { internalMarketId: stranger, reason: "a typo" },
          ],
        },
      },
      series,
    );
    // 22:42: past the 22:15 window's bound (22:35), with its resolution owed.
    const restarted = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, idSeed: 1, config, clockStartMs: Date.UTC(2026, 9, 4, 22, 42) });
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED")).toEqual([[WINDOW_2215.id]]);
    expect(incidentsNamed(restarted, "GATEWAY_SERIES_OPERATOR_RETIREMENT_UNMATCHED")).toEqual([[stranger]]);
    expect(resolutionsOf(restarted, WINDOW_2215.id)).toBe(1);
    await cycleAfter(restarted, 0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]?.["operatorReason"]).toBeUndefined();
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ windowsRetiredByOperator: 0, windowsRetiredResolved: 1, operatorRetirementsUnmatched: 1 });
    await restarted.gateway.stop();
  });
});

describe("ROLLOVER-1 r3 (R3-FABLE-02): the cap counts unconfirmed intents", () => {
  it("R3-FABLE-02: with publication halted, two intents fill the cap of 2 and a later due window is held GATEWAY_SERIES_CAP_REACHED, with no intent of its own", async () => {
    const walFileSystem = createMemoryFileSystem();
    const stub = venueStub({ clob: everyClobBody() });
    const halted = await started(stub, { walFileSystem, startupTransportFailure: "redis down" });
    const intents = Object.values(ledger(walFileSystem)).filter((record) => record["status"] === "ADMITTED" && record["admissionConfirmedAt"] === undefined);
    expect(intents.map((record) => record["key"])).toEqual([WINDOW_2215.conditionId, WINDOW_2230.conditionId]);
    expect(observedIncidents(halted, "GATEWAY_SERIES_CAP_REACHED")).toBe(0);
    // 22:31: the 22:45 window is due (14 minutes ahead) while the two intents are live.
    await cycleAfter(halted, 11 * 60_000);
    const third = recordedEvent(2);
    expect(observedIncidents(halted, "GATEWAY_SERIES_CAP_REACHED")).toBe(1);
    expect(ledger(walFileSystem)[third.conditionId]).toBeUndefined();
    expect(stub.requests.some((url) => url.includes(`/clob-markets/${third.conditionId}`))).toBe(false);
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ windowsAdmitted: 2, windowsHeldByCap: 1, liveWindows: 2 });
    await halted.gateway.stop();
  });
});

describe("ROLLOVER-1 r4 (R4-FABLE-01): a resolution whose ledger write fails is held, owed, and written again", () => {
  const series = { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };
  /** 22:32: the 22:15 window closed at 22:30; its market_resolved arrives now. */
  const RESOLVED_AT_MS = Date.UTC(2026, 9, 4, 22, 32);

  /** A memory WAL root whose admission-ledger writes fail while `failing.ledger` is set. */
  function failingLedger(): { readonly walFileSystem: MemoryFileSystem; readonly failing: { ledger: boolean } } {
    const walFileSystem = createMemoryFileSystem();
    const failing = { ledger: false };
    const writeWholeFile = walFileSystem.writeWholeFile.bind(walFileSystem);
    walFileSystem.writeWholeFile = async (path: string, bytes: Uint8Array): Promise<void> => {
      if (failing.ledger && path === LEDGER_PATH) throw new Error("injected: the admission ledger cannot be written");
      await writeWholeFile(path, bytes);
    };
    return { walFileSystem, failing };
  }

  /** W2215 admitted; then publication halts AND the ledger fails; then W2215's market_resolved arrives. */
  async function doubleFailure(walFileSystem: MemoryFileSystem, failing: { ledger: boolean }): Promise<Harness> {
    const harness = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, config: admissionConfig({}, series) });
    expect(admittedIds(harness)).toEqual([WINDOW_2215.id]);
    harness.clock.advance(RESOLVED_AT_MS - NOW_MS);
    harness.transport.setUnavailable(true);
    failing.ledger = true;
    harness.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, RESOLVED_AT_MS));
    await harness.settle();
    return harness;
  }

  function pageDetail(harness: Harness): string | undefined {
    return harness.incidents.find((incident) => incident.reasonCode === "GATEWAY_SERIES_RESOLUTION_UNPUBLISHED")?.detail;
  }

  it("R4-FABLE-01: the write and the publication both fail — the PAGE says the resolution is NOT in the ledger; the next cycle writes it; the next epoch re-publishes it and retires the window RESOLVED", async () => {
    const { walFileSystem, failing } = failingLedger();
    const halted = await doubleFailure(walFileSystem, failing);
    expect(resolutionsOf(halted, WINDOW_2215.id)).toBe(0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"]).toBeUndefined();
    // The PAGE says where the resolution is: not in the ledger, and lost by a stop.
    expect(pageDetail(halted)).toMatch(/is NOT in the admission ledger/u);
    expect(pageDetail(halted)).toMatch(/LOST/u);
    expect(pageDetail(halted)).not.toMatch(/kept in the admission ledger/u);
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsObserved: 1, resolutionsUnpublished: 1, resolutionsUnrecorded: 1 });
    expect(halted.gateway.metrics().seriesAdmission?.ledgerWriteFailures).toBeGreaterThanOrEqual(1);

    // The ledger heals: the next cycle writes the held resolution, owed.
    failing.ledger = false;
    await cycleAfter(halted, 30_000);
    const owed = ledger(walFileSystem)[WINDOW_2215.conditionId];
    expect(owed?.["status"]).toBe("ADMITTED");
    expect(owed?.["resolution"]).toBeDefined();
    const kept = owed?.["resolution"] as Record<string, unknown> | undefined;
    expect(kept?.["payload"]).toEqual({ internalMarketId: WINDOW_2215.id, conditionId: WINDOW_2215.conditionId, outcome: "YES_WIN", resolvedAt: expect.any(String) as unknown });
    expect(kept?.["publishedAt"]).toBeUndefined();
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsUnrecorded: 0, resolutionsOwed: 1, liveWindows: 1 });
    await halted.gateway.stop();

    // Epoch 2 (22:42): re-published unchanged; then retired RESOLVED, and the 22:30 window takes the slot.
    const restarted = await started(venueStub({ clob: everyClobBody() }), {
      walFileSystem,
      idSeed: 4,
      config: admissionConfig({}, series),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 42),
    });
    expect(restarted.publishedOfType("MarketResolved").map((envelope) => payloadOf(envelope))).toEqual([kept?.["payload"]]);
    await cycleAfter(restarted, 0);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect(admittedIds(restarted)).toEqual([WINDOW_2230.id]);
    await restarted.gateway.stop();
  });

  it("R4-FABLE-01: while the ledger stays unwritable, the held resolution is OWED past the window's bound — not 'unresolved', its slot kept — and the write lands once the ledger heals", async () => {
    const { walFileSystem, failing } = failingLedger();
    const halted = await doubleFailure(walFileSystem, failing);
    // Cycles to 22:41, past the 22:35 bound, with every ledger write failing.
    for (let index = 0; index < 3; index += 1) await cycleAfter(halted, 3 * 60_000);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"]).toBeUndefined();
    // Owed, not "unresolved": r3 knew nothing of it and named the window unresolved.
    expect(observedIncidents(halted, "GATEWAY_SERIES_WINDOW_UNRESOLVED")).toBe(0);
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsOwed: 1, windowsAwaitingResolution: 0, liveWindows: 1 });
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsUnrecorded: 1 });
    // Its slot is kept: the 22:30 window is not admitted.
    expect(ledger(walFileSystem)[WINDOW_2230.conditionId]).toBeUndefined();
    expect(unsubscribedTokens(halted)).not.toContain(WINDOW_2215.yes);
    failing.ledger = false;
    await cycleAfter(halted, 60_000);
    expect(ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"]).toBeDefined();
    expect((ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"] as Record<string, unknown> | undefined)?.["payload"]).toMatchObject({ internalMarketId: WINDOW_2215.id });
    expect(halted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionsUnrecorded: 0, resolutionsOwed: 1 });
    await halted.gateway.stop();
  });

  it("control: with the ledger healthy, the same unpublished resolution's PAGE says it is kept in the ledger", async () => {
    const { walFileSystem, failing } = failingLedger();
    const harness = await started(venueStub({ clob: everyClobBody() }), { walFileSystem, config: admissionConfig({}, series) });
    harness.clock.advance(RESOLVED_AT_MS - NOW_MS);
    harness.transport.setUnavailable(true);
    harness.polymarketSockets.current.message(marketResolvedFrame(WINDOW_2215, RESOLVED_AT_MS));
    await harness.settle();
    expect(failing.ledger).toBe(false);
    expect(pageDetail(harness)).toMatch(/its resolution is kept in the admission ledger/u);
    expect((ledger(walFileSystem)[WINDOW_2215.conditionId]?.["resolution"] as Record<string, unknown> | undefined)?.["payload"]).toMatchObject({ internalMarketId: WINDOW_2215.id });
    await harness.gateway.stop();
  });
});

describe("ROLLOVER-1 r5 (R5-ASTRA-01): a window whose MARKET-level negRisk is not the reviewed value is refused, whatever its event says", () => {
  /** The recorded page with the 22:15 window's event flag set and its market's flag changed. */
  function pageWithNegRisk(eventFlag: boolean, mutateMarket: (market: Record<string, unknown>) => void): () => unknown {
    return () => {
      const page = structuredClone(KEYSET_PAGE);
      const event = page.events[0] as Record<string, unknown>;
      event["negRisk"] = eventFlag;
      mutateMarket((event["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>);
      return page;
    };
  }

  it("control: the market's flag and its event's both false, as reviewed — ADMITTED and subscribed", async () => {
    const harness = await started(venueStub({ page: pageWithNegRisk(false, (market) => (market["negRisk"] = false)) }));
    expect(admissionTypes(harness).filter((entry) => entry.endsWith(String(WINDOW_2215.id)))).toEqual([
      `MarketDiscovered:${String(WINDOW_2215.id)}`,
      `TradingParametersChanged:${String(WINDOW_2215.id)}`,
      `SeriesWindowAdmitted:${String(WINDOW_2215.id)}`,
    ]);
    expect(ledger(harness.walFileSystem)[WINDOW_2215.conditionId]?.["status"]).toBe("ADMITTED");
    expect(subscribedTokens(harness)).toContain(WINDOW_2215.yes);
    expect(harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED")).toEqual([]);
    await harness.gateway.stop();
  });

  for (const [name, eventFlag, mutateMarket, mismatch] of [
    ["the market's own flag true under an event flag of false", false, (market: Record<string, unknown>) => {
      market["negRisk"] = true;
    }, /Gamma Market\.negRisk is true, not the reviewed false/u],
    ["the market's flag null", false, (market: Record<string, unknown>) => {
      market["negRisk"] = null;
    }, /Gamma Market\.negRisk is null, not the reviewed false/u],
    ["the market's flag absent", false, (market: Record<string, unknown>) => {
      delete market["negRisk"];
    }, /Gamma Market\.negRisk is absent, not the reviewed false/u],
    ["the market's flag malformed (a string)", false, (market: Record<string, unknown>) => {
      market["negRisk"] = "false";
    }, /Gamma Market\.negRisk is unreadable, not the reviewed false/u],
    ["an event flag of true that contradicts its market's false", true, (market: Record<string, unknown>) => {
      market["negRisk"] = false;
    }, /Gamma Event\.negRisk is true, not the reviewed false/u],
  ] as const) {
    it(`refuses ${name}: no admission event, a REFUSED record and an incident naming it, its tokens never subscribed; the next window is admitted`, async () => {
      const harness = await started(venueStub({ page: pageWithNegRisk(eventFlag, mutateMarket) }));
      expect(admissionTypes(harness).filter((entry) => entry.endsWith(String(WINDOW_2215.id)))).toEqual([]);
      const record = ledger(harness.walFileSystem)[WINDOW_2215.conditionId];
      expect(record?.["status"]).toBe("REFUSED");
      expect(JSON.stringify(record?.["mismatches"])).toMatch(mismatch);
      const refused = harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.detail).toMatch(mismatch);
      expect(subscribedTokens(harness)).not.toContain(WINDOW_2215.yes);
      expect(subscribedTokens(harness)).not.toContain(WINDOW_2215.no);
      // Only the mutated window is refused: the 22:30 window, unchanged, is admitted.
      expect(admissionTypes(harness)).toContain(`SeriesWindowAdmitted:${String(WINDOW_2230.id)}`);
      expect(subscribedTokens(harness)).toContain(WINDOW_2230.yes);
      await harness.gateway.stop();
    });
  }
});

// ---------------------------------------------------------------------------
// V2-1 (ADR-030 Amendment 2 rules 1-3; `docs/venue/protocol-v2-migration-plan.md`
// package V2-1, rows A1, A4-A8, D3, D5): Protocol V2 windows through the real
// gateway. No V2 market of our series has been observed on Gamma (U-36), so
// the V2 window is the recorded 22:15 window carrying the documented example's
// V2 fields (S-D16: `version`, `clobTokenIds`, `positionIds`) with the
// canary's observed ids (S-L01), its 31-byte condition id (F-43) and its tick.
// ---------------------------------------------------------------------------

const [V2_UP, V2_DOWN] = (CLOB_V2["t"] as { t: string }[]).map((token) => token.t) as [string, string];
const V2_WINDOW = {
  conditionId31: PROTOCOL_V2_SAMPLES.canaryConditionId31,
  conditionId32: String(CLOB_V2["c"]),
  up: V2_UP,
  down: V2_DOWN,
  id: windowInternalMarketId(PROTOCOL_V2_SAMPLES.canaryConditionId31, Date.UTC(2026, 9, 4, 22, 15)),
};
/** The live V1 btc-15m window's CTF ids (S-G04): a populated `clobTokenIds` beside a V2 market's `positionIds`. */
const OTHER_CTF_IDS = [
  "25070934348813416902477876984955073880416401960631253331845590271167412497744",
  "111614563957165270026378011809694313565736745512637881727398424401624030147043",
] as const;

/** A review accepting V1 and V2 windows (the operator's step before the switchover, `V2-0` follow-up 3). */
function reviewAccepting(accepted: readonly string[]): Record<string, unknown> {
  const document = reviewedBtc15mSeriesDocument();
  return { ...document, parameters: { ...(document["parameters"] as Record<string, unknown>), acceptedProtocolVersions: accepted } };
}

/** The recorded page with its first window as a V2 market (then `mutate`d); the 22:30 window stays V1. */
function v2Page(mutate: (market: Record<string, unknown>) => void = () => undefined): () => unknown {
  return () => {
    const page = structuredClone(KEYSET_PAGE);
    const market = ((page.events[0] as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    market["version"] = GAMMA_V2_EXAMPLE["version"];
    market["clobTokenIds"] = GAMMA_V2_EXAMPLE["clobTokenIds"];
    market["positionIds"] = [V2_WINDOW.up, V2_WINDOW.down];
    market["conditionId"] = V2_WINDOW.conditionId31;
    market["orderPriceMinTickSize"] = CLOB_V2["mts"];
    mutate(market);
    return page;
  };
}

/** The stub CLOB: the canary's body under its 32-byte id ONLY — the 31-byte form is a 404, as F-70 observed. */
function v2Stub(options: { readonly mutate?: (market: Record<string, unknown>) => void; readonly clobV2?: Record<string, unknown> } = {}) {
  return venueStub({
    page: v2Page(options.mutate),
    clob: { [V2_WINDOW.conditionId32]: options.clobV2 ?? CLOB_V2, [WINDOW_2230.conditionId]: CLOB_2230 },
  });
}

/** A ledger record's mismatches as one text, quotes unescaped. */
function mismatchesOf(record: Record<string, unknown> | undefined): string {
  return ((record?.["mismatches"] as string[] | undefined) ?? []).join(" | ");
}

function clobReadsOf(stub: { readonly requests: readonly string[] }, conditionId: string): number {
  return stub.requests.filter((url) => url === `${CLOB_BASE}/clob-markets/${conditionId}`).length;
}

async function startedUnder(stub: ReturnType<typeof venueStub>, accepted: readonly string[], overrides: Record<string, unknown> = {}): Promise<Harness> {
  return started(stub, { config: admissionConfig(overrides, reviewAccepting(accepted)) });
}

describe("V2-1 acceptance 1, 5 and 6: a V2 window is admitted with the ids its version selects, read at 32 bytes, identified at 31", () => {
  it("built from the documented example: positionIds admitted, the CLOB read sent right-padded, t[] paired on clob-markets-v2.jsonc, Gamma's 31-byte id the identity", async () => {
    const stub = v2Stub();
    const harness = await startedUnder(stub, ["v1", "v2"]);

    const admitted = harness.publishedOfType("SeriesWindowAdmitted").map(payloadOf);
    expect(admitted.map((payload) => payload["internalMarketId"])).toEqual([V2_WINDOW.id, WINDOW_2230.id]);
    expect(admitted[0]).toMatchObject({
      internalMarketId: V2_WINDOW.id,
      conditionId: V2_WINDOW.conditionId31,
      yesTokenId: V2_WINDOW.up,
      noTokenId: V2_WINDOW.down,
      tickSize: "0.01",
    });
    expect(payloadOf(harness.publishedOfType("MarketDiscovered")[0])).toMatchObject({
      conditionId: V2_WINDOW.conditionId31,
      yesTokenId: V2_WINDOW.up,
      noTokenId: V2_WINDOW.down,
    });
    // The read went to the 32-byte form, once; never to the 31-byte form (a 404 at the venue, F-70).
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(1);
    expect(clobReadsOf(stub, V2_WINDOW.conditionId31)).toBe(0);
    // The journaled frame the admission cites is that 32-byte read.
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    const causation = harness.publishedOfType("SeriesWindowAdmitted")[0]?.causationId ?? "";
    const cited = frames.find((frame) => frame.ingestSeq === causation.split(":").at(-1));
    expect(cited?.endpoint).toBe(`${CLOB_BASE}/clob-markets/${V2_WINDOW.conditionId32}`);
    // Gamma's text is the identity: the ledger key, the derived id.
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]?.["status"]).toBe("ADMITTED");
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId32]).toBeUndefined();
    expect(subscribedTokens(harness)).toEqual(expect.arrayContaining([V2_WINDOW.up, V2_WINDOW.down]));
    await harness.gateway.stop();
  });

  it("with BOTH fields populated, \"v2\" admits positionIds: the CTF ids reach no event and no subscription", async () => {
    const stub = v2Stub({ mutate: (market) => void (market["clobTokenIds"] = JSON.stringify(OTHER_CTF_IDS)) });
    const harness = await startedUnder(stub, ["v1", "v2"]);
    expect(payloadOf(harness.publishedOfType("SeriesWindowAdmitted")[0])).toMatchObject({ yesTokenId: V2_WINDOW.up, noTokenId: V2_WINDOW.down });
    const published = JSON.stringify(harness.published().map((envelope) => envelope.payload));
    for (const ctf of OTHER_CTF_IDS) {
      expect(published).not.toContain(ctf);
      expect(subscribedTokens(harness)).not.toContain(ctf);
    }
    await harness.gateway.stop();
  });
});

describe("V2-1 acceptance 2, 3 and 4: every unclear V2 window is REFUSED by name, with the existing incident", () => {
  for (const [name, mutate, mismatch] of [
    ["a missing version", (m: Record<string, unknown>) => void delete m["version"], /Market\.version is absent/u],
    ["a null version", (m: Record<string, unknown>) => void (m["version"] = null), /Market\.version is null/u],
    ["an unknown version", (m: Record<string, unknown>) => void (m["version"] = "v3"), /Market\.version is "v3", not a supported protocol version/u],
    ["positionIds null beside populated clobTokenIds (not yet available, F-40)", (m: Record<string, unknown>) => {
      m["positionIds"] = null;
      m["clobTokenIds"] = JSON.stringify(OTHER_CTF_IDS);
    }, /Market\.positionIds, the field Market\.version "v2" selects, is null: the window's ids are not yet available/u],
    ["positionIds absent", (m: Record<string, unknown>) => void delete m["positionIds"], /Market\.positionIds, the field Market\.version "v2" selects, is absent/u],
    ["positionIds as a JSON-encoded string", (m: Record<string, unknown>) => void (m["positionIds"] = JSON.stringify([V2_WINDOW.up, V2_WINDOW.down])), /is not an array of decimal strings/u],
    ["one position id", (m: Record<string, unknown>) => void (m["positionIds"] = [V2_WINDOW.up]), /not exactly two position ids/u],
    ["a non-decimal position id", (m: Record<string, unknown>) => void (m["positionIds"] = [`+${V2_WINDOW.up}`, V2_WINDOW.down]), /index-0 position id .* is not a canonical token id/u],
    ["two equal position ids", (m: Record<string, unknown>) => void (m["positionIds"] = [V2_WINDOW.up, V2_WINDOW.up]), /the two position ids are the same id/u],
    ["the documented example's outcomes (Yes/No)", (m: Record<string, unknown>) => void (m["outcomes"] = GAMMA_V2_EXAMPLE["outcomes"]), /Market\.outcomes/u],
  ] as const) {
    it(`refuses ${name}: a REFUSED record naming it, GATEWAY_SERIES_WINDOW_REFUSED naming the window, no admission`, async () => {
      const harness = await startedUnder(v2Stub({ mutate }), ["v1", "v2"]);
      expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
      const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
      expect(record?.["status"]).toBe("REFUSED");
      expect(mismatchesOf(record)).toMatch(mismatch);
      const refused = harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.detail).toMatch(mismatch);
      expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_REFUSED")).toEqual([[V2_WINDOW.id]]);
      expect(subscribedTokens(harness)).not.toContain(V2_WINDOW.up);
      await harness.gateway.stop();
    });
  }

  it("acceptance 4: under the sample review (acceptedProtocolVersions [\"v1\"]) the V2 window is REFUSED, naming the reviewed list; the V1 window beside it is admitted", async () => {
    const harness = await startedUnder(v2Stub(), ["v1"]);
    expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
    expect(record?.["status"]).toBe("REFUSED");
    expect(mismatchesOf(record)).toMatch(/Market\.version is "v2", not one of the reviewed acceptedProtocolVersions \["v1"\]/u);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_REFUSED")).toEqual([[V2_WINDOW.id]]);
    await harness.gateway.stop();
  });

  it("acceptance 4: a review that accepts only v2 refuses the V1 window and admits the V2 one", async () => {
    const harness = await startedUnder(v2Stub(), ["v2"]);
    expect(admittedIds(harness)).toEqual([V2_WINDOW.id]);
    expect(ledger(harness.walFileSystem)[WINDOW_2230.conditionId]?.["status"]).toBe("REFUSED");
    await harness.gateway.stop();
  });

  it("acceptance 4: a review without acceptedProtocolVersions stops the gateway at its configuration door", async () => {
    const document = reviewedBtc15mSeriesDocument();
    const parameters = { ...(document["parameters"] as Record<string, unknown>) };
    delete parameters["acceptedProtocolVersions"];
    await expect(
      buildHarness({ config: admissionConfig({}, { ...document, parameters }), http: venueStub().route, clockStartMs: NOW_MS }),
    ).rejects.toThrow(GatewayConfigurationError);
  });
});

describe("V2-1 acceptance 5: a condition id of another width gets NO CLOB read and is refused by name (rule 3)", () => {
  for (const [name, conditionId] of [
    ["63 hex digits", `${PROTOCOL_V2_SAMPLES.canaryConditionId31}0`],
    ["65 hex digits", `${PROTOCOL_V2_SAMPLES.canaryConditionId32}0`],
    ["a short id", "0xab"],
  ] as const) {
    it(`${name}: no request, a REFUSED record naming rule 3, the incident, and the read budget kept for the next window`, async () => {
      const stub = v2Stub({ mutate: (market) => void (market["conditionId"] = conditionId) });
      const harness = await startedUnder(stub, ["v1", "v2"]);
      expect(stub.requests.filter((url) => url.startsWith(`${CLOB_BASE}/clob-markets/${conditionId.slice(0, 40)}`))).toEqual([]);
      const record = ledger(harness.walFileSystem)[conditionId];
      expect(record?.["status"]).toBe("REFUSED");
      expect(mismatchesOf(record)).toMatch(/is neither 31 bytes \(0x and 62 hex digits\) nor 32 bytes/u);
      expect(harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED")).toHaveLength(1);
      expect(harness.incidents.map((incident) => incident.reasonCode)).not.toContain("GATEWAY_SERIES_CLOB_READ_FAILED");
      expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
      await harness.gateway.stop();
    });
  }

  it("a 32-byte V1 id is sent unchanged (the recorded windows)", async () => {
    const stub = venueStub();
    const harness = await started(stub);
    expect(clobReadsOf(stub, WINDOW_2215.conditionId)).toBe(1);
    expect(clobReadsOf(stub, `${WINDOW_2215.conditionId}00`)).toBe(0);
    await harness.gateway.stop();
  });
});

describe("V2-1 acceptance 8: CLOB v is a labelled, refusal-only cross-check (C-21)", () => {
  it("present and equal (\"v2\" on the canary's body): admitted — the first test above", async () => {
    const harness = await startedUnder(v2Stub(), ["v1", "v2"]);
    expect(admittedIds(harness)).toContain(V2_WINDOW.id);
    await harness.gateway.stop();
  });

  it("present and different: REFUSED, naming both versions, with the incident", async () => {
    const harness = await startedUnder(v2Stub({ clobV2: { ...CLOB_V2, v: "v1" } }), ["v1", "v2"]);
    expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
    expect(record?.["status"]).toBe("REFUSED");
    expect(mismatchesOf(record)).toMatch(/cross-check: CLOB v \(undocumented, C-21\) is "v1", but Gamma Market\.version is "v2"/u);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_REFUSED")).toEqual([[V2_WINDOW.id]]);
    await harness.gateway.stop();
  });

  it("absent: refuses nothing", async () => {
    const body = { ...CLOB_V2 };
    delete body["v"];
    const harness = await startedUnder(v2Stub({ clobV2: body }), ["v1", "v2"]);
    expect(admittedIds(harness)).toEqual([V2_WINDOW.id, WINDOW_2230.id]);
    await harness.gateway.stop();
  });
});

describe("V2-1 (plan row A8): the collision check reads the ids the version selects, and only those", () => {
  it("a configured market holding a selected position id: the V2 window is skipped as known, with no CLOB read", async () => {
    const stub = v2Stub();
    const harness = await startedUnder(stub, ["v1", "v2"], { markets: [{ ...MARKET, gammaMarketId: "999", yesTokenId: V2_WINDOW.up }] });
    expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(0);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    expect(harness.gateway.metrics().seriesAdmission?.windowsSkippedKnown).toBeGreaterThanOrEqual(1);
    await harness.gateway.stop();
  });

  it("a configured market holding an id of the field the version does NOT select: not a collision, the V2 window is admitted", async () => {
    const stub = v2Stub({ mutate: (market) => void (market["clobTokenIds"] = JSON.stringify(OTHER_CTF_IDS)) });
    const harness = await startedUnder(stub, ["v1", "v2"], { markets: [{ ...MARKET, gammaMarketId: "999", yesTokenId: OTHER_CTF_IDS[0] }] });
    expect(admittedIds(harness)).toEqual([V2_WINDOW.id, WINDOW_2230.id]);
    await harness.gateway.stop();
  });
});

describe("V2-1 acceptance 7: the V1 admission output on series-window.json is byte-identical to af3a1c9's", () => {
  /**
   * The judge's verdicts on the twelve recorded windows, read through the
   * door, under the sample review — `acceptedProtocolVersions: ["v1"]` now —
   * and the review hash af3a1c9's sample review had (the hash is an INPUT of
   * the judge; the review's own hash changed with the added field, as ADR-030
   * Amendment 2 rule 2 item 3 says a review change does). The digests were
   * taken at af3a1c9 with the same code path.
   */
  const AF3A1C9_REVIEW_HASH = "2ec9d02c2ec78cb81a3f115db1c5e3c99ff43d137c41a0148204aa30346309f0";

  function verdictsDigest(clobFor: (index: number, market: Record<string, unknown>) => Record<string, unknown> | undefined): string {
    const parsed = parseReviewedSeries(reviewedBtc15mSeriesDocument());
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    const page = readGammaSeriesEventsBody(JSON.stringify(KEYSET_PAGE));
    if (page.status !== "ok") throw new Error("unreadable fixture");
    const verdicts = page.events.map((event, index) => {
      const market = (KEYSET_PAGE.events[index]?.["markets"] as Record<string, unknown>[])[0] ?? {};
      const body = clobFor(index, market);
      const clob = body === undefined ? undefined : readClobMarketInfoBody(JSON.stringify(body));
      if (clob !== undefined && clob.status !== "ok") throw new Error("unreadable CLOB body");
      return judgeSeriesWindow(parsed.series, AF3A1C9_REVIEW_HASH, event, clob?.reading);
    });
    return createHash("sha256").update(JSON.stringify(verdicts), "utf8").digest("hex");
  }

  it("the recorded reads (S-G03 with S-K03a and S-K04a): two admitted, ten refused for the missing read", () => {
    const recorded: Record<string, Record<string, unknown>> = { [WINDOW_2215.conditionId]: CLOB_2215, [WINDOW_2230.conditionId]: CLOB_2230 };
    expect(verdictsDigest((_index, market) => recorded[String(market["conditionId"])])).toBe(
      "49d98f225ec7126becad1481e3bc6c054bd5d586f8e839b8ed57633a557a1ba9",
    );
  });

  it("every window with its own CLOB body (S-K04a's shape): twelve admitted", () => {
    expect(
      verdictsDigest((_index, market) => {
        const [yes, no] = tradingIdsOf(market) as [string, string];
        return { ...CLOB_2230, t: [{ t: yes, o: "Up" }, { t: no, o: "Down" }], mts: market["orderPriceMinTickSize"], c: market["conditionId"] };
      }),
    ).toBe("65645da112e340d891697ffe1bbd4846e3ece1e82b325fc5766ce433b62f8752");
  });
});

// ---------------------------------------------------------------------------
// `V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06, the
// orchestrator's interim ruling for PAPER and BACKTEST; `V2-1`'s known risk
// V21-FABLE-03): ids not yet available. The window is the recorded 22:30
// window (open 22:30, close 22:45; due at 22:20 under the 900 s lead) as a V2
// market carrying the canary's condition and position ids (S-L01).
// ---------------------------------------------------------------------------

const V2_WINDOW_2230_ID = windowInternalMarketId(PROTOCOL_V2_SAMPLES.canaryConditionId31, Date.UTC(2026, 9, 4, 22, 30));

/** The page holding only the 22:30 window, as a V2 market whose `positionIds` is `state.positionIds` (`undefined`: absent). */
function v2Page2230(state: { positionIds: unknown; mutate?: (market: Record<string, unknown>) => void }): () => unknown {
  return () => {
    const page = structuredClone(KEYSET_PAGE);
    page.events = [page.events[1] as Record<string, unknown>];
    const market = ((page.events[0] as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    market["version"] = GAMMA_V2_EXAMPLE["version"];
    market["clobTokenIds"] = GAMMA_V2_EXAMPLE["clobTokenIds"];
    if (state.positionIds === undefined) delete market["positionIds"];
    else market["positionIds"] = state.positionIds;
    market["conditionId"] = V2_WINDOW.conditionId31;
    market["orderPriceMinTickSize"] = CLOB_V2["mts"];
    state.mutate?.(market);
    return page;
  };
}

function v2Stub2230(state: { positionIds: unknown; mutate?: (market: Record<string, unknown>) => void }) {
  return venueStub({ page: v2Page2230(state), clob: { [V2_WINDOW.conditionId32]: CLOB_V2 } });
}

function refusedIncidents(harness: Harness): readonly string[] {
  return harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_SERIES_WINDOW_REFUSED").map((incident) => incident.detail);
}

/** The three admission payloads of a window, as published, in order. */
function admissionPayloadsOf(harness: Harness, internalMarketId: string | undefined): readonly string[] {
  return harness
    .published()
    .filter((envelope) => ["MarketDiscovered", "TradingParametersChanged", "SeriesWindowAdmitted"].includes(envelope.eventType))
    .filter((envelope) => payloadOf(envelope)["internalMarketId"] === internalMarketId)
    .map((envelope) => `${envelope.eventType}:${JSON.stringify(envelope.payload)}`);
}

describe("V2-3 item 7: ids not yet available are not yet admissible — judged again until the window's open", () => {
  it("ids filled BEFORE the open admit the window: until then no record, no incident, judged at every poll; the admission is byte-identical to one with the ids at first sight", async () => {
    const state: { positionIds: unknown } = { positionIds: null };
    const stub = v2Stub2230(state);
    const harness = await startedUnder(stub, ["v1", "v2"]);
    // 22:20 (null), then 22:20:30 (absent): not yet admissible — nothing recorded, nothing raised.
    expect(admittedIds(harness)).toEqual([]);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    expect(refusedIncidents(harness)).toEqual([]);
    state.positionIds = undefined;
    await cycleAfter(harness, 0);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    expect(refusedIncidents(harness)).toEqual([]);
    // Judged at every poll: one CLOB read each, within the cycle's budget.
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(2);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ windowsNotYetAdmissible: 2, windowsRefused: 0, liveWindows: 0 });

    // 22:25:30, before the 22:30 open: the ids are filled — admitted at once.
    state.positionIds = [V2_WINDOW.up, V2_WINDOW.down];
    await cycleAfter(harness, 5 * 60_000);
    expect(admittedIds(harness)).toEqual([V2_WINDOW_2230_ID]);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toMatchObject({ status: "ADMITTED", admissionConfirmedAt: expect.any(String) });
    expect(subscribedTokens(harness)).toEqual(expect.arrayContaining([V2_WINDOW.up, V2_WINDOW.down]));

    // The control: the same window with its ids at first sight.
    const control = await startedUnder(v2Stub2230({ positionIds: [V2_WINDOW.up, V2_WINDOW.down] }), ["v1", "v2"]);
    expect(admissionPayloadsOf(harness, V2_WINDOW_2230_ID)).toEqual(admissionPayloadsOf(control, V2_WINDOW_2230_ID));
    expect(admissionPayloadsOf(control, V2_WINDOW_2230_ID)).toHaveLength(3);
    await control.gateway.stop();
    await harness.gateway.stop();
  });

  it("still null when judged at or after the open: REFUSED finally, with the existing incident naming the open; ids that arrive later admit nothing", async () => {
    const state: { positionIds: unknown } = { positionIds: null };
    const stub = v2Stub2230(state);
    const harness = await startedUnder(stub, ["v1", "v2"]);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    // 22:30:30: judged after its open, still null.
    await cycleAfter(harness, 10 * 60_000);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
    expect(record?.["status"]).toBe("REFUSED");
    expect(mismatchesOf(record)).toMatch(/Market\.positionIds, the field Market\.version "v2" selects, is null: the window's ids are not yet available \(F-40\)/u);
    expect(mismatchesOf(record)).toMatch(
      /not yet admissible until its scheduled open 2026-10-04T22:30:00\.000Z, and judged at 2026-10-04T22:30:30\.000Z: the selected id field was still absent or null when the window opened, so the refusal is final \(ADR-030 Amendment 2 rule 1, note of 2026-10-06\)/u,
    );
    expect(refusedIncidents(harness)).toHaveLength(1);
    expect(incidentsNamed(harness, "GATEWAY_SERIES_WINDOW_REFUSED")).toEqual([[V2_WINDOW_2230_ID]]);
    // Final: filled ids are never judged again.
    const reads = clobReadsOf(stub, V2_WINDOW.conditionId32);
    state.positionIds = [V2_WINDOW.up, V2_WINDOW.down];
    await cycleAfter(harness, 0);
    expect(admittedIds(harness)).toEqual([]);
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(reads);
    await harness.gateway.stop();
  });

  it("the open is the bound, on the read's receipt: judged one millisecond before it, not yet admissible; judged exactly AT it, refused", async () => {
    const early = await started(v2Stub2230({ positionIds: null }), {
      config: admissionConfig({}, reviewAccepting(["v1", "v2"])),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 29, 59, 999),
    });
    expect(ledger(early.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    expect(early.gateway.metrics().seriesAdmission?.windowsNotYetAdmissible).toBe(1);
    await early.gateway.stop();
    const atOpen = await started(v2Stub2230({ positionIds: null }), {
      config: admissionConfig({}, reviewAccepting(["v1", "v2"])),
      clockStartMs: Date.UTC(2026, 9, 4, 22, 30, 0, 0),
    });
    expect(ledger(atOpen.walFileSystem)[V2_WINDOW.conditionId31]?.["status"]).toBe("REFUSED");
    expect(mismatchesOf(ledger(atOpen.walFileSystem)[V2_WINDOW.conditionId31])).toMatch(/judged at 2026-10-04T22:30:00\.000Z/u);
    await atOpen.gateway.stop();
  });

  for (const [name, accepted, mutate, mismatch] of [
    [
      "a Gamma fee rate that differs, beside positionIds null",
      ["v1", "v2"],
      (market: Record<string, unknown>) => void ((market["feeSchedule"] as Record<string, unknown>)["rate"] = 0.08),
      /feeSchedule\.rate/u,
    ],
    ["positionIds as a JSON-encoded string (not an array)", ["v1", "v2"], (market: Record<string, unknown>) => void (market["positionIds"] = JSON.stringify([V2_WINDOW.up, V2_WINDOW.down])), /is not an array of decimal strings/u],
    ["one position id", ["v1", "v2"], (market: Record<string, unknown>) => void (market["positionIds"] = [V2_WINDOW.up]), /not exactly two position ids/u],
    ["an unknown version", ["v1", "v2"], (market: Record<string, unknown>) => void (market["version"] = "v3"), /not a supported protocol version/u],
    ["a version the review does not accept, beside positionIds null", ["v1"], () => undefined, /not one of the reviewed acceptedProtocolVersions \["v1"\]/u],
  ] as const) {
    it(`every other refusal stays FINAL, at once, before the open — ${name}`, async () => {
      const state = { positionIds: null as unknown, mutate };
      const stub = v2Stub2230(state);
      const harness = await startedUnder(stub, accepted);
      const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
      expect(record?.["status"]).toBe("REFUSED");
      expect(mismatchesOf(record)).toMatch(mismatch);
      expect(mismatchesOf(record)).not.toMatch(/not yet admissible until/u);
      expect(refusedIncidents(harness)).toHaveLength(1);
      expect(harness.gateway.metrics().seriesAdmission?.windowsNotYetAdmissible).toBe(0);
      // Never judged again, even once everything is right.
      const reads = clobReadsOf(stub, V2_WINDOW.conditionId32);
      state.positionIds = [V2_WINDOW.up, V2_WINDOW.down];
      state.mutate = () => undefined;
      await cycleAfter(harness, 0);
      expect(admittedIds(harness)).toEqual([]);
      expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(reads);
      await harness.gateway.stop();
    });
  }
});

describe("V2-3: two V2-1 LOWs pinned (V21-FABLE-01, V21-FABLE-02)", () => {
  it("V21-FABLE-01: a condition id of another width spends NO CLOB read budget — under a cap of 1, the next window is still read and admitted in the same cycle", async () => {
    const bad = `${PROTOCOL_V2_SAMPLES.canaryConditionId32}0`;
    const page = (): unknown => {
      const copy = structuredClone(KEYSET_PAGE);
      ((copy.events[0] as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0]!["conditionId"] = bad;
      return copy;
    };
    const stub = venueStub({ page });
    const harness = await started(stub, { config: admissionConfig({}, { ...reviewedBtc15mSeriesDocument(), maximumConcurrentWindows: 1 }) });
    // One cycle: the 63-byte id is refused with no read, and the cycle's one read goes to 22:30.
    expect(ledger(harness.walFileSystem)[bad]?.["status"]).toBe("REFUSED");
    expect(stub.requests.filter((url) => url.includes("/clob-markets/"))).toEqual([`${CLOB_BASE}/clob-markets/${WINDOW_2230.conditionId}`]);
    expect(admittedIds(harness)).toEqual([WINDOW_2230.id]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ windowsDeferredByReadBudget: 0, cycles: 1 });
    await harness.gateway.stop();
  });

  it("V21-FABLE-02 (a): when the selection FAILS, the collision check still reads the condition id — a known condition is skipped, with no read and no record", async () => {
    const stub = v2Stub({ mutate: (market) => void (market["version"] = "v3") });
    const harness = await startedUnder(stub, ["v1", "v2"], { markets: [{ ...MARKET, gammaMarketId: "999", conditionId: V2_WINDOW.conditionId31 }] });
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(0);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId31]).toBeUndefined();
    expect(harness.gateway.metrics().seriesAdmission?.windowsSkippedKnown).toBeGreaterThanOrEqual(1);
    await harness.gateway.stop();
  });

  it("V21-FABLE-02 (b): when the selection FAILS, the collision check reads NO ids — the other field's tokens never make it a collision; the judge refuses it by name", async () => {
    const stub = v2Stub({
      mutate: (market) => {
        market["version"] = "v3";
        market["clobTokenIds"] = JSON.stringify(OTHER_CTF_IDS);
      },
    });
    const harness = await startedUnder(stub, ["v1", "v2"], { markets: [{ ...MARKET, gammaMarketId: "999", yesTokenId: OTHER_CTF_IDS[0] }] });
    expect(clobReadsOf(stub, V2_WINDOW.conditionId32)).toBe(1);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId31];
    expect(record?.["status"]).toBe("REFUSED");
    expect(mismatchesOf(record)).toMatch(/Market\.version is "v3", not a supported protocol version/u);
    expect(harness.gateway.metrics().seriesAdmission?.windowsSkippedKnown).toBe(0);
    await harness.gateway.stop();
  });
});
