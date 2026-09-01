/**
 * The market and series registry — handoff §9.2, §10.1.
 *
 * A registry value is IMMUTABLE. Every operation returns a new registry and
 * leaves the one it was given intact, so a caller can hold "the universe as of
 * event N" and "as of event N+1" at once — which is what a replay, a
 * reconciliation, and a test all need.
 *
 * The registry owns three kinds of fact:
 *
 * 1. **Identity** — which venue market an internal id refers to, and the
 *    uniqueness of `conditionId` and both `tokenId`s across the whole universe.
 *    Two markets sharing a token id would make every book update ambiguous, so
 *    it is refused here rather than discovered later.
 * 2. **Series membership** — as CONFIGURATION. A market becomes a member of a
 *    series only through {@link bindMarketToSeries}, which requires a human
 *    approver, and only when the series' own binding has been approved. A
 *    heuristic can add a SUGGESTION and nothing else (§9.2).
 * 3. **Versioned parameters and lifecycle** — delegated to `parameters.ts` and
 *    `lifecycle.ts`, which hold the immutability and transition rules.
 *
 * No I/O, no clock, no randomness: identifiers, instants, and observations all
 * arrive as arguments.
 */

import {
  InternalMarketIdSchema,
  type ConditionId,
  type InternalMarketId,
  type IsoTimestamp,
  type MarketDiscoveredPayload,
  type TokenId,
  type TradingParametersChangedPayload,
} from "@polymarket-bot/domain";

import {
  universeFailure,
  universeOk,
  universeRefusal,
  type UniverseRefusal,
  type UniverseResult,
} from "./errors.js";
import { MarketIdentitySchema, isSameMarketIdentity, type MarketIdentity } from "./identity.js";
import {
  applyMarketLifecycleEvent,
  type MarketLifecycleInput,
  type MarketProjection,
  type ObservedOutcomeStateInput,
  type ProjectionApplied,
  recordObservedOutcomeState,
} from "./lifecycle.js";
import {
  appendParameterVersion,
  createParameterHistory,
  type MarketParameterVersion,
  type ParameterObservation,
} from "./parameters.js";
import {
  SeriesDefinitionSchema,
  UNBOUND_SERIES_BINDING,
  approvedSeriesBinding,
  isApprovedSeriesBinding,
  suggestSeriesBindings,
  suggestedSeriesBinding,
  type SeriesDefinition,
  type SeriesSuggestion,
} from "./series.js";

/** The immutable universe: markets, series, and the identity indexes. */
export interface UniverseRegistry {
  readonly markets: ReadonlyMap<InternalMarketId, MarketProjection>;
  readonly series: ReadonlyMap<string, SeriesDefinition>;
  readonly marketIdByConditionId: ReadonlyMap<ConditionId, InternalMarketId>;
  readonly marketIdByTokenId: ReadonlyMap<TokenId, InternalMarketId>;
  readonly seriesIdBySeriesKey: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Immutability enforcement (round-1 review, H3)
//
// `ReadonlyMap` and a shallow `Object.freeze` are COMPILE-TIME promises only:
// the reviewer's probe mutated a registered series' nested `binding` in place
// and forged an approval `approveSeries` never granted, and the exposed maps
// were ordinary `Map` instances a cast away from mutation. Stored values are
// therefore deeply frozen, and every exposed collection has its mutators
// replaced with throwing functions, so in-place forgery fails loudly at
// runtime rather than silently succeeding.
// ---------------------------------------------------------------------------

/** Recursively freezes an acyclic value in place and returns it. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const target = value as unknown as object;
  if (seen.has(target)) {
    return value;
  }
  seen.add(target);
  Object.freeze(target);
  for (const key of Reflect.ownKeys(target)) {
    deepFreeze((target as Record<PropertyKey, unknown>)[key], seen);
  }
  return value;
}

function refuseMutation(): never {
  throw new TypeError(
    "universe registry collections are immutable; every operation returns a new registry",
  );
}

/** A `Map` whose mutators throw, frozen, exposed as `ReadonlyMap`. */
function immutableMap<K, V>(entries?: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map<K, V>(entries);
  Object.defineProperties(map, {
    set: { value: refuseMutation },
    delete: { value: refuseMutation },
    clear: { value: refuseMutation },
  });
  return Object.freeze(map);
}

const EMPTY_REGISTRY: UniverseRegistry = Object.freeze({
  markets: immutableMap<InternalMarketId, MarketProjection>(),
  series: immutableMap<string, SeriesDefinition>(),
  marketIdByConditionId: immutableMap<ConditionId, InternalMarketId>(),
  marketIdByTokenId: immutableMap<TokenId, InternalMarketId>(),
  seriesIdBySeriesKey: immutableMap<string, string>(),
});

/** An empty registry. */
export function createUniverseRegistry(): UniverseRegistry {
  return EMPTY_REGISTRY;
}

function withMarket(
  registry: UniverseRegistry,
  projection: MarketProjection,
): UniverseRegistry {
  const markets = new Map(registry.markets);
  markets.set(projection.identity.internalMarketId, deepFreeze(projection));
  return Object.freeze({ ...registry, markets: immutableMap(markets) });
}

function issuesOf(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

function invalid(what: string, issues: readonly string[]): UniverseRefusal {
  return universeRefusal("UNIVERSE_INPUT_INVALID", `${what} is invalid: ${issues.join("; ")}`, {
    issues,
  });
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/** Registers a series definition. Re-registering the identical definition is a no-op. */
export function registerSeries(
  registry: UniverseRegistry,
  definition: unknown,
): UniverseResult<UniverseRegistry> {
  const parsed = SeriesDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return universeFailure(invalid("series definition", issuesOf(parsed.error)));
  }
  const series = parsed.data;

  const existing = registry.series.get(series.seriesId);
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(series)) {
      return universeOk(registry);
    }
    return universeFailure(
      universeRefusal(
        "UNIVERSE_SERIES_CONFLICT",
        "a different definition is already registered for this series id",
        { seriesId: series.seriesId },
      ),
    );
  }

