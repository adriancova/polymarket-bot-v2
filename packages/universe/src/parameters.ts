/**
 * Versioned market parameters — handoff §6 invariant 9, §9.2, §10.1.
 *
 * Invariant 9 is unconditional: "Market rules, settlement specs, fee schedules,
 * tick sizes, minimum sizes, and delays are versioned. Historical runs use
 * historical parameters." §9.2 restates it as a Universe Service duty ("Version
 * market parameters on every change") and the work plan makes it an acceptance
 * criterion: "Parameter changes create immutable history."
 *
 * HOW THAT IS ENFORCED HERE:
 *
 * 1. There is no mutating operation. {@link appendParameterVersion} returns a
 *    NEW history; the one it was given is unchanged and keeps object identity
 *    for every version it already held.
 * 2. Every version object, its parameter snapshot, its `changedParameters`
 *    array, and the history's `versions` array are frozen, so a caller that
 *    tries to edit recorded history gets a `TypeError` under ES modules' strict
 *    mode instead of silently rewriting the past.
 * 3. A version is never overwritten and never renumbered: versions are
 *    append-only and strictly ascending, mirroring WP-040's
 *    `enforce_append_only('catalog', 'market_parameter_history')`.
 * 4. A no-op change is REFUSED rather than recorded, so the version counter
 *    means "the parameters differ from the previous version" and a consumer can
 *    compare versions to decide whether to re-price
 *    (`docs/contracts/domain.md` §6.4: "an event that changed nothing is not a
 *    change event").
 *
 * The snapshot fields are exactly the §9.2 list plus `status` from §10.1's
 * `market_parameter_history` ("Tick, minimum size, delay, `negRisk`, fees,
 * status"), which is the same vocabulary the frozen
 * `TradingParameterKindSchema` names — so `changedParameters` on the emitted
 * event is a subset of the frozen enum by construction.
 *
 * The fee schedule is referenced, not embodied: its shape is a volatile venue
 * fact (§1.2) that `docs/contracts/domain.md` §6.4 deliberately leaves to the
 * catalog, so this snapshot carries the opaque handle of the
 * `catalog.fee_schedule_snapshots` row.
 *
 * AND EVERY SNAPSHOT THIS MODULE COMPARES OR STORES IS OWN DATA
 * (`./parameters-door.ts`, `UNIV-3`). `UNIV-2`'s review measured that the
 * comparison below read `previous[field]` / `next[field]` on `zod`'s ordinary
 * `Object.prototype`-bearing output, so an absent optional was answered by the
 * prototype: three categories nobody observed entered an IMMUTABLE recorded
 * version, a real change was answered `UNIVERSE_PARAMETERS_UNCHANGED`, and the
 * emitted §7.4 payload lost a category that really changed. The door re-states
 * the frozen schema on its own reads — so an inherited `skipChecks`, which
 * admitted `tickSize:"-9"` into a recorded version at base, no longer does —
 * and emits the snapshot prototype-free, which is what closes the comparison.
 * The documented `UniverseValidationError` throw contract is unchanged: the
 * re-statement raises exactly that error, with the same issue rendering.
 */

