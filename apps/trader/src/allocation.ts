/**
 * The §8.1 "allocate capital" step — `packages/capital-allocator`, wired.
 *
 * ```text
 * … persist DecisionResults
 *   → allocate capital        ← THIS MODULE (§9.7)
 *   → run risk checks         ← §9.8 check 14 consumes the verdict below
 *   → create execution plans
 *   → update OMS / submit eligible actions
 * ```
 *
 * ## Why this file exists at all (review round 1, HIGH-1)
 *
 * The reviewed tip parsed the operator's allocator caps through
 * `parseAllocatorCaps` and then **discarded them**, and handed the risk engine a
 * fabricated `allocation: { permitted: true }`. §9.8 check 14 is fail-closed by
 * construction — an absent verdict refuses every entry — so the fabrication was
 * the only thing satisfying it: caps of `"1"` everywhere still approved,
 * planned, submitted and filled a ~17 pUSD entry. A hardcoded `permitted` is not
 * a wiring shortcut; it is the check itself, deleted.
 *
 * Everything below is therefore WIRING plus one accounting derivation the
 * allocator needs and this process is the only holder of (see
 * {@link CostBasisBook}). No cap is applied here, no refusal is invented here
 * and no verdict is repaired here: {@link AllocatorGate.evaluate} answers with
 * `packages/capital-allocator`'s own verdict, refusal codes included, and the
 * loop hands it to `packages/risk` unaltered.
 *
 * ## The two reservation books, and why BOTH exist
 *
 * | Book | Owner | Answers | Consumed by |
 * | --- | --- | --- | --- |
 * | `ReservationBook` (`reservations.ts`) | this app | "how many SHARES and how much pUSD may the next PLAN still use" | `packages/execution-planner` (`WP-220` obligation 9) |
 * | the allocator's applied reservations (here) | `packages/capital-allocator` | "how much of every §9.7 CAP is already committed" | `packages/risk` §9.8 checks 14 and 15 |
 *
 * They are not the same book and neither can stand in for the other: the first
 * is per-`(market, side)` inventory for a planner that plans one market, the
 * second is the account-wide commitment table every cap compares against. They
 * are TAKEN at the same moment (before submission — §9.10 "reserve
 * collateral/inventory before submission") and RELEASED at the same two moments
 * (a refused submission, for each planned order the venue does not hold, and an
 * order reaching a terminal state — `TRDR-4` round 1: an order a refused plan
 * nonetheless left at the venue is released only at the second), and both are
 * keyed on the PLANNED ORDER, so no state exists in which one holds a
 * commitment the other has forgotten.
 *
 * ## Why the state carries NO open orders
 *
 * `AllocatorStateInput.openOrders` and an applied reservation would both
 * describe the SAME in-flight commitment, and §9.14 forbids double reservation.
 * This process holds an allocator reservation from before submission until the
 * order is terminal, so the reservation IS the in-flight commitment and
 * `openOrders` is deliberately empty.
 *
 * The consequence is stated where it matters: between a partial fill's posting
 * and its order's terminal state the filled part is counted TWICE — once as a
 * position, once as the still-held reservation. That OVERSTATES committed
 * exposure, which is the fail-closed direction, and it is the same property
 * `reservations.ts` defends for the inventory book ("releasing on a fill would
 * free inventory a partially-filled resting order can still consume").
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import {
  EXPOSURE_ZERO,
  applyReservation,
  createAllocatorState,
  evaluateReservation,
  exposureSnapshotCovering,
  shadowExposureSnapshot,
  type AllocatorCaps,
  type AllocatorState,
  type CapitalRefusal,
  type ExposureEntry,
  type ExposureSnapshot,
  type ReservationRequest,
} from "@polymarket-bot/capital-allocator";
import type { Intent } from "@polymarket-bot/domain";
import type { LedgerProjection } from "@polymarket-bot/ledger";
import type { SimulatedFill } from "@polymarket-bot/simulation";

import type { MarketConfig } from "./config.js";
import { TRADER_RUN_MODE } from "./safety.js";

/** The §9.8 check-14 verdict, in the shape `packages/risk` reads structurally. */
export interface AllocationVerdict {
  readonly permitted: boolean;
  readonly refusals: readonly { readonly code: string; readonly message: string }[];
}

