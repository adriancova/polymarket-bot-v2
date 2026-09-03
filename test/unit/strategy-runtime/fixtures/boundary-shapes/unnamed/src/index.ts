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
