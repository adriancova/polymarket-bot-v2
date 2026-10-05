/**
 * WP-290 r15: the round-15 joint report's findings (Claude Opus and Codex gpt-6-astra, `reconcile-r15/joint.md`), kept
 * as named regressions with their controls. Every pin of the MEDIUM fails on d70d7a0 on a BEHAVIOURAL assertion (a
 * resume on lagging reads, with R1; or a resume at MATCHED where the r15 rule holds) or, for the mechanism pins, on the
 * journal's content; and passes here. The controls pass on both trees. The LOW's pins pass on d70d7a0 too (its guard
 * is there; the finding was its missing pin) and fail with the guard removed (mutation R15-F1). Each journal check is
 * asserted AFTER the behavioural ones.
 *
 * - WP290-V15-EFA-REQUEST-STATUS-ASSUMED (MEDIUM): a trade named only by WP-280's `EVENT_NOT_FULLY_APPLICABLE` request
 *   whose shortfalls name no status shortfall was journaled as ordered with no status, though the request carries no
 *   status at all (`manager.ts` `UserStreamReconciliationRequest`): the status travels only in the event's output,
 *   which WP-280 emits immediately before the request. When a coordinator restart lost the output while WP-280's backlog
 *   kept the request (the suite's own `restarted()` model), a lagging read showing the trade MATCHED answered the
 *   request, it was acknowledged, and the account resumed with a FAILED settlement missed (R1). Now the request's trade
 *   is `unordered` unless the coordinator received the output of the very event the request was raised for IMMEDIATELY
 *   before it (`P15-EFA`, `P15-EARLIER`, `P15-PULL`, `P15-ADJACENT`), and then its record carries that event's status
 *   (`P15-CARRY`).
 * - WP290-V15-RECEIPT-FLUSH-UNPINNED (LOW): the identities a request named during the last run of a `reconcile` are
 *   journaled when the `reconcile` ends (`P15-FLUSH`, Opus's X9, and a restart that loses WP-280's backlog too).
 *
 * PAPER only: every port is the in-memory simulated venue; WP-280's code is pure (no socket); no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import type { NormalizeOptions } from "../../../packages/polymarket-secure/src/user-stream/index.js";

import { boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults, VenueTrade } from "./support/world.js";
import { OUR_OWNER, OURS, Wp280Backlog, deliver, wireTrade, wp280Emit, type Wp280Emission } from "./support/wp280.js";

type Row = Record<string, unknown>;

interface Bound extends Ready {
  readonly backlog: Wp280Backlog;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`no ${what}`);
  return value;
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

async function boundReady(): Promise<Bound> {
  const r = await ready();
  const backlog = new Wp280Backlog();
  r.p.coordinator.bindUserStream(backlog);
  return { ...r, backlog };
}

/**
 * A new process over the same journal, store and venue. Bound to the same WP-280 backlog (WP-280 outlived the
 * coordinator: it re-delivers what it holds), or (`backlog` given) to another one (WP-280 died with it).
 */
async function restarted(r: Bound, backlog: Wp280Backlog = r.backlog): Promise<Bound> {
  const p = await boot(r.u);
  p.coordinator.bindUserStream(backlog);
  return { u: r.u, p, oms: p.oms as OrderManager, backlog };
}

/** A consistent snapshot of every read, as the venue answers now (a lagging adapter replays it). */
async function snapshot(r: Ready, venueOrderId: string): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const byId = await port.readOrder(venueOrderId);
  return { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral, readOrder: () => byId };
}

/** `rounds` runs on the reads as they are, the clock past the horizon after each: whether ANY resumed. */
async function anyResumed(r: Ready, rounds: number): Promise<boolean> {
  let resumed = false;
  for (let round = 0; round < rounds; round += 1) {
    resumed = (await r.p.coordinator.reconcile()).resumed || resumed;
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
  }
  return resumed;
}

