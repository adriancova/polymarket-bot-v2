/**
 * Contract: the documented snapshots in `./fixtures/` are what the venue
 * documents, value for value (WP-310 acceptance 3: "Limits are configuration
 * snapshots, not constants").
 *
 * - Every venue number in the rate-limit snapshot is tied to the text of the
 *   dated report that recorded it (`verified-2026-09-16.md` §8, unchanged on
 *   2026-09-30 §8), quoted below and checked to appear there verbatim.
 * - The tiers and trading dual limits also match the frozen venue fixture
 *   `test/fixtures/venue/rate-limits/rate-limits.json` value for value
 *   ("`rate-limits.json` matches value-for-value", 2026-09-16 §8).
 * - The restricted-mode snapshot's venue durations are tied to their quotes.
 * - Both snapshots carry a source and an effective time, and both parse.
 *
 * OFFLINE: every test installs WP-260's network tripwire; none may be refused.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseRestrictedModeConfiguration, type RestrictedModeConfiguration } from "../../../packages/oms/src/index.js";
import { parseRateLimitConfiguration, type RateLimitConfiguration } from "../../../packages/polymarket-secure/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";

import { RATE_LIMIT_SNAPSHOT_PATH, RESTRICTED_MODE_SNAPSHOT_PATH, normalized, readJson, readRepoText, venueExample } from "./support.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const REPORT_0916 = normalized(readRepoText("docs/venue/verified-2026-09-16.md"));
const REPORT_0930 = normalized(readRepoText("docs/venue/verified-2026-09-30.md"));

function rateLimits(): RateLimitConfiguration {
  const parsed = parseRateLimitConfiguration(readJson(RATE_LIMIT_SNAPSHOT_PATH));
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.value;
}

function modes(): RestrictedModeConfiguration {
  const parsed = parseRestrictedModeConfiguration(readJson(RESTRICTED_MODE_SNAPSHOT_PATH));
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.value;
}

/** Each IP class's windows, and the 2026-09-16 §8 text that states them. */
const IP_CLASSES: readonly [string, readonly (readonly [number, number])[], string][] = [
  ["general", [[15_000, 10_000]], "General 15,000/10s"],
  ["clob.general", [[9000, 10_000]], "CLOB general 9,000/10s"],
  ["clob.balance_allowance_get", [[200, 10_000]], "CLOB balance-allowance 200/10s GET and 50/10s update"],
  ["clob.balance_allowance_update", [[50, 10_000]], "CLOB balance-allowance 200/10s GET and 50/10s update"],
  ["clob.book", [[1500, 10_000]], "market data `/book`, `/price`, `/midpoint` 1,500/10s"],
  ["clob.books", [[500, 10_000]], "`/books`, `/prices`, `/midpoints` 500/10s"],
  ["clob.ledger", [[900, 10_000]], "ledger 900/10s"],
  ["clob.data_orders", [[500, 10_000]], "`/data/orders`, `/data/trades` 500/10s"],
  ["clob.data_trades", [[500, 10_000]], "`/data/orders`, `/data/trades` 500/10s"],
  ["clob.auth", [[100, 10_000]], "auth 100/10s"],
  ["clob.post_order", [[5000, 10_000], [120_000, 600_000]], "`POST /order` 5,000/10s + 120,000/10min"],
  ["clob.delete_order", [[5000, 10_000], [120_000, 600_000]], "`DELETE /order` 5,000/10s + 120,000/10min"],
  ["clob.post_orders", [[2000, 10_000], [21_000, 600_000]], "`POST /orders` 2,000/10s + **21,000**/10min"],
  ["clob.delete_orders", [[2000, 10_000], [15_000, 600_000]], "`DELETE /orders` 2,000/10s + **15,000**/10min"],
  ["clob.cancel_all", [[250, 10_000], [6000, 600_000]], "`DELETE /cancel-all` 250/10s + 6,000/10min"],
  ["clob.cancel_market_orders", [[1500, 10_000], [21_000, 600_000]], "`DELETE /cancel-market-orders` 1,500/10s + 21,000/10min"],
  ["gamma.general", [[4000, 10_000]], "Gamma general 4,000/10s"],
  ["gamma.events", [[500, 10_000]], "(`/events` 500,"],
  ["gamma.markets", [[300, 10_000]], "`/markets` 300,"],
  ["gamma.listing", [[900, 10_000]], "combined listing 900"],
  ["gamma.public_search", [[350, 10_000]], "`/public-search` 350"],
  ["data.v2.general", [[800, 10_000]], '"General (all `/v2` endpoints)" 800/10s'],
  ["data.v2.trades", [[300, 10_000]], "`/v2/trades` 300/10s"],
  ["data.v2.positions", [[200, 10_000]], "`/v2/positions`, `/v2/positions/combos` 200/10s"],
];

