/**
 * Contract: sanitized venue order-response fixtures → the PINNED SDK's own
 * response parser (`@polymarket/client@0.11.0` → `@polymarket/bindings`
 * `OrderResponseSchema`) → the secure client's placement outcome.
 *
 * Fixture: `test/fixtures/venue/orders/order-responses.json` (docs
 * `trading/place-orders`, retrieved 2026-08-24; venue report 2026-09-30 §2.2
 * UNCHANGED). Plus one documented example quoted verbatim in the 2026-09-30
 * report §2.2 (the batch per-entry rate-limit rejection, S-D50 line 140).
 *
 * What this pins about the SDK, as observed (not as the docs say):
 * - `live` / `matched` / `delayed` are accepted placements;
 * - `unmatched` — "placement still succeeded" per the docs (ADR-007 §5) — is
 *   turned by the SDK into `{ ok: false, code: "unmatched" }` WITHOUT the
 *   order id (conflict C-6 as the SDK resolves it). The client maps it to
 *   UNKNOWN (`SDK_UNMATCHED`), never to a rejection;
 * - only `not enough balance / allowance` among the fixture's error texts is
 *   classified by the SDK; the others become `unknown` → UNKNOWN (U-4).
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlacementOutcome } from "../../../packages/polymarket-secure/src/index.js";
import {
  answerAsPinnedSdk,
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  parseOrderResponseWithPinnedSdk,
  type NetworkTripwire,
} from "../../../packages/polymarket-secure/src/testing/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../fixtures/venue/orders/order-responses.json");
const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });

interface FixtureFile {
  readonly fixture: string;
  readonly sanitized: boolean;
  readonly examples: readonly { readonly name: string; readonly payload: Record<string, unknown> }[];
}

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  expect(tripwire.answered()).toEqual([]);
});

async function outcomeFor(raw: unknown): Promise<PlacementOutcome> {
  const { factory } = createFakeSdkFactory({ postOrder: () => answerAsPinnedSdk(raw) });
  const client = await createSecureVenueClientForTesting({ runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle }, factory);
  const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
  if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
  return client.postOrder(signed.order);
}

const EXPECTED: Readonly<Record<string, PlacementOutcome>> = {
  "limit-live": {
    kind: "ACCEPTED",
    orderId: "0x00000000000000000000000000000000000000000000000000000000feed0001",
    status: "LIVE",
    makingAmount: "0",
    takingAmount: "0",
    tradeIds: [],
    transactionHashes: [],
  },
  "limit-matched": {
    kind: "ACCEPTED",
    orderId: "0x00000000000000000000000000000000000000000000000000000000feed0004",
    status: "MATCHED",
    makingAmount: "3200000",
    takingAmount: "40000000",
    tradeIds: ["00000000-0000-0000-0000-00000000t001"],
    transactionHashes: ["0x0000000000000000000000000000000000000000000000000000000000c0ffee"],
  },
  "market-delayed-pending-not-filled": {
    kind: "ACCEPTED",
    orderId: "0x00000000000000000000000000000000000000000000000000000000feed0002",
    status: "DELAYED",
    makingAmount: "0",
    takingAmount: "0",
    tradeIds: [],
    transactionHashes: [],
  },
  "market-unmatched-placement-succeeded": { kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null },
  "error-insufficient-balance-or-allowance": { kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" },
  "error-tick-size-violation": { kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null },
  "error-below-min-order-size": { kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null },
  "error-gtd-expiration-too-soon": { kind: "UNKNOWN", reason: "SDK_UNKNOWN_CODE", error: null },
};

describe("orders/order-responses fixture through the pinned SDK and the secure client", async () => {
  const file = JSON.parse(await readFile(FIXTURE, "utf8")) as FixtureFile;

  it("is the sanitized fixture this suite was written against, and every example has an expectation", () => {
    expect(file.fixture).toBe("orders/order-responses");
    expect(file.sanitized).toBe(true);
    expect(file.examples.map((example) => example.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(file.examples.map((example) => [example.name, example.payload] as const))("%s", async (name, payload) => {
    expect(await outcomeFor(payload)).toEqual(EXPECTED[name]);
  });

  it("the pinned SDK drops the order id of the documented `unmatched` success (why UNKNOWN is the only safe mapping)", async () => {
    const example = file.examples.find((entry) => entry.name === "market-unmatched-placement-succeeded");
    expect(example?.payload["orderID"]).toMatch(/^0x[0-9a-f]{64}$/u);
    const parsed = await parseOrderResponseWithPinnedSdk(example?.payload);
    expect(parsed).toEqual({ ok: true, value: { ok: false, code: "unmatched", message: "Unknown order failure" } });
  });

  it("no rejection message (venue free text) is carried into any outcome", async () => {
    for (const example of file.examples) {
      const text = JSON.stringify(await outcomeFor(example.payload));
      const errorMsg = example.payload["errorMsg"];
      if (typeof errorMsg === "string" && errorMsg !== "") expect(text).not.toContain(errorMsg);
    }
  });
});

describe("documented examples quoted in the 2026-09-30 venue report", () => {
  it("§2.2 batch entry {success:false, status:'delayed', errorMsg:'Rate limit exceeded…'} without amounts is UNKNOWN, never ACCEPTED/DELAYED", async () => {
    // Verbatim from S-D50 line 140 as quoted in the report; the SDK schema
    // requires makingAmount/takingAmount, so the SDK reports an unexpected
    // response and the client cannot say whether the order exists.
    const outcome = await outcomeFor({
      success: false,
      orderID: "",
      status: "delayed",
      errorMsg: "Rate limit exceeded for tokenId: 0xdef456abc789...",
    });
    expect(outcome).toMatchObject({ kind: "UNKNOWN", reason: "ERROR", error: { kind: "UNEXPECTED_RESPONSE", effect: "UNKNOWN" } });
  });

  it("§9 post-only batch entry (success:true with a non-empty errorMsg) is REJECTED POST_ONLY_MODE, not ACCEPTED", async () => {
    // CONSTRUCTED, not quoted: the report documents the KIND (§9: batch
    // post-only entries carry "success": true and a non-empty errorMsg) and
    // the post-only error string, but does not quote a full entry. The other
    // fields follow the fixture's documented failure shape.
    const outcome = await outcomeFor({
      success: true,
      errorMsg: "post-only mode: only post-only orders and cancels are allowed",
      orderID: "",
      status: "",
      makingAmount: "",
      takingAmount: "",
    });
    expect(outcome).toEqual({ kind: "REJECTED", reason: "POST_ONLY_MODE" });
  });
});
