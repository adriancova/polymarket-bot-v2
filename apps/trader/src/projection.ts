/**
 * The scalar feature projection — `WP-220` composition-root obligation 2.
 *
 * > "The engine's executable-price features are **structured** and the SDK's
 * > view is **flat**, so **projecting them onto scalar keys is the root's job**;
 * > this package refuses to guess the projection."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * `packages/features` computes a `FeatureSnapshot` whose entries carry
 * `FeatureData` — a string, a number, a boolean, an array or a record.
 * `packages/strategy-sdk`'s `FeatureSnapshot.values` is
 * `Record<string, DecimalString | string | boolean | null>`. This module is the
 * one place the first becomes the second, and the `@`-selector the strategy's
 * key grammar declares is the coordinate it reads.
 *
 * ## The convention, version `polymarket-bot/trader/feature-projection/v1`
 *
 * A configured key is `featureId` or `featureId "@" selector` (the strategy's
 * `parseFeatureKey` grammar, `selector := [A-Za-z0-9_.:+-]{1,32}`). Given the
 * computed snapshot, each requested key projects by exactly one rule:
 *
 * | # | Feature | Selector | Projection |
 * | --- | --- | --- | --- |
 * | R1 | any | absent | the value itself when it is a `string` or `boolean`; a NUMBER is refused (§6 invariant 1: no binary float for economics) |
 * | R2 | `polymarket.executable_buy_price` / `polymarket.executable_sell_price` | a decimal quantity | the entry whose `requestedShares` equals it EXACTLY: `volumeWeightedAveragePrice` for `QUOTE`, `null` for `INSUFFICIENT_DEPTH` |
 * | R3 | `quality.active_incidents` | `any` | `true` iff the incident list is non-empty |
 * | R4 | a record-valued feature | a member name | that member when it is a `string` or `boolean` |
 * | R5 | anything else | — | **not projected**, and the reason is recorded |
 *
 * An `ABSENT` entry projects `null` under every rule, because `null` is what
 * the SDK view uses for "the engine reported this feature as absent" and the
 * strategy's `readFeatureScalar` reads it as the data condition `ABSENT` rather
 * than as a wiring fault.
 *
 * ## Why R5 refuses instead of guessing
 *
 * A key that does not project is NOT written into `values`, so the strategy's
 * own `readFeatureScalar` answers `UNUSABLE` — a stated wiring fault — instead
 * of reading a value this module invented. The alternative (project `null`)
 * would make an unusable wiring indistinguishable from a genuinely absent
 * feature, and the strategy treats those two differently on purpose: an
 * `ABSENT` incident flag "counts as an incident, never as an all-clear", while
 * an `UNUSABLE` one is a configuration the operator must fix.
 *
 * ## Why numbers are refused (R1)
 *
 * `FeatureData` admits `number`, and some v1 features legitimately carry one
 * (`levelsConsumed`, `bidLevelCount`). None of them is economic, and none is a
 * trigger this strategy reads. Projecting a `number` onto a key the strategy
 * will compare against a decimal string is exactly §6 invariant 1's failure
 * mode, so this module refuses by name and records it.
 *
 * PURE. No clock, no I/O, no randomness. Every read is own-property only:
 * `packages/features` builds its outcome records prototype-free, but the
 * snapshot travels through this module as ordinary data and a projection that
 * adopted a value from `Object.prototype` would put an invented price in front
 * of a trigger.
 */

import type { FeatureSnapshot as EngineFeatureSnapshot } from "@polymarket-bot/features";
import type { FeatureSnapshot as StrategyFeatureSnapshot } from "@polymarket-bot/strategy-sdk";

export const FEATURE_PROJECTION_VERSION = "polymarket-bot/trader/feature-projection/v1";

/** The two structured executable-price features (`features-v1.md` §7). */
export const EXECUTABLE_PRICE_FEATURE_IDS: readonly string[] = Object.freeze([
  "polymarket.executable_buy_price",
  "polymarket.executable_sell_price",
]);

/** The incident feature the strategy's data-quality gate reads. */
export const INCIDENT_FEATURE_ID = "quality.active_incidents";

