/**
 * Shared WP-220 fixtures.
 *
 * Imported RELATIVELY through each package's own `exports` entry module (the
 * WP-150/WP-170 precedent for the root test tree: it declares no dependency on
 * any workspace package, and the root `package.json` is outside WP-220's
 * allowed paths). These are entry-point imports, not deep imports (F16).
 *
 * PURITY. Per the GOV-1C ruling on `dependency-direction.md` §6.1 item 2, a
 * strategy's tests follow the same determinism rules as the strategy: no
 * `Date`, no `Math.random`, no wall clock. Time here is explicit fixture text
 * and a manual monotonic counter; the only randomness available is the
 * runtime's seeded generator, which this strategy does not use.
 */

import type {
  DecisionResult,
  FeatureSnapshot,
  MarketView,
  OrderBookView,
  ResolutionView,
  RiskBudgetView,
  SeededRandom,
  StrategyContext,
  StrategyOrderView,
  VirtualPositionView,
} from "../../../../packages/strategy-sdk/src/index.js";
import type { Intent } from "../../../../packages/domain/src/index.js";
import {
  canonicalJsonStringify,
  rebuildStateFromPatches,
  type DecisionRecord,
  type DecisionTelemetry,
  type EvaluationInput,
  type MonotonicClock,
  type StrategyStateCheckpoint,
} from "../../../../packages/strategy-runtime/src/index.js";
import {
  INITIAL_STATE,
  type OrderTrack,
  type StaticBracketParams,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";

export const MARKET_ID = "018f4a7e-1111-7abc-8def-0123456789ab";
export const YES_TOKEN = "111";
export const NO_TOKEN = "222";
export const SNAPSHOT_REF = "snapshot-1";
export const RUN_ID = "run-1";
export const INSTANCE_ID = "instance-1";
export const CONFIG_ID = "config-1";
export const RUN_SEED = "424242";

/** The market opens at T_OPEN and closes 15 minutes later. */
export const T_OPEN = "2026-03-04T12:00:00.000Z";
export const T_CLOSE = "2026-03-04T12:15:00.000Z";
export const T_NOW = "2026-03-04T12:05:00.000Z";

export const TRIGGER_KEY = "polymarket.executable_buy_price@50";
export const STOP_KEY = "polymarket.executable_sell_price@50";
export const INCIDENT_KEY = "quality.active_incidents@any";

/**
 * The §13.2 example configuration, key for key and value for value, plus the
 * fields this package adds (each disclosed in `params.ts` with its basis).
 *
 * `handoffConfig()` below returns ONLY the §13.2 half, and
 * `test/unit/strategies/static-bracket/params-grammar.test.ts` proves this
 * object is that object plus exactly the disclosed additions.
 */
export function baseConfig(): Record<string, unknown> {
  return {
    strategy: "static-bracket",
    version: 1,
    market_selector: {
      series_id: "btc-15m-updown",
      direction: "YES",
    },
    entry: {
      trigger_basis: "executable_ask",
      trigger_feature_key: TRIGGER_KEY,
      trigger_price_lte: "0.35",
      size_shares: "50",
      maximum_total_cost: "18",
      economic_leg_policy: "DIRECT_ONLY",
      execution: {
        liquidity_preference: "MAKER_PREFERRED",
        passive_price: "0.35",
        convert_to_aggressive_after_ms: 0,
        maximum_buy_price: "0.35",
        immediate_order_type: "GTD",
        partial_fill_policy: "ACCEPT_MINIMUM",
        minimum_fill_shares: "10",
        submission_unknown_after_ms: 5000,
        order_validity_ms: 30000,
      },
      economics: {
        entry_fee_per_share: "0.001",
        exit_fee_per_share: "0.001",
        minimum_expected_net_edge: "1",
      },
    },
    exit: {
      take_profit: {
        price: "0.50",
        liquidity_preference: "MAKER_ONLY",
        post_only: true,
      },
      stop: {
        enabled: true,
        trigger_basis: "executable_bid",
        trigger_feature_key: STOP_KEY,
        trigger_price_lte: "0.27",
        minimum_sell_price: "0.26",
        urgency: "AGGRESSIVE",
      },
      maximum_holding_seconds: 180,
      entry_cutoff_before_close_seconds: 45,
      exit_cutoff_before_close_seconds: 20,
      final_policy: "PROTECTED_REDUCE",
      allow_resolution_hold: false,
    },
    reentry: {
      maximum_entries_per_market: 1,
      cooldown_seconds: 30,
    },
    risk: {
      maximum_position_shares: "50",
      maximum_contractual_loss: "18",
      maximum_slippage: "1",
      maximum_book_participation: "0.05",
    },
    data_quality: {
      maximum_book_age_ms: 2000,
      incident_feature_key: INCIDENT_KEY,
      on_stale_book: "PAUSE_AND_CANCEL",
      on_incident: "PAUSE_AND_CANCEL",
    },
  };
}

/** The tag every protected reduction carries (`reasons.ts` `TAGS`). */
export const PROTECTED_REDUCE_TAG = "sb.protected-reduce";

/**
 * The PROTECTED-REDUCTION intents of a decision.
 *
 * Review round 2's BLOCKER: a §7.7 `REDUCE_POSITION` carries a `targetShares`
 * that the merged execution planner reads as a per-side SELL-DOWN LEVEL for the
 * WHOLE market, which cannot express one leg's own allocation and cannot
 * express a complement-leg buy-back at all. Every exit this strategy emits is
 * therefore a `POSITION` delta, and a protected reduction is told apart from a
 * take-profit by the tag it carries — so an assertion that NO reduction was
 * emitted still has teeth rather than filtering for a type that never occurs.
 */
export function protectedReductions(decision: {
  readonly intents: readonly Intent[];
}): readonly Intent[] {
  return decision.intents.filter(
    (intent) => intent.type === "POSITION" && intent.tags.includes(PROTECTED_REDUCE_TAG),
  );
}

/** Deep, own-key clone of a plain fixture tree (no `structuredClone` needed). */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => clone(element)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = clone(member);
    }
    return copy as T;
  }
  return value;
}

