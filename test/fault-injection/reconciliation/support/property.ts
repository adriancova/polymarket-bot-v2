/**
 * WP-290 r6: the SEEDED RANDOMIZED PROPERTY over the simulated venue and the real OMS, Ledger, journal and
 * inventory (`property-*.test.ts` run it over 4000 seeds, 1 to 4000).
 *
 * Each seed draws, from a seeded generator, a random interleaving of:
 * - submissions with every placement outcome (accepted, a lost answer the venue took or never got, a late arrival,
 *   not sent);
 * - venue activity: matches (settled or in transit), settlement steps, FAILED settlements, cancels, foreign orders
 *   (exact twins of the account's own, and others), unexplained holding changes;
 * - the user stream: an order's observation, a trade's fill (retained by the OMS while an attempt could own it), a
 *   phantom id, and a fill reported again with other economics (a repeated OMS halting alert);
 * - a ledger transaction with UNATTRIBUTED arrivals in two markets;
 * - every read source and answer shape: complete, partial, duplicated, sibling-malformed, by-id found, not found,
 *   thrown or regressing, trades complete, partial, malformed or lagging, positions and collateral failing;
 * - clock faults at a random await of a run (a read, or an OMS write: the fault is DETECTED there, through an
 *   operator's release that reads the clock, as the r6 reproduction did);
 * - crashes at a random port call (a restart with a kill plan) and plain restarts;
 * - truthful operator releases (an operator who never releases what the venue contradicts).
 *
 * THE ORACLES, checked after every step:
 * - R1 (`harness.ts`): resumed only when consistent (nothing lost, nothing double counted, reservations conserved),
 *   and, at every step, no OMS order holds more fill than its venue order matched, and every reservation conserves;
 * - R2: ABSENT is never accepted for an order the venue holds or may still receive; R3: PRESENT names the attempt's
 *   own order. The one exemption is the disclosed identity limit (I-12 and `identity.ts`'s KNOWN LIMIT): the
 *   attempt's own venue order was canceled with nothing matched and NO source ever observed it (no evidence record
 *   names it, the stream never named it): no read can tell it from a foreign twin or from nothing. Counted;
 * - no break is resolved in a run whose reads a detectable fault touched (an unusable answer, a failed read), nor
 *   after a clock fault was injected into that run, nor one naming a venue object a lie touched in that run;
 * - no run resumes when a detectable fault or a clock fault touched it;
 * - no halt obligation is lost or collapsed: after a final truthful settling phase, every ledger arrival and every
 *   OMS halting alert has its own break, and every quarantined break's halt was delivered.
 *
 * PAPER only: every port is in-memory; no network, key or signer.
 */

import { addDecimal, compareDecimal } from "../../../../packages/decimal/src/index.js";
import { projectLedger, projectedHoldings } from "../../../../packages/ledger/src/index.js";
import { compositeKey } from "../../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../../packages/oms/src/index.js";
import { decodeCompositeKey } from "../../../../packages/oms/src/reconciliation/subjects.js";
import { venueIdFor } from "../../../unit/oms/support/fake-venue.js";
import { uuid7 } from "../../../unit/oms/support/ids.js";

import { ACCOUNT, Killed, MARKET, MARKET_NO, NO, YES, bookReversal, boot, streamTrade, universe, type Process, type Universe } from "./harness.js";
import { G_YES, sequence, submitOne } from "./scenario.js";
import type { ReadFaults, Transmission, VenueOrder, VenueTrade } from "./world.js";

/** A seeded generator (mulberry32): the same seed always draws the same scenario. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fired {
  readonly runId: string | null;
  readonly kind: string;
  /** A detectable fault (an unusable answer, a failed read): the run must conclude nothing. */
  readonly detectable: boolean;
  /** The venue object a lie touched (by-id not found, a regressing read): no break naming it may be resolved. */
  readonly object: string | null;
}

export interface SeedResult {
  readonly seed: number;
  readonly violations: readonly string[];
  readonly exemptions: number;
  readonly resumes: number;
  readonly runs: number;
  readonly steps: readonly string[];
}

const READ_SHAPE_CLASSES: readonly string[] = ["READ_MISSING", "READ_MALFORMED", "READ_INCOMPLETE", "READ_WRONG_ROUTE"];
const TRANSMISSIONS: readonly Transmission[] = ["ACCEPT_LIVE", "ACCEPT_LIVE", "UNKNOWN_EXISTS", "UNKNOWN_EXISTS", "UNKNOWN_ABSENT", "LATE_ARRIVAL", "NOT_SENT"];
const SHARES = ["0.1", "0.2", "0.4", "1"] as const;

