/**
 * The engine: one call computes feature set v1 once for one event and returns
 * an immutable, content-addressed `FeatureSnapshot` (§9.5) — or a typed
 * refusal. TOTAL: this module never throws.
 *
 * ## Content addressing
 *
 * ```text
 * body (everything but contentAddress)
 *   → serializeCanonicalJson(body)                    (one value, one text)
 *   → "polymarket-bot/feature-snapshot/v1:" + text    (domain separation)
 *   → SHA-256 hex                                     (the content address)
 * ```
 *
 * The body embeds `inputs.inputsSha256` — the digest of the WHOLE validated
 * input tree — so two computations from different inputs can never share an
 * address even if every derived value coincides, and `inputs.bookSha256` —
 * the plain SHA-256 of the exact `serializeBook` text consumed — so the
 * addressed book state IS the parsed book state (WP-150 follow-up: no second
 * canonical serialization is invented; the order-book v1 text is the one
 * canonical form and it is addressed verbatim).
 *
 * ## Immutability
 *
 * The returned snapshot is a fresh, deeply frozen, PROTOTYPE-FREE tree built
 * one `defineProperty` at a time from values this module validated: no caller
 * mutation can reach it, no `Object.prototype` pollution can add a field to
 * it, and an absent field of it stays absent under every read (the WP-180
 * lessons, applied to the OUTPUT side).
 *
 * The §9.5 storage helpers below — {@link snapshotReference} and
 * {@link selectIndexedValues} — are emitted through the SAME
 * {@link ownFrozenTree} machinery, so the values a decision row is built from
 * carry the property the snapshot carries (`WP-160-FU1`, closing `WP-160`
 * R1-L3 / the `GOV-2A` schema-boundary row for this package).
 *
 * ## Storage guidance (§9.5)
 *
 * High-frequency snapshots may live in the event archive — `serialization` is
 * exactly the bytes to archive, and `verifySnapshotSerialization` re-derives
 * the address from them. Important action decisions store
 * {@link snapshotReference} (durable reference) plus
 * {@link selectIndexedValues} (the chosen indexed values) in PostgreSQL; the
 * storage itself belongs to later work packages.
 */

import { serializeCanonicalJson } from "./canonical-json.js";
import { sha256HexUtf8 } from "./hash.js";
import { computeLifecycleFeatures } from "./compute/lifecycle.js";
import { computePolymarketFeatures } from "./compute/polymarket.js";
import { computeReferenceFeatures } from "./compute/reference.js";
import { computeQualityFeatures } from "./compute/quality.js";
import type { ValidatedFeatureInput } from "./inputs.js";
import { validateFeatureInput } from "./inputs.js";
import { materializeInput } from "./materialize.js";
import type { FeatureCategory } from "./registry.js";
import { FEATURES_V1, FEATURE_SET_VERSION } from "./registry.js";
import type { FeatureRefusalResult } from "./refusals.js";
import { ownDataDescriptor, refuse } from "./refusals.js";
import type { AbsenceReason, ComputedFeature, FeatureData } from "./values.js";

/** The versioned snapshot serialization format. */
export const FEATURE_SNAPSHOT_FORMAT = "polymarket-bot/feature-snapshot/v1";

/** Domain-separation prefix mixed into every content address. */
export const CONTENT_ADDRESS_DOMAIN = `${FEATURE_SNAPSHOT_FORMAT}:`;

export interface FeatureEntry {
  readonly id: string;
  readonly version: number;
  readonly category: FeatureCategory;
  readonly status: "OK" | "ABSENT";
  readonly value?: FeatureData;
  readonly reason?: AbsenceReason;
  readonly detail?: string;
}

export interface FeatureSnapshotInputsSection {
  readonly inputsSha256: string;
  readonly bookSerializationVersion: string;
  readonly bookSha256: string;
  readonly bookGatewayEpoch: string;
  readonly bookSubscriptionGeneration: number;
  readonly bookLastIngestSeq: string;
  readonly bookVenueBookHash?: string;
  readonly tickSize?: string;
}

export interface FeatureSnapshot {
  readonly format: typeof FEATURE_SNAPSHOT_FORMAT;
  readonly featureSet: typeof FEATURE_SET_VERSION;
  readonly subject: { readonly internalMarketId: string; readonly tokenId: string };
  readonly asOf: string;
  readonly asOfEpochMs: number;
  readonly trigger: { readonly gatewayEpoch: string; readonly ingestSeq: string; readonly eventId?: string };
  readonly config: {
    readonly depthLevels: readonly number[];
    readonly executableShares: readonly string[];
    readonly tradeWindowMs: number;
    readonly ewmaLambda: string;
    readonly primaryReferenceVenue: "binance" | "coinbase";
  };
  readonly inputs: FeatureSnapshotInputsSection;
  readonly features: readonly FeatureEntry[];
  readonly contentAddress: string;
}