  const keyOwner = registry.seriesIdBySeriesKey.get(series.seriesKey);
  if (keyOwner !== undefined && keyOwner !== series.seriesId) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_SERIES_KEY_ALREADY_BOUND",
        `series key ${series.seriesKey} already belongs to another series`,
        { seriesKey: series.seriesKey, ownerSeriesId: keyOwner },
      ),
    );
  }

  const seriesMap = new Map(registry.series);
  // Deep, not shallow (round-1 review, H3): a shallowly frozen series left
  // its nested `binding` mutable, and a caller holding `registry.series`
  // could forge `approved: true` in place.
  seriesMap.set(series.seriesId, deepFreeze(series));
  const keyMap = new Map(registry.seriesIdBySeriesKey);
  keyMap.set(series.seriesKey, series.seriesId);
  return universeOk(
    Object.freeze({
      ...registry,
      series: immutableMap(seriesMap),
      seriesIdBySeriesKey: immutableMap(keyMap),
    }),
  );
}

/** Records the human approval that makes a series usable for live binding (§9.2). */
export function approveSeries(
  registry: UniverseRegistry,
  input: { readonly seriesId: string; readonly approvedBy: string; readonly approvedAt: IsoTimestamp },
): UniverseResult<UniverseRegistry> {
  const series = registry.series.get(input.seriesId);
  if (series === undefined) {
    return universeFailure(
      universeRefusal("UNIVERSE_SERIES_UNKNOWN", "no such series", { seriesId: input.seriesId }),
    );
  }
  const approved: SeriesDefinition = {
    ...series,
    binding: { approved: true, approvedBy: input.approvedBy, approvedAt: input.approvedAt },
  };
  const parsed = SeriesDefinitionSchema.safeParse(approved);
  if (!parsed.success) {
    return universeFailure(invalid("series approval", issuesOf(parsed.error)));
  }
  const seriesMap = new Map(registry.series);
  seriesMap.set(series.seriesId, deepFreeze(parsed.data));
  return universeOk(Object.freeze({ ...registry, series: immutableMap(seriesMap) }));
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** What registering a market requires. */
export interface MarketRegistrationInput {
  readonly identity: unknown;
  /** The first parameter version (§9.2's stored parameter set). */
  readonly parameters: ParameterObservation;
  /** Metadata version of the venue payload this registration came from. */
  readonly metadataVersion?: number;
}

/** What registration produced. */
export interface MarketRegistered {
  readonly registry: UniverseRegistry;
  readonly projection: MarketProjection;
  /**
   * The §7.4 `MarketDiscovered` payload for this market.
   *
   * `seriesId` (the §7.4 field, which is the series KEY, not the catalog UUID)
   * is present only when an APPROVED binding exists: publishing a suggestion as
   * a binding would be the auto-approval §9.2 forbids, one layer downstream.
   */
  readonly event: MarketDiscoveredPayload;
}

function discoveredEvent(
  registry: UniverseRegistry,
  projection: MarketProjection,
): MarketDiscoveredPayload {
  const binding = projection.seriesBinding;
  const seriesKey = isApprovedSeriesBinding(binding)
    ? registry.series.get(binding.seriesId)?.seriesKey
    : undefined;
  return {
    internalMarketId: projection.identity.internalMarketId,
    conditionId: projection.identity.conditionId,
    yesTokenId: projection.identity.yesTokenId,
    noTokenId: projection.identity.noTokenId,
    ...(seriesKey === undefined ? {} : { seriesId: seriesKey }),
    metadataVersion: projection.metadataVersion,
  };
}

/**
 * Registers a market and starts its parameter history at version 1.
 *
 * Re-registering the SAME identity is idempotent; re-using a `conditionId` or
 * either `tokenId` for a different internal market is refused.
 */
export function registerMarket(
  registry: UniverseRegistry,
  input: MarketRegistrationInput,
): UniverseResult<MarketRegistered> {
  const parsed = MarketIdentitySchema.safeParse(input.identity);
  if (!parsed.success) {
    return universeFailure(invalid("market identity", issuesOf(parsed.error)));
  }
  const identity: MarketIdentity = parsed.data;
  const metadataVersion = input.metadataVersion ?? 1;

  const existing = registry.markets.get(identity.internalMarketId);
  if (existing !== undefined) {
    if (!isSameMarketIdentity(existing.identity, identity)) {
      return universeFailure(
        universeRefusal(
          "UNIVERSE_MARKET_IDENTITY_CONFLICT",
          "this internal market id is already registered with a different venue identity",
          { internalMarketId: identity.internalMarketId },
        ),
      );
    }
    return universeOk({
      registry,
      projection: existing,
      event: discoveredEvent(registry, existing),
    });
  }

  const conditionOwner = registry.marketIdByConditionId.get(identity.conditionId);
  if (conditionOwner !== undefined) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_CONDITION_ID_ALREADY_BOUND",
        "another internal market already claims this condition id",
        { conditionId: identity.conditionId, ownerInternalMarketId: conditionOwner },
      ),
    );
  }
  for (const tokenId of [identity.yesTokenId, identity.noTokenId]) {
    const tokenOwner = registry.marketIdByTokenId.get(tokenId);
    if (tokenOwner !== undefined) {
      return universeFailure(
        universeRefusal(
          "UNIVERSE_TOKEN_ID_ALREADY_BOUND",
          "another internal market already claims this outcome token",
          { tokenId, ownerInternalMarketId: tokenOwner },
        ),
      );
    }
  }

  const parameters = createParameterHistory(identity.internalMarketId, input.parameters);
  const projection: MarketProjection = deepFreeze({
    identity,
    seriesBinding: UNBOUND_SERIES_BINDING,
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion,
    clarifications: [],
    parameters,
  });

  const markets = new Map(registry.markets);
  markets.set(identity.internalMarketId, projection);
  const byCondition = new Map(registry.marketIdByConditionId);
  byCondition.set(identity.conditionId, identity.internalMarketId);
  const byToken = new Map(registry.marketIdByTokenId);
  byToken.set(identity.yesTokenId, identity.internalMarketId);
  byToken.set(identity.noTokenId, identity.internalMarketId);

  const next = Object.freeze({
    ...registry,
    markets: immutableMap(markets),
    marketIdByConditionId: immutableMap(byCondition),
    marketIdByTokenId: immutableMap(byToken),
  });
  return universeOk({ registry: next, projection, event: discoveredEvent(next, projection) });
}