class Sim {
  readonly u: Universe;
  p: Process;
  readonly rand: () => number;
  readonly steps: string[] = [];
  readonly violations: string[] = [];
  readonly fired: Fired[] = [];
  exemptions = 0;
  runs = 0;
  #clockFaults = 0;
  #phantoms = 0;
  #attempts = 0;
  /** The journal position at which a clock fault was injected, per run id. */
  readonly clockFaultAt = new Map<string, number>();
  /** Arms a clock fault at the n-th intercepted await of the next reconciliation (0: none). */
  #clockArm = 0;
  #intercepted = 0;

  private constructor(u: Universe, p: Process, rand: () => number) {
    this.u = u;
    this.p = p;
    this.rand = rand;
  }

  static async start(seed: number): Promise<Sim> {
    const u = universe();
    const p = await boot(u);
    const sim = new Sim(u, p, seeded(seed));
    sim.#instrument();
    sim.#install();
    await sim.p.coordinator.reconcile();
    const oms = sim.p.oms as OrderManager;
    await oms.registerGroup(G_YES);
    return sim;
  }

  pick<T>(list: readonly T[]): T | undefined {
    return list.length === 0 ? undefined : list[Math.floor(this.rand() * list.length)];
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }

  get oms(): OrderManager | null {
    return this.p.oms;
  }

  /** The run the journal shows RUNNING now, if any. */
  currentRun(): string | null {
    for (let index = this.u.journalEvents.length - 1; index >= 0; index -= 1) {
      const event = this.u.journalEvents[index];
      if (event?.kind === "RUN_COMPLETED") return null;
      if (event?.kind === "RUN_STARTED") return event.runId;
    }
    return null;
  }

  fire(kind: string, detectable: boolean, object: string | null = null): void {
    this.fired.push({ runId: this.currentRun(), kind, detectable, object });
  }

