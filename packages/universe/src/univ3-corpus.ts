/**
 * UNIV-3's honest-input corpus and its two digests.
 *
 * `docs/handoffs/UNIV-1.md` and `UNIV-2.md` both pinned an honest-input digest
 * across their door rounds; this module is the state-side equivalent, and it
 * exists as a module rather than inside one `.test.ts` so the SAME corpus can be
 * run against the same code by any suite that needs it.
 *
 * TWO DIGESTS, because they answer two different questions.
 *
 * - {@link corpusValueDigest} — what the package ANSWERS. Values, in own-key
 *   order, with `Map`s expanded in insertion order. This digest may not move
 *   between the base and the tip of a hardening round: a door that changes an
 *   honest answer is not a door, it is a behaviour change.
 * - {@link corpusShapeDigest} — HOW the answer is represented: prototype
 *   identity, frozen-ness, and every own property descriptor flag. This digest
 *   IS allowed to move, and every difference must be a disclosed class (D4
 *   null-prototype emission, a newly frozen list), which is exactly why it is
 *   measured separately.
 *
 * Nothing here reads a clock or a random source: every instant and identifier
 * is a fixed literal, so both digests are reproducible.
 */

import { createHash } from "node:crypto";

import { marketLifecycleInputFromEnvelope } from "./envelope.js";
import { currentTradingParameters, evaluateMarketReadiness } from "./eligibility.js";
import {
  applyMarketLifecycleEvent,
  clarificationsAfterOpen,
  effectiveCloseInstant,
  effectiveLifecycleState,
  recordObservedOutcomeState,
  type MarketProjection,
} from "./lifecycle.js";
import {
  appendParameterVersion,
  changedParameterKinds,
  createParameterHistory,
  currentParameterVersion,
  parameterVersion,
  parametersAsOf,
  type MarketParameters,
  type ParameterObservation,
} from "./parameters.js";
import {
  applyMarketEvent,
  approveSeries,
  bindMarketToSeries,
  createUniverseRegistry,
  findMarketByConditionId,
  findMarketByTokenId,
  recordMarketOutcomeState,
  recordMarketParameters,
  recordSeriesSuggestion,
  registerMarket,
  registerSeries,
  suggestSeriesForMarket,
} from "./registry.js";
import {
  SAMPLE_MARKET_ID,
  SAMPLE_SERIES_ID,
  marketIdentitySample,
  parameterObservationSample,
  permittingSettlementView,
  seriesDefinitionSample,
} from "./testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;
const EPOCH = "01936f00-0000-7000-8000-0000000e0001";
const REF = { internalMarketId: SAMPLE_MARKET_ID, conditionId: CONDITION_ID } as const;

function order(seq: string): { gatewayEpoch: string; ingestSeq: string } {
  return { gatewayEpoch: EPOCH, ingestSeq: seq };
}

/** One labelled answer the corpus records. */
export interface CorpusEntry {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Runs every honest operation this package exposes, in a fixed order.
 *
 * "Honest" means: no prototype pollution, no exotic shape, no hostile value —
 * exactly the inputs a composition root supplies. A hardening round must leave
 * every one of these answers untouched.
 */
export function runHonestCorpus(): readonly CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const record = (label: string, value: unknown): void => {
    entries.push({ label, value });
  };

  // --- series and market registration --------------------------------------
  const empty = createUniverseRegistry();
  record("createUniverseRegistry", empty);

  const withSeries = registerSeries(empty, seriesDefinitionSample());
  record("registerSeries", withSeries);
  if (!withSeries.ok) {
    return entries;
  }
  record(
    "registerSeries (idempotent re-registration)",
    registerSeries(withSeries.value, seriesDefinitionSample()),
  );

  const approved = approveSeries(withSeries.value, {
    seriesId: SAMPLE_SERIES_ID,
    approvedBy: "reviewer-1",
    approvedAt: "2026-08-28T10:00:00Z",
  });
  record("approveSeries", approved);
  if (!approved.ok) {
    return entries;
  }

  const registered = registerMarket(approved.value, {
    identity: marketIdentitySample(),
    parameters: parameterObservationSample(),
    metadataVersion: 3,
  });
  record("registerMarket", registered);
  if (!registered.ok) {
    return entries;
  }
  record(
    "registerMarket (idempotent re-registration)",
    registerMarket(registered.value.registry, {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
      metadataVersion: 3,
    }),
  );

  record("suggestSeriesForMarket", suggestSeriesForMarket(registered.value.registry, SAMPLE_MARKET_ID));
  record(
    "recordSeriesSuggestion",
    recordSeriesSuggestion(registered.value.registry, SAMPLE_MARKET_ID),
  );

