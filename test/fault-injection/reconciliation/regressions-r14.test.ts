/**
 * WP-290 r14: the round-14 joint report's finding (Claude Opus and Codex gpt-6-astra, `reconcile-r14/joint.md`), and
 * the instance of its class the round's re-audit found, kept as named regressions with their controls. Every finding
 * pin fails on c3cb404 on a BEHAVIOURAL assertion (a resume on lagging reads, an oracle violation, an ABSENT accepted
 * for an order the venue holds, a request acknowledged while what it named is unanswered), and passes here. Each
 * journal and acknowledgement check is asserted AFTER the behavioural ones.
 *
 * - WP290-V14-WP280-EVENT-IDS-DISCARDED (HIGH): WP-280's own, contract-conforming outputs for an account event it could
 *   not project (an EMPTY TRADE projection, its shortfall `TRADE_STATUS_UNRECOGNIZED`, `TRADE_STATUS_C3`,
 *   `MAKER_LEG_OWNERSHIP_UNDETERMINED`, `TRADER_SIDE_UNKNOWN` or `DUPLICATE_OWN_MAKER_LEG`; an ORDER projection with
 *   `observation: null`, `ORDER_STATUS_ABSENT`) were read as carrying nothing, and WP-280's `EVENT_NOT_FULLY_APPLICABLE`
 *   (or `EVENT_NOT_DELIVERED`) request, which names the event's identifiers exactly, as a bare trigger acknowledged after
 *   one run. Under lagging reads the account resumed with a FAILED settlement missed (R1), a maker fill lost (R1), or an
 *   ABSENT answered for an unknown submission the venue holds (R2). Every arm here is driven by WP-280's REAL normalizer
 *   and projection over a venue wire message, emitted exactly as WP-280's manager emits it (`support/wp280.ts`), with
 *   and without a restart. Now the event's identities and the request's are journaled as stream-NAMED evidence (an order
 *   read by id; a trade whose identity is open until a valid trades row shows its own legs in full; `unordered` when its
 *   status cannot be ordered), an identity that cannot be read is an obligation of the account, and the request is
 *   acknowledged only once a run has judged everything it named (`P14-*`).
 * - The re-audit (the finding's "re-audit every 'empty means nothing' reading of a WP-280 activity output"): an activity
 *   output received DURING a run waited, unrouted, in the coordinator's buffer while that run resumed, so the fill it
 *   carried was unapplied at the resume (R1). Now it is work that arrived during the run (`P14-BUFFER`).
 *
 * PAPER only: every port is the in-memory simulated venue; WP-280's code is pure (no socket); no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { readStreamOutput, readStreamRequest } from "../../../packages/oms/src/reconciliation/door.js";
import { readEvidenceRecords } from "../../../packages/oms/src/reconciliation/evidence.js";
import type { NormalizeOptions } from "../../../packages/polymarket-secure/src/user-stream/index.js";

import { boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults, VenueTrade } from "./support/world.js";
import { OUR_OWNER, OURS, Wp280Backlog, deliver, wireOrder, wireTrade, wp280Emit, type Wp280Emission } from "./support/wp280.js";

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

/** A new process over the same journal, store and venue, bound to the same WP-280 backlog (it re-delivers what it holds). */
async function restarted(r: Bound): Promise<Bound> {
  const p = await boot(r.u);
  p.coordinator.bindUserStream(r.backlog);
  return { u: r.u, p, oms: p.oms as OrderManager, backlog: r.backlog };
}

/** Every read lags behind the fill: no trades, no positions, the collateral as before, the order by id with 0 matched (r7's helper). */
function lagEveryRead(r: Ready, collateral: string): void {
  r.u.world.faults = {
    listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
    readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
    readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
    readOrder: (_id, answer) => {
      const read = answer() as { order?: Row };
      return { ...read, order: { ...read.order, sizeMatched: "0" } };
    },
  };
}

/** A consistent snapshot of every read, as the venue answers now (a lagging adapter replays it); the by-id read of `venueOrderId` too. */
async function snapshot(r: Ready, venueOrderId: string | null): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const faults: ReadFaults = { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral };
  if (venueOrderId !== null) {
    const byId = await port.readOrder(venueOrderId);
    faults.readOrder = () => byId;
  }
  return faults;
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

/** The journaled stream-named evidence: [kind, source, venue order, venue trade, status, unreadable]. */
function streamEvidence(r: Ready): unknown[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.source.startsWith("STREAM_"))
    .map((record) => [record.evidenceKind, record.source, record.venueOrderId, record.venueTradeId, record.status, record.unreadable]);
}

/** Release every QUARANTINED break whose subject an operator has checked against the venue (the r10 helper's rule); returns how many. */
async function releaseAll(r: Ready, reason: string): Promise<number> {
  let released = 0;
  for (const view of r.p.journal.unresolvedBreaks()) {
    if (view.status !== "QUARANTINED") continue;
    if ((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason })).ok) released += 1;
  }
  return released;
}

