/**
 * FIXTURE entry point: the PUBLIC surface of the fixture package. Every export
 * form appears here — a named list, a barrel, `export *`, a type-only export of
 * a class, and a function DECLARED here rather than re-exported.
 */

export {
  arrowConst,
  ExportedClass,
  objectApi,
  overloaded,
  reexportedFunction,
  withDestructuring,
  withRest,
} from "./shapes.js";

export { clauseOnly } from "./barrel.js";

export * from "./starred.js";

export { makeFacade, usesPort, type HandedOutFacade, type NeverImplementedPort } from "./handed-out.js";

export { makeTypeOnly, type TypeOnlyExportedClass } from "./type-only-class.js";

/** Round 6: the callables reachable only through the RETURN position. */
export {
  conditionalFactory,
  makeCallableFacade,
  makeHandler,
  makeInline,
  makeMapped,
  NestedReturningAccessor,
  ReturningAccessor,
  type CallableFacade,
  type LeftBranch,
  type MappedFacade,
  type RightBranch,
} from "./returned.js";

/** Declared HERE, not re-exported: review round 5's `directIndexTomorrow`. */
export function directlyInTheEntryPoint(value: unknown, label = "root"): string {
  return `${label}: ${typeof value}`;
}
