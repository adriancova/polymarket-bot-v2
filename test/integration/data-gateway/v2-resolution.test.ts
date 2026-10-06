/**
 * `V2-3` — the resolution of admitted windows through a journaled
 * `GET /v2/resolutions` read (ADR-030 Amendment 2, rules 3-5; rule 5 is the
 * orchestrator's interim ruling for PAPER and BACKTEST), end to end through
 * the real `DataGateway` on the repository's doubles: the recorded keyset page
 * and CLOB bodies of VENUE-SETL-1, VENUE-4's public V2 captures
 * (`test/fixtures/venue/protocol-v2/`, served byte for byte), a scripted
 * market socket, an in-memory WAL and transport. No socket, no network.
 *
 * What is proven, each against the base `51c0213` (which makes no
 * `/v2/resolutions` read at all):
 *
 * 1. **The read** — an admitted, confirmed window past its scheduled close
 *    with no resolution owed or published is read at its 32-byte condition
 *    (never the 31-byte form), once per cycle, from the first cycle past its
 *    close; never before it, never for an unconfirmed admission, never after
 *    a frame's resolution.
 * 2. **Journal before derive** — every response is in the WAL before anything
 *    is derived; the published `MarketResolved@1` cites it; a REPLAY of the
 *    WAL alone derives what the gateway derived.
 * 3. **Publishable** — the resolved V2 canary row (S-A11, verbatim) publishes
 *    `YES_WIN` with `resolvedAt` its `resolved_at` unchanged; a V1 window's
 *    `[0,1000000]` publishes `NO_WIN`; the window retires `RESOLVED`.
 * 4. **Pending, Failed, Refused** — a miss (`[]`, `null`), a pending row, an
 *    error status, a transport failure and a non-JSON body raise nothing of
 *    their own, and the bound's incident carries the latest read's result; a
 *    refused row (the collateral-unit `["1","0"]`, and every other kind)
 *    raises `GATEWAY_SERIES_WINDOW_UNRESOLVED` at once with the reason, ends
 *    the row path, and survives a restart (R2-OPUS-L2).
 * 5. **Two sources** — the first resolution stands; an agreeing late row is a
 *    harmless repeat (R2-OPUS-L1); a disagreement, in either order, publishes
 *    nothing from the row and is raised under a scope of its own that outlives
 *    the window's retirement; the market channel is never held back.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { ADMISSION_LEDGER_FILE_NAME, IncidentRegistry } from "@polymarket-bot/data-gateway";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem, type MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { RECORDED_WINDOW, reviewedBtc15mSeriesDocument } from "@polymarket-bot/universe/testing";
import { windowInternalMarketId } from "@polymarket-bot/universe";
import { afterEach, describe, expect, it, vi } from "vitest";

import { replayJournaledResolutionAnswer } from "../../../apps/data-gateway/src/feeds/resolution-check.js";

import { buildHarness, polymarketRestBook, type Harness } from "./support/harness.js";
import { recordedFrames, type RecordedFrame } from "./support/wal.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../contract/polymarket-public/fixtures/series-window.json"), "utf8"),
) as { readonly examples: readonly { readonly payload: unknown }[] };
const [KEYSET_PAGE, CLOB_2215] = fixture.examples.map((example) => example.payload) as [
  { events: Record<string, unknown>[]; next_cursor: string },
  Record<string, unknown>,
];
const captureText = (name: string): string => readFileSync(resolve(here, "../../fixtures/venue/protocol-v2", `${name}.jsonc`), "utf8");
const capture = (name: string): Record<string, unknown> => JSON.parse(captureText(name)) as Record<string, unknown>;

const GAMMA_BASE = "http://gamma.stub";
const CLOB_BASE = "http://clob.stub";
const DATA_BASE = "http://data.stub";
const FEED_ID = "polymarket-series-admission";
const LEDGER_PATH = `/wal/${ADMISSION_LEDGER_FILE_NAME}`;
/** 22:20: inside the recorded 22:15-22:30 window. */
const NOW_MS = Date.UTC(2026, 9, 4, 22, 20, 0);
const UNRESOLVED = "GATEWAY_SERIES_WINDOW_UNRESOLVED";

/** S-A11, served verbatim: the resolved V2 canary, `payouts` `[1000000,0]`, `resolved_at` 2026-10-05T21:35:56Z. */
const S_A11 = captureText("data-v2-resolutions-v2-resolved");
const S_A11_CONDITION_32 = "0x015ecdbafe90dfcb60b2f38afe44f4be85000000000000000000000000000000";
/** S-L04, served verbatim: an open V2 market, `status` `active`. Its own condition is another market's. */
const S_L04 = captureText("data-v2-resolutions-v2-active");
const CLOB_V2 = capture("clob-markets-v2");
const GAMMA_V2_EXAMPLE = capture("gamma-market-v2-docs-example");
const [V2_UP, V2_DOWN] = (CLOB_V2["t"] as { t: string }[]).map((token) => token.t) as [string, string];

interface Window {
  readonly conditionId: string;
  readonly padded: string;
  readonly yes: string;
  readonly no: string;
  readonly id: string;
}