/**
 * (r15, restated: WP290-V15-EFA-REQUEST-STATUS-ASSUMED) After a restart, WP-280's `EVENT_NOT_FULLY_APPLICABLE` request
 * comes from its backlog WITHOUT the output it was raised for: which status its event had is unknown to the new process
 * (it could have been FAILED), so its trade holds while the reads show it MATCHED, and is delivered once a read shows it
 * terminal. r14 asserted a resume at MATCHED here, which is exactly the finding's fail-open premise (the request alone
 * ordering its event's status). Without a restart, nothing new holds (the arms above resume at MATCHED).
 */
async function heldUntilTerminal(r: Bound, trade: VenueTrade): Promise<void> {
  expect(await anyResumed(r, 3)).toBe(false);
  expect(oracle(r)).toEqual([]);
  expect(r.backlog.acknowledged).toEqual([]);
  trade.status = "CONFIRMED";
}

function absentAnswers(r: Ready, attempt: string | null): number {
  return r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT").length;
}

/**
 * (A) A tracked BUY matched 0.4 (MATCHED), its fill delivered by the stream, resumed; the venue FAILS the trade; WP-280's
 * TRADE output for the FAILED event names a status it does not recognise (or C-3's), so it projects NOTHING (a status
 * shortfall); the reads replay a snapshot from before the failure.
 */
async function failedThenLag(wireStatus: string, delivery: "OUTPUT" | "REQUEST_ONLY" | "OUTPUT_ONLY", withRestart: boolean): Promise<{ r: Bound; trade: VenueTrade; emission: Wp280Emission }> {
  const r0 = await boundReady();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
  r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
  await r0.p.coordinator.settled();
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const stale = await snapshot(r0, trade.venueOrderId);
  r0.u.world.failTrade(trade);
  const emission = wp280Emit(makerTrade(trade, wireStatus));
  deliver(r0.p.coordinator, r0.backlog, emission, { outputTaken: delivery !== "REQUEST_ONLY", requestsReceived: delivery !== "OUTPUT_ONLY" });
  await r0.p.coordinator.settled();
  r0.u.world.faults = stale;
  return { r: withRestart ? await restarted(r0) : r0, trade, emission };
}

/**
 * (B, C) A tracked BUY of 1 at 0.5, resumed; the venue matches 0.4 against it (our order the maker); WP-280's TRADE
 * output for the MATCHED event cannot attribute the leg (`options`, `extra`), so it projects nothing for it; the order is
 * canceled and every read lags.
 */
async function fillThenLag(options: NormalizeOptions, extra: Parameters<typeof makerTrade>[2], delivery: "OUTPUT" | "REQUEST_ONLY", withRestart: boolean): Promise<{ r: Bound; trade: VenueTrade; emission: Wp280Emission }> {
  const r0 = await boundReady();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const collateral = r0.u.world.collateral;
  const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
  const emission = wp280Emit(makerTrade(trade, "MATCHED", extra), options);
  deliver(r0.p.coordinator, r0.backlog, emission, { outputTaken: delivery === "OUTPUT" });
  await r0.p.coordinator.settled();
  r0.u.world.cancel(trade.venueOrderId);
  lagEveryRead(r0, collateral);
  return { r: withRestart ? await restarted(r0) : r0, trade, emission };
}

/**
 * (E) An UNKNOWN submission the venue took (LIVE); WP-280's ORDER output for it names the order with `status` as given
 * (`null`: absent, so `observation: null`); the list reads replay a snapshot taken before the submission; the by-id
 * read is truthful, or (`byIdLags`) does not find the order either.
 */
async function unknownOrderThenLag(wireStatus: string | null, delivery: "OUTPUT" | "REQUEST_ONLY", withRestart: boolean, byIdLags: boolean): Promise<{ r: Bound; attempt: string | null; venueOrderId: string; emission: Wp280Emission }> {
  const r0 = await boundReady();
  const stale = await snapshot(r0, null);
  r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
  const attempt = await submitOne(r0.oms);
  const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
  expect(order.status).toBe("LIVE");
  const emission = wp280Emit(wireOrder({ id: order.venueOrderId, assetId: order.tokenId, side: order.side, originalSize: order.original, sizeMatched: order.matched, price: order.price, status: wireStatus }));
  deliver(r0.p.coordinator, r0.backlog, emission, { outputTaken: delivery === "OUTPUT" });
  await r0.p.coordinator.settled();
  r0.u.world.faults = byIdLags ? { ...stale, readOrder: () => ({ route: "/data/order", found: false }) } : stale;
  return { r: withRestart ? await restarted(r0) : r0, attempt, venueOrderId: order.venueOrderId, emission };
}

