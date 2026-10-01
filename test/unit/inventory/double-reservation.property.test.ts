/**
 * WP-300 acceptance 1 (property form): double reservation is impossible.
 *
 * Seeded random operation sequences (reserve, consume, release, inflow,
 * settle, observe) run against the book AND against an independent oracle
 * that does its arithmetic in BigInt cents. After every step:
 * - the book's accept/refuse decision equals the oracle's;
 * - every line's actual/reserved/pendingOut/pendingIn/available equals the
 *   oracle's;
 * - `checkInvariants()` is empty;
 * - on every unblocked line, reserved + pendingOut <= actual (no negative
 *   available, §10.7), and no holder has two ACTIVE reservations on one asset.
 *
 * Pending ids are single-use for the book's lifetime (WP300-R1-01): the oracle
 * retains settled ids, and the generator deliberately replays settlements and
 * reuses settled ids for both consumes and inflows.
 *
 * fast-check is not a root dependency, and this packet may add none, so the
 * generator is a seeded PRNG: every failure reproduces from its seed.
 */

import { describe, expect, it } from "vitest";

import type { InventoryBook } from "../../../packages/inventory/src/index.js";
import { ACCOUNT, NO, PUSD, YES, pick, prng, randomAmount, seededBook } from "./helpers.js";

const ASSETS = [PUSD, YES, NO] as const;
const HOLDERS = ["o1", "o2", "o3", "o4", "o5"] as const;

function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > 2) throw new Error(`oracle handles 2 decimals, got ${value}`);
  const result = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -result : result;
}

interface OracleLine {
  actual: bigint;
  pendingOut: bigint;
  pendingIn: bigint;
  blocked: boolean;
}
interface OracleReservation {
  holder: string;
  asset: string;
  amount: bigint;
  used: bigint;
  active: boolean;
}
interface OraclePending {
  asset: string;
  amount: bigint;
  direction: "OUT" | "IN";
}

class Oracle {
  readonly lines = new Map<string, OracleLine>();
  readonly reservations = new Map<string, OracleReservation>();
  readonly pending = new Map<string, OraclePending>();
  readonly settled = new Set<string>();

  line(asset: string): OracleLine {
    let line = this.lines.get(asset);
    if (line === undefined) {
      line = { actual: 0n, pendingOut: 0n, pendingIn: 0n, blocked: false };
      this.lines.set(asset, line);
    }
    return line;
  }
  reserved(asset: string): bigint {
    let sum = 0n;
    for (const r of this.reservations.values()) if (r.active && r.asset === asset) sum += r.amount - r.used;
    return sum;
  }
  available(asset: string): bigint {
    const line = this.line(asset);
    return line.actual - this.reserved(asset) - line.pendingOut;
  }
  reserve(id: string, holder: string, asset: string, amount: bigint): boolean {
    if (this.reservations.has(id)) return false;
    for (const r of this.reservations.values()) if (r.active && r.holder === holder && r.asset === asset) return false;
    if (this.line(asset).blocked || this.available(asset) < amount) return false;
    this.reservations.set(id, { holder, asset, amount, used: 0n, active: true });
    return true;
  }
  consume(id: string, amount: bigint, pendingId: string): boolean {
    const r = this.reservations.get(id);
    if (r === undefined || !r.active || this.idTaken(pendingId) || amount > r.amount - r.used) return false;
    r.used += amount;
    this.line(r.asset).pendingOut += amount;
    this.pending.set(pendingId, { asset: r.asset, amount, direction: "OUT" });
    if (r.used === r.amount) r.active = false;
    return true;
  }
  release(id: string): boolean {
    const r = this.reservations.get(id);
    if (r === undefined || !r.active) return false;
    r.used = r.amount; // the remainder is released, not consumed; remaining becomes 0
    r.active = false;
    return true;
  }
  inflow(pendingId: string, asset: string, amount: bigint): boolean {
    if (this.idTaken(pendingId)) return false;
    this.line(asset).pendingIn += amount;
    this.pending.set(pendingId, { asset, amount, direction: "IN" });
    return true;
  }
  settle(pendingId: string, applied: boolean): boolean {
    const p = this.pending.get(pendingId);
    if (p === undefined) return false;
    const line = this.line(p.asset);
    if (p.direction === "OUT") {
      if (applied && line.actual < p.amount) return false;
      line.pendingOut -= p.amount;
      if (applied) line.actual -= p.amount;
    } else {
      line.pendingIn -= p.amount;
      if (applied) line.actual += p.amount;
    }
    this.pending.delete(pendingId);
    this.settled.add(pendingId);
    return true;
  }
  idTaken(pendingId: string): boolean {
    return this.pending.has(pendingId) || this.settled.has(pendingId);
  }
  observe(asset: string, balance: bigint): boolean {
    for (const p of this.pending.values()) if (p.asset === asset) return false;
    const line = this.line(asset);
    line.actual = balance;
    line.blocked = this.available(asset) < 0n;
    return true;
  }
}