/** The recorded 22:15 window (V1, a 32-byte condition sent unchanged). */
const V1_WINDOW: Window = {
  conditionId: RECORDED_WINDOW.conditionId,
  padded: RECORDED_WINDOW.conditionId,
  yes: RECORDED_WINDOW.yesTokenId,
  no: RECORDED_WINDOW.noTokenId,
  id: windowInternalMarketId(RECORDED_WINDOW.conditionId, Date.UTC(2026, 9, 4, 22, 15)) ?? "",
};

/**
 * The 22:15 window as a V2 market (the documented example's shape, F-40): the
 * resolved canary's condition (S-A11) in its 31-byte form (F-43) — Gamma's
 * text, the identity — with the observed canary's position ids (S-L01).
 */
const V2_WINDOW: Window = {
  conditionId: S_A11_CONDITION_32.slice(0, -2),
  padded: S_A11_CONDITION_32,
  yes: V2_UP,
  no: V2_DOWN,
  id: windowInternalMarketId(S_A11_CONDITION_32.slice(0, -2), Date.UTC(2026, 9, 4, 22, 15)) ?? "",
};

type ResolutionsRoute = (call: number, request: PublicHttpRequest) => PublicHttpResponse | Promise<PublicHttpResponse>;

interface Stub {
  readonly route: (request: PublicHttpRequest) => Promise<PublicHttpResponse>;
  readonly requests: string[];
  /** The `/v2/resolutions` URLs requested, in order. */
  resolutionReads(): readonly string[];
}

/** The stub venue: ONE window (the recorded 22:15 event, V1 or made V2), its CLOB body, a ready Gamma market, books, and `resolutions`. */
function venueStub(window: Window, resolutions: ResolutionsRoute): Stub {
  const requests: string[] = [];
  let calls = 0;
  const page = (): unknown => {
    const copy = structuredClone(KEYSET_PAGE);
    copy.events = [copy.events[0] as Record<string, unknown>];
    if (window === V2_WINDOW) {
      const market = ((copy.events[0] as Record<string, unknown>)["markets"] as Record<string, unknown>[])[0] as Record<string, unknown>;
      market["version"] = GAMMA_V2_EXAMPLE["version"];
      market["clobTokenIds"] = GAMMA_V2_EXAMPLE["clobTokenIds"];
      market["positionIds"] = [V2_UP, V2_DOWN];
      market["conditionId"] = V2_WINDOW.conditionId;
      market["orderPriceMinTickSize"] = CLOB_V2["mts"];
    }
    return copy;
  };
  const clob = window === V2_WINDOW ? CLOB_V2 : CLOB_2215;
  const route = async (request: PublicHttpRequest): Promise<PublicHttpResponse> => {
    requests.push(request.url);
    if (request.url.startsWith(`${DATA_BASE}/v2/resolutions`)) {
      calls += 1;
      return resolutions(calls, request);
    }
    if (request.url.startsWith(`${GAMMA_BASE}/events/keyset`)) return { status: 200, body: JSON.stringify(page()) };
    if (request.url === `${CLOB_BASE}/clob-markets/${window.padded}`) return { status: 200, body: JSON.stringify(clob) };
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify({ active: true, closed: false, archived: false, acceptingOrders: true }) };
    }
    if (request.url.includes("/books")) {
      const tokens = (request.jsonBody as readonly { token_id: string }[] | undefined) ?? [];
      return { status: 200, body: JSON.stringify(tokens.map((entry) => polymarketRestBook(entry.token_id, window.padded))) };
    }
    return { status: 404, body: "{}" };
  };
  return { route, requests, resolutionReads: () => requests.filter((url) => url.startsWith(`${DATA_BASE}/v2/resolutions`)) };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const document = reviewedBtc15mSeriesDocument();
  const series = {
    ...document,
    parameters: { ...(document["parameters"] as Record<string, unknown>), acceptedProtocolVersions: ["v1", "v2"] },
    unresolvedTeardownSeconds: 300,
  };
  return {
    markets: [],
    polymarket: { feedId: "polymarket-market", customFeatureEnabled: true, snapshotBaseUrl: CLOB_BASE },
    lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    seriesAdmission: {
      gammaBaseUrl: GAMMA_BASE,
      clobBaseUrl: CLOB_BASE,
      dataApiBaseUrl: DATA_BASE,
      pollIntervalMs: 30_000,
      maximumPages: 1,
      admissionLeadSeconds: 900,
      series: [series],
    },
    ...overrides,
  };
}

async function started(stub: Stub, extra: Parameters<typeof buildHarness>[0] = {}): Promise<Harness> {
  const harness = await buildHarness({ config: config(), http: stub.route, clockStartMs: NOW_MS, ...extra });
  harness.gateway.start();
  harness.polymarketSockets.current.open();
  await harness.settle();
  return harness;
}

/** One admission cycle after moving the clock `ms` forward. */
async function cycleAfter(harness: Harness, ms: number): Promise<void> {
  harness.clock.advance(ms);
  harness.timers.advance(30_000);
  await harness.settle();
}