/** The venue's trade as a wire trade message in which OUR order is the maker leg (the simulated venue's match makes it so). */
function makerTrade(trade: VenueTrade, status: string, extra: { readonly traderSide?: string | null; readonly makerOwners?: readonly string[] } = {}): Row {
  const owners = extra.makerOwners ?? [OUR_OWNER];
  return wireTrade({
    id: trade.venueTradeId,
    takerOrderId: "their-taker-order-1",
    assetId: trade.tokenId,
    side: trade.side === "BUY" ? "SELL" : "BUY",
    size: trade.shares,
    price: trade.price,
    status,
    traderSide: extra.traderSide === undefined ? "MAKER" : extra.traderSide,
    transactionHash: trade.transactionHash,
    makers: owners.map((owner) => ({ orderId: trade.venueOrderId, owner, matchedAmount: trade.shares, price: trade.price, assetId: trade.tokenId, side: trade.side })),
  });
}

/** The journaled stream trade records: [venue trade, status, unreadable]. */
function streamTrades(r: Ready): unknown[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.evidenceKind === "TRADE" && record.source === "STREAM_TRADE")
    .map((record) => [record.venueTradeId, record.status, record.unreadable]);
}

/** WP-280's request as its manager hands it to the listener (`RECONCILIATION_REQUESTED`), the request in its backlog first. */
function hand(r: Bound, request: unknown): void {
  r.backlog.pending.push(request as never);
  r.p.coordinator.onUserStreamOutput(Object.freeze({ kind: "RECONCILIATION_REQUESTED", request }));
}

/**
 * A tracked BUY matched 0.4 (MATCHED), its fill delivered by the stream (`earlier`: WP-280's REAL MATCHED event for the
 * same trade, with the same shortfall, and its request; else r14's synthetic projection), resumed; then the snapshot of
 * every read the lagging adapter will replay, taken before the venue fails the trade.
 */
async function matchedDelivered(options: NormalizeOptions, extra: Parameters<typeof makerTrade>[2], earlier: boolean): Promise<{ readonly r0: Bound; readonly trade: VenueTrade; readonly stale: ReadFaults }> {
  const r0 = await boundReady();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
  if (earlier) {
    const matched = wp280Emit(makerTrade(trade, "MATCHED", extra), options);
    expect(matched.request).not.toBeNull();
    deliver(r0.p.coordinator, r0.backlog, matched, { outputTaken: true });
  } else {
    r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
  }
  await r0.p.coordinator.settled();
  expect(await reconcileRounds(r0, 6)).toBe(true);
  expect(r0.oms.orders()[0]?.filledShares).toBe("0.4");
  // (`earlier`) The MATCHED event's request was answered: the trade is known MATCHED to the evidence.
  expect(r0.backlog.pending).toEqual([]);
  return { r0, trade, stale: await snapshot(r0, trade.venueOrderId) };
}

/** How the coordinator that received the FAILED event loses it (`P15-EFA`). */
type Crash = "OUTPUT_NEVER_RECEIVED" | "DIED_BEFORE_JOURNALING" | "DIED_DURING_THE_RUN";

/**
 * The venue FAILS the trade; WP-280 emits the FAILED event (its status recognised, so no status shortfall, but the
 * event cannot be projected: `extra`, `options`) and its `EVENT_NOT_FULLY_APPLICABLE` request; the coordinator loses
 * the output (`crash`), WP-280's backlog keeps the request (or, `control`, its `EVENT_NOT_DELIVERED` request); a new
 * process is bound to that backlog; every read replays the snapshot from before the failure.
 */
