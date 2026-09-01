/**
 * WORKPLAN ACCEPTANCE 3 — "Gap recovery requires an authoritative snapshot."
 *
 * §7.1 / ADR-002 §2.4 make the obligation unconditional: "a restart or
 * detected gap requires a new authoritative snapshot before affected markets
 * resume", and the two contract fields that express it are pinned to the
 * literal `true` so a gap cannot waive it and a resynchronization cannot
 * assert a recovery that did not happen.
 *
 * What is asserted here:
 *
 * 1. A reconnect opens a gap; NO `FeedResynchronized` is published until an
 *    authoritative REST snapshot has actually been fetched and applied.
 * 2. When the snapshot FAILS, the gap stays open, an incident opens, and no
 *    resynchronization is claimed — the feed does not resume on a snapshot it
 *    never got.
 * 3. On the RTDS feed, where no authoritative snapshot can ever exist, the
 *    gateway does NOT wait for one: it halts the feed with a PAGE incident and
 *    clears the adapter's gap state — and the acknowledgement is NEVER an
 *    authoritative resync (no `FeedResynchronized` is published, because none
 *    exists on that feed). Round-1 review H4: the halt is TERMINAL, and the
 *    post-gap frame below is what proves it — raw recording continues,
 *    normalized publication does not.
 */

import { describe, expect, it } from "vitest";

import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";

import {
  buildHarness,
  polymarketBookFrame,
  polymarketRestBook,
  rtdsUpdateFrame,
  MARKET,
} from "./support/harness.js";
import { recordedFrames } from "./support/wal.js";

function restRoute(): (request: PublicHttpRequest) => PublicHttpResponse {
  return (request) => {
    if (request.url.includes("/books")) {
      return {
        status: 200,
        body: JSON.stringify([
          polymarketRestBook(MARKET.yesTokenId, MARKET.conditionId),
          polymarketRestBook(MARKET.noTokenId, MARKET.conditionId),
        ]),
      };
    }
    return {
      status: 200,
      body: JSON.stringify(polymarketRestBook(MARKET.yesTokenId, MARKET.conditionId)),
    };
  };
}

