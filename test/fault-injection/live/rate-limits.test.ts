/**
 * WP-340 r1 (J4: CX340-R1-02): the mock CLOB's rate limits are the
 * DOCUMENTED ones, pinned through WP-260's REAL secure client
 * (`createSecureVenueClientForTesting`, the sealed mock signer, the fake-SDK
 * seam), so every refusal below is the pinned SDK's own `RateLimitError`
 * classified by WP-260 (`RATE_LIMITED`, effect UNKNOWN).
 *
 * The documented facts (`docs/venue/verified-2026-09-16.md` §8, S-D25,
 * unchanged on 2026-09-30):
 *
 * - "separate order and cancel buckets per signer address": every API key of
 *   one signer draws on the same two buckets. The trader's key and WP-330's
 *   separate emergency key (handoff §15) are two keys of ONE signer, so the
 *   trader's spend is the emergency path's spend;
 * - "a batch is admitted only when the bucket contains enough tokens for
 *   every entry. Otherwise, the entire request is rejected and no entries are
 *   processed";
 * - D-21: "Each request first consumes one cancel token. After the
 *   cancellation result is known, the bucket is debited one additional token
 *   for every order successfully canceled. For tiers that allow a negative
 *   cancel balance, this second debit can put the bucket into debt. Future
 *   cancel requests remain blocked until the bucket has enough tokens for the
 *   next request." Standard allows a negative balance, and
 *   "`Poly-RateLimit-Remaining` can be negative after `DELETE /cancel-all`".
 *
 * What the docs leave open is assumption A9 (`support/mock-clob.ts`, report
 * §3.2). PAPER only: no credential, the mock venue, the tripwire everywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RateLimitObservation, SecureVenueClient } from "../../../packages/polymarket-secure/src/index.js";
import { LIVE_SHAPED_CONTEXT } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createMockSignerHandle, createSecureVenueClientForTesting, installNetworkTripwire, MOCK_SIGNER_ADDRESS, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";

import { STANDARD_TIER } from "./support/mock-clob.js";
import { liveWorld, NO, YES, type LiveWorld } from "./support/live-node.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

interface Keyed {
  readonly client: SecureVenueClient;
  readonly observations: RateLimitObservation[];
}

/** WP-260's real client under one API key of the mock venue, with its sanitized rate-limit observations. */
async function keyed(world: LiveWorld, credential: "trader" | "emergency"): Promise<Keyed> {
  const observations: RateLimitObservation[] = [];
  const client = await createSecureVenueClientForTesting(
    { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle, onRateLimitUpdate: (observation) => void observations.push(observation) },
    world.clob.sdk(credential),
  );
  return { client, observations };
}

/** `count` resting orders of the account placed outside our processes (no bucket is charged for them). */
function foreignOrders(world: LiveWorld, count: number): string[] {
  return Array.from({ length: count }, () => world.clob.placeForeign({ tokenId: YES, side: "BUY", price: "0.2", size: "1" }).venueOrderId);
}

/** Every order of the account the venue rests now (ours and foreign). */
function resting(world: LiveWorld): string[] {
  return [...world.clob.orders.values()].filter((order) => order.status === "LIVE").map((order) => order.venueOrderId);
}

const RATE_LIMITED = { kind: "UNKNOWN", error: expect.objectContaining({ kind: "RATE_LIMITED", effect: "UNKNOWN" }) };

describe("WP-340 r1: the mock CLOB's buckets are per SIGNER, shared by every API key of it (§8)", () => {
  it("the trader key's spent ORDER bucket refuses the emergency key's placement (the same signer): 429, nothing created; one token later it is admitted", async () => {
    const world = await liveWorld();
    const trader = await keyed(world, "trader");
    const emergency = await keyed(world, "emergency");
    expect(trader.client.identity.signerAddress).toBe(MOCK_SIGNER_ADDRESS);
    expect(emergency.client.identity.signerAddress).toBe(MOCK_SIGNER_ADDRESS);
    // The trader's burst drained the signer's order bucket.
    world.clob.drainOrderBucket("trader");
    const signed = await emergency.client.createLimitOrder({ assetId: NO, side: "BUY", price: "0.5", size: "1" });
    if (signed.kind !== "SIGNED") throw new Error(`signing failed: ${JSON.stringify(signed)}`);
    const refused = await emergency.client.postOrder(signed.order);
    expect(refused).toMatchObject(RATE_LIMITED);
    expect(world.clob.orders.size, "nothing was created").toBe(0);
    expect(world.clob.log.filter((entry) => entry.kind === "PLACE").map((entry) => [entry.credential, entry.detail.split(":")[1]])).toEqual([["emergency", "429"]]);
    expect(emergency.observations.at(-1)).toMatchObject({ bucket: "order", remaining: 0, tier: STANDARD_TIER.tier });
    // 40 tokens a second: one token is back after 25 ms, for either key.
    await world.time.advance(25);
    expect(await emergency.client.postOrder(signed.order)).toMatchObject({ kind: "ACCEPTED" });
    expect(world.clob.openOrderIds("emergency")).toHaveLength(1);
    // One bucket pair, the signer's: the mock keys it by the signer address the keys share.
    expect(world.clob.signerOf("trader")).toBe(MOCK_SIGNER_ADDRESS);
    expect(world.clob.signerOf("emergency")).toBe(MOCK_SIGNER_ADDRESS);
  });

  it("the trader key's spent CANCEL bucket blocks the emergency key's cancel-all (the same signer): 429, nothing canceled; one token later it is admitted", async () => {
    const world = await liveWorld({ cancelAllScope: "ACCOUNT" });
    const trader = await keyed(world, "trader");
    const emergency = await keyed(world, "emergency");
    const foreign = foreignOrders(world, 1);
    // The trader's 120 by-id cancels at one instant (each costs one token, canceled or not): the bucket is empty.
    for (let index = 0; index < STANDARD_TIER.cancelBurst; index += 1) expect(await trader.client.cancelOrder("venue-unknown")).toMatchObject({ kind: "COMPLETED" });
    expect(trader.observations.at(-1)).toMatchObject({ bucket: "cancel", remaining: 0 });
    expect(await emergency.client.cancelAll()).toMatchObject(RATE_LIMITED);
    expect(emergency.observations.at(-1), "the emergency key's 429 reports the SHARED bucket").toMatchObject({ bucket: "cancel", remaining: 0 });
    expect(resting(world), "nothing was canceled").toEqual(foreign);
    expect(world.clob.log.at(-1)).toMatchObject({ kind: "CANCEL_ALL", credential: "emergency", detail: "cancel-all:429", effective: false });
    // 80 tokens a second: 12 ms is not yet one token; 13 ms is.
    await world.time.advance(12);
    expect(await emergency.client.cancelAll()).toMatchObject(RATE_LIMITED);
    await world.time.advance(1);
    expect(await emergency.client.cancelAll()).toMatchObject({ kind: "COMPLETED", canceled: foreign });
    expect(resting(world)).toEqual([]);
  });
});

