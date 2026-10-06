/**
 * WP-340: THE MOCK CLOB. A test-tree simulation of the venue's DOCUMENTED
 * behaviour, and the ground truth every live-shaped process in this suite
 * trades against. Nothing here reaches a network, holds a key or signs a
 * real order: "signatures" come from WP-260's mock signer (r = 0, never a
 * valid secp256k1 signature), and every request arrives in memory.
 *
 * ## How a process reaches it
 *
 * Through the REAL WP-260 `SecureVenueClient`, built by
 * `createSecureVenueClientForTesting` (the run-mode gate still runs, with a
 * live-SHAPED literal context, and only the mock signer is accepted) over
 * WP-260's fake-SDK seam (`createFakeSdkFactory`). {@link MockClob.sdk}
 * scripts that seam: signing, placement, cancels and the rate-limit
 * listener all land here. Failures are the pinned SDK's OWN error objects
 * (`sdk-errors.ts`), so WP-260's classification runs exactly as it would on
 * a live answer. The user channel ({@link MockClob.subscribe}), the order
 * heartbeat ({@link MockClob.heartbeat}) and the authenticated account reads
 * (WP-290's `AccountReadPort`, inherited from `ReconWorld`) are the other
 * three surfaces.
 *
 * ## What it models (cited; `mock-venue-facts.test.ts` pins each citation verbatim)
 *
 * | Behaviour | Source |
 * | --- | --- |
 * | Order heartbeat: once the first heartbeat is accepted, a valid one must arrive within 10 s, else every open order of those credentials is canceled; the check runs every 5 s | `verified-2026-09-16.md` §5 (S-D17), unchanged `verified-2026-09-30.md` §5 |
 * | Heartbeat id chain: empty id to start, each success returns the next id, an invalid id gets `400` with the expected id | same |
 * | `425` on order-related requests while the engine restarts, optional `Retry-After`; then post-only for two minutes (cancels allowed, non-post-only orders refused `503 post_only_mode`) | `verified-2026-09-30.md` §9, E-06 |
 * | Cancel-only / disabled trading: placements get `503 {"error": "trading is disabled"}`; cancels "work even in cancel-only mode" | §9 E-05, §2.5 |
 * | Placement statuses `live` / `unmatched`; the pinned SDK turns `unmatched` into `{ok:false, code:"unmatched"}` | §2.2, C-6; WP-260 handoff |
 * | Batch placement of 1–15 orders; batch cancel ≤ 1,000 ids (C-11, the lower figure) | §W.3 |
 * | Cancel answers `{canceled, not_canceled}` with the documented reasons | §2.5 |
 * | Order and cancel buckets PER SIGNER ADDRESS, shared by every API key of that signer (Standard tier: order 60 burst, 40/s; cancel 120 burst, 80/s); a batch admitted only with tokens for every entry; `Poly-RateLimit-*` feedback, `429` with `Retry-After` | §8 (S-D25), WP-310's dated snapshot `rate-limits-2026-09-30` |
 * | D-21: a cancel-all or cancel-market request first consumes one cancel token, then one more per order canceled once the result is known, which may put the Standard tier's bucket in debt; later cancel requests stay blocked until the bucket holds enough tokens for the next one | `verified-2026-09-16.md` §8 D-21 |
 * | User channel: `order` events (`PLACEMENT`/`UPDATE`/`CANCELLATION`) and `trade` events (`MATCHED` … `CONFIRMED`), no replay of missed events | §4, §W.4 |
 * | Reads: open orders (an absent order is not proof of cancellation), by id "regardless of status", trades, `/v2/positions`, on-chain collateral, `/v2/approvals` | §W.9 E-14, E-15; `ReconWorld` |
 *
 * ## What it ASSUMES (undocumented; every one is a labelled test assumption in the report)
 *
 * - A1: API keys of one account see and act on the account's orders: open-order reads, by-id cancels and the user
 *   channel (Session Keys, which see only their own, are not modelled; E-16).
 * - A2: `DELETE /cancel-all` cancels the open orders OWNED BY THE CALLING CREDENTIALS (WP-330's own plan text);
 *   `cancelAllScope: "ACCOUNT"` models the wider reading.
 * - A3: while the heartbeat stays lapsed, EVERY check cancels the credentials' open orders, including orders placed
 *   after the first sweep; the id chain is unchanged by a sweep; an empty id after the chain started is invalid.
 * - A4: a heartbeat request is answered normally in every engine mode; reads are answered in every mode.
 * - A5: a cancel refused `425` during a restart was not applied.
 * - A6: the check timer's phase is fixed when the venue starts; a valid heartbeat at exactly 10 s still counts.
 * - A7: our orders rest (they never cross on arrival); fills are the venue's later matches, at the order's price,
 *   fee 0, as WP-290's `ReconWorld` books them.
 * - A8: a user-channel frame is pushed through the shared time line, so it reaches a process only when that time
 *   line turns, AFTER the REST answer of the request that caused it (REST answers are synchronous here). The venue
 *   documents no ordering between a REST answer and the push of the same change (WP340-F1's route 3 rests on this).
 * - A9: the rate-limit details the docs leave open: tokens refill continuously at the tier's rate; a request refused
 *   `429` (an order batch, or a cancel blocked by D-21) consumes nothing and is answered with the pinned SDK's
 *   `RateLimitError` (`Retry-After: 2`); a by-id cancel batch, like a placement batch, is admitted only with a token
 *   for every id; callers sharing one signer's buckets are served in arrival order (bucket arbitration is
 *   undocumented, `verified-2026-09-16.md` §12); a 425'd cancel consumes nothing (with A5).
 *
 * ## The oracle it keeps (independent of the system under test)
 *
 * - S2: no new salt is SIGNED for an execution group while another salt of it is live at the venue or may still
 *   arrive (inherited from WP-270/WP-290's oracle);
 * - DUPLICATE_EXPOSURE: never two live orders of one execution group at the venue;
 * - OVER_EXPOSURE: a group's matched plus open size never exceeds its planned shares;
 * - every signature it produced, so a suite can prove none reached any store in clear.
 */