describe("WP-290 r14 (WP290-V14-WP280-EVENT-IDS-DISCARDED): WP-280's own empty projections and event-level requests carry the event's identities", () => {
  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";

    for (const wireStatus of ["Failed", "TRADE_STATUS_REVERTED", "MATCHED_NOT_BROADCASTED"]) {
      it(`(P14-A "${wireStatus}"${tag}) a FAILED trade's event under a status WP-280 does not recognise (an empty projection and its request), then the reads lag behind the failure: never resumed; once truthful, the failure is held`, async () => {
        const { r, trade, emission } = await failedThenLag(wireStatus, "OUTPUT", withRestart);
        expect(emission.shortfalls).toEqual([wireStatus === "MATCHED_NOT_BROADCASTED" ? "TRADE_STATUS_C3" : "TRADE_STATUS_UNRECOGNIZED"]);
        // c3cb404: resumed with the failure missed (collateral 999.8 projected vs 1000; token 0.4 vs 0).
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(r.backlog.acknowledged).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("SETTLEMENT_FAILED");
        // The mechanism, asserted last: the trade, stream-named, its status unordered.
        expect(streamEvidence(r).filter((entry) => entry[0] === "TRADE")).toContainEqual(["TRADE", "STREAM_TRADE", null, trade.venueTradeId, null, expect.arrayContaining(["status"])]);
      });
    }

    it(`(P14-A, the output alone${tag}) the same FAILED event, its request never received: the output's event alone marks the trade; never resumed on the lagging reads`, async () => {
      const { r } = await failedThenLag("TRADE_STATUS_REVERTED", "OUTPUT_ONLY", withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
    });

    it(`(P14-A, EVENT_NOT_DELIVERED${tag}) the same FAILED event not taken by the listener: only WP-280's two requests name it; never resumed on the lagging reads`, async () => {
      const { r } = await failedThenLag("Failed", "REQUEST_ONLY", withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(r.backlog.acknowledged).toEqual([]);
    });

    for (const [name, options, extra, shortfall] of [
      ["B: maker ownership undetermined (no isAccountOwner)", {}, {}, "MAKER_LEG_OWNERSHIP_UNDETERMINED"],
      ["C: trader side unknown (\"BOGUS\")", OURS, { traderSide: "BOGUS" }, "TRADER_SIDE_UNKNOWN"],
      ["C: trader side absent", OURS, { traderSide: null }, "TRADER_SIDE_UNKNOWN"],
      ["C: our maker leg listed twice", OURS, { makerOwners: [OUR_OWNER, OUR_OWNER] }, "DUPLICATE_OWN_MAKER_LEG"],
    ] as const) {
      it(`(P14-${name}${tag}${withRestart ? "; r15 restated" : ""}) a maker fill WP-280 cannot attribute (an empty projection and its request), then every read lags: never resumed, nothing lost; the reads catch up: delivered, acknowledged, resumed${withRestart ? " once the trade is shown terminal" : ""}`, async () => {
        const { r, trade, emission } = await fillThenLag(options, extra, "OUTPUT", withRestart);
        expect(emission.shortfalls).toContain(shortfall);
        expect((emission.output["oms"] as { settlements: unknown[] }).settlements).toEqual([]);
        // c3cb404: resumed with the fill lost (OMS 0 vs venue 0.4; collateral 1000 vs 999.8; token 0 vs 0.4).
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(r.backlog.acknowledged).toEqual([]);
        r.u.world.faults = {};
        if (withRestart) await heldUntilTerminal(r, trade);
        expect(await reconcileRounds(r, 6)).toBe(true);
        expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
        expect(oracle(r)).toEqual([]);
        expect(r.backlog.acknowledged).toEqual([must(emission.request, "request").requestId]);
      });
    }

    it(`(P14-B, EVENT_NOT_DELIVERED${tag}) the same unattributable fill, its output not taken: only the requests name it; never resumed; caught up, delivered; the event's status unknown, it holds until the trade is shown terminal`, async () => {
      const { r, trade } = await fillThenLag({}, {}, "REQUEST_ONLY", withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      // The undelivered event's status is unknown (it could have been FAILED): held, nothing delivered from a read
      // that may be behind it, while the reads show MATCHED; once shown terminal, delivered and resumed.
      expect(await anyResumed(r, 3)).toBe(false);
      expect(oracle(r)).toEqual([]);
      trade.status = "CONFIRMED";
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(oracle(r)).toEqual([]);
    });

    it(`(P14-D, control: our maker leg determined${tag}${withRestart ? "; r15 restated" : ""}) WP-280 projects the MATCHED settlement (no fill: MAKER_FEE_NOT_ON_STREAM): held on the lagging reads, delivered once they catch up${withRestart ? " and the trade is shown terminal" : ""}`, async () => {
      const { r, trade, emission } = await fillThenLag(OURS, {}, "OUTPUT", withRestart);
      expect(emission.shortfalls).toEqual(["MAKER_FEE_NOT_ON_STREAM"]);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      if (withRestart) await heldUntilTerminal(r, trade);
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(oracle(r)).toEqual([]);
    });

    for (const byIdLags of [false, true]) {
      const how = byIdLags ? "its by-id read lagging too (not found)" : "its by-id read truthful";
      it(`(P14-E${tag}, ${how}) an UNKNOWN submission the venue holds, WP-280's ORDER event for it with no status (observation null): never ABSENT; answered PRESENT once found`, async () => {
        const { r, attempt, venueOrderId, emission } = await unknownOrderThenLag(null, "OUTPUT", withRestart, byIdLags);
        expect(emission.shortfalls).toEqual(["ORDER_STATUS_ABSENT"]);
        await anyResumed(r, 4);
        // c3cb404: ABSENT accepted for the order the venue holds (R2), and R1.
        expect(absentAnswers(r, attempt)).toBe(0);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        await anyResumed(r, 3);
        // A by-id read that did not find a NAMED order made it a ghost (ORDER_NOT_FOUND_BY_ID): an operator's release,
        // once the venue shows the order, acknowledges that history.
        if (byIdLags) expect(await releaseAll(r, "the venue shows the order now")).toBeGreaterThan(0);
        expect(await reconcileRounds(r, 6)).toBe(true);
        expect(absentAnswers(r, attempt)).toBe(0);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => `${answer.verdict} ${String(answer.venueOrderId)}`)).toContain(`PRESENT ${venueOrderId}`);
        expect(oracle(r)).toEqual([]);
        expect(streamEvidence(r)).toContainEqual(["ORDER", "STREAM_ORDER", venueOrderId, null, null, expect.arrayContaining(["status"])]);
      });
    }

    it(`(P14-E, EVENT_NOT_DELIVERED${tag}) the same ORDER event not taken: only the request names the order: never ABSENT`, async () => {
      const { r, attempt } = await unknownOrderThenLag(null, "REQUEST_ONLY", withRestart, true);
      await anyResumed(r, 4);
      expect(absentAnswers(r, attempt)).toBe(0);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      await anyResumed(r, 3);
      expect(await releaseAll(r, "the venue shows the order now")).toBeGreaterThan(0);
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(absentAnswers(r, attempt)).toBe(0);
      expect(oracle(r)).toEqual([]);
    });

    it(`(P14-E, control: status LIVE${tag}) the same event with its status: never ABSENT, PRESENT`, async () => {
      const { r, attempt } = await unknownOrderThenLag("LIVE", "OUTPUT", withRestart, false);
      await anyResumed(r, 4);
      expect(absentAnswers(r, attempt)).toBe(0);
      expect(oracle(r)).toEqual([]);
    });
  }
});

