/**
 * Runner for the network tripwire's plants (WP-300c). It is not a suite of its
 * own and no gate runs it directly: `network-tripwire.test.ts` runs it in a
 * child process and checks each plant's result.
 *
 * It is this suite's config, `vitest.config.ts`, imported as it is (root,
 * setup file and all), with `include` narrowed to the plants:
 * `tripwire-plants/*.plant.ts`. Those files call `fetch` on purpose, and most
 * of them are expected to FAIL. The suite's own `include` matches `.test.ts`
 * files only, so it never picks them up, and no other config does either.
 */

import { defineConfig } from "vitest/config";

import suite from "./vitest.config.js";

export default defineConfig({
  ...suite,
  test: {
    ...suite.test,
    include: ["test/contract/wallet-operations/tripwire-plants/*.plant.ts"],
  },
});
