import { describe, expect, it } from "vitest";

import {
  assertReconnectPolicy,
  nextReconnectDelayMs,
  DEFAULT_RECONNECT_POLICY,
  MIN_AVERAGE_RECONNECT_SPACING_MS,
} from "./connection.js";
import { BinanceConfigurationError } from "./errors.js";

describe("nextReconnectDelayMs", () => {
  it("grows geometrically and stops at the ceiling", () => {
    const policy = { initialDelayMs: 1_000, maxDelayMs: 8_000, multiplier: 2 };
    expect([1, 2, 3, 4, 5, 6].map((attempt) => nextReconnectDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });

  it("is deterministic: the same attempt always yields the same delay", () => {
    const first = nextReconnectDelayMs(4, DEFAULT_RECONNECT_POLICY);
    const second = nextReconnectDelayMs(4, DEFAULT_RECONNECT_POLICY);
    expect(first).toBe(second);
  });

  it("keeps the first retry inside the venue's documented connection budget", () => {
    // "There is a limit of 300 connections per attempt every 5 minutes per IP"
    // — 300 attempts in 300 seconds is one per second.
    expect(MIN_AVERAGE_RECONNECT_SPACING_MS).toBe(1_000);
    expect(nextReconnectDelayMs(1, DEFAULT_RECONNECT_POLICY)).toBeGreaterThanOrEqual(
      MIN_AVERAGE_RECONNECT_SPACING_MS,
    );
  });

  it("does not overflow to Infinity at a large attempt number", () => {
    const delay = nextReconnectDelayMs(2_000, DEFAULT_RECONNECT_POLICY);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(DEFAULT_RECONNECT_POLICY.maxDelayMs);
  });

  it("rejects a non-positive attempt number", () => {
    expect(() => nextReconnectDelayMs(0, DEFAULT_RECONNECT_POLICY)).toThrow(
      BinanceConfigurationError,
    );
  });
});

describe("assertReconnectPolicy", () => {
  it("accepts the default", () => {
    expect(() => assertReconnectPolicy(DEFAULT_RECONNECT_POLICY)).not.toThrow();
  });

  it("rejects a ceiling below the floor", () => {
    expect(() =>
      assertReconnectPolicy({ initialDelayMs: 5_000, maxDelayMs: 1_000, multiplier: 2 }),
    ).toThrow(BinanceConfigurationError);
  });

  it("rejects a multiplier below 1, which would shrink the backoff into a hot loop", () => {
    expect(() =>
      assertReconnectPolicy({ initialDelayMs: 1_000, maxDelayMs: 5_000, multiplier: 0.5 }),
    ).toThrow(BinanceConfigurationError);
  });

  it("rejects a negative delay and a zero maxAttempts", () => {
    expect(() =>
      assertReconnectPolicy({ initialDelayMs: -1, maxDelayMs: 5_000, multiplier: 2 }),
    ).toThrow(BinanceConfigurationError);
    expect(() =>
      assertReconnectPolicy({
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        multiplier: 2,
        maxAttempts: 0,
      }),
    ).toThrow(BinanceConfigurationError);
  });
});
