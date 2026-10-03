// Tripwire plant (WP-300c), the CONTROL: it calls nothing, so it must pass.
// Run only by `../network-tripwire.test.ts`, through `../network-tripwire.plants.config.ts`.

import { it } from "vitest";

import { requireTripwire } from "./support.js";

it("calls no fetch (the control)", () => {
  requireTripwire();
});