import { equalsDecimal } from "@polymarket-bot/decimal";
import {
  EventSourceSchema,
  InternalMarketIdSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveDecimalStringSchema,
  type ConditionId,
  type EventSource,
  type InternalMarketId,
  type IsoTimestamp,
  type TradingParameterKind,
  type TradingParametersChangedPayload,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { ownRecord } from "./caller-door.js";
import {
  UniverseValidationError,
  universeFailure,
  universeOk,
  universeRefusal,
  type UniverseResult,
} from "./errors.js";
import { MarketLifecycleStateSchema } from "./lifecycle-state.js";
import { ownSnapshotField, restateObservation } from "./parameters-door.js";
import { instantMilliseconds, isSameInstant } from "./time.js";

/** One versioned snapshot of a market's trading parameters (§9.2, §10.1). */
export const MarketParametersSchema = z
  .strictObject({
    tickSize: PositiveDecimalStringSchema,
    minimumOrderSize: PositiveDecimalStringSchema,
    negRisk: z.boolean(),
    tradingDelaySeconds: NonNegativeIntegerSchema,
    /**
     * Opaque handle to the `catalog.fee_schedule_snapshots` row in force.
     *
     * Not the fee values: their shape is a volatile venue fact and the
     * USDC/pUSD denomination question is an OPEN venue conflict (C-2,
     * `docs/contracts/protected-contracts.md` §8). A handle records which
     * schedule applied without asserting what it said.
     */
    feeScheduleRef: NonEmptyStringSchema.optional(),
    /** Scheduled open. A parameter, not the observation that it opened. */
    openTime: IsoTimestampSchema.optional(),
    /** Scheduled close. A parameter, and reschedulable. */
    closeTime: IsoTimestampSchema.optional(),
    /** §10.1 `market_parameter_history.status`. */
    status: MarketLifecycleStateSchema,
  })
  .superRefine((parameters, ctx) => {
    const { openTime, closeTime } = parameters;
    if (openTime === undefined || closeTime === undefined) {
      return;
    }
    const open = instantMilliseconds(openTime);
    const close = instantMilliseconds(closeTime);
    if (open !== undefined && close !== undefined && close <= open) {
      ctx.addIssue({
        code: "custom",
        path: ["closeTime"],
        message: "the scheduled close must be after the scheduled open",
      });
    }
  });

export type MarketParameters = z.infer<typeof MarketParametersSchema>;

/** How a parameter observation reached us, for provenance. */
export const ParameterObservationSchema = z.strictObject({
  parameters: MarketParametersSchema,
  observedAt: IsoTimestampSchema,
  source: EventSourceSchema,
});
export type ParameterObservation = z.infer<typeof ParameterObservationSchema>;

/** One immutable entry in a market's parameter history. */
export interface MarketParameterVersion {
  readonly parametersVersion: number;
  readonly previousParametersVersion?: number;
  /** Which categories changed. Empty is impossible: a no-op is refused. */
  readonly changedParameters: readonly TradingParameterKind[];
  readonly parameters: MarketParameters;
  readonly observedAt: IsoTimestamp;
  readonly source: EventSource;
  /**
   * The opaque handle `TradingParametersChanged.parameterVersionRef` carries.
   *
   * `docs/contracts/domain.md` §6.4 leaves the addressing scheme to the catalog
   * layer, so this is it: `<internalMarketId>/v<parametersVersion>`. It is an
   * ADDRESS, not a hash — it identifies the version, and the version's contents
   * are immutable by construction rather than by digest.
   */
  readonly parameterVersionRef: string;
}

/** A market's append-only parameter history, ascending by version. */
export interface MarketParameterHistory {
  readonly internalMarketId: InternalMarketId;
  readonly versions: readonly MarketParameterVersion[];
}

/** Every parameter category, in the frozen `TradingParameterKind` order. */
const PARAMETER_FIELDS = [
  ["tickSize", "tick_size"],
  ["minimumOrderSize", "minimum_order_size"],
  ["feeScheduleRef", "fee_schedule"],
  ["tradingDelaySeconds", "trading_delay"],
  ["negRisk", "neg_risk"],
  ["openTime", "open_time"],
  ["closeTime", "close_time"],
  ["status", "status"],
] as const satisfies readonly (readonly [keyof MarketParameters, TradingParameterKind])[];

function fieldChanged(
  field: keyof MarketParameters,
  previous: MarketParameters,
  next: MarketParameters,
): boolean {
  // OWN reads (`UNIV-2` r1 MED-1). This is the row: `next` used to be `zod`'s
  // ordinary output, so "does the new snapshot carry an `openTime`?" was
  // answered by `Object.prototype`, and the answer decided what
  // `changedParameters` recorded, what the §7.4 payload announced, and whether
  // the whole change was refused as a no-op.
  const before = ownSnapshotField(previous, field);
  const after = ownSnapshotField(next, field);
  if (before === undefined || after === undefined) {
    return before !== after;
  }
  if (field === "tickSize" || field === "minimumOrderSize") {
    // Exact decimal comparison: never `Number()`, and never string identity,
    // which would call a re-spelled value a change.
    return !equalsDecimal(before as string, after as string);
  }
  if (field === "openTime" || field === "closeTime") {
    return !isSameInstant(before as string, after as string);
  }
  return before !== after;
}

/** The categories in which two snapshots differ, in the frozen enum's order. */
export function changedParameterKinds(
  previous: MarketParameters,
  next: MarketParameters,
): readonly TradingParameterKind[] {
  const changed: TradingParameterKind[] = [];
  for (const [field, kind] of PARAMETER_FIELDS) {
    if (fieldChanged(field, previous, next)) {
      changed.push(kind);
    }
  }
  return Object.freeze(changed);
}

/** The categories a first version establishes: every field it actually carries. */
function establishedParameterKinds(
  parameters: MarketParameters,
): readonly TradingParameterKind[] {
  const established: TradingParameterKind[] = [];
  for (const [field, kind] of PARAMETER_FIELDS) {
    // OWN, for the same reason the comparison is: at base an inherited
    // `openTime`/`closeTime`/`feeScheduleRef` put three categories nobody
    // observed into version 1's immutable `changedParameters`.
    if (ownSnapshotField(parameters, field) !== undefined) {
      established.push(kind);
    }
  }
  return Object.freeze(established);
}

function parameterVersionRef(
  internalMarketId: InternalMarketId,
  parametersVersion: number,
): string {
  return `${internalMarketId}/v${String(parametersVersion)}`;
}

/**
 * D4. One recorded version, emitted prototype-free and frozen.
 *
 * A version is read by someone else's `version.previousParametersVersion ===
 * undefined` (`apps/data-gateway/src/directory.ts` does exactly that), and an
 * ordinary object answers that question from `Object.prototype`. `ownRecord`
 * preserves the literal's key order, so the recorded JSON does not move.
 */
function freezeVersion(version: MarketParameterVersion): MarketParameterVersion {
  Object.freeze(version.changedParameters);
  return ownRecord<MarketParameterVersion>(version as unknown as Record<string, unknown>);
}

/** D4 for the history record; its `versions` list stays a frozen array. */
function freezeHistory(history: MarketParameterHistory): MarketParameterHistory {
  Object.freeze(history.versions);
  return ownRecord<MarketParameterHistory>(history as unknown as Record<string, unknown>);
}

/**
 * Judges an observation and reads it as OWN data.
 *
 * Two steps, in this order and for the reason every door in this package gives:
 * the frozen schema judges FIRST, so an honest-but-wrong observation keeps its
 * own message byte for byte, and `./parameters-door.ts` then re-states the same
 * declarations on its own reads — which is what survives an inherited
 * `skipChecks` (`UNIV-2` r1 MED-2: `tickSize:"-9"` recorded at base). Both
 * failures raise the SAME documented `UniverseValidationError`, so no caller
 * sees a new verdict class.
 *
 * @throws {UniverseValidationError} when the observation is not valid.
 */
function parseObservation(value: unknown): ParameterObservation {
  const result = ParameterObservationSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join(".");
      return `${path === "" ? "(root)" : path}: ${issue.message}`;
    });
    throw new UniverseValidationError(
      `market parameter observation is invalid: ${issues.join("; ")}`,
      issues,
    );
  }
  const read = restateObservation(value);
  if (!read.ok) {
    throw new UniverseValidationError(
      `market parameter observation is invalid: ${read.issues.join("; ")}`,
      read.issues,
    );
  }
  // D3: the stored values come from the own read, never from `result.data`.
  return read.value as unknown as ParameterObservation;
}

