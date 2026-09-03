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
