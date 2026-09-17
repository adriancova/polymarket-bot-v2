/**
 * UNIV-4 — the market lifecycle producer (closeout blocker B10): acceptance
 * (a), and the pin that FLIPPED.
 *
 * At base `df1b346` this file asserted the absence: a configured OPEN market
 * with a trade-ready venue never produced `MarketOpened` / `MarketClosing`,
 * and nothing consulted the documented polled surface (`8937f69`). The round
 * added the lifecycle feed; the first test below is that pin inverted.
 *
 * What is proven, against a stub of the documented `GET /markets/{id}`
 * surface (D-30) on the gateway's injected HTTP port — the repository's
 * established REST double; no socket, no network:
 *
 * 1. The pin, flipped: not-ready → ready → (closeTime reached) → closed
 *    across polls produces EXACTLY one `MarketOpened`, then the scheduled
 *    `MarketClosing` (`closesAt = closeTime`, emitted by the first poll at or
 *    past `closeTime` — NOT at the open, which would put the trader into
 *    `CLOSE_ONLY` before it could enter), then the observed `MarketClosing`
 *    (`closesAt` = the poll's receipt instant), in that sequence; every raw
 *    response was journaled BEFORE its derived events (acceptance 1's three
 *    assertions: publish-time WAL count, ingestSeq order, `causationId`);
 *    the not-ready poll and the ready-before-closeTime poll emitted nothing;
 *    the closed market is not polled again.
 * 2. Restart mid-run, `openedAt` from configuration: the second epoch emits
 *    no second `MarketOpened`; the one emitted carries the configured
 *    `openTime`; the universe fold accepts the two epochs' events in order,
 *    accepts a same-instant replay as idempotent and REFUSES a fresh instant.
 * 3. Restart mid-run, `openedAt` from the first observation (no `openTime`):
 *    the ledger under the WAL root holds the instant; the second epoch emits
 *    no second `MarketOpened`; the fold proof as in 2. (Mutation reported in
 *    `docs/handoffs/UNIV-4.md`: with the ledger read removed, 2 and 3 fail
 *    with a second `MarketOpened` in the second epoch.)
 * 4. The rules' other cells: R5 contradiction (closed before ever open →
 *    incident, nothing derived, not polled again); R6 (readiness lost through
 *    `active`/`archived` alone → incident, nothing derived); ready before the
 *    configured `openTime` → observation instant; no `closeTime` → no
 *    scheduled closing; `restricted` recorded, not acted on.
 * 5. Failure paths: transport error, non-2xx and an undocumented body each
 *    open a market-scoped incident and derive nothing (the non-2xx and the
 *    undocumented body are still journaled); N consecutive failures publish
 *    `FeedStale` and open `GATEWAY_FEED_STALL` (the acceptance-2 machinery),
 *    a success closes the episode, a later run opens a fresh one; a WAL
 *    refusal suppresses derivation with a PAGE incident; an unreadable
 *    ledger fails the start; overlapping cycles are skipped, never stacked.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { GatewayStateError } from "@polymarket-bot/data-gateway";
import { LIFECYCLE_LEDGER_FILE_NAME } from "@polymarket-bot/data-gateway";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { applyMarketEvent, createUniverseRegistry, registerMarket } from "@polymarket-bot/universe";
import type { UniverseRegistry } from "@polymarket-bot/universe";
import { describe, expect, it } from "vitest";

import {
  buildHarness,
  polymarketBookFrame,
  polymarketRestBook,
  MARKET,
  type Harness,
} from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

/** `ManualGatewayClock`'s start: 2025-10-09T08:53:20.000Z. Asserted, not assumed. */
const CLOCK_START_MS = 1_760_000_000_000;
const OPEN_TIME = "2025-10-09T00:00:00.000Z"; // before the clock start
const CLOSE_TIME = "2025-10-09T08:53:45.000Z"; // 25 s after it: reached by the poll at +30 s
const GAMMA_MARKET_ID = "900001";
const GAMMA_BASE = "http://gamma.stub";
const GAMMA_URL = `${GAMMA_BASE}/markets/${GAMMA_MARKET_ID}`;

const LIFECYCLE_MARKET = {
  ...MARKET,
  gammaMarketId: GAMMA_MARKET_ID,
  parameters: {
    ...MARKET.parameters,
    status: "OPEN",
    openTime: OPEN_TIME,
    closeTime: CLOSE_TIME,
  },
} as const;

/** A `Market` body in the documented D-30 shape (every documented field present). */
function gammaMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conditionId: MARKET.conditionId,
    question: "Synthetic market (stub)",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    restricted: false,
    enableOrderBook: true,
    negRisk: false,
    startDate: "2025-10-01T00:00:00Z",
    endDate: "2025-12-31T00:00:00Z",
    closedTime: null,
    gameStartTime: null,
    ...overrides,
  };
}

