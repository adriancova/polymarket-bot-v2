/**
 * The OMS test harness: an `OrderManager` over mocked ports only. Nothing
 * here can reach a network, a key, a signer or a real venue: the venue is
 * `FakeVenue`, the store is `MemoryStore`, the cipher is `MockCipher`, the
 * reconciler records requests, and the inventory is either WP-300's real
 * in-memory `ReservationService` (layer-1 logic, no I/O) or a recorder.
 */

import { AssetRegistry, InventoryBook, ReservationService } from "../../../../packages/inventory/src/index.js";
import type { InventoryJournalEvent } from "../../../../packages/inventory/src/index.js";
import {
  OrderManager,
  type OmsReservationPort,
  type OrderManagerDependencies,
  type OrderTicket,
  type GroupSpec,
  type PortResult,
  type ReconciliationRequest,
  type ReconciliationRequester,
  type RestoreSignedOrder,
  type VenueMode,
} from "../../../../packages/oms/src/index.js";

import { FakeVenue, restoreFakeSignedOrder } from "./fake-venue.js";
import { idSource, tokenSource, uuid7 } from "./ids.js";
import { MemoryStore } from "./memory-store.js";
import { MockCipher } from "./mock-cipher.js";

export const ACCOUNT = "paper-account-1";
export const PUSD = "asset-pusd";
export const YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
export const NO = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
export const CONDITION = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";

export class RecordingReconciler implements ReconciliationRequester {
  readonly requests: ReconciliationRequest[] = [];
  /** Called synchronously inside `request` (a synchronous coordinator answering re-entrantly). */
  onRequest: ((request: ReconciliationRequest) => void) | null = null;
  throwNext = 0;

  request(request: ReconciliationRequest): void {
    if (this.throwNext > 0) {
      this.throwNext -= 1;
      throw new Error("reconciler unavailable");
    }
    this.requests.push(request);
    this.onRequest?.(request);
  }

  latestFor(attemptId: string): ReconciliationRequest | undefined {
    return [...this.requests].reverse().find((request) => request.submissionAttemptId === attemptId);
  }
}

/** WP-300's real reservation service over an in-memory book, with a journal that records. */
export function realInventory(balances: { readonly pusd?: string; readonly yes?: string } = {}): {
  readonly service: ReservationService;
  readonly book: InventoryBook;
  readonly journal: InventoryJournalEvent[];
} {
  const created = AssetRegistry.create({ pusdAssetId: PUSD });
  if (!created.ok) throw new Error(created.refusal.message);
  const pair = created.value.registerOutcomePair({ conditionId: CONDITION, yesAssetId: YES, noAssetId: NO });
  if (!pair.ok) throw new Error(pair.refusal.message);
  const book = new InventoryBook(created.value);
  for (const [assetId, balance] of [
    [PUSD, balances.pusd ?? "1000"],
    [YES, balances.yes ?? "1000"],
  ] as const) {
    const observed = book.observeActual({ accountRef: ACCOUNT, assetId, balance });
    if (!observed.ok) throw new Error(observed.refusal.message);
  }
  const journal: InventoryJournalEvent[] = [];
  const service = new ReservationService(book, {
    append: async (event) => {
      journal.push(event);
    },
  });
  return { service, book, journal };
}

/** A recording reservation port with scriptable answers (for failure paths). */
export class RecordingReservations implements OmsReservationPort {
  readonly calls: { readonly op: string; readonly input: unknown }[] = [];
  reserveAnswer: () => PortResult | Promise<PortResult> = () => ({ ok: true, value: {} });
  consumeAnswer: () => PortResult | Promise<PortResult> = () => ({ ok: true, value: {} });
  releaseAnswer: () => PortResult | Promise<PortResult> = () => ({ ok: true, value: {} });

  async reserve(input: unknown): Promise<PortResult> {
    this.calls.push({ op: "reserve", input });
    return this.reserveAnswer();
  }
  async consume(input: unknown): Promise<PortResult> {
    this.calls.push({ op: "consume", input });
    return this.consumeAnswer();
  }
  async release(input: unknown): Promise<PortResult> {
    this.calls.push({ op: "release", input });
    return this.releaseAnswer();
  }
}

