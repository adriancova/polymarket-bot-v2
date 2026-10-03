// Tripwire plant (WP-300c): a fetch at MODULE LOAD whose error is swallowed. Only the setup
// file's 0-call assertions can catch it: the test below must fail (after each test) and so must
// the file (after all its tests). Run only by `../network-tripwire.test.ts`.

import { it } from "vitest";

import { PLANTED_URL, requireTripwire } from "./support.js";

requireTripwire();
try {
  void fetch(PLANTED_URL);
} catch {
  // swallowed on purpose: the plant
}

it("runs after a swallowed fetch at module load", () => {
  requireTripwire();
});