  /** Count every await a run makes through a read or an OMS write; inject the armed clock fault at its turn. */
  #instrument(): void {
    this.u.seams.localClock = (venueMs: number): number => {
      if (this.#clockFaults > 0) {
        this.#clockFaults -= 1;
        return Number.NaN;
      }
      return venueMs;
    };
    const oms = this.p.oms;
    if (oms === null) return;
    for (const name of ["recordFill", "applySettlement", "applyReconciliation", "applyOrderObservation", "requestOrderReconciliation"] as const) {
      const real = (oms[name] as (raw: never) => Promise<unknown>).bind(oms);
      Object.defineProperty(oms, name, {
        configurable: true,
        writable: true,
        value: async (raw: never): Promise<unknown> => {
          const result = await real(raw);
          this.intercept(`oms.${name}`);
          return result;
        },
      });
    }
  }

  /** One intercepted await: when it is the armed one, the clock faults and the coordinator detects it now. */
  intercept(where: string): void {
    if (this.#clockArm === 0) return;
    this.#intercepted += 1;
    if (this.#intercepted !== this.#clockArm) return;
    this.#clockArm = 0;
    const runId = this.currentRun();
    if (runId !== null && !this.clockFaultAt.has(runId)) this.clockFaultAt.set(runId, this.u.journalEvents.length);
    this.fire(`CLOCK@${where}`, true);
    this.#clockFaults = 1;
    // An operator's release attempted now reads the clock (synchronously): the fault is detected at this await.
    void this.p.coordinator.releaseQuarantine({ breakId: uuid7(0xdead, 1), operatorRef: "property", reason: "a release attempted while the clock faults" });
  }

  async restart(withKill: boolean): Promise<void> {
    const plan = withKill ? { at: 1 + Math.floor(this.rand() * 60), phase: this.chance(0.5) ? ("before" as const) : ("after" as const) } : null;
    this.steps.push(`RESTART${plan === null ? "" : `(kill ${plan.phase} call ${String(plan.at)})`}`);
    this.#pending.clear();
    try {
      this.p = await boot(this.u, plan);
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
    this.#instrument();
  }

  /** A process that died (a kill plan fired, or its OMS could not open) is replaced by a fresh one. */
  async ensureAlive(): Promise<void> {
    if (this.p.inc.alive && this.p.oms !== null) return;
    this.steps.push("REBOOT");
    this.#pending.clear();
    this.p = await boot(this.u);
    this.#instrument();
  }

  // ---- venue activity ---------------------------------------------------------------------------------------

  liveOrders(): VenueOrder[] {
    return [...this.u.world.orders.values()].filter((order) => order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0);
  }

  ownOrders(): VenueOrder[] {
    return [...this.u.world.orders.values()].filter((order) => !order.foreign);
  }

  /**
   * One submission. Every attempt signs its own economics (a distinct limit price), so a foreign order is an exact
   * twin of an attempt only when the twin step copies that attempt's observed order (see `foreign`): the disclosed
   * I-12 limit (a lone exact twin of an order no source ever observed) is not what this property measures.
   */
  async submit(): Promise<void> {
    const oms = this.oms;
    if (oms === null || oms.paused) return;
    const behavior = this.pick(TRANSMISSIONS) ?? "ACCEPT_LIVE";
    this.u.world.nextTransmission = sequence([behavior]);
    this.#attempts += 1;
    const limitPrice = `0.${String(40 + this.#attempts)}`;
    this.steps.push(`SUBMIT(${behavior}, ${limitPrice})`);
    try {
      await submitOne(oms, { limitPrice });
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
  }

  match(): void {
    const order = this.pick(this.liveOrders());
    if (order === undefined) return;
    const shares = this.pick(SHARES) ?? "0.1";
    const status = this.chance(0.5) ? "CONFIRMED" : this.chance(0.5) ? "MATCHED" : "MINED";
    this.steps.push(`MATCH(${order.venueOrderId}, ${shares}, ${status})`);
    this.u.world.match(order.salt, shares, { status });
  }

  settle(): void {
    const trade = this.pick(this.u.world.trades.filter((entry) => entry.status === "MATCHED" || entry.status === "MINED"));
    if (trade === undefined) return;
    if (this.chance(0.25)) {
      this.steps.push(`FAIL(${trade.venueTradeId})`);
      this.u.world.failTrade(trade);
      return;
    }
    const next = trade.status === "MATCHED" ? "MINED" : "CONFIRMED";
    this.steps.push(`SETTLE(${trade.venueTradeId}, ${next})`);
    trade.status = next;
  }

  /** A foreign order: an exact twin of an own order some source observed (60%), or another one. */
  foreign(): void {
    const observed = this.ownOrders().filter((order) => this.#observed(order.venueOrderId));
    const model = this.chance(0.6) ? this.pick(observed) : undefined;
    const facts =
      model !== undefined
        ? { tokenId: model.tokenId, side: model.side, price: model.price, size: model.original }
        : { tokenId: this.chance(0.5) ? YES : NO, side: this.chance(0.5) ? ("SELL" as const) : ("BUY" as const), price: "0.9", size: "3" };
    const order = this.u.world.placeForeign(facts);
    this.steps.push(`FOREIGN(${order.venueOrderId}${model !== undefined ? `, exact twin of ${model.venueOrderId}` : ""})`);
  }

  /**
   * THE OBSERVATION LEDGER (the property's own, independent of the coordinator under test): what the reads DELIVERED
   * to the coordinator (every row, valid or not, of every open-orders answer; every order a by-id read found; every
   * own leg of every trades answer) and what the stream routed to it, with the most matched each showed. An
   * observation counts once a run of that same process COMPLETED after it (before that, a crash may lose it, as
   * any process memory is lost): `#promote`. Lies and twins are drawn only against observed orders, and the
   * identity-limit exemption applies only to orders never observed.
   */
  readonly #pending = new Map<string, string>();
  readonly #seen = new Map<string, string>();

  saw(id: unknown, matched: unknown): void {
    if (typeof id !== "string") return;
    const amount = typeof matched === "string" && /^[0-9]+(\.[0-9]+)?$/u.test(matched) ? matched : "0";
    const earlier = this.#pending.get(id);
    if (earlier === undefined || compareDecimal(amount, earlier) > 0) this.#pending.set(id, amount);
  }

  #promote(): void {
    for (const [id, matched] of this.#pending) {
      const earlier = this.#seen.get(id);
      if (earlier === undefined || compareDecimal(matched, earlier) > 0) this.#seen.set(id, matched);
    }
    this.#pending.clear();
  }

  /** A completed run of a living process was shown this venue order matched (above zero). */
  matchedSeen(id: string): boolean {
    return compareDecimal(this.#seen.get(id) ?? "0", "0") > 0;
  }

  #observed(id: string): boolean {
    return this.#seen.has(id);
  }

  cancel(): void {
    const order = this.pick(this.liveOrders());
    if (order === undefined) return;
    this.steps.push(`CANCEL(${order.venueOrderId})`);
    this.u.world.cancel(order.venueOrderId);
  }

  adjust(): void {
    const delta = this.pick(["0.05", "0.3", "-0.05"]) ?? "0.05";
    if (this.chance(0.5)) {
      this.steps.push(`ADJUST(collateral ${delta})`);
      this.u.world.adjustCollateral(delta);
    } else {
      this.steps.push(`ADJUST(${YES} +0.3)`);
      this.u.world.adjustPosition(YES, "0.3");
    }
  }

  /** A ledger transaction with an UNATTRIBUTED arrival in each of two markets (the venue shows the same holdings). */
  ledgerTwoMarkets(): void {
    const id = this.u.ledgerIds();
    const entries = [
      { assetId: YES, marketId: MARKET },
      { assetId: NO, marketId: MARKET_NO },
    ].flatMap(({ assetId, marketId }) => [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-2" },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-2" },
    ]);
    const appended = this.u.ledger.append({ ledgerTransactionId: id, eventType: "RECONCILIATION_CORRECTION", environment: "PAPER", accountRef: ACCOUNT, source: "internal", occurredAt: "2026-10-03T00:00:00Z", entries });
    if (!appended.ok) throw new Error(`the two-market transaction was refused: ${JSON.stringify(appended.refusals)}`);
    this.u.ledger = appended.value.ledger;
    this.u.world.adjustPosition(YES, "2");
    this.u.world.adjustPosition(NO, "2");
    this.steps.push(`LEDGER(two markets, ${id})`);
  }

  // ---- the user stream --------------------------------------------------------------------------------------

  async stream(): Promise<void> {
    const roll = this.rand();
    if (roll < 0.15) {
      this.#phantoms += 1;
      const id = `venue-phantom-${String(this.#phantoms)}`;
      this.steps.push(`STREAM(order ${id}, phantom)`);
      this.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: id, status: "LIVE" }, shortfalls: [] } });
    } else if (roll < 0.5) {
      const order = this.pick(this.ownOrders());
      if (order === undefined) return;
      const full = compareDecimal(order.matched, order.original) === 0;
      const status = order.status === "CANCELED" ? "CANCELED" : full ? "MATCHED" : "LIVE";
      this.saw(order.venueOrderId, "0");
      this.steps.push(`STREAM(order ${order.venueOrderId} ${status})`);
      this.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status }, shortfalls: [] } });
    } else if (roll < 0.85) {
      const trade = this.pick(this.u.world.trades.filter((entry) => this.ownOrders().some((order) => order.venueOrderId === entry.venueOrderId)));
      if (trade === undefined) return;
      this.saw(trade.venueOrderId, trade.shares);
      this.steps.push(`STREAM(fill ${trade.venueTradeId})`);
      this.p.coordinator.onUserStreamOutput(streamTrade(this.u, trade.venueTradeId));
    } else {
      // A fill reported again with other economics: the OMS refuses it and raises a halting alert (repeated alerts).
      const trade = this.pick(this.u.world.trades);
      if (trade === undefined) return;
      this.steps.push(`STREAM(conflicting fill ${trade.venueTradeId})`);
      const output = streamTrade(this.u, trade.venueTradeId) as { kind: string; oms: { fills: Record<string, unknown>[] } };
      this.p.coordinator.onUserStreamOutput({ ...output, oms: { ...output.oms, fills: output.oms.fills.map((fill) => ({ ...fill, price: "0.01" })) } });
    }
    try {
      await this.p.coordinator.settled();
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
  }

  // ---- faults for the next run ------------------------------------------------------------------------------

  armFaults(): void {
    const faults: ReadFaults = {};
    const chosen: string[] = [];
    const count = 1 + Math.floor(this.rand() * 2);
    for (let index = 0; index < count; index += 1) {
      const roll = Math.floor(this.rand() * 14);
      const target = this.pick([...this.u.world.orders.values()]);
      const trade = this.pick(this.u.world.trades);
      switch (roll) {
        case 0:
          chosen.push("LIST_INCOMPLETE");
          faults.listOpenOrders = (answer) => {
            this.fire("LIST_INCOMPLETE", true);
            return { ...(answer() as Record<string, unknown>), complete: false };
          };
          break;
        case 1:
          chosen.push("LIST_MALFORMED_SIBLING");
          faults.listOpenOrders = (answer) => {
            this.fire("LIST_MALFORMED_SIBLING", true);
            const read = answer() as { orders: unknown[] };
            return { ...read, orders: [...read.orders, { venueOrderId: "broken-row", price: "not a price" }] };
          };
          break;
        case 2:
          chosen.push("LIST_DUPLICATE");
          faults.listOpenOrders = (answer) => {
            const read = answer() as { orders: unknown[] };
            if (read.orders.length === 0) return read;
            this.fire("LIST_DUPLICATE", true);
            return { ...read, orders: [...read.orders, read.orders[0]] };
          };
          break;
        case 3:
          // E-14's lag: the list leaves out an order a source already observed (its by-id read must still find it).
          // (A complete list leaving out a live order NO source ever observed hides it from every documented read
          // that does not name its id: the disclosed identity limit, outside this fault model.)
          if (target === undefined || !this.#observed(target.venueOrderId)) break;
          chosen.push(`LIST_OMIT(${target.venueOrderId})`);
          faults.listOpenOrders = (answer) => {
            const read = answer() as { orders: { venueOrderId: string }[] };
            return { ...read, orders: read.orders.filter((order) => order.venueOrderId !== target.venueOrderId) };
          };
          break;
        case 4:
          chosen.push("TRADES_INCOMPLETE");
          faults.listTrades = (answer) => {
            this.fire("TRADES_INCOMPLETE", true);
            return { ...(answer() as Record<string, unknown>), complete: false };
          };
          break;
        case 5:
          if (trade === undefined || !this.#observed(trade.venueOrderId)) break;
          chosen.push(`TRADES_OMIT(${trade.venueTradeId})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string }[] };
            return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade.venueTradeId) };
          };
          break;
        case 6:
          chosen.push("TRADES_MALFORMED_SIBLING");
          faults.listTrades = (answer) => {
            this.fire("TRADES_MALFORMED_SIBLING", true);
            const read = answer() as { trades: unknown[] };
            return { ...read, trades: [...read.trades, { venueTradeId: "broken-trade", status: "CONFIRMED", ownLegs: [{ venueOrderId: "broken-leg" }] }] };
          };
          break;
        case 7:
          if (target === undefined) break;
          chosen.push(`BYID_NOT_FOUND(${target.venueOrderId})`);
          faults.readOrder = (id, answer) => {
            if (id !== target.venueOrderId) return answer();
            this.fire("BYID_NOT_FOUND", false, id);
            return { route: "/data/order", found: false };
          };
          break;
        case 8:
          if (target === undefined) break;
          chosen.push(`BYID_THROW(${target.venueOrderId})`);
          faults.readOrder = (id, answer) => {
            if (id !== target.venueOrderId) return answer();
            this.fire("BYID_THROW", true, id);
            throw new Error("timeout");
          };
          break;
        case 9:
          if (target === undefined) break;
          chosen.push(`BYID_REGRESS(${target.venueOrderId})`);
          // A read behind what a source already showed (less matched than the evidence): a lie the coordinator can
          // see. (A lie no observation contradicts, such as a live order read as canceled, no reconciler can see.)
          faults.readOrder = (id, answer) => {
            const read = answer() as { found?: boolean; order?: Record<string, unknown> };
            if (id !== target.venueOrderId || read.found !== true || !this.matchedSeen(id)) return read;
            this.fire("BYID_REGRESS", false, id);
            return { ...read, order: { ...read.order, sizeMatched: "0" } };
          };
          break;
        case 10:
          chosen.push("POSITIONS_FAIL");
          faults.readPositions = () => {
            this.fire("POSITIONS_FAIL", true);
            throw new Error("timeout");
          };
          break;
        case 11:
          chosen.push("COLLATERAL_FAIL");
          faults.readCollateral = () => {
            this.fire("COLLATERAL_FAIL", true);
            throw new Error("timeout");
          };
          break;
        case 12:
          if (target === undefined) break;
          chosen.push(`LIST_REGRESS(${target.venueOrderId})`);
          faults.listOpenOrders = (answer) => {
            const read = answer() as { orders: Record<string, unknown>[] };
            return {
              ...read,
              orders: read.orders.map((order) => {
                if (order["venueOrderId"] !== target.venueOrderId || order["sizeMatched"] === "0" || !this.matchedSeen(target.venueOrderId)) return order;
                this.fire("LIST_REGRESS", false, target.venueOrderId);
                return { ...order, sizeMatched: "0" };
              }),
            };
          };
          break;
        default:
          // A clock fault at a random await of the run (a read or an OMS write).
          this.#clockArm = 1 + Math.floor(this.rand() * 12);
          this.#intercepted = 0;
          chosen.push(`CLOCK(at await ${String(this.#clockArm)})`);
          break;
      }
    }
    this.#install(faults);
    this.steps.push(`FAULTS(${chosen.join(", ")})`);
  }

  /** The reads the coordinator gets: the chosen faults (if any), then the observation ledger records what they deliver. */
  #install(chosen: ReadFaults = {}): void {
    const pass = (answer: () => unknown): unknown => answer();
    const list = chosen.listOpenOrders ?? pass;
    const trades = chosen.listTrades ?? pass;
    const byId = chosen.readOrder ?? ((_id: string, answer: () => unknown): unknown => answer());
    this.u.world.faults = {
      ...chosen,
      listOpenOrders: (answer) => {
        const read = list(answer) as { orders?: unknown };
        if (Array.isArray(read.orders)) for (const row of read.orders as Record<string, unknown>[]) this.saw(row["venueOrderId"], row["sizeMatched"]);
        return read;
      },
      listTrades: (answer) => {
        const read = trades(answer) as { trades?: unknown };
        if (Array.isArray(read.trades)) {
          for (const trade of read.trades as { ownLegs?: unknown }[]) {
            if (Array.isArray(trade.ownLegs)) for (const leg of trade.ownLegs as Record<string, unknown>[]) this.saw(leg["venueOrderId"], leg["shares"]);
          }
        }
        return read;
      },
      readOrder: (id, answer) => {
        const read = byId(id, answer) as { found?: unknown; order?: Record<string, unknown> };
        if (read.found === true && read.order !== undefined) this.saw(id, read.order["sizeMatched"]);
        return read;
      },
      onRead: (name: string) => this.intercept(`read.${name}`),
    };
  }

  // ---- runs and the oracle ----------------------------------------------------------------------------------

  async reconcile(): Promise<void> {
    await this.ensureAlive();
    const before = this.u.journalEvents.length;
    let report: Awaited<ReturnType<Process["coordinator"]["reconcile"]>> | undefined;
    try {
      report = await this.p.coordinator.reconcile();
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
    this.#install();
    this.#clockArm = 0;
    const runs = report?.runs ?? [];
    if (this.p.inc.alive && runs.some((run) => run.runId !== null)) this.#promote();
    this.runs += runs.length;
    this.steps.push(`RECONCILE -> ${runs.map((run) => `${run.status}${run.resumed ? "+resumed" : ""}`).join(", ") || "(killed)"}`);
    this.#checkRuns(runs, before);
    this.u.clock.t += this.chance(0.5) ? this.u.policy.quiescenceHorizonMs + 1 : Math.floor(this.rand() * 3000);
  }

  #checkRuns(runs: readonly { readonly runId: string | null; readonly resumed: boolean }[], before: number): void {
    const events = this.u.journalEvents.slice(before);
    const breaks = new Map(this.p.journal.breaks().map((view) => [view.breakId, view]));
    for (const run of runs) {
      if (run.runId === null) continue;
      const fired = this.fired.filter((entry) => entry.runId === run.runId);
      const detectable = fired.filter((entry) => entry.detectable);
      if (run.resumed && detectable.length > 0) this.violations.push(`resumed in run ${run.runId} though ${detectable.map((entry) => entry.kind).join(", ")} touched it`);
      const resolved = events.filter((event) => event.kind === "BREAK_RESOLVED" && event.runId === run.runId);
      if (detectable.some((entry) => !entry.kind.startsWith("CLOCK")) && resolved.length > 0) {
        this.violations.push(`run ${run.runId} resolved ${String(resolved.length)} break(s) though ${detectable.map((entry) => entry.kind).join(", ")} touched its reads`);
      }
      const faultAt = this.clockFaultAt.get(run.runId);
      if (faultAt !== undefined) {
        for (const event of resolved) {
          if (this.u.journalEvents.indexOf(event) >= faultAt) this.violations.push(`run ${run.runId} resolved break ${event.kind === "BREAK_RESOLVED" ? event.breakId : "?"} after a clock fault was detected in it`);
        }
      }
      for (const lie of fired.filter((entry) => entry.object !== null)) {
        const token = `${String(lie.object?.length)}:${lie.object ?? ""};`;
        for (const event of resolved) {
          if (event.kind !== "BREAK_RESOLVED") continue;
          const view = breaks.get(event.breakId);
          if (view === undefined || !view.subjectKey.includes(token)) continue;
          // A by-id read's SHAPE problem (failed, malformed) is resolved by a read that answered in its shape; what
          // the answer says is judged by the order's own subjects.
          if (READ_SHAPE_CLASSES.includes(view.breakClass)) continue;
          // A name-only hold the same run replaced with the id's not-found quarantine is not a resolution on a lie.
          const replaced = view.breakClass === "ORDER_UNRESOLVED" && this.p.journal.breaks().some((other) => other.breakClass === "ORDER_NOT_FOUND_BY_ID" && other.runId === run.runId && other.subjectKey.includes(token));
          if (!replaced) this.violations.push(`run ${run.runId} resolved ${view.breakClass} ${view.subjectKey} while a read of ${lie.object ?? "?"} lied (${lie.kind})`);
        }
      }
    }
    this.#checkOracle();
  }

  /** R1 to R3, as the harness's oracle recorded them, less the disclosed identity limit; and the standing invariants. */
  #checkOracle(): void {
    const recorded = this.u.violations.splice(0);
    for (const message of recorded) {
      const salt = /for salt (\S+?)[,\s]/u.exec(message)?.[1];
      if (message.startsWith("R2:") && salt !== undefined && this.#identityLimit(salt)) {
        this.exemptions += 1;
        continue;
      }
      // The same limit's one consequence: that canceled, never-matched venue order stays untracked (final size 0, exact).
      const untracked = /^R1 \(resumed while inconsistent\): venue order (\S+) is tracked by 0 OMS orders$/u.exec(message)?.[1];
      const salt0 = [...this.u.world.orders.values()].find((order) => order.venueOrderId === untracked)?.salt;
      if (untracked !== undefined && salt0 !== undefined && this.#identityLimit(salt0)) {
        this.exemptions += 1;
        continue;
      }
      this.violations.push(message);
    }
    for (const message of this.u.world.violations.splice(0)) this.violations.push(`world: ${message}`);
    const oms = this.oms;
    if (oms === null) return;
    // Nothing double counted: no OMS order holds more fill than its venue order matched.
    for (const order of oms.orders()) {
      if (order.venueOrderId === null) continue;
      const venue = [...this.u.world.orders.values()].find((candidate) => candidate.venueOrderId === order.venueOrderId);
      if (venue !== undefined && compareDecimal(order.filledShares, venue.matched) > 0) {
        this.violations.push(`double counted: order ${order.orderId} holds ${order.filledShares} filled; venue order ${order.venueOrderId} matched ${venue.matched}`);
      }
      const reservation = this.u.inventory.book.reservation(order.reservation.reservationId);
      if (reservation !== undefined && addDecimal(addDecimal(reservation.consumed, reservation.released), reservation.remaining) !== reservation.amount) {
        this.violations.push(`reservation ${reservation.reservationId} is not conserved`);
      }
    }
    if (this.u.inventory.book.checkInvariants().length > 0) this.violations.push("the inventory's invariants fail");
  }

  /**
   * The disclosed identity limit (`identity.ts`'s KNOWN LIMIT): the attempt's own order was placed and canceled with
   * nothing matched before any source observed it (no evidence record names it, the stream never did): every
   * documented read that does not name its id is blind to it, so "no candidate" fixes its final size at 0 exactly.
   */
  #identityLimit(salt: string): boolean {
    const own = this.u.world.orders.get(salt);
    if (own === undefined || own.status !== "CANCELED" || own.matched !== "0") return false;
    return !this.#observed(venueIdFor(salt));
  }

  /** A truthful operator: releases what the venue does not contradict, never an id the venue holds as not found. */
  async release(): Promise<void> {
    const releasable = this.p.journal.unresolvedBreaks().filter((view) => view.status === "QUARANTINED" && this.#truthful(view.breakClass, view.subjectKey));
    const view = this.pick(releasable);
    if (view === undefined) return;
    this.steps.push(`RELEASE(${view.breakClass})`);
    try {
      await this.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "property: truthful release" });
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
  }

  #truthful(breakClass: string, subjectKey: string): boolean {
    const parts = decodeCompositeKey(subjectKey) ?? [];
    const venueHas = (id: string | undefined): boolean => [...this.u.world.orders.values()].some((order) => order.venueOrderId === id);
    const foreign = (id: string | undefined): boolean => [...this.u.world.orders.values()].some((order) => order.venueOrderId === id && order.foreign);
    switch (breakClass) {
      case "ORDER_NOT_FOUND_BY_ID":
        return !venueHas(parts[1]);
      case "ORDER_UNATTRIBUTED":
        return foreign(parts[1]);
      case "TRADE_UNATTRIBUTED":
        return foreign(parts[2]);
      default:
        return true;
    }
  }

  /** The operator books the compensating reversal of every FAILED trade's fill (ADR-006 §5). */
  bookReversals(): void {
    for (const trade of this.u.world.trades.filter((entry: VenueTrade) => entry.status === "FAILED")) bookReversal(this.u, trade.venueTradeId, trade.venueOrderId);
  }

  /**
   * The final settling phase: no fault, a restart, truthful releases and reversals, and several runs. Then the halt
   * obligations: every ledger arrival and every OMS halting alert of the live process has its own break, and every
   * quarantined break's halt was delivered.
   */
  async settleAndCheckObligations(): Promise<void> {
    this.#install();
    this.#clockArm = 0;
    this.u.world.settleArrivals();
    await this.restart(false);
    for (let round = 0; round < 6; round += 1) {
      this.bookReversals();
      await this.reconcile();
      for (let release = 0; release < 4; release += 1) await this.release();
    }
    await this.reconcile();
    const journal = this.p.journal;
    const subjects = new Set(journal.breaks().map((view) => view.subjectKey));
    // Every ledger halt obligation (each arrival, by transaction, kind, asset, market and place) is its own break.
    const places = new Map<string, number>();
    for (const arrival of projectedHoldings(projectLedger(this.u.ledger), ACCOUNT).unattributedArrivals) {
      const group = compositeKey(arrival.ledgerTransactionId, arrival.kind, arrival.assetId, arrival.marketId ?? "");
      const place = places.get(group) ?? 0;
      places.set(group, place + 1);
      const subject = compositeKey("ledger-arrival", arrival.ledgerTransactionId, arrival.kind, arrival.assetId, arrival.marketId ?? "", String(place));
      if (!subjects.has(subject)) this.violations.push(`lost halt obligation: ledger arrival ${subject} has no break`);
    }
    // Every OMS halting alert of the live process is its own break (an alert's ordinal is its identity).
    const oms = this.p.oms;
    const halting = (oms?.alerts() ?? []).map((alert, ordinal) => ({ alert, ordinal })).filter(({ alert }) => alert.haltMarket);
    const alertBreaks = journal.breaks().filter((view) => view.breakClass === "OMS_HALTING_ALERT");
    for (const { alert, ordinal } of halting) {
      const tail = compositeKey(String(ordinal), alert.kind, alert.orderId ?? "", alert.submissionAttemptId ?? "", alert.venueOrderId ?? "");
      if (!alertBreaks.some((view) => view.subjectKey.endsWith(tail))) this.violations.push(`lost halt obligation: OMS halting alert ${String(ordinal)} (${alert.kind}) has no break`);
    }
    // Every quarantine standing now had its halt delivered.
    for (const view of journal.unresolvedBreaks().filter((entry) => entry.status === "QUARANTINED")) {
      if (!this.u.halts.some((halt) => halt.breakId === view.breakId)) this.violations.push(`quarantine ${view.breakId} (${view.breakClass}) was never halted`);
    }
    this.#checkOracle();
  }
}

/** Run one seed: a random interleaving of 8 to 16 steps, every oracle after every step, then the settling phase. */
export async function runSeed(seed: number): Promise<SeedResult> {
  const sim = await Sim.start(seed);
  const steps = 8 + Math.floor(sim.rand() * 9);
  for (let index = 0; index < steps; index += 1) {
    const roll = sim.rand();
    if (roll < 0.14) await sim.submit();
    else if (roll < 0.23) sim.match();
    else if (roll < 0.29) sim.settle();
    else if (roll < 0.35) sim.foreign();
    else if (roll < 0.39) sim.cancel();
    else if (roll < 0.52) await sim.stream();
    else if (roll < 0.54) sim.adjust();
    else if (roll < 0.56) sim.ledgerTwoMarkets();
    else if (roll < 0.7) {
      sim.armFaults();
      await sim.reconcile();
    } else if (roll < 0.82) await sim.reconcile();
    else if (roll < 0.88) await sim.restart(sim.chance(0.6));
    else if (roll < 0.94) await sim.release();
    else {
      sim.steps.push("ADVANCE");
      sim.u.clock.t += sim.u.policy.quiescenceHorizonMs + 1;
    }
  }
  await sim.settleAndCheckObligations();
  return Object.freeze({ seed, violations: Object.freeze([...sim.violations]), exemptions: sim.exemptions, resumes: sim.u.resumes, runs: sim.runs, steps: Object.freeze([...sim.steps]) });
}
