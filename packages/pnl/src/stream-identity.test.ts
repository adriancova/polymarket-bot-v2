/**
 * The PnL stream identity (review round 1, HIGH-2), engine side.
 *
 * `accounting.pnl_snapshots` (§10.5) requires `scope`, `environment`, and a
 * NOT NULL `account_ref`, and keys its rows by
 * `(scope, environment, account_ref, instance_id, market_id, as_of)`. Before
 * this round a stream knew only its owner — and a virtual owner knew only an
 * `instanceId` — so a composition root could not write a row without
 * inventing the environment and the account. In a monetary table, under a
 * PAPER/LIVE discriminator, "invent it" is not an option.
 *
 * The column-by-column agreement with the migration is pinned in the
 * cross-package suite (`test/unit/ledger/wp040-persistence-shape.test.ts`).
 * This suite pins the engine's half: a stream must STATE the identity, records
 * must belong to it, and every snapshot row reports it unchanged.
 */

import { describe, expect, it } from "vitest";

import { PnlOwnerSchema, PnlStreamIdentitySchema, pnlOwnerOf } from "./records.js";
import { PnlConfigurationError } from "./refusals.js";
import { computePnlSnapshot } from "./snapshot.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import {
  ACCOUNT,
  ACCOUNT_STREAM,
  ENVIRONMENT,
  INSTANCE_A,
  INSTANCE_B,
  INSTANCE_STREAM,
  MARKET_A,
  PUSD,
  RUN_A,
  TIMESTAMP,
  UNATTRIBUTED_STREAM,
  YES_TOKEN,
  buy,
  fee,
} from "./testing/samples.js";

const OTHER_ACCOUNT = "acct-paper-2";

describe("a stream states the identity its rows are written under", () => {
  it("refuses to open without an environment", () => {
    const withoutEnvironment: Record<string, unknown> = { ...INSTANCE_STREAM };
    delete withoutEnvironment["environment"];
    expect(() => emptyPnlState(withoutEnvironment as never)).toThrow(PnlConfigurationError);
  });

  it("refuses to open without an account, for a strategy stream as much as any other", () => {
    const withoutAccount: Record<string, unknown> = { ...INSTANCE_STREAM };
    delete withoutAccount["accountRef"];
    expect(() => emptyPnlState(withoutAccount as never)).toThrow(PnlConfigurationError);
  });

  it("refuses an unknown environment rather than defaulting one", () => {
    expect(() =>
      emptyPnlState({ ...INSTANCE_STREAM, environment: "PRODUCTION" } as never),
    ).toThrow(PnlConfigurationError);
  });

  it("refuses a non-canonical instance id, carrying nothing forward (ADR-016 §2)", () => {
    expect(() =>
      emptyPnlState({ ...INSTANCE_STREAM, instanceId: INSTANCE_A.toUpperCase() } as never),
    ).toThrow(PnlConfigurationError);
  });

  it("carries the identity and its owner half on the state", () => {
    const state = emptyPnlState(INSTANCE_STREAM);
    expect(state.identity).toEqual(INSTANCE_STREAM);
    expect(state.owner).toEqual({
      scope: "VIRTUAL_STRATEGY",
      accountRef: ACCOUNT,
      instanceId: INSTANCE_A,
    });
    expect(PnlOwnerSchema.safeParse(state.owner).success).toBe(true);
  });

  it("derives the owner half of every scope", () => {
    expect(pnlOwnerOf(ACCOUNT_STREAM)).toEqual({ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT });
    expect(pnlOwnerOf(UNATTRIBUTED_STREAM)).toEqual({
      scope: "UNATTRIBUTED",
      accountRef: ACCOUNT,
    });
  });

  it("accepts the optional run and market scoping, and only those", () => {
    expect(
      PnlStreamIdentitySchema.safeParse({ ...INSTANCE_STREAM, runId: RUN_A, marketId: MARKET_A })
        .success,
    ).toBe(true);
    expect(
      PnlStreamIdentitySchema.safeParse({ ...INSTANCE_STREAM, tradingDesk: "x" }).success,
    ).toBe(false);
  });
});

describe("a record belongs to one account's stream", () => {
  it("refuses the same instance's record booked in another account", () => {
    const foreign = buy(1, "10", "0.4", {
      scope: "VIRTUAL_STRATEGY",
      accountRef: OTHER_ACCOUNT,
      instanceId: INSTANCE_A,
    });
    const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), foreign);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_OWNER_MISMATCH");
    expect(result.refusals[0]?.details).toMatchObject({
      stateOwner: { accountRef: ACCOUNT, instanceId: INSTANCE_A },
      recordOwner: { accountRef: OTHER_ACCOUNT, instanceId: INSTANCE_A },
    });
  });

  it("refuses another instance's record in the same account", () => {
    const foreign = buy(1, "10", "0.4", {
      scope: "VIRTUAL_STRATEGY",
      accountRef: ACCOUNT,
      instanceId: INSTANCE_B,
    });
    expect(applyPnlRecord(emptyPnlState(INSTANCE_STREAM), foreign).ok).toBe(false);
  });

  it("refuses a strategy record with no account at all", () => {
    const accountless = {
      ...buy(1, "10", "0.4"),
      owner: { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_A },
    };
    const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), accountless);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_INPUT_INVALID");
  });
});

describe("every snapshot row reports the identity unchanged", () => {
  it("stamps scope, environment, account, instance, run, and market on each row", () => {
    const folded = foldPnlRecords({ ...INSTANCE_STREAM, runId: RUN_A, marketId: MARKET_A }, [
      buy(1, "10", "0.4"),
      fee(2, "0.05", "fees-v1"),
    ]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) {
      return;
    }
    const rows = computePnlSnapshot(folded.value, {
      asOf: TIMESTAMP,
      marks: { [YES_TOKEN]: { midpoint: "0.5" } },
    });
    expect(rows.ok).toBe(true);
    if (!rows.ok) {
      return;
    }
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]).toMatchObject({
      scope: "VIRTUAL_STRATEGY",
      environment: ENVIRONMENT,
      accountRef: ACCOUNT,
      instanceId: INSTANCE_A,
      runId: RUN_A,
      marketId: MARKET_A,
      denominationAsset: PUSD,
      asOf: TIMESTAMP,
    });
  });

  it("reports a null instance for a non-strategy stream, never an empty string", () => {
    const folded = foldPnlRecords(ACCOUNT_STREAM, [
      fee(1, "0.05", undefined, { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT }),
    ]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) {
      return;
    }
    const rows = computePnlSnapshot(folded.value, { asOf: TIMESTAMP, marks: {} });
    expect(rows.ok).toBe(true);
    if (!rows.ok) {
      return;
    }
    expect(rows.value[0]).toMatchObject({
      scope: "ACTUAL_ACCOUNT",
      accountRef: ACCOUNT,
      instanceId: null,
      runId: null,
      marketId: null,
    });
  });
});