async function failedThenCrash(
  setup: { readonly r0: Bound; readonly trade: VenueTrade; readonly stale: ReadFaults },
  options: NormalizeOptions,
  extra: Parameters<typeof makerTrade>[2],
  crash: Crash,
  control: boolean,
): Promise<{ readonly r: Bound; readonly emission: Wp280Emission }> {
  const { r0, trade, stale } = setup;
  r0.u.world.failTrade(trade);
  const emission = wp280Emit(makerTrade(trade, "FAILED", extra), options);
  expect((emission.output["oms"] as { settlements: unknown[] }).settlements).toEqual([]);
  const request = must(control ? emission.notDelivered : emission.request, "request");
  if (crash === "OUTPUT_NEVER_RECEIVED") {
    // X8b (Opus): the old coordinator journaled nothing of the event; only the request survives, in WP-280's backlog.
    r0.backlog.pending.push(request);
  } else if (crash === "DIED_BEFORE_JOURNALING") {
    // astra's strengthened arm: the output, then its request, handed to the old coordinator between runs; it dies
    // before its stream chain runs (no further durable event).
    const before = r0.u.journalEvents.length;
    r0.p.coordinator.onUserStreamOutput(emission.output);
    hand(r0, request);
    r0.p.inc.alive = false;
    await r0.p.coordinator.settled();
    expect(r0.u.journalEvents.length).toBe(before);
  } else {
    // Both handed to the old coordinator DURING a run (the output buffered, the request's identities waiting for the
    // next run's evidence load); it dies in that run.
    const before = r0.u.journalEvents.length;
    r0.u.world.faults = {
      ...stale,
      onRead: (name) => {
        if (name !== "listTrades" || !r0.p.inc.alive) return;
        r0.p.coordinator.onUserStreamOutput(emission.output);
        hand(r0, request);
        r0.p.inc.alive = false;
      },
    };
    r0.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r0.p.coordinator.reconcile();
    await r0.p.coordinator.settled();
    expect(report.resumed).toBe(false);
    expect(r0.p.inc.alive).toBe(false);
    // Nothing of the event or the request is durable (the run's own RUN_STARTED may be).
    expect(r0.u.journalEvents.slice(before).filter((event) => event.kind === "EVIDENCE_RECORDED")).toEqual([]);
  }
  expect(r0.backlog.pending).toEqual([request]);
  r0.u.world.faults = stale;
  return { r: await restarted(r0), emission };
}

const SHAPES = [
  ["TRADER_SIDE_UNKNOWN (\"BOGUS\")", OURS, { traderSide: "BOGUS" }, "TRADER_SIDE_UNKNOWN"],
  ["TRADER_SIDE_UNKNOWN (absent)", OURS, { traderSide: null }, "TRADER_SIDE_UNKNOWN"],
  ["MAKER_LEG_OWNERSHIP_UNDETERMINED (no isAccountOwner)", {}, {}, "MAKER_LEG_OWNERSHIP_UNDETERMINED"],
  ["DUPLICATE_OWN_MAKER_LEG", OURS, { makerOwners: [OUR_OWNER, OUR_OWNER] }, "DUPLICATE_OWN_MAKER_LEG"],
] as const;

const CRASHES: readonly [Crash, string][] = [
  ["OUTPUT_NEVER_RECEIVED", "the output lost, the request only in WP-280's backlog (X8b)"],
  ["DIED_BEFORE_JOURNALING", "both handed to the old coordinator, which died before journaling either (astra's arm)"],
  ["DIED_DURING_THE_RUN", "both handed to the old coordinator during a run, which died in it"],
];

/** The new process on the lagging reads, then the truthful ones: never resumed; the failure held; the request owed. */
async function expectHeldThroughFailure(r: Bound, emission: Wp280Emission, requestId: string): Promise<void> {
  // d70d7a0: resumed with the failure missed (R1: collateral 999.8 projected vs 1000; token 0.4 vs 0), the request acknowledged.
  expect(await anyResumed(r, 4)).toBe(false);
  expect(oracle(r)).toEqual([]);
  expect(r.backlog.acknowledged).not.toContain(requestId);
  expect(r.backlog.pending.map((request) => request.requestId)).toEqual([requestId]);
  r.u.world.faults = {};
  expect(await anyResumed(r, 3)).toBe(false);
  expect(oracle(r)).toEqual([]);
  expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("SETTLEMENT_FAILED");
  // The mechanism, asserted last: the trade the request named, its status unordered (no observation fixed it).
  const tradeId = must((emission.request ?? emission.notDelivered)?.venueTradeId, "trade id");
  expect(streamTrades(r)).toContainEqual([tradeId, null, expect.arrayContaining(["status"])]);
}