/**
 * Starts a market's parameter history at version 1.
 *
 * @throws {UniverseValidationError} when the observation is not valid.
 */
export function createParameterHistory(
  internalMarketId: InternalMarketId,
  observation: ParameterObservation,
): MarketParameterHistory {
  const id = InternalMarketIdSchema.parse(internalMarketId);
  const parsed = parseObservation(observation);
  const version = freezeVersion({
    parametersVersion: 1,
    changedParameters: establishedParameterKinds(parsed.parameters),
    parameters: parsed.parameters,
    observedAt: parsed.observedAt,
    source: parsed.source,
    parameterVersionRef: parameterVersionRef(id, 1),
  });
  return freezeHistory({ internalMarketId: id, versions: [version] });
}

/** The most recent version. A history always has at least one. */
export function currentParameterVersion(
  history: MarketParameterHistory,
): MarketParameterVersion {
  const version = history.versions[history.versions.length - 1];
  /* c8 ignore next 5 -- unreachable: a history is only ever built with one version. */
  if (version === undefined) {
    throw new UniverseValidationError("parameter history is empty", [
      "versions: must contain at least one version",
    ]);
  }
  return version;
}

/** What appending produced: the new history, the new version, and the event to emit. */
export interface ParameterVersionAppended {
  readonly history: MarketParameterHistory;
  readonly version: MarketParameterVersion;
  /**
   * The §7.4 `TradingParametersChanged` payload describing this change.
   *
   * Built here because this package holds the authoritative version numbers and
   * the change set. The ENVELOPE (event id, gateway epoch, ingest sequence) is
   * assigned by the process that publishes it: minting one would require a
   * clock and randomness, which this package does not have (§6 invariant 2).
   */
  readonly event: TradingParametersChangedPayload;
}

