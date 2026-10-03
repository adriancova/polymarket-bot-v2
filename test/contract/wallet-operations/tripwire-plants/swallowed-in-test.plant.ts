// Tripwire plant (WP-300c): a fetch inside a TEST whose error is swallowed. The test must fail
// (the setup's after-each count) and so must the file (its after-all count). Run only by
// `../network-tripwire.test.ts`.

import { it } from "vitest";

import { PLANTED_URL, requireTripwire } from "./support.js";

it("swallows a fetch made inside the test", () => {
  requireTripwire();
  try {
    void fetch(PLANTED_URL);
  } catch {
    // swallowed on purpose: the plant
  }
});
