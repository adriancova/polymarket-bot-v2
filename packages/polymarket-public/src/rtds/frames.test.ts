import { describe, expect, it } from "vitest";

import {
  buildSubscribeFrame,
  buildSubscriptionEntry,
  buildSymbolFilter,
  decodeInboundRtdsFrame,
} from "./frames.js";

describe("the subscribe frame follows the documented shape", () => {
  it("builds the page's two-window example", () => {
    const frame = buildSubscribeFrame([
      { windowSeconds: 30, symbols: ["btc/usd"] },
      { windowSeconds: 60, symbols: ["btc/usd"] },
    ]);
    expect(frame).toEqual({
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_twap_thirty",
          type: "update",
          filters: '{"symbol":"btc/usd"}',
        },
        {
          topic: "crypto_prices_twap_sixty",
          type: "update",
          filters: '{"symbol":"btc/usd"}',
        },
      ],
    });
  });

  it("emits the exact compact filter form, with no spaces", () => {
    const filter = buildSymbolFilter("eth/usd");
    expect(filter).toBe('{"symbol":"eth/usd"}');
    expect(filter).not.toMatch(/\s/u);
    // The hand-written form and the serializer agree for this shape; the
    // hand-written one is used so the compactness is visible at the call site.
    expect(filter).toBe(JSON.stringify({ symbol: "eth/usd" }));
  });
});

describe("filters is OPTIONAL — the corrected WP-000 round-4 rule", () => {
  it("omits the key entirely when no symbol is requested", () => {
    const entry = buildSubscriptionEntry({ windowSeconds: 60 });
    expect(entry).toEqual({ topic: "crypto_prices_twap_sixty", type: "update" });
    expect(Object.hasOwn(entry, "filters")).toBe(false);
  });

  it("omits the key when several symbols are wanted for one window", () => {
    // "If you need several symbols for one window, omit filters and filter
    // updates by payload.symbol in your application."
    const entry = buildSubscriptionEntry({
      windowSeconds: 30,
      symbols: ["btc/usd", "eth/usd"],
    });
    expect(Object.hasOwn(entry, "filters")).toBe(false);
  });

  it("never emits null or an empty string for filters", () => {
    // Neither form is documented; §17 records `null` being rejected rather than
    // assumed benign for exactly this field.
    for (const subscription of [
      { windowSeconds: 30 } as const,
      { windowSeconds: 30, symbols: [] } as const,
      { windowSeconds: 30, symbols: ["btc/usd"] } as const,
      { windowSeconds: 60, symbols: ["btc/usd", "eth/usd"] } as const,
    ]) {
      const entry = buildSubscriptionEntry(subscription);
      const filters = Object.hasOwn(entry, "filters") ? entry["filters"] : undefined;
      expect(filters === undefined || (typeof filters === "string" && filters !== "")).toBe(
        true,
      );
    }
  });
});

describe("inbound frame decoding", () => {
  it("classifies a bare PING or PONG as an undocumented heartbeat text frame", () => {
    expect(decodeInboundRtdsFrame("PONG")).toEqual({ kind: "heartbeat-text", text: "PONG" });
    expect(decodeInboundRtdsFrame(" PING \n")).toEqual({ kind: "heartbeat-text", text: "PING" });
  });

  it("wraps a single envelope object in a one-element list", () => {
    const decoded = decodeInboundRtdsFrame('{"topic":"t","type":"update"}');
    expect(decoded).toEqual({ kind: "values", values: [{ topic: "t", type: "update" }] });
  });

  it("accepts an array so a batch does not collapse into one problem", () => {
    const decoded = decodeInboundRtdsFrame('[{"topic":"a"},{"topic":"b"}]');
    expect(decoded.kind).toBe("values");
    expect(decoded.kind === "values" ? decoded.values : []).toHaveLength(2);
  });

  it("reports every unusable frame instead of returning nothing", () => {
    for (const raw of ["", "   ", "not json", "42", '"a string"', "null", "[]"]) {
      expect(decodeInboundRtdsFrame(raw).kind).toBe("unparsable");
    }
  });
});
