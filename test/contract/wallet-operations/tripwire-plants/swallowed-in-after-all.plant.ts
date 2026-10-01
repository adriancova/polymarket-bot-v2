// Tripwire plant (WP-300c): a fetch in the file's own `afterAll`, its error swallowed. It runs
// after every test, so no after-each count can see it: the test below passes, and only the setup
// file's after-all count can fail the file. Run only by `../network-tripwire.test.ts`.

import { afterAll, it } from "vitest";

import { PLANTED_URL, requireTripwire } from "./support.js";

afterAll(() => {
  requireTripwire();
  try {
    void fetch(PLANTED_URL);
  } catch {
    // swallowed on purpose: the plant
  }
});

it("passes: the plant runs after it, in afterAll", () => {
  requireTripwire();
});
