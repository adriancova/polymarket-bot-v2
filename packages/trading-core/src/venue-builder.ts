/**
 * The ONE place the simulated venue is constructed (`BACKTEST-2`, ADR-022 D5).
 *
 * Before `BACKTEST-2` the `SimulatedVenue` a composition root hands to
 * `createPaperTrader` was built in four places: `apps/trader/src/main.ts`, and
 * three test copies of it (`test/e2e/support/harness.ts`,
 * `test/integration/paper-trader/support/fixture.ts` and
 * `test/unit/simulation/backtest-replay-support.ts`). A copy is a second
 * authority that can drift from the one it copies, and blocker B3's
 * qualification named exactly that: "the harness's venue wiring is a copy of
 * main.ts's". Every root now calls {@link buildSimulatedVenue} — the paper
 * trader's `main.ts`, the backtest executable's `run` command, and the test
 * harnesses — so the seam a test proves is the seam the process runs.
 *
 * ## What it builds, and what it asks the caller
 *
 * This is `main.ts`'s construction, moved (`ac0b12f:apps/trader/src/main.ts`
 * `assembleDurableTrader`, the fee door and the `new SimulatedVenue({...})`
 * call). Every argument of the venue is fixed here EXCEPT the ones a caller
 * genuinely differs on, and those are this function's parameters:
 *
 * | Venue input | Fixed here | Parameter |
 * | --- | --- | --- |
 * | `runMode` | `TRADER_RUN_MODE` (`"PAPER"`): the one mode the core starts in; the plan carries it and the venue refuses a plan naming another | — |
 * | `model` | Tier 0 over the settings' fill-model version and parameters hash | `settings` |
 * | `feeSnapshot` | read through `packages/simulation`'s own door; a refused snapshot is this function's refusal | `settings.feeSchedule` |
 * | `startingCash` | — | `startingCash` (the configuration's `accounting.startingCash`, the one statement of the opening balance) |
 * | `policy` | `createExecutionPolicy` over the clock (`venue-policy.ts`): it reads the planned order's own time-in-force | `log` (where an order without a time-in-force is logged; nothing when absent) |
 * | `books` | a live lookup through the holder's trader on every read | — |
 * | `rateLimits` | `unmodeledRateLimits` with {@link UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE} | `rateLimits` (a test that needs a REAL venue refusal passes a token bucket) |
 * | `retention` | the venue's own defaults | `retention` (a test that must make the venue evict) |
 * | `clock` | — | `clock` |
 *
 * WHERE THE SETTINGS COME FROM is the caller's statement, not this module's:
 * a composition root passes its PARSED configuration's `simulation` block
 * (`TraderConfig["simulation"]` is assignable to {@link SimulatedVenueSettings});
 * a harness that builds a venue for a document it is about to see refused
 * passes what it read defensively. Either way the settings reach one door and
 * one constructor.
 *
 * ## The two-phase wiring
 *
 * The venue asks one question only the trader can answer — the BOOK a market
 * has (§12.2's Tier-0 depth) — and the trader takes the venue as a constructor
 * argument. So the venue is built against a HOLDER ({@link VenueWiring}) that
 * the caller fills with the trader the instant it exists. (The TIME-IN-FORCE a
 * planned order carries is on the plan itself since `C1-TIF`, ADR-034 D3.1
 * item 2, so the §12.1 `ExecutionPolicy` reads the order, not the holder.)
 *
 * ```ts
 * const built = buildSimulatedVenue({ clock, settings: config.simulation, log });
 * if (!built.ok) return refuse(built.refusal);
 * const created = createPaperTrader({ ..., venue: built.venue });
 * if (created.ok) built.wiring.trader = created.trader;
 * ```
 *
 * Until it is filled, every book read answers `undefined`, which cannot
 * happen: no event has been processed, so no plan exists. A venue that
 * answered the question itself would be a second authority, which
 * `packages/simulation` refuses to be.
 *
 * ## Layer and safety
 *
 * `packages/trading-core` is layer 1, and this module imports only
 * `packages/simulation` (§2.1 row S15, whose consumed surface names this
 * construction from `BACKTEST-2` on) and the core's own modules. It is a
 * factory a root CHOOSES to call; the loop never calls it and never branches
 * on whether it runs in simulation (§12.1, §12.4), and a live root will not
 * call it. The venue it builds is `packages/simulation`'s, which refuses
 * `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name. No credential, signer,
 * venue URL or network handle is representable in any argument.
 */

import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type RateLimitBudget,
  type SimulatedVenueOptions,
  type SimulationRefusal,
} from "@polymarket-bot/simulation";

import type { Clock } from "./ports.js";
import { TRADER_RUN_MODE } from "./safety.js";
import { createExecutionPolicy, type VenueWiring } from "./venue-policy.js";