/** To the first cycle past the 22:30 close: 22:30:30. */
async function pastClose(harness: Harness): Promise<void> {
  await cycleAfter(harness, 10 * 60_000);
}

function payloadOf(envelope: EventEnvelope<unknown> | undefined): Record<string, unknown> {
  return (envelope?.payload ?? {}) as Record<string, unknown>;
}

function resolutionsOf(harness: Harness, window: Window): readonly EventEnvelope<unknown>[] {
  return harness.publishedOfType("MarketResolved").filter((envelope) => payloadOf(envelope)["internalMarketId"] === window.id);
}

function unresolvedIncidents(harness: Harness): readonly { readonly detail: string; readonly ids: readonly string[] }[] {
  return harness
    .publishedOfType("DataQualityIncidentOpened")
    .filter((envelope) => payloadOf(envelope)["reasonCode"] === UNRESOLVED)
    .map((envelope) => ({ detail: String(payloadOf(envelope)["detail"]), ids: payloadOf(envelope)["affectedMarketIds"] as string[] }));
}

function ledger(fileSystem: MemoryFileSystem): Record<string, Record<string, unknown>> {
  const text = fileSystem.snapshot()[LEDGER_PATH];
  if (text === undefined) return {};
  return (JSON.parse(text) as { windows: Record<string, Record<string, unknown>> }).windows;
}

/** The journaled `/v2/resolutions` responses of an epoch, in order. */
function resolutionFrames(harness: Harness): readonly RecordedFrame[] {
  return recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch).filter((frame) => frame.endpoint.startsWith(`${DATA_BASE}/v2/resolutions?`));
}

function marketResolvedFrame(window: Window, winner: string, atMs: number): string {
  return JSON.stringify([
    {
      event_type: "market_resolved",
      id: "5255913",
      market: window.padded,
      assets_ids: [window.yes, window.no],
      winning_asset_id: winner,
      winning_outcome: winner === window.yes ? "Up" : "Down",
      timestamp: String(atMs),
    },
  ]);
}

const json = (body: unknown): PublicHttpResponse => ({ status: 200, body: JSON.stringify(body) });

/** A one-row body for `window`'s 32-byte condition. */
function row(window: Window, fields: Record<string, unknown>): PublicHttpResponse {
  return json({ data: [{ condition_id: window.padded, ...fields }] });
}

const RESOLVED_NO = (window: Window): PublicHttpResponse =>
  row(window, { status: "resolved", payouts: [0, 1_000_000], resolved_at: "2026-10-04T22:30:41Z" });