const NOT_READY = gammaMarket({ acceptingOrders: false });
const READY = gammaMarket();
const CLOSED = gammaMarket({ closed: true, acceptingOrders: false, closedTime: "2025-10-09T08:00:00Z" });

/** One scripted answer of the stub Gamma server. */
type GammaAnswer =
  | { readonly status?: number; readonly body: unknown }
  | { readonly transportError: string }
  | { readonly hang: true };

/**
 * The stub Gamma server, on the gateway's injected HTTP port: answers the
 * scripted sequence in order (the last answer repeats), records every
 * request URL, and still serves the CLOB book routes for the market feed.
 */
function gammaStub(sequence: readonly GammaAnswer[]) {
  const requests: string[] = [];
  let index = 0;
  const pending: (() => void)[] = [];
  const route = (request: PublicHttpRequest): PublicHttpResponse | Promise<PublicHttpResponse> => {
    if (!request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return {
        status: 200,
        body: JSON.stringify(polymarketRestBook(MARKET.yesTokenId, MARKET.conditionId)),
      };
    }
    requests.push(request.url);
    const answer = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (answer === undefined) throw new Error("empty stub sequence");
    if ("transportError" in answer) throw new Error(answer.transportError);
    if ("hang" in answer) {
      return new Promise<PublicHttpResponse>((resolve) => {
        pending.push(() => {
          resolve({ status: 200, body: JSON.stringify(READY) });
        });
      });
    }
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status ?? 200, body };
  };
  return {
    route,
    requests,
    /** Releases every hung request. */
    release: (): void => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function lifecycleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    markets: [LIFECYCLE_MARKET],
    lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    ...overrides,
  };
}

function lifecycleEvents(harness: Harness): readonly EventEnvelope<unknown>[] {
  return harness
    .published()
    .filter((envelope) => envelope.eventType === "MarketOpened" || envelope.eventType === "MarketClosing");
}

function payloadOf(envelope: EventEnvelope<unknown>): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

/** The universe registry the trader would fold into, seeded exactly as the gateway seeds its own. */
function seededRegistry(): UniverseRegistry {
  const result = registerMarket(createUniverseRegistry(), {
    identity: {
      internalMarketId: MARKET.internalMarketId,
      conditionId: MARKET.conditionId,
      yesTokenId: MARKET.yesTokenId,
      noTokenId: MARKET.noTokenId,
    },
    parameters: {
      parameters: { ...LIFECYCLE_MARKET.parameters },
      observedAt: MARKET.observedAt,
      source: "polymarket",
    },
  });
  if (!result.ok) throw new Error("registration refused");
  return result.value.registry;
}

/** Folds the published lifecycle events, in order, refusing nothing. Returns the final registry. */
function foldAll(registry: UniverseRegistry, envelopes: readonly EventEnvelope<unknown>[]): UniverseRegistry {
  let current = registry;
  for (const envelope of envelopes) {
    const applied = applyMarketEvent(current, MARKET.internalMarketId, {
      eventType: envelope.eventType as "MarketOpened" | "MarketClosing",
      payload: envelope.payload,
      order: { gatewayEpoch: envelope.gatewayEpoch, ingestSeq: envelope.ingestSeq },
    });
    if (!applied.ok) {
      throw new Error(
        `the fold refused ${envelope.eventType}@${envelope.ingestSeq}: ${applied.refusals
          .map((refusal) => refusal.code)
          .join(",")}`,
      );
    }
    current = applied.value.registry;
  }
  return current;
}

async function pollOnce(harness: Harness): Promise<void> {
  harness.timers.advance(10_000);
  await harness.settle();
}

