/**
 * OWN-DATA BRANDS — classification a caller-supplied value cannot subvert.
 *
 * ## Why `instanceof` is not usable at a containment boundary
 *
 * `instanceof` is `OrdinaryHasInstance`, which WALKS the value's prototype
 * chain. On a `Proxy` every step of that walk runs the `getPrototypeOf` trap, so
 * the classification itself is caller code and can throw. Review round 4 of
 * `WP-060-FU1` measured the consequence on the publish path, which takes a
 * caller-supplied object:
 *
 * ```ts
 * let hostile;
 * let count = 0;
 * hostile = new Proxy({}, { getPrototypeOf() {
 *   if (++count === 1) throw hostile;
 *   throw new RangeError("escape from instanceof");
 * } });
 * validateEnvelope(new Proxy({}, { ownKeys() { throw hostile; } }));
 * ```
 *
 * The first `instanceof` (in `readOwnWireValue`'s catch) re-threw `hostile`; the
 * second (in `containedJudgement`'s catch) threw a bare `RangeError`, which left
 * a boundary whose whole contract is that only an `EventBusEnvelopeError`
 * escapes it.
 *
 * ## What replaces it
 *
 * Each class this package must recognise brands its instances at construction
 * with an own, non-enumerable, non-writable, non-configurable DATA property at a
 * module-private symbol. {@link hasOwnBrand} then reads ONE OWN PROPERTY
 * DESCRIPTOR — no prototype walk, therefore no `getPrototypeOf` trap — and is
 * itself wrapped, so a value that manages to throw from
 * `Object.getOwnPropertyDescriptor` (a `Proxy` with a throwing trap, a revoked
 * `Proxy`) is classified as "not ours" rather than escaping. Classification is
 * therefore TOTAL: it returns a boolean for every input.
 *
 * The descriptor is built with NO PROTOTYPE for the reason measured in
 * `packages/risk/src/plain-data.ts`'s `ownDataDescriptor`: `defineProperty`
 * reads a descriptor's fields with `HasProperty`, which walks the chain, so an
 * inherited `Object.prototype.get` turns an ordinary `{ value }` literal into an
 * invalid "accessors and a value" descriptor and `defineProperty` throws. This
 * package's own tests install exactly that pollution.
 *
 * WHAT THIS DOES NOT CLAIM. The symbols are module-private, not unforgeable: a
 * caller already holding a genuine branded instance could read the symbol off it
 * with `Object.getOwnPropertySymbols` and brand a lookalike. That is not an
 * escalation — a caller who can produce a genuine refusal can already produce
 * one — and the prototype-based test it replaces was forgeable in the same way,
 * by `Object.create(EventBusEnvelopeError.prototype)`.
 */

/** The brand carried by every {@link EventBusEnvelopeError} (see `errors.ts`). */
export const ENVELOPE_REFUSAL_BRAND: unique symbol = Symbol(
  "@polymarket-bot/event-bus envelope refusal",
);

/** A brand descriptor: own, non-enumerable, non-writable, non-configurable data. */
function brandDescriptor(): PropertyDescriptor {
  // Assignment is safe here and only here: the target has no prototype, so no
  // inherited setter can run and no inherited field can be read back.
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = true;
  descriptor.enumerable = false;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/**
 * Brands `target` so {@link hasOwnBrand} recognises it.
 *
 * Non-enumerable, so it is invisible to `Object.keys`, to a structural equality
 * assertion, and to anything that serialises the error's own data.
 */
export function brandOwn(target: object, brand: symbol): void {
  Object.defineProperty(target, brand, brandDescriptor());
}

/**
 * Whether `value` carries `brand` as its OWN data. TOTAL: never throws.
 *
 * `Object.hasOwn(descriptor, "value")` rather than `"value" in descriptor`, for
 * the reason `plain-data.ts`'s `ownDataValue` records: the descriptor is an
 * ordinary object, so `in` answers for an INHERITED name and an
 * `Object.prototype.value` would make an accessor read as branded data.
 */
export function hasOwnBrand(value: unknown, brand: symbol): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, brand);
    return (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === true
    );
  } catch {
    // A `Proxy` with a throwing `getOwnPropertyDescriptor` trap, or a revoked
    // one. It is not ours; saying so is the fail-closed answer.
    return false;
  }
}