/**
 * Appends a new parameter version.
 *
 * Refuses a snapshot identical to the current one and a snapshot observed
 * before the version it would follow: both would corrupt `parametersAsOf`,
 * which is what "historical runs use historical parameters" depends on.
 *
 * @throws {UniverseValidationError} when the observation is not valid.
 */
export function appendParameterVersion(
  history: MarketParameterHistory,
  observation: ParameterObservation,
  /** The market's venue condition id, which the emitted event must carry. */
  conditionId: ConditionId,
): UniverseResult<ParameterVersionAppended> {
  const parsed = parseObservation(observation);
  const current = currentParameterVersion(history);
  const changed = changedParameterKinds(current.parameters, parsed.parameters);

  if (changed.length === 0) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_PARAMETERS_UNCHANGED",
        "the proposed parameters are identical to the current version; a change that changes nothing is not a version",
        {
          internalMarketId: history.internalMarketId,
          parametersVersion: current.parametersVersion,
        },
      ),
    );
  }

  const previousMs = instantMilliseconds(current.observedAt);
  const nextMs = instantMilliseconds(parsed.observedAt);
  if (previousMs !== undefined && nextMs !== undefined && nextMs < previousMs) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_PARAMETER_HISTORY_OUT_OF_ORDER",
        "the proposed parameters were observed before the version they would follow",
        {
          internalMarketId: history.internalMarketId,
          currentObservedAt: current.observedAt,
          proposedObservedAt: parsed.observedAt,
        },
      ),
    );
  }

  const parametersVersion = current.parametersVersion + 1;
  const version = freezeVersion({
    parametersVersion,
    previousParametersVersion: current.parametersVersion,
    changedParameters: changed,
    parameters: parsed.parameters,
    observedAt: parsed.observedAt,
    source: parsed.source,
    parameterVersionRef: parameterVersionRef(history.internalMarketId, parametersVersion),
  });

  return universeOk({
    // A NEW history: the previous one still holds exactly the versions it did,
    // and every one of them is the same frozen object.
    history: freezeHistory({
      internalMarketId: history.internalMarketId,
      versions: [...history.versions, version],
    }),
    version,
    // D4: the §7.4 payload this package emits is prototype-free, so a
    // consumer's `event.tickSize === undefined` — the frozen schema makes both
    // economic fields optional — cannot be answered by `Object.prototype`.
    // `ownRecord` preserves the literal's key order, so the published bytes do
    // not move.
    event: ownRecord<TradingParametersChangedPayload>({
      internalMarketId: history.internalMarketId,
      conditionId,
      parametersVersion,
      previousParametersVersion: current.parametersVersion,
      parameterVersionRef: version.parameterVersionRef,
      changedParameters: changed,
      tickSize: parsed.parameters.tickSize,
      minimumOrderSize: parsed.parameters.minimumOrderSize,
    }),
  });
}

/**
 * The parameter version in force at an instant, or `undefined` when the market
 * had no recorded parameters yet.
 *
 * This is what §6 invariant 9's "historical runs use historical parameters"
 * means operationally: a replay asks the history what applied THEN, rather than
 * reading whatever applies now.
 */
export function parametersAsOf(
  history: MarketParameterHistory,
  asOf: IsoTimestamp,
): MarketParameterVersion | undefined {
  const asOfMs = instantMilliseconds(asOf);
  if (asOfMs === undefined) {
    return undefined;
  }
  let found: MarketParameterVersion | undefined;
  for (const version of history.versions) {
    const observedMs = instantMilliseconds(version.observedAt);
    if (observedMs === undefined || observedMs > asOfMs) {
      continue;
    }
    found = version;
  }
  return found;
}

/** A version by number, or `undefined`. */
export function parameterVersion(
  history: MarketParameterHistory,
  parametersVersion: number,
): MarketParameterVersion | undefined {
  return history.versions.find(
    (version) => version.parametersVersion === parametersVersion,
  );
}
