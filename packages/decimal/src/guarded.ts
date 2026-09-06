/**
 * The package's binding of {@link withNeutralIndexNames} to its own taxonomy.
 *
 * `prototype-guard.ts` imports NOTHING — that is a stated property of it, and it
 * is what lets the module be read as a self-contained argument about the
 * prototype chain rather than as part of this package's error design. So it
 * takes its refusal as a callback, and this one line is where the callback is
 * supplied. Both `arithmetic.ts` and `tick.ts` guard through {@link guarded}, so
 * there is exactly one answer to "what does this package do when the realm is
 * unusable" and no entry point can drift from it.
 */

import { HostilePrototypeError } from "./errors.js";
import { withNeutralIndexNames } from "./prototype-guard.js";

/**
 * Refuses, naming every index-name property that could not be neutralized.
 *
 * The names arrive already rendered (`Array.prototype["0"]`) and are joined
 * without any `Array.prototype` method: this function runs precisely when that
 * prototype is the thing that is broken, and `join` is a `Get` at `"join"` — a
 * NAMED key, so not itself in the class this package guards, but reading an
 * element of the array it is called on is not. A manual loop over a local array
 * touches nothing inherited.
 */
function refuseHostilePrototype(unneutralizable: readonly string[]): never {
  let listed = "";
  for (const name of unneutralizable) {
    listed = listed === "" ? name : `${listed}, ${name}`;
  }
  throw new HostilePrototypeError(
    "DECIMAL_HOSTILE_PROTOTYPE",
    `exact decimal arithmetic refused: this process has a non-configurable property at an array-index name that cannot be neutralized (${listed}), which changes what decimal.js arithmetic computes`,
  );
}

/**
 * Runs `operation` with the index-name boundary in force.
 *
 * Returns whatever `operation` returns and propagates whatever it throws.
 *
 * @throws {HostilePrototypeError} when an array-index name on `Array.prototype`
 *   or `Object.prototype` can be neither neutralized nor shadowed. No value is
 *   computed in that state; see `prototype-guard.ts`'s residual section for the
 *   measurement that made refusing the only honest answer.
 */
export function guarded<T>(operation: () => T): T {
  return withNeutralIndexNames(operation, refuseHostilePrototype);
}