describe("UNIV-4 acceptance (a) — the pin that flipped", () => {
  it("not-ready → ready → closeTime → closed: exactly one MarketOpened, the scheduled and the observed MarketClosing, raw journaled first", async () => {
    const stub = gammaStub([
      { body: NOT_READY },
      { body: READY },
      { body: READY },
      { body: READY },
      { body: CLOSED },
    ]);
    const harness = await buildHarness({
      config: lifecycleConfig({ polymarket: { feedId: "polymarket-market" } }),
      http: stub.route,
    });
    expect(harness.clock.nowMs()).toBe(CLOCK_START_MS);

    // Acceptance 1, assertion 1: the WAL's accepted count at the instant each
    // lifecycle event is submitted to the transport.
    const acceptedAtPublish: { readonly eventType: string; readonly frames: number }[] = [];
    harness.transport.setPublishObserver((envelope) => {
      acceptedAtPublish.push({
        eventType: envelope.eventType,
        frames: harness.gateway.metrics().wal.framesAccepted,
      });
    });

    harness.gateway.start();
    const socket = harness.polymarketSockets.current;
    socket.open();
    socket.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();

    // Poll 1 (at start): not ready. Configuration said OPEN; the venue did not.
    expect(stub.requests).toEqual([GAMMA_URL]);
    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("PENDING");

    // Poll 2 (+10 s): ready → MarketOpened, and ONLY MarketOpened: the
    // reviewed closeTime (+25 s) is not reached, so no closing is announced.
    await pollOnce(harness);
    const afterOpen = lifecycleEvents(harness);
    expect(afterOpen.map((envelope) => envelope.eventType)).toEqual(["MarketOpened"]);
    expect(payloadOf(afterOpen[0]!)).toEqual({
      internalMarketId: MARKET.internalMarketId,
      conditionId: MARKET.conditionId,
      openedAt: OPEN_TIME,
    });
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("OPEN");

    // Poll 3 (+20 s): still ready, still before closeTime → nothing.
    await pollOnce(harness);
    expect(lifecycleEvents(harness)).toHaveLength(1);

    // Poll 4 (+30 s): closeTime reached → the scheduled MarketClosing.
    await pollOnce(harness);
    const afterSchedule = lifecycleEvents(harness);
    expect(afterSchedule.map((envelope) => envelope.eventType)).toEqual(["MarketOpened", "MarketClosing"]);
    expect(payloadOf(afterSchedule[1]!)).toEqual({
      internalMarketId: MARKET.internalMarketId,
      conditionId: MARKET.conditionId,
      closesAt: CLOSE_TIME,
    });
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("OPEN");

    // Poll 5 (+40 s): closed → the observed MarketClosing at the receipt instant.
    const closedObservedAtMs = harness.clock.nowMs() + 10_000;
    await pollOnce(harness);
    const all = lifecycleEvents(harness);
    expect(all.map((envelope) => envelope.eventType)).toEqual([
      "MarketOpened",
      "MarketClosing",
      "MarketClosing",
    ]);
    expect(payloadOf(all[2]!)["closesAt"]).toBe(new Date(closedObservedAtMs).toISOString());
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("CLOSED_OBSERVED");

    // Polls 6 and 7: nothing more, and the closed market is not even requested.
    await pollOnce(harness);
    await pollOnce(harness);
    expect(stub.requests).toHaveLength(5);
    expect(lifecycleEvents(harness)).toHaveLength(3);
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(1);

    await harness.gateway.stop();

    // Acceptance 1, assertions 2 and 3: identities and causation.
    const epoch = harness.gateway.gatewayEpoch;
    const frames = recordedFrames(harness.walFileSystem, epoch);
    const gammaFrames = frames.filter((frame) => frame.endpoint === GAMMA_URL);
    expect(gammaFrames).toHaveLength(5);
    for (const frame of gammaFrames) expect(frame.source).toBe("polymarket");
    expect(JSON.parse(gammaFrames[0]!.payloadUtf8)).toEqual(NOT_READY);
    expect(JSON.parse(gammaFrames[1]!.payloadUtf8)).toEqual(READY);
    expect(JSON.parse(gammaFrames[3]!.payloadUtf8)).toEqual(READY);
    expect(JSON.parse(gammaFrames[4]!.payloadUtf8)).toEqual(CLOSED);
    // MarketOpened ← poll 2's response; scheduled ← poll 4's; observed ← poll 5's.
    const causingFrames = [gammaFrames[1]!, gammaFrames[3]!, gammaFrames[4]!];
    for (const [index, envelope] of all.entries()) {
      const frame = causingFrames[index]!;
      expect(BigInt(frame.ingestSeq)).toBeLessThan(BigInt(envelope.ingestSeq));
      expect(envelope.causationId).toBe(`raw:${epoch}:${frame.ingestSeq}`);
      expect(envelope.source).toBe("polymarket");
      expect(envelope.sourceChannel).toBe("polymarket:gamma-market-rest");
      expect(envelope.subscriptionGeneration).toBe(0);
    }
    // Sequence within the stream, by the shared ordering identity.
    expect(BigInt(all[0]!.ingestSeq) < BigInt(all[1]!.ingestSeq)).toBe(true);
    expect(BigInt(all[1]!.ingestSeq) < BigInt(all[2]!.ingestSeq)).toBe(true);
    // The market-data feed kept flowing through the same stream.
    expect(harness.publishedOfType("BookSnapshot")).toHaveLength(1);
    // Assertion 1: at every lifecycle publish the WAL already held its frame
    // (the book frame plus the Gamma responses so far: 2 at the open, 4 at
    // the scheduled close, 5 at the observed close).
    const lifecyclePublishes = acceptedAtPublish.filter(
      (entry) => entry.eventType === "MarketOpened" || entry.eventType === "MarketClosing",
    );
    expect(lifecyclePublishes.map((entry) => entry.frames)).toEqual([3, 5, 6]);
    // Nothing dropped, nothing refused.
    const metrics = harness.gateway.metrics();
    expect(metrics.wal.queue.messagesDropped).toBe(0);
    expect(metrics.lifecycle).toMatchObject({
      polls: 5,
      pollFailures: 0,
      framesRecorded: 5,
      framesRefusedByWal: 0,
      marketOpenedEmitted: 1,
      marketClosingScheduledEmitted: 1,
      marketClosingObservedEmitted: 1,
      contradictions: 0,
      stallsObserved: 0,
    });
    // The lifecycle feed opened no incident. (The scripted market socket never
    // answers PING, so the MARKET feed's own heartbeat stall fires after 40 s of
    // manual time — acceptance 2's machinery, not this feed's.)
    expect(harness.incidents.filter((incident) => incident.feedId === "polymarket-lifecycle")).toEqual([]);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toEqual(["GATEWAY_FEED_STALL"]);
  });
});

