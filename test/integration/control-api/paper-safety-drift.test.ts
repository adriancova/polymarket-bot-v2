/**
 * The DRIFT GUARD between `apps/trader`'s ADR-010 §3 name tables and the shared
 * ones in `packages/observability`.
 *
 * `packages/observability/src/control/paper-safety.ts` holds the enumerations
 * so the control API and the dashboard suite can scan against one table.
 * `apps/trader/src/safety.ts` holds its own copy, because F10 forbids one app
 * importing another and `apps/trader/**` is outside `WP-240`'s grant — so the
 * copy could not be collapsed in this round, only pinned.
 *
 * This tree is the one place that may alias both. If a future ADR-010 amendment
 * adds a name to one and not the other, this fails LOUDLY, which is exactly
 * what the interim arrangement owes.
 *
 * The collapse itself is a follow-up on a future `apps/trader` grant.
 */

import { describe, expect, it } from "vitest";

import {
  BUILDER_ATTRIBUTION_NAMES as TRADER_BUILDER,
  CREDENTIAL_NAME_PATTERNS as TRADER_PATTERNS,
  PRODUCTION_ACCOUNT_NAMES as TRADER_ACCOUNT,
  PRODUCTION_SECRET_NAMES as TRADER_SECRET,
  REPOSITORY_MAXIMUM_RUN_MODE as TRADER_CEILING,
} from "@polymarket-bot/trader";
import {
  BUILDER_ATTRIBUTION_NAMES as SHARED_BUILDER,
  CREDENTIAL_NAME_PATTERNS as SHARED_PATTERNS,
  PRODUCTION_ACCOUNT_NAMES as SHARED_ACCOUNT,
  PRODUCTION_SECRET_NAMES as SHARED_SECRET,
} from "@polymarket-bot/observability";
import { REPOSITORY_MAXIMUM_RUN_MODE as CONTROL_CEILING } from "@polymarket-bot/control-api";

describe("the ADR-010 §3 tables do not drift", () => {
  it("secret material: EXACT equality, in order", () => {
    expect([...SHARED_SECRET]).toEqual([...TRADER_SECRET]);
  });

  it("account-identifying names: EXACT equality, in order", () => {
    expect([...SHARED_ACCOUNT]).toEqual([...TRADER_ACCOUNT]);
  });

  it("builder attribution: EXACT equality, in order", () => {
    expect([...SHARED_BUILDER]).toEqual([...TRADER_BUILDER]);
  });

  it("the credential-shaped heuristic patterns: EXACT equality, in order", () => {
    expect([...SHARED_PATTERNS]).toEqual([...TRADER_PATTERNS]);
  });

  it("the guard is not vacuous: the tables are non-empty", () => {
    expect(SHARED_SECRET.length).toBeGreaterThan(5);
    expect(SHARED_ACCOUNT.length).toBeGreaterThan(0);
    expect(SHARED_BUILDER.length).toBeGreaterThan(0);
    expect(SHARED_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe("both processes name the same repository ceiling", () => {
  it("PAPER, in the trader and in the control API alike", () => {
    expect(CONTROL_CEILING).toBe("PAPER");
    expect(TRADER_CEILING).toBe("PAPER");
    expect(CONTROL_CEILING).toBe(TRADER_CEILING);
  });
});