/**
 * The rate-limit disclosure the venue carries on every `ExecutionResult` when
 * no venue budget is modelled — `main.ts`'s own text, which the three test
 * copies had each restated in their own words.
 */
export const UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE =
  "no venue rate-limit budget is modelled: §9.13's budget is WP-310's package and does " +
  "not exist yet. The trader's own §9.8 check-19 headroom is measured against the " +
  "operator-stated requestBudget and is NOT the venue's published bucket.";

/**
 * What the venue is configured from: the `simulation` block of the operator
 * configuration (`config.ts` `SimulationConfigSchema`), structurally.
 */
export interface SimulatedVenueSettings {
  /** §12.5's fill-model version pin, carried on every simulated fill. */
  readonly fillModelVersion: string;
  /** Content identity of §12.5's fill-model parameters. */
  readonly fillModelParametersHash: string;
  /** §6 invariant 9: the fee schedule the run books against. Validated here. */
  readonly feeSchedule: FeeScheduleSnapshot;
}

/** Inputs to {@link buildSimulatedVenue}. Only these vary between callers. */
export interface SimulatedVenueBuildOptions {
  /** The §12.1 clock the trader is built with — the SAME one. */
  readonly clock: Clock;
  readonly settings: SimulatedVenueSettings;
  /** The venue's opening simulated cash: the configuration's `accounting.startingCash`. */
  readonly startingCash: string;
  /**
   * Where the execution policy logs a planned order it cannot resolve a
   * time-in-force for, before refusing it. Absent: not logged (the refusal
   * itself still happens, and is still contained).
   */
  readonly log?: (line: string) => void;
  /**
   * The venue's §9.13 budget. Absent: `unmodeledRateLimits` with
   * {@link UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE}, as the shipped process runs.
   */
  readonly rateLimits?: RateLimitBudget;
  /**
   * SIM-2: the bounds of the venue's retained HISTORY. Absent: the venue's
   * own defaults, as the shipped process runs. A bound the venue refuses is
   * the venue constructor's `RangeError`, unchanged.
   */
  readonly retention?: SimulatedVenueOptions["retention"];
}

/**
 * The venue and the holder the caller fills with its trader — or the one
 * refusal this builder answers: the fee snapshot was refused by
 * `packages/simulation`'s door (a run without a valid fee snapshot cannot
 * charge a fee, §6 invariant 9).
 */
export type SimulatedVenueBuild =
  | { readonly ok: true; readonly venue: SimulatedVenue; readonly wiring: VenueWiring }
  | { readonly ok: false; readonly refusal: SimulationRefusal };

/** Nothing is logged when the caller supplies no sink. */
function discard(): void {
  // The policy's refusal is still thrown and contained; only the line is dropped.
}

/**
 * Builds the simulated venue a composition root hands to `createPaperTrader`,
 * and the holder it must fill with the trader. Total apart from the venue
 * constructor's own `RangeError` for a `retention` bound it refuses.
 */
export function buildSimulatedVenue(options: SimulatedVenueBuildOptions): SimulatedVenueBuild {
  const { settings } = options;
  const fees = readFeeScheduleSnapshot({
    snapshotVersion: settings.feeSchedule.snapshotVersion,
    takerFeeRate: settings.feeSchedule.takerFeeRate,
    makerFeeRate: settings.feeSchedule.makerFeeRate,
    roundingDecimalPlaces: settings.feeSchedule.roundingDecimalPlaces,
    roundingMode: settings.feeSchedule.roundingMode,
    minimumChargedFee: settings.feeSchedule.minimumChargedFee,
    feeCurrency: settings.feeSchedule.feeCurrency,
  });
  if (!fees.ok) return { ok: false, refusal: fees.refusal };

  // The holder the venue's book provider reads. The caller fills it
  // the instant the trader exists; see the module header.
  const wiring: VenueWiring = { trader: undefined };

  const venue = new SimulatedVenue({
    clock: options.clock,
    runMode: TRADER_RUN_MODE,
    model: tier0Model({
      fillModelVersion: settings.fillModelVersion,
      fillModelParametersHash: settings.fillModelParametersHash,
    }),
    feeSnapshot: fees.value,
    rateLimits: options.rateLimits ?? unmodeledRateLimits(UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE),
    policy: createExecutionPolicy(options.clock, options.log ?? discard),
    startingCash: options.startingCash,
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    books: {
      book(input): BookView | undefined {
        const market = wiring.trader?.markets.get(input.marketId);
        if (market === undefined) return undefined;
        const tokenId =
          input.side === "YES" ? market.config.yesTokenId : market.config.noTokenId;
        return {
          internalMarketId: input.marketId,
          tokenId,
          top() {
            const top = market.bookFor(input.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market
              .bookFor(input.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });

  return { ok: true, venue, wiring };
}