describe("UNIV-4 acceptance (a) — openedAt is stable across a gateway restart", () => {
  it("configured openTime: the second epoch emits no second MarketOpened, and the fold accepts the whole stream", async () => {
    const walFileSystem = createMemoryFileSystem();
    const stubA = gammaStub([{ body: NOT_READY }, { body: READY }]);
    const first = await buildHarness({
      config: lifecycleConfig(),
      http: stubA.route,
      walFileSystem,
      idSeed: 0,
    });
    first.gateway.start();
    await first.settle();
    await pollOnce(first);
    expect(lifecycleEvents(first).map((envelope) => envelope.eventType)).toEqual(["MarketOpened"]);
    await first.gateway.stop();

    // The restart: a new epoch, the same WAL root (the harness clock starts
    // over, so closeTime is again 25 s ahead), the venue still ready, then
    // the schedule is reached, then the venue closes.
    const stubB = gammaStub([{ body: READY }, { body: READY }, { body: READY }, { body: READY }, { body: CLOSED }]);
    const second = await buildHarness({
      config: lifecycleConfig(),
      http: stubB.route,
      walFileSystem,
      idSeed: 1,
    });
    expect(second.gateway.gatewayEpoch).not.toBe(first.gateway.gatewayEpoch);
    second.gateway.start();
    await second.settle();
    await pollOnce(second);
    await pollOnce(second);
    // Three ready polls in the new epoch: no second MarketOpened.
    expect(lifecycleEvents(second)).toHaveLength(0);
    expect(second.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("OPEN");
    await pollOnce(second); // +30 s: closeTime reached → the scheduled closing
    expect(lifecycleEvents(second).map((envelope) => envelope.eventType)).toEqual(["MarketClosing"]);
    const closedAtMs = second.clock.nowMs() + 10_000;
    await pollOnce(second);
    await second.gateway.stop();

    const combined = [...lifecycleEvents(first), ...lifecycleEvents(second)];
    expect(combined.map((envelope) => envelope.eventType)).toEqual([
      "MarketOpened",
      "MarketClosing",
      "MarketClosing",
    ]);
    expect(payloadOf(combined[0]!)["openedAt"]).toBe(OPEN_TIME);
    expect(payloadOf(combined[2]!)["closesAt"]).toBe(new Date(closedAtMs).toISOString());
    expect(
      [...first.publishedOfType("MarketOpened"), ...second.publishedOfType("MarketOpened")],
    ).toHaveLength(1);

    // The fold accepts the two epochs' events in order…
    const folded = foldAll(seededRegistry(), combined);
    const projection = folded.markets.get(MARKET.internalMarketId);
    expect(projection?.lifecycleState).toBe("CLOSING");
    expect(projection?.openedAt).toBe(OPEN_TIME);
    // …accepts a same-instant MarketOpened replay as idempotent…
    const replay = applyMarketEvent(folded, MARKET.internalMarketId, {
      eventType: "MarketOpened",
      payload: payloadOf(combined[0]!),
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.idempotent).toBe(true);
    // …and REFUSES a MarketOpened minted fresh at the restart's first poll.
    const fresh = applyMarketEvent(folded, MARKET.internalMarketId, {
      eventType: "MarketOpened",
      payload: {
        internalMarketId: MARKET.internalMarketId,
        conditionId: MARKET.conditionId,
        openedAt: new Date(CLOCK_START_MS).toISOString(),
      },
    });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.refusals[0]?.code).toBe("UNIVERSE_LIFECYCLE_CONFLICT");
  });

  it("no configured openTime: the first observation instant is persisted in the ledger and re-read, never re-minted", async () => {
    const walFileSystem = createMemoryFileSystem();
    const market = {
      ...LIFECYCLE_MARKET,
      parameters: { ...MARKET.parameters, status: "DISCOVERED", closeTime: CLOSE_TIME },
    };
    const stubA = gammaStub([{ body: NOT_READY }, { body: NOT_READY }, { body: READY }]);
    const first = await buildHarness({
      config: lifecycleConfig({ markets: [market] }),
      http: stubA.route,
      walFileSystem,
      idSeed: 0,
    });
    first.gateway.start();
    await first.settle();
    await pollOnce(first);
    expect(lifecycleEvents(first)).toHaveLength(0);
    const readyObservedAtMs = first.clock.nowMs() + 10_000;
    await pollOnce(first);
    const opened = first.publishedOfType("MarketOpened");
    expect(opened).toHaveLength(1);
    const expectedOpenedAt = new Date(readyObservedAtMs).toISOString();
    expect(payloadOf(opened[0]!)["openedAt"]).toBe(expectedOpenedAt);
    await first.gateway.stop();

    // The ledger is on disk, under the WAL root, beside the epoch directory.
    const ledgerPath = `/wal/${LIFECYCLE_LEDGER_FILE_NAME}`;
    const ledgerText = walFileSystem.snapshot()[ledgerPath];
    expect(ledgerText).toBeDefined();
    const ledger = JSON.parse(ledgerText ?? "{}") as {
      schemaVersion: number;
      markets: Record<string, Record<string, unknown>>;
    };
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.markets[MARKET.internalMarketId]).toEqual({
      internalMarketId: MARKET.internalMarketId,
      openedAt: expectedOpenedAt,
      openedAtOrigin: "observation",
      firstReadyObservedAt: expectedOpenedAt,
    });

    // The restart, an hour later (closeTime long passed): the venue is still
    // ready. Without the ledger read this poll would mint a NEW openedAt and
    // publish a contradiction; with it, the only thing owed is the scheduled
    // closing the first epoch never reached.
    const stubB = gammaStub([{ body: READY }, { body: CLOSED }]);
    const second = await buildHarness({
      config: lifecycleConfig({ markets: [market] }),
      http: stubB.route,
      walFileSystem,
      idSeed: 1,
    });
    second.timers.advance(3_600_000);
    second.gateway.start();
    await second.settle();
    expect(second.publishedOfType("MarketOpened")).toHaveLength(0);
    expect(lifecycleEvents(second).map((envelope) => envelope.eventType)).toEqual(["MarketClosing"]);
    expect(payloadOf(lifecycleEvents(second)[0]!)["closesAt"]).toBe(CLOSE_TIME);
    expect(second.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("OPEN");
    await pollOnce(second);
    await second.gateway.stop();

    const combined = [...lifecycleEvents(first), ...lifecycleEvents(second)];
    expect(combined.map((envelope) => envelope.eventType)).toEqual([
      "MarketOpened",
      "MarketClosing",
      "MarketClosing",
    ]);
    const folded = foldAll(seededRegistry(), combined);
    expect(folded.markets.get(MARKET.internalMarketId)?.openedAt).toBe(expectedOpenedAt);
    // What the mutation would have published: a MarketOpened at the restart's
    // first poll instant. The fold refuses it.
    const minted = applyMarketEvent(folded, MARKET.internalMarketId, {
      eventType: "MarketOpened",
      payload: {
        internalMarketId: MARKET.internalMarketId,
        conditionId: MARKET.conditionId,
        openedAt: new Date(CLOCK_START_MS + 3_600_000).toISOString(),
      },
    });
    expect(minted.ok).toBe(false);
    // And the ledger now also records the observed close.
    const after = JSON.parse(walFileSystem.snapshot()[ledgerPath] ?? "{}") as {
      markets: Record<string, Record<string, unknown>>;
    };
    expect(after.markets[MARKET.internalMarketId]?.["scheduledClosesAt"]).toBe(CLOSE_TIME);
    expect(after.markets[MARKET.internalMarketId]?.["observedClosesAt"]).toBe(
      payloadOf(combined[2]!)["closesAt"],
    );
  });

  it("a restart after the observed close polls nothing and emits nothing", async () => {
    const walFileSystem = createMemoryFileSystem();
    const first = await buildHarness({
      config: lifecycleConfig(),
      http: gammaStub([{ body: READY }, { body: CLOSED }]).route,
      walFileSystem,
      idSeed: 0,
    });
    first.gateway.start();
    await first.settle();
    await pollOnce(first);
    // Opened, then the venue closed before the schedule: the observed closing only.
    expect(lifecycleEvents(first).map((envelope) => envelope.eventType)).toEqual([
      "MarketOpened",
      "MarketClosing",
    ]);
    await first.gateway.stop();

    const stub = gammaStub([{ body: READY }]);
    const second = await buildHarness({
      config: lifecycleConfig(),
      http: stub.route,
      walFileSystem,
      idSeed: 1,
    });
    second.gateway.start();
    await second.settle();
    await pollOnce(second);
    await second.gateway.stop();
    expect(stub.requests).toHaveLength(0);
    expect(lifecycleEvents(second)).toHaveLength(0);
    expect(second.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("CLOSED_OBSERVED");
  });
});

describe("UNIV-4 — the derivation rules' other cells", () => {
  it("R5: a market observed closed before it was ever open emits nothing, opens an incident, and is not polled again", async () => {
    const stub = gammaStub([{ body: CLOSED }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    await pollOnce(harness);
    await pollOnce(harness);
    await harness.gateway.stop();

    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(stub.requests).toHaveLength(1);
    const contradictions = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED",
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.severity).toBe("NOTIFY");
    expect(contradictions[0]?.feedId).toBe("polymarket-lifecycle");
    const published = harness
      .publishedOfType("DataQualityIncidentOpened")
      .map(payloadOf)
      .filter((payload) => payload["reasonCode"] === "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED");
    expect(published).toHaveLength(1);
    expect(published[0]?.["affectedMarketIds"]).toEqual([MARKET.internalMarketId]);
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("CONTRADICTED");
    // The response was still journaled: the contradiction is evidence.
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames.filter((frame) => frame.endpoint === GAMMA_URL)).toHaveLength(1);
  });

  it("R5 holds for archived too", async () => {
    const stub = gammaStub([{ body: gammaMarket({ archived: true, active: false }) }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toEqual([
      "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED",
    ]);
  });

  it("R6: readiness lost through active/archived alone while OPEN emits nothing and opens an incident", async () => {
    const stub = gammaStub([{ body: READY }, { body: gammaMarket({ active: false }) }, { body: READY }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    await pollOnce(harness);
    await pollOnce(harness);
    await harness.gateway.stop();
    expect(lifecycleEvents(harness).map((envelope) => envelope.eventType)).toEqual(["MarketOpened"]);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toEqual([
      "GATEWAY_LIFECYCLE_STATE_UNEXPECTED",
    ]);
    expect(harness.gateway.metrics().lifecycle?.phases[MARKET.internalMarketId]).toBe("OPEN");
  });

  it("R4: acceptingOrders false alone while OPEN is the observed closing", async () => {
    const stub = gammaStub([{ body: READY }, { body: NOT_READY }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    const observedAtMs = harness.clock.nowMs() + 10_000;
    await pollOnce(harness);
    await harness.gateway.stop();
    const events = lifecycleEvents(harness);
    expect(events.map((envelope) => envelope.eventType)).toEqual(["MarketOpened", "MarketClosing"]);
    expect(payloadOf(events[1]!)["closesAt"]).toBe(new Date(observedAtMs).toISOString());
  });

  it("R3: a market first observed ready AFTER its closeTime gets MarketOpened then the scheduled MarketClosing on the same poll", async () => {
    const harness = await buildHarness({
      config: lifecycleConfig(),
      http: gammaStub([{ body: READY }]).route,
    });
    harness.timers.advance(30_000); // past closeTime (+25 s) before the first poll
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    const events = lifecycleEvents(harness);
    expect(events.map((envelope) => envelope.eventType)).toEqual(["MarketOpened", "MarketClosing"]);
    expect(payloadOf(events[0]!)["openedAt"]).toBe(OPEN_TIME);
    expect(payloadOf(events[1]!)["closesAt"]).toBe(CLOSE_TIME);
    expect(BigInt(events[0]!.ingestSeq) < BigInt(events[1]!.ingestSeq)).toBe(true);
    // Both derive from the one response.
    expect(events[0]!.causationId).toBe(events[1]!.causationId);
    // …and the fold accepts them in this order (the reverse would be a regression).
    const folded = foldAll(seededRegistry(), events);
    expect(folded.markets.get(MARKET.internalMarketId)?.lifecycleState).toBe("CLOSING");
  });

  it("R3: the scheduled MarketClosing is announced exactly once, at the first poll at or past closeTime, never at the open", async () => {
    const harness = await buildHarness({
      config: lifecycleConfig(),
      http: gammaStub([{ body: READY }]).route,
    });
    harness.gateway.start();
    await harness.settle(); // +0 s: open
    await pollOnce(harness); // +10 s
    await pollOnce(harness); // +20 s
    expect(lifecycleEvents(harness).map((envelope) => envelope.eventType)).toEqual(["MarketOpened"]);
    await pollOnce(harness); // +30 s ≥ +25 s
    await pollOnce(harness); // +40 s: not again
    await pollOnce(harness); // +50 s
    await harness.gateway.stop();
    const events = lifecycleEvents(harness);
    expect(events.map((envelope) => envelope.eventType)).toEqual(["MarketOpened", "MarketClosing"]);
    expect(payloadOf(events[1]!)["closesAt"]).toBe(CLOSE_TIME);
    expect(events[1]!.receivedAt).toBe(new Date(CLOCK_START_MS + 30_000).toISOString());
    expect(harness.gateway.metrics().lifecycle?.marketClosingScheduledEmitted).toBe(1);
  });

  it("R2: ready BEFORE the configured openTime uses the observation instant (the venue's state wins over the schedule)", async () => {
    const future = new Date(CLOCK_START_MS + 86_400_000).toISOString();
    const market = {
      ...LIFECYCLE_MARKET,
      parameters: { ...LIFECYCLE_MARKET.parameters, openTime: future },
    };
    const harness = await buildHarness({
      config: lifecycleConfig({ markets: [market] }),
      http: gammaStub([{ body: READY }]).route,
    });
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    const opened = harness.publishedOfType("MarketOpened");
    expect(opened).toHaveLength(1);
    expect(payloadOf(opened[0]!)["openedAt"]).toBe(new Date(CLOCK_START_MS).toISOString());
    const ledger = JSON.parse(
      harness.walFileSystem.snapshot()[`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`] ?? "{}",
    ) as { markets: Record<string, Record<string, unknown>> };
    expect(ledger.markets[MARKET.internalMarketId]?.["openedAtOrigin"]).toBe("observation");
  });

  it("R3: no configured closeTime → no scheduled MarketClosing; only the observed one", async () => {
    const market = {
      ...LIFECYCLE_MARKET,
      parameters: { ...MARKET.parameters, status: "OPEN", openTime: OPEN_TIME },
    };
    const harness = await buildHarness({
      config: lifecycleConfig({ markets: [market] }),
      http: gammaStub([{ body: READY }, { body: CLOSED }]).route,
    });
    harness.gateway.start();
    await harness.settle();
    expect(lifecycleEvents(harness).map((envelope) => envelope.eventType)).toEqual(["MarketOpened"]);
    await pollOnce(harness);
    await harness.gateway.stop();
    expect(lifecycleEvents(harness).map((envelope) => envelope.eventType)).toEqual([
      "MarketOpened",
      "MarketClosing",
    ]);
  });

  it("R1: `restricted` is recorded, not acted on — a restricted market with an open book opens", async () => {
    const harness = await buildHarness({
      config: lifecycleConfig(),
      http: gammaStub([{ body: gammaMarket({ restricted: true }) }]).route,
    });
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(1);
    expect(harness.incidents).toEqual([]);
  });

  it("R1: every documented field null (the venue stated nothing) opens nothing", async () => {
    const harness = await buildHarness({
      config: lifecycleConfig(),
      http: gammaStub([
        {
          body: gammaMarket({
            active: null,
            closed: null,
            archived: null,
            acceptingOrders: null,
            restricted: null,
          }),
        },
      ]).route,
    });
    harness.gateway.start();
    await harness.settle();
    await pollOnce(harness);
    await harness.gateway.stop();
    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(harness.incidents).toEqual([]);
    expect(harness.gateway.metrics().lifecycle?.polls).toBe(2);
  });
});

describe("UNIV-4 — failure paths inherit the gateway's invariants", () => {
  it("three consecutive transport failures are a stall: FeedStale, GATEWAY_FEED_STALL, then a success closes the episode", async () => {
    const stub = gammaStub([
      { transportError: "ECONNRESET 1" },
      { transportError: "ECONNRESET 2" },
      { transportError: "ECONNRESET 3" },
      { body: NOT_READY },
      { transportError: "ECONNRESET 4" },
      { transportError: "ECONNRESET 5" },
      { transportError: "ECONNRESET 6" },
    ]);
    const harness = await buildHarness({
      config: lifecycleConfig({
        lifecycle: {
          feedId: "polymarket-lifecycle",
          baseUrl: GAMMA_BASE,
          pollIntervalMs: 10_000,
          consecutiveFailureThreshold: 3,
        },
      }),
      http: stub.route,
    });
    harness.gateway.start();
    await harness.settle();
    await pollOnce(harness);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toEqual([
      "GATEWAY_LIFECYCLE_POLL_FAILED",
    ]);
    expect(harness.publishedOfType("FeedStale")).toHaveLength(0);

    await pollOnce(harness); // third failure: the stall
    const stalls = harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_FEED_STALL");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.severity).toBe("NOTIFY");
    expect(stalls[0]?.feedId).toBe("polymarket-lifecycle");
    const stale = harness.publishedOfType("FeedStale");
    expect(stale).toHaveLength(1);
    expect(payloadOf(stale[0]!)["feedId"]).toBe("polymarket-lifecycle");
    expect(harness.gateway.metrics().lifecycle?.consecutiveFailures).toBe(3);

    await pollOnce(harness); // success: the episode ends
    expect(harness.gateway.metrics().lifecycle?.consecutiveFailures).toBe(0);
    await pollOnce(harness);
    await pollOnce(harness);
    await pollOnce(harness); // a fresh episode
    await harness.gateway.stop();
    expect(
      harness.incidents.filter((incident) => incident.reasonCode === "GATEWAY_FEED_STALL"),
    ).toHaveLength(2);
    expect(harness.publishedOfType("FeedStale")).toHaveLength(2);
    // Transport failures journal nothing (no response); nothing derived.
    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(harness.gateway.metrics().lifecycle).toMatchObject({
      polls: 7,
      pollFailures: 6,
      framesRecorded: 1,
      stallsObserved: 2,
    });
  });

  it("a non-2xx response and an undocumented body are journaled, open market-scoped incidents, and derive nothing", async () => {
    const stub = gammaStub([
      { status: 503, body: '{"error":"maintenance"}' },
      { body: gammaMarket({ active: "true" }) },
      { body: READY },
    ]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    expect(lifecycleEvents(harness)).toHaveLength(0);
    await pollOnce(harness);
    expect(lifecycleEvents(harness)).toHaveLength(0);
    expect(harness.incidents.map((incident) => incident.reasonCode)).toEqual([
      "GATEWAY_LIFECYCLE_POLL_FAILED",
      "GATEWAY_LIFECYCLE_STATE_INVALID",
    ]);
    await pollOnce(harness);
    await harness.gateway.stop();
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(1);
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch).filter(
      (frame) => frame.endpoint === GAMMA_URL,
    );
    expect(frames).toHaveLength(3);
    expect(frames[0]?.payloadUtf8).toBe('{"error":"maintenance"}');
    // The published incidents name the market.
    const incidents = harness.publishedOfType("DataQualityIncidentOpened").map(payloadOf);
    expect(incidents.map((payload) => payload["affectedMarketIds"])).toEqual([
      [MARKET.internalMarketId],
      [MARKET.internalMarketId],
    ]);
  });

  it("a WAL refusal suppresses the derivation and opens a PAGE incident (acceptance 1, the other half)", async () => {
    const harness = await buildHarness({
      config: lifecycleConfig({ wal: { rootPath: "/wal", maxTotalBytes: 1 } }),
      http: gammaStub([{ body: READY }]).route,
    });
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    expect(lifecycleEvents(harness)).toHaveLength(0);
    const refused = harness.incidents.filter(
      (incident) => incident.reasonCode === "GATEWAY_WAL_FRAME_REFUSED",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("PAGE");
    expect(harness.gateway.metrics().lifecycle).toMatchObject({
      framesRefusedByWal: 1,
      derivationsSuppressedUnrecorded: 1,
      marketOpenedEmitted: 0,
    });
  });

  it("an unreadable ledger fails the start rather than being replaced", async () => {
    const walFileSystem = createMemoryFileSystem();
    await walFileSystem.ensureDirectory("/wal");
    await walFileSystem.writeWholeFile(
      `/wal/${LIFECYCLE_LEDGER_FILE_NAME}`,
      Buffer.from("{ not the ledger", "utf8"),
    );
    let thrown: unknown;
    try {
      await buildHarness({ config: lifecycleConfig(), http: gammaStub([{ body: READY }]).route, walFileSystem });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as GatewayStateError | undefined)?.name).toBe("GatewayStateError");
    expect(String((thrown as Error | undefined)?.message)).toContain("lifecycle ledger");
  });

  it("a cycle still in flight is never stacked: the next interval is skipped and counted", async () => {
    const stub = gammaStub([{ hang: true }, { body: READY }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    harness.timers.advance(10_000);
    harness.timers.advance(10_000);
    expect(stub.requests).toHaveLength(1);
    expect(harness.gateway.metrics().lifecycle?.cyclesSkippedOverlapping).toBe(2);
    stub.release();
    await harness.settle();
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(1);
    await harness.gateway.stop();
  });

  it("the lifecycle feed alone is a valid gateway, and it never touches the WebSocket", async () => {
    const stub = gammaStub([{ body: READY }]);
    const harness = await buildHarness({ config: lifecycleConfig(), http: stub.route });
    harness.gateway.start();
    await harness.settle();
    await harness.gateway.stop();
    expect(harness.polymarketSockets.sockets).toHaveLength(0);
    expect(harness.publishedOfType("MarketOpened")).toHaveLength(1);
    expect(harness.lifetime).toEqual({ acquired: 1, released: 1 });
  });
});
