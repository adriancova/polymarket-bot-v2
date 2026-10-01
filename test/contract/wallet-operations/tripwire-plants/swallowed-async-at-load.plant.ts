// Tripwire plant (WP-300c): a fetch from a microtask queued at MODULE LOAD, its rejection
// swallowed. Only the setup file's 0-call assertions can catch it: the test below must fail
// (after each test) and so must the file (after all its tests). Run only by
// `../network-tripwire.test.ts`.

import { it } from "vitest";

import { PLANTED_URL, requireTripwire } from "./support.js";

requireTripwire();
void Promise.resolve()
  .then(() => fetch(PLANTED_URL))
  .catch(() => undefined);

it("runs after a swallowed fetch from a microtask queued at module load", () => {
  requireTripwire();
});
