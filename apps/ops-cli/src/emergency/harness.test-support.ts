/**
 * TEST SUPPORT for the emergency CLI's tests (imported only by `*.test.ts`).
 * Nothing here reaches a network, a key, a signer, a database or a venue:
 *
 * - {@link FakeClock}: epoch milliseconds that move only when the CLI sleeps;
 * - {@link FakeVenue}: an in-memory account (open orders, positions,
 *   collateral, approvals) behind the cancel half of WP-260's interface and
 *   WP-290's `AccountReadPort`, recording every call;
 * - {@link harness}: a complete `OpsCliDependencies` whose run-mode flags are
 *   LIVE-SHAPED literals (the WP-260 precedent: such a context only ever
 *   reaches these fakes or a refusal), whose emergency credential is a plain
 *   `{ accountRef }` with nothing in it, and whose lease store THROWS if it is
 *   ever opened (only stop-heartbeat may open it).
 *
 * The rate-limit snapshot is WP-310's dated contract snapshot
 * (`test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json`,
 * venue values with their source), read, never edited. One operation the CLI
 * reads with is not in it, `data.v2.approvals`; {@link contractSnapshot} adds
 * it for tests only, on the documented "all `/v2` endpoints" general class
 * (`docs/venue/verified-2026-09-16.md` §8), and says so in its source note.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AccountReadPort } from "@polymarket-bot/oms";
import { SecureVenueError, type CancelMarketFilter, type CancelOutcome, type SecureOperation, type VenueAccountIdentity } from "@polymarket-bot/polymarket-secure";

import type { AuditMirror, AuditRecord, AuditSink } from "./audit-log.js";
import { AuditUnavailableError } from "./audit-log.js";
import { OPS_CONFIGURATION_SCHEMA } from "./configuration.js";
import type { FencingLeaseView } from "@polymarket-bot/storage-postgres";

import type {
  ConfirmationPrompt,
  EmergencyCancelClient,
  EmergencyVenue,
  FencingLeaseAccess,
  FencingLeaseAccessFactory,
  OpsClock,
  ProjectionSource,
} from "./ports.js";
import type { OpsCliDependencies } from "./run.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const CONTRACT_SNAPSHOT_PATH = "test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json";

/** After the contract snapshot's `effectiveFrom` (2026-09-30T05:12:03Z). */
export const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
export const ACCOUNT = "acct-emergency-1";
export const OPERATOR = "operator-ana";
export const SIGNER = `0x${"5".repeat(40)}`;
export const WALLET = `0x${"6".repeat(40)}`;
export const PUSD = "pusd-collateral";
export const EXCHANGE = `0x${"e".repeat(40)}`;
export const CONDITION = `0x${"c".repeat(64)}`;
export const TOKEN_YES = "1111";
export const TOKEN_NO = "2222";

/** Live-SHAPED run-mode flags: they reach only the fakes in this file. */
export const LIVE_FLAGS: Readonly<Record<string, string>> = Object.freeze({ RUN_MODE: "LIVE_MICRO", MAX_RUN_MODE: "LIVE_MICRO", ALLOW_REAL_ORDERS: "true" });
/** The repository defaults (ADR-010 §1). */
export const PAPER_FLAGS: Readonly<Record<string, string>> = Object.freeze({ RUN_MODE: "PAPER", MAX_RUN_MODE: "PAPER", ALLOW_REAL_ORDERS: "false" });

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** WP-310's dated contract snapshot, read fresh, plus the test-only approvals operation. Optional policy overrides. */
export function contractSnapshot(policy: Readonly<Record<string, Json>> = {}): { [key: string]: Json } {
  const snapshot = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT_SNAPSHOT_PATH), "utf8")) as { [key: string]: Json };
  const operations = snapshot["operations"] as Json[];
  operations.push({
    operationId: "data.v2.approvals",
    kind: "READ",
    ipEndpointClasses: ["general", "data.v2.general"],
    signerBucket: null,
    relayer: false,
    tokenCost: null,
  });
  const source = snapshot["source"] as { [key: string]: Json };
  source["policyAuthority"] = `${String(source["policyAuthority"])}; WP-330 tests add data.v2.approvals on the documented general /v2 class`;
  snapshot["policy"] = { ...(snapshot["policy"] as { [key: string]: Json }), ...policy };
  return snapshot;
}

