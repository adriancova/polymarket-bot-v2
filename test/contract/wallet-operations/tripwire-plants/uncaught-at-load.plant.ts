// Tripwire plant (WP-300c): a fetch at MODULE LOAD that nothing catches. The tripwire throws
// synchronously, so the module fails to load with the tripwire's own error and its test never
// runs. Run only by `../network-tripwire.test.ts`.

import { it } from "vitest";

import { PLANTED_URL, requireTripwire } from "./support.js";

requireTripwire();
void fetch(PLANTED_URL); // throws synchronously; not caught

it("never runs: the module fails to load", () => {
  requireTripwire();
});