function requireMarket(
  registry: UniverseRegistry,
  internalMarketId: string,
): UniverseResult<MarketProjection> {
  const parsed = InternalMarketIdSchema.safeParse(internalMarketId);
  if (!parsed.success) {
    return universeFailure(invalid("internal market id", issuesOf(parsed.error)));
  }
  const projection = registry.markets.get(parsed.data);
  if (projection === undefined) {
    return universeFailure(
      universeRefusal("UNIVERSE_MARKET_UNKNOWN", "no such market", { internalMarketId }),
    );
  }
  return universeOk(projection);
}

/** The market a condition id belongs to. */
export function findMarketByConditionId(
  registry: UniverseRegistry,
  conditionId: ConditionId,
): MarketProjection | undefined {
  const id = registry.marketIdByConditionId.get(conditionId);
  return id === undefined ? undefined : registry.markets.get(id);
}

/** The market an outcome token belongs to. */
export function findMarketByTokenId(
  registry: UniverseRegistry,
  tokenId: TokenId,
): MarketProjection | undefined {
  const id = registry.marketIdByTokenId.get(tokenId);
  return id === undefined ? undefined : registry.markets.get(id);
}

// ---------------------------------------------------------------------------
// Series binding (configuration, never heuristic)
// ---------------------------------------------------------------------------

/**
 * Binds a market to a series, with the human approval §9.2 requires.
 *
 * The series must itself be approved and active: approving a market into a
 * series whose own configuration nobody signed off would move the unreviewed
 * decision one level down rather than removing it.
 */
