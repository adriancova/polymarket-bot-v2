/**
 * The wallet-operations contract suite's network tripwire (WP300B-R1-04;
 * WP-300c).
 *
 * `vitest.config.ts` lists this file in `setupFiles`, so it runs in each test
 * file's worker BEFORE that test module (and everything it imports) is
 * loaded: code evaluated at module load is covered, not only code run inside a
 * test (the tripwires it replaces were installed in `beforeEach`, after the
 * module had loaded). From here on `fetch` throws, and every call is counted:
 * - an uncaught call fails where it is made (at module load, the import of the
 *   test file fails, and the whole file with it);
 * - a call whose error is swallowed is caught by the count: after each test,
 *   and once more after the file, the count since module load must be 0.
 * Each test file also asserts that the `fetch` it saw at module load is this
 * tripwire (its mark), so the suite fails if this file stops being loaded
 * first.
 *
 * Both 0-call assertions are load-bearing: `network-tripwire.test.ts` runs
 * this suite's config over planted test files (`tripwire-plants/`) in a child
 * process, and fails unless each swallowed call fails its plant, with the
 * labels below (WP-300c, mutant C-24). Keep the labels and the error message
 * in step with that file.
 *
 * It guards `fetch` only. Node 24's global `WebSocket`, and `node:http`,
 * `node:net` and undici, are not trapped (WP300C-J9): no test file or plant
 * in this suite uses one, and the self-test spawns a local vitest process,
 * which is not a network transport. A file that starts using one needs its
 * own tripwire here first.
 */

import { afterAll, afterEach, expect } from "vitest";

/** The tripwire's mark (a registered symbol: test files check it without importing this file). */
const NETWORK_TRIPWIRE = Symbol.for("polymarket-bot.contract.wallet-operations.network-tripwire");

let calls = 0;

const tripwire = Object.assign(
  (() => {
    calls += 1;
    throw new Error("network tripwire: the wallet-operations contract suite is offline");
  }) as typeof globalThis.fetch,
  { [NETWORK_TRIPWIRE]: true },
);

globalThis.fetch = tripwire;

afterEach(() => {
  expect(calls, "fetch calls since the test module was loaded (module load included)").toBe(0);
});

afterAll(() => {
  expect(calls, "fetch calls in this test file, from module load to its end").toBe(0);
});