import { addDecimal, compareDecimal, subDecimal } from "../../../../packages/decimal/src/index.js";
import type { CancelOutcome } from "../../../../packages/oms/src/index.js";
import {
  createFakeSdkFactory,
  DEFAULT_FAKE_ACCOUNT,
  MOCK_FIXTURE_DOMAIN_NAME,
  type FakeSdkScript,
} from "../../../../packages/polymarket-secure/src/testing/index.js";
import type { SdkClientFactory, SdkClientFactoryArguments } from "../../../../packages/polymarket-secure/src/sdk-port.js";
import type { HeartbeatRequest, OrderHeartbeatTransport } from "../../../../packages/polymarket-secure/src/heartbeat/index.js";
import { ReconWorld, type VenueOrder, type VenueTrade } from "../../reconciliation/support/world.js";
import { OUR_OWNER, WP280_MARKET, wireOrder, wireTrade } from "../../reconciliation/support/wp280.js";

import type { SdkErrors } from "./sdk-errors.js";

/** The time line the venue lives on: the shared monotonic clock and its timer queue (WP-320's `ManualTime`). */
export interface ClobTime {
  readonly now: number;
  epochMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A kill point a process incarnation counts (WP-290's `Incarnation.call`); the identity when nothing is counted. */
export type Checkpoint = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const NO_CHECKPOINT: Checkpoint = (_name, run) => run();

/** How the venue answers the next placement it is sent. */
export type PlacementAnswer =
  /** Created; `live` is answered. */
  | "ACCEPT"
  /** Created; the answer is lost on the way back (the SDK's `TransportError`). */
  | "LOST_AFTER"
  /** Never reaches the venue (the SDK's `TransportError`). */
  | "LOST_BEFORE"
  /** Reaches the venue `lateMs` after it was sent; the sender sees a transport failure now. */
  | "LATE"
  /** Created; the venue answers `unmatched`, which the pinned SDK turns into `{ok:false, code:"unmatched"}`. */
  | "UNMATCHED"
  /** Not created; a documented rejection (`insufficient_balance_or_allowance`). */
  | "REJECT";

/** The engine's mode at an instant (§9). */
export type EngineMode = "NORMAL" | "RESTARTING" | "POST_ONLY" | "TRADING_DISABLED";

/** The documented post-only window after a restart: "enters post-only mode for two minutes" (§9, S-D26 line 33). */
export const POST_ONLY_AFTER_RESTART_MS = 120_000;
/** "if a valid heartbeat is not received within 10 seconds" (S-D17). */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** "The cancellation check runs every five seconds" (S-D17). */
export const CANCELLATION_CHECK_MS = 5_000;
/** C-11: the lower of the two documented batch-cancel limits. */
export const MAX_CANCEL_IDS = 1_000;
/** "1 to 15" orders per batch (§W.3). */
export const MAX_BATCH_ORDERS = 15;
/** The Standard tier's per-signer-address buckets (`rate-limits-2026-09-30`, §8): order 60 burst at 40/s; cancel 120 at 80/s, negative allowed (D-21). */
export const STANDARD_TIER = Object.freeze({ tier: "Standard", orderBurst: 60, orderPerSecond: 40, cancelBurst: 120, cancelPerSecond: 80 });

export interface CredentialRecord {
  /** The account the credentials act for (A1: one account, several API keys). */
  readonly account: string;
  /** The user-channel `owner` field this credential's orders carry. */
  readonly owner: string;
  /**
   * The signer address the credential's requests are signed and RATE-LIMITED under: §8's buckets are per signer
   * address, so every API key of one signer draws on the same two buckets. It is the fake SDK's account signer too.
   */
  readonly signer: string;
}

/** A token bucket in THOUSANDTHS of a token (exact integers: the refill of `ms` milliseconds at `r` tokens/s is `ms × r`). */
interface Bucket {
  milli: number;
  atMs: number;
}

interface HeartbeatChain {
  armed: boolean;
  expectedId: string | null;
  /** The venue's receipt instant of every VALID heartbeat, ascending. */
  readonly receipts: number[];
  issued: number;
  /** Requests are answered as a transport failure without reaching the venue (a network outage on this path). */
  outage: boolean;
}

/** One request the venue received, for the suites' oracles (never a decision input). */
export interface VenueLogEntry {
  readonly kind: "SIGN" | "PLACE" | "CANCEL" | "CANCEL_ALL" | "HEARTBEAT";
  readonly credential: string;
  /** The process that sent it (a label only the suite sees; the venue cannot tell processes apart: ADR-008 §4). */
  readonly source: string;
  readonly atMs: number;
  readonly detail: string;
  /** Whether the request took effect at the venue (an order created, a heartbeat accepted, an order canceled). */
  readonly effective: boolean;
}

export interface SweepRecord {
  readonly credential: string;
  readonly atMs: number;
  readonly canceled: readonly string[];
}

/** A wire frame for the user channel, before any chaos. */
export interface PublishedFrame {
  readonly seq: number;
  readonly text: string;
  readonly market: string;
  readonly eventType: "order" | "trade";
  readonly type: string;
  readonly id: string;
}

/** A subscriber of the user channel (one connection of one process). */
export interface ChannelSubscriber {
  readonly credential: string;
  readonly markets: Set<string>;
  push(frame: PublishedFrame): void;
}

const MATCHED_AT_SECONDS = String(Date.UTC(2026, 9, 3, 0, 0, 0) / 1000);

export interface MockClobOptions {
  readonly time: ClobTime;
  readonly errors: SdkErrors;
  readonly collateral: string;
  readonly collateralAssetId: string;
  /** Every credential the venue knows, by API-key label. */
  readonly credentials?: Readonly<Record<string, CredentialRecord>>;
}

export class MockClob extends ReconWorld {
  readonly time: ClobTime;
  readonly errors: SdkErrors;
  readonly credentials: Readonly<Record<string, CredentialRecord>>;
  /** Signature by salt: every signature the mock signer produced through this venue. */
  readonly signatures = new Map<string, string>();
  /** The credential each salt was placed under. */
  readonly placedBy = new Map<string, string>();
  readonly log: VenueLogEntry[] = [];
  readonly sweeps: SweepRecord[] = [];
  readonly frames: PublishedFrame[] = [];
  /** Planned shares by execution group (`token|side`), for OVER_EXPOSURE. */
  readonly plannedShares = new Map<string, string>();
  /** The answer to the next placements (each call takes one; then `ACCEPT`). */
  readonly answers: PlacementAnswer[] = [];
  /** A2: whose orders `DELETE /cancel-all` cancels. */
  cancelAllScope: "CREDENTIAL" | "ACCOUNT" = "CREDENTIAL";
  /** Answer 425s with the documented example `Retry-After: 1` (E-06), or with no header. */
  restartRetryAfter = false;
  /** A cancel the venue never answers (it stays pending; nothing is canceled). */
  readonly hangCancels = new Set<string>();
  #mode: { readonly kind: EngineMode; readonly untilMs: number | null } = { kind: "NORMAL", untilMs: null };
  readonly #buckets = new Map<string, { order: Bucket; cancel: Bucket }>();
  readonly #chains = new Map<string, HeartbeatChain>();
  readonly #subscribers = new Set<ChannelSubscriber>();
  /** When each of our orders became live at the venue (a sweep at instant c cancels only orders live by c). */
  readonly #createdAt = new Map<string, number>();
  #nextCheckAtMs: number;
  readonly #rateLimitListeners = new Map<string, ((update: Parameters<NonNullable<SdkClientFactoryArguments["onRateLimitUpdate"]>>[0]) => void)[]>();
  #salt = 340_000;
  #frameSeq = 0;

  constructor(options: MockClobOptions) {
    super({ now: () => options.time.epochMs(), collateral: options.collateral, collateralAssetId: options.collateralAssetId });
    this.time = options.time;
    this.errors = options.errors;
    // The trader's key and the separate emergency key (WP-330, handoff §15) of ONE account and ONE signer.
    this.credentials = options.credentials ?? {
      trader: { account: "acct-live-1", owner: OUR_OWNER, signer: DEFAULT_FAKE_ACCOUNT.signer },
      emergency: { account: "acct-live-1", owner: OUR_OWNER, signer: DEFAULT_FAKE_ACCOUNT.signer },
    };
    this.#nextCheckAtMs = options.time.now + CANCELLATION_CHECK_MS;
    this.#scheduleCheck();
  }

  // -------------------------------------------------------------------------
  // The engine's mode (§9).

  /** A matching-engine restart: 425 for `durationMs`, then post-only for two minutes, then normal. */
  restart(durationMs: number): void {
    this.#mode = { kind: "RESTARTING", untilMs: this.time.now + durationMs };
  }

  /** Cancel-only / disabled trading until `clearTradingDisabled` (E-05: the two are indistinguishable). */
  disableTrading(): void {
    this.#mode = { kind: "TRADING_DISABLED", untilMs: null };
  }

  clearTradingDisabled(): void {
    this.#mode = { kind: "NORMAL", untilMs: null };
  }

  mode(): EngineMode {
    const now = this.time.now;
    if (this.#mode.kind === "RESTARTING" && this.#mode.untilMs !== null && now >= this.#mode.untilMs) {
      this.#mode = { kind: "POST_ONLY", untilMs: this.#mode.untilMs + POST_ONLY_AFTER_RESTART_MS };
    }
    if (this.#mode.kind === "POST_ONLY" && this.#mode.untilMs !== null && now >= this.#mode.untilMs) this.#mode = { kind: "NORMAL", untilMs: null };
    return this.#mode.kind;
  }

  // -------------------------------------------------------------------------
  // Rate limits (§8).

  /** The signer address a credential's requests are rate-limited under (§8: per signer, not per API key). */
  signerOf(credential: string): string {
    const record = this.credentials[credential];
    if (record === undefined) throw new Error(`unknown credential ${credential}`);
    return record.signer;
  }

  /** The two buckets of the credential's SIGNER (shared by every API key of that signer), refilled to now. */
  #bucketsOf(credential: string): { order: Bucket; cancel: Bucket } {
    const signer = this.signerOf(credential);
    let buckets = this.#buckets.get(signer);
    if (buckets === undefined) {
      buckets = { order: { milli: STANDARD_TIER.orderBurst * 1000, atMs: this.time.now }, cancel: { milli: STANDARD_TIER.cancelBurst * 1000, atMs: this.time.now } };
      this.#buckets.set(signer, buckets);
    }
    const refill = (bucket: Bucket, burst: number, perSecond: number): void => {
      const now = this.time.now;
      if (now > bucket.atMs) bucket.milli = Math.min(burst * 1000, bucket.milli + (now - bucket.atMs) * perSecond);
      bucket.atMs = now;
    };
    refill(buckets.order, STANDARD_TIER.orderBurst, STANDARD_TIER.orderPerSecond);
    refill(buckets.cancel, STANDARD_TIER.cancelBurst, STANDARD_TIER.cancelPerSecond);
    return buckets;
  }

  /** Drain the order bucket of a credential's signer (a burst someone else spent): the next placements are refused 429 until it refills. */
  drainOrderBucket(credential: string): void {
    this.#bucketsOf(credential).order.milli = 0;
  }

  /** The token balance of a credential's signer's bucket now (the cancel bucket may be negative: D-21). */
  balance(credential: string, bucket: "order" | "cancel"): number {
    return this.#bucketsOf(credential)[bucket].milli / 1000;
  }

  #feedback(credential: string, bucket: "order" | "cancel"): void {
    const milli = this.#bucketsOf(credential)[bucket].milli;
    const update = { bucket, remaining: Math.floor(milli / 1000), reset: milli <= 0 ? Math.ceil(this.time.epochMs() / 1000) + 1 : undefined, tier: STANDARD_TIER.tier, warning: false };
    for (const listener of this.#rateLimitListeners.get(credential) ?? []) listener(update as never);
  }

  // -------------------------------------------------------------------------
  // The SDK seam (WP-260's fake SDK, scripted by the venue).

  /**
   * A fake-SDK factory bound to `credential`: hand it to `createSecureVenueClientForTesting`. `checkpoint` is the
   * process incarnation's kill point (every SDK-level step counts: the signer call, the venue's receipt, its answer).
   */
  sdk(credential: string, options: { readonly source?: string; readonly checkpoint?: Checkpoint; readonly alive?: () => boolean } = {}): SdkClientFactory {
    if (this.credentials[credential] === undefined) throw new Error(`unknown credential ${credential}`);
    const source = options.source ?? credential;
    const at = options.checkpoint ?? NO_CHECKPOINT;
    const alive = options.alive ?? ((): boolean => true);
    const script: FakeSdkScript = {
      account: { ...DEFAULT_FAKE_ACCOUNT, signer: this.signerOf(credential) },
      createLimitOrder: (request, signer) => this.#sign(credential, source, at, request as unknown as Readonly<Record<string, unknown>>, signer),
      postOrder: (order) => this.#post(credential, source, at, alive, [order as unknown as Readonly<Record<string, unknown>>], false),
      postOrders: (orders) => this.#post(credential, source, at, alive, orders as unknown as readonly Readonly<Record<string, unknown>>[], true),
      // The SDK's own answer types cannot be named here (only `packages/polymarket-secure` imports the SDK); the
      // shapes below are its documented `{canceled, notCanceled}` answers, read by WP-260's `mapCancelResponse`.
      cancelOrder: ((request: { readonly orderId: string }) => this.#cancelIds(credential, source, at, alive, [request.orderId], "single")) as never,
      cancelOrders: ((request: { readonly orderIds: readonly string[] }) => this.#cancelIds(credential, source, at, alive, request.orderIds, "batch")) as never,
      cancelMarketOrders: ((request: Readonly<Record<string, unknown>>) => this.#cancelMarket(credential, source, at, alive, request)) as never,
      cancelAll: (() => this.#cancelAll(credential, source, at, alive)) as never,
      fetchOrder: (() => {
        throw new Error("fetchOrder is not modelled by the mock CLOB");
      }) as never,
      closeSubscriptions: () => undefined,
    };
    const { factory } = createFakeSdkFactory(script);
    return async (args) => {
      if (args.onRateLimitUpdate !== undefined) {
        const list = this.#rateLimitListeners.get(credential) ?? [];
        list.push(args.onRateLimitUpdate);
        this.#rateLimitListeners.set(credential, list);
      }
      return factory(args);
    };
  }

  async #sign(
    credential: string,
    source: string,
    at: Checkpoint,
    request: Readonly<Record<string, unknown>>,
    signer: Parameters<NonNullable<FakeSdkScript["createLimitOrder"]>>[1],
  ): Promise<unknown> {
    const tokenId = String(request["assetId"]);
    const side = request["side"] === "SELL" ? "SELL" : "BUY";
    const price = String(request["price"]);
    const size = String(request["size"]);
    // S2 (the oracle): a new salt for a group while another of its salts is live at the venue or may still arrive.
    for (const [salt, facts] of this.signed) {
      if (facts.tokenId !== tokenId || facts.side !== side) continue;
      const order = this.orders.get(salt);
      if ((order !== undefined && order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0) || this.isPending(salt)) {
        this.fail(`S2: a new salt for ${tokenId} ${side} while salt ${salt} is live at the venue or may still arrive`);
      }
    }
    this.#salt += 1;
    const salt = String(this.#salt);
    const message = {
      salt,
      maker: DEFAULT_FAKE_ACCOUNT.wallet,
      signer: DEFAULT_FAKE_ACCOUNT.signer,
      signatureType: DEFAULT_FAKE_ACCOUNT.walletType,
      tokenId,
      ...fixtureAmounts(side, price, size),
      side,
      timestamp: "1790000000000",
      metadata: `0x${"0".repeat(64)}`,
      builder: `0x${"0".repeat(64)}`,
    };
    // The signer call is its own kill point: killed AFTER it, a signature exists that no process ever held.
    const signature = await at("sdk.signer.signTypedData", async () => {
      const made = await signer.signTypedData({
        domain: { name: MOCK_FIXTURE_DOMAIN_NAME, version: "0", chainId: 31337 },
        primaryType: "FixtureOrder",
        types: { FixtureOrder: [{ name: "salt", type: "uint256" }] },
        message,
      });
      this.signed.set(salt, { tokenId, side, price, size });
      this.signatures.set(salt, String(made));
      return made;
    });
    this.log.push({ kind: "SIGN", credential, source, atMs: this.time.now, detail: salt, effective: true });
    const expiration = typeof request["expiration"] === "number" ? request["expiration"] : 0;
    return {
      ...message,
      expiration,
      orderType: request["expiration"] === undefined ? "GTC" : "GTD",
      signature,
      ...(request["postOnly"] === undefined ? {} : { postOnly: request["postOnly"] }),
    };
  }

  /**
   * One request through ONE kill point around the venue's processing: killed BEFORE it, the request never left the
   * process (mid-transmission); killed AFTER it, the venue processed it and the answer never came back (mid-answer).
   * Processing never throws inside the checkpoint, so a refusal cannot skip the kill.
   */
  async #through<T>(at: Checkpoint, name: string, alive: () => boolean, process: () => Promise<T> | T): Promise<T> {
    const settled = await at(name, async (): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> => {
      if (!alive()) return { ok: false, error: this.errors.transportFailure };
      try {
        return { ok: true, value: await process() };
      } catch (error) {
        return { ok: false, error };
      }
    });
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  #post(credential: string, source: string, at: Checkpoint, alive: () => boolean, orders: readonly Readonly<Record<string, unknown>>[], batch: boolean): Promise<unknown> {
    return this.#through(at, "venue.process.placement", alive, () => this.#place(credential, source, orders, batch));
  }

  #place(credential: string, source: string, orders: readonly Readonly<Record<string, unknown>>[], batch: boolean): unknown {
    this.catchUp();
    // Every placement that arrives is RECEIVED, whatever the venue answers (WP-290's `ReconWorld` semantics).
    for (const order of orders) this.receipts.push(String(order["salt"]));
    const mode = this.mode();
    if (mode === "RESTARTING") {
      this.#logPlacements(credential, source, orders, false, "425");
      throw this.restartRetryAfter ? this.errors.engineRestartingRetryAfter1 : this.errors.engineRestarting;
    }
    if (mode === "TRADING_DISABLED") {
      this.#logPlacements(credential, source, orders, false, "503-disabled");
      throw this.errors.tradingDisabled;
    }
    if (mode === "POST_ONLY" && orders.some((order) => order["postOnly"] !== true)) {
      this.#logPlacements(credential, source, orders, false, "503-post-only");
      throw this.errors.postOnlyMode;
    }
    if (orders.length < 1 || orders.length > MAX_BATCH_ORDERS) throw new Error("the mock CLOB refuses a batch outside 1..15");
    const buckets = this.#bucketsOf(credential);
    if (buckets.order.milli < orders.length * 1000) {
      // §8: per-signer admission is all-or-nothing for a batch; the refused request consumes nothing (A9).
      this.#logPlacements(credential, source, orders, false, "429");
      this.#feedback(credential, "order");
      throw this.errors.rateLimited;
    }
    buckets.order.milli -= orders.length * 1000;
    const answers: unknown[] = [];
    let lost = false;
    for (const order of orders) {
      const salt = String(order["salt"]);
      if (!this.signed.has(salt)) throw new Error("an order the mock CLOB never signed reached it");
      if (this.signatures.get(salt) !== order["signature"]) this.fail(`a placement of salt ${salt} carried a signature the venue did not issue`);
      const answer = this.answers.shift() ?? "ACCEPT";
      switch (answer) {
        case "ACCEPT":
        case "LOST_AFTER":
        case "UNMATCHED":
          this.#createOwn(salt, credential);
          this.#logPlacement(credential, source, salt, true, answer);
          answers.push(answer === "UNMATCHED" ? { ok: false, code: "unmatched" } : liveAnswer(this.venueOrderIdOf(salt)));
          if (answer === "LOST_AFTER") lost = true;
          break;
        case "LOST_BEFORE": {
          // It never arrived: un-receive it (its last receipt).
          const index = this.receipts.lastIndexOf(salt);
          if (index >= 0) this.receipts.splice(index, 1);
          this.#logPlacement(credential, source, salt, false, answer);
          lost = true;
          answers.push(null);
          break;
        }
        case "LATE":
          this.pending.push({ salt, atMs: this.time.epochMs() + this.lateMs });
          this.placedBy.set(salt, credential);
          this.#logPlacement(credential, source, salt, false, answer);
          lost = true;
          answers.push(null);
          break;
        case "REJECT":
          this.#logPlacement(credential, source, salt, false, answer);
          answers.push({ ok: false, code: "insufficient_balance_or_allowance" });
          break;
      }
    }
    this.#feedback(credential, "order");
    if (lost) throw this.errors.transportFailure;
    return batch ? answers : answers[0];
  }

  #logPlacements(credential: string, source: string, orders: readonly Readonly<Record<string, unknown>>[], effective: boolean, detail: string): void {
    for (const order of orders) this.#logPlacement(credential, source, String(order["salt"]), effective, detail);
  }

  #logPlacement(credential: string, source: string, salt: string, effective: boolean, detail: string): void {
    this.log.push({ kind: "PLACE", credential, source, atMs: this.time.now, detail: `${salt}:${detail}`, effective });
  }

  venueOrderIdOf(salt: string): string {
    return `venue-${salt}`;
  }

  /** Create one of OUR orders (by salt) and run the exposure oracle; publish its PLACEMENT. */
  #createOwn(salt: string, credential: string): void {
    if (this.orders.has(salt)) return;
    const facts = this.signed.get(salt);
    if (facts === undefined) throw new Error("an unsigned salt reached the venue");
    for (const other of this.orders.values()) {
      if (other.foreign || other.tokenId !== facts.tokenId || other.side !== facts.side) continue;
      if (other.status === "LIVE" && compareDecimal(other.matched, other.original) < 0) {
        this.fail(`DUPLICATE_EXPOSURE: ${facts.tokenId} ${facts.side}: salt ${salt} became live while salt ${other.salt} is live`);
      }
    }
    this.orders.set(salt, {
      salt,
      venueOrderId: this.venueOrderIdOf(salt),
      tokenId: facts.tokenId,
      side: facts.side,
      price: facts.price,
      original: facts.size,
      matched: "0",
      status: "LIVE",
      foreign: false,
    });
    this.placedBy.set(salt, credential);
    this.#createdAt.set(salt, this.time.now);
    this.#checkExposure(facts.tokenId, facts.side);
    const order = this.orders.get(salt) as VenueOrder;
    this.#publishOrder(order, "PLACEMENT");
  }

  #checkExposure(tokenId: string, side: "BUY" | "SELL"): void {
    const planned = this.plannedShares.get(`${tokenId}|${side}`);
    if (planned === undefined) return;
    let exposure = "0";
    for (const order of this.orders.values()) {
      if (order.foreign || order.tokenId !== tokenId || order.side !== side) continue;
      exposure = addDecimal(exposure, order.status === "LIVE" ? order.original : order.matched);
    }
    if (compareDecimal(exposure, planned) > 0) this.fail(`OVER_EXPOSURE: ${tokenId} ${side}: ${exposure} exposed against ${planned} planned`);
  }