  const bound = bindMarketToSeries(registered.value.registry, {
    internalMarketId: SAMPLE_MARKET_ID,
    seriesId: SAMPLE_SERIES_ID,
    approvedBy: "reviewer-2",
    approvedAt: "2026-08-28T10:30:00Z",
  });
  record("bindMarketToSeries", bound);
  if (!bound.ok) {
    return entries;
  }
  const registry = bound.value;
  record("findMarketByConditionId", findMarketByConditionId(registry, CONDITION_ID as never));
  record("findMarketByTokenId", findMarketByTokenId(registry, "1000000001" as never));

  // --- versioned parameters -------------------------------------------------
  const nextParameters: MarketParameters = {
    ...parameterObservationSample().parameters,
    tickSize: "0.02",
    closeTime: "2026-08-28T12:30:00Z",
  };
  const recorded = recordMarketParameters(registry, SAMPLE_MARKET_ID, {
    parameters: nextParameters,
    observedAt: "2026-08-28T12:01:00Z",
    source: "polymarket",
  } as ParameterObservation);
  record("recordMarketParameters", recorded);
  record(
    "recordMarketParameters (unchanged)",
    recordMarketParameters(registry, SAMPLE_MARKET_ID, parameterObservationSample()),
  );
  if (!recorded.ok) {
    return entries;
  }

  const history = createParameterHistory(SAMPLE_MARKET_ID as never, parameterObservationSample());
  record("createParameterHistory", history);
  record("currentParameterVersion", currentParameterVersion(history));
  record(
    "appendParameterVersion",
    appendParameterVersion(
      history,
      {
        parameters: nextParameters,
        observedAt: "2026-08-28T12:01:00Z",
        source: "polymarket",
      } as ParameterObservation,
      CONDITION_ID as never,
    ),
  );
  record("parametersAsOf (before)", parametersAsOf(history, "2026-08-28T10:00:00Z"));
  record("parametersAsOf (after)", parametersAsOf(history, "2026-08-28T13:00:00Z"));
  record("parameterVersion(1)", parameterVersion(history, 1));
  record("parameterVersion(9)", parameterVersion(history, 9));
  record(
    "changedParameterKinds",
    changedParameterKinds(parameterObservationSample().parameters, nextParameters),
  );

