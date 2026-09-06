/**
 * The RUNTIME half of the WP-040 vocabulary pin.
 *
 * `vocabulary.ts` pins the two arrays to `packages/storage-postgres`'s types at
 * COMPILE time (`satisfies`), which catches a value the enum does not admit. It
 * cannot catch the other direction: a scope the database knows and this API
 * cannot express is a control an operator would look for and not find, and no
 * `satisfies` sees that.
 *
 * So this file imports the VALUES and asserts set equality both ways. It is a
 * separate file because importing the `packages/storage-postgres` barrel loads
 * `pg` and `kysely`, and only the test that needs them should pay for it — the
 * production modules use `import type`, which `verbatimModuleSyntax` erases.
 *
 * NO DATABASE IS REACHED. This reads two exported arrays.
 */

import { describe, expect, it } from "vitest";

import {
  ACTOR_KINDS,
  KILL_SWITCH_ACTIONS,
  KILL_SWITCH_SCOPES,
} from "@polymarket-bot/storage-postgres";

import {
  CONTROL_ACTOR_KIND,
  CONTROL_KILL_SWITCH_ACTIONS,
  CONTROL_KILL_SWITCH_SCOPES,
} from "./vocabulary.js";

describe("the control vocabulary matches the WP-040 database enums", () => {
  it("scopes: EXACT set equality, both directions", () => {
    expect([...CONTROL_KILL_SWITCH_SCOPES].sort()).toEqual([...KILL_SWITCH_SCOPES].sort());
  });

  it("actions: EXACT set equality, both directions", () => {
    expect([...CONTROL_KILL_SWITCH_ACTIONS].sort()).toEqual([...KILL_SWITCH_ACTIONS].sort());
  });

  it("the actor kind is one the ops tables admit", () => {
    expect([...ACTOR_KINDS]).toContain(CONTROL_ACTOR_KIND);
  });

  it("this API offers only the HUMAN actor kind, and that is a CHOICE", () => {
    // §10.6 also admits AUTOMATED. Asserted so the omission is visible as a
    // decision rather than read as an oversight: this deployment issues
    // operator credentials to people, and an AUTOMATED actor would be a
    // machine credential nobody has asked for.
    expect([...ACTOR_KINDS]).toEqual(["HUMAN", "AUTOMATED"]);
    expect(CONTROL_ACTOR_KIND).toBe("HUMAN");
  });
});
