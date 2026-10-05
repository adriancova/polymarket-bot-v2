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
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { ADMISSION_LEDGER_FILE_NAME, GatewayConfigurationError, incidentReferenceId } from "@polymarket-bot/data-gateway";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem, type MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { reviewedBtc15mSeriesDocument, RECORDED_WINDOW } from "@polymarket-bot/universe/testing";
import { windowInternalMarketId } from "@polymarket-bot/universe";
import { describe, expect, it } from "vitest";

import { buildHarness, polymarketRestBook, type Harness } from "./support/harness.js";
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

/** Every recorded window's token → its condition id, for the CLOB book stub. */
const CONDITION_OF_TOKEN = new Map<string, string>(
  KEYSET_PAGE.events.flatMap((event) => {
    const market = (event["markets"] as Record<string, unknown>[])[0] ?? {};
    const tokens = JSON.parse(String(market["clobTokenIds"])) as string[];
    return tokens.map((token): [string, string] => [token, String(market["conditionId"])]);
  }),
);

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

function subscribedTokens(harness: Harness): readonly string[] {
  return harness.polymarketSockets.sockets.flatMap((socket) =>
    socket.sent.flatMap((frame) => {
      const parsed = JSON.parse(frame) as { assets_ids?: string[]; operation?: string };
      return parsed.operation === "unsubscribe" ? [] : (parsed.assets_ids ?? []);
    }),
  );
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
    const thirdTokens = JSON.parse(String(thirdMarket["clobTokenIds"])) as [string, string];
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
  const [yes, no] = JSON.parse(String(market["clobTokenIds"])) as [string, string];
  return { conditionId: String(market["conditionId"]), yes, no, openMs: Date.parse(String(market["eventStartTime"])) };
}

/** S-K04a's CLOB shape with the window's own condition and tokens (the r0 cap test's convention). */
function clobBodyFor(index: number): Record<string, unknown> {
  const window = recordedEvent(index);
  return { ...CLOB_2230, c: window.conditionId, t: [{ t: window.yes, o: "Up" }, { t: window.no, o: "Down" }] };
}

function unsubscribedTokens(harness: Harness): readonly string[] {
  return harness.polymarketSockets.sockets.flatMap((socket) =>
    socket.sent.flatMap((frame) => {
      const parsed = JSON.parse(frame) as { assets_ids?: string[]; operation?: string };
      return parsed.operation === "unsubscribe" ? (parsed.assets_ids ?? []) : [];
    }),
  );
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