export function testConfiguration(overrides: Readonly<Record<string, Json>> = {}): { [key: string]: Json } {
  return {
    schema: OPS_CONFIGURATION_SCHEMA,
    rateLimitSnapshots: [contractSnapshot()],
    maxBudgetWaitMs: 30_000,
    venueAnswerBoundMs: 30_000,
    reconciliation: {
      collateralAssetId: PUSD,
      quiescenceHorizonMs: 5_000,
      maxReadSpanMs: 2_000,
      holdingConfirmationMs: 1_000,
      requiredApprovalSpenders: [EXCHANGE],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Time and ids.

export class FakeClock implements OpsClock {
  now: number;
  readonly sleeps: number[] = [];

  constructor(start: number = T0) {
    this.now = start;
  }

  nowMs(): number {
    return this.now;
  }

  /** Advances at once, and resolves on a later turn of the event loop (as a real timer would: never synchronously). */
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.now += ms;
    return new Promise((resolve) => setImmediate(resolve));
  }

  advance(ms: number): void {
    this.now += ms;
  }
}

/** Deterministic, distinct UUIDv7 text. */
export function uuidSource(startMs: number = T0): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const time = Math.floor(startMs).toString(16).padStart(12, "0");
    const tail = counter.toString(16).padStart(12, "0");
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7000-8000-${tail}`;
  };
}

// ---------------------------------------------------------------------------
// WP-260's typed errors, as its client would map them.

/** A 429 through the pinned SDK: kind RATE_LIMITED, effect UNKNOWN (WP-260 CX-R3-01). */
export function rateLimited(operation: SecureOperation, retryAfterSeconds: number): SecureVenueError {
  return new SecureVenueError({
    kind: "RATE_LIMITED",
    operation,
    effect: "UNKNOWN",
    httpStatus: 429,
    venueCode: null,
    undocumentedVenueCode: false,
    retryAfterSeconds,
    cancelsAvailable: null,
    source: "RateLimitError",
  });
}

/** A documented refusal, unapplied (503 `post_only_mode`: WP-260's only NOT_APPLIED). */
export function refusedUnapplied(operation: SecureOperation): SecureVenueError {
  return new SecureVenueError({
    kind: "POST_ONLY_MODE",
    operation,
    effect: "NOT_APPLIED",
    httpStatus: 503,
    venueCode: "post_only_mode",
    undocumentedVenueCode: false,
    retryAfterSeconds: null,
    cancelsAvailable: "YES",
    source: "RequestRejectedError",
  });
}

/** A transport failure: the request may or may not have reached the venue. */
export function transportFailure(operation: SecureOperation): SecureVenueError {
  return new SecureVenueError({
    kind: "TRANSPORT_FAILURE",
    operation,
    effect: "UNKNOWN",
    httpStatus: null,
    venueCode: null,
    undocumentedVenueCode: false,
    retryAfterSeconds: null,
    cancelsAvailable: null,
    source: "TransportError",
  });
}

// ---------------------------------------------------------------------------
// The venue.

export interface FakeOrder {
  readonly venueOrderId: string;
  readonly tokenId: string;
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly originalSize: string;
  sizeMatched: string;
  status: "LIVE" | "CANCELED" | "MATCHED";
}

export function order(id: string, overrides: Partial<FakeOrder> = {}): FakeOrder {
  return { venueOrderId: id, tokenId: TOKEN_YES, market: CONDITION, side: "BUY", price: "0.42", originalSize: "10", sizeMatched: "0", status: "LIVE", ...overrides };
}

export interface VenueCall {
  readonly method: string;
  readonly at: number;
  readonly args: readonly unknown[];
}

/**
 * An in-memory account. Cancels apply at once unless scripted; `resist`
 * holds orders the venue answers "not canceled"; `ignoreCancelAll` leaves
 * orders listed after a cancel-all that canceled others (so a by-id sweep is
 * needed); `beforeCall` runs before each call (to check what was durable at
 * that instant).
 */
export class FakeVenue {
  readonly orders = new Map<string, FakeOrder>();
  readonly calls: VenueCall[] = [];
  readonly resist = new Set<string>();
  readonly ignoreCancelAll = new Set<string>();
  positions: { tokenId: string; size: string }[] = [];
  collateral = "100";
  approvals: { spender: string; approved: boolean }[] = [{ spender: EXCHANGE, approved: true }];
  /** Per-method answer overrides (read or cancel), checked before the default. */
  readonly scripted = new Map<string, (...args: unknown[]) => unknown>();
  beforeCall: ((method: string) => void) | null = null;
  readonly identity: VenueAccountIdentity = Object.freeze({ signerAddress: SIGNER, walletAddress: WALLET, signerType: "EOA", walletType: 0 });
  closed = 0;

  constructor(readonly clock: FakeClock) {}

  add(...orders: FakeOrder[]): this {
    for (const entry of orders) this.orders.set(entry.venueOrderId, entry);
    return this;
  }

  open(): FakeOrder[] {
    return [...this.orders.values()].filter((entry) => entry.status === "LIVE");
  }

  callsOf(method: string): VenueCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  #record(method: string, args: readonly unknown[]): ((...a: unknown[]) => unknown) | undefined {
    this.beforeCall?.(method);
    this.calls.push({ method, at: this.clock.nowMs(), args });
    return this.scripted.get(method);
  }

  #cancelIds(ids: readonly string[]): CancelOutcome {
    const canceled: string[] = [];
    const notCanceled: { orderId: string; reason: string }[] = [];
    for (const id of ids) {
      const entry = this.orders.get(id);
      if (entry === undefined) notCanceled.push({ orderId: id, reason: "Order not found" });
      else if (this.resist.has(id)) notCanceled.push({ orderId: id, reason: "Order already matched" });
      else if (entry.status !== "LIVE") notCanceled.push({ orderId: id, reason: "Order already canceled" });
      else {
        entry.status = "CANCELED";
        canceled.push(id);
      }
    }
    return { kind: "COMPLETED", canceled, notCanceled };
  }

  readonly cancels: EmergencyCancelClient = {
    identity: this.identity,
    cancelOrder: async (orderId: string) => {
      const script = this.#record("cancelOrder", [orderId]);
      return script !== undefined ? ((await script(orderId)) as CancelOutcome) : this.#cancelIds([orderId]);
    },
    cancelOrders: async (orderIds: readonly string[]) => {
      const script = this.#record("cancelOrders", [[...orderIds]]);
      return script !== undefined ? ((await script(orderIds)) as CancelOutcome) : this.#cancelIds(orderIds);
    },
    cancelMarketOrders: async (filter: CancelMarketFilter) => {
      const script = this.#record("cancelMarketOrders", [filter]);
      if (script !== undefined) return (await script(filter)) as CancelOutcome;
      const market = "market" in filter ? filter.market : undefined;
      const asset = "assetId" in filter ? filter.assetId : undefined;
      const ids = this.open()
        .filter((entry) => (market === undefined || entry.market === market) && (asset === undefined || entry.tokenId === asset))
        .map((entry) => entry.venueOrderId);
      return this.#cancelIds(ids);
    },
    cancelAll: async () => {
      const script = this.#record("cancelAll", []);
      if (script !== undefined) return (await script()) as CancelOutcome;
      const ids = this.open()
        .map((entry) => entry.venueOrderId)
        .filter((id) => !this.ignoreCancelAll.has(id));
      return this.#cancelIds(ids);
    },
    close: async () => {
      this.closed += 1;
      return Promise.resolve();
    },
  };

  readonly reads: AccountReadPort = {
    listOpenOrders: async () => {
      const script = this.#record("listOpenOrders", []);
      if (script !== undefined) return script();
      return {
        route: "/data/orders",
        complete: true,
        orders: this.open().map(({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status }) => ({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status })),
      };
    },
    readOrder: async (venueOrderId: string) => {
      const script = this.#record("readOrder", [venueOrderId]);
      if (script !== undefined) return script(venueOrderId);
      const entry = this.orders.get(venueOrderId);
      if (entry === undefined) return { route: "/data/order", found: false };
      const { tokenId, side, price, originalSize, sizeMatched, status } = entry;
      return { route: "/data/order", found: true, order: { venueOrderId, tokenId, side, price, originalSize, sizeMatched, status } };
    },
    listTrades: async () => {
      const script = this.#record("listTrades", []);
      return script !== undefined ? script() : { route: "/data/trades", complete: true, trades: [] };
    },
    readPositions: async () => {
      const script = this.#record("readPositions", []);
      return script !== undefined ? script() : { route: "/v2/positions", complete: true, positions: this.positions.map((line) => ({ ...line })) };
    },
    readCollateral: async () => {
      const script = this.#record("readCollateral", []);
      return script !== undefined ? script() : { source: "ONCHAIN_ERC20_BALANCE", assetId: PUSD, balance: this.collateral };
    },
    readApprovals: async () => {
      const script = this.#record("readApprovals", []);
      return script !== undefined ? script() : { route: "/v2/approvals", approvals: this.approvals.map((line) => ({ ...line })) };
    },
    readWalletMember: async (member) => {
      this.#record("readWalletMember", [member]);
      return Promise.reject(new Error("no wallet member in this account"));
    },
  };

  binding(): EmergencyVenue {
    return { cancels: this.cancels, reads: this.reads };
  }
}

// ---------------------------------------------------------------------------
// The harness.

export const NON_INTERACTIVE: ConfirmationPrompt = Object.freeze({
  interactive: false,
  ask: () => Promise.reject(new Error("a non-interactive prompt must never be asked")),
});

export function typedPrompt(answer: string | null): ConfirmationPrompt & { readonly questions: string[] } {
  const questions: string[] = [];
  return { interactive: true, questions, ask: (question: string) => (questions.push(question), Promise.resolve(answer)) };
}

export interface MemoryAudit extends AuditSink {
  readonly records: AuditRecord[];
  failOn: AuditRecord["phase"] | null;
}

export function memoryAudit(): MemoryAudit {
  const records: AuditRecord[] = [];
  const sink: MemoryAudit = {
    location: "memory://ops-cli-audit",
    records,
    failOn: null,
    append(record: AuditRecord): Promise<void> {
      if (sink.failOn === record.phase) return Promise.reject(new AuditUnavailableError("WRITE_FAILED", "memory://ops-cli-audit"));
      records.push(record);
      return Promise.resolve();
    },
  };
  return sink;
}

export const LEASES_FORBIDDEN: FencingLeaseAccessFactory = Object.freeze({
  open: () => Promise.reject(new Error("the fencing lease store must not be opened by this command")),
});

export interface Harness {
  readonly clock: FakeClock;
  readonly venue: FakeVenue;
  readonly audit: MemoryAudit;
  readonly output: string[];
  /** Which ports were touched, in order. */
  readonly touched: string[];
  deps(argv: readonly string[], overrides?: Partial<OpsCliDependencies>): OpsCliDependencies;
  text(): string;
}

/** Arguments every command needs, plus the given ones. */
export function args(command: string, ...rest: string[]): string[] {
  return [command, ...rest, "--account", ACCOUNT, "--operator", OPERATOR];
}

export const DESTRUCTIVE_REASON = ["--reason", "incident 42: stop all exposure"];

export function harness(options: { readonly configuration?: unknown; readonly mirror?: AuditMirror | null; readonly projection?: ProjectionSource | null } = {}): Harness {
  const clock = new FakeClock();
  const venue = new FakeVenue(clock);
  const audit = memoryAudit();
  const output: string[] = [];
  const touched: string[] = [];
  const newId = uuidSource();
  return {
    clock,
    venue,
    audit,
    output,
    touched,
    text: () => output.join("\n"),
    deps: (argv, overrides = {}) => ({
      argv,
      runModeFlags: LIVE_FLAGS,
      defaultAuditLogPath: audit.location,
      out: { line: (text: string) => void output.push(text) },
      prompt: NON_INTERACTIVE,
      clock,
      newId,
      openAuditLog: () => audit,
      auditMirror: options.mirror ?? null,
      configuration: {
        load: () => {
          touched.push("configuration");
          return Promise.resolve({ kind: "LOADED" as const, document: options.configuration ?? testConfiguration() });
        },
      },
      credentials: {
        load: (request) => {
          touched.push("credentials");
          return Promise.resolve({ kind: "LOADED" as const, credential: { accountRef: request.accountRef } });
        },
      },
      venues: {
        open: () => {
          touched.push("venues");
          return Promise.resolve({ kind: "OPEN" as const, venue: venue.binding() });
        },
      },
      leases: LEASES_FORBIDDEN,
      projection: options.projection ?? null,
      ...overrides,
    }),
  };
}

/** The phases of the audit records, in order. */
export function phases(records: readonly AuditRecord[]): string[] {
  return records.map((record) => record.phase);
}

// ---------------------------------------------------------------------------
// The fencing lease (stop-heartbeat).

export const LEASE_ID = "01a10bef-6200-7000-8000-00000000abcd";

export interface FakeLeases {
  readonly factory: FencingLeaseAccessFactory;
  readonly currentCalls: { readonly accountRef: string; readonly environment: string }[];
  readonly revoked: { readonly fencingLeaseId: string; readonly reason: string }[];
  opened: number;
  closed: number;
  lease: FencingLeaseView | null;
}

export function leaseView(overrides: Partial<FencingLeaseView> = {}): FencingLeaseView {
  return {
    fencingLeaseId: LEASE_ID,
    fencingToken: "42",
    accountRef: ACCOUNT,
    environment: "LIVE_MICRO",
    holderId: "trader-host-a:pid-77",
    heartbeatId: "hb-rotating-id-not-printed",
    expiresAt: "2026-10-05T12:00:30.000Z",
    ...overrides,
  };
}

/** WP-320's two lease operations, in memory: `revoke` ends exactly the named ACTIVE lease, as the store does. */
export function fakeLeases(initial: FencingLeaseView | null = leaseView()): FakeLeases {
  const state: FakeLeases = {
    currentCalls: [],
    revoked: [],
    opened: 0,
    closed: 0,
    lease: initial,
    factory: {
      open: () => {
        state.opened += 1;
        const leases: FencingLeaseAccess = {
          current: (accountRef: string, environment: string) => {
            state.currentCalls.push({ accountRef, environment });
            return Promise.resolve(state.lease);
          },
          revoke: (input) => {
            state.revoked.push({ ...input });
            if (state.lease !== null && state.lease.fencingLeaseId === input.fencingLeaseId) {
              state.lease = null;
              return Promise.resolve(true);
            }
            return Promise.resolve(false);
          },
        };
        return Promise.resolve({
          kind: "OPEN" as const,
          leases,
          close: () => {
            state.closed += 1;
            return Promise.resolve();
          },
        });
      },
    },
  };
  return state;
}