/** The selector `quality.active_incidents` accepts. Nothing else is defined. */
export const INCIDENT_ANY_SELECTOR = "any";

export type ScalarFeatureValue = string | boolean | null;

/** One key that did NOT project, and exactly why. */
export interface ProjectionRefusal {
  readonly key: string;
  readonly featureId: string;
  readonly selector: string | null;
  readonly reason:
    /** No entry in the snapshot carries this feature id. */
    | "FEATURE_NOT_IN_SNAPSHOT"
    /** R2: the configured quantity is not one the engine was asked to compute. */
    | "EXECUTABLE_QUANTITY_NOT_COMPUTED"
    /** R3: a selector other than `any` on the incident feature. */
    | "INCIDENT_SELECTOR_UNDEFINED"
    /** R4: the selector names no member of the record-valued feature. */
    | "SELECTOR_NAMES_NO_MEMBER"
    /** R1/R4: the value is a number, an array or a record — not a scalar. */
    | "VALUE_NOT_SCALAR"
    /** A selector was supplied for a feature whose projection defines none. */
    | "SELECTOR_NOT_APPLICABLE";
  readonly detail: string;
}

export interface ProjectionResult {
  /** The flat map a `StrategyContext.features()` view carries. */
  readonly values: Readonly<Record<string, ScalarFeatureValue>>;
  /** Every requested key that did not project, in request order. */
  readonly refusals: readonly ProjectionRefusal[];
}