export interface FeatureSnapshotSuccess {
  readonly ok: true;
  readonly snapshot: FeatureSnapshot;
  /** The exact canonically serialized body bytes the address covers. */
  readonly serialization: string;
}

export type FeatureComputationResult = FeatureSnapshotSuccess | FeatureRefusalResult;

/** A durable reference for action decisions (§9.5). */
export interface FeatureSnapshotReference {
  readonly contentAddress: string;
  readonly format: string;
  readonly featureSet: string;
  readonly internalMarketId: string;
  readonly tokenId: string;
  readonly asOf: string;
  readonly triggerGatewayEpoch: string;
  readonly triggerIngestSeq: string;
}

/** One selected indexed value (§9.5: "selected indexed values"). */
export interface IndexedFeatureValue {
  readonly id: string;
  readonly version: number;
  readonly status: "OK" | "ABSENT";
  readonly value?: FeatureData;
  readonly reason?: AbsenceReason;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Computes feature set v1 for one event. Deterministic: the same input value
 * (by content) yields a byte-identical serialization and an identical
 * content address. Total: refuses, never throws.
 */
export function computeFeatureSnapshot(rawInput: unknown): FeatureComputationResult {
  try {
    return computeGuarded(rawInput);
  } catch (cause) {
    return refuse("FEATURES_INTERNAL", "feature computation failed unexpectedly and was contained (fail closed)", {
      cause: cause instanceof Error ? cause.message : "a non-Error was thrown",
    });
  }
}

function computeGuarded(rawInput: unknown): FeatureComputationResult {
  // 1. Materialize a prototype-free copy BEFORE any validation; everything
  //    downstream reads ONLY this tree (the recorded schema-risk remedy).
  const materialized = materializeInput(rawInput, "input");
  if (!materialized.ok) {
    const first = materialized.problems[0];
    return refuse("FEATURES_INPUT_NOT_DATA", "the input could not be read as plain data", {
      problemCount: materialized.problems.length,
      firstPath: first?.path,
      firstProblem: first?.problem,
    });
  }

  // 2. Validate the tree with hand-written total predicates (no schema library).
  const validated = validateFeatureInput(materialized.value);
  if (!validated.ok) {
    const first = validated.problems[0];
    const details = {
      problemCount: validated.problems.length,
      firstPath: first?.path,
      firstProblem: first?.problem,
    };
    switch (validated.kind) {
      case "TIMESTAMP":
        return refuse("FEATURES_TIMESTAMP_INVALID", "a timestamp violates the strict v1 UTC grammar", details);
      case "SUBJECT_MISMATCH":
        return refuse("FEATURES_SUBJECT_MISMATCH", "the serialized book does not belong to the subject", details);
      case "BOOK_UNSUPPORTED":
        return refuse("FEATURES_BOOK_SERIALIZATION_UNSUPPORTED", "the book serialization version is not supported", details);
      case "BOOK_MALFORMED":
        return refuse("FEATURES_BOOK_SERIALIZATION_MALFORMED", "the book serialization does not parse under the v1 grammar", details);
      case "BOOK_INCONSISTENT":
        return refuse("FEATURES_BOOK_SERIALIZATION_INCONSISTENT", "the book serialization contradicts itself", details);
      case "BOOK_NOT_BASELINED":
        return refuse("FEATURES_BOOK_NOT_BASELINED", "the book has no baseline snapshot (§7.1)", details);
      default:
        return refuse("FEATURES_INPUT_INVALID", "the input violates the v1 input contract", details);
    }
  }
  const input = validated.input;

  // 3. Compute every category once.
  const computed: ComputedFeature[] = [
    ...computePolymarketFeatures(input),
    ...computeReferenceFeatures(input),
    ...computeLifecycleFeatures(input),
    ...computeQualityFeatures(input),
  ];

  // 4. Bind the computation to the registry: the id sets must be EQUAL.
  //    (An own-`ok` discriminant, never `"ok" in …` — `in` answers for an
  //    INHERITED name, so `Object.prototype.ok` would have flipped a branch
  //    keyed on it.)
  const bound = bindToRegistry(computed);
  if (!bound.ok) {
    return bound;
  }
  const entries = bound.entries;

  // 5. Assemble the body, serialize canonically, address, freeze.
  const body = {
    format: FEATURE_SNAPSHOT_FORMAT,
    featureSet: FEATURE_SET_VERSION,
    subject: { internalMarketId: input.subject.internalMarketId, tokenId: input.subject.tokenId },
    asOf: input.asOf,
    asOfEpochMs: input.asOfEpochMs,
    trigger: {
      gatewayEpoch: input.trigger.gatewayEpoch,
      ingestSeq: input.trigger.ingestSeq,
      ...(input.trigger.eventId === undefined ? {} : { eventId: input.trigger.eventId }),
    },
    config: {
      depthLevels: input.config.depthLevels,
      executableShares: input.config.executableShares,
      tradeWindowMs: input.config.tradeWindowMs,
      ewmaLambda: input.config.ewmaLambda,
      primaryReferenceVenue: input.config.primaryReferenceVenue,
    },
    inputs: buildInputsSection(input),
    features: entries,
  };
  const serialization = serializeCanonicalJson(body);
  const contentAddress = sha256HexUtf8(CONTENT_ADDRESS_DOMAIN + serialization);
  const snapshot = ownFrozenTree({ ...body, contentAddress }) as FeatureSnapshot;
  return { ok: true, snapshot, serialization };
}

function bindToRegistry(
  computed: readonly ComputedFeature[],
): { readonly ok: true; readonly entries: readonly FeatureEntry[] } | FeatureRefusalResult {
  const byId = new Map<string, ComputedFeature>();
  for (const feature of computed) {
    if (byId.has(feature.id)) {
      return refuse("FEATURES_INTERNAL", "a feature id was computed twice; the computation is ambiguous", {
        featureId: feature.id,
      });
    }
    byId.set(feature.id, feature);
  }
  const entries: FeatureEntry[] = [];
  for (const definition of FEATURES_V1) {
    const feature = byId.get(definition.id);
    if (feature === undefined) {
      return refuse("FEATURES_INTERNAL", "a registered feature was not computed; the snapshot would be silently partial", {
        featureId: definition.id,
      });
    }
    byId.delete(definition.id);
    const outcome = feature.outcome;
    entries.push(
      outcome.status === "OK"
        ? {
            id: definition.id,
            version: definition.version,
            category: definition.category,
            status: "OK",
            value: outcome.value,
          }
        : {
            id: definition.id,
            version: definition.version,
            category: definition.category,
            status: "ABSENT",
            reason: outcome.reason,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          },
    );
  }
  if (byId.size > 0) {
    return refuse("FEATURES_INTERNAL", "a computed feature is not in the v1 registry; unregistered values must not ship", {
      featureIds: [...byId.keys()].join(", "),
    });
  }
  return { ok: true, entries };
}

function buildInputsSection(input: ValidatedFeatureInput): FeatureSnapshotInputsSection {
  const inputsSha256 = sha256HexUtf8(
    serializeCanonicalJson({
      subject: input.subject,
      asOf: input.asOf,
      trigger: {
        gatewayEpoch: input.trigger.gatewayEpoch,
        ingestSeq: input.trigger.ingestSeq,
        ...(input.trigger.eventId === undefined ? {} : { eventId: input.trigger.eventId }),
      },
      config: input.config,
      book: { serializedBook: input.book.serializedBook, lastEventAt: input.book.lastEventAt },
      ...(input.trades === undefined
        ? {}
        : {
            trades: {
              lastEventAt: input.trades.lastEventAt,
              window: input.trades.window.map((trade) => ({
                price: trade.price,
                size: trade.size,
                ...(trade.takerSide === undefined ? {} : { takerSide: trade.takerSide }),
                observedAt: trade.observedAt,
              })),
            },
          }),
      reference: serializeReferenceForDigest(input),
      ...(input.lifecycle === undefined
        ? {}
        : {
            lifecycle: {
              ...(input.lifecycle.openedAt === undefined ? {} : { openedAt: input.lifecycle.openedAt }),
              ...(input.lifecycle.closesAt === undefined ? {} : { closesAt: input.lifecycle.closesAt }),
              ...(input.lifecycle.referenceOpenPrice === undefined
                ? {}
                : { referenceOpenPrice: input.lifecycle.referenceOpenPrice }),
            },
          }),
      quality: {
        activeIncidents: input.quality.activeIncidents.map((incident) => ({
          incidentId: incident.incidentId,
          reasonCode: incident.reasonCode,
          severity: incident.severity,
          ...(incident.feedId === undefined ? {} : { feedId: incident.feedId }),
        })),
      },
    }),
  );
  const parsed = input.book.parsed;
  return {
    inputsSha256,
    bookSerializationVersion: input.book.serializedBook.split("\n", 1)[0] ?? "",
    bookSha256: sha256HexUtf8(input.book.serializedBook),
    bookGatewayEpoch: parsed.gatewayEpoch,
    bookSubscriptionGeneration: parsed.subscriptionGeneration,
    bookLastIngestSeq: parsed.lastIngestSeq,
    ...(parsed.venueBookHash === undefined ? {} : { bookVenueBookHash: parsed.venueBookHash }),
    ...(parsed.tickSize === undefined ? {} : { tickSize: parsed.tickSize }),
  };
}

function serializeReferenceForDigest(input: ValidatedFeatureInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const venue of ["binance", "coinbase"] as const) {
    const series = input.reference[venue];
    if (series === undefined) continue;
    out[venue] = {
      symbol: series.symbol,
      lastEventAt: series.lastEventAt,
      trades: series.trades.map((point) => ({ price: point.price, observedAt: point.observedAt })),
      ...(series.topOfBook === undefined
        ? {}
        : {
            topOfBook: {
              ...(series.topOfBook.bidPrice === undefined ? {} : { bidPrice: series.topOfBook.bidPrice }),
              ...(series.topOfBook.bidSize === undefined ? {} : { bidSize: series.topOfBook.bidSize }),
              ...(series.topOfBook.askPrice === undefined ? {} : { askPrice: series.topOfBook.askPrice }),
              ...(series.topOfBook.askSize === undefined ? {} : { askSize: series.topOfBook.askSize }),
            },
          }),
    };
  }
  if (input.reference.chainlink !== undefined) {
    out["chainlink"] = {
      lastEventAt: input.reference.chainlink.lastEventAt,
      twaps: input.reference.chainlink.twaps.map((twap) => ({
        feedId: twap.feedId,
        value: twap.value,
        windowSeconds: twap.windowSeconds,
        windowEndAt: twap.windowEndAt,
      })),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Immutable output tree
// ---------------------------------------------------------------------------

/**
 * A fresh, deeply frozen, prototype-free copy of a tree THIS MODULE built.
 * Records lose their prototype (absence stays absence for every consumer);
 * arrays stay arrays (frozen). Values are known-plain by construction.
 */
function ownFrozenTree(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((member) => ownFrozenTree(member)));
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) continue;
    Object.defineProperty(out, key, ownDataDescriptor(ownFrozenTree(member)));
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Storage helpers (§9.5)
// ---------------------------------------------------------------------------

/**
 * The durable reference an action decision stores alongside indexed values.
 *
 * Emitted through {@link ownFrozenTree}, the same machinery the snapshot
 * itself is built with: the reference is destined for the same PostgreSQL row
 * as the indexed values, and a prototype-bearing row object answers EVERY name
 * a writer asks it for — including names this contract does not declare.
 */
export function snapshotReference(snapshot: FeatureSnapshot): FeatureSnapshotReference {
  return ownFrozenTree({
    contentAddress: snapshot.contentAddress,
    format: snapshot.format,
    featureSet: snapshot.featureSet,
    internalMarketId: snapshot.subject.internalMarketId,
    tokenId: snapshot.subject.tokenId,
    asOf: snapshot.asOf,
    triggerGatewayEpoch: snapshot.trigger.gatewayEpoch,
    triggerIngestSeq: snapshot.trigger.ingestSeq,
  }) as FeatureSnapshotReference;
}

/**
 * The selected features, by id, for indexing next to a decision. An id absent
 * from the snapshot is reported with status `ABSENT` and reason
 * `INPUT_MISSING` is NOT fabricated — an unknown id is simply not returned,
 * and the caller can compare lengths; a snapshot always carries every
 * registered id, so an unknown id is a caller typo, not a data condition.
 *
 * Every member is emitted through {@link ownFrozenTree} — the SAME machinery
 * the snapshot itself is built with (`computeGuarded` step 5). Ordinary
 * literals were the `WP-160` R1-L3 defect that `GOV-2A` re-measured: an OK
 * member has no own `reason` and an ABSENT member has no own `value`, so with
 * a prototype a polluted `Object.prototype.reason` answered for BOTH returned
 * members and a polluted `Object.prototype.value` gave an ABSENT member a
 * value. These rows are indexed next to decisions in PostgreSQL, so a name
 * this contract leaves absent must read as absent for every consumer.
 */
export function selectIndexedValues(snapshot: FeatureSnapshot, ids: readonly string[]): readonly IndexedFeatureValue[] {
  const wanted = new Set(ids);
  const selected: IndexedFeatureValue[] = [];
  for (const entry of snapshot.features) {
    if (!wanted.has(entry.id)) continue;
    selected.push(
      entry.status === "OK"
        ? { id: entry.id, version: entry.version, status: "OK", ...(entry.value === undefined ? {} : { value: entry.value }) }
        : { id: entry.id, version: entry.version, status: "ABSENT", ...(entry.reason === undefined ? {} : { reason: entry.reason }) },
    );
  }
  return ownFrozenTree(selected) as readonly IndexedFeatureValue[];
}

/**
 * Verifies archived snapshot bytes: re-derives the content address from the
 * serialization and compares. `true` iff the bytes address to `expected`.
 */
export function verifySnapshotSerialization(serialization: string, expected: string): boolean {
  return sha256HexUtf8(CONTENT_ADDRESS_DOMAIN + serialization) === expected;
}
