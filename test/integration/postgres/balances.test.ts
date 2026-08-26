/**
 * §10.7: "No negative available balance after reservations."
 * §9.14: "Prevent double reservation."
 * ADR-006 §9: reservations constrain availability but are not spends, and every
 * terminal order path releases unused reservations.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain } from "@polymarket-bot/storage-postgres/testing";
import {
  NegativeAvailableBalanceError,
  UniqueViolationError,
  UnknownBalanceError,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("balances");

const ACCOUNT = "test-account";

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
let orderId: string;
let firstReservationId: string;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "balances" });

  orderId = await context.repositories.orders.insertOrder({
    planId: chain.planId,
    executionGroupId: chain.executionGroupId,
    marketId: chain.marketId,
    tokenId: chain.tokenId,
    environment: "PAPER",
    accountRef: ACCOUNT,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "10",
    state: "LIVE",
  });

  await context.repositories.balances.setActualBalance(
    { accountRef: ACCOUNT, environment: "PAPER", assetId: "pUSD" },
    "COLLATERAL",
    "100.5",
  );
});

describe("available balance after reservations", () => {
  it("computes available as actual minus reserved, in canonical decimal strings", async () => {
    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });

    expect(balance?.actualAmount).toBe("100.5");
    expect(balance?.reservedAmount).toBe("0");
    expect(balance?.availableAmount).toBe("100.5");
  });

  it("reduces availability when a reservation is taken", async () => {
    firstReservationId = await context.repositories.balances.reserve({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "40.25",
      orderId,
      planId: chain.planId,
      instanceId: chain.instanceId,
    });

    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });

    expect(balance?.reservedAmount).toBe("40.25");
    expect(balance?.availableAmount).toBe("60.25");
  });

  it("REJECTS a reservation that would drive available below zero", async () => {
    const error = await captureRejection(async () =>
      context.repositories.balances.reserve({
        accountRef: ACCOUNT,
        environment: "PAPER",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "60.250000001",
      }),
    );

    expect(error).toBeInstanceOf(NegativeAvailableBalanceError);
    expect((error as NegativeAvailableBalanceError).constraintName).toBe(
      "balance_projection_no_negative_available",
    );
  });

  it("accepts a reservation for exactly the remaining availability", async () => {
    const reservationId = await context.repositories.balances.reserve({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "60.25",
    });

    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });

    expect(balance?.availableAmount).toBe("0");
    await context.repositories.balances.closeReservation(reservationId, "RELEASED", "test cleanup");
  });

  it("restores availability when a reservation is released (ADR-006 §9)", async () => {
    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.availableAmount).toBe("60.25");
    expect(balance?.reservedAmount).toBe("40.25");
  });

  it("REJECTS a second active reservation for one order and asset (§9.14)", async () => {
    const error = await captureRejection(async () =>
      context.repositories.balances.reserve({
        accountRef: ACCOUNT,
        environment: "PAPER",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "1",
        orderId,
      }),
    );

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraintName).toBe(
      "inventory_reservations_no_double_reservation",
    );
  });

  it("REJECTS a reservation against an asset with no balance row", async () => {
    const error = await captureRejection(async () =>
      context.repositories.balances.reserve({
        accountRef: ACCOUNT,
        environment: "PAPER",
        assetId: "token:unknown",
        assetKind: "OUTCOME_TOKEN",
        amount: "1",
      }),
    );

    expect(error).toBeInstanceOf(UnknownBalanceError);
    expect((error as UnknownBalanceError).sqlState).toBe("PMB09");
  });

  it("REJECTS a rebuild that would lower actual below what is reserved", async () => {
    const error = await captureRejection(async () =>
      context.repositories.balances.setActualBalance(
        { accountRef: ACCOUNT, environment: "PAPER", assetId: "pUSD" },
        "COLLATERAL",
        "40",
      ),
    );

    expect(error).toBeInstanceOf(NegativeAvailableBalanceError);
  });

  it("consumes a reservation on a terminal order path, freeing availability", async () => {
    const consumed = await context.repositories.balances.closeReservation(
      firstReservationId,
      "CONSUMED",
      "order filled",
    );
    expect(consumed).toBe(true);

    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.reservedAmount).toBe("0");
    expect(balance?.availableAmount).toBe("100.5");

    const active = await context.repositories.balances.listActiveReservations(ACCOUNT, "PAPER");
    expect(active).toHaveLength(0);
  });

  it("is idempotent: closing an already-closed reservation changes nothing", async () => {
    const closedAgain = await context.repositories.balances.closeReservation(
      firstReservationId,
      "RELEASED",
      "double release",
    );
    expect(closedAgain).toBe(false);

    const balance = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.reservedAmount).toBe("0");
  });

  it("keeps environments separate (§10.8)", async () => {
    await context.repositories.balances.setActualBalance(
      { accountRef: ACCOUNT, environment: "BACKTEST", assetId: "pUSD" },
      "COLLATERAL",
      "1000",
    );

    const paper = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    const backtest = await context.repositories.balances.findBalance({
      accountRef: ACCOUNT,
      environment: "BACKTEST",
      assetId: "pUSD",
    });

    expect(paper?.actualAmount).toBe("100.5");
    expect(backtest?.actualAmount).toBe("1000");
  });

  it("rejects a non-canonical decimal at the storage boundary (§7.3)", async () => {
    for (const spelling of ["1.50", "01", "+1", "1.", "1e2", "-0"]) {
      const error = await captureRejection(async () =>
        context.pool.query(
          `insert into accounting.balance_projection
             (account_ref, environment, asset_id, asset_kind, actual_amount)
           values ($1, 'PAPER', $2, 'COLLATERAL', $3)`,
          [ACCOUNT, `asset-${spelling}`, spelling],
        ),
      );
      expect((error as { code?: string }).code, spelling).toBe("23514");
    }
  });
});
