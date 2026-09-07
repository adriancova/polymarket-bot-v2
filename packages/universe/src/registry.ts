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
  UniverseValidationError,
  universeFailure,
  universeOk,
  universeRefusal,
  type UniverseRefusal,
  type UniverseResult,
} from "./errors.js";
import { isSameMarketIdentity, type MarketIdentity } from "./identity.js";
import { containedParse } from "./lifecycle-door.js";
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
  SERIES_APPROVAL_KEYS,
  SERIES_BINDING_KEYS,
  openApprovalInput,
  openApprovedSeriesDefinition,
  openLifecycleEventInput,
  openMarketIdentity,
  openMarketRegistrationInput,
  openObservedOutcomeStateInput,
  openParameterObservation,
  openSeriesDefinition,
  ownDiscoveredEvent,
} from "./registration-door.js";
import {
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

function invalid(what: string, issues: readonly string[]): UniverseRefusal {
  return universeRefusal("UNIVERSE_INPUT_INVALID", `${what} is invalid: ${issues.join("; ")}`, {
    issues,
  });
}

/**
 * Runs `./parameters.ts` with its own throw contract intact, and nothing else.
 *
 * `parseObservation` is DOCUMENTED to throw `UniverseValidationError` on an
 * invalid observation, and that verdict is preserved here — it is what every
 * existing caller sees. What is NOT part of any contract is `zod`'s refusal
 * CONSTRUCTION escaping as a bare `TypeError`: measured at base and at the
 * candidate, an inherited `get`, `value`, `_zod` or `message` turned
 * `recordMarketParameters`' clean `UniverseValidationError` into
 * `TypeError: Invalid property descriptor …` / `Cannot read properties of
 * undefined (reading 'has')`. Those become a typed refusal (ADR-020 amendment
 * 2026-09-06); the observation schema itself stays where it belongs.
 */
function containedParameters<T>(
  run: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly string[] } {
  try {
    return { ok: true, value: run() };
  } catch (error: unknown) {
    if (error instanceof UniverseValidationError) {
      throw error;
    }
    return {
      ok: false,
      issues: [
        "(root): the parameter observation could not be judged (its refusal could not be constructed); refused",
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/**
 * Registers a series definition. Re-registering the identical definition is a no-op.
 *
 * The definition arrives through `./registration-door.ts` (`UNIV-2`): at base
 * all NINE declared keys were satisfiable from `Object.prototype`, including a
 * fabricated `{approved: true, approvedBy: "ghost", approvedAt: …}` binding
 * that `bindMarketToSeries` then accepted — the §9.2 review gate, granted by a
 * review that never happened.
 */
export function registerSeries(
  registry: UniverseRegistry,
  definition: unknown,
): UniverseResult<UniverseRegistry> {
  const opened = openSeriesDefinition(definition);
  if (!opened.ok) {
    return universeFailure(invalid("series definition", opened.issues));
  }
  const series = opened.value;

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

/**
 * Records the human approval that makes a series usable for live binding (§9.2).
 *
 * Both review facts, and the `seriesId` being approved, are read as OWN
 * properties of the caller's record: at base an inherited `approvedBy`/
 * `approvedAt` stored `{"approved":true,"approvedBy":"ghost",…}`, and an
 * inherited `seriesId` approved a series the caller never named.
 */
export function approveSeries(
  registry: UniverseRegistry,
  input: { readonly seriesId: string; readonly approvedBy: string; readonly approvedAt: IsoTimestamp },
): UniverseResult<UniverseRegistry> {
  const opened = openApprovalInput(input, SERIES_APPROVAL_KEYS);
  if (!opened.ok) {
    return universeFailure(invalid("series approval", opened.issues));
  }
  const seriesId = opened.value.seriesId;
  const series = typeof seriesId === "string" ? registry.series.get(seriesId) : undefined;
  if (series === undefined) {
    return universeFailure(
      universeRefusal("UNIVERSE_SERIES_UNKNOWN", "no such series", { seriesId }),
    );
  }
  const approved = openApprovedSeriesDefinition(
    series,
    opened.value.approvedBy,
    opened.value.approvedAt,
  );
  if (!approved.ok) {
    return universeFailure(invalid("series approval", approved.issues));
  }
  const seriesMap = new Map(registry.series);
  seriesMap.set(series.seriesId, deepFreeze(approved.value));
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
  // D4: the emitted payload is prototype-free, so a consumer's
  // `event.seriesId === undefined` — "does this market have an APPROVED series
  // binding?" — cannot be answered by `Object.prototype`.
  return ownDiscoveredEvent({
    internalMarketId: projection.identity.internalMarketId,
    conditionId: projection.identity.conditionId,
    yesTokenId: projection.identity.yesTokenId,
    noTokenId: projection.identity.noTokenId,
    ...(seriesKey === undefined ? {} : { seriesId: seriesKey }),
    metadataVersion: projection.metadataVersion,
  });
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
  // The input RECORD first: at base `registerMarket(registry, {})` registered a
  // market whose identity and parameter observation both came from
  // `Object.prototype`, and an inherited `metadataVersion` landed in the
  // projection. The materialized `parameters` subtree is what
  // `createParameterHistory` is handed below, so the frozen observation schema
  // has no chain to read either.
  const opened = openMarketRegistrationInput(input);
  if (!opened.ok) {
    return universeFailure(invalid("market registration", opened.issues));
  }
  const identityRead = openMarketIdentity(opened.value.identity);
  if (!identityRead.ok) {
    return universeFailure(invalid("market identity", identityRead.issues));
  }
  const identity: MarketIdentity = identityRead.value;
  const metadataVersion = (opened.value.metadataVersion as number | undefined) ?? 1;

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

  const history = containedParameters(() =>
    createParameterHistory(identity.internalMarketId, opened.value.parameters as ParameterObservation),
  );
  if (!history.ok) {
    return universeFailure(invalid("market parameter observation", history.issues));
  }
  const parameters = history.value;
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
  // Contained (ADR-020 amendment): the id is a scalar, so nothing is adoptable
  // here — but rendering the REFUSAL reads through the prototype chain, and at
  // base an inherited `get`/`value`/`_zod`/`message` turned this function's
  // clean refusal into an escaping `TypeError`.
  const parsed = containedParse(InternalMarketIdSchema, internalMarketId);
  if (!parsed.ok) {
    return universeFailure(invalid("internal market id", parsed.issues));
  }
  const projection = registry.markets.get(internalMarketId);
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
  // Every one of the four keys adopted at base, in BOTH pollution variants:
  // no schema stands between this record and the stored APPROVED binding, so
  // `strictObject` could not even fail it closed. An inherited `approvedBy`
  // recorded `"ghost"` as the human who approved the membership.
  const opened = openApprovalInput(input, SERIES_BINDING_KEYS);
  if (!opened.ok) {
    return universeFailure(invalid("series binding", opened.issues));
  }
  const market = requireMarket(registry, opened.value.internalMarketId as string);
  if (!market.ok) {
    return market;
  }
  const seriesId = opened.value.seriesId;
  const series = typeof seriesId === "string" ? registry.series.get(seriesId) : undefined;
  if (series === undefined) {
    return universeFailure(
      universeRefusal("UNIVERSE_SERIES_UNKNOWN", "no such series", { seriesId }),
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
        opened.value.approvedBy as string,
        opened.value.approvedAt as string,
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
  // D1 only, and deliberately (see `./registration-door.ts`): the materialized
  // observation goes to `./parameters.ts` exactly as the caller's value did, so
  // its documented THROW contract and every message are unchanged — while the
  // adoption class is closed, including the ECONOMIC members. At base an
  // inherited `tickSize` recorded `"0.99"` into an immutable parameter version.
  const observed = openParameterObservation(observation);
  if (!observed.ok) {
    return universeFailure(invalid("market parameter observation", observed.issues));
  }
  const contained = containedParameters(() =>
    appendParameterVersion(
      market.value.parameters,
      observed.value as ParameterObservation,
      market.value.identity.conditionId,
    ),
  );
  if (!contained.ok) {
    return universeFailure(invalid("market parameter observation", contained.issues));
  }
  const appended = contained.value;
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

/**
 * Folds a §7.4 market event into the registry.
 *
 * The input RECORD is read as own data before the fold: at base
 * `applyMarketEvent(registry, id, {})` OPENED a market — `eventType` and the
 * whole `payload` came from `Object.prototype`, in BOTH variants — and an
 * inherited `order` supplied the §7.1 ordering the replay guard compares. The
 * PAYLOAD itself is handed on untouched: `./lifecycle-door.ts` owns it.
 */
export function applyMarketEvent(
  registry: UniverseRegistry,
  internalMarketId: string,
  input: MarketLifecycleInput,
): UniverseResult<MarketEventApplied> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  const opened = openLifecycleEventInput(input);
  if (!opened.ok) {
    return universeFailure(invalid("market lifecycle input", opened.issues));
  }
  const result = applyMarketLifecycleEvent(market.value, opened.value);
  if (!result.ok) {
    return result;
  }
  return universeOk({
    ...result.value,
    registry: withMarket(registry, result.value.projection),
  });
}

/**
 * Records a non-terminal observed outcome state (see `lifecycle.ts`).
 *
 * At base `recordMarketOutcomeState(registry, id, {})` recorded `DISPUTED` in
 * BOTH pollution variants — the one settlement state §9.3 lets an operator
 * assert, asserted by nobody.
 */
export function recordMarketOutcomeState(
  registry: UniverseRegistry,
  internalMarketId: string,
  input: ObservedOutcomeStateInput,
): UniverseResult<MarketEventApplied> {
  const market = requireMarket(registry, internalMarketId);
  if (!market.ok) {
    return market;
  }
  const opened = openObservedOutcomeStateInput(input);
  if (!opened.ok) {
    return universeFailure(invalid("observed outcome state", opened.issues));
  }
  const result = recordObservedOutcomeState(
    market.value,
    opened.value as unknown as ObservedOutcomeStateInput,
  );
  if (!result.ok) {
    return result;
  }
  return universeOk({
    ...result.value,
    registry: withMarket(registry, result.value.projection),
  });
}