/** Applies `path -> value` edits to a cloned config. */
export function configWith(edits: Record<string, unknown>): Record<string, unknown> {
  const config = baseConfig();
  for (const [path, value] of Object.entries(edits)) {
    const segments = path.split(".");
    let cursor = config as Record<string, unknown>;
    for (let index = 0; index < segments.length - 1; index += 1) {
      cursor = cursor[segments[index] as string] as Record<string, unknown>;
    }
    const last = segments[segments.length - 1] as string;
    if (value === DELETE) {
      delete cursor[last];
    } else {
      cursor[last] = value;
    }
  }
  return config;
}

/** Sentinel for `configWith`: remove the key entirely. */
export const DELETE = Symbol("delete");

export interface BookFixture {
  readonly bids: readonly (readonly [string, string])[];
  readonly asks: readonly (readonly [string, string])[];
  readonly asOf?: string;
}

/**
 * Reads one OPTIONAL fixture key, OWN-PROPERTY ONLY.
 *
 * `options.tickSize ?? "0.01"` looks harmless and is not: the option objects the
 * tests pass are ordinary `{}` literals, so they inherit `Object.prototype`, and
 * the hostile battery pollutes exactly that. A polluted `tickSize`, `closeTime`
 * or `yesShares` would be answered by the prototype and the FIXTURE would hand
 * the strategy a poisoned view — the battery would then be measuring the
 * helpers, not the package under test. Every optional read below goes through
 * here, so an absent key is absent.
 */
function pick<T extends object, K extends keyof T & string>(
  options: T,
  key: K,
  fallback: NonNullable<T[K]>,
): NonNullable<T[K]> {
  if (!Object.hasOwn(options, key)) return fallback;
  const value = options[key];
  return value === undefined ? fallback : (value as NonNullable<T[K]>);
}

/** As {@link pick}, but `null` is a meaningful value the caller chose. */
function pickNullable<T extends object, K extends keyof T & string>(
  options: T,
  key: K,
  fallback: T[K],
): T[K] {
  if (!Object.hasOwn(options, key)) return fallback;
  const value = options[key];
  return value === undefined ? fallback : value;
}

function levels(pairs: readonly (readonly [string, string])[]): { price: string; shares: string }[] {
  return pairs.map(([price, shares]) => ({ price, shares }));
}

export function book(fixture: BookFixture, asOf: string): OrderBookView {
  return {
    bids: levels(fixture.bids),
    asks: levels(fixture.asks),
    asOf: pick(fixture, "asOf", asOf),
  } as OrderBookView;
}

/** A book deep enough for the §13.2 size at the §13.2 prices. */
export const HEALTHY_YES: BookFixture = {
  bids: [
    ["0.34", "2000"],
    ["0.33", "2000"],
  ],
  asks: [
    ["0.35", "2000"],
    ["0.36", "2000"],
  ],
};

