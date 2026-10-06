/**
 * WP-340: the mock CLOB models ONLY documented behaviour, and says so. Each
 * figure or shape it acts on is pinned here to the dated venue reports
 * (`docs/venue/verified-2026-09-16.md`, `verified-2026-09-30.md`), quoted
 * VERBATIM (whitespace normalized: the reports wrap their lines), and to the
 * constant the product itself acts on, so the mock and the packages cannot
 * drift apart silently. Every assumption the mock makes where the venue
 * documents nothing (A1–A9 in `support/mock-clob.ts`) must be listed, by id,
 * in the security and recovery report.
 *
 * Pure text and constants: nothing reaches a network or a venue (the tripwire
 * is installed all the same).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEARTBEAT_CADENCE_MS, HEARTBEAT_TIMEOUT_MS as PRODUCT_TIMEOUT_MS, VENUE_CANCELLATION_CHECK_INTERVAL_MS } from "../../../packages/polymarket-secure/src/heartbeat/index.js";
import { MAX_CANCEL_IDS_PER_REQUEST, MAX_ORDERS_PER_BATCH } from "../../../packages/polymarket-secure/src/index.js";
import { DOCUMENTED_NOT_CANCELED_REASONS } from "../../../packages/polymarket-secure/src/outcomes.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { PING_INTERVAL_MS } from "../../../packages/polymarket-secure/src/user-stream/index.js";

import { CANCELLATION_CHECK_MS, HEARTBEAT_TIMEOUT_MS, MAX_BATCH_ORDERS, MAX_CANCEL_IDS, POST_ONLY_AFTER_RESTART_MS, STANDARD_TIER } from "./support/mock-clob.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const normalized = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8").replace(/\s+/gu, " ");
const R0916 = normalized("docs/venue/verified-2026-09-16.md");
const R0930 = normalized("docs/venue/verified-2026-09-30.md");
const quote = (text: string): string => text.replace(/\s+/gu, " ");

describe("WP-340: every behaviour the mock CLOB acts on is documented, and agrees with the product's own constant", () => {
  it("the order heartbeat: 10 s without a valid heartbeat cancels the credentials' open orders; the check runs every 5 s; send every 5 s (S-D17)", () => {
    expect(R0916).toContain(
      quote(
        "if a valid heartbeat is not received within 10 seconds, all open orders owned by those CLOB API credentials are canceled. The cancellation check runs every five seconds, so cancellation may occur up to five seconds after the timeout.",
      ),
    );
    expect(R0916).toContain(quote('Send a heartbeat every **5 seconds**.'));
    expect(HEARTBEAT_TIMEOUT_MS).toBe(10_000);
    expect(CANCELLATION_CHECK_MS).toBe(5_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(PRODUCT_TIMEOUT_MS);
    expect(CANCELLATION_CHECK_MS).toBe(VENUE_CANCELLATION_CHECK_INTERVAL_MS);
    expect(HEARTBEAT_CADENCE_MS).toBe(5_000);
    // Unchanged on 2026-09-30, by digest.
    expect(R0930).toContain(quote("Every heartbeat statement quoted in VENUE-2 §5 is re-verified by digest"));
  });

  it("the heartbeat id chain: an empty id to start, each success returns the next, an invalid id gets 400 with the expected one (S-D17)", () => {
    expect(R0916).toContain(quote('Send an empty `heartbeat_id` to `POST /v1/heartbeats`'));
    expect(R0916).toContain(quote("Each successful response returns a new ID to use for the following heartbeat"));
    expect(R0916).toContain(quote('`{"error_msg": "Invalid Heartbeat ID", "heartbeat_id": "<expected_heartbeat_id>"}`'));
  });

  it("the restart: 425 on order-related requests, an optional Retry-After, then post-only for two minutes; cancels available (§9, E-06)", () => {
    expect(R0930).toContain(quote("An order-related request returns HTTP `425` while the matching engine is restarting. Honor `Retry-After` when the response includes it"));
    expect(R0930).toContain(quote("enters post-only mode for two minutes: cancels remain available, but new orders must be eligible maker orders submitted as post-only"));
    expect(R0930).toContain(quote('{"error": "post-only mode: only post-only orders and cancels are allowed", "code": "post_only_mode", "retry_after_seconds": 79}'));
    expect(R0930).toContain(quote('"Do not retry the same non-post-only order unchanged."'));
    expect(POST_ONLY_AFTER_RESTART_MS).toBe(120_000);
  });

  it("cancel-only and disabled trading answer the same 503, and cancels work in cancel-only mode (§9 E-05, §2.5)", () => {
    expect(R0930).toContain(quote('`{"error": "trading is disabled"}`'));
    expect(R0930).toContain(quote("return the same trading-disabled response in cancel-only and fully disabled modes"));
    expect(R0930).toContain(quote('each "Works even in cancel-only mode"'));
  });

  it("batch limits: 1 to 15 placements; at most 1,000 ids per batch cancel (C-11, the lower figure)", () => {
    expect(R0916).toContain(quote("accepts between **1 and 15** signed orders per call"));
    expect(R0930).toContain(quote("**`DELETE /orders` `maxItems: 1000`**"));
    expect(MAX_BATCH_ORDERS).toBe(MAX_ORDERS_PER_BATCH);
    expect(MAX_CANCEL_IDS).toBe(MAX_CANCEL_IDS_PER_REQUEST);
  });

  it("cancel answers: `{canceled, not_canceled}` with the documented reasons, which WP-260 carries verbatim", () => {
    expect(R0930).toContain(quote('response `{canceled: [...], not_canceled: {"<id>": "<reason>"}}` with documented example reasons "Order not found or already canceled", "Order already matched", "Order not found", "Order already canceled"'));
    for (const reason of ["Order not found or already canceled", "Order already matched", "Order not found", "Order already canceled"]) expect(DOCUMENTED_NOT_CANCELED_REASONS).toContain(reason);
  });

  it("the user channel: PING every 10 s answered PONG; no replay after a disconnection (§4)", () => {
    expect(R0916).toContain(quote("Send the text frame `PING` every 10 seconds; the server replies with `PONG`."));
    expect(R0916).toContain(quote("Real-time updates do not replace authoritative account reads or replay every change missed during a disconnection."));
    expect(PING_INTERVAL_MS).toBe(10_000);
  });

  it("reads: an order absent from the open list is not proof of cancellation; by id the venue returns it regardless of status (E-14)", () => {
    expect(R0930).toContain(quote("Filtering by id returns that order regardless of status, including canceled or fully matched orders."));
  });

  it("rate limits: the Standard tier's per-signer buckets are the dated snapshot's (§8, unchanged on 2026-09-30); the five documented headers", () => {
    const snapshot = JSON.parse(readFileSync(path.join(REPO_ROOT, "test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json"), "utf8")) as {
      readonly signerTiers: readonly { readonly tier: string; readonly orderBurst: number; readonly orderTokensPerSecond: number; readonly cancelBurst: number; readonly cancelTokensPerSecond: number; readonly negativeCancelBalance: boolean }[];
    };
    const standard = snapshot.signerTiers.find((tier) => tier.tier === "Standard");
    expect(standard).toMatchObject({ orderBurst: STANDARD_TIER.orderBurst, orderTokensPerSecond: STANDARD_TIER.orderPerSecond, cancelBurst: STANDARD_TIER.cancelBurst, cancelTokensPerSecond: STANDARD_TIER.cancelPerSecond, negativeCancelBalance: true });
    expect(R0930).toContain(quote("every IP limit, the six trading dual limits, the eight per-signer tiers, the negative-cancel-balance rule"));
  });

  it("rate limits: the buckets are per SIGNER ADDRESS, and a batch is admitted only with a token for every entry (§8, S-D25); J4, WP-340 r1", () => {
    expect(R0916).toContain(quote("separate order and cancel buckets per signer address"));
    expect(R0916).toContain(quote("a batch is admitted only when the bucket contains enough tokens for every entry. Otherwise, the entire request is rejected and no entries are processed."));
  });

  it("D-21: one cancel token first, then one per order canceled once the result is known; debt allowed on Standard; later cancels blocked until the bucket covers the next request (§8); J4, WP-340 r1", () => {
    expect(R0916).toContain(
      quote(
        "Each request first consumes one cancel token. After the cancellation result is known, the bucket is debited one additional token for every order successfully canceled. For tiers that allow a negative cancel balance, this second debit can put the bucket into debt. Future cancel requests remain blocked until the bucket has enough tokens for the next request.",
      ),
    );
    expect(R0916).toContain(quote("`Poly-RateLimit-Remaining` can be negative after `DELETE /cancel-all` or `DELETE /cancel-market-orders` for tiers that allow a negative cancel balance."));
    // The mock's tier is one that allows the debt.
    expect(STANDARD_TIER.tier).toBe("Standard");
  });

  it("every undocumented behaviour the mock assumes (A1–A9) is listed, by id, in the security and recovery report", () => {
    const mock = readFileSync(path.join(REPO_ROOT, "test/fault-injection/live/support/mock-clob.ts"), "utf8");
    const ids = [...mock.matchAll(/^ \* - (A[0-9]+): /gmu)].map((match) => match[1] as string);
    // A8 (the push timing, J7) and A9 (the rate-limit details the docs leave open, J4) were added in WP-340 r1.
    expect(ids).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]);
    const report = readFileSync(path.join(REPO_ROOT, "docs/experiments/phase-3-verification.md"), "utf8");
    for (const id of ids) expect(report, id).toMatch(new RegExp(`\\| ${id} \\|`, "u"));
  });
});