describe("the documented rate-limit snapshot", () => {
  const config = rateLimits();

  it("parses, with its source documents and its effective time", () => {
    expect(config.effectiveFrom).toBe("2026-09-30T05:12:03Z");
    expect(config.source.documents.map((doc) => doc.url)).toEqual([
      "https://docs.polymarket.com/api-reference/rate-limits.md",
      "https://docs.polymarket.com/api-reference/trading-rate-limits.md",
    ]);
    // The retrieval instants are the report's own source-index rows S-D24 and S-D25.
    expect(REPORT_0930).toContain("| S-D24 | `https://docs.polymarket.com/api-reference/rate-limits.md` | 2026-09-30T05:12:02Z |");
    expect(REPORT_0930).toContain("| S-D25 | `https://docs.polymarket.com/api-reference/trading-rate-limits.md` | 2026-09-30T05:12:03Z |");
    expect(REPORT_0930).toContain("limits stay configuration snapshots (unchanged values, effective 2026-09-30)");
  });

  it.each(IP_CLASSES)("IP class %s matches the report", (classId, windows, quote) => {
    expect(REPORT_0916).toContain(normalized(quote));
    const entry = config.ipEndpointClasses.find((candidate) => candidate.classId === classId);
    expect(entry?.windows.map((window) => [window.limit, window.windowMs])).toEqual(windows);
  });

  it("declares no IP class the table above does not tie to the report", () => {
    expect(config.ipEndpointClasses.map((entry) => entry.classId).sort()).toEqual(IP_CLASSES.map(([classId]) => classId).sort());
  });

  it("the relayer budget matches the report", () => {
    expect(REPORT_0916).toContain("Relayer `/submit` 25/min");
    expect(config.relayer.windows).toEqual([{ limit: 25, windowMs: 60_000 }]);
  });

  it("the signer tiers match the frozen fixture value for value, and the negative cancel balance matches D-21", () => {
    const fixture = venueExample("rate-limits/rate-limits.json", "per-signer-token-buckets-snapshot") as {
      readonly tiers: readonly { tier: string; order_tokens_per_s: number; order_burst: number; cancel_tokens_per_s: number; cancel_burst: number }[];
    };
    expect(
      config.signerTiers.map((tier) => ({
        tier: tier.tier,
        order_tokens_per_s: tier.orderTokensPerSecond,
        order_burst: tier.orderBurst,
        cancel_tokens_per_s: tier.cancelTokensPerSecond,
        cancel_burst: tier.cancelBurst,
      })),
    ).toEqual(fixture.tiers.map(({ tier, order_tokens_per_s, order_burst, cancel_tokens_per_s, cancel_burst }) => ({ tier, order_tokens_per_s, order_burst, cancel_tokens_per_s, cancel_burst })));
    expect(REPORT_0916).toContain("`Yes` for Standard, Copper, Bronze, Silver, Gold; `No` for Platinum, Diamond, Elite");
    expect(config.signerTiers.filter((tier) => tier.negativeCancelBalance).map((tier) => tier.tier)).toEqual(["Standard", "Copper", "Bronze", "Silver", "Gold"]);
  });

  it("the trading dual limits match the frozen fixture value for value", () => {
    const fixture = venueExample("rate-limits/rate-limits.json", "ip-limits-snapshot") as {
      readonly trading_dual_limits: Readonly<Record<string, { burst_per_10s: number; sustained_per_10min: number }>>;
      readonly limits_per_10s: Readonly<Record<string, number>>;
    };
    const byEndpoint: Readonly<Record<string, string>> = {
      "POST /order": "clob.post_order",
      "DELETE /order": "clob.delete_order",
      "POST /orders": "clob.post_orders",
      "DELETE /orders": "clob.delete_orders",
      "DELETE /cancel-all": "clob.cancel_all",
      "DELETE /cancel-market-orders": "clob.cancel_market_orders",
    };
    for (const [endpoint, limits] of Object.entries(fixture.trading_dual_limits)) {
      const entry = config.ipEndpointClasses.find((candidate) => candidate.classId === byEndpoint[endpoint]);
      expect(entry?.windows, endpoint).toEqual([
        { limit: limits.burst_per_10s, windowMs: 10_000 },
        { limit: limits.sustained_per_10min, windowMs: 600_000 },
      ]);
    }
    for (const [key, classId] of [
      ["general", "general"],
      ["clob_general", "clob.general"],
      ["gamma_general", "gamma.general"],
      ["gamma_events", "gamma.events"],
      ["gamma_markets", "gamma.markets"],
      ["auth", "clob.auth"],
    ] as const) {
      expect(config.ipEndpointClasses.find((entry) => entry.classId === classId)?.windows[0]?.limit, key).toBe(fixture.limits_per_10s[key]);
    }
  });

  it("the token costs are the report's", () => {
    expect(REPORT_0916).toContain(
      normalized(
        'token costs `POST /order` 1, `POST /orders` "Number of orders in a non-empty batch", `DELETE /order` 1, `DELETE /orders` "Number of submitted order IDs", `DELETE /cancel-all` and `DELETE /cancel-market-orders` "1 plus the number of … orders canceled"',
      ),
    );
    const cost = (operationId: string): unknown => config.operations.find((op) => op.operationId === operationId)?.tokenCost;
    expect(cost("clob.post_order")).toEqual({ base: 1, perEntry: 0, perCanceled: 0 });
    expect(cost("clob.post_orders")).toEqual({ base: 0, perEntry: 1, perCanceled: 0 });
    expect(cost("clob.cancel_order")).toEqual({ base: 1, perEntry: 0, perCanceled: 0 });
    expect(cost("clob.cancel_orders")).toEqual({ base: 0, perEntry: 1, perCanceled: 0 });
    expect(cost("clob.cancel_all")).toEqual({ base: 1, perEntry: 0, perCanceled: 1 });
    expect(cost("clob.cancel_market_orders")).toEqual({ base: 1, perEntry: 0, perCanceled: 1 });
  });

  it("a later snapshot with changed values takes effect at its effective time, with no code change", () => {
    const changed = readJson(RATE_LIMIT_SNAPSHOT_PATH) as Record<string, unknown>;
    changed["snapshotId"] = "venue-hypothetical";
    changed["effectiveFrom"] = "2026-12-01T00:00:00Z";
    (changed["signerTiers"] as { orderBurst: number }[])[0]!.orderBurst = 30;
    const parsed = parseRateLimitConfiguration(changed);
    expect(parsed.ok && parsed.value.signerTiers[0]?.orderBurst).toBe(30);
  });
});