export const HEALTHY_NO: BookFixture = {
  bids: [
    ["0.64", "2000"],
    ["0.63", "2000"],
  ],
  asks: [
    ["0.66", "2000"],
    ["0.67", "2000"],
  ],
};

export interface ViewOptions {
  readonly now?: string;
  readonly yes?: BookFixture;
  readonly no?: BookFixture;
  readonly features?: Record<string, string | boolean | null>;
  /** Keys DELETED from the snapshot, so the strategy sees them truly absent. */
  readonly omitFeatures?: readonly string[];
  readonly yesShares?: string;
  readonly noShares?: string;
  readonly orders?: readonly StrategyOrderView[];
  readonly tickSize?: string;
  readonly minimumOrderSize?: string;
  readonly closeTime?: string | null;
  readonly openTime?: string | null;
}

export function features(
  overrides: Record<string, string | boolean | null> = {},
  omit: readonly string[] = [],
): FeatureSnapshot {
  const values: Record<string, string | boolean | null> = {
    [TRIGGER_KEY]: "0.35",
    [STOP_KEY]: "0.34",
    [INCIDENT_KEY]: false,
    ...overrides,
  };
  for (const key of omit) {
    delete values[key];
  }
  return { snapshotRef: SNAPSHOT_REF, asOf: T_NOW, values } as FeatureSnapshot;
}

export function marketView(options: ViewOptions = {}): MarketView {
  const view: Record<string, unknown> = {
    marketId: MARKET_ID,
    conditionId: "0xcondition",
    yesTokenId: YES_TOKEN,
    noTokenId: NO_TOKEN,
    tickSize: pick(options, "tickSize", "0.01"),
    minimumOrderSize: pick(options, "minimumOrderSize", "5"),
  };
  const openTime = pickNullable(options, "openTime", T_OPEN as string | null);
  if (openTime !== null) view["openTime"] = openTime;
  const closeTime = pickNullable(options, "closeTime", T_CLOSE as string | null);
  if (closeTime !== null) view["closeTime"] = closeTime;
  return view as unknown as MarketView;
}

export function position(options: ViewOptions = {}): VirtualPositionView {
  return {
    yesShares: pick(options, "yesShares", "0"),
    noShares: pick(options, "noShares", "0"),
    asOf: pick(options, "now", T_NOW),
  } as VirtualPositionView;
}

export function riskBudget(): RiskBudgetView {
  return { availableCollateral: "1000", asOf: T_NOW } as RiskBudgetView;
}

export function order(overrides: Partial<StrategyOrderView> = {}): StrategyOrderView {
  return {
    orderId: "order-1",
    marketId: MARKET_ID,
    outcome: "YES",
    side: "BUY",
    price: "0.35",
    requestedShares: "50",
    filledShares: "0",
    status: "OPEN",
    placedAt: T_NOW,
    ...overrides,
  } as StrategyOrderView;
}

/**
 * A `StrategyContext` over the fixtures.
 *
 * Faithful to §7.6: the methods return frozen data and perform no I/O, and the
 * RNG is a seeded counter that this strategy never draws from (a draw would
 * make the test fail the determinism assertions, which is the point).
 */
export function context(
  params: unknown,
  state: unknown,
  options: ViewOptions = {},
): StrategyContext {
  const now = pick(options, "now", T_NOW);
  const yesBook = book(pick(options, "yes", HEALTHY_YES), now);
  const noBook = book(pick(options, "no", HEALTHY_NO), now);
  const snapshot = features(pick(options, "features", {}), pick(options, "omitFeatures", []));
  const market = marketView(options);
  const held = position({ ...options, now });
  const orders = pick(options, "orders", []);
  let draws = 0;
  const rng: SeededRandom = {
    nextUint32: () => {
      draws += 1;
      return draws;
    },
    nextFloat53: () => {
      draws += 1;
      return 0;
    },
    nextIntBelow: () => {
      draws += 1;
      return 0;
    },
  };
  return {
    now: () => now,
    market: () => market,
    book: (outcome: "YES" | "NO") => (outcome === "YES" ? yesBook : noBook),
    features: () => snapshot,
    position: () => held,
    orders: () => orders,
    riskBudget: () => riskBudget(),
    params: <T,>() => params as T,
    state: <T,>() => state as T,
    rng: () => rng,
  } as StrategyContext;
}

/** The validated params for the §13.2 example configuration. */
export function parsedParams(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  config: Record<string, unknown> = baseConfig(),
): StaticBracketParams {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new Error("fixture configuration must validate");
  }
  return parsed.data as StaticBracketParams;
}