function compare(book: InventoryBook, oracle: Oracle, context: string): void {
  expect(book.checkInvariants(), context).toEqual([]);
  for (const asset of ASSETS) {
    const line = book.line(ACCOUNT, asset);
    const o = oracle.line(asset);
    const view = line ?? { actual: "0", reserved: "0", pendingOut: "0", pendingIn: "0", available: "0", blocked: null };
    expect(cents(view.actual), `${context} actual ${asset}`).toBe(o.actual);
    expect(cents(view.reserved), `${context} reserved ${asset}`).toBe(oracle.reserved(asset));
    expect(cents(view.pendingOut), `${context} pendingOut ${asset}`).toBe(o.pendingOut);
    expect(cents(view.pendingIn), `${context} pendingIn ${asset}`).toBe(o.pendingIn);
    expect(cents(view.available), `${context} available ${asset}`).toBe(oracle.available(asset));
    if (view.blocked === null) {
      expect(cents(view.reserved) + cents(view.pendingOut) <= cents(view.actual), `${context} over-reserved ${asset}`).toBe(true);
    }
  }
  const activeByHolderAsset = new Set<string>();
  for (const r of book.reservations()) {
    if (r.status !== "ACTIVE") continue;
    const key = `${r.holderRef}|${r.assetId}`;
    expect(activeByHolderAsset.has(key), `${context} double reservation ${key}`).toBe(false);
    activeByHolderAsset.add(key);
  }
}

function runSeed(seed: number, steps: number): Set<string> {
  const refusals = new Set<string>();
  const track = (result: { ok: boolean; refusal?: { code: string } }): boolean => {
    if (!result.ok && result.refusal !== undefined) refusals.add(result.refusal.code);
    return result.ok;
  };
  const random = prng(seed);
  const book = seededBook({ [PUSD]: "50", [YES]: "20", [NO]: "20" });
  const oracle = new Oracle();
  oracle.observe(PUSD, 5000n);
  oracle.observe(YES, 2000n);
  oracle.observe(NO, 2000n);
  let nextId = 0;
  const reservationIds: string[] = [];
  const pendingIds: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    const context = `seed ${seed} step ${step}`;
    const roll = random();
    if (roll < 0.4) {
      // Sometimes reuse an id on purpose.
      const id = random() < 0.1 && reservationIds.length > 0 ? pick(random, reservationIds) : `r${nextId++}`;
      const holder = pick(random, HOLDERS);
      const asset = pick(random, ASSETS);
      const amount = randomAmount(random, 15);
      const got = track(book.reserve({ reservationId: id, holderRef: holder, accountRef: ACCOUNT, assetId: asset, amount }));
      expect(got, `${context} reserve`).toBe(oracle.reserve(id, holder, asset, cents(amount)));
      if (got) reservationIds.push(id);
    } else if (roll < 0.6 && reservationIds.length > 0) {
      const id = pick(random, reservationIds);
      const amount = randomAmount(random, 8);
      const pendingId = random() < 0.1 && pendingIds.length > 0 ? pick(random, pendingIds) : `p${nextId++}`;
      const got = track(book.consume({ reservationId: id, amount, pendingId }));
      expect(got, `${context} consume`).toBe(oracle.consume(id, cents(amount), pendingId));
      if (got) pendingIds.push(pendingId);
    } else if (roll < 0.72 && reservationIds.length > 0) {
      const id = pick(random, reservationIds);
      expect(track(book.release({ reservationId: id })), `${context} release`).toBe(oracle.release(id));
    } else if (roll < 0.8) {
      // Sometimes reuse an id on purpose (live or already settled).
      const pendingId = random() < 0.15 && pendingIds.length > 0 ? pick(random, pendingIds) : `p${nextId++}`;
      const asset = pick(random, ASSETS);
      const amount = randomAmount(random, 5);
      const got = track(book.expectInflow({ pendingId, accountRef: ACCOUNT, assetId: asset, amount }));
      expect(got, `${context} inflow`).toBe(oracle.inflow(pendingId, asset, cents(amount)));
      if (got) pendingIds.push(pendingId);
    } else if (roll < 0.93 && pendingIds.length > 0) {
      const pendingId = pick(random, pendingIds);
      const applied = random() < 0.6;
      const got = track(book.settlePending({ pendingId, settlement: applied ? "APPLIED" : "VOIDED" }));
      expect(got, `${context} settle`).toBe(oracle.settle(pendingId, applied));
    } else {
      const asset = pick(random, ASSETS);
      const balance = randomAmount(random, 60);
      const got = track(book.observeActual({ accountRef: ACCOUNT, assetId: asset, balance }));
      expect(got, `${context} observe`).toBe(oracle.observe(asset, cents(balance)));
    }
    compare(book, oracle, context);
  }
  return refusals;
}

// One test per seed keeps each synchronous block short (a long one starves the
// vitest worker's RPC; see CI-1).
const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1);

describe("double reservation is impossible (seeded property run against an exact oracle)", () => {
  it.each(SEEDS)("seed %i: 120 random steps agree with the oracle and keep every invariant", (seed) => {
    runSeed(seed, 120);
  });

  it("is not vacuous: the generator reaches every refusal the property is about", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS.slice(0, 20)) for (const code of runSeed(seed, 120)) seen.add(code);
    for (const code of [
      "INVENTORY_DUPLICATE_RESERVATION_ID",
      "INVENTORY_DOUBLE_RESERVATION",
      "INVENTORY_INSUFFICIENT_AVAILABLE",
      "INVENTORY_RESERVATION_NOT_ACTIVE",
      "INVENTORY_OVER_CONSUMPTION",
      "INVENTORY_PENDING_UNRESOLVED",
      "INVENTORY_DUPLICATE_PENDING_ID",
      "INVENTORY_PENDING_ALREADY_SETTLED",
    ]) {
      expect(seen.has(code), code).toBe(true);
    }
  });
});