describe("WP-290 r14: an identity WP-280 names that cannot be read is an obligation of the account", () => {
  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";
    for (const [name, shape, expected] of [
      ["the output's event missing", (output: Row) => ({ kind: output["kind"], oms: output["oms"] }), ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["event"]]],
      ["the output's event an accessor", (output: Row) => Object.defineProperty({ kind: output["kind"], oms: output["oms"] }, "event", { get: () => output["event"], enumerable: true }), ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["event"]]],
      ["the event's trade id unreadable", (output: Row) => ({ ...output, event: { ...(output["event"] as Row), venueTradeId: 7 } }), ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["venueTradeId"]]],
    ] as const) {
      it(`(P14-UNREADABLE, ${name}${tag}) an unattributable fill's output whose event cannot be read (its request lost): a durable obligation; never resumed, before or after the reads catch up`, async () => {
        const r0 = await boundReady();
        await submitOne(r0.oms);
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const collateral = r0.u.world.collateral;
        const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
        const emission = wp280Emit(makerTrade(trade, "MATCHED"), {});
        r0.p.coordinator.onUserStreamOutput(shape(emission.output));
        await r0.p.coordinator.settled();
        r0.u.world.cancel(trade.venueOrderId);
        lagEveryRead(r0, collateral);
        const r = withRestart ? await restarted(r0) : r0;
        // c3cb404: resumed with the fill lost.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(streamEvidence(r).filter((entry) => entry[1] === "STREAM_UNREADABLE").map((entry) => [entry[0], entry[1], entry[5]])).toEqual([expected]);
      });
    }

    it(`(P14-UNREADABLE, an ORDER event's order id unreadable${tag}) an UNKNOWN submission's ORDER output with no status whose event's id cannot be read: an obligation; never ABSENT`, async () => {
      const r0 = await boundReady();
      const stale = await snapshot(r0, null);
      r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      const attempt = await submitOne(r0.oms);
      const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
      const emission = wp280Emit(wireOrder({ id: order.venueOrderId, assetId: order.tokenId, side: order.side, originalSize: order.original, sizeMatched: order.matched, price: order.price, status: null }));
      r0.p.coordinator.onUserStreamOutput({ ...emission.output, event: { ...(emission.output["event"] as Row), venueOrderId: ["not an id"] } });
      await r0.p.coordinator.settled();
      r0.u.world.faults = { ...stale, readOrder: () => ({ route: "/data/order", found: false }) };
      const r = withRestart ? await restarted(r0) : r0;
      expect(await anyResumed(r, 4)).toBe(false);
      expect(absentAnswers(r, attempt)).toBe(0);
      expect(oracle(r)).toEqual([]);
      expect(streamEvidence(r).filter((entry) => entry[1] === "STREAM_ORDER_UNKEYED").map((entry) => entry[0])).toEqual(["UNKEYED_ORDER"]);
    });

    for (const [name, request, expected] of [
      ["EVENT_NOT_DELIVERED, its trade id a number", { cause: "EVENT_NOT_DELIVERED", venueOrderIds: [], venueTradeId: 7, shortfalls: [] }, ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["venueTradeId"]]],
      ["EVENT_NOT_DELIVERED, its order ids not a list", { cause: "EVENT_NOT_DELIVERED", venueOrderIds: "venue-1", venueTradeId: null, shortfalls: [] }, ["UNKEYED_ORDER", "STREAM_ORDER_UNKEYED", ["venueOrderId"]]],
      ["EVENT_NOT_FULLY_APPLICABLE naming nothing", { cause: "EVENT_NOT_FULLY_APPLICABLE", venueOrderIds: [], venueTradeId: null, shortfalls: ["TRADER_SIDE_UNKNOWN"] }, ["UNKEYED_ORDER", "STREAM_ORDER_UNKEYED", ["venueOrderId"]]],
      ["a cause outside WP-280's vocabulary, its identity fields missing", { cause: "EVENT_NOT_DELIVERED " }, ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["venueTradeId"]]],
    ] as const) {
      it(`(P14-REQUEST-UNREADABLE, ${name}${tag}) the only word of an unattributable fill is a request whose identity cannot be read: a durable obligation; never resumed, never acknowledged`, async () => {
        const r0 = await boundReady();
        await submitOne(r0.oms);
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const collateral = r0.u.world.collateral;
        const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
        const raised = Object.freeze({ requestId: "r14-garbled", afterLoss: null, markets: [], subscriptionGeneration: 1, unrecognized: null, requestedAt: null, ...request });
        r0.backlog.pending.push(raised as never);
        r0.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request: raised });
        await r0.p.coordinator.settled();
        r0.u.world.cancel(trade.venueOrderId);
        lagEveryRead(r0, collateral);
        const r = withRestart ? await restarted(r0) : r0;
        // c3cb404: a bare trigger, acknowledged after one run; resumed with the fill lost.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(r.backlog.acknowledged).toEqual([]);
        expect(streamEvidence(r).filter((entry) => entry[1] === "STREAM_UNREADABLE" || entry[1] === "STREAM_ORDER_UNKEYED").map((entry) => [entry[0], entry[1], entry[5]])).toEqual([expected]);
      });
    }
  }
});

