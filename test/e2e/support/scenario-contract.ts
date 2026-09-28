/**
 * The SCENARIO a paper end-to-end run is driven by (`BRACKET-1b`, E1).
 *
 * `WP-250` wrote the harness, the artefact capture, the golden reader and the
 * determinism test around ONE scenario, imported by name from `scenario.ts`.
 * `BRACKET-1b` adds a second one (`scenarios/two-brackets.ts`), so every one of
 * those modules now takes the scenario as a value of this shape instead — and
 * defaults to the original, so every existing caller reads exactly what it
 * read before and the existing golden stays byte-identical.
 *
 * A scenario is plain data plus three pure functions. Nothing here reads a
 * clock, an environment, a file or a random source.
 */

import type { FeeScheduleSnapshot } from "@polymarket-bot/simulation";
import type { IngestedEvent } from "@polymarket-bot/trader";

/**
 * The scenario's constants, as the artefact's `scenario` section states them.
 *
 * Each field is copied VERBATIM into that section, so for the original
 * scenario these are exactly the constants `scenario.ts` exports and the
 * committed golden already holds.
 */
export interface ScenarioConstants {
  readonly marketId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  /** The OWNER instance whose decisions, orders and PnL stream the artefact reads. */
  readonly instanceId: string;
  readonly runId: string;
  readonly accountRef: string;
  readonly denominationAssetId: string;
  readonly startingCash: string;
  readonly entryShares: string;
  readonly triggerPriceLte: string;
  readonly maximumBuyPrice: string;
  readonly maximumTotalCost: string;
  readonly takeProfitPrice: string;
  readonly entryFeePerShare: string;
  readonly exitFeePerShare: string;
}

export interface Scenario {
  /** A short, stable name, used in test titles and messages only. */
  readonly name: string;
  /**
   * The `idNamespace` handed to `createPaperTrader`: the seed every minted
   * ledger, PnL and plan id — and therefore the golden — is frozen against.
   */
  readonly idNamespace: string;
  /** The instant the manual clock is constructed at (the market's open). */
  readonly clockStart: string;
  readonly constants: ScenarioConstants;
  /** The operator-stated fee snapshot (§6 invariant 9). */
  readonly feeSnapshot: () => FeeScheduleSnapshot;
  /** The whole operator document; `withShadow` adds an observe-only SHADOW instance. */
  readonly traderConfig: (options?: { readonly withShadow?: boolean }) => Record<string, unknown>;
  /** The recorded events, in publication order. A pure function of module constants. */
  readonly events: () => readonly IngestedEvent[];
  /** The committed golden's file name, under `test/replay-golden/paper-e2e/`. */
  readonly goldenFile: string;
}
