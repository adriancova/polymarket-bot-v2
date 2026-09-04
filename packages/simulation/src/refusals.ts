/**
 * Typed refusals for the simulation package (WP-210).
 *
 * A refusal is DATA, never a thrown exception: every public entry point in this
 * package is total, and everything it cannot answer comes back as one of these.
 * The `details` record is copied into a fresh prototype-free tree by
 * {@link ownDataDetails}, so a refusal can never carry live caller state, an
 * accessor, or an inherited property.
 *
 * BOUNDARY DISCIPLINE (ADR-020 §3, `docs/contracts/schema-boundary.md` §1).
 * This package runs NO runtime schema library — the WP-160 precedent — so every
 * value that crosses a door is materialized prototype-free first
 * ({@link ./plain.js}), validated by hand-written TOTAL predicates
 * ({@link ./grammar.js}), read from the materialized tree, and emitted
 * prototype-free. `ownDataDescriptor` below is the WP-180 round-8 lesson made
 * local: an object-literal property descriptor is itself read through the
 * prototype chain, so an inherited `get`/`set` makes every
 * `Object.defineProperty` throw.
 */

/** Every refusal code this package can return. Exhaustive by construction. */
export const SIMULATION_REFUSAL_CODES = [
  // --- doors ---------------------------------------------------------------
  /** A caller value could not be read as plain data (Proxy, accessor, cycle …). */
  "SIMULATION_INPUT_NOT_DATA",
  /** The materialized value violates the documented input contract. */
  "SIMULATION_INPUT_INVALID",
  /** Fail-closed containment: an unexpected internal failure became a refusal. */
  "SIMULATION_INTERNAL",

  // --- replay clock --------------------------------------------------------
  /** The clock was asked to move backwards; replay time is monotone (§12.4). */
  "REPLAY_CLOCK_NOT_MONOTONE",
  /** The clock was read before any recorded event positioned it (§12.1). */
  "REPLAY_CLOCK_UNPOSITIONED",

  // --- dataset manifest ----------------------------------------------------
  /** The manifest bytes are not the strict-JSON reading profile (ADR-017 §3). */
  "REPLAY_MANIFEST_NOT_STRICT_JSON",
  /** The manifest parses but does not satisfy the §12.5 / §8.4 contract. */
  "REPLAY_MANIFEST_INVALID",
  /** The manifest's format id or version is not one this build replays. */
  "REPLAY_MANIFEST_UNSUPPORTED",
  /** A run-scoped §12.5 pin is missing, so the run is not reproducible. */
  "REPLAY_MANIFEST_PIN_MISSING",
  /** A run-scoped pin disagrees with the component that would be used. */
  "REPLAY_MANIFEST_PIN_MISMATCH",

  // --- dataset event source ------------------------------------------------
  /** Bytes read for an archived object do not hash to the manifest's pin. */
  "REPLAY_OBJECT_CHECKSUM_MISMATCH",
  /** Bytes read for a WAL segment do not hash to the manifest's pin. */
  "REPLAY_SEGMENT_CHECKSUM_MISMATCH",
  /** A manifest-pinned object or segment could not be read at all. */
  "REPLAY_ARCHIVE_UNREADABLE",
  /** A decoded row does not satisfy the pinned dataset row contract. */
  "REPLAY_ROW_INVALID",
  /** Dispatch ordinals are not dense, or disagree with recorded ingest order. */
  "REPLAY_DISPATCH_ORDER_INCONSISTENT",
  /** A dispatch ordinal is missing: a gap is refused, never skipped (§8.3). */
  "REPLAY_ORDINAL_GAP",
  /** A row is excluded without a manifest-declared justification. */
  "REPLAY_EXCLUSION_UNDECLARED",
  /** Observed counts do not reconcile with the manifest's own counts. */
  "REPLAY_COUNTS_UNRECONCILED",
  /**
   * The dataset spans more than one gateway epoch.
   *
   * `docs/contracts/wal-format.md` §12.1 (GOV-1C item 5): epochs are identity,
   * not chronology, and no cross-epoch order is defined. Ordering rows across
   * epochs would fabricate one.
   */
  "REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED",
  /** The normalizer refused a recorded frame; a dropped event is never silent. */
  "REPLAY_NORMALIZER_REFUSED",

  // --- simulated venue -----------------------------------------------------
  /** A run mode that requires a live signer reached a SIMULATED venue (§11). */
  "SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER",
  /** The plan is not a shape this venue can simulate. */
  "SIMULATED_VENUE_PLAN_UNSUPPORTED",
  /** No book state exists for a market the plan names (§6 invariant 12). */
  "SIMULATED_VENUE_NO_BOOK",
  /** The rate-limit budget refused the action (§9.13, ADR-012 §5.6). */
  "SIMULATED_VENUE_RATE_LIMITED",
  /** A submission was attempted for an order the venue already knows. */
  "SIMULATED_VENUE_DUPLICATE_ORDER",
  /** A cancel names an order this venue never accepted. */
  "SIMULATED_VENUE_UNKNOWN_ORDER",

  // --- fill models ---------------------------------------------------------
  /** The fill-model parameters are absent or not pinned (§12.5, ADR-012 §4). */
  "FILL_MODEL_PARAMETERS_UNPINNED",
  /** A fee schedule snapshot is required and was not supplied (§6 invariant 9). */
  "FILL_MODEL_FEE_SNAPSHOT_MISSING",
  /** A latency distribution is empty or has non-positive total weight. */
  "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
  /** A queue-scenario band came out inconsistent with its own ordering. */
  "FILL_MODEL_BAND_INCONSISTENT",

  // --- markouts ------------------------------------------------------------
  /** A markout was requested at a horizon the observed path cannot cover. */
  "MARKOUT_HORIZON_UNOBSERVED",
] as const;

