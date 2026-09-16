/**
 * The process entry point's ONE throwing seam, driven rather than asserted.
 *
 * Review round 1, MEDIUM-3: `main.ts` carried a bare `throw` inside the venue's
 * `ExecutionPolicy` under a `startup()` docstring that says "Never throws", with
 * a comment claiming the branch was unreachable and no test either way. The
 * throw is the right answer — `timeInForceFor` has no refusal channel and the
 * seam's own rule forbids a default — so what this file establishes is where it
 * GOES: into `SimulatedVenue.submit`'s total boundary, as a refused
 * `ExecutionResult`, never as an exception on the caller's stack.
 *
 * The venue here is the REAL `packages/simulation` one. Nothing is doubled.
 */

import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type PlannedOrderView,
} from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { EXIT_CODES, createExecutionPolicy, type VenueWiring } from "./main.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";
const AT = "2026-03-04T12:00:01.000Z";

function plannedOrderView(): PlannedOrderView {
  return { plannedOrderId: "planned-1" } as unknown as PlannedOrderView;
}

function venueWith(policy: ReturnType<typeof createExecutionPolicy>): SimulatedVenue {
  const fees = readFeeScheduleSnapshot({
    snapshotVersion: "main-test",
    takerFeeRate: "0",
    makerFeeRate: "0",
    roundingDecimalPlaces: 6,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  });
  if (!fees.ok) throw new Error("the test fee snapshot was refused");
  return new SimulatedVenue({
    clock: { now: () => AT, monotonicNs: () => 0n },
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: "tier0/main-test",
      fillModelParametersHash: "a".repeat(64),
    }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue budget is modelled in this unit test"),
    policy,
    startingCash: "1000",
    books: {
      book() {
        return {
          internalMarketId: MARKET,
          tokenId: "111",
          top() {
            return { bestAskPrice: "0.34", bestAskSize: "200" };
          },
          ladder() {
            return [{ price: "0.34", size: "200" }];
          },
        };
      },
    },
  } as unknown as ConstructorParameters<typeof SimulatedVenue>[0]);
}

describe("the process entry point's execution policy", () => {
  it("answers the TRADER's recorded time-in-force, never a default", () => {
    const wiring = {
      trader: { loop: { timeInForceFor: () => "GTC" } },
    } as unknown as VenueWiring;
    const policy = createExecutionPolicy(wiring, () => undefined);
    expect(policy.timeInForceFor(plannedOrderView())).toBe("GTC");
  });

  it("LOGS and throws when no answer was recorded — there is no safe value here", () => {
    const lines: string[] = [];
    const policy = createExecutionPolicy({ trader: undefined }, (line) => lines.push(line));
    expect(() => policy.timeInForceFor(plannedOrderView())).toThrow(
      /refuses to assume one/u,
    );
    // The operator sees WHICH order, on the process's own log, rather than only
    // a refusal code on the venue seam.
    expect(lines.join("\n")).toContain("planned-1");
    expect(lines.join("\n")).toContain("SUBMISSION REFUSED");
  });

  it("the throw is CONTAINED by the real venue: a refused result, not a rejected promise", async () => {
    const policy = createExecutionPolicy({ trader: undefined }, () => undefined);
    const venue = venueWith(policy);
    venue.observe({
      gatewayEpoch: EPOCH,
      ingestSeq: "1",
      receivedAt: AT,
      datasetRowOrdinal: 1,
    });

    const result = await venue.submit({
      executionPlanId: "018f4a7e-6666-7abc-8def-000000000001",
      planKind: "PLACE",
      runMode: "PAPER",
      accountingMode: "LIVE",
      groups: [
        {
          marketId: MARKET,
          orders: [
            {
              plannedOrderId: "planned-1",
              tokenId: "111",
              side: "YES",
              action: "BUY",
              limitPrice: "0.34",
              shares: "10",
              executionStyle: "MARKETABLE_LIMIT",
              postOnly: false,
            },
          ],
        },
      ],
      reservations: [],
    } as unknown as Parameters<SimulatedVenue["submit"]>[0]);

    // The promise RESOLVED, and the answer is a refusal with a code — which is
    // exactly what `startup()`'s "never throws" rests on.
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBeDefined();
    expect(result.orders).toEqual([]);
    expect(result.fills).toEqual([]);
  });

  it("states NOT_OBSERVED for same-instant additions, because it observed nothing", () => {
    const policy = createExecutionPolicy({ trader: undefined }, () => undefined);
    expect(policy.sameInstantAdditionsFor()).toBe("NOT_OBSERVED");
    expect(policy.statedExpiryNsFor()).toBeUndefined();
  });

  it("the exit codes an operator scripts against are stable", () => {
    expect(EXIT_CODES.ok).toBe(0);
    expect(EXIT_CODES.unsafeEnvironment).toBe(78);
    expect(EXIT_CODES.configurationRefused).toBe(78);
    expect(EXIT_CODES.halted).toBe(75);
    // `BOOT-1`: the database could not answer the registration check.
    expect(EXIT_CODES.infrastructureUnavailable).toBe(69);
  });
});