/** What {@link AllocatorGate.evaluate} answers for one intent. */
export interface AllocationOutcome {
  /**
   * The allocator's verdict, or `undefined` when the intent commits NOTHING —
   * a `CANCEL`, whose §9.8 disposition is `CANCEL` and which check 14 does not
   * require a verdict for. It is `undefined` for an intent that WOULD commit
   * capital only when no leg of it could be priced, and check 14 then refuses
   * the entry, which is the fail-closed direction.
   */
  readonly verdict: AllocationVerdict | undefined;
  /** The §9.8 check-15 snapshot, covering every scope this evaluation queries. */
  readonly exposures: ExposureSnapshot;
  /** The requests the verdict was computed over, in leg order. */
  readonly requests: readonly ReservationRequest[];
}

export interface AllocatorMetrics {
  /** Allocator reservations currently applied (§9.10, pre-submission). */
  readonly open: number;
  readonly applied: number;
  readonly released: number;
  /** §9.7 "reserved pUSD" across the applied BUY reservations, exactly summed. */
  readonly reservedCollateral: string;
  /** Allocator refusals seen, by the allocator's OWN code. */
  readonly refusalsByCode: Readonly<Record<string, number>>;
}

/** The account state, or the allocator's refusals to describe it. */
type BuiltState =
  | { readonly ok: true; readonly state: AllocatorState }
  | { readonly ok: false; readonly refusals: readonly CapitalRefusal[] };

interface Lot {
  readonly shares: string;
  readonly price: string;
}

/**
 * FIFO cost basis per `(instanceId, marketId, side)`, folded from the fills
 * this process has already booked.
 *
 * WHY IT IS HERE. §9.7's exposure table counts a position at its `costBasis` —
 * "capital already spent" — and neither `packages/ledger`'s projection (which
 * carries balances, not lots) nor `packages/capital-allocator` (which is pure
 * and sees no fills) holds it. Passing `"0"`, as the reviewed tip did for the
 * risk portfolio, would make every held position consume ZERO of every cap:
 * the allocator's central rule — "open orders and positions BOTH consume
 * limits" — defeated on the position half.
 *
 * EXACT, AND WITHOUT A DIVISION. Lots are consumed oldest-first and the cost a
 * sale removes is `lotPrice × sharesTaken`, summed over the lots it touches.
 * There is no average, so there is no rounding policy and no §6 invariant 1
 * exposure. FIFO is a STATED policy, not an inferred one.
 */
export class CostBasisBook {
  readonly #lots = new Map<string, Lot[]>();

  static key(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    return `${instanceId}|${marketId}|${side}`;
  }

  /** Folds one booked fill. BUY opens a lot; SELL consumes the oldest first. */
  observe(
    instanceId: string,
    fill: Pick<SimulatedFill, "marketId" | "side" | "action" | "price" | "shares">,
  ): void {
    const key = CostBasisBook.key(instanceId, fill.marketId, fill.side);
    const lots = this.#lots.get(key) ?? [];
    if (fill.action === "BUY") {
      lots.push({ shares: fill.shares, price: fill.price });
      this.#lots.set(key, lots);
      return;
    }
    let remaining = fill.shares;
    while (compareDecimal(remaining, "0") > 0 && lots.length > 0) {
      const lot = lots[0];
      if (lot === undefined) break;
      if (compareDecimal(lot.shares, remaining) <= 0) {
        remaining = subDecimal(remaining, lot.shares);
        lots.shift();
        continue;
      }
      lots[0] = { shares: subDecimal(lot.shares, remaining), price: lot.price };
      remaining = "0";
    }
    // A sale larger than the lots this book has seen leaves the book EMPTY
    // rather than negative: `packages/ledger` is the authority on shares, this
    // book answers only what the REMAINING ones cost, and a negative cost basis
    // is not a smaller one — it is a broken derivation.
    this.#lots.set(key, lots);
  }

  /** Exact remaining cost basis for one key. */
  costBasis(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    let total = "0";
    for (const lot of this.#lots.get(CostBasisBook.key(instanceId, marketId, side)) ?? []) {
      total = addDecimal(total, mulDecimal(lot.price, lot.shares));
    }
    return total;
  }

