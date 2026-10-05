/**
 * The verifiers' reproductions from rounds 1 to 5 (`../regressions/`) are kept as close to verbatim as the suite's
 * type-checked lint allows: they read and rewrite raw read answers (any field, any shape), which is what a fault
 * does. `Loose` is that one escape hatch, named, for those files only; no source file and no other suite file uses it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

/** Where the reproductions printed their diagnostics: kept as a call (their values stay computed), printing nothing. */
export function trace(...values: readonly unknown[]): void {
  void values;
}
