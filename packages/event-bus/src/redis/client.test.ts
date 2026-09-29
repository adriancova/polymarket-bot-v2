/**
 * The response bound's door (`OUTAGE-1`): `resolveResponseTimeoutMs` and the
 * two entry points that apply it before opening anything. No server is
 * needed: every case here is refused, or defaulted, before a socket exists.
 */

import { describe, expect, it } from "vitest";

import { EventBusConfigurationError } from "../errors.js";
import {
  createRedisClient,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  MAX_RESPONSE_TIMEOUT_MS,
  resolveResponseTimeoutMs,
} from "./client.js";
import { RedisStreamsEventTransport } from "./transport.js";

/** Nothing listens here; a refusal that tried to connect first would say so. */
const UNREACHABLE = "redis://127.0.0.1:1";

describe("resolveResponseTimeoutMs", () => {
  it("defaults to five seconds when the caller states none", () => {
    expect(DEFAULT_RESPONSE_TIMEOUT_MS).toBe(5_000);
    expect(resolveResponseTimeoutMs({ url: UNREACHABLE })).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
  });

  it.each([1, 100, 5_000, MAX_RESPONSE_TIMEOUT_MS])("accepts %s", (responseTimeoutMs) => {
    expect(resolveResponseTimeoutMs({ url: UNREACHABLE, responseTimeoutMs })).toBe(responseTimeoutMs);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_RESPONSE_TIMEOUT_MS + 1])(
    "refuses %s rather than clamping it",
    (responseTimeoutMs) => {
      expect(() => resolveResponseTimeoutMs({ url: UNREACHABLE, responseTimeoutMs })).toThrow(
        EventBusConfigurationError,
      );
    },
  );
});

describe("a refused bound opens nothing", () => {
  it("createRedisClient refuses it as a configuration error, not a connection failure", async () => {
    await expect(createRedisClient({ url: UNREACHABLE, responseTimeoutMs: 0 }, "pmb-test")).rejects.toThrow(
      EventBusConfigurationError,
    );
  });

  it("RedisStreamsEventTransport.connect refuses it as a configuration error, not a connection failure", async () => {
    await expect(
      RedisStreamsEventTransport.connect({
        connection: { url: UNREACHABLE, responseTimeoutMs: -1 },
        retention: { maxEvents: 100 },
      }),
    ).rejects.toThrow(/responseTimeoutMs must be an integer in \[1, 600000\], received -1/u);
  });
});