const RESOLVED_YES = (window: Window): PublicHttpResponse =>
  row(window, { status: "resolved", payouts: [1_000_000, 0], resolved_at: "2026-10-04T22:30:41Z" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V2-3 acceptance 1-3: the read, journal before derive, and a publishable row", () => {
  it("a V2 window past its close is read at its 32-byte condition; S-A11 (verbatim) publishes YES_WIN, resolvedAt unchanged, citing the journaled response; it retires RESOLVED and is read no more", async () => {
    const stub = venueStub(V2_WINDOW, () => ({ status: 200, body: S_A11 }));
    const harness = await started(stub);
    expect(harness.publishedOfType("SeriesWindowAdmitted").map((envelope) => payloadOf(envelope)["internalMarketId"])).toEqual([V2_WINDOW.id]);
    // 22:20-22:30: the window is open — no read (rule 4 item 1: past its scheduled close only).
    await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toEqual([]);

    await pastClose(harness);
    // One read, at the 32-byte form — never the 31-byte form (F-70: a 400).
    expect(stub.resolutionReads()).toEqual([`${DATA_BASE}/v2/resolutions?condition=${V2_WINDOW.padded}`]);
    const resolved = resolutionsOf(harness, V2_WINDOW);
    expect(resolved).toHaveLength(1);
    expect(payloadOf(resolved[0])).toEqual({
      internalMarketId: V2_WINDOW.id,
      conditionId: V2_WINDOW.conditionId,
      outcome: "YES_WIN",
      resolvedAt: "2026-10-05T21:35:56Z",
    });
    expect(resolved[0]?.sourceChannel).toBe("polymarket:data-api-resolutions-rest");
    expect(resolved[0]?.source).toBe("polymarket");

    // Journaled BEFORE derived: the cited raw frame is the response, byte for
    // byte, with its status, and its ingestSeq precedes the event's.
    const frames = resolutionFrames(harness);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.endpoint).toBe(`${DATA_BASE}/v2/resolutions?condition=${V2_WINDOW.padded}#http-status=200`);
    expect(frames[0]?.payloadUtf8).toBe(S_A11);
    expect(resolved[0]?.causationId).toBe(`raw:${harness.gateway.gatewayEpoch}:${frames[0]?.ingestSeq ?? ""}`);
    expect(BigInt(frames[0]?.ingestSeq ?? "0")).toBeLessThan(BigInt(resolved[0]?.ingestSeq ?? "0"));

    // Recorded, owed and discharged like a frame's; the next cycle retires it RESOLVED and unsubscribes it.
    await cycleAfter(harness, 0);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId];
    expect(record).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect((record?.["resolution"] as Record<string, unknown>)["payload"]).toEqual(payloadOf(resolved[0]));
    expect((record?.["resolution"] as Record<string, unknown>)["rawFrame"]).toEqual({ gatewayEpoch: harness.gateway.gatewayEpoch, ingestSeq: frames[0]?.ingestSeq });
    // Its row path ended: never read again, however many cycles pass.
    for (let index = 0; index < 3; index += 1) await cycleAfter(harness, 60_000);
    expect(stub.resolutionReads()).toHaveLength(1);
    expect(resolutionsOf(harness, V2_WINDOW)).toHaveLength(1);
    expect(unresolvedIncidents(harness)).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionReads: 1, resolutionRowsPublished: 1, windowsRetiredResolved: 1, liveWindows: 0 });
    await harness.gateway.stop();
  });

  it("a V1 window: rule 5 applies alike; [0,1000000] is NO_WIN by index (index 0 is YES, F-40), its 32-byte id sent unchanged", async () => {
    const stub = venueStub(V1_WINDOW, () => RESOLVED_NO(V1_WINDOW));
    const harness = await started(stub);
    await pastClose(harness);
    expect(stub.resolutionReads()).toEqual([`${DATA_BASE}/v2/resolutions?condition=${V1_WINDOW.conditionId}`]);
    expect(resolutionsOf(harness, V1_WINDOW).map(payloadOf)).toEqual([
      { internalMarketId: V1_WINDOW.id, conditionId: V1_WINDOW.conditionId, outcome: "NO_WIN", resolvedAt: "2026-10-04T22:30:41Z" },
    ]);
    await harness.gateway.stop();
  });

  it("an unconfirmed admission (publication halted) is never read: no consumer knows the window", async () => {
    const stub = venueStub(V1_WINDOW, () => RESOLVED_YES(V1_WINDOW));
    const harness = await started(stub, { startupTransportFailure: "redis down" });
    expect(ledger(harness.walFileSystem)[V1_WINDOW.conditionId]?.["admissionConfirmedAt"]).toBeUndefined();
    await pastClose(harness);
    await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toEqual([]);
    await harness.gateway.stop();
  });

  it("REPLAY: every journaled response re-derives, from the WAL alone, what the gateway derived — the venue is never asked", async () => {
    const answers: PublicHttpResponse[] = [
      json({ data: [] }),
      json({ data: null }),
      row(V1_WINDOW, { status: "proposed" }),
      { status: 503, body: '{"error":"busy"}' },
      { status: 200, body: "<html>" },
      RESOLVED_YES(V1_WINDOW),
    ];
    const stub = venueStub(V1_WINDOW, (call) => answers[call - 1] ?? json({ data: [] }));
    const harness = await started(stub);
    await pastClose(harness);
    for (let index = 0; index < 6; index += 1) await cycleAfter(harness, 0);
    const frames = resolutionFrames(harness);
    expect(frames.map((frame) => frame.payloadUtf8)).toEqual(answers.map((answer) => answer.body));
    const replayed = frames.map((frame) => replayJournaledResolutionAnswer(frame));
    expect(replayed.map((entry) => entry?.finding.kind)).toEqual(["PENDING", "PENDING", "PENDING", "FAILED", "FAILED", "PUBLISHABLE"]);
    expect(replayed.every((entry) => entry?.paddedConditionId === V1_WINDOW.padded)).toBe(true);
    // The publishable replay is the published resolution, and it is the frame the event cites.
    const published = resolutionsOf(harness, V1_WINDOW);
    expect(published).toHaveLength(1);
    const last = replayed.at(-1)?.finding;
    expect(last?.kind === "PUBLISHABLE" ? { outcome: last.outcome, resolvedAt: last.resolvedAt } : undefined).toEqual({
      outcome: payloadOf(published[0])["outcome"],
      resolvedAt: payloadOf(published[0])["resolvedAt"],
    });
    expect(published[0]?.causationId).toBe(`raw:${harness.gateway.gatewayEpoch}:${frames.at(-1)?.ingestSeq ?? ""}`);
    // Nothing else was derived from the five others: no incident, no resolution.
    expect(unresolvedIncidents(harness)).toEqual([]);
    await harness.gateway.stop();
  });
});

