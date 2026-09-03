/**
 * FIXTURE (remediation round 6): callables reached only through the RETURN
 * position, every one of which review round 6 proved SILENTLY ABSENT — present
 * in neither `callables` nor `unresolved`.
 *
 * These are the shapes that must be ENUMERATED BY NAME. The ones that cannot be
 * named at all live in the sibling `unnamed/` fixture and must be REFUSED by
 * name; between the two, no callable shape is silent.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

/** Round 6, the reviewer's shape 2: a GETTER whose value is a function. */
export class ReturningAccessor {
  get handler(): (value: unknown) => string {
    return (value: unknown): string => typeof value;
  }
}

/**
 * The reviewer's note that the omission is not specific to getters: an ordinary
 * function that returns a function loses the returned callable the same way.
 */
export function makeHandler(): (value: unknown) => string {
  return (value: unknown): string => typeof value;
}

/** Two hops: a callable returned from a callable returned from a getter. */
export class NestedReturningAccessor {
  get outer(): () => (value: unknown) => string {
    return () =>
      (value: unknown): string =>
        typeof value;
  }
}

/** Round 6, the reviewer's shape 6: BOTH branches of a generic conditional. */
export interface LeftBranch {
  left(value: unknown): string;
}
export interface RightBranch {
  right(value: unknown): string;
}
export function conditionalFactory<T>(flag: T): T extends string ? LeftBranch : RightBranch {
  return (
    typeof flag === "string"
      ? { left: (value: unknown): string => typeof value }
      : { right: (value: unknown): string => typeof value }
  ) as T extends string ? LeftBranch : RightBranch;
}

/**
 * A CALLABLE interface: the shape a callable `Proxy` is handed out under, which
 * the reviewer noted would inherit the same omission as the getter.
 */
export interface CallableFacade {
  (value: unknown): string;
  readonly tag: string;
}
export function makeCallableFacade(): CallableFacade {
  const call = (value: unknown): string => typeof value;
  return Object.assign(call, { tag: "fixture" });
}

/**
 * A MAPPED type in the return position. Not on the reviewer's list; found by
 * this round's own hunt, and the one with a live analogue — `Readonly<MarketView>`
 * and its siblings are the SDK's actual return types. The walk used to require
 * the returned type's own symbol to be OURS, and `Readonly<T>`'s symbol belongs
 * to the standard library, so every member went missing.
 */
export interface MappedFacade {
  mapped(value: unknown): string;
}
export function makeMapped(): Readonly<MappedFacade> {
  return { mapped: (value: unknown): string => typeof value };
}

/** An ANONYMOUS inline object type in the return position: named by its site. */
export function makeInline(): { inline(value: unknown): string } {
  return { inline: (value: unknown): string => typeof value };
}
