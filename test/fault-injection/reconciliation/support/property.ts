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
 *   phantom id, a fill reported again with other economics (a repeated OMS halting alert), and (r8) a trade's
 *   settlement without its fill (WP-280's projection of a maker leg: the OMS refuses it while it holds no such fill);
 * - (r7) the OMS store refusing a stream fill's write WITHOUT a process kill (the OMS faults: a store failure, then
 *   `OMS_FAULTED`), after which the composition reopens the OMS from its store and binds it to the SAME coordinator;
 * - (r7) a by-id read showing another value of an observed order's fixed fact, and a trades read showing an
 *   observed fill with other economics (an offsetting price and fee);
 * - (r8) a trades read showing a trade with the OTHER terminal settlement than one a read already showed it with
 *   (CONFIRMED for FAILED, or the reverse);
 * - (r9) a trades answer in which one trade's leg is malformed (its fee), and a VALID trades read showing one trade
 *   with its ownership undetermined and no own leg, at its true status;
 * - (r10) a by-id read answering with the order's TRUE row in an unusable envelope (`found: false`, or `found`
 *   absent), and a trades answer in which a trade not yet shown carries an unreadable trade id (a number), its legs
 *   valid;
 * - (r11, the class fix at the door layer) DOOR MUTATIONS of a true answer of any door (open orders, by id, trades,
 *   positions, the collateral, approvals: `mutate.ts`, every mutation the door property draws but the undetectable
 *   ones, a list truncated or a valid row relabelled), and LAG EPISODES: a consistent snapshot of every read is taken,
 *   the venue moves on, one run reads the truth through door mutations, then the snapshot is replayed for one to three
 *   runs (a lagging adapter), possibly mutated too, then the reads are truthful again;
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
 *   OMS halting alert has its own break, and every quarantined break's halt was delivered;
 * - (r11) NO VALIDATED FACT IS LOST: in a run that replays a stale snapshot, nothing resumes once any fact NEWER than
 *   the snapshot was delivered to the coordinator (by any answer, a mutated one's validated fragments included, or by
 *   the user stream) in a run that completed since: an order matched further, an order terminal, an order or a trade
 *   the snapshot does not have, a trade's settlement further or the other terminal one. The delivered facts are counted
 *   by the property itself, under each row's TRUE identity, only where a delivered fragment equals the truth (a lie is
 *   never counted). Holdings are not facts of this kind: a position or a balance is not monotonic. When nothing newer
 *   was delivered, a stale run cannot know, and R1 is excused in it (counted).
 *
 * PAPER only: every port is in-memory; no network, key or signer.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString } from "../../../../packages/decimal/src/index.js";
import { projectLedger, projectedHoldings } from "../../../../packages/ledger/src/index.js";
import { compositeKey } from "../../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../../packages/oms/src/index.js";
import { decodeCompositeKey } from "../../../../packages/oms/src/reconciliation/subjects.js";
import { venueIdFor } from "../../../unit/oms/support/fake-venue.js";
import { uuid7 } from "../../../unit/oms/support/ids.js";

import { ACCOUNT, Killed, MARKET, MARKET_NO, NO, PUSD, YES, bookReversal, boot, reopenOms, streamTrade, universe, type Process, type Universe } from "./harness.js";
import { readApprovals, readCollateral, readOpenOrders, readOrderById, readPositions, readTrades } from "../../../../packages/oms/src/reconciliation/door.js";
import { isLegalSettlementTransition } from "../../../../packages/oms/src/states.js";

import { LEG_KEYS, MUTATIONS, ORDER_KEYS, UNREADABLE, expectedEntries, expectedRow, mutateAnswer, own, type Door, type Mutation } from "./mutate.js";
import { G_YES, sequence, submitOne } from "./scenario.js";
import type { ReadFaults, Transmission, VenueOrder, VenueTrade } from "./world.js";

/** (r11) What the reads and the stream DELIVERED of the venue's truth, under each row's true identity (see the header). */
interface Delivered {
  /** Venue order → the most matched delivered, and whether it was delivered terminal. */
  readonly orders: Map<string, { matched: string; terminal: boolean }>;
  /** Venue trade → every settlement status delivered (plain spelling), and its legs' shares by order. */
  readonly trades: Map<string, { statuses: Set<string>; legs: Map<string, string> }>;
}

function emptyDelivered(): Delivered {
  return { orders: new Map(), trades: new Map() };
}

/** (r11) A consistent snapshot of the venue at one instant: what a lagging adapter replays. */
interface Snapshot {
  readonly orders: ReadonlyMap<string, VenueOrder>;
  readonly trades: readonly VenueTrade[];
  readonly positions: ReadonlyMap<string, string>;
  readonly collateral: string;
  readonly approvals: ReadonlyMap<string, boolean>;
}

