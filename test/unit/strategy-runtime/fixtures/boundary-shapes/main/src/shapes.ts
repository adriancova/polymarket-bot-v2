/**
 * FIXTURE (remediation round 5). Every export shape review round 5 proved the
 * round-4 AST scan could not see, plus the ones it could, in one module that a
 * real `ts.Program` compiles. `boundary-shapes.test.ts` asserts the exact set
 * this yields, so each shape is covered by a permanent test rather than by a
 * mutation someone ran once.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

/** Shape: an exported arrow constant. */
export const arrowConst = (value: unknown): string => typeof value;

/** Shape: an `export function` re-exported by name from the entry point. */
export function reexportedFunction(value: unknown): string {
  return typeof value;
}

/** Shape: overloads — two declared signatures over one implementation. */
export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: unknown): string {
  return typeof value;
}

/** Shape: a rest parameter. */
export function withRest(...values: readonly unknown[]): number {
  return values.length;
}

/** Shape: a destructured parameter. */
export function withDestructuring({ first }: { readonly first: unknown }): string {
  return typeof first;
}

/** Shapes: an ordinary method, a static, an arrow FIELD, a getter, a setter, a private. */
export class ExportedClass {
  readonly field = (value: unknown): string => typeof value;
  private tag: string;

  constructor(label: string) {
    this.tag = label;
  }

  static staticMethod(value: unknown): string {
    return typeof value;
  }

  method(value: unknown): string {
    return `${this.tag}:${typeof value}`;
  }

  get current(): string {
    return this.tag;
  }

  set current(next: string) {
    this.tag = next;
  }

  private hidden(value: unknown): string {
    return `${this.tag}:${typeof value}`;
  }
}

/** Shapes: a method on an exported object literal, and one nested a level deeper. */
export const objectApi = {
  method(value: unknown): string {
    return typeof value;
  },
  nested: {
    deeper: (value: unknown): string => typeof value,
  },
};

/** Shape: a local function exported later through an export clause. */
function clauseOnly(value: unknown): string {
  return typeof value;
}

export { clauseOnly };

/** Not re-exported by the entry point: PACKAGE, and it must still be enumerated. */
export function packageOnly(value: unknown): string {
  return typeof value;
}
