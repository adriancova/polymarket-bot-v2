/**
 * The strategy-instance id as a ROUTE PARAMETER — `CONTROL-1`, closing
 * `WP-240` r1 L-1 and L-2.
 *
 * `POST /v1/strategies/:instanceId/{pause,resume}` carries the id in the
 * path, percent-encoded. At `WP-240` the router matched the RAW segment with
 * `[^/]+` and then called `decodeURIComponent` on it outside any door:
 *
 * - **L-1.** A malformed escape (`%E0%A4%A`, `%ZZ`) made `decodeURIComponent`
 *   THROW. The handler's outer guard contained it, so nothing leaked and no
 *   state changed, but the operator got `500 CONTROL_INTERNAL_ERROR` for a
 *   request that was simply malformed.
 * - **L-2.** The raw grammar excluded `/`, and decoding re-admitted it: `a%2Fb`
 *   became the instance id `a/b`, and the audit record's `scopeRef` with it.
 *   An id the route grammar cannot spell is an id no operator can address
 *   twice the same way.
 *
 * {@link readInstanceIdParameter} is the door for that parameter: TOTAL (it
 * never throws), and it applies one grammar — {@link instanceIdProblem} —
 * to the DECODED value. `ControlPlane.register` applies the same grammar, so
 * every instance the control plane knows is one the route can address.
 *
 * ## The grammar, and why each rule
 *
 * 1. **Non-empty.**
 * 2. **At most {@link MAX_INSTANCE_ID_LENGTH} characters** — the same bound the
 *    kill-switch `scopeRef` has (`api.ts`), because both become the §10.6
 *    audit record's `scope_ref`.
 * 3. **No `/`** — the router's own segment grammar, applied after decoding
 *    (L-2).
 * 4. **No control character** (Unicode `Cc`: C0, DEL, C1). It is unprintable
 *    in an operator's audit log, and PostgreSQL `text` cannot hold `NUL`, so a
 *    `%00` would otherwise turn a durable audit append into a sink failure.
 *
 * Nothing else is refused. In particular a space (`sb%20one`) stays legal:
 * `TRDR-1` relaxed the trader's instance ids, and this API does not narrow
 * them further than it must.
 */

/** The longest instance id this API accepts (the `scopeRef` bound). */
export const MAX_INSTANCE_ID_LENGTH = 256;

/** Why `id` is not an instance id this API can address, or `undefined`. */
export function instanceIdProblem(id: string): string | undefined {
  if (id.length === 0) return "the strategy instance id is empty";
  if (id.length > MAX_INSTANCE_ID_LENGTH) {
    return `the strategy instance id is longer than ${String(MAX_INSTANCE_ID_LENGTH)} characters`;
  }
  if (id.includes("/")) {
    return "the strategy instance id contains '/', which the route grammar cannot carry (a %2F is decoded, then refused)";
  }
  if (/\p{Cc}/u.test(id)) return "the strategy instance id contains a control character";
  return undefined;
}

export type InstanceIdParameter =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Decodes and checks the raw `:instanceId` path segment. TOTAL: a malformed
 * percent-escape is a refusal, never a throw (L-1).
 */
export function readInstanceIdParameter(raw: string): InstanceIdParameter {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // The segment itself is NOT echoed: it is a caller's bytes, and the class
    // of the failure is what an operator can act on.
    return { ok: false, detail: "the strategy instance id is not valid percent-encoded UTF-8" };
  }
  const problem = instanceIdProblem(decoded);
  return problem === undefined ? { ok: true, value: decoded } : { ok: false, detail: problem };
}