describe("the documented restricted-mode snapshot", () => {
  const config = modes();

  it("parses, with its source and effective time", () => {
    expect(config.effectiveFrom).toBe("2026-09-30T05:12:03Z");
    expect(config.source.documents[0]?.url).toBe("https://docs.polymarket.com/trading/matching-engine.md");
    expect(REPORT_0930).toContain("| S-D26 | `https://docs.polymarket.com/trading/matching-engine.md` | 2026-09-30T05:12:03Z |");
  });

  it("the post-only window is the documented two minutes", () => {
    expect(REPORT_0930).toContain("enters post-only mode for two minutes");
    expect(config.postOnlyWindowMs).toBe(2 * 60 * 1000);
  });

  it("the restart backoff starts at 1 s, doubles, and is capped at 30 s, as documented", () => {
    expect(REPORT_0916).toContain("Start at 1–2 seconds and increase the interval on each retry");
    expect(REPORT_0930).toContain("honour `error.retryAfter` with a doubling fallback capped at 30 s");
    expect(config.restartBackoff).toEqual({ initialMs: 1000, multiplier: 2, capMs: 30_000 });
  });

  it("the unavailable pause is policy (the venue documents no duration) and says so", () => {
    expect(REPORT_0930).toContain("Pause new submissions; this response does not establish whether cancels are available.");
    expect(config.source.policyAuthority).toMatch(/tradingUnavailableBackoff is an example/u);
  });
});
