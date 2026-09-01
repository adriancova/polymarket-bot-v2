import { describe, expect, it } from "vitest";

import { ConnectionIdFactory } from "./connection-ids.js";
import { GatewayConfigurationError } from "./errors.js";

describe("ConnectionIdFactory", () => {
  // Obligation (WP-080 identity contract, half 1): every connection ATTEMPT
  // gets a connectionId the feed has never seen. A counter proves uniqueness.
  it("never mints the same id twice", () => {
    const factory = new ConnectionIdFactory("binance-reference");
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const id = factory.next();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(factory.attempts).toBe(500);
  });

  it("stays inside every adapter's connection-id bound (100 chars, 64-char feed id)", () => {
    const longestFeedId = "f".repeat(64);
    const factory = new ConnectionIdFactory(longestFeedId);
    let id = "";
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      id = factory.next();
    }
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.startsWith(`${longestFeedId}-a`)).toBe(true);
  });

  it("uses the -a infix so gateway-minted ids cannot collide with Coinbase's -c ids", () => {
    const factory = new ConnectionIdFactory("feed");
    expect(factory.next()).toBe("feed-a1");
    // The Coinbase manager mints `feed-c1` for its first attempt.
    expect(factory.next()).not.toMatch(/-c\d+$/u);
  });

  it("refuses an empty or over-long feed id", () => {
    expect(() => new ConnectionIdFactory("")).toThrow(GatewayConfigurationError);
    expect(() => new ConnectionIdFactory("x".repeat(65))).toThrow(GatewayConfigurationError);
  });
});
