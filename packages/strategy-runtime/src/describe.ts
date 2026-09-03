/**
 * `describeCause` — the ONE way this package turns an arbitrary thrown value
 * into text, and the reason it is a module of its own.
 *
 * Added 2026-09-03 in remediation round 3 (review round 3, MEDIUM 1). Every
 * "never throws" function in this package formats a cause somewhere on its
 * refusal path, and the obvious spelling of that formatting is itself a partial
 * function:
 *
 * - `cause instanceof Error` performs [[GetPrototypeOf]] on the LEFT operand,
 *   which throws `TypeError: Cannot perform 'getPrototypeOf' on a proxy that
 *   has been revoked` — reproduced verbatim before this module existed, by a
 *   hostile trap that threw a revoked `Proxy` rather than an `Error`;
 * - `cause.message` may be an accessor that throws;
 * - `String(cause)` runs `Symbol.toPrimitive`/`toString`, which a hostile object
 *   can make throw, which a `Symbol` value refuses outright
 *   (`TypeError: Cannot convert a Symbol value to a string`), and which a
 *   null-prototype object cannot satisfy at all
 *   (`TypeError: Cannot convert object to primitive value`).
 *
 * A refusal path that throws while describing why it is refusing is worse than
 * no refusal at all: it converts a contained, typed outcome into an escaped
 * exception, which is exactly the class of defect rounds 1–3 kept finding. So
 * every step here is guarded and the last resort is `typeof`, the only
 * operation in the language that cannot run caller code.
 */

/**
 * Normalizes a DIAGNOSTIC path or label — the `path` of a materialization, the
 * `label` of a field snapshot — into text before anything interpolates it.
 *
 * Added 2026-09-03 in remediation round 4 (review round 4, MEDIUM 1). These
 * arguments are typed `string`, so the type system stops a TypeScript caller;
 * it stops nothing at runtime, and `materializeCheckpointableJson` accepted its
 * `path` from any caller through the package's public API. Reproduced verbatim
 * against the round-3 code:
 *
 *     materializeCheckpointableJson(1n, Symbol(...))  → threw TypeError:
 *       Cannot convert a Symbol value to a string
 *     path.toString() throws                          → escaped Error:
 *       PATH_TOSTRING
 *
 * — because the refusal `${path}: bigint is not representable in JSON` runs
 * `ToString` on whatever was passed. Two things were done about it: the `path`
 * argument is no longer part of any PUBLIC signature (the exported wrappers take
 * the value alone and the pathed forms are package-internal), and every
 * diagnostic label is normalized here first, so even an internal caller that
 * one day computes one cannot reopen the hole.
 */
export function describeLabel(label: unknown): string {
  return typeof label === "string" ? label : describeCause(label);
}

/** Describes any thrown value as text. TOTAL: this function cannot throw. */
export function describeCause(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      const message: unknown = cause.message;
      if (typeof message === "string") {
        return message;
      }
    }
  } catch {
    // The prototype-chain walk or the `message` accessor ran caller code and
    // threw; fall through to the next strategy rather than propagating.
  }
  try {
    const text: unknown = String(cause);
    if (typeof text === "string") {
      return text;
    }
  } catch {
    // `String()` invokes caller code too (`toString`, `Symbol.toPrimitive`).
  }
  return `<unprintable ${typeof cause} value>`;
}
