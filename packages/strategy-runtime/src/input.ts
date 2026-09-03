/**
 * `EvaluationInput` — everything one evaluation may observe, supplied by the
 * event loop per §8.1 ("update local market/account state → update feature
 * snapshots → invoke subscribed strategies"). The runtime validates the input
 * SHALLOWLY and with typed detail before invoking anything: identifiers must
 * be canonical (a UUID-shaped value that is not canonical lowercase is
 * REFUSED, never case-folded — ADR-016), timestamps must be ISO-8601, the
 * callback payload must match the callback. An invalid input is a REFUSED
 * evaluation: the callback never runs and no decision record exists.
 *
 * Deep economic validation of view contents (book prices, position shares) is
 * deliberately NOT repeated here: views are produced in-process by components
 * that validated their own inputs against the frozen domain contracts, and
 * §8.1 gives the core loop a latency budget. The boundary re-validation lives
 * where untrusted bytes enter (adapters), not on every tick.
 *
 * Ownership: by passing an `EvaluationInput`, the caller hands the view
 * objects to the runtime, which deep-freezes them IN PLACE before the strategy
 * can see them (§7.6 read-only views). The caller therefore may not keep
 * mutating a view it passes: the first evaluation freezes the producer's own
 * object, and its next in-place write throws in strict mode.
 *
 * BINDING OBLIGATION ON THE COMPOSITION ROOT (WP-230), recorded 2026-09-02 in
 * remediation round 1 at the reviewer's request (finding L1): WP-230 must pass
 * a FRESH or explicitly COPIED view object per evaluation, and must carry an
 * INTEGRATION TEST that proves it — a test that runs two consecutive
 * evaluations against the real wiring and asserts the producers' own objects
 * are not the frozen ones (or, equivalently, that the producer can still
 * mutate its own state after an evaluation). In-place freezing of
 * caller-supplied objects is a deliberate, disclosed library-boundary choice
 * (`docs/handoffs/WP-170.md`: `assumptions` 13, `known_risks` 1); the test is
 * how that choice stops being a trap.
 */

import {
  IsoTimestampSchema,
  TerminalMarketOutcomeStateSchema,
  UnsignedBigIntStringSchema,
  Uuidv7Schema,
  UuidSchema,
  MAX_IDENTIFIER_LENGTH,
} from "@polymarket-bot/domain";
import type { IsoTimestamp } from "@polymarket-bot/domain";
import {
  STRATEGY_CALLBACK_NAMES,
  type FeatureSnapshot,
  type MarketView,
  type OrderBookView,
  type ResolutionView,
  type RiskBudgetView,
  type SourceEventRef,
  type StrategyFill,
  type StrategyOrderView,
  type VirtualPositionView,
} from "@polymarket-bot/strategy-sdk";

export interface EvaluationViews {
  readonly market: MarketView;
  readonly books: { readonly yes: OrderBookView; readonly no: OrderBookView };
  readonly features: FeatureSnapshot;
  readonly position: VirtualPositionView;
  readonly orders: readonly StrategyOrderView[];
  readonly riskBudget: RiskBudgetView;
}

interface EvaluationBase extends EvaluationViews {
  /** Logical evaluation time — the value `ctx.now()` returns. */
  readonly evaluatedAt: IsoTimestamp;
  readonly sourceEvent?: SourceEventRef;
}

export type EvaluationInput =
  | (EvaluationBase & {
      readonly callback: "onStart" | "onMarketOpen" | "onFeatures" | "onTimer";
    })
  | (EvaluationBase & { readonly callback: "onFill"; readonly fill: StrategyFill })
  | (EvaluationBase & { readonly callback: "onOrderUpdate"; readonly order: StrategyOrderView })
  | (EvaluationBase & { readonly callback: "onMarketClosing"; readonly secondsRemaining: number })
  | (EvaluationBase & {
      readonly callback: "onMarketResolved";
      readonly resolution: ResolutionView;
    })
  | (EvaluationBase & { readonly callback: "onStop"; readonly reason: string });

export type InputValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

const CALLBACKS_WITHOUT_PAYLOAD = new Set(["onStart", "onMarketOpen", "onFeatures", "onTimer"]);