/** The mutations the end-to-end property draws: every one a door detects (a list truncated, or a valid list row relabelled, is an undetectable lie: `mutate.ts`). */
const E2E_MUTATIONS: readonly Mutation[] = MUTATIONS.filter((mutation) => mutation !== "NONE" && mutation !== "TRUNCATE_LIST");
const MUTATED_DOORS: readonly Door[] = ["open-orders", "by-id", "trades", "positions", "collateral", "approvals"];

function plainStatus(status: string): string {
  return status.replace(/^TRADE_STATUS_/u, "");
}

type Settlement = "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";

function isSettlement(value: string): value is Settlement {
  return ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"].includes(value);
}

/** (r11) A lagging adapter's reads: every answer from a snapshot. */
type SnapshotAnswers = Required<Pick<ReadFaults, "listOpenOrders" | "readOrder" | "listTrades" | "readPositions" | "readCollateral" | "readApprovals">>;

/** (r9) The fee the TRADES_MALFORMED_LEG lie gives a leg: not an exact decimal, so the door refuses the leg. */
const MALFORMED_FEE = "not-a-fee";

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
  /** (r11) Lag episodes run, door mutations applied, and R1 messages excused in a stale run that had nothing newer delivered. */
  readonly lagEpisodes?: number;
  readonly doorMutations?: number;
  readonly staleExcused?: number;
  /** (r11) Stale runs that replayed a snapshot after a newer fact was delivered (each must not resume), and those that resumed with nothing newer. */
  readonly staleHeld?: number;
  readonly staleResumed?: number;
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
  /** (r11) Facts delivered since the current lag episode's snapshot (pending until a run of this process completes). */
  #deliveredPending: Delivered = emptyDelivered();
  #delivered: Delivered = emptyDelivered();
  /** (r11) The snapshot of the current lag episode, and whether the current run replays it. */
  #snapshot: Snapshot | null = null;
  #replaying = false;
  lagEpisodes = 0;
  doorMutations = 0;
  staleExcused = 0;
  staleHeld = 0;
  staleResumed = 0;

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
    this.#factsPending.clear();
    this.#deliveredPending = emptyDelivered();
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
    this.#factsPending.clear();
    this.#deliveredPending = emptyDelivered();
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
  /**
   * r7: what a READ showed of each object's immutable facts (an order's price, by a list row or a by-id read; a trade's
   * economics, by a trades answer), promoted with the rest: the r7 lies (`BYID_FACTS`, `TRADES_ECON`) are drawn only
   * against facts a read already showed, so each is a lie the coordinator can detect (a first observation that lies
   * is the undetectable kind, outside this fault model).
   */
  readonly #factsPending = new Set<string>();
  readonly #factsSeen = new Set<string>();

  sawFacts(key: string): void {
    this.#factsPending.add(key);
  }

  saw(id: unknown, matched: unknown): void {
    if (typeof id !== "string") return;
    // (r11) A door mutation may deliver an inexact decimal ("0.40"): only a canonical one is an amount.
    const amount = typeof matched === "string" && isCanonicalDecimalString(matched, { range: "NON_NEGATIVE" }) ? matched : "0";
    const earlier = this.#pending.get(id);
    if (earlier === undefined || compareDecimal(amount, earlier) > 0) this.#pending.set(id, amount);
  }

  #promote(): void {
    for (const [id, matched] of this.#pending) {
      const earlier = this.#seen.get(id);
      if (earlier === undefined || compareDecimal(matched, earlier) > 0) this.#seen.set(id, matched);
    }
    this.#pending.clear();
    for (const key of this.#factsPending) this.#factsSeen.add(key);
    this.#factsPending.clear();
    // (r11) Deliveries count once a run of the same process completed after them.
    for (const [id, order] of this.#deliveredPending.orders) this.#mergeOrder(this.#delivered, id, order.matched, order.terminal);
    for (const [id, trade] of this.#deliveredPending.trades) {
      for (const status of trade.statuses) this.#mergeTrade(this.#delivered, id, status, null, null);
      for (const [order, shares] of trade.legs) this.#mergeTrade(this.#delivered, id, null, order, shares);
      if (trade.statuses.size === 0 && trade.legs.size === 0) this.#mergeTrade(this.#delivered, id, null, null, null);
    }
    this.#deliveredPending = emptyDelivered();
  }

  // ---- (r11) delivered facts, door mutations and lag episodes ------------------------------------------------

  #mergeOrder(into: Delivered, id: string, matched: string, terminal: boolean): void {
    const known = into.orders.get(id);
    if (known === undefined) into.orders.set(id, { matched, terminal });
    else {
      if (compareDecimal(matched, known.matched) > 0) known.matched = matched;
      known.terminal ||= terminal;
    }
  }

  #mergeTrade(into: Delivered, id: string, status: string | null, order: string | null, shares: string | null): void {
    let known = into.trades.get(id);
    if (known === undefined) {
      known = { statuses: new Set(), legs: new Map() };
      into.trades.set(id, known);
    }
    if (status !== null) known.statuses.add(plainStatus(status));
    if (order !== null && shares !== null) {
      const held = known.legs.get(order);
      if (held === undefined || compareDecimal(shares, held) > 0) known.legs.set(order, shares);
    }
  }

  /**
   * Count what one delivered answer showed of the truth (`truth`: the venue's own answer at that instant), row by
   * row in the truth's order: a delivered row's fragment counts only when it is own data in its domain AND equal to the
   * true row's (a lie never counts), and only under the true row's identity when the delivered row's id is that one or
   * unreadable (a row relabelled with another readable id is not counted for anything).
   */
  #deliver(door: "open-orders" | "trades" | "by-id", truth: unknown, delivered: unknown, asked: string | null = null): void {
    if (this.#snapshot === null || this.#replaying) return;
    const pairs = (field: string): [Record<string, unknown>, unknown][] => {
      const trueRows = (own(truth, field).data ? (own(truth, field) as { value: unknown }).value : []) as Record<string, unknown>[];
      const read = own(delivered, field);
      const rows = read.data ? (expectedEntries(read.value, 50_000) ?? []) : [];
      return trueRows.slice(0, rows.length).map((row, index) => [row, rows[index]]);
    };
    const orderFacts = (trueRow: Record<string, unknown>, row: unknown): void => {
      const fragment = expectedRow(row, ORDER_KEYS);
      const id = trueRow["venueOrderId"] as string;
      if (fragment["venueOrderId"] !== UNREADABLE && fragment["venueOrderId"] !== id) return;
      const same = (key: string): boolean => fragment[key] !== UNREADABLE && fragment[key] === trueRow[key];
      if (!ORDER_KEYS.some((key) => same(key))) return;
      const matched = same("sizeMatched") ? (trueRow["sizeMatched"] as string) : "0";
      const terminal = (same("status") && trueRow["status"] === "CANCELED") || (same("sizeMatched") && same("originalSize") && trueRow["sizeMatched"] === trueRow["originalSize"]);
      this.#mergeOrder(this.#deliveredPending, id, matched, terminal);
    };
    if (door === "open-orders") for (const [trueRow, row] of pairs("orders")) orderFacts(trueRow, row);
    else if (door === "by-id") {
      const trueOrder = own(truth, "order");
      const order = own(delivered, "order");
      if (asked !== null && trueOrder.data && trueOrder.value !== null && typeof trueOrder.value === "object" && order.data) orderFacts(trueOrder.value as Record<string, unknown>, order.value);
    } else {
      for (const [trueRow, row] of pairs("trades")) {
        const fragment = expectedRow(row, ["venueTradeId", "status"]);
        const id = trueRow["venueTradeId"] as string;
        if (fragment["venueTradeId"] !== UNREADABLE && fragment["venueTradeId"] !== id) continue;
        const status = fragment["status"] !== UNREADABLE && fragment["status"] === trueRow["status"] ? (trueRow["status"] as string) : null;
        const trueLegs = (Array.isArray(trueRow["ownLegs"]) ? trueRow["ownLegs"] : []) as Record<string, unknown>[];
        const legsRead = own(row === UNREADABLE ? null : row, "ownLegs");
        const legs = legsRead.data ? (expectedEntries(legsRead.value, 64) ?? []) : [];
        let any = status !== null || fragment["venueTradeId"] === id;
        trueLegs.slice(0, legs.length).forEach((trueLeg, index) => {
          const leg = expectedRow(legs[index], LEG_KEYS);
          if (leg["venueOrderId"] !== UNREADABLE && leg["venueOrderId"] !== trueLeg["venueOrderId"]) return;
          const shares = leg["shares"] !== UNREADABLE && leg["shares"] === trueLeg["shares"] ? (trueLeg["shares"] as string) : null;
          if (shares === null && !LEG_KEYS.some((key) => leg[key] !== UNREADABLE && leg[key] === trueLeg[key])) return;
          any = true;
          this.#mergeTrade(this.#deliveredPending, id, null, trueLeg["venueOrderId"] as string, shares ?? "0");
        });
        if (any) this.#mergeTrade(this.#deliveredPending, id, status, null, null);
      }
    }
  }

  /** (r11) What the user stream delivered (always the truth here, but for a conflicting fill's economics). */
  #deliverStream(trade: VenueTrade | null, order: VenueOrder | null, withShares: boolean, withStatus: boolean): void {
    if (this.#snapshot === null || this.#replaying) return;
    if (order !== null) this.#mergeOrder(this.#deliveredPending, order.venueOrderId, "0", order.status === "CANCELED");
    if (trade !== null) this.#mergeTrade(this.#deliveredPending, trade.venueTradeId, withStatus ? trade.status : null, withShares ? trade.venueOrderId : null, withShares ? trade.shares : null);
  }

  /**
   * (r11) The first fact delivered (and promoted) since the snapshot that is NEWER than it, or `null`: an order the
   * snapshot does not have, matched further (by its own row or by its trades' legs), or terminal where it is live; a
   * trade the snapshot does not have, or a settlement status further than its, or the other terminal one.
   */
  #newerThanSnapshot(): string | null {
    const snapshot = this.#snapshot;
    if (snapshot === null) return null;
    const exists = (id: string): boolean => [...this.u.world.orders.values()].some((order) => order.venueOrderId === id);
    for (const [id, order] of this.#delivered.orders) {
      if (!exists(id)) continue;
      const then = snapshot.orders.get(id);
      if (then === undefined) return `order ${id} was delivered; the snapshot does not have it`;
      if (compareDecimal(order.matched, then.matched) > 0) return `order ${id} was delivered matched ${order.matched}; the snapshot shows ${then.matched}`;
      const terminal = then.status === "CANCELED" || compareDecimal(then.matched, then.original) === 0;
      if (order.terminal && !terminal) return `order ${id} was delivered terminal; the snapshot shows it live`;
    }
    for (const [id, trade] of this.#delivered.trades) {
      if (!this.u.world.trades.some((entry) => entry.venueTradeId === id)) continue;
      const then = snapshot.trades.find((entry) => entry.venueTradeId === id);
      if (then === undefined) return `trade ${id} was delivered; the snapshot does not have it`;
      const was = plainStatus(then.status);
      for (const status of trade.statuses) {
        if (status === was) continue;
        const terminal = (value: string): boolean => value === "CONFIRMED" || value === "FAILED";
        const forward = isSettlement(was) && isSettlement(status) && isLegalSettlementTransition(was, status);
        if (forward || (terminal(was) && terminal(status))) return `trade ${id} was delivered ${status}; the snapshot shows ${was}`;
      }
      for (const [order, shares] of trade.legs) {
        const legSum = snapshot.trades.filter((entry) => entry.venueOrderId === order).reduce((sum, entry) => addDecimal(sum, entry.shares), "0");
        if (compareDecimal(shares, legSum) > 0) return `trade ${id}'s leg on ${order} (${shares}) was delivered; the snapshot's trades on it sum to ${legSum}`;
      }
    }
    return null;
  }

  #takeSnapshot(): Snapshot {
    const world = this.u.world;
    return {
      orders: new Map([...world.orders.values()].map((order) => [order.venueOrderId, { ...order }])),
      trades: world.trades.map((trade) => ({ ...trade })),
      positions: new Map(world.positions),
      collateral: world.collateral,
      approvals: new Map(world.approvals),
    };
  }

  /** The reads of a lagging adapter: every answer from the snapshot (`world.ts`'s shapes). */
  #snapshotAnswers(snapshot: Snapshot): SnapshotAnswers {
    const world = this.u.world;
    return {
      listOpenOrders: () => ({
        route: "/data/orders",
        complete: true,
        orders: [...snapshot.orders.values()].filter((order) => order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0).map((order) => world.orderView(order)),
      }),
      readOrder: (id) => {
        const order = snapshot.orders.get(id);
        return order === undefined ? { route: "/data/order", found: false } : { route: "/data/order", found: true, order: world.orderView(order) };
      },
      listTrades: () => ({ route: "/data/trades", complete: true, trades: snapshot.trades.map((trade) => world.tradeView(trade)) }),
      readPositions: () => ({
        route: "/v2/positions",
        complete: true,
        positions: [...snapshot.positions].filter(([, size]) => compareDecimal(size, "0") !== 0).map(([tokenId, size]) => ({ tokenId, size })),
      }),
      readCollateral: () => ({ source: "ONCHAIN_ERC20_BALANCE", assetId: PUSD, balance: snapshot.collateral }),
      readApprovals: () => ({ route: "/v2/approvals", approvals: [...snapshot.approvals].map(([spender, approved]) => ({ spender, approved })) }),
    };
  }

  /**
   * (r11) A door mutation of one door's answer (the truth, or a snapshot's): drawn now, applied when read. It is a lie
   * only when the door detects it (the answer is then unusable; a run it touches concludes nothing); a draw the door
   * would read as usable is not applied.
   */
  #mutationOf(door: Door): (answer: unknown, asked: string | null) => unknown {
    const rand = seeded(Math.floor(this.rand() * 2_147_483_647) + 1);
    const mutation = this.pick(E2E_MUTATIONS) ?? "DROP_FIELD";
    const ids = [...this.u.world.orders.values()].map((order) => order.venueOrderId);
    return (answer, asked) => {
      const mutated = mutateAnswer(rand, door, answer, mutation, door === "by-id" ? [...ids, "venue-relabelled"] : ids);
      const outcome =
        door === "open-orders"
          ? readOpenOrders(mutated)
          : door === "trades"
            ? readTrades(mutated)
            : door === "by-id"
              ? readOrderById(mutated, asked ?? "")
              : door === "positions"
                ? readPositions(mutated)
                : door === "collateral"
                  ? readCollateral(mutated, PUSD)
                  : readApprovals(mutated);
      if (outcome.kind === "OK") return answer;
      this.doorMutations += 1;
      this.fire(`DOOR_MUTATION(${door} ${mutation})`, true);
      return mutated;
    };
  }

  /** Door mutations on `count` doors of the given answers (the truth when `base` is undefined). */
  #mutatedFaults(count: number, base?: SnapshotAnswers): ReadFaults {
    const faults: ReadFaults = {};
    const doors = [...MUTATED_DOORS].sort(() => this.rand() - 0.5).slice(0, count);
    for (const door of doors) {
      const mutate = this.#mutationOf(door);
      if (door === "by-id") faults.readOrder = (id, answer) => mutate(base === undefined ? answer() : base.readOrder(id, answer), id);
      else {
        const key = ({ "open-orders": "listOpenOrders", trades: "listTrades", positions: "readPositions", collateral: "readCollateral", approvals: "readApprovals" } as const)[door as Exclude<Door, "by-id" | "wallet-member" | "stream">];
        const source = base?.[key];
        faults[key] = (answer) => mutate(source === undefined ? answer() : source(answer), null);
      }
      this.steps.push(`DOOR_MUTATION(${door})`);
    }
    return faults;
  }

  /** The snapshot's answers as read faults. */
  snapshotFaults(): SnapshotAnswers {
    return this.#snapshotAnswers(this.#snapshot as Snapshot);
  }

  /**
   * (r11) A LAG EPISODE. Only while no attempt is unresolved and nothing is in transit (so a stale run has no request
   * to answer, and no submission is made during it): a snapshot of every read is taken; the venue moves on (0 to 2
   * activity steps, the user stream included); ONE run reads the truth through door mutations; then the snapshot is
   * replayed for 1 to 3 runs (a lagging adapter), possibly through a door mutation too; then the reads are truthful
   * again. Facts delivered since the snapshot are counted (`#deliver`); in a replaying run, a resume after a NEWER one
   * was delivered is a violation (`#checkRuns`).
   */
  async lagEpisode(): Promise<void> {
    await this.ensureAlive();
    const oms = this.oms;
    if (oms === null || this.u.world.pending.length > 0) return;
    if (oms.attempts().some((attempt) => ["SIGNED", "SENDING", "SUBMISSION_UNKNOWN", "RECONCILING"].includes(attempt.state))) return;
    this.lagEpisodes += 1;
    this.#snapshot = this.#takeSnapshot();
    this.#delivered = emptyDelivered();
    this.#deliveredPending = emptyDelivered();
    this.steps.push("LAG(snapshot)");
    const activity = Math.floor(this.rand() * 3);
    for (let step = 0; step < activity; step += 1) {
      const roll = this.rand();
      if (roll < 0.35) this.match();
      else if (roll < 0.55) this.settle();
      else if (roll < 0.65) this.cancel();
      else if (roll < 0.75) this.foreign();
      else await this.stream();
    }
    // One run reads the truth through door mutations: what it delivers is the newer facts a stale run must not forget.
    this.#install(this.#mutatedFaults(1 + Math.floor(this.rand() * 2)));
    await this.reconcile();
    const replays = 1 + Math.floor(this.rand() * 3);
    for (let run = 0; run < replays; run += 1) {
      if (this.#snapshot === null) break;
      const answers = this.snapshotFaults();
      const faults: ReadFaults = this.chance(0.4) ? { ...answers, ...this.#mutatedFaults(1, answers) } : { ...answers };
      this.steps.push(`LAG(replay ${String(run + 1)} of ${String(replays)})`);
      this.#replaying = true;
      this.#install(faults);
      try {
        await this.reconcile();
      } finally {
        this.#replaying = false;
      }
    }
    this.#snapshot = null;
    this.#delivered = emptyDelivered();
    this.#deliveredPending = emptyDelivered();
    this.#install();
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
    } else if (roll < 0.45) {
      const order = this.pick(this.ownOrders());
      if (order === undefined) return;
      const full = compareDecimal(order.matched, order.original) === 0;
      const status = order.status === "CANCELED" ? "CANCELED" : full ? "MATCHED" : "LIVE";
      this.saw(order.venueOrderId, "0");
      this.#deliverStream(null, order, false, false);
      this.steps.push(`STREAM(order ${order.venueOrderId} ${status})`);
      this.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status }, shortfalls: [] } });
    } else if (roll < 0.75) {
      const trade = this.pick(this.u.world.trades.filter((entry) => this.ownOrders().some((order) => order.venueOrderId === entry.venueOrderId)));
      if (trade === undefined) return;
      this.saw(trade.venueOrderId, trade.shares);
      this.#deliverStream(trade, null, true, false);
      this.steps.push(`STREAM(fill ${trade.venueTradeId})`);
      this.p.coordinator.onUserStreamOutput(streamTrade(this.u, trade.venueTradeId));
    } else if (roll < 0.87) {
      // r8 (WP290-CX-R8-01): a settlement without its fill, at the trade's true status (WP-280 projects no fill for a
      // maker leg): the OMS applies it only against a fill it recorded, and refuses it otherwise.
      const trade = this.pick(this.u.world.trades.filter((entry) => this.ownOrders().some((order) => order.venueOrderId === entry.venueOrderId)));
      if (trade === undefined) return;
      this.saw(trade.venueOrderId, "0");
      this.#deliverStream(trade, null, false, true);
      this.steps.push(`STREAM(settlement ${trade.venueTradeId} ${trade.status})`);
      this.p.coordinator.onUserStreamOutput({
        kind: "TRADE",
        oms: {
          fills: [],
          settlements: [{ venueTradeId: trade.venueTradeId, venueOrderId: trade.venueOrderId, status: trade.status, transactionHash: trade.transactionHash, observedAt: "2026-10-03T00:00:01Z" }],
          shortfalls: [],
        },
      });
    } else {
      // A fill reported again with other economics: the OMS refuses it and raises a halting alert (repeated alerts).
      const trade = this.pick(this.u.world.trades);
      if (trade === undefined) return;
      this.#deliverStream(trade, null, false, false);
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

  /**
   * r7 (WP290-V7-STREAM-REFUSAL-DROPPED): the OMS store refuses the write of a fill the user stream delivers, so the
   * OMS faults (`OMS_STORE_WRITE_FAILED`, then `OMS_FAULTED` for anything after), with NO process kill: the composition
   * reopens the OMS from its durable store and binds it to the SAME live coordinator.
   */
  async storeFault(): Promise<void> {
    const oms = this.oms;
    if (oms === null) return;
    // A fill of a tracked order the OMS has not recorded yet (so its commit is attempted), else any own fill.
    const own = this.u.world.trades.filter((entry) => this.ownOrders().some((order) => order.venueOrderId === entry.venueOrderId));
    const recorded = new Set(this.u.store.snapshotSync().fills.map((fill) => fill.venueTradeId));
    const tracked = own.filter((entry) => !recorded.has(entry.venueTradeId) && oms.orders().some((order) => order.venueOrderId === entry.venueOrderId));
    const trade = this.pick(tracked.length > 0 ? tracked : own);
    if (trade === undefined) return;
    this.saw(trade.venueOrderId, trade.shares);
    this.#deliverStream(trade, null, true, false);
    this.steps.push(`STORE_FAULT(fill ${trade.venueTradeId})`);
    this.u.store.hooks.before = (writes) => {
      if (writes.some((write) => write.kind === "INSERT_FILL")) throw new Error("the database is unavailable");
    };
    try {
      this.p.coordinator.onUserStreamOutput(streamTrade(this.u, trade.venueTradeId));
      await this.p.coordinator.settled();
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    } finally {
      this.u.store.hooks.before = undefined;
    }
    if (this.p.inc.alive && this.p.oms?.faulted === true) {
      this.steps.push("REBIND");
      try {
        this.p = await reopenOms(this.u, this.p);
      } catch (error) {
        if (!(error instanceof Killed)) throw error;
      }
      this.#instrument();
    }
  }

  // ---- faults for the next run ------------------------------------------------------------------------------

  armFaults(): void {
    const faults: ReadFaults = {};
    const chosen: string[] = [];
    const count = 1 + Math.floor(this.rand() * 2);
    for (let index = 0; index < count; index += 1) {
      const roll = Math.floor(this.rand() * 22);
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
        case 13:
          // r7 (WP290-CX-R7-01): a by-id read shows an observed order with another limit price (a fixed fact).
          if (target === undefined || !this.#factsSeen.has(`order:${target.venueOrderId}`)) break;
          chosen.push(`BYID_FACTS(${target.venueOrderId})`);
          faults.readOrder = (id, answer) => {
            const read = answer() as { found?: boolean; order?: Record<string, unknown> };
            if (id !== target.venueOrderId || read.found !== true) return read;
            this.fire("BYID_FACTS", false, id);
            return { ...read, order: { ...read.order, price: target.price === "0.6" ? "0.61" : "0.6" } };
          };
          break;
        case 14:
          // r7 (WP290-CX-R7-02): a trades read shows an observed fill at a lower price with an offsetting collateral fee.
          if (trade === undefined || !this.#factsSeen.has(`trade:${trade.venueTradeId}`)) break;
          chosen.push(`TRADES_ECON(${trade.venueTradeId})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string; ownLegs: Record<string, unknown>[] }[] };
            return {
              ...read,
              trades: read.trades.map((entry) => {
                if (entry.venueTradeId !== trade.venueTradeId) return entry;
                this.fire("TRADES_ECON", false, trade.venueOrderId);
                return { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, price: "0.01", feeAmount: "0.001", feeAssetId: PUSD })) };
              }),
            };
          };
          break;
        case 15: {
          // r8 (WP290-CX-R8-02): a trades read shows a trade with the other terminal settlement than one a read already
          // showed it with (a lie the coordinator can detect: both terminal statuses are then in the evidence).
          const shownTerminal = trade === undefined ? undefined : ["CONFIRMED", "FAILED"].find((status) => this.#factsSeen.has(`status:${trade.venueTradeId}:${status}`));
          if (trade === undefined || shownTerminal === undefined) break;
          const other = shownTerminal === "CONFIRMED" ? "FAILED" : "CONFIRMED";
          chosen.push(`TRADES_TERMINAL(${trade.venueTradeId} ${other})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string }[] };
            return {
              ...read,
              trades: read.trades.map((entry) => {
                if (entry.venueTradeId !== trade.venueTradeId) return entry;
                this.fire("TRADES_TERMINAL", false, trade.venueTradeId);
                this.fire("TRADES_TERMINAL", false, trade.venueOrderId);
                return { ...entry, status: other };
              }),
            };
          };
          break;
        }
        case 16:
          // r9 (WP290-CX-R9-01): one trade's leg is malformed (its fee): the answer is unusable, and only the trade's
          // id and status are kept (never its economics); a later read must answer that identity.
          if (trade === undefined) break;
          chosen.push(`TRADES_MALFORMED_LEG(${trade.venueTradeId})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string; ownLegs: Record<string, unknown>[] }[] };
            return {
              ...read,
              trades: read.trades.map((entry) => {
                if (entry.venueTradeId !== trade.venueTradeId) return entry;
                this.fire("TRADES_MALFORMED_LEG", true);
                return { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, feeAmount: MALFORMED_FEE })) };
              }),
            };
          };
          break;
        case 17:
          // r9 (WP290-CX-R9-01, WP290-V9-UNFOLDED-TERMINAL): a VALID trades read shows one trade with its ownership
          // undetermined and no own leg, at its true status (FAILED included): its status is kept, its identity open.
          if (trade === undefined) break;
          chosen.push(`TRADES_LEGLESS(${trade.venueTradeId})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string }[] };
            return {
              ...read,
              trades: read.trades.map((entry) => {
                if (entry.venueTradeId !== trade.venueTradeId) return entry;
                // The trade's own READ_INCOMPLETE leaves the run inconclusive: it must conclude nothing.
                this.fire("TRADES_LEGLESS", true);
                return { ...entry, ownershipUndetermined: true, ownLegs: [] };
              }),
            };
          };
          break;
        case 18: {
          // r10 (WP290-CX-R10-01): a by-id read answers with the order's TRUE row in an unusable envelope (`found: false`,
          // or `found` absent): it answers nothing about the order (the run is inconclusive), and the row is kept as
          // evidence under its own id.
          if (target === undefined) break;
          const absent = this.chance(0.5);
          chosen.push(`BYID_UNUSABLE(${target.venueOrderId} ${absent ? "found absent" : "found false"})`);
          faults.readOrder = (id, answer) => {
            const read = answer() as Record<string, unknown>;
            if (id !== target.venueOrderId || read["found"] !== true) return read;
            this.fire("BYID_UNUSABLE", true, id);
            const unusable: Record<string, unknown> = { ...read, found: false };
            if (absent) delete unusable["found"];
            return unusable;
          };
          break;
        }
        case 19:
          // r10 (WP290-V10-UNKEYED-LEG-DISCHARGED): a trade no completed run has seen in full carries an unreadable trade id
          // (a number), its legs valid: the answer is unusable, and each leg is an obligation on its order until the reads
          // show the trade by its id. (A trade already shown by its id and re-shown garbled owes one trade more than the
          // venue has, by the fail-closed count: a disclosed permanent hold, outside this fault model.)
          if (trade === undefined || this.#factsSeen.has(`trade:${trade.venueTradeId}`)) break;
          chosen.push(`TRADES_UNKEYED(${trade.venueTradeId})`);
          faults.listTrades = (answer) => {
            const read = answer() as { trades: { venueTradeId: string }[] };
            return {
              ...read,
              trades: read.trades.map((entry) => {
                if (entry.venueTradeId !== trade.venueTradeId) return entry;
                this.fire("TRADES_UNKEYED", true);
                return { ...entry, venueTradeId: 42 };
              }),
            };
          };
          break;
        case 20: {
          // r11 (the class fix at the door layer): a door mutation of one door's true answer, which the door detects.
          const mutated = this.#mutatedFaults(1);
          chosen.push("DOOR_MUTATION");
          Object.assign(faults, mutated);
          break;
        }
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
        if (this.#snapshot !== null && !this.#replaying) this.#deliver("open-orders", answer(), read);
        if (Array.isArray(read.orders)) {
          for (const row of read.orders as Record<string, unknown>[]) {
            this.saw(row["venueOrderId"], row["sizeMatched"]);
            if (typeof row["price"] === "string") this.sawFacts(`order:${String(row["venueOrderId"])}`);
          }
        }
        return read;
      },
      listTrades: (answer) => {
        const read = trades(answer) as { trades?: unknown };
        if (this.#snapshot !== null && !this.#replaying) this.#deliver("trades", answer(), read);
        if (Array.isArray(read.trades)) {
          for (const trade of read.trades as { venueTradeId?: unknown; ownLegs?: unknown }[]) {
            const legs = Array.isArray(trade.ownLegs) ? (trade.ownLegs as Record<string, unknown>[]) : [];
            // r9: a leg the TRADES_MALFORMED_LEG lie broke only NAMES its order (the door keeps its id alone, never its
            // shares); a row with no intact leg shows none of the trade's economics.
            for (const leg of legs) this.saw(leg["venueOrderId"], leg["feeAmount"] === MALFORMED_FEE ? "0" : leg["shares"]);
            const intact = legs.length > 0 && legs.every((leg) => leg["feeAmount"] !== MALFORMED_FEE);
            if (typeof trade.venueTradeId === "string" && intact) this.sawFacts(`trade:${trade.venueTradeId}`);
            // r8: the terminal settlement a read showed (either spelling), so a TRADES_TERMINAL lie can contradict it.
            const status = (trade as { status?: unknown }).status;
            if (typeof trade.venueTradeId === "string" && typeof status === "string") this.sawFacts(`status:${trade.venueTradeId}:${status.replace(/^TRADE_STATUS_/u, "")}`);
          }
        }
        return read;
      },
      readOrder: (id, answer) => {
        const read = byId(id, answer) as { found?: unknown; order?: Record<string, unknown> };
        if (this.#snapshot !== null && !this.#replaying) this.#deliver("by-id", answer(), read, id);
        if (read.found === true && read.order !== undefined) {
          this.saw(id, read.order["sizeMatched"]);
          this.sawFacts(`order:${id}`);
        } else if (read.order !== undefined && read.order !== null && typeof read.order["venueOrderId"] === "string") {
          // r10: the row of an unusable by-id answer (BYID_UNUSABLE: the order's true row) is kept, under its own id.
          this.saw(read.order["venueOrderId"], read.order["sizeMatched"]);
          this.sawFacts(`order:${read.order["venueOrderId"]}`);
        }
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
    // (r11) A run replaying a stale snapshot: once a NEWER fact was delivered, it must not resume.
    if (this.#replaying) {
      const newer = this.#newerThanSnapshot();
      for (const run of runs) {
        if (run.runId === null) continue;
        if (newer !== null) this.staleHeld += 1;
        if (run.resumed && newer !== null) this.violations.push(`run ${run.runId} resumed on a stale snapshot after a newer fact was delivered: ${newer}`);
        if (run.resumed && newer === null) this.staleResumed += 1;
      }
    }
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
    // (r11) In a run replaying a stale snapshot with nothing newer delivered, the coordinator cannot know the venue
    // moved on: R1 (judged against the venue's truth now) is excused there, and counted.
    const staleBlind = this.#replaying && this.#newerThanSnapshot() === null;
    for (const message of recorded) {
      if (staleBlind && message.startsWith("R1 ")) {
        this.staleExcused += 1;
        continue;
      }
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
    else if (roll < 0.49) await sim.stream();
    else if (roll < 0.52) await sim.storeFault();
    else if (roll < 0.54) sim.adjust();
    else if (roll < 0.56) sim.ledgerTwoMarkets();
    else if (roll < 0.7) {
      sim.armFaults();
      await sim.reconcile();
    } else if (roll < 0.82) await sim.reconcile();
    else if (roll < 0.88) await sim.restart(sim.chance(0.6));
    else if (roll < 0.94) await sim.release();
    else if (roll < 0.97) await sim.lagEpisode();
    else {
      sim.steps.push("ADVANCE");
      sim.u.clock.t += sim.u.policy.quiescenceHorizonMs + 1;
    }
  }
  await sim.settleAndCheckObligations();
  return Object.freeze({
    seed,
    violations: Object.freeze([...sim.violations]),
    exemptions: sim.exemptions,
    resumes: sim.u.resumes,
    runs: sim.runs,
    steps: Object.freeze([...sim.steps]),
    lagEpisodes: sim.lagEpisodes,
    doorMutations: sim.doorMutations,
    staleExcused: sim.staleExcused,
    staleHeld: sim.staleHeld,
    staleResumed: sim.staleResumed,
  });
}