function ownValue(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** Splits a configured key at the strategy's declared `@` separator. */
export function splitFeatureKey(key: string): {
  readonly featureId: string;
  readonly selector: string | null;
} {
  const at = key.indexOf("@");
  return at < 0
    ? { featureId: key, selector: null }
    : { featureId: key.slice(0, at), selector: key.slice(at + 1) };
}

function refusal(
  key: string,
  featureId: string,
  selector: string | null,
  reason: ProjectionRefusal["reason"],
  detail: string,
): ProjectionRefusal {
  return Object.freeze({ key, featureId, selector, reason, detail });
}

/**
 * Projects one engine snapshot onto the exact scalar keys a configuration
 * names.
 *
 * `keys` is the set of keys the loaded strategy instances configured; nothing
 * else is projected, so the view a strategy sees is the smallest one that can
 * answer its own configuration. That is deliberate: a view carrying every
 * feature would make an accidental read of an unconfigured key succeed.
 */
export function projectFeatureValues(
  snapshot: EngineFeatureSnapshot,
  keys: readonly string[],
): ProjectionResult {
  const values: Record<string, ScalarFeatureValue> = Object.create(null) as Record<
    string,
    ScalarFeatureValue
  >;
  const refusals: ProjectionRefusal[] = [];
  const byId = new Map(snapshot.features.map((entry) => [entry.id, entry]));

  for (const key of keys) {
    const { featureId, selector } = splitFeatureKey(key);
    const entry = byId.get(featureId);
    if (entry === undefined) {
      refusals.push(
        refusal(
          key,
          featureId,
          selector,
          "FEATURE_NOT_IN_SNAPSHOT",
          `the computed snapshot carries no feature "${featureId}"`,
        ),
      );
      continue;
    }
    if (entry.status === "ABSENT") {
      // The engine's own answer, carried straight through: `null` is the SDK
      // view's word for "absent", and the strategy reads it as a data
      // condition rather than as a wiring fault.
      values[key] = null;
      continue;
    }
    const value = entry.value;

    // R3 — the incident flag.
    if (featureId === INCIDENT_FEATURE_ID) {
      if (selector !== INCIDENT_ANY_SELECTOR) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "INCIDENT_SELECTOR_UNDEFINED",
            `the only defined selector for ${INCIDENT_FEATURE_ID} is ` +
              `"${INCIDENT_ANY_SELECTOR}" (true iff any incident is active); ` +
              `"${selector ?? "<absent>"}" has no projection and is refused rather than guessed`,
          ),
        );
        continue;
      }
      if (!Array.isArray(value)) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "VALUE_NOT_SCALAR",
            `${INCIDENT_FEATURE_ID} is expected to carry a list of active incidents`,
          ),
        );
        continue;
      }
      values[key] = value.length > 0;
      continue;
    }

    // R2 — the executable-price band, selected by exact quantity.
    if (EXECUTABLE_PRICE_FEATURE_IDS.includes(featureId)) {
      if (selector === null) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "SELECTOR_NOT_APPLICABLE",
            `${featureId} is computed per configured quantity, so a key naming it must ` +
              'carry the quantity as an "@" selector (for example ' +
              `"${featureId}@50")`,
          ),
        );
        continue;
      }
      if (!Array.isArray(value)) {
        refusals.push(
          refusal(key, featureId, selector, "VALUE_NOT_SCALAR", `${featureId} is not a list`),
        );
        continue;
      }
      const quote = value.find(
        (member) => ownValue(member, "requestedShares") === selector,
      );
      if (quote === undefined) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "EXECUTABLE_QUANTITY_NOT_COMPUTED",
            `no executable price was computed for quantity "${selector}"; the engine ` +
              "computes exactly the quantities its config names, so the fix is the feature " +
              "configuration, never a substituted quantity",
          ),
        );
        continue;
      }
      const outcome = ownValue(quote, "outcome");
      if (outcome === "INSUFFICIENT_DEPTH") {
        // A real data condition, not a wiring fault: the book could not fill the
        // configured quantity. `null` is the SDK view's word for it.
        values[key] = null;
        continue;
      }
      const price = ownValue(quote, "volumeWeightedAveragePrice");
      if (typeof price !== "string") {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "VALUE_NOT_SCALAR",
            `the executable price for quantity "${selector}" is not a decimal string`,
          ),
        );
        continue;
      }
      values[key] = price;
      continue;
    }

    // R4 — a member of a record-valued feature.
    if (selector !== null) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "SELECTOR_NOT_APPLICABLE",
            `${featureId} does not carry a record, so the selector "${selector}" names nothing`,
          ),
        );
        continue;
      }
      const member = ownValue(value, selector);
      if (member === undefined) {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "SELECTOR_NAMES_NO_MEMBER",
            `${featureId} has no member "${selector}"`,
          ),
        );
        continue;
      }
      if (typeof member !== "string" && typeof member !== "boolean") {
        refusals.push(
          refusal(
            key,
            featureId,
            selector,
            "VALUE_NOT_SCALAR",
            `${featureId}.${selector} is a ${typeof member}; only a string or a boolean ` +
              "projects onto the SDK's flat view (§6 invariant 1 forbids a number for economics)",
          ),
        );
        continue;
      }
      values[key] = member;
      continue;
    }

    // R1 — a scalar feature read directly.
    if (typeof value === "string" || typeof value === "boolean") {
      values[key] = value;
      continue;
    }
    refusals.push(
      refusal(
        key,
        featureId,
        selector,
        "VALUE_NOT_SCALAR",
        `${featureId} carries a ${Array.isArray(value) ? "list" : typeof value}, which has no ` +
          "scalar projection without a selector",
      ),
    );
  }

  return Object.freeze({
    // A prototype-free container, frozen: the strategy runtime materializes
    // whatever it is handed, but the value that reaches it should not be able
    // to answer a key from `Object.prototype` on the way.
    values: Object.freeze(values),
    refusals: Object.freeze(refusals),
  });
}

/**
 * Builds the SDK `FeatureSnapshot` view from a computed engine snapshot.
 *
 * `snapshotRef` is the engine's own content address, so §6 invariant 4's chain
 * (`decision → feature snapshot`) names a snapshot whose bytes exist and can be
 * re-derived (`verifySnapshotSerialization`). `asOf` is already strict UTC when
 * the loop normalised the event that produced it.
 */
export function buildStrategyFeatureView(input: {
  readonly snapshotRef: string;
  readonly asOf: string;
  readonly values: Readonly<Record<string, ScalarFeatureValue>>;
}): StrategyFeatureSnapshot {
  return Object.freeze({
    snapshotRef: input.snapshotRef,
    asOf: input.asOf,
    values: input.values,
  });
}
