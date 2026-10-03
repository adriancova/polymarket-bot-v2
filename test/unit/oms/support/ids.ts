/**
 * Deterministic UUIDv7-shaped ids and request tokens for the OMS suites.
 * Synthetic only. A counter token source is PREDICTABLE: it is fit for tests
 * that must name a request id ahead of time, and never for production
 * (ADR-032 D3: the composition binds a CSPRNG).
 */

/** A UUIDv7-shaped id (version nibble 7, variant 8) from a namespace digit and a counter. */
export function uuid7(namespace: number, n: number): string {
  const ns = namespace.toString(16).padStart(4, "0").slice(-4);
  const tail = n.toString(16).padStart(12, "0").slice(-12);
  return `00000000-${ns}-7000-8000-${tail}`;
}

export function idSource(namespace = 0xa): () => string {
  let n = 0;
  return () => {
    n += 1;
    return uuid7(namespace, n);
  };
}

export function tokenSource(prefix = "tok"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}