describe("acceptance 3 — gap recovery requires an authoritative snapshot", () => {
  it("publishes FeedResynchronized only after an authoritative REST snapshot is applied", async () => {
    let snapshotRequests = 0;
    const harness = await buildHarness({
      config: { polymarket: { feedId: "polymarket-market" } },
      http: (request) => {
        snapshotRequests += 1;
        return restRoute()(request);
      },
    });
    harness.gateway.start();
    const first = harness.polymarketSockets.current;
    first.open();
    first.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();

    // A healthy first connection owes nothing.
    expect(harness.publishedOfType("FeedGapDetected")).toHaveLength(0);
    expect(harness.publishedOfType("FeedResynchronized")).toHaveLength(0);
    expect(snapshotRequests).toBe(0);

    // The socket dies and the feed reconnects: the server-side subscription was
    // replaced, so a gap opens.
    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.polymarketSockets.current;
    expect(second).not.toBe(first);
    second.open();
    await harness.settle();

    const gaps = harness.publishedOfType("FeedGapDetected");
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    // The obligation is recorded on the event itself, pinned to `true`.
    expect(
      (gaps[0]?.payload as { requiresAuthoritativeSnapshot?: unknown })
        .requiresAuthoritativeSnapshot,
    ).toBe(true);

    // The gateway fetched the authoritative snapshot and only then claimed
    // recovery.
    await harness.settle();
    expect(snapshotRequests).toBeGreaterThanOrEqual(1);
    const resyncs = harness.publishedOfType("FeedResynchronized");
    expect(resyncs).toHaveLength(1);
    expect(
      (resyncs[0]?.payload as { authoritativeSnapshotApplied?: unknown })
        .authoritativeSnapshotApplied,
    ).toBe(true);

    // The snapshot's own books were published before the recovery claim.
    const snapshotEvents = harness.publishedOfType("BookSnapshot");
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(2);
    const lastSnapshot = snapshotEvents.at(-1);
    expect(lastSnapshot).toBeDefined();
    if (lastSnapshot === undefined || resyncs[0] === undefined) return;
    expect(BigInt(lastSnapshot.ingestSeq)).toBeLessThan(BigInt(resyncs[0].ingestSeq));
    expect(harness.gateway.metrics().polymarket?.snapshotRecoveries).toBe(1);

    await harness.gateway.stop();
  });

  it("leaves the gap open and claims no recovery when the snapshot fetch fails", async () => {
    const harness = await buildHarness({
      config: { polymarket: { feedId: "polymarket-market" } },
      http: () => {
        throw new Error("CLOB REST unreachable");
      },
    });
    harness.gateway.start();
    const first = harness.polymarketSockets.current;
    first.open();
    first.message(polymarketBookFrame(MARKET.yesTokenId, MARKET.conditionId));
    await harness.settle();

    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    harness.polymarketSockets.current.open();
    await harness.settle();

    // A gap was detected, the snapshot could not be obtained, and NOTHING
    // claimed recovery.
    expect(harness.publishedOfType("FeedGapDetected").length).toBeGreaterThanOrEqual(1);
    expect(harness.publishedOfType("FeedResynchronized")).toHaveLength(0);
    expect(harness.gateway.metrics().polymarket?.snapshotFetchFailures).toBeGreaterThanOrEqual(1);
    expect(harness.gateway.metrics().polymarket?.snapshotRecoveries).toBe(0);
    expect(
      harness.incidents.some(
        (incident) => incident.reasonCode === "GATEWAY_SNAPSHOT_FETCH_FAILED",
      ),
    ).toBe(true);

    await harness.gateway.stop();
  });

  it("halts the RTDS feed on an unrecoverable gap instead of waiting for a snapshot that cannot exist", async () => {
    const harness = await buildHarness({
      config: {
        rtds: {
          feedId: "polymarket-rtds-twap",
          subscriptions: [{ windowSeconds: 60 }],
          plannedSymbols: ["btc/usd"],
        },
      },
    });
    harness.gateway.start();
    const first = harness.rtdsSockets.current;
    first.open();
    first.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();
    expect(harness.publishedOfType("ReferenceTwapObserved")).toHaveLength(1);

    // The socket dies and the feed reconnects: RTDS publishes no history, so
    // the interval that passed is permanently unobserved.
    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.rtdsSockets.current;
    expect(second).not.toBe(first);
    second.open();
    await harness.settle();

    const halts = harness.incidents.filter(
      (incident) => incident.reasonCode === "RTDS_UNRECOVERABLE_GAP",
    );
    expect(halts).toHaveLength(1);
    expect(halts[0]?.severity).toBe("PAGE");
    // The acknowledgement is NOT a resync: no FeedResynchronized exists on
    // this feed and none was synthesized (WP-100 DV1).
    expect(harness.publishedOfType("FeedResynchronized")).toHaveLength(0);
    expect(harness.gateway.metrics().rtds?.unrecoverableGapsAcknowledged).toBe(1);

    // ROUND-1 REVIEW H4: "halts" has to mean the feed STOPS. Round 1 opened
    // the incident, acknowledged the gap, and then went on publishing — the
    // test stopped one assertion too early to see it. The halt is now real
    // and terminal for the epoch.
    expect(harness.gateway.metrics().rtds?.halted).toBe(true);

    // A POST-GAP FRAME: recorded raw, never published. A consumer that read
    // only the data stream would otherwise see an unbroken TWAP series across
    // a permanently unobserved interval.
    const publishedBeforePostGapFrame = harness.publishedOfType("ReferenceTwapObserved").length;
    harness.clock.advance(1_000);
    second.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();

    expect(harness.publishedOfType("ReferenceTwapObserved")).toHaveLength(
      publishedBeforePostGapFrame,
    );
    expect(harness.gateway.metrics().rtds?.observationsSuppressedAfterGap).toBe(1);
    // The suppression is not a drop: the raw frame is on disk, verbatim.
    expect(harness.gateway.metrics().rtds?.framesRefusedByWal).toBe(0);

    await harness.gateway.stop();
    const frames = recordedFrames(harness.walFileSystem, harness.gateway.gatewayEpoch);
    expect(frames.some((frame) => frame.payloadUtf8.includes("crypto_prices_twap"))).toBe(true);
    // Every frame the sockets delivered reached the WAL, including the ones
    // after the halt.
    expect(harness.gateway.metrics().rtds?.framesRecorded).toBe(frames.length);
  });
});