describe("V2-3 acceptance 4: pending, failed and refused reads", () => {
  it("Pending — {\"data\": []}, {\"data\": null} (R2-OPUS-L3), S-L04's active row — raises nothing, and is read again every cycle until a resolved row publishes", async () => {
    // S-L04's row is another market's: re-keyed to this window's condition, otherwise as captured.
    const active = { ...((JSON.parse(S_L04) as { data: Record<string, unknown>[] }).data[0] ?? {}), condition_id: V2_WINDOW.padded };
    const answers: PublicHttpResponse[] = [json({ data: [] }), json({ data: null }), json({ data: [active] }), RESOLVED_YES(V2_WINDOW)];
    const stub = venueStub(V2_WINDOW, (call) => answers[call - 1] ?? json({ data: [] }));
    const harness = await started(stub);
    await pastClose(harness);
    for (let index = 0; index < 2; index += 1) await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toHaveLength(3);
    expect(resolutionsOf(harness, V2_WINDOW)).toEqual([]);
    expect(unresolvedIncidents(harness)).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionReadsPending: 3, resolutionRowsRefused: 0 });
    await cycleAfter(harness, 0);
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["YES_WIN"]);
    expect(unresolvedIncidents(harness)).toEqual([]);
    await harness.gateway.stop();
  });

  it("a row still pending at the bound: GATEWAY_SERIES_WINDOW_UNRESOLVED opens then, once, carrying the latest read's result", async () => {
    const stub = venueStub(V2_WINDOW, () => row(V2_WINDOW, { status: "proposed" }));
    const harness = await started(stub);
    await pastClose(harness);
    await cycleAfter(harness, 0);
    expect(unresolvedIncidents(harness)).toEqual([]);
    // 22:35:31: past the 300 s bound.
    await cycleAfter(harness, 4 * 60_000);
    const incidents = unresolvedIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.ids).toEqual([V2_WINDOW.id]);
    expect(incidents[0]?.detail).toMatch(/The latest \/v2\/resolutions read \(at 2026-10-04T22:3\d:\d\d\.000Z, journaled as ingestSeq \d+\) was PENDING: the row's status is "proposed", not "resolved"/u);
    await cycleAfter(harness, 0);
    expect(unresolvedIncidents(harness)).toHaveLength(1);
    // Still read, once per cycle (rule 5, "Polling and the incident", item 1): four cycles past the close, four reads.
    expect(stub.resolutionReads()).toHaveLength(4);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionReads: 4, resolutionReadsPending: 4, windowsAwaitingResolution: 1 });
    await harness.gateway.stop();
  });

  it("Failed — an error status, a transport failure, a non-JSON body — raises nothing of its own; the bound's incident carries the latest failure", async () => {
    const stub = venueStub(V2_WINDOW, (call) => {
      if (call === 1) return { status: 503, body: '{"error":"overloaded","retryable":true}' };
      if (call === 2) throw new Error("ECONNRESET");
      return { status: 200, body: "<html>bad gateway</html>" };
    });
    const harness = await started(stub);
    await pastClose(harness);
    await cycleAfter(harness, 0);
    await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toHaveLength(3);
    expect(unresolvedIncidents(harness)).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionReadsFailed: 3, resolutionRowsRefused: 0 });
    // The 503 and the non-JSON body are journaled; the transport failure received nothing.
    expect(resolutionFrames(harness).map((frame) => frame.endpoint.split("#")[1])).toEqual(["http-status=503", "http-status=200"]);
    // A failed read is not a keyset failure: the admission feed raises no stall for it.
    expect(harness.incidents.filter((incident) => incident.feedId === FEED_ID).map((incident) => incident.reasonCode)).not.toContain("GATEWAY_FEED_STALL");
    expect(harness.gateway.metrics().seriesAdmission?.consecutiveFailures).toBe(0);
    await cycleAfter(harness, 4 * 60_000);
    expect(unresolvedIncidents(harness)).toHaveLength(1);
    expect(unresolvedIncidents(harness)[0]?.detail).toMatch(/was FAILED: the body is not JSON/u);
    await harness.gateway.stop();
  });

  it("Refused — the SDK's collateral-unit tuple [\"1\",\"0\"] (F-78): the incident AT ONCE, before the bound, with the reason; nothing published, never read as YES_WIN; the row path ends, in the ledger too", async () => {
    const stub = venueStub(V2_WINDOW, () => ({
      status: 200,
      body: `{"data":[{"condition_id":"${V2_WINDOW.padded}","status":"resolved","payouts":["1","0"],"resolved_at":"2026-10-04T22:30:41Z"}]}`,
    }));
    const harness = await started(stub);
    await pastClose(harness);
    expect(resolutionsOf(harness, V2_WINDOW)).toEqual([]);
    const incidents = unresolvedIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.ids).toEqual([V2_WINDOW.id]);
    expect(incidents[0]?.detail).toMatch(/its \/v2\/resolutions row was REFUSED \(journaled as ingestSeq \d+\) — payouts \["1","0"\] carries strings, not the wire's integer micro-USDC per share/u);
    expect(incidents[0]?.detail).toMatch(/Its row path has ended: no more reads, and no row publishes its resolution/u);
    expect(incidents[0]?.detail).toMatch(/recorded in the admission ledger, so a restart does not read this window again/u);
    // Before the bound (22:35): it is 22:30:30.
    expect(harness.clock.nowMs()).toBeLessThan(Date.UTC(2026, 9, 4, 22, 35));
    // The marker, in the existing ledger's own namespace.
    expect(ledger(harness.walFileSystem)[`resolution-row-refused:${V2_WINDOW.conditionId}`]).toMatchObject({ status: "REFUSED", closeAt: "2026-10-04T22:30:00.000Z" });
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId]?.["status"]).toBe("ADMITTED");
    // No more reads; the window stays in its slot, and the bound adds no second incident.
    for (let index = 0; index < 12; index += 1) await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toHaveLength(1);
    expect(unresolvedIncidents(harness)).toHaveLength(1);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionRowsRefused: 1, liveWindows: 1, resolutionRowPathsEnded: 1 });
    await harness.gateway.stop();
  });

  for (const [name, answer, reason] of [
    ["two rows", json({ data: [{ condition_id: V2_WINDOW.padded, status: "active" }, { condition_id: V2_WINDOW.padded, status: "active" }] }), /carries 2 rows/u],
    ["a row for another condition", { status: 200, body: S_L04 }, /the row is for condition "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000", not the window's/u],
    ["a split payout", row(V2_WINDOW, { status: "resolved", payouts: [500_000, 500_000], resolved_at: "2026-10-04T22:30:41Z" }), /a split payout/u],
    ["[1,0]", row(V2_WINDOW, { status: "resolved", payouts: [1, 0], resolved_at: "2026-10-04T22:30:41Z" }), /payouts \[1,0\] is neither/u],
    ["[1000000,0,0]", row(V2_WINDOW, { status: "resolved", payouts: [1_000_000, 0, 0], resolved_at: "2026-10-04T22:30:41Z" }), /payouts \[1000000,0,0\] is neither/u],
    ["no payouts", row(V2_WINDOW, { status: "resolved", resolved_at: "2026-10-04T22:30:41Z" }), /payouts are absent/u],
    ["no resolved_at", row(V2_WINDOW, { status: "resolved", payouts: [1_000_000, 0] }), /resolved_at is absent, and MarketResolved\.resolvedAt has no substitute/u],
    ["a malformed resolved_at", row(V2_WINDOW, { status: "resolved", payouts: [1_000_000, 0], resolved_at: "2026-10-04 22:30" }), /is not a well-formed instant/u],
    ["a status outside F-57", row(V2_WINDOW, { status: "Resolved", payouts: [1_000_000, 0], resolved_at: "2026-10-04T22:30:41Z" }), /outside F-57's list/u],
    ["no data list", json({ rows: [] }), /no data member/u],
  ] as const) {
    it(`Refused — ${name}: the incident at once, naming it; nothing published; no second read`, async () => {
      const stub = venueStub(V2_WINDOW, () => answer);
      const harness = await started(stub);
      await pastClose(harness);
      await cycleAfter(harness, 0);
      expect(resolutionsOf(harness, V2_WINDOW)).toEqual([]);
      const incidents = unresolvedIncidents(harness);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.detail).toMatch(reason);
      expect(stub.resolutionReads()).toHaveLength(1);
      await harness.gateway.stop();
    });
  }

  it("a refusal AFTER the bound is still raised with its reason: the bound's incident is closed and a fresh one names the refusal", async () => {
    const stub = venueStub(V2_WINDOW, (call) => (call < 3 ? row(V2_WINDOW, { status: "challenged" }) : row(V2_WINDOW, { status: "resolved", payouts: [500_000, 500_000], resolved_at: "2026-10-04T22:30:41Z" })));
    const harness = await started(stub);
    await pastClose(harness);
    await cycleAfter(harness, 5 * 60_000); // 22:36: the bound passed; the second read, still pending
    expect(unresolvedIncidents(harness).map((incident) => incident.detail)).toEqual([expect.stringMatching(/was PENDING/u)]);
    await cycleAfter(harness, 0); // the third read: refused
    const incidents = unresolvedIncidents(harness);
    expect(incidents).toHaveLength(2);
    expect(incidents[1]?.detail).toMatch(/row was REFUSED .* a split payout/u);
    expect(incidents[1]?.ids).toEqual([V2_WINDOW.id]);
    await harness.gateway.stop();
  });

  it("R2-OPUS-L2: the refusal SURVIVES a restart — the next epoch never reads the window, and its bound incident says the row path ended", async () => {
    const refused = venueStub(V2_WINDOW, () => row(V2_WINDOW, { status: "resolved", payouts: [500_000, 500_000], resolved_at: "2026-10-04T22:30:41Z" }));
    const first = await started(refused);
    await pastClose(first);
    expect(refused.resolutionReads()).toHaveLength(1);
    await first.gateway.stop();

    // A new epoch at 22:33, on the same disk; the venue would now serve a qualifying row.
    const qualifying = venueStub(V2_WINDOW, () => RESOLVED_YES(V2_WINDOW));
    const restarted = await started(qualifying, { walFileSystem: first.walFileSystem, idSeed: 1, clockStartMs: Date.UTC(2026, 9, 4, 22, 33) });
    for (let index = 0; index < 4; index += 1) await cycleAfter(restarted, 60_000);
    expect(qualifying.resolutionReads()).toEqual([]);
    expect(resolutionsOf(restarted, V2_WINDOW)).toEqual([]);
    expect(restarted.gateway.metrics().seriesAdmission).toMatchObject({ resolutionRowPathsEnded: 1, liveWindows: 1 });
    const incidents = unresolvedIncidents(restarted);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.detail).toMatch(/row path has ENDED, so no row will publish its resolution: its row was refused by an earlier gateway epoch, at 2026-10-04T22:30:30\.000Z: .*a split payout/u);
    // The market channel still may publish (rule 5 item 4): its frame retires the window.
    restarted.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, restarted.clock.nowMs()));
    await restarted.settle();
    await cycleAfter(restarted, 0);
    expect(ledger(restarted.walFileSystem)[V2_WINDOW.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    await restarted.gateway.stop();
  });
});