describe("WP-290 r14: a WP-280 request is acknowledged only once a run has judged everything it named", () => {
  it("(P14-ACK, a trade) the request naming an unattributable fill's trade is not acknowledged while the reads lag; acknowledged by the run that shows the trade", async () => {
    const { r, emission } = await fillThenLag({}, {}, "OUTPUT", false);
    const requestId = must(emission.request, "request").requestId;
    const runs = [];
    for (let round = 0; round < 3; round += 1) runs.push(await r.p.coordinator.reconcile());
    expect(runs.some((report) => report.resumed)).toBe(false);
    expect(r.backlog.acknowledged).toEqual([]);
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(1);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(r.backlog.acknowledged).toEqual([requestId]);
    expect(oracle(r)).toEqual([]);
  });

  it("(P14-ACK, an order) the request naming an order the by-id read does not find (a ghost) is not acknowledged; once the order is found by id, it is (the ghost's quarantine is the operator's)", async () => {
    const { r, emission } = await unknownOrderThenLag(null, "OUTPUT", false, true);
    const requestId = must(emission.request, "request").requestId;
    await anyResumed(r, 3);
    expect(r.backlog.acknowledged).toEqual([]);
    r.u.world.faults = {};
    await anyResumed(r, 2);
    expect(r.backlog.acknowledged).toEqual([requestId]);
    expect(await releaseAll(r, "the venue shows the order now")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(P14-ACK, liveness) a request naming an order the evidence already settled (canceled, nothing matched: no longer listed or read by id, and no new fact) is acknowledged by the next complete run", async () => {
    const r = await boundReady();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const order = must(r.u.world.orders.get(must(r.u.world.receipts.at(-1), "receipt")), "venue order");
    r.u.world.cancel(order.venueOrderId);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.orders()[0]?.state).toBe("CANCELED");
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(0);
    const emission = wp280Emit(wireOrder({ id: order.venueOrderId, assetId: order.tokenId, side: order.side, originalSize: order.original, sizeMatched: order.matched, price: order.price, status: "LIVE" }));
    deliver(r.p.coordinator, r.backlog, emission, { outputTaken: false });
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.backlog.acknowledged).toEqual([must(emission.notDelivered, "request").requestId]);
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(0);
    expect(oracle(r)).toEqual([]);
  });

  it("(P14-RECEIPT, during a run) after the run's last read, the venue matches an unattributable fill and WP-280's requests name its trade (its output not taken); from then on every read lags: the next run of the same reconcile holds (what the requests named is taken in before it reads)", async () => {
    const r = await boundReady();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const collateral = r.u.world.collateral;
    const salt = must(r.u.world.receipts.at(-1), "receipt");
    let fired = false;
    r.u.world.faults.onRead = (name) => {
      if (name !== "readApprovals" || fired) return;
      fired = true;
      const trade = must(r.u.world.match(salt, "0.4", { status: "MATCHED" }), "match");
      r.u.world.cancel(trade.venueOrderId);
      lagEveryRead(r, collateral);
      deliver(r.p.coordinator, r.backlog, wp280Emit(makerTrade(trade, "MATCHED"), {}), { outputTaken: false });
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(fired).toBe(true);
    expect(report.runs.length).toBeGreaterThan(1);
    // c3cb404: the requests are bare triggers; the next run, on reads that lag, resumes with the fill lost (R1).
    expect(report.resumed).toBe(false);
    expect(oracle(r)).toEqual([]);
    expect(await anyResumed(r, 3)).toBe(false);
    expect(oracle(r)).toEqual([]);
    // The mechanism, asserted last: the next run of the same reconcile journaled the trade the requests named, before
    // it read (its evidence load), not the stream chain after the reconcile.
    const journaled = r.p.journal.events().filter((event) => event.kind === "EVIDENCE_RECORDED" && event.source === "STREAM_TRADE").map((event) => (event.kind === "EVIDENCE_RECORDED" ? event.runId : "?"));
    expect(journaled[0]).toBe(report.runs[1]?.runId);
  });

  it("(P14-ORPHAN) WP-280's empty projection of an unattributable maker fill whose event, corrupted in transit, calls the leg OWN but names no readable order (its request lost): an ORPHAN_LEG of the trade is journaled; held on the lagging reads; caught up, the trade shown with its leg answers it", async () => {
    const r = await boundReady();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const collateral = r.u.world.collateral;
    const trade = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
    const emission = wp280Emit(makerTrade(trade, "MATCHED"), {});
    expect(emission.shortfalls).toEqual(["MAKER_LEG_OWNERSHIP_UNDETERMINED"]);
    const output = emission.output;
    const event = output["event"] as Row;
    r.p.coordinator.onUserStreamOutput({ ...output, event: { ...event, makerOrders: (event["makerOrders"] as Row[]).map((maker) => ({ ...maker, venueOrderId: "", account: "OWN" })) } });
    await r.p.coordinator.settled();
    r.u.world.cancel(trade.venueOrderId);
    lagEveryRead(r, collateral);
    // c3cb404: the empty projection is nothing; resumed with the fill lost (R1).
    expect(await anyResumed(r, 4)).toBe(false);
    expect(oracle(r)).toEqual([]);
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind === "ORPHAN_LEG").map((record) => [record.source, record.venueTradeId])).toEqual([["STREAM_SETTLEMENT_ORPHAN", trade.venueTradeId]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    expect(oracle(r)).toEqual([]);
  });

  it("(P14-ACK, control: a stream-level request) a reconnect request names nothing: acknowledged by id after one complete run, as before", async () => {
    const r = await boundReady();
    const request = Object.freeze({ requestId: "r14-reconnect", cause: "SOCKET_CLOSED", afterLoss: null, markets: [], subscriptionGeneration: 1, shortfalls: [], unrecognized: null, venueOrderIds: [], venueTradeId: null, requestedAt: null });
    r.backlog.pending.push(request as never);
    r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
    expect(r.backlog.acknowledged).toEqual(["r14-reconnect"]);
  });

  it("(P14, control: a trade's counterparty orders) the orders a trade's request names are not read as the account's: no ghost; resumed once the trade is shown", async () => {
    const { r } = await fillThenLag({}, {}, "OUTPUT", false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(r.p.journal.evidence().some((record) => record.venueOrderId === "their-taker-order-1")).toBe(false);
    expect(r.p.journal.breaks().some((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID")).toBe(false);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r14, the re-audit: an activity output received during a run is work that arrived during it", () => {
  for (const when of ["RUN_COMPLETED", "readApprovals"] as const) {
    it(`(P14-BUFFER, ${when === "RUN_COMPLETED" ? "while the PASSED record is written" : "after the reads"}) a match and WP-280's fill output arrive during the run: that run does not resume with the fill unapplied; the next run routes it first`, async () => {
      const r = await ready();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const salt = must(r.u.world.receipts.at(-1), "receipt");
      let fired = false;
      const fire = (): void => {
        if (fired) return;
        fired = true;
        const trade = must(r.u.world.match(salt, "0.4"), "match");
        r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade.venueTradeId));
      };
      r.p.coordinator.trigger("PERIODIC_TIMER");
      if (when === "RUN_COMPLETED") {
        const original = r.p.journal.append.bind(r.p.journal);
        r.p.journal.append = async (event: unknown) => {
          const entry = event as { kind?: string; status?: string };
          if (entry.kind === "RUN_COMPLETED" && entry.status === "PASSED") fire();
          return original(event as never);
        };
      } else {
        r.u.world.faults.onRead = (name) => {
          if (name === when) fire();
        };
      }
      const report = await r.p.coordinator.reconcile();
      await r.p.coordinator.settled();
      // c3cb404: the first run resumed with the fill in its buffer (R1: OMS 0 vs venue 0.4).
      expect(oracle(r)).toEqual([]);
      expect(report.runs[0]?.resumed).toBe(false);
      // The same reconcile's next run routes the fill before it reads, and (the reads truthful) resumes.
      expect(report.resumed).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(await reconcileRounds(r, 3)).toBe(true);
      expect(oracle(r)).toEqual([]);
    });
  }
});

describe("WP-290 r14 units: the stream door's event and request reads", () => {
  it("(P14, the request door; r15 restated) every identity is read on its own; required for an event-level or unknown cause; an event-level request naming nothing is unreadable; the status is RECOGNISED (never ordered by the request alone: WP290-V15-EFA-REQUEST-STATUS-ASSUMED) only for EVENT_NOT_FULLY_APPLICABLE with no status shortfall", () => {
    const base = { requestId: "q1", afterLoss: null, markets: ["m"], subscriptionGeneration: 1, unrecognized: null, requestedAt: null };
    const read = (fields: Row): unknown => {
      const out = readStreamRequest({ ...base, ...fields });
      return [out.requestId, out.cause, out.eventCause, out.venueTradeId, out.venueOrderIds, out.statusRecognised, out.unreadable];
    };
    expect(read({ cause: "EVENT_NOT_FULLY_APPLICABLE", venueTradeId: "t1", venueOrderIds: ["a", "b"], shortfalls: ["MAKER_FEE_NOT_ON_STREAM"] })).toEqual(["q1", "EVENT_NOT_FULLY_APPLICABLE", true, "t1", ["a", "b"], true, []]);
    expect(read({ cause: "EVENT_NOT_FULLY_APPLICABLE", venueTradeId: "t1", venueOrderIds: ["a"], shortfalls: ["TRADE_STATUS_C3"] })).toEqual(["q1", "EVENT_NOT_FULLY_APPLICABLE", true, "t1", ["a"], false, []]);
    expect(read({ cause: "EVENT_NOT_FULLY_APPLICABLE", venueTradeId: "t1", venueOrderIds: ["a"], shortfalls: ["NOT_A_SHORTFALL"] })).toEqual(["q1", "EVENT_NOT_FULLY_APPLICABLE", true, "t1", ["a"], false, []]);
    expect(read({ cause: "EVENT_NOT_DELIVERED", venueTradeId: "t1", venueOrderIds: ["a"], shortfalls: [] })).toEqual(["q1", "EVENT_NOT_DELIVERED", true, "t1", ["a"], false, []]);
    expect(read({ cause: "EVENT_NOT_DELIVERED", venueTradeId: null, venueOrderIds: ["venue-9"], shortfalls: [] })).toEqual(["q1", "EVENT_NOT_DELIVERED", true, null, ["venue-9"], false, []]);
    expect(read({ cause: "EVENT_NOT_DELIVERED", venueTradeId: null, venueOrderIds: [], shortfalls: [] })).toEqual(["q1", "EVENT_NOT_DELIVERED", true, null, [], false, ["venueOrderIds"]]);
    expect(read({ cause: "EVENT_NOT_DELIVERED" })).toEqual(["q1", "EVENT_NOT_DELIVERED", true, null, [], false, ["shortfalls", "venueOrderIds", "venueTradeId"]]);
    expect(read({ cause: "EVENT_NOT_DELIVERED", venueTradeId: 7, venueOrderIds: ["a", 8, "has space"], shortfalls: [] })).toEqual(["q1", "EVENT_NOT_DELIVERED", true, null, ["a"], false, ["venueOrderIds", "venueTradeId"]]);
    // A stream-level cause: nothing required, nothing named; a missing field is nothing (WP-280 carries none).
    expect(read({ cause: "SOCKET_CLOSED" })).toEqual(["q1", "SOCKET_CLOSED", false, null, [], false, []]);
    expect(read({ cause: "SOCKET_CLOSED", venueTradeId: null, venueOrderIds: [], shortfalls: [] })).toEqual(["q1", "SOCKET_CLOSED", false, null, [], false, []]);
    // A cause outside WP-280's vocabulary (or unreadable): the fields are required.
    expect(read({ cause: "event_not_delivered" })).toEqual(["q1", "event_not_delivered", false, null, [], false, ["shortfalls", "venueOrderIds", "venueTradeId"]]);
    expect(read({ cause: 7, venueTradeId: "t1", venueOrderIds: [], shortfalls: [] })).toEqual(["q1", null, false, "t1", [], false, []]);
    // An accessor is not own data: the request is malformed (`opaque`), and its identities are still read.
    const accessor = { ...base, cause: "EVENT_NOT_DELIVERED", venueOrderIds: [], venueTradeId: "t1" };
    Object.defineProperty(accessor, "requestId", { get: () => "q1", enumerable: true });
    expect(readStreamRequest(accessor)).toMatchObject({ requestId: null, opaque: true, venueTradeId: "t1" });
  });

  it("(P14, the output door) an empty projection or a shortfall makes the event required; a whole projection's event is read but not required; an unreadable required identity is an entry", () => {
    const event = { venueTradeId: "t1", takerOrderId: "their-1", status: { kind: "KNOWN", value: "MATCHED" }, traderSide: { kind: "KNOWN", value: "MAKER" }, makerOrders: [{ venueOrderId: "venue-1", account: "OWN" }], transactionHash: null };
    const settlement = { venueTradeId: "t1", venueOrderId: "venue-1", status: "MATCHED", transactionHash: null };
    const entries = (output: unknown): string[] => readStreamOutput(output).unreadable.map((entry) => `${entry.kind}:${entry.field}`);
    expect(entries({ kind: "TRADE", oms: { fills: [], settlements: [settlement], shortfalls: [] } })).toEqual([]);
    expect(entries({ kind: "TRADE", oms: { fills: [], settlements: [settlement], shortfalls: ["MAKER_FEE_NOT_ON_STREAM"] } })).toEqual(["FILL:event"]);
    expect(entries({ kind: "TRADE", oms: { fills: [], settlements: [settlement], shortfalls: "none" } })).toEqual(["FILL:event"]);
    expect(entries({ kind: "TRADE", oms: { fills: [], settlements: [], shortfalls: [] } })).toEqual(["FILL:event"]);
    expect(entries({ kind: "TRADE", event: { ...event, venueTradeId: "" }, oms: { fills: [], settlements: [], shortfalls: ["TRADER_SIDE_UNKNOWN"] } })).toEqual(["FILL:venueTradeId"]);
    expect(entries({ kind: "TRADE", event: { ...event, venueTradeId: "" }, oms: { fills: [], settlements: [settlement], shortfalls: [] } })).toEqual([]);
    expect(entries({ kind: "ORDER", oms: { observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] } })).toEqual(["ORDER:event"]);
    expect(entries({ kind: "ORDER", event: { venueOrderId: 7 }, oms: { observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] } })).toEqual(["ORDER:venueOrderId"]);
    // A projection key unreadable already carries the output's obligation: the event is read, not required.
    expect(entries({ kind: "TRADE", oms: { fills: 7, settlements: [], shortfalls: ["X"] } })).toEqual(["FILL:fills"]);
    const whole = readStreamOutput({ kind: "TRADE", event, oms: { fills: [], settlements: [settlement], shortfalls: [] } });
    expect(whole.event).toMatchObject({ kind: "TRADE", required: false, venueTradeId: "t1", status: "MATCHED", ordered: true, ownOrderIds: ["venue-1"], ownOrphans: 0, legsDetermined: true });
    const undetermined = readStreamOutput({ kind: "TRADE", event: { ...event, makerOrders: [{ venueOrderId: "venue-1", account: "UNDETERMINED" }] }, oms: { fills: [], settlements: [], shortfalls: ["MAKER_LEG_OWNERSHIP_UNDETERMINED"] } });
    expect(undetermined.event).toMatchObject({ required: true, ownOrderIds: [], legsDetermined: false, ordered: true });
    const unordered = readStreamOutput({ kind: "TRADE", event: { ...event, status: { kind: "UNRECOGNIZED", lexeme: "FAILED_X", reason: "NOT_IN_VERIFIED_VOCABULARY" } }, oms: { fills: [], settlements: [], shortfalls: ["TRADE_STATUS_UNRECOGNIZED"] } });
    expect(unordered.event).toMatchObject({ status: null, ordered: false, ownOrderIds: ["venue-1"] });
    expect(readStreamOutput({ kind: "TRADE", event: { ...event, traderSide: { kind: "KNOWN", value: "TAKER" }, takerOrderId: "venue-2" }, oms: { fills: [], settlements: [], shortfalls: ["OWN_MAKER_LEG_ON_TAKER_TRADE"] } }).event).toMatchObject({ ownOrderIds: ["venue-1", "venue-2"], legsDetermined: true });
  });

  it("(P14, the journal) a STREAM_TRADE record and the r14 unreadable names are accepted by the ledger's journal and read back by the coordinator's door", async () => {
    const r = await ready();
    const record = { kind: "EVIDENCE_RECORDED", runId: null, evidenceKind: "TRADE", venueOrderId: null, venueTradeId: "t-r14", provenance: "NAMED", source: "STREAM_TRADE", tokenId: null, side: null, price: null, originalSize: null, size: null, status: null, level: null, feeAmount: null, feeAssetId: null, role: null, matchedAt: null, unreadable: ["makerOrders", "shortfalls", "status", "takerOrderId", "traderSide", "venueOrderIds"], transactionHash: null, subject: null, value: "UNDETERMINED", atMs: r.u.clock.t };
    expect(((await r.p.journal.append(record as never)) as { ok: boolean }).ok).toBe(true);
    expect(((await r.p.journal.append({ ...record, provenance: "SHOWN" } as never)) as { ok: boolean }).ok).toBe(false);
    expect(readEvidenceRecords(r.p.journal.evidence())?.at(-1)).toMatchObject({ evidenceKind: "TRADE", source: "STREAM_TRADE", provenance: "NAMED", unreadable: record.unreadable });
  });
});