/** Every refusal code this package can return. */
export type SimulationRefusalCode = (typeof SIMULATION_REFUSAL_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set<string>(SIMULATION_REFUSAL_CODES);

/** Narrowing predicate over the closed refusal vocabulary. */
export function isSimulationRefusalCode(value: unknown): value is SimulationRefusalCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/** A typed refusal. `details` is always own, plain, frozen data. */
export interface SimulationRefusal {
  readonly code: SimulationRefusalCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Total result: an answer, or a reason there is none. */
export type SimulationResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly refusal: SimulationRefusal };

/**
 * A property descriptor with NO PROTOTYPE.
 *
 * WP-180 round 8: an object-literal descriptor is read through the prototype
 * chain, so an inherited `get`/`set` on `Object.prototype` makes every
 * `Object.defineProperty` written with a literal throw `TypeError`
 * (ADR-020 §1 item 8).
 */
export function ownDataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  // Assignment is safe here and nowhere else: the target has no prototype.
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/** Defines one own, plain data property on a prototype-free target. */
export function defineData(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, ownDataDescriptor(value));
}

/** A fresh prototype-free record. */
export function plainRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function describeNonPrimitive(value: unknown): string {
  switch (typeof value) {
    case "bigint":
      return `a bigint (${value.toString()})`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return Array.isArray(value)
        ? `an array of ${String((value as unknown[]).length)} members`
        : "an object";
  }
}

/**
 * A fresh, frozen, prototype-free copy of a refusal's `details`.
 *
 * Copies own string-keyed DATA properties only, reading descriptors rather than
 * properties so no getter runs. Anything that is not own data is counted, not
 * silently dropped.
 */
export function ownDataDetails(
  details?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out = plainRecord();
  if (details === null || details === undefined || typeof details !== "object") {
    return Object.freeze(out);
  }
  let skipped = 0;
  let names: readonly string[];
  try {
    names = Object.getOwnPropertyNames(details);
  } catch {
    defineData(out, "detailsUnreadable", "its own property names could not be read");
    return Object.freeze(out);
  }
  for (const name of names) {
    if (name === "__proto__") {
      skipped += 1;
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(details, name);
    } catch {
      skipped += 1;
      continue;
    }
    if (descriptor === undefined) continue;
    // `Object.hasOwn`, not `"value" in descriptor`: `in` answers for an
    // INHERITED name, so with `Object.prototype.value` defined every accessor
    // descriptor would read as a data descriptor (WP-180 round-6 census).
    if (!Object.hasOwn(descriptor, "value")) {
      skipped += 1;
      continue;
    }
    const value = descriptor.value as unknown;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "undefined"
    ) {
      defineData(out, name, value);
    } else {
      // A refusal detail is evidence about primitives (an id, a count, a
      // spelling); a structured value is described, never aliased.
      defineData(out, name, describeNonPrimitive(value));
    }
  }
  if (skipped > 0) {
    defineData(
      out,
      "detailsUnreadable",
      `${String(skipped)} propert${skipped === 1 ? "y" : "ies"} of the supplied details are not own data and were not copied`,
    );
  }
  return Object.freeze(out);
}

/** Builds a refusal. The details record is copied, never aliased. */
export function simulationRefusal(
  code: SimulationRefusalCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SimulationRefusal {
  const refusal = plainRecord();
  defineData(refusal, "code", code);
  defineData(refusal, "message", message);
  defineData(refusal, "details", ownDataDetails(details));
  return Object.freeze(refusal) as unknown as SimulationRefusal;
}

/** Builds a failing result. */
export function simulationFailure<TValue = never>(
  code: SimulationRefusalCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SimulationResult<TValue> {
  const result = plainRecord();
  defineData(result, "ok", false);
  defineData(result, "refusal", simulationRefusal(code, message, details));
  return Object.freeze(result) as unknown as SimulationResult<TValue>;
}

/** Builds a succeeding result. The value is NOT copied; callers pass own data. */
export function simulationOk<TValue>(value: TValue): SimulationResult<TValue> {
  const result = plainRecord();
  defineData(result, "ok", true);
  defineData(result, "value", value);
  return Object.freeze(result) as unknown as SimulationResult<TValue>;
}

/**
 * Wraps a computation so an unexpected throw becomes a typed refusal.
 *
 * ADR-020 §6's bound includes "no throw escapes": a door that documents typed
 * refusals may not leak an exception when the ambient prototype is polluted.
 */
export function totally<TValue>(
  what: string,
  compute: () => SimulationResult<TValue>,
): SimulationResult<TValue> {
  try {
    return compute();
  } catch (cause) {
    let described = "an unexpected failure";
    try {
      described = cause instanceof Error ? `${cause.name}` : typeof cause;
    } catch {
      described = "an unreadable failure";
    }
    return simulationFailure(
      "SIMULATION_INTERNAL",
      `${what} failed unexpectedly and is refused rather than answered (fail closed)`,
      { failure: described },
    );
  }
}