  // --- the eight fold arms, through the registry door ----------------------
  const folds: readonly (readonly [string, unknown, string])[] = [
    [
      "MarketDiscovered",
      { ...REF, yesTokenId: "1000000001", noTokenId: "1000000002", metadataVersion: 4 },
      "1",
    ],
    ["MarketMetadataChanged", { ...REF, metadataVersion: 5, previousMetadataVersion: 4, changedFields: ["title"] }, "2"],
    ["MarketRulesChanged", { ...REF, rulesVersionId: "rules-v1", changedFields: ["rules"] }, "3"],
    ["MarketOpened", { ...REF, openedAt: "2026-08-28T12:00:00Z" }, "4"],
    ["MarketClosing", { ...REF, closesAt: "2026-08-28T12:15:00Z" }, "5"],
    [
      "MarketClarificationObserved",
      { ...REF, clarificationId: "clarification-1", observedAt: "2026-08-28T12:05:00Z" },
      "6",
    ],
    [
      "TradingParametersChanged",
      {
        ...REF,
        parametersVersion: 1,
        parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
        changedParameters: ["tick_size"],
        tickSize: "0.01",
      },
      "7",
    ],
    [
      "MarketResolved",
      { ...REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:20:00Z", rulesVersionId: "rules-v1" },
      "8",
    ],
  ];
  let folded = registry;
  for (const [eventType, payload, seq] of folds) {
    const applied = applyMarketEvent(folded, SAMPLE_MARKET_ID, {
      eventType: eventType as never,
      payload,
      order: order(seq),
    });
    record(`applyMarketEvent ${eventType}`, applied);
    if (applied.ok) {
      folded = applied.value.registry;
    }
  }

  const projection = folded.markets.get(SAMPLE_MARKET_ID as never) as MarketProjection;
  record("projection after the eight folds", projection);
  record("effectiveLifecycleState", effectiveLifecycleState(projection, "2026-08-28T12:10:00Z"));
  record("effectiveCloseInstant", effectiveCloseInstant(projection));
  record("clarificationsAfterOpen", clarificationsAfterOpen(projection));
  record("currentTradingParameters", currentTradingParameters(projection));

  // --- the un-doored direct fold, and the observation path -----------------
  const openProjection = folded.markets.get(SAMPLE_MARKET_ID as never) as MarketProjection;
  record(
    "applyMarketLifecycleEvent (replayed)",
    applyMarketLifecycleEvent(openProjection, {
      eventType: "MarketOpened",
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
      order: order("4"),
    }),
  );
  const preResolution = registry.markets.get(SAMPLE_MARKET_ID as never) as MarketProjection;
  record(
    "recordObservedOutcomeState (DISPUTED)",
    recordObservedOutcomeState(preResolution, {
      outcomeState: "DISPUTED",
      observedAt: "2026-08-28T12:06:00Z",
      observedBy: "operator-1",
    }),
  );
  record(
    "recordMarketOutcomeState (DISPUTED)",
    recordMarketOutcomeState(registry, SAMPLE_MARKET_ID, {
      outcomeState: "DISPUTED",
      observedAt: "2026-08-28T12:06:00Z",
      observedBy: "operator-1",
    }),
  );
  record(
    "recordObservedOutcomeState (terminal refused)",
    recordObservedOutcomeState(preResolution, {
      outcomeState: "YES_WIN",
      observedAt: "2026-08-28T12:06:00Z",
      observedBy: "operator-1",
    }),
  );

  // --- readiness ------------------------------------------------------------
  const seriesForReadiness = folded.series.get(SAMPLE_SERIES_ID);
  record(
    "evaluateMarketReadiness",
    evaluateMarketReadiness(preResolution, {
      asOf: "2026-08-28T12:05:00Z",
      settlement: permittingSettlementView(),
      series: seriesForReadiness,
    }),
  );

  // --- the envelope adapter -------------------------------------------------
  record(
    "marketLifecycleInputFromEnvelope",
    marketLifecycleInputFromEnvelope({
      eventId: "01936f00-0000-7000-8000-0000000f0001",
      source: "polymarket",
      sourceChannel: "clob-ws",
      receivedAt: "2026-08-28T12:00:01Z",
      receivedMonotonicNs: "1000000000",
      gatewayEpoch: EPOCH,
      ingestSeq: "42",
      eventType: "MarketOpened",
      schemaVersion: 1,
      payload: { ...REF, openedAt: "2026-08-28T12:00:00Z" },
    }),
  );

  return entries;
}

// ---------------------------------------------------------------------------
// The two serializers
// ---------------------------------------------------------------------------

function serializeValue(value: unknown, depth = 0): string {
  if (depth > 24) {
    return "<deep>";
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint") {
    return `${kind[0] ?? "?"}:${String(value)}`;
  }
  if (kind === "function") {
    return "fn";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item, depth + 1)).join(",")}]`;
  }
  if (value instanceof Map) {
    return `Map{${[...value.entries()]
      .map(([key, entry]) => `${String(key)}=>${serializeValue(entry, depth + 1)}`)
      .join(",")}}`;
  }
  if (value instanceof Set) {
    return `Set{${[...value.values()].map((entry) => serializeValue(entry, depth + 1)).join(",")}}`;
  }
  const container = value as Record<string, unknown>;
  const keys = Object.keys(container);
  return `{${keys.map((key) => `${key}:${serializeValue(container[key], depth + 1)}`).join(",")}}`;
}

function prototypeName(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null) {
    return "null";
  }
  if (prototype === Object.prototype) {
    return "Object";
  }
  if (prototype === Array.prototype) {
    return "Array";
  }
  if (prototype === Map.prototype) {
    return "Map";
  }
  if (prototype === Set.prototype) {
    return "Set";
  }
  return "other";
}

function serializeShape(value: unknown, depth = 0): string {
  if (depth > 24) {
    return "<deep>";
  }
  if (value === null || typeof value !== "object") {
    return typeof value;
  }
  const container = value as object;
  const flags = `proto=${prototypeName(container)},frozen=${String(Object.isFrozen(container))},sealed=${String(Object.isSealed(container))},ext=${String(Object.isExtensible(container))}`;
  if (value instanceof Map) {
    return `Map[${flags}]{${[...value.entries()]
      .map(([key, entry]) => `${String(key)}=>${serializeShape(entry, depth + 1)}`)
      .join(",")}}`;
  }
  if (value instanceof Set) {
    return `Set[${flags}]{${[...value.values()].map((entry) => serializeShape(entry, depth + 1)).join(",")}}`;
  }
  const members: string[] = [];
  for (const key of Reflect.ownKeys(container)) {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined) {
      continue;
    }
    const shape = Object.hasOwn(descriptor, "value")
      ? serializeShape(descriptor.value, depth + 1)
      : "accessor";
    members.push(
      `${String(key)}<w=${String(descriptor.writable ?? false)},e=${String(descriptor.enumerable ?? false)},c=${String(descriptor.configurable ?? false)}>:${shape}`,
    );
  }
  return `[${flags}]{${members.join(",")}}`;
}

function digestOf(entries: readonly CorpusEntry[], render: (value: unknown) => string): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.label);
    hash.update(" ");
    hash.update(render(entry.value));
    hash.update("");
  }
  return hash.digest("hex");
}

/** What the package ANSWERS. Must not move across a hardening round. */
export function corpusValueDigest(entries: readonly CorpusEntry[]): string {
  return digestOf(entries, (value) => serializeValue(value));
}

/** HOW the answer is represented. May move only in disclosed classes. */
export function corpusShapeDigest(entries: readonly CorpusEntry[]): string {
  return digestOf(entries, (value) => serializeShape(value));
}