describe("V2-3 acceptance 5: two sources — the first stands; a disagreement in either order is raised under its own scope", () => {
  function registrySpies() {
    const opened = vi.spyOn(IncidentRegistry.prototype, "open");
    const closed = vi.spyOn(IncidentRegistry.prototype, "markClosed");
    return {
      registry: (): IncidentRegistry => opened.mock.contexts[0] as IncidentRegistry,
      closedScopes: (): readonly string[] => closed.mock.calls.filter((call) => call[1] === UNRESOLVED).map((call) => call[0]),
    };
  }

  it("a frame observed BEFORE the close is the resolution: no row is ever read", async () => {
    const stub = venueStub(V2_WINDOW, () => RESOLVED_NO(V2_WINDOW));
    const harness = await started(stub);
    harness.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, harness.clock.nowMs()));
    await harness.settle();
    await pastClose(harness);
    await cycleAfter(harness, 0);
    expect(stub.resolutionReads()).toEqual([]);
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["YES_WIN"]);
    await harness.gateway.stop();
  });

  it("R2-OPUS-L1: a frame observed while the row is read, and the row AGREES — a harmless repeat: one MarketResolved, no incident", async () => {
    const ref: { harness?: Harness } = {};
    const stub = venueStub(V2_WINDOW, () => {
      ref.harness?.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, ref.harness.clock.nowMs()));
      return RESOLVED_YES(V2_WINDOW);
    });
    const harness = await started(stub);
    ref.harness = harness;
    await pastClose(harness);
    await cycleAfter(harness, 0);
    const resolved = resolutionsOf(harness, V2_WINDOW);
    expect(resolved.map((envelope) => [envelope.sourceChannel, payloadOf(envelope)["outcome"]])).toEqual([[expect.not.stringMatching(/data-api/u), "YES_WIN"]]);
    expect(unresolvedIncidents(harness)).toEqual([]);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionRowsRepeated: 1, resolutionRowsPublished: 0, resolutionDisagreements: 0, windowsRetiredResolved: 1 });
    await harness.gateway.stop();
  });

  it("frame first, then a row that DISAGREES: nothing is published from the row; the incident names both outcomes and both sources, under its own scope, which the window's retirement does NOT close", async () => {
    const spies = registrySpies();
    const ref: { harness?: Harness } = {};
    const stub = venueStub(V2_WINDOW, () => {
      ref.harness?.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, ref.harness.clock.nowMs()));
      return RESOLVED_NO(V2_WINDOW);
    });
    const harness = await started(stub);
    ref.harness = harness;
    await pastClose(harness);
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["YES_WIN"]);
    const incidents = unresolvedIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.ids).toEqual([V2_WINDOW.id]);
    expect(incidents[0]?.detail).toMatch(/two resolutions that DISAGREE .*: YES_WIN from the market channel's market_resolved .*observed first, and NO_WIN from the \/v2\/resolutions row \(journaled as ingestSeq \d+\), resolved_at 2026-10-04T22:30:41Z, read second — nothing is published from it/u);
    // The window retires on its first (published) resolution …
    await cycleAfter(harness, 0);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect((ledger(harness.walFileSystem)[V2_WINDOW.conditionId]?.["resolution"] as Record<string, Record<string, unknown>>)["payload"]?.["outcome"]).toBe("YES_WIN");
    // … which closes the window's OWN unresolved scope, never the disagreement's: it outlives the retirement.
    const own = `${FEED_ID}:${V2_WINDOW.id}`;
    const disagreement = `${FEED_ID}:${V2_WINDOW.id}:resolution-disagreement`;
    expect(spies.closedScopes()).toContain(own);
    expect(spies.closedScopes()).not.toContain(disagreement);
    expect(spies.registry().isOpen(disagreement, UNRESOLVED)).toBe(true);
    expect(harness.gateway.metrics().seriesAdmission).toMatchObject({ resolutionDisagreements: 1, resolutionRowsPublished: 0 });
    await harness.gateway.stop();
  });

  it("row first, then a frame that DISAGREES: the frame is still published (never held back), the row's resolution stands, and the disagreement is raised under its own scope — which outlives the retirement", async () => {
    const spies = registrySpies();
    const stub = venueStub(V2_WINDOW, () => RESOLVED_NO(V2_WINDOW));
    const harness = await started(stub);
    await pastClose(harness);
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["NO_WIN"]);
    harness.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, harness.clock.nowMs()));
    await harness.settle();
    // The market channel is never held back: its frame reached the stream, after the row's.
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["NO_WIN", "YES_WIN"]);
    const incidents = unresolvedIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.detail).toMatch(/NO_WIN from the \/v2\/resolutions row .*published first, and YES_WIN from the market channel's market_resolved .*observed second and published as received/u);
    await cycleAfter(harness, 0);
    const record = ledger(harness.walFileSystem)[V2_WINDOW.conditionId];
    expect(record).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect((record?.["resolution"] as Record<string, Record<string, unknown>>)["payload"]?.["outcome"]).toBe("NO_WIN");
    expect(spies.closedScopes()).not.toContain(`${FEED_ID}:${V2_WINDOW.id}:resolution-disagreement`);
    expect(spies.registry().isOpen(`${FEED_ID}:${V2_WINDOW.id}:resolution-disagreement`, UNRESOLVED)).toBe(true);
    await harness.gateway.stop();
  });

  it("the FIRST published resolution stands in memory too: with every discharge write failing, the retirement carries the row's resolution, never a later disagreeing frame's", async () => {
    const walFileSystem = createMemoryFileSystem();
    const writeWholeFile = walFileSystem.writeWholeFile.bind(walFileSystem);
    // Refuse exactly the ledger writes that DISCHARGE the window's resolution while it is live:
    // the record keeps it owed, and teardown retires on the in-memory publication (ROLLOVER-1 r3).
    walFileSystem.writeWholeFile = async (path: string, bytes: Uint8Array): Promise<void> => {
      if (path === LEDGER_PATH) {
        const record = (JSON.parse(Buffer.from(bytes).toString("utf8")) as { windows: Record<string, Record<string, unknown>> }).windows[V2_WINDOW.conditionId];
        if (record?.["status"] === "ADMITTED" && (record["resolution"] as Record<string, unknown> | undefined)?.["publishedAt"] !== undefined) {
          throw new Error("injected: the discharge cannot be written");
        }
      }
      await writeWholeFile(path, bytes);
    };
    const stub = venueStub(V2_WINDOW, () => RESOLVED_NO(V2_WINDOW));
    const harness = await started(stub, { walFileSystem });
    await pastClose(harness);
    harness.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, harness.clock.nowMs()));
    await harness.settle();
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["NO_WIN", "YES_WIN"]);
    expect(harness.gateway.metrics().seriesAdmission?.ledgerWriteFailures).toBeGreaterThanOrEqual(1);
    await cycleAfter(harness, 0);
    const record = ledger(walFileSystem)[V2_WINDOW.conditionId];
    expect(record).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    expect((record?.["resolution"] as Record<string, Record<string, unknown>>)["payload"]?.["outcome"]).toBe("NO_WIN");
    await harness.gateway.stop();
  });

  it("row first, then a frame that AGREES: a repeat — published as received, no incident", async () => {
    const stub = venueStub(V2_WINDOW, () => RESOLVED_YES(V2_WINDOW));
    const harness = await started(stub);
    await pastClose(harness);
    harness.polymarketSockets.current.message(marketResolvedFrame(V2_WINDOW, V2_WINDOW.yes, harness.clock.nowMs()));
    await harness.settle();
    expect(resolutionsOf(harness, V2_WINDOW).map((envelope) => payloadOf(envelope)["outcome"])).toEqual(["YES_WIN", "YES_WIN"]);
    expect(unresolvedIncidents(harness)).toEqual([]);
    await cycleAfter(harness, 0);
    expect(ledger(harness.walFileSystem)[V2_WINDOW.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    await harness.gateway.stop();
  });

  it("a row-published resolution a publication halt left OWED is kept, re-published unchanged by the next epoch, and the window is never read again", async () => {
    const stub = venueStub(V2_WINDOW, () => RESOLVED_NO(V2_WINDOW));
    const first = await started(stub);
    // The event bus becomes unavailable after the admission: the row's resolution is dispatched, never published.
    first.transport.setUnavailable(true);
    await pastClose(first);
    const owed = ledger(first.walFileSystem)[V2_WINDOW.conditionId]?.["resolution"] as Record<string, unknown> | undefined;
    expect(owed?.["payload"]).toEqual({ internalMarketId: V2_WINDOW.id, conditionId: V2_WINDOW.conditionId, outcome: "NO_WIN", resolvedAt: "2026-10-04T22:30:41Z" });
    expect(owed?.["publishedAt"]).toBeUndefined();
    expect(first.incidents.map((incident) => incident.reasonCode)).toContain("GATEWAY_SERIES_RESOLUTION_UNPUBLISHED");
    await cycleAfter(first, 0);
    expect(stub.resolutionReads()).toHaveLength(1); // owed: the row path is over
    await first.gateway.stop();

    const again = venueStub(V2_WINDOW, () => RESOLVED_YES(V2_WINDOW));
    const restarted = await started(again, { walFileSystem: first.walFileSystem, idSeed: 1, clockStartMs: Date.UTC(2026, 9, 4, 22, 32) });
    expect(resolutionsOf(restarted, V2_WINDOW).map(payloadOf)).toEqual([owed?.["payload"]]);
    await cycleAfter(restarted, 0);
    expect(again.resolutionReads()).toEqual([]);
    expect(ledger(restarted.walFileSystem)[V2_WINDOW.conditionId]).toMatchObject({ status: "RETIRED", retiredReason: "RESOLVED" });
    await restarted.gateway.stop();
  });
});