export function bindMarketToSeries(
  registry: UniverseRegistry,
  input: {
    readonly internalMarketId: string;
    readonly seriesId: string;
    readonly approvedBy: string;
    readonly approvedAt: IsoTimestamp;
  },
): UniverseResult<UniverseRegistry> {
  const market = requireMarket(registry, input.internalMarketId);
  if (!market.ok) {
    return market;
  }
  const series = registry.series.get(input.seriesId);
  if (series === undefined) {
    return universeFailure(
      universeRefusal("UNIVERSE_SERIES_UNKNOWN", "no such series", { seriesId: input.seriesId }),
    );
  }
  if (!series.binding.approved) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_SERIES_BINDING_NOT_APPROVED",
        "the series' own binding has not been approved, so no market may be bound to it",
        { seriesId: series.seriesId, seriesKey: series.seriesKey },
      ),
    );
  }
  if (!series.active) {
    return universeFailure(
      universeRefusal("UNIVERSE_SERIES_INACTIVE", "the series is not active", {
        seriesId: series.seriesId,
      }),
    );
  }

  return universeOk(
    withMarket(registry, {
      ...market.value,
      seriesBinding: approvedSeriesBinding(
        series.seriesId,
        input.approvedBy,
        input.approvedAt,
      ),
    }),
  );
}

/**
 * Series this market might belong to, ranked and explained.
 *
 * SUGGESTION ONLY (§9.2): the registry is not modified, and nothing in the
 * result can be turned into an approval without a human identity.
 */
export function suggestSeriesForMarket(
  registry: UniverseRegistry,
  internalMarketId: string,
): UniverseResult<readonly SeriesSuggestion[]> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  return universeOk(suggestSeriesBindings(market.value.identity, [...registry.series.values()]));
}

/**
 * Records the best suggestion as a SUGGESTED binding.
 *
 * A suggested binding permits nothing: `evaluateMarketReadiness` refuses
 * model-dependent activation on it exactly as it does on an unbound market. It
 * exists so an operator sees the shortlist next to the market.
 */
export function recordSeriesSuggestion(
  registry: UniverseRegistry,
  internalMarketId: string,
): UniverseResult<UniverseRegistry> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  if (isApprovedSeriesBinding(market.value.seriesBinding)) {
    // A suggestion never overwrites an approval.
    return universeOk(registry);
  }
  const suggestions = suggestSeriesBindings(market.value.identity, [
    ...registry.series.values(),
  ]);
  const best = suggestions[0];
  if (best === undefined) {
    return universeOk(registry);
  }
  return universeOk(
    withMarket(registry, {
      ...market.value,
      seriesBinding: suggestedSeriesBinding(best.seriesId, best.reasons),
    }),
  );
}

// ---------------------------------------------------------------------------
// Parameters and events
// ---------------------------------------------------------------------------

/** What recording a parameter change produced. */
export interface MarketParametersRecorded {
  readonly registry: UniverseRegistry;
  readonly version: MarketParameterVersion;
  readonly event: TradingParametersChangedPayload;
}

/**
 * Records a new parameter version for a market (§6 invariant 9).
 *
 * Refuses a no-op and an out-of-order observation; on success the market's
 * history has one more immutable version and the caller holds the
 * `TradingParametersChanged` payload to publish.
 */
export function recordMarketParameters(
  registry: UniverseRegistry,
  internalMarketId: string,
  observation: ParameterObservation,
): UniverseResult<MarketParametersRecorded> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  const appended = appendParameterVersion(
    market.value.parameters,
    observation,
    market.value.identity.conditionId,
  );
  if (!appended.ok) {
    return appended;
  }
  return universeOk({
    registry: withMarket(registry, {
      ...market.value,
      parameters: appended.value.history,
    }),
    version: appended.value.version,
    event: appended.value.event,
  });
}

/** What applying an event produced. */
export interface MarketEventApplied extends ProjectionApplied {
  readonly registry: UniverseRegistry;
}

/** Folds a §7.4 market event into the registry. */
export function applyMarketEvent(
  registry: UniverseRegistry,
  internalMarketId: string,
  input: MarketLifecycleInput,
): UniverseResult<MarketEventApplied> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  const result = applyMarketLifecycleEvent(market.value, input);
  if (!result.ok) {
    return result;
  }
  return universeOk({
    ...result.value,
    registry: withMarket(registry, result.value.projection),
  });
}

/** Records a non-terminal observed outcome state (see `lifecycle.ts`). */
export function recordMarketOutcomeState(
  registry: UniverseRegistry,
  internalMarketId: string,
  input: ObservedOutcomeStateInput,
): UniverseResult<MarketEventApplied> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  const result = recordObservedOutcomeState(market.value, input);
  if (!result.ok) {
    return result;
  }
  return universeOk({
    ...result.value,
    registry: withMarket(registry, result.value.projection),
  });
}