  /** Σ of every key's cost basis — the capital this account has spent. */
  total(): string {
    let total = "0";
    for (const lots of this.#lots.values()) {
      for (const lot of lots) total = addDecimal(total, mulDecimal(lot.price, lot.shares));
    }
    return total;
  }
}

/** The §9.7 scope a market states, as the allocator's requests carry it. */
export interface AllocationMarket {
  readonly marketId: string;
  readonly seriesKey: string;
  readonly underlyingKey: string;
  readonly resolutionWindowKey: string;
}

/** The scope keys one evaluation will query. */
export interface AllocationCoverage {
  readonly strategyInstanceIds: readonly string[];
  readonly marketIds: readonly string[];
  readonly seriesKeys: readonly string[];
  readonly underlyingKeys: readonly string[];
  readonly resolutionWindowKeys: readonly string[];
}

/** One BUY or SELL leg of an intent, bounded by the intent's own price. */
export interface IntentLeg {
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
}

function scopeOf(market: AllocationMarket): {
  readonly seriesKey: string;
  readonly underlyingKey: string;
  readonly resolutionWindowKey: string;
} {
  return {
    seriesKey: market.seriesKey,
    underlyingKey: market.underlyingKey,
    resolutionWindowKey: market.resolutionWindowKey,
  };
}

/**
 * The composition root's handle on `packages/capital-allocator`.
 *
 * It holds exactly two things of its own: the operator's parsed caps and the
 * reservations this process has APPLIED and not yet released. Everything else
 * is rebuilt from the loop's own authoritative state on every question, so the
 * allocator can never answer from a stale copy of the account.
 */
export class AllocatorGate {
  readonly #caps: AllocatorCaps;
  readonly #markets: ReadonlyMap<string, AllocationMarket>;
  /** `assetId -> (marketId, side)`, inverted from the loop's own token map. */
  readonly #assets: ReadonlyMap<string, { readonly marketId: string; readonly side: "YES" | "NO" }>;
  readonly #costBasis = new CostBasisBook();
  /** `plannedOrderId -> the applied request`, keyed exactly as `ReservationBook` is. */
  readonly #applied = new Map<string, ReservationRequest>();
  readonly #refusalsByCode = new Map<string, number>();
  #appliedCount = 0;
  #releasedCount = 0;

  constructor(input: {
    readonly caps: AllocatorCaps;
    readonly markets: ReadonlyMap<string, AllocationMarket>;
    /** The loop's `marketId|SIDE -> assetId` map, inverted here. */
    readonly tokenAssetIds: ReadonlyMap<string, string>;
  }) {
    this.#caps = input.caps;
    this.#markets = input.markets;
    const assets = new Map<string, { marketId: string; side: "YES" | "NO" }>();
    for (const [key, assetId] of input.tokenAssetIds) {
      const separator = key.lastIndexOf("|");
      if (separator < 0) continue;
      const marketId = key.slice(0, separator);
      const side = key.slice(separator + 1);
      if (side !== "YES" && side !== "NO") continue;
      assets.set(assetId, { marketId, side });
    }
    this.#assets = assets;
  }

  /** Folds one booked fill into the cost-basis book. */
  observeFill(
    instanceId: string,
    fill: Pick<SimulatedFill, "marketId" | "side" | "action" | "price" | "shares">,
  ): void {
    this.#costBasis.observe(instanceId, fill);
  }

  /** The exact remaining cost basis of one held position. */
  costBasisOf(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    return this.#costBasis.costBasis(instanceId, marketId, side);
  }

  /** The §9.7 scope this gate knows for a market, if it is configured. */
  marketOf(marketId: string): AllocationMarket | undefined {
    return this.#markets.get(marketId);
  }