function bad(detail: string): InputValidationResult {
  return { ok: false, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/** Validates one evaluation input. Returns typed detail; never throws. */
export function validateEvaluationInput(input: unknown): InputValidationResult {
  if (!isRecord(input)) {
    return bad("input must be an object");
  }
  const callback = input["callback"];
  if (
    typeof callback !== "string" ||
    !(STRATEGY_CALLBACK_NAMES as readonly string[]).includes(callback)
  ) {
    return bad(`callback must be one of ${STRATEGY_CALLBACK_NAMES.join(", ")}`);
  }
  if (!IsoTimestampSchema.safeParse(input["evaluatedAt"]).success) {
    return bad("evaluatedAt must be an ISO-8601 timestamp");
  }

  const market = input["market"];
  if (!isRecord(market)) {
    return bad("market view is required");
  }
  if (!Uuidv7Schema.safeParse(market["marketId"]).success) {
    return bad(
      "market.marketId must be a canonical lowercase UUIDv7 — a non-canonical UUID-shaped " +
        "identifier is refused, never case-folded (ADR-016)",
    );
  }

  const books = input["books"];
  if (!isRecord(books) || !isRecord(books["yes"]) || !isRecord(books["no"])) {
    return bad("books.yes and books.no order-book views are required");
  }

  const features = input["features"];
  if (!isRecord(features)) {
    return bad("features snapshot view is required");
  }
  if (!isBoundedNonEmptyString(features["snapshotRef"])) {
    return bad(
      `features.snapshotRef must be a non-empty string of at most ${String(MAX_IDENTIFIER_LENGTH)} characters`,
    );
  }
  if (!isRecord(features["values"])) {
    return bad("features.values must be an object");
  }

  if (!isRecord(input["position"])) {
    return bad("position view is required");
  }
  if (!Array.isArray(input["orders"])) {
    return bad("orders must be an array of StrategyOrderView");
  }
  if (!isRecord(input["riskBudget"])) {
    return bad("riskBudget view is required");
  }

  const sourceEvent = input["sourceEvent"];
  if (sourceEvent !== undefined) {
    if (!isRecord(sourceEvent)) {
      return bad("sourceEvent must be an object when present");
    }
    const eventId = sourceEvent["eventId"];
    if (eventId !== undefined && !UuidSchema.safeParse(eventId).success) {
      return bad("sourceEvent.eventId must be a canonical lowercase UUID (ADR-016)");
    }
    const gatewayEpoch = sourceEvent["gatewayEpoch"];
    if (gatewayEpoch !== undefined && !UuidSchema.safeParse(gatewayEpoch).success) {
      return bad("sourceEvent.gatewayEpoch must be a canonical lowercase UUID (ADR-016)");
    }
    const ingestSeq = sourceEvent["ingestSeq"];
    if (ingestSeq !== undefined && !UnsignedBigIntStringSchema.safeParse(ingestSeq).success) {
      return bad("sourceEvent.ingestSeq must be a canonical unsigned integer string");
    }
  }

  if (CALLBACKS_WITHOUT_PAYLOAD.has(callback)) {
    return { ok: true };
  }
  switch (callback) {
    case "onFill": {
      if (!isRecord(input["fill"])) {
        return bad("onFill requires a fill payload");
      }
      return { ok: true };
    }
    case "onOrderUpdate": {
      if (!isRecord(input["order"])) {
        return bad("onOrderUpdate requires an order payload");
      }
      return { ok: true };
    }
    case "onMarketClosing": {
      const seconds = input["secondsRemaining"];
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return bad("onMarketClosing requires a finite non-negative secondsRemaining");
      }
      return { ok: true };
    }
    case "onMarketResolved": {
      const resolution = input["resolution"];
      if (!isRecord(resolution)) {
        return bad("onMarketResolved requires a resolution payload");
      }
      if (!TerminalMarketOutcomeStateSchema.safeParse(resolution["outcome"]).success) {
        return bad(
          "resolution.outcome must be a terminal market outcome state " +
            "(YES_WIN, NO_WIN, SPLIT_50_50, CANCELLED) — a dispute is market state, not a resolution",
        );
      }
      return { ok: true };
    }
    case "onStop": {
      if (!isBoundedNonEmptyString(input["reason"])) {
        return bad("onStop requires a non-empty reason string");
      }
      return { ok: true };
    }
    default:
      return bad(`unhandled callback ${callback}`);
  }
}
