/**
 * FIXTURE (remediation round 7, M7-3): a class VALUE handed out by a public
 * factory — `typeof C` in the return position.
 *
 * Neither class is exported by name. The ONLY thing that puts them in a
 * caller's hands is the factory below, which is exactly the shape review round
 * 7 reproduced: the walk visited the class but forgot how it got there, so it
 * asked the entry points, got "not exported", and classified the constructor
 * and every prototype implementation PACKAGE. PACKAGE entries never enter the
 * hostile battery, so those were public callables going unfuzzed:
 *
 * ```
 * abstractClassFactory      PUBLIC
 * AbstractHandedOut.parse   PUBLIC     ← only because the property walk reached the static
 * AbstractHandedOut.concrete    PACKAGE
 * AbstractHandedOut.execute     PACKAGE
 * AbstractHandedOut.constructor PACKAGE
 * ```
 *
 * The four cases the fix has to tell apart, all present here:
 *
 * 1. a CONCRETE constructor — `new C(x)` is the caller's to make;
 * 2. an ABSTRACT constructor — `new C(x)` will not compile, but a subclass the
 *    caller writes reaches it through `super(...)` with the caller's arguments;
 * 3. a CONCRETE prototype implementation — the body is ours, the argument is
 *    theirs;
 * 4. an ABSTRACT declaration — the body is the CALLER's subclass's, so it is
 *    not this package's callable and carries no hostile-argument obligation. It
 *    is still enumerated by name, as PACKAGE, because absence from both lists
 *    is the outcome this mechanism may not have.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

abstract class AbstractHandedOut {
  constructor(readonly label: string) {}

  /** A static: reachable on the handed-out value itself. */
  static parse(raw: string): string {
    return raw;
  }

  /** 3 — a concrete prototype implementation. */
  concrete(value: unknown): string {
    return `${this.label}: ${typeof value}`;
  }

  /** 4 — an abstract method declaration. */
  abstract execute(value: unknown): string;

  /** 4 — an abstract ACCESSOR declaration. */
  abstract get handler(): (value: unknown) => string;

  /** 4 — an abstract PROPERTY whose type is callable. */
  abstract readonly compute: (value: unknown) => string;

  /** …and an abstract property that is not callable at all: nothing to enumerate. */
  abstract readonly tag: string;
}

export function abstractClassFactory(): typeof AbstractHandedOut {
  return AbstractHandedOut;
}

class ConcreteHandedOut {
  constructor(readonly seed: string) {}

  run(value: unknown): string {
    return `${this.seed}: ${typeof value}`;
  }
}

export function concreteClassFactory(): typeof ConcreteHandedOut {
  return ConcreteHandedOut;
}

/**
 * Reached TWICE, and the order is against us. This class is exported from this
 * MODULE, so the walk meets it first as a package-internal declaration and
 * derives PACKAGE; the public factory that hands it out lives in
 * `twice-reached.ts`, which the walk reaches LATER because it walks its files
 * in sorted order (`classes.ts` < `twice-reached.ts`). The visited-class guard
 * has to notice that the second reading differs from the first, or it returns
 * early and the wrong answer stands.
 *
 * It is deliberately NOT re-exported from the fixture's entry point: a value
 * export would make it PUBLIC without any of this mattering.
 */
export class TwiceReachedClass {
  constructor(readonly note: string) {}

  reached(value: unknown): string {
    return `${this.note}: ${typeof value}`;
  }
}