  /**
   * §8.1's "allocate capital", for one intent.
   *
   * Answers the allocator's OWN verdict and the exposure snapshot §9.8 check 15
   * queries. It changes nothing: `evaluateReservation` is the question, and
   * {@link applyForPlan} is the commitment.
   */
  evaluate(input: {
    readonly intent: Intent;
    readonly instanceId: string;
    /**
     * The §9.7 accounting mode the commitment is judged under.
     *
     * `apps/trader` always passes `LIVE`, and review round 2's HIGH-1 is why:
     * the trader has ONE book — one cash balance, one ledger, one venue — so a
     * commitment that reaches it is a live commitment however it is attributed.
     * `SHADOW` selects the allocator's independent-shadow-accounting arm, which
     * skips the ADR-011 ownership gate, the live-micro fence and the collateral
     * and inventory sufficiency checks, and compares caps against the
     * instance's OWN shadow book. That is correct for a caller holding a
     * separate book and catastrophic for one that is not: at the r1 tip a
     * `SHADOW` instance was evaluated on the shadow arm and then executed on the
     * shared venue, bypassing every one of those gates. The parameter stays
     * because the package's contract has both arms; the trader's answer to it
     * is a constant (`loop.ts`'s `SHARED_BOOK_ACCOUNTING_MODE`).
     */
    readonly accountingMode: "LIVE" | "SHADOW";
    readonly liveOwners: readonly {
      readonly marketId: string;
      readonly strategyInstanceId: string;
    }[];
    readonly projection: LedgerProjection;
    readonly availableCollateral: string;
    readonly approvedIntentId: string;
    /** Held shares as the loop sees them, for the delta this intent resolves to. */
    readonly heldShares: (marketId: string, side: "YES" | "NO") => string;
  }): AllocationOutcome {
    const built = this.#buildState(input.liveOwners, input.projection, input.availableCollateral);
    const requests = this.#requestsFor(input);
    const coverage = this.#coverageFor(input.instanceId, requests);

    if (!built.ok) {
      // The state itself could not be built. A cap cannot be shown to hold
      // against an account this process cannot describe, so the answer is a
      // REFUSAL carrying the allocator's own codes — never an absent verdict,
      // which check 14 would read as "the allocator was not asked", and never
      // an absent exposure snapshot, which check 15 would read the same way.
      return {
        verdict: this.#record(false, built.refusals),
        exposures: covering(EMPTY_SNAPSHOT, coverage),
        requests,
      };
    }
    const exposures =
      input.accountingMode === "LIVE"
        ? exposureSnapshotCovering(built.state, coverage)
        : covering(shadowExposureSnapshot(built.state, input.instanceId), coverage);
    if (requests.length === 0) return { verdict: undefined, exposures, requests };

    const refusals: CapitalRefusal[] = [];
    for (const request of requests) {
      const verdict = evaluateReservation(built.state, this.#caps, request);
      if (!verdict.permitted) refusals.push(...verdict.refusals);
    }
    return { verdict: this.#record(refusals.length === 0, refusals), exposures, requests };
  }

  /**
   * §9.10: reserve BEFORE submission.
   *
   * Applies one reservation per PLANNED ORDER — the same key `ReservationBook`
   * uses — so the two books are taken and released together. A refusal is
   * answered as data and nothing is applied: the caller does not submit.
   */
  applyForPlan(input: {
    readonly entries: readonly {
      readonly plannedOrderId: string;
      readonly request: ReservationRequest;
    }[];
    readonly liveOwners: readonly {
      readonly marketId: string;
      readonly strategyInstanceId: string;
    }[];
    readonly projection: LedgerProjection;
    readonly availableCollateral: string;
  }): { readonly ok: true } | { readonly ok: false; readonly refusals: readonly CapitalRefusal[] } {
    const built = this.#buildState(input.liveOwners, input.projection, input.availableCollateral);
    if (!built.ok) return { ok: false, refusals: this.#count(built.refusals) };
    let state = built.state;
    for (const entry of input.entries) {
      const applied = applyReservation(state, this.#caps, entry.request);
      if (!applied.ok) return { ok: false, refusals: this.#count(applied.refusals) };
      state = applied.value.state;
    }
    // Recorded only after EVERY leg was accepted, so a plan is never half
    // reserved: a partial application would leave capital committed against an
    // order this process then refuses to submit.
    for (const entry of input.entries) {
      this.#applied.set(entry.plannedOrderId, entry.request);
      this.#appliedCount += 1;
    }
    return { ok: true };
  }

  /**
   * Releases the allocator reservation one planned order holds.
   *
   * Called from exactly the two places `ReservationBook.releaseForOrder` is: a
   * REFUSED submission, for each planned order the venue does NOT hold (review
   * round 1, MEDIUM-4 — such an order has no view, so nothing else would ever
   * release it; `TRDR-4` round 1 — one the venue DOES hold is kept until it is
   * terminal) and an order reaching a TERMINAL state.
   */
  release(plannedOrderId: string): boolean {
    if (!this.#applied.delete(plannedOrderId)) return false;
    this.#releasedCount += 1;
    return true;
  }

  metrics(): AllocatorMetrics {
    let reserved = "0";
    for (const request of this.#applied.values()) {
      if (request.action !== "BUY") continue;
      reserved = addDecimal(reserved, mulDecimal(request.price, request.shares));
    }
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const code of [...this.#refusalsByCode.keys()].sort()) {
      counts[code] = this.#refusalsByCode.get(code) ?? 0;
    }
    return Object.freeze({
      open: this.#applied.size,
      applied: this.#appliedCount,
      released: this.#releasedCount,
      reservedCollateral: reserved,
      refusalsByCode: Object.freeze(counts),
    });
  }

  #count(refusals: readonly CapitalRefusal[]): readonly CapitalRefusal[] {
    for (const refusal of refusals) {
      this.#refusalsByCode.set(refusal.code, (this.#refusalsByCode.get(refusal.code) ?? 0) + 1);
    }
    return refusals;
  }

  #record(permitted: boolean, refusals: readonly CapitalRefusal[]): AllocationVerdict {
    if (!permitted) this.#count(refusals);
    return Object.freeze({
      permitted,
      refusals: Object.freeze(
        refusals.map((refusal) => Object.freeze({ code: refusal.code, message: refusal.message })),
      ),
    });
  }

  /**
   * The account, rebuilt from the loop's own authoritative state and then
   * carrying every reservation this process still holds.
   *
   * The re-application is not ceremony: capacity is re-checked against the
   * state as it is NOW, so a reservation that could no longer be made becomes a
   * refusal rather than a silently retained commitment.
   */
  #buildState(
    liveOwners: readonly { readonly marketId: string; readonly strategyInstanceId: string }[],
    projection: LedgerProjection,
    availableCollateral: string,
  ): BuiltState {
    const created = createAllocatorState({
      accountEquity: addDecimal(availableCollateral, this.#costBasis.total()),
      availableCollateral,
      positions: this.#positionsFrom(projection),
      // See the module header: the applied reservations ARE the in-flight
      // commitments, so declaring them here as well would double-reserve.
      openOrders: [],
      liveOwners: liveOwners.map((owner) => ({
        marketId: owner.marketId,
        strategyInstanceId: owner.strategyInstanceId,
      })),
    });
    if (!created.ok) return { ok: false, refusals: created.refusals };
    let state = created.value;
    for (const request of this.#applied.values()) {
      const applied = applyReservation(state, this.#caps, request);
      if (!applied.ok) return { ok: false, refusals: applied.refusals };
      state = applied.value.state;
    }
    return { ok: true, state };
  }

  #positionsFrom(projection: LedgerProjection): readonly {
    readonly positionId: string;
    readonly marketId: string;
    readonly strategyInstanceId: string;
    readonly side: "YES" | "NO";
    readonly shares: string;
    readonly costBasis: string;
    readonly scope?: ReturnType<typeof scopeOf>;
  }[] {
    const rows: {
      positionId: string;
      marketId: string;
      strategyInstanceId: string;
      side: "YES" | "NO";
      shares: string;
      costBasis: string;
      scope?: ReturnType<typeof scopeOf>;
    }[] = [];
    for (const line of projection.virtualPositions.values()) {
      const asset = this.#assets.get(line.assetId);
      if (asset === undefined) continue;
      if (compareDecimal(line.balance, "0") === 0) continue;
      const market = this.#markets.get(asset.marketId);
      rows.push({
        positionId: `${line.instanceId}|${asset.marketId}|${asset.side}`,
        marketId: asset.marketId,
        strategyInstanceId: line.instanceId,
        side: asset.side,
        shares: line.balance,
        costBasis: this.#costBasis.costBasis(line.instanceId, asset.marketId, asset.side),
        ...(market === undefined ? {} : { scope: scopeOf(market) }),
      });
    }
    // The projection's own iteration order is already deterministic (a Map over
    // a canonical key); sorted anyway so the document this process hands the
    // allocator does not depend on the ledger's fold order.
    return Object.freeze(
      rows.sort((left, right) => (left.positionId < right.positionId ? -1 : 1)),
    );
  }

  /**
   * The §7.7 intent, as §9.7 reservation requests.
   *
   * The leg derivation MIRRORS `packages/risk`'s `buildIntentView`: a
   * `POSITION` intent resolves to a signed delta against the held shares, a
   * positive delta BUYS and a negative one SELLS, a `REDUCE_POSITION` sells the
   * excess on each side, and a `CANCEL` commits nothing. It applies no policy of
   * its own — the SHAPE is the allocator's input contract — and the two
   * derivations are held together by the suite: a request the risk engine would
   * not recognise refuses an intent the engine approves, which is a test
   * failure rather than a silent divergence.
   */
  #requestsFor(input: {
    readonly intent: Intent;
    readonly instanceId: string;
    readonly accountingMode: "LIVE" | "SHADOW";
    readonly approvedIntentId: string;
    readonly heldShares: (marketId: string, side: "YES" | "NO") => string;
  }): readonly ReservationRequest[] {
    return Object.freeze(
      intentLegs(input.intent, input.heldShares).map((leg, index) =>
        requestFor({
          reservationId: `${input.approvedIntentId}#${String(index)}`,
          instanceId: input.instanceId,
          accountingMode: input.accountingMode,
          leg,
          market: this.#markets.get(leg.marketId),
        }),
      ),
    );
  }

  /** Every scope this evaluation will query, so the snapshot ANSWERS for it. */
  #coverageFor(
    instanceId: string,
    requests: readonly ReservationRequest[],
  ): AllocationCoverage {
    const marketIds = [...new Set(requests.map((request) => request.marketId))].sort();
    const scopes = marketIds
      .map((marketId) => this.#markets.get(marketId))
      .filter((market): market is AllocationMarket => market !== undefined);
    return {
      strategyInstanceIds: [instanceId],
      marketIds,
      seriesKeys: [...new Set(scopes.map((market) => market.seriesKey))].sort(),
      underlyingKeys: [...new Set(scopes.map((market) => market.underlyingKey))].sort(),
      resolutionWindowKeys: [
        ...new Set(scopes.map((market) => market.resolutionWindowKey)),
      ].sort(),
    };
  }
}

/**
 * The legs of one intent, mirroring `packages/risk`'s own normalization.
 *
 * A leg with no price bound is OMITTED rather than priced at a guess: the
 * allocator's request needs an exact price, and inventing one would commit
 * capital against a number nobody stated. An entry whose legs all vanish that
 * way produces NO request, and §9.8 check 14 then refuses it as a missing
 * verdict — the fail-closed direction.
 */
export function intentLegs(
  intent: Intent,
  heldShares: (marketId: string, side: "YES" | "NO") => string,
): readonly IntentLeg[] {
  const legs: IntentLeg[] = [];
  switch (intent.type) {
    case "CANCEL":
      return Object.freeze([]);
    case "POSITION": {
      const held = heldShares(intent.marketId, intent.direction);
      const delta =
        intent.targetMode === "DELTA" ? intent.targetShares : subDecimal(intent.targetShares, held);
      if (compareDecimal(delta, "0") === 0) return Object.freeze([]);
      const buying = compareDecimal(delta, "0") > 0;
      const price = buying ? intent.maximumBuyPrice : intent.minimumSellPrice;
      if (price === undefined) return Object.freeze([]);
      legs.push({
        marketId: intent.marketId,
        side: intent.direction,
        action: buying ? "BUY" : "SELL",
        price,
        shares: absolute(delta),
      });
      break;
    }
    case "REDUCE_POSITION": {
      if (intent.minimumSellPrice === undefined) return Object.freeze([]);
      for (const side of ["YES", "NO"] as const) {
        const excess = subDecimal(
          heldShares(intent.marketId, side),
          absolute(intent.targetShares),
        );
        if (compareDecimal(excess, "0") <= 0) continue;
        legs.push({
          marketId: intent.marketId,
          side,
          action: "SELL",
          price: intent.minimumSellPrice,
          shares: excess,
        });
      }
      break;
    }
    case "QUOTE":
      // §7.7's `QuoteLevel` names no outcome token, and the allocator's request
      // needs one. The side a level belongs to is NOT derivable from the level,
      // so a quote produces no request here — and §9.8 check 14 then refuses the
      // quote for want of a verdict, which is the fail-closed direction and is
      // stated rather than guessed. `strategy-static-bracket` emits no quote.
      return Object.freeze([]);
    case "BASKET": {
      for (const leg of intent.legs) {
        const shares = absolute(leg.targetShares);
        if (compareDecimal(shares, "0") === 0) continue;
        const buying = compareDecimal(leg.targetShares, "0") > 0;
        const price = buying ? leg.maximumBuyPrice : leg.minimumSellPrice;
        if (price === undefined) continue;
        legs.push({
          marketId: leg.marketId,
          side: leg.direction,
          action: buying ? "BUY" : "SELL",
          price,
          shares,
        });
      }
      break;
    }
  }
  return Object.freeze(legs);
}

/** One §9.7 reservation request, assembled from a leg. */
export function requestFor(input: {
  readonly reservationId: string;
  readonly instanceId: string;
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly leg: IntentLeg;
  readonly market: AllocationMarket | undefined;
}): ReservationRequest {
  return {
    reservationId: input.reservationId,
    strategyInstanceId: input.instanceId,
    // §11: this process serves exactly ONE run mode, and `safety.ts` refuses to
    // start under any other. Stated rather than threaded so a request cannot
    // name a mode the process is not in — and stated as `safety.ts`'s OWN
    // constant (review round 2, note N4), so the mode the allocator's
    // real-order fence reads is the same symbol the startup gate enforced.
    runMode: TRADER_RUN_MODE,
    accountingMode: input.accountingMode,
    marketId: input.leg.marketId,
    side: input.leg.side,
    action: input.leg.action,
    price: input.leg.price,
    shares: input.leg.shares,
    ...(input.market === undefined ? {} : { scope: scopeOf(input.market) }),
  } as ReservationRequest;
}

/** The §9.7 scope a market configuration states. */
export function allocationMarketOf(market: MarketConfig): AllocationMarket {
  return {
    marketId: market.marketId,
    seriesKey: market.seriesKey,
    underlyingKey: market.underlyingKey,
    resolutionWindowKey: market.resolutionWindowKey,
  };
}

function absolute(value: string): string {
  return compareDecimal(value, "0") < 0 ? subDecimal("0", value) : value;
}

/** An account with nothing in it — used only when the state could not be built. */
const EMPTY_SNAPSHOT: ExposureSnapshot = Object.freeze({
  global: EXPOSURE_ZERO,
  byStrategyInstance: Object.freeze({}),
  byMarket: Object.freeze({}),
  bySeries: Object.freeze({}),
  byUnderlying: Object.freeze({}),
  byResolutionWindow: Object.freeze({}),
});

/**
 * {@link exposureSnapshotCovering} for a snapshot the package does not build a
 * covering form of.
 *
 * `packages/capital-allocator` publishes the covering builder for the LIVE
 * snapshot only, and an uncovered snapshot is exactly what
 * `RISK_EXPOSURE_ENTRY_MISSING` refuses. The zeros this adds are honest for the
 * same reason the package's are: a shadow book is that instance's COMPLETE
 * record of its own commitments, so a scope it does not mention holds nothing.
 * The entry written is the package's own {@link EXPOSURE_ZERO}.
 *
 * On the refused-state path it covers the EMPTY snapshot, which is honest in a
 * different way: the verdict travelling with it is a refusal, so nothing is
 * approved against those zeros.
 */
function covering(snapshot: ExposureSnapshot, coverage: AllocationCoverage): ExposureSnapshot {
  const fill = (
    table: Readonly<Record<string, ExposureEntry>>,
    keys: readonly string[],
  ): Readonly<Record<string, ExposureEntry>> => {
    const out: Record<string, ExposureEntry> = { ...table };
    for (const key of keys) {
      if (!Object.hasOwn(out, key)) out[key] = EXPOSURE_ZERO;
    }
    return Object.freeze(out);
  };
  return Object.freeze({
    global: snapshot.global,
    byStrategyInstance: fill(snapshot.byStrategyInstance, coverage.strategyInstanceIds),
    byMarket: fill(snapshot.byMarket, coverage.marketIds),
    bySeries: fill(snapshot.bySeries, coverage.seriesKeys),
    byUnderlying: fill(snapshot.byUnderlying, coverage.underlyingKeys),
    byResolutionWindow: fill(snapshot.byResolutionWindow, coverage.resolutionWindowKeys),
  });
}
