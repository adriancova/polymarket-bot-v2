/**
 * `THROUGHPUT-1a` — a PREPARED `reference` section. PERFORMANCE ONLY: a
 * snapshot computed with a prepared section is the snapshot computed with the
 * raw one, byte for byte, refusals included.
 *
 * ## Why it exists
 *
 * A trader evaluates on every book event, but its reference series (up to 512
 * points per venue) changes only when a reference trade arrives — H1's burst:
 * ~28 a second against ~660 evaluations. Before this module every evaluation
 * re-materialized, re-validated, re-copied and re-serialized the whole window
 * (and recomputed its EWMA): profiled on the H1 burst, the reference window was
 * most of the trader's per-event cost.
 *
 * ## What it is
 *
 * {@link prepareReferenceInput} reads the caller's section ONCE — with the very
 * reader `computeFeatureSnapshot` uses, at the path and depth the section has
 * inside an input (`input.reference`, depth 1) — and, when it is clean plain
 * data, answers that materialized copy DEEP-FROZEN and registered in a
 * `WeakMap` this package owns. The caller passes it as `input.reference`
 * exactly where it would have passed the raw section. Then:
 *
 * - the MATERIALIZER answers the registered tree itself where it would have
 *   copied the raw one (`materialize.ts`, `PREPARED_TREES`): the copy it would
 *   make is equal to it;
 * - the VALIDATOR reuses one validation of it. The section's only
 *   `asOf`-dependent check is "no point observed after `asOf`" (§6 invariant
 *   15); the reuse is taken only when the latest point is at or before this
 *   call's `asOf`, which is exactly when that check passes, and only for a
 *   section with no `chainlink` part (whose TWAP windows have their own
 *   `asOf` check). Otherwise the section is validated as always;
 * - the validated model's prototype-free copy of the section, its
 *   canonical-JSON digest fragment and the EWMA outcome are reused likewise.
 *
 * A value that is NOT clean plain data is returned UNCHANGED (unprepared), so
 * the ordinary path refuses it with the same codes, paths and problems as
 * before. Registration is by identity in package-owned weak maps: nothing a
 * caller builds, and no Proxy, can pass for a prepared section, and checking
 * runs no caller code. A prepared section is immutable (frozen), which is what
 * makes every reuse above sound.
 */

import { canonicalFragment, serializeCanonicalJson } from "./canonical-json.js";
import type { ValidatedReferenceInput } from "./inputs.js";
import { materializePrepared } from "./materialize.js";

/** Where a `reference` section sits inside a feature input. */
export const REFERENCE_SECTION_PATH = "input.reference";
const REFERENCE_SECTION_DEPTH = 1;

/**
 * Prepares a `reference` section for repeated snapshots (see the module
 * header). Returns the prepared (frozen, registered) section, or `raw` itself
 * when it is not clean plain data. TOTAL: never throws.
 */
export function prepareReferenceInput(raw: unknown): unknown {
  const prepared = materializePrepared(raw, REFERENCE_SECTION_PATH, REFERENCE_SECTION_DEPTH);
  return prepared ?? raw;
}

/** One reuse of a prepared section's validation (see `inputs.ts` `validateReference`). */
export interface PreparedValidation {
  /** The section as `validateReference` answered it. */
  readonly validated: ValidatedReferenceInput;
  /** `ownPlainCopy(validated)`: the validated model's copy of the section. */
  readonly plain: ValidatedReferenceInput;
  /** The latest `observedAt` of any point, epoch ms (`-Infinity` for none). */
  readonly latestObservedAtEpochMs: number;
}

/** Validations of prepared sections, by the prepared tree. `null`: not reusable. */
const VALIDATIONS = new WeakMap<object, PreparedValidation | null>();

/** The recorded reuse for a prepared tree, if one was recorded. */
export function preparedValidationOf(tree: unknown): PreparedValidation | null | undefined {
  if (tree === null || typeof tree !== "object") return undefined;
  return VALIDATIONS.get(tree);
}

/** Records the reuse (or `null`: not reusable) for a prepared tree. */
export function recordPreparedValidation(tree: object, validation: PreparedValidation | null): void {
  VALIDATIONS.set(tree, validation);
}

/** Every validated model copy of a prepared section, so the digest can find its fragment. */
const PLAIN_SECTIONS = new WeakSet<object>();

export function registerPlainSection(plain: object): void {
  PLAIN_SECTIONS.add(plain);
}

/** Canonical-JSON fragments of the digest shape, by the validated model copy. */
const DIGEST_FRAGMENTS = new WeakMap<object, object>();

/**
 * The inputs digest's `reference` member for a validated section: a
 * pre-serialized canonical fragment when the section is a registered model
 * copy of a prepared one (serialized once, then reused), else the plain shape
 * the serializer walks. Either way the digest bytes are
 * `serializeCanonicalJson(shape)`.
 */
export function referenceDigestMember(
  reference: ValidatedReferenceInput,
  shapeOf: (reference: ValidatedReferenceInput) => Record<string, unknown>,
): unknown {
  if (!PLAIN_SECTIONS.has(reference)) return shapeOf(reference);
  const cached = DIGEST_FRAGMENTS.get(reference);
  if (cached !== undefined) return cached;
  const fragment = canonicalFragment(serializeCanonicalJson(shapeOf(reference)));
  DIGEST_FRAGMENTS.set(reference, fragment);
  return fragment;
}
