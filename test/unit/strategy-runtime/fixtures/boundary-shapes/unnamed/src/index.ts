/**
 * FIXTURE (remediation round 6): the return positions where a callable EXISTS
 * but no concrete NAME reaches it.
 *
 * These are a separate fixture package from `main/` for one reason: the correct
 * answer here is a REFUSAL, and `main/`'s test asserts an empty `unresolved`.
 * The reviewer's instruction was literal — "emit `unresolved` where no concrete
 * callable name can be driven" — so this fixture is the negative half of the
 * binding property. Inventing an id like `indexFactory (returned)[*]` would put
 * an entry in the registry that the hostile battery could never call, which is a
 * worse lie than the silence it replaced.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

/** The reviewer's shape 7: a callable-only string index signature. */
export interface CallableIndex {
  readonly [key: string]: (value: unknown) => string;
}
export function indexFactory(): CallableIndex {
  return { any: (value: unknown): string => typeof value };
}

/** A `readonly` array of callables: an element has an index, not a name. */
export function arrayFactory(): readonly ((value: unknown) => string)[] {
  return [(value: unknown): string => typeof value];
}

/** A facade reachable only as a foreign container's type argument. */
export interface PromisedFacade {
  promised(value: unknown): string;
}
export function promiseFactory(): Promise<PromisedFacade> {
  return Promise.resolve({ promised: (value: unknown): string => typeof value });
}

/** A handed-out value someone can `new` that is not one of our classes. */
export interface ConstructibleFacade {
  new (value: unknown): { readonly value: unknown };
}
export function constructibleFactory(): ConstructibleFacade {
  return class {
    readonly value: unknown;
    constructor(value: unknown) {
      this.value = value;
    }
  };
}

/**
 * A chain of returned facades longer than `MAX_SURFACE_DEPTH`. The walk used to
 * stop here in silence, truncating everything below; it now says so by name.
 */
export interface Hop0 {
  hop(): Hop1;
}
export interface Hop1 {
  hop(): Hop2;
}
export interface Hop2 {
  hop(): Hop3;
}
export interface Hop3 {
  hop(): Hop4;
}
export interface Hop4 {
  hop(): Hop5;
}
export interface Hop5 {
  deepest(value: unknown): string;
}
export function deepFactory(): Hop0 {
  throw new Error("the fixture is compiled and walked, never executed");
}

/**
 * ROUND 7, M7-2: a callable buried deeper than the PREDICATE can see.
 *
 * `carriesCallables` used to return a boolean, so "I ran out of depth before I
 * could tell" came back as `false` and every caller read it as "there is
 * nothing there". Review round 7 reproduced exactly this: a callable ten
 * property hops beneath a returned string-index value produced
 * `callables: [deepIndexFactory]`, `unresolved: []`, `diagnostics: []` — silent,
 * behind a bound documented as always refusing.
 *
 * The chain below is long enough that the predicate exhausts itself from every
 * one of the three sites that consult it: an index signature's value type, a
 * foreign container's type argument, and the enumeration's own depth bound.
 * Each of them must now REFUSE by name.
 */
export interface Deep19 {
  deepest(value: unknown): string;
}
export interface Deep18 {
  next: Deep19;
}
export interface Deep17 {
  next: Deep18;
}
export interface Deep16 {
  next: Deep17;
}
export interface Deep15 {
  next: Deep16;
}
export interface Deep14 {
  next: Deep15;
}
export interface Deep13 {
  next: Deep14;
}
export interface Deep12 {
  next: Deep13;
}
export interface Deep11 {
  next: Deep12;
}
export interface Deep10 {
  next: Deep11;
}
export interface Deep9 {
  next: Deep10;
}
export interface Deep8 {
  next: Deep9;
}
export interface Deep7 {
  next: Deep8;
}
export interface Deep6 {
  next: Deep7;
}
export interface Deep5 {
  next: Deep6;
}
export interface Deep4 {
  next: Deep5;
}
export interface Deep3 {
  next: Deep4;
}
export interface Deep2 {
  next: Deep3;
}
export interface Deep1 {
  next: Deep2;
}
export interface Deep0 {
  next: Deep1;
}

/** The reviewer's shape: a callable far beneath a returned string-index value. */
export interface DeepIndex {
  readonly [key: string]: Deep0;
}
export function deepIndexFactory(): DeepIndex {
  throw new Error("the fixture is compiled and walked, never executed");
}

/** The same, beneath a FOREIGN container's type argument. */
export function deepContainerFactory(): Promise<Deep0> {
  throw new Error("the fixture is compiled and walked, never executed");
}

/** And the same chain reached by NAME, which exhausts the enumeration's own bound. */
export function deepNamedFactory(): Deep0 {
  throw new Error("the fixture is compiled and walked, never executed");
}

/**
 * ROUND 7, M7-1's other half: a SYNTHESIZED property whose own call signature
 * is declared in the standard library, with one of ours underneath it.
 *
 * A remapped property has no declaration, so the walk asks its TYPE instead —
 * and it will not claim somebody else's implementation as this package's. Round
 * 6 settled that frontier for returned call signatures by skipping them; here
 * the skip would hide the callable that IS ours, sitting on the intersection, so
 * the branch is refused by name instead.
 */
export interface OwnedUnderneath {
  ours(value: unknown): string;
}
export interface ForeignCallableSource {
  readonly stringify: typeof JSON.stringify & OwnedUnderneath;
}
export type ForeignRemapped<T> = { [K in keyof T as `x_${string & K}`]: T[K] };
export function foreignRemappedFactory(): ForeignRemapped<ForeignCallableSource> {
  throw new Error("the fixture is compiled and walked, never executed");
}
