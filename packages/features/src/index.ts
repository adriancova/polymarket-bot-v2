/**
 * `@polymarket-bot/features` — the versioned feature engine (WP-160,
 * handoff §9.5).
 *
 * A pure layer-1 library: one call (`computeFeatureSnapshot`) computes the
 * minimum v1 Polymarket, reference, lifecycle and quality features once for
 * one event, from caller-supplied inputs only, and returns an immutable,
 * content-addressed `FeatureSnapshot` — or a typed refusal. The registry
 * (`FEATURES_V1`) is versioned data, and the engine refuses any computation
 * whose id set differs from it.
 *
 * DEPENDENCY DIRECTION (handoff §5.2, `dependency-direction.md` §2): layer 1.
 * This package depends only on `@polymarket-bot/domain` (type-only) and
 * `@polymarket-bot/decimal` (both layer 0). Book state enters as the
 * canonical order-book v1 serialization TEXT (WP-150's `serializeBook`),
 * because the machine-checked contract enumerates no features → order-book
 * same-layer edge; the reader is bound to the real serializer by cross-test.
 *
 * DETERMINISM (workplan acceptance 1 & 3): no wall clock, no randomness, no
 * I/O beyond `node:crypto`'s pure SHA-256; time enters only as event
 * timestamps in the input. The same input value yields a byte-identical
 * serialization and content address.
 *
 * SCHEMA BOUNDARY (recorded cross-package risk, 2026-09-03): no runtime
 * schema library at all. Inputs are materialized into a prototype-free tree
 * first and validated by hand; every computed value is taken from that tree.
 *
 * SAFETY: nothing here can place an order or touch a venue. Run-mode
 * defaults (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, zero live-micro
 * caps) are untouched and not representable in this package.
 *
 * The normative contract (semantics, grammars, policies, versioning rules)
 * is `docs/contracts/features-v1.md`.
 */

export type { BookRead, BookReadProblemKind, ParsedBook, ParsedBookLevel } from "./book-serialization.js";
export { SUPPORTED_BOOK_SERIALIZATION_VERSION, readBookSerialization } from "./book-serialization.js";
export { serializeCanonicalJson } from "./canonical-json.js";
export type { SqrtResult } from "./decimal-policy.js";
export {
  FEATURE_DIVISION_PRECISION,
  FEATURE_DIVISION_ROUNDING,
  SQRT_MAX_ITERATIONS,
  dividePolicy,
  halveExact,
  quantizePolicy,
  sqrtPolicy,
} from "./decimal-policy.js";
export { sha256HexUtf8 } from "./hash.js";
export type {
  InputProblem,
  InputValidation,
  ReferenceVenueName,
  ValidatedBookInput,
  ValidatedChainlinkInput,
  ValidatedConfig,
  ValidatedFeatureInput,
  ValidatedIncident,
  ValidatedLifecycleInput,
  ValidatedQualityInput,
  ValidatedReferenceInput,
  ValidatedReferencePoint,
  ValidatedReferenceSeries,
  ValidatedReferenceTop,
  ValidatedSubject,
  ValidatedTrade,
  ValidatedTradesInput,
  ValidatedTrigger,
  ValidatedTwap,
} from "./inputs.js";
export {
  MAX_CONFIG_LIST,
  MAX_DEPTH_LEVEL,
  MAX_INCIDENTS,
  MAX_REFERENCE_POINTS,
  MAX_SERIALIZED_BOOK_LENGTH,
  MAX_TRADES,
  MAX_TRADE_WINDOW_MS,
  MAX_TWAPS,
  validateFeatureInput,
} from "./inputs.js";
export type { MaterializeProblem, MaterializedInput } from "./materialize.js";
export { MAX_INPUT_DEPTH, materializeInput } from "./materialize.js";
export type { FeatureCategory, FeatureDefinition } from "./registry.js";
export {
  FEATURES_V1,
  FEATURE_IDS_V1,
  FEATURE_SET_VERSION,
  RETURN_HORIZONS,
  TWAP_WINDOWS_SECONDS,
  featureDefinition,
} from "./registry.js";
export type { FeatureRefusal, FeatureRefusalCode, FeatureRefusalResult } from "./refusals.js";
export type {
  FeatureComputationResult,
  FeatureEntry,
  FeatureSnapshot,
  FeatureSnapshotInputsSection,
  FeatureSnapshotReference,
  FeatureSnapshotSuccess,
  IndexedFeatureValue,
} from "./snapshot.js";
export {
  CONTENT_ADDRESS_DOMAIN,
  FEATURE_SNAPSHOT_FORMAT,
  computeFeatureSnapshot,
  selectIndexedValues,
  snapshotReference,
  verifySnapshotSerialization,
} from "./snapshot.js";
export type { ParsedTimestamp } from "./time.js";
export { parseUtcTimestamp } from "./time.js";
export type { AbsenceReason, ComputedFeature, FeatureData, FeatureOutcome } from "./values.js";