  /** Late transmissions arrive: create each (with the exposure oracle and its PLACEMENT event). */
  override settleArrivals(): void {
    this.catchUp();
    const now = this.time.epochMs();
    const due = this.pending.filter((entry) => entry.atMs <= now).map((entry) => entry.salt);
    for (const salt of due) {
      const index = this.pending.findIndex((entry) => entry.salt === salt);
      if (index >= 0) this.pending.splice(index, 1);
      this.#createOwn(salt, this.placedBy.get(salt) ?? "trader");
    }
  }

  // -------------------------------------------------------------------------
  // Cancels (§2.5).

  /** The account's open orders a credential may act on (A1), or only its own (`own`). */
  #openOrders(credential: string, own: boolean): VenueOrder[] {
    const account = this.credentials[credential]?.account;
    return [...this.orders.values()].filter(
      (order) =>
        order.status === "LIVE" &&
        compareDecimal(order.matched, order.original) < 0 &&
        (own ? this.placedBy.get(order.salt) === credential : order.foreign || this.credentials[this.placedBy.get(order.salt) ?? ""]?.account === account),
    );
  }

  #cancelOne(venueOrderId: string): { readonly canceled: boolean; readonly reason: string } {
    const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === venueOrderId);
    if (order === undefined) return { canceled: false, reason: "Order not found" };
    if (order.status === "CANCELED") return { canceled: false, reason: "Order already canceled" };
    if (compareDecimal(order.matched, order.original) >= 0) return { canceled: false, reason: "Order already matched" };
    order.status = "CANCELED";
    this.#publishOrder(order, "CANCELLATION");
    return { canceled: true, reason: "" };
  }

  /**
   * Admit one cancel request, or refuse it. A 425 during a restart (nothing consumed: A5, A9). Then D-21's
   * admission on the SIGNER's cancel bucket: "Future cancel requests remain blocked until the bucket has enough
   * tokens for the next request", so a request whose up-front cost (1 for cancel-all and cancel-market, one per
   * submitted id for `DELETE /order(s)`) exceeds the balance is refused `429`, consuming nothing (A9); otherwise the
   * up-front cost is consumed now.
   */
  #cancelGate(credential: string, source: string, kind: "CANCEL" | "CANCEL_ALL", detail: string, upfront: number): void {
    this.catchUp();
    if (this.mode() === "RESTARTING") {
      this.log.push({ kind, credential, source, atMs: this.time.now, detail: `${detail}:425`, effective: false });
      throw this.restartRetryAfter ? this.errors.engineRestartingRetryAfter1 : this.errors.engineRestarting;
    }
    const bucket = this.#bucketsOf(credential).cancel;
    if (bucket.milli < upfront * 1000) {
      this.log.push({ kind, credential, source, atMs: this.time.now, detail: `${detail}:429`, effective: false });
      this.#feedback(credential, "cancel");
      throw this.errors.rateLimited;
    }
    bucket.milli -= upfront * 1000;
  }

  /**
   * D-21's second debit, for cancel-all and cancel-market: "After the cancellation result is known, the bucket is
   * debited one additional token for every order successfully canceled"; on the Standard tier this "can put the
   * bucket into debt".
   */
  #debitCanceled(credential: string, canceled: number): void {
    this.#bucketsOf(credential).cancel.milli -= canceled * 1000;
  }

  async #cancelIds(credential: string, source: string, at: Checkpoint, alive: () => boolean, ids: readonly string[], kind: "single" | "batch"): Promise<unknown> {
    if (ids.some((id) => this.hangCancels.has(id))) return new Promise<never>(() => undefined);
    return this.#through(at, "venue.process.cancel", alive, () => this.#cancelIdsNow(credential, source, ids, kind));
  }

  #cancelIdsNow(credential: string, source: string, ids: readonly string[], kind: "single" | "batch"): unknown {
    if (ids.length < 1 || ids.length > MAX_CANCEL_IDS) throw new Error("the mock CLOB refuses a cancel batch outside 1..1000");
    this.#cancelGate(credential, source, "CANCEL", `${kind}:${ids.join(",")}`, ids.length);
    const canceled: string[] = [];
    const notCanceled: Record<string, string> = {};
    for (const id of [...new Set(ids)]) {
      const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === id);
      // A1: by-id cancels act on the account's orders, whichever of its API keys placed them.
      const sameAccount = order !== undefined && (order.foreign || this.credentials[this.placedBy.get(order.salt) ?? ""]?.account === this.credentials[credential]?.account);
      const result = sameAccount ? this.#cancelOne(id) : { canceled: false, reason: "Order not found" };
      if (result.canceled) canceled.push(id);
      else notCanceled[id] = result.reason;
      this.log.push({ kind: "CANCEL", credential, source, atMs: this.time.now, detail: id, effective: result.canceled });
    }
    this.#feedback(credential, "cancel");
    return { canceled, notCanceled };
  }

  #cancelMarket(credential: string, source: string, at: Checkpoint, alive: () => boolean, filter: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#through(at, "venue.process.cancel", alive, () => this.#cancelMarketNow(credential, source, filter));
  }

  #cancelMarketNow(credential: string, source: string, filter: Readonly<Record<string, unknown>>): unknown {
    const asset = typeof filter["assetId"] === "string" ? filter["assetId"] : undefined;
    const market = typeof filter["market"] === "string" ? filter["market"] : undefined;
    this.#cancelGate(credential, source, "CANCEL", `market:${asset ?? market ?? "?"}`, 1);
    const ids = this.#openOrders(credential, false)
      .filter((order) => (asset === undefined || order.tokenId === asset) && (market === undefined || market === WP280_MARKET))
      .map((order) => order.venueOrderId);
    const canceled = ids.filter((id) => this.#cancelOne(id).canceled);
    for (const id of canceled) this.log.push({ kind: "CANCEL", credential, source, atMs: this.time.now, detail: id, effective: true });
    this.#debitCanceled(credential, canceled.length);
    this.#feedback(credential, "cancel");
    return { canceled, notCanceled: {} };
  }

  #cancelAll(credential: string, source: string, at: Checkpoint, alive: () => boolean): Promise<unknown> {
    return this.#through(at, "venue.process.cancelAll", alive, () => {
      this.#cancelGate(credential, source, "CANCEL_ALL", "cancel-all", 1);
      const ids = this.#openOrders(credential, this.cancelAllScope === "CREDENTIAL").map((order) => order.venueOrderId);
      const canceled = ids.filter((id) => this.#cancelOne(id).canceled);
      this.log.push({ kind: "CANCEL_ALL", credential, source, atMs: this.time.now, detail: canceled.join(","), effective: canceled.length > 0 });
      this.#debitCanceled(credential, canceled.length);
      this.#feedback(credential, "cancel");
      return { canceled, notCanceled: {} };
    });
  }

  /** The OMS-shaped cancel (`ReconWorld.cancel`), with the CANCELLATION event published. */
  override cancel(venueOrderId: string): CancelOutcome {
    this.settleArrivals();
    const result = this.#cancelOne(venueOrderId);
    return result.canceled
      ? { kind: "COMPLETED", canceled: [venueOrderId], notCanceled: [] }
      : { kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: venueOrderId, reason: "Order not found or already canceled" }] };
  }

  // -------------------------------------------------------------------------
  // Matches (A7) and the user channel (§4).

  /** The venue matches `shares` of a live order: `ReconWorld.match`, then its UPDATE and its trade's events (MATCHED, then the settled status). */
  override match(
    salt: string,
    shares: string,
    options: { readonly status?: string; readonly feeAmount?: string | null; readonly feeAssetId?: string } = {},
  ): VenueTrade | undefined {
    const trade = super.match(salt, shares, options);
    const order = this.orders.get(salt);
    if (trade === undefined || order === undefined) return trade;
    if (!order.foreign) this.#checkExposure(order.tokenId, order.side);
    this.#publishOrder(order, "UPDATE");
    this.#publishTrade(order, trade, "MATCHED");
    if (trade.status !== "MATCHED") this.#publishTrade(order, trade, trade.status);
    return trade;
  }

  /** Publish a settlement status of an existing trade (MINED, CONFIRMED, RETRYING, FAILED) without changing holdings. */
  publishTradeStatus(trade: VenueTrade, status: string): void {
    const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === trade.venueOrderId);
    if (order !== undefined) this.#publishTrade(order, trade, status);
  }

  /** An order of the account placed outside the OMS (`ReconWorld.placeForeign`), with its PLACEMENT event. */
  override placeForeign(facts: { readonly tokenId: string; readonly side: "BUY" | "SELL"; readonly price: string; readonly size: string }): VenueOrder {
    const order = super.placeForeign(facts);
    this.#publishOrder(order, "PLACEMENT");
    return order;
  }

  subscribe(subscriber: ChannelSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  #publish(message: Readonly<Record<string, unknown>>, eventType: "order" | "trade", type: string, id: string): void {
    this.#frameSeq += 1;
    const frame: PublishedFrame = { seq: this.#frameSeq, text: JSON.stringify(message), market: WP280_MARKET, eventType, type, id };
    this.frames.push(frame);
    for (const subscriber of [...this.#subscribers]) if (subscriber.markets.has(frame.market)) subscriber.push(frame);
  }

  #publishOrder(order: VenueOrder, type: "PLACEMENT" | "UPDATE" | "CANCELLATION"): void {
    const full = compareDecimal(order.matched, order.original) >= 0;
    const status = order.status === "CANCELED" ? "CANCELED" : full ? "MATCHED" : "LIVE";
    this.#publish(
      wireOrder({ id: order.venueOrderId, assetId: order.tokenId, side: order.side, originalSize: order.original, sizeMatched: order.matched, price: order.price, status, type }),
      "order",
      type,
      order.venueOrderId,
    );
  }

  #publishTrade(order: VenueOrder, trade: VenueTrade, status: string): void {
    this.#publish(
      wireTrade({
        id: trade.venueTradeId,
        takerOrderId: `taker-${trade.venueTradeId}`,
        assetId: trade.tokenId,
        side: trade.side === "BUY" ? "SELL" : "BUY",
        size: trade.shares,
        price: trade.price,
        status,
        traderSide: "MAKER",
        makers: [{ orderId: order.venueOrderId, owner: OUR_OWNER, matchedAmount: trade.shares, price: trade.price, assetId: trade.tokenId, side: trade.side }],
        transactionHash: trade.transactionHash,
        matchTime: MATCHED_AT_SECONDS,
      }),
      "trade",
      status,
      trade.venueTradeId,
    );
  }

  // -------------------------------------------------------------------------
  // The order heartbeat (S-D17).

  #chainOf(credential: string): HeartbeatChain {
    let chain = this.#chains.get(credential);
    if (chain === undefined) {
      chain = { armed: false, expectedId: null, receipts: [], issued: 0, outage: false };
      this.#chains.set(credential, chain);
    }
    return chain;
  }

  /** The `OrderHeartbeatTransport` of one process for `credential` (ADR-033 D2's provisional contract, S-D17's shapes). */
  heartbeat(credential: string, options: { readonly source?: string; readonly checkpoint?: Checkpoint; readonly alive?: () => boolean } = {}): OrderHeartbeatTransport {
    const source = options.source ?? credential;
    const at = options.checkpoint ?? NO_CHECKPOINT;
    const alive = options.alive ?? ((): boolean => true);
    const failure = { kind: "FAILURE", error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN", retryAfterSeconds: null } };
    return {
      // ADR-033 D2: a transport ANSWERS (a response or a failure); a dead process's request, or one lost in an
      // outage, is a failure that never reached the venue.
      send: (request: HeartbeatRequest) =>
        at("venue.process.heartbeat", async () => {
          if (!alive() || this.#chainOf(credential).outage) {
            this.log.push({ kind: "HEARTBEAT", credential, source, atMs: this.time.now, detail: "never-arrived", effective: false });
            return failure;
          }
          return this.#heartbeat(credential, source, request.heartbeatId);
        }),
    };
  }

  /** A network outage on the heartbeat path of `credential`: requests fail in transport and never reach the venue. */
  heartbeatOutage(credential: string, outage: boolean): void {
    this.#chainOf(credential).outage = outage;
  }

  #heartbeat(credential: string, source: string, heartbeatId: string): unknown {
    this.catchUp();
    const chain = this.#chainOf(credential);
    const valid = chain.armed ? heartbeatId === chain.expectedId : heartbeatId === "";
    if (!valid) {
      this.log.push({ kind: "HEARTBEAT", credential, source, atMs: this.time.now, detail: `invalid:${heartbeatId}`, effective: false });
      return { kind: "RESPONSE", httpStatus: 400, body: { error_msg: "Invalid Heartbeat ID", heartbeat_id: chain.expectedId ?? "" } };
    }
    chain.issued += 1;
    chain.armed = true;
    chain.expectedId = `hb-${credential}-${String(chain.issued)}`;
    chain.receipts.push(this.time.now);
    this.log.push({ kind: "HEARTBEAT", credential, source, atMs: this.time.now, detail: heartbeatId, effective: true });
    return { kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: chain.expectedId } };
  }

  /** The current expected heartbeat id of `credential`, or `null` before the first accepted heartbeat. */
  expectedHeartbeatId(credential: string): string | null {
    return this.#chainOf(credential).expectedId;
  }

  heartbeatArmed(credential: string): boolean {
    return this.#chainOf(credential).armed;
  }

  /** The venue's valid-heartbeat receipt instants for `credential`. */
  heartbeatReceipts(credential: string): readonly number[] {
    return [...this.#chainOf(credential).receipts];
  }

  /** A periodic tick on the shared time line; the checks themselves are evaluated by {@link catchUp}. */
  #scheduleCheck(): void {
    this.time.setTimeout(() => {
      this.catchUp();
      this.#scheduleCheck();
    }, CANCELLATION_CHECK_MS);
  }

  /**
   * Run every 5 s cancellation check the venue owes up to now, EACH AT ITS OWN INSTANT (A6): the venue's clock does
   * not stall when a process does. At check instant c, a credential whose chain was armed by c and whose last valid
   * heartbeat received by c is more than 10 s old has every one of its orders live by c canceled (S-D17; A3).
   * Called before anything else the venue does, and by its own tick.
   */
  catchUp(): void {
    const now = this.time.now;
    while (this.#nextCheckAtMs <= now) {
      const instant = this.#nextCheckAtMs;
      this.#nextCheckAtMs += CANCELLATION_CHECK_MS;
      for (const [credential, chain] of this.#chains) {
        const received = chain.receipts.filter((receipt) => receipt <= instant);
        const last = received.at(-1);
        if (last === undefined || instant - last <= HEARTBEAT_TIMEOUT_MS) continue;
        const canceled = this.#openOrders(credential, true)
          .filter((order) => (this.#createdAt.get(order.salt) ?? Number.POSITIVE_INFINITY) <= instant)
          .map((order) => order.venueOrderId)
          .filter((id) => this.#cancelOne(id).canceled);
        this.sweeps.push({ credential, atMs: instant, canceled });
      }
    }
  }

  /** Our orders the venue holds open now, by credential (`null`: every credential). */
  openOrderIds(credential: string | null = null): string[] {
    return [...this.orders.values()]
      .filter((order) => !order.foreign && order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0 && (credential === null || this.placedBy.get(order.salt) === credential))
      .map((order) => order.venueOrderId);
  }

  /** The remaining (unmatched) size of a live order. */
  remaining(order: VenueOrder): string {
    return subDecimal(order.original, order.matched);
  }
}

/** The SDK's success answer for a resting order (`OrderResponse`, the pinned SDK's fields). */
function liveAnswer(orderId: string): unknown {
  return { ok: true, orderId, status: "live", makingAmount: "0", takingAmount: "0", tradeIds: [], transactionsHashes: [] };
}

/**
 * The amounts the pinned SDK signs for a limit order at tick 0.01 (WP-260's fake SDK, `fixtureAmounts`): shares
 * rounded DOWN to 2 decimals, the quote rounded DOWN to 4 decimals, both in 6-decimal base units. Exact integers.
 */
function fixtureAmounts(side: "BUY" | "SELL", priceText: string, sizeText: string): { readonly makerAmount: string; readonly takerAmount: string } {
  const rational = (text: string): { readonly n: bigint; readonly d: bigint } => {
    const [whole = "0", fraction = ""] = text.split(".");
    return { n: BigInt(`${whole}${fraction}`), d: 10n ** BigInt(fraction.length) };
  };
  const size = rational(sizeText);
  const price = rational(priceText);
  const shares = ((size.n * 1_000_000n) / size.d / 10_000n) * 10_000n;
  const quote = ((price.n * shares) / price.d / 100n) * 100n;
  const [maker, taker] = side === "BUY" ? [quote, shares] : [shares, quote];
  return { makerAmount: maker.toString(10), takerAmount: taker.toString(10) };
}