describe("WP-290 r15 (WP290-V15-EFA-REQUEST-STATUS-ASSUMED): a request carries no status: its trade is unordered unless its own event's output came right before it", () => {
  for (const [name, options, extra, shortfall] of SHAPES) {
    for (const [crash, how] of CRASHES) {
      it(`(P15-EFA, ${name}; ${how}) a FAILED event WP-280 recognises but cannot project; a restart on the same backlog; the reads lag behind the failure: never resumed; once truthful, the failure is held`, async () => {
        const setup = await matchedDelivered(options, extra, false);
        const { r, emission } = await failedThenCrash(setup, options, extra, crash, false);
        expect(emission.shortfalls).toEqual([shortfall]);
        await expectHeldThroughFailure(r, emission, must(emission.request, "request").requestId);
      });
    }

    it(`(P15-EFA, control: EVENT_NOT_DELIVERED; ${name}) the same, WP-280's backlog holding the EVENT_NOT_DELIVERED request instead: held (on both trees)`, async () => {
      const setup = await matchedDelivered(options, extra, false);
      const { r, emission } = await failedThenCrash(setup, options, extra, "OUTPUT_NEVER_RECEIVED", true);
      await expectHeldThroughFailure(r, emission, must(emission.notDelivered, "request").requestId);
    });
  }

  for (const [crash, how] of CRASHES) {
    it(`(P15-EARLIER; ${how}) the trade's EARLIER event (WP-280's real MATCHED event, the same shortfall) was received, journaled and answered: an earlier MATCHED observation does not establish the FAILED event's status`, async () => {
      const [, options, extra] = must(SHAPES[0], "shape");
      const setup = await matchedDelivered(options, extra, true);
      // The earlier event's stream record is durable, at MATCHED.
      expect(streamTrades(setup.r0)).toContainEqual([setup.trade.venueTradeId, "MATCHED", expect.any(Array)]);
      const { r, emission } = await failedThenCrash(setup, options, extra, crash, false);
      await expectHeldThroughFailure(r, emission, must(emission.request, "request").requestId);
    });
  }

  it("(P15-EFA, control: no restart) the FAILED event's output, then its request, handed in WP-280's order: held on the lagging reads; once truthful, the failure is held (on both trees)", async () => {
    const [, options, extra] = must(SHAPES[0], "shape");
    const { r0, trade, stale } = await matchedDelivered(options, extra, false);
    r0.u.world.failTrade(trade);
    const emission = wp280Emit(makerTrade(trade, "FAILED", extra), options);
    deliver(r0.p.coordinator, r0.backlog, emission, { outputTaken: true });
    await r0.p.coordinator.settled();
    r0.u.world.faults = stale;
    expect(await anyResumed(r0, 4)).toBe(false);
    expect(oracle(r0)).toEqual([]);
    r0.u.world.faults = {};
    expect(await anyResumed(r0, 3)).toBe(false);
    expect(oracle(r0)).toEqual([]);
    expect(r0.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("SETTLEMENT_FAILED");
  });
});

/**
 * A tracked BUY of 1 at 0.5, resumed; the venue matches 0.4 against it (our order the maker; MATCHED, not terminal);
 * WP-280's TRADE output for that event cannot attribute the leg (trader side "BOGUS": `TRADER_SIDE_UNKNOWN`, its status
 * recognised), so it projects nothing; the reads are truthful.
 */
async function matchedUnattributed(): Promise<{ readonly r: Bound; readonly trade: VenueTrade; readonly emission: Wp280Emission }> {
  const r = await boundReady();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const trade = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
  const emission = wp280Emit(makerTrade(trade, "MATCHED", { traderSide: "BOGUS" }), OURS);
  expect(emission.shortfalls).toEqual(["TRADER_SIDE_UNKNOWN"]);
  return { r, trade, emission };
}

/**
 * The request's trade is `unordered` here: it holds while the reads show the trade MATCHED (it could have been a later,
 * FAILED event's), and resumes, delivered and acknowledged, once the venue shows it CONFIRMED.
 */
async function expectUnorderedHold(r: Bound, trade: VenueTrade, requestId: string): Promise<void> {
  expect(await anyResumed(r, 3)).toBe(false);
  expect(oracle(r)).toEqual([]);
  expect(r.backlog.acknowledged).toEqual([]);
  trade.status = "CONFIRMED";
  expect(await reconcileRounds(r, 6)).toBe(true);
  expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
  expect(oracle(r)).toEqual([]);
  expect(r.backlog.acknowledged).toEqual([requestId]);
}

describe("WP-290 r15: only the output received IMMEDIATELY before a request establishes its event's status", () => {
  it("(P15-NORMAL, control: WP-280's order) the output, then its request, received in a row: nothing new holds (resumed at MATCHED, delivered, acknowledged)", async () => {
    const { r, emission } = await matchedUnattributed();
    deliver(r.p.coordinator, r.backlog, emission, { outputTaken: true });
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    expect(oracle(r)).toEqual([]);
    expect(r.backlog.acknowledged).toEqual([must(emission.request, "request").requestId]);
  });

  it("(P15-PULL) the output handed by the listener, its request only in WP-280's backlog (pulled by the next run): the pulled request has no output before it, so its trade holds until shown terminal", async () => {
    const { r, trade, emission } = await matchedUnattributed();
    const request = must(emission.request, "request");
    r.p.coordinator.onUserStreamOutput(emission.output);
    r.backlog.pending.push(request);
    await r.p.coordinator.settled();
    await expectUnorderedHold(r, trade, request.requestId);
  });

  it("(P15-ADJACENT, a STATE output between) the output, then a STATE output, then its request: not received in a row, so its trade holds until shown terminal", async () => {
    const { r, trade, emission } = await matchedUnattributed();
    const request = must(emission.request, "request");
    r.p.coordinator.onUserStreamOutput(emission.output);
    r.p.coordinator.onUserStreamOutput(Object.freeze({ kind: "STATE", from: "SUBSCRIBED", to: "STALE", cause: null, subscriptionGeneration: 1 }));
    hand(r, request);
    await r.p.coordinator.settled();
    await expectUnorderedHold(r, trade, request.requestId);
  });

  for (const [name, change, expected] of [
    ["the request names another trade", { venueTradeId: "their-trade-elsewhere-1" }, "their-trade-elsewhere-1"],
    ["the request's shortfalls longer than the output's", { shortfalls: ["TRADER_SIDE_UNKNOWN", "MAKER_FEE_NOT_ON_STREAM"] }, null],
    ["the request's shortfall another one", { shortfalls: ["MAKER_FEE_NOT_ON_STREAM"] }, null],
  ] as const) {
    it(`(P15-ADJACENT, ${name}) received right after the output, but not its event's request: the trade it names is unordered`, async () => {
      const { r, trade, emission } = await matchedUnattributed();
      const request = Object.freeze({ ...must(emission.request, "request"), ...change });
      r.p.coordinator.onUserStreamOutput(emission.output);
      hand(r, request);
      await r.p.coordinator.settled();
      const tradeId = expected ?? trade.venueTradeId;
      expect(streamTrades(r)).toContainEqual([tradeId, null, expect.arrayContaining(["status"])]);
    });
  }

  it("(P15-ADJACENT, a shortfall outside WP-280's vocabulary on both) the output and its request in a row, both naming a shortfall WP-280 never raises: the status is not one WP-280 attested recognised: unordered", async () => {
    const { r, trade, emission } = await matchedUnattributed();
    const output = Object.freeze({ ...emission.output, oms: Object.freeze({ ...(emission.output["oms"] as Row), shortfalls: Object.freeze(["NOT_A_SHORTFALL"]) }) });
    const request = Object.freeze({ ...must(emission.request, "request"), shortfalls: Object.freeze(["NOT_A_SHORTFALL"]) });
    r.p.coordinator.onUserStreamOutput(output);
    hand(r, request);
    await r.p.coordinator.settled();
    expect(streamTrades(r)).toContainEqual([trade.venueTradeId, null, expect.arrayContaining(["status"])]);
  });

  it("(P15-CARRY) the FAILED event's output and request received during the last run of a reconcile; the process dies right after the request's trade is journaled (before the output is routed), and WP-280's backlog dies with it: the request's record alone carries the event's FAILED status, so the lagging reads never resume", async () => {
    const [, options, extra] = must(SHAPES[0], "shape");
    const { r0, trade, stale } = await matchedDelivered(options, extra, false);
    let reads = 0;
    let fired = false;
    r0.u.world.faults = {
      onRead: (name) => {
        if (name !== "readApprovals") return;
        reads += 1;
        // Every run gets new work during its reads (a trigger), so the reconcile uses all of its runs.
        if (reads < 4) {
          r0.p.coordinator.trigger("PERIODIC_TIMER");
          return;
        }
        if (fired) return;
        fired = true;
        r0.u.world.failTrade(trade);
        deliver(r0.p.coordinator, r0.backlog, wp280Emit(makerTrade(trade, "FAILED", extra), options), { outputTaken: true });
      },
    };
    // The reconcile records what the requests named before it routes the outputs buffered during its last run: the
    // process dies right after the first stream trade record journaled once the event arrived.
    const original = r0.p.journal.append.bind(r0.p.journal);
    r0.p.journal.append = async (event: unknown) => {
      const result = await original(event as never);
      const entry = event as { kind?: string; source?: string };
      if (fired && entry.kind === "EVIDENCE_RECORDED" && entry.source === "STREAM_TRADE") r0.p.inc.alive = false;
      return result;
    };
    r0.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r0.p.coordinator.reconcile();
    await r0.p.coordinator.settled();
    expect(fired).toBe(true);
    expect(report.resumed).toBe(false);
    expect(r0.p.inc.alive).toBe(false);
    r0.u.world.faults = stale;
    const r = await restarted(r0, new Wp280Backlog());
    // d70d7a0: the request's record carried no status (and no unordered mark): resumed with the failure missed (R1).
    expect(await anyResumed(r, 4)).toBe(false);
    expect(oracle(r)).toEqual([]);
    r.u.world.faults = {};
    expect(await anyResumed(r, 3)).toBe(false);
    expect(oracle(r)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("SETTLEMENT_FAILED");
    // The mechanism, asserted last: the only stream record of the event is the request's, at FAILED.
    expect(streamTrades(r).filter((entry) => entry[1] === "FAILED")).toEqual([[trade.venueTradeId, "FAILED", []]]);
  });
});

describe("WP-290 r15 (WP290-V15-RECEIPT-FLUSH-UNPINNED): what a request named during a reconcile's last run is journaled when the reconcile ends", () => {
  for (const withRestart of [false, true]) {
    it(`(P15-FLUSH${withRestart ? ", a restart that loses WP-280's backlog too" : ""}) X9 (Opus): a request received during the LAST run of a reconcile names an unattributable fill; its trade is journaled once the reconcile returns${withRestart ? "; a new process, with no backlog, holds on it" : ""}`, async () => {
      const r = await boundReady();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const collateral = r.u.world.collateral;
      const salt = must(r.u.world.receipts.at(-1), "receipt");
      let reads = 0;
      let fired = false;
      r.u.world.faults.onRead = (name) => {
        if (name !== "readApprovals") return;
        reads += 1;
        if (reads < 4) {
          r.p.coordinator.trigger("PERIODIC_TIMER");
          return;
        }
        if (fired) return;
        fired = true;
        const trade = must(r.u.world.match(salt, "0.4", { status: "MATCHED" }), "match");
        r.u.world.cancel(trade.venueOrderId);
        r.u.world.faults = {
          listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
          readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
          readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
          readOrder: (_id, answer) => {
            const read = answer() as { order?: Row };
            return { ...read, order: { ...read.order, sizeMatched: "0" } };
          },
        };
        // WP-280's output for the match is not taken: only its requests reach the coordinator, during this run.
        deliver(r.p.coordinator, r.backlog, wp280Emit(makerTrade(trade, "MATCHED"), {}), { outputTaken: false });
      };
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await r.p.coordinator.settled();
      expect(fired).toBe(true);
      expect(report.runs.length).toBe(4);
      expect(report.resumed).toBe(false);
      // d70d7a0 with the reconcile-end flush removed: nothing journaled here (the identities waited in memory).
      expect(streamTrades(r).length).toBeGreaterThan(0);
      const next = withRestart ? await restarted(r, new Wp280Backlog()) : r;
      expect(await anyResumed(next, 3)).toBe(false);
      expect(oracle(next)).toEqual([]);
    });
  }
});