describe("WP-340 r1: D-21, the cancel bucket's admission and its debt (Standard tier)", () => {
  it("the 121st cancel request at one instant is blocked (each cancel-all first consumes one token); one token later it is admitted", async () => {
    const world = await liveWorld();
    const { client } = await keyed(world, "trader");
    for (let index = 0; index < STANDARD_TIER.cancelBurst; index += 1) expect(await client.cancelAll()).toMatchObject({ kind: "COMPLETED", canceled: [] });
    expect(await client.cancelAll(), "request 121 needs a token at the same instant").toMatchObject(RATE_LIMITED);
    await world.time.advance(13);
    expect(await client.cancelAll()).toMatchObject({ kind: "COMPLETED" });
  });

  it("a cancel-all's post-result debit puts the bucket in DEBT (the header's Remaining is negative), and every cancel stays blocked until the balance covers the next request", async () => {
    const world = await liveWorld({ cancelAllScope: "ACCOUNT" });
    const { client, observations } = await keyed(world, "trader");
    foreignOrders(world, 130);
    const swept = await client.cancelAll();
    expect(swept).toMatchObject({ kind: "COMPLETED" });
    expect(swept.kind === "COMPLETED" ? swept.canceled.length : 0).toBe(130);
    // 120 − 1 (up front) − 130 (one per order canceled, once the result is known) = −11: "Remaining can be negative".
    expect(observations.at(-1)).toMatchObject({ bucket: "cancel", remaining: -11, tier: STANDARD_TIER.tier });
    const late = foreignOrders(world, 1);
    // Blocked, by id or by cancel-all, until 12 tokens are back (80/s: 150 ms).
    expect(await client.cancelOrder(late[0] as string)).toMatchObject(RATE_LIMITED);
    await world.time.advance(149);
    expect(await client.cancelAll()).toMatchObject(RATE_LIMITED);
    expect(resting(world), "only the late order rests; nothing was canceled while blocked").toEqual(late);
    await world.time.advance(1);
    expect(await client.cancelOrder(late[0] as string)).toMatchObject({ kind: "COMPLETED", canceled: late });
    expect(world.clob.balance("trader", "cancel"), "exact: 1 token back, then spent").toBe(0);
  });

  it("the same debt after a cancel-market (`DELETE /cancel-market-orders`): one token up front, one per order canceled", async () => {
    const world = await liveWorld();
    const { client, observations } = await keyed(world, "trader");
    foreignOrders(world, 125);
    expect(await client.cancelMarketOrders({ assetId: YES })).toMatchObject({ kind: "COMPLETED" });
    expect(observations.at(-1)).toMatchObject({ bucket: "cancel", remaining: 120 - 1 - 125 });
    const late = foreignOrders(world, 1);
    expect(await client.cancelMarketOrders({ assetId: YES })).toMatchObject(RATE_LIMITED);
    expect(resting(world)).toEqual(late);
  });

  it("a by-id batch (`DELETE /orders`) is admitted only with a token for EVERY id: refused whole, nothing canceled, nothing consumed; the batch that fits passes", async () => {
    const world = await liveWorld();
    const { client, observations } = await keyed(world, "trader");
    const ids = foreignOrders(world, 6);
    for (let index = 0; index < STANDARD_TIER.cancelBurst - 5; index += 1) await client.cancelOrder("venue-unknown");
    expect(observations.at(-1)).toMatchObject({ bucket: "cancel", remaining: 5 });
    expect(await client.cancelOrders(ids)).toMatchObject(RATE_LIMITED);
    expect(resting(world)).toEqual(ids);
    expect(observations.at(-1), "a refused request consumes nothing (A9)").toMatchObject({ bucket: "cancel", remaining: 5 });
    expect(await client.cancelOrders(ids.slice(0, 5))).toMatchObject({ kind: "COMPLETED", canceled: ids.slice(0, 5) });
    expect(world.clob.balance("trader", "cancel")).toBe(0);
  });
});
