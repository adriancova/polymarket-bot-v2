/**
 * FIXTURE (remediation round 7, M7-3): the public factory that hands out
 * `TwiceReachedClass`, in a module the walk reaches AFTER `classes.ts`.
 *
 * The file name matters. The walk visits its files in sorted order, so
 * `classes.ts` gives the walk a package-internal reading of the class first and
 * this module gives it the public one second. Under round 6's visited-class
 * guard — keyed by the symbol alone — the second visit returned early and the
 * PACKAGE reading stood, which is the order-dependence this fixture exists to
 * pin.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

import { TwiceReachedClass } from "./classes.js";

export function twiceReachedFactory(): typeof TwiceReachedClass {
  return TwiceReachedClass;
}