export interface Harness {
  readonly manager: OrderManager;
  readonly venue: FakeVenue;
  readonly store: MemoryStore;
  readonly cipher: MockCipher;
  readonly reservations: OmsReservationPort;
  readonly inventory: ReturnType<typeof realInventory> | null;
  readonly reconciler: RecordingReconciler;
  readonly mode: { value: VenueMode };
  readonly deps: OrderManagerDependencies;
}

export interface HarnessOptions {
  readonly reservations?: OmsReservationPort;
  readonly balances?: { readonly pusd?: string; readonly yes?: string };
  readonly newId?: () => string;
  readonly requestToken?: () => string;
  /** Defaults to the fake restorer (which mirrors the real envelope's shape check). */
  readonly restoreSignedOrder?: RestoreSignedOrder;
}

export async function openHarness(options: HarnessOptions = {}): Promise<Harness> {
  const venue = new FakeVenue();
  const store = new MemoryStore();
  const cipher = new MockCipher();
  const inventory = options.reservations === undefined ? realInventory(options.balances) : null;
  const reservations = options.reservations ?? (inventory as NonNullable<typeof inventory>).service;
  const reconciler = new RecordingReconciler();
  const mode = { value: "NORMAL" as VenueMode };
  const deps: OrderManagerDependencies = {
    venue,
    restoreSignedOrder: options.restoreSignedOrder ?? restoreFakeSignedOrder,
    store,
    cipher,
    reservations,
    reconciler,
    newId: options.newId ?? idSource(0xa),
    requestToken: options.requestToken ?? tokenSource(),
    venueMode: () => mode.value,
    collateralAssetId: PUSD,
  };
  const opened = await OrderManager.open(deps);
  if (!opened.ok) throw new Error(`open failed: ${opened.refusal.code}`);
  return { manager: opened.value, venue, store, cipher, reservations, inventory, reconciler, mode, deps };
}

/** A process restart: a fresh manager over the same durable store and the same external world. */
export async function reopen(h: Harness, overrides: Partial<OrderManagerDependencies> = {}): Promise<Harness> {
  const deps: OrderManagerDependencies = { ...h.deps, ...overrides };
  const opened = await OrderManager.open(deps);
  if (!opened.ok) throw new Error(`reopen failed: ${opened.refusal.code}`);
  return { ...h, manager: opened.value, deps };
}

export const PLAN = uuid7(0xb, 1);
export const MARKET = uuid7(0xc, 1);
export const INSTANCE_A = uuid7(0xd, 1);
export const INSTANCE_B = uuid7(0xd, 2);

export function group(n: number, overrides: Partial<GroupSpec> = {}): GroupSpec {
  return {
    executionGroupId: uuid7(0xe, n),
    planId: PLAN,
    marketId: MARKET,
    tokenId: YES,
    accountRef: ACCOUNT,
    side: "BUY",
    plannedShares: "10",
    postOnly: false,
    ...overrides,
  };
}

let ticketCounter = 0;

/** A BUY (by default) ticket in group `g`, fully attributed to one intent of instance A. */
export function ticket(g: GroupSpec, overrides: Partial<OrderTicket> & { readonly n?: number } = {}): OrderTicket {
  ticketCounter += 1;
  const n = overrides.n ?? ticketCounter;
  const shares = overrides.shares ?? g.plannedShares;
  const limitPrice = overrides.limitPrice ?? "0.5";
  const amount =
    g.side === "BUY" ? multiply(limitPrice, shares) : shares;
  const base: OrderTicket = {
    orderId: uuid7(0xf, n),
    executionGroupId: g.executionGroupId,
    limitPrice,
    shares,
    reservation: { reservationId: `res-${String(n)}`, assetId: g.side === "BUY" ? PUSD : g.tokenId, amount },
    attributions: [{ intentId: uuid7(0x1, n), approvedIntentId: uuid7(0x2, n), instanceId: INSTANCE_A, shares }],
  };
  const { n: _ignored, ...rest } = overrides;
  void _ignored;
  return { ...base, ...rest };
}

/** Exact decimal multiplication for fixtures (BigInt; no float). */
export function multiply(a: string, b: string): string {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const product = BigInt(ai + af) * BigInt(bi + bf);
  const scale = af.length + bf.length;
  const text = product.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale);
  const frac = scale === 0 ? "" : text.slice(text.length - scale).replace(/0+$/u, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** Settle microtasks so a fire-and-forget persist chain completes. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