/** A state document with the named overrides applied to the initial one. */
export function stateWith(changes: Partial<StaticBracketState>): StaticBracketState {
  return { ...INITIAL_STATE, ...changes };
}

/** A tracked order with the named overrides applied to a plain resting entry. */
export function orderTrack(changes: Partial<OrderTrack> = {}): OrderTrack {
  return {
    kind: "ENTRY",
    intentId: "sb-entry-0",
    orderId: "order-1",
    state: "WORKING",
    outcome: "YES",
    side: "BUY",
    limitPrice: "0.35",
    requestedShares: "50",
    filledShares: "0",
    viewFilledShares: "0",
    placedAtMs: 1,
    escalated: true,
    ...changes,
  };
}

// ---------------------------------------------------------------------------
// The real WP-170 runtime harness
// ---------------------------------------------------------------------------

/** Manual monotonic clock: time moves only when a test moves it. */
export class ManualClock implements MonotonicClock {
  private ns = 1_000_000n;

  nowNs(): bigint {
    return this.ns;
  }

  advanceUs(us: number): void {
    this.ns += BigInt(us) * 1000n;
  }
}

export class RecordingSink {
  readonly calls: { record: DecisionRecord; telemetry: DecisionTelemetry }[] = [];

  persist(record: DecisionRecord, telemetry: DecisionTelemetry): void {
    this.calls.push({ record, telemetry });
  }

  get decisions(): DecisionResult[] {
    return this.calls.map((call) => call.record.decision);
  }
}

export class RecordingStore {
  readonly checkpoints: StrategyStateCheckpoint[] = [];

  save(checkpoint: StrategyStateCheckpoint): void {
    this.checkpoints.push(checkpoint);
  }
}

/**
 * `CKPT-1` (ADR-027 D2.1): the canonical bytes of the fold of every persisted
 * `statePatch` — the state the records alone rebuild (`WP-170` decision 8).
 * Since ADR-027 a checkpoint is written only when the state (or status, or
 * RNG) changed, so the LAST checkpoint must equal this; a test that reads the
 * current state off the last checkpoint checks that it does.
 */
export function foldedStateBytes(sink: RecordingSink): string {
  const folded = rebuildStateFromPatches(sink.calls.map((call) => call.record.decision.statePatch));
  if (!folded.ok) throw new Error(`the persisted patches do not fold: ${folded.problem}`);
  return canonicalJsonStringify(folded.state);
}

/**
 * `CKPT-1` — the sequences of the records after which the folded state bytes
 * changed, plus the first record (START): what ADR-027 Decision 1 owes a
 * checkpoint for, for this strategy. Static Bracket draws no randomness, and
 * these runs neither stop nor contain nor span 60 s, so STATE and START are
 * the only transitions that can apply.
 */
export function stateChangingSeqs(sink: RecordingSink): number[] {
  const owed: number[] = [];
  let last = "";
  for (const [index, call] of sink.calls.entries()) {
    const folded = rebuildStateFromPatches(
      sink.calls.slice(0, index + 1).map((entry) => entry.record.decision.statePatch),
    );
    if (!folded.ok) throw new Error(`the persisted patches do not fold: ${folded.problem}`);
    const bytes = canonicalJsonStringify(folded.state);
    if (index === 0 || bytes !== last) owed.push(call.record.evaluationSeq);
    last = bytes;
  }
  return owed;
}

/** One evaluation input for the real runtime. */
export function evaluationInput(
  callback: EvaluationInput["callback"],
  options: ViewOptions = {},
  payload: Record<string, unknown> = {},
): EvaluationInput {
  const now = pick(options, "now", T_NOW);
  return {
    callback,
    evaluatedAt: now,
    market: marketView(options),
    books: {
      yes: book(pick(options, "yes", HEALTHY_YES), now),
      no: book(pick(options, "no", HEALTHY_NO), now),
    },
    features: features(pick(options, "features", {}), pick(options, "omitFeatures", [])),
    position: position({ ...options, now }),
    orders: pick(options, "orders", []),
    riskBudget: riskBudget(),
    ...payload,
  } as EvaluationInput;
}

export function fillPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fill: {
      orderId: "order-1",
      marketId: MARKET_ID,
      outcome: "YES",
      side: "BUY",
      price: "0.35",
      shares: "50",
      filledAt: T_NOW,
      ...overrides,
    },
  };
}

export function resolutionPayload(outcome = "YES_WIN"): Record<string, unknown> {
  return {
    resolution: { marketId: MARKET_ID, outcome, resolvedAt: T_CLOSE } as unknown as ResolutionView,
  };
}
