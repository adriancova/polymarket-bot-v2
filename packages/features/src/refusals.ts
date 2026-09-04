/**
 * Typed refusals for the feature engine (WP-160).
 *
 * A refusal is data, never a thrown exception: `computeFeatureSnapshot` is
 * total, and everything it cannot answer is returned as one of these. The
 * `details` record is copied into a fresh prototype-free tree by
 * {@link ownDataDetails} so a refusal can never carry live caller state, an
 * accessor, or an inherited property.
 */

/** Every refusal code the feature engine can return. */
export type FeatureRefusalCode =
  /** The input value could not be read as plain data (Proxy, accessor, cycle …). */
  | "FEATURES_INPUT_NOT_DATA"
  /** The materialized input violates the documented input contract. */
  | "FEATURES_INPUT_INVALID"
  /** A timestamp is not in the strict v1 UTC grammar or names an impossible instant. */
  | "FEATURES_TIMESTAMP_INVALID"
  /** The serialized book names a different market/token than the subject. */
  | "FEATURES_SUBJECT_MISMATCH"
  /** The book serialization's version line is not `polymarket-bot/order-book/v1`. */
  | "FEATURES_BOOK_SERIALIZATION_UNSUPPORTED"
  /** The book serialization does not parse under the v1 line grammar. */
  | "FEATURES_BOOK_SERIALIZATION_MALFORMED"
  /** The book serialization's summary lines contradict its own ladders. */
  | "FEATURES_BOOK_SERIALIZATION_INCONSISTENT"
  /** The book has no baseline snapshot; §7.1 forbids treating it as state. */
  | "FEATURES_BOOK_NOT_BASELINED"
  /** Fail-closed containment: an unexpected internal failure became a refusal. */
  | "FEATURES_INTERNAL";

/** A typed refusal. `details` is always own, plain, frozen data. */
export interface FeatureRefusal {
  readonly code: FeatureRefusalCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface FeatureRefusalResult {
  readonly ok: false;
  readonly refusal: FeatureRefusal;
}

/**
 * A fresh, frozen, prototype-free copy of a refusal's `details`.
 *
 * Copies own string-keyed DATA properties only, one level of primitives and
 * plain sub-values, reading descriptors rather than properties so no getter
 * runs (the WP-180 `ownDataDetails` pattern, implemented locally because
 * `packages/risk` is a same-layer package this one may not import). Anything
 * that is not own data is counted, not silently dropped.
 */
export function ownDataDetails(details?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out = Object.create(null) as Record<string, unknown>;
  if (details === null || typeof details !== "object") {
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

function describeNonPrimitive(value: unknown): string {
  switch (typeof value) {
    case "bigint":
      return `a bigint (${value.toString()})`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return Array.isArray(value) ? `an array of ${String((value as unknown[]).length)} members` : "an object";
  }
}

/**
 * A property descriptor with NO PROTOTYPE (the WP-180 round-8 lesson: an
 * object-literal descriptor is itself read through the prototype chain, so an
 * inherited `get`/`set` makes every `Object.defineProperty` throw).
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

function defineData(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, ownDataDescriptor(value));
}

/** Builds a refusal result. The details record is copied, never aliased. */
export function refuse(
  code: FeatureRefusalCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): FeatureRefusalResult {
  const refusal = Object.create(null) as {
    code: FeatureRefusalCode;
    message: string;
    details: Readonly<Record<string, unknown>>;
  };
  defineData(refusal, "code", code);
  defineData(refusal, "message", message);
  defineData(refusal, "details", ownDataDetails(details));
  const result = Object.create(null) as { ok: false; refusal: FeatureRefusal };
  defineData(result, "ok", false);
  defineData(result, "refusal", Object.freeze(refusal));
  return Object.freeze(result) as FeatureRefusalResult;
}
