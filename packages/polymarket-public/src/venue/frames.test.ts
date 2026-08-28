import { describe, expect, it } from "vitest";

import {
  buildMarketSubscribeFrame,
  buildMarketSubscribeUpdateFrame,
  buildMarketUnsubscribeUpdateFrame,
  decodeInboundFrame,
} from "./frames.js";

describe("buildMarketSubscribeFrame", () => {
  it("builds the documented initial subscription frame", () => {
    expect(
      buildMarketSubscribeFrame({
        assetsIds: ["123"],
        customFeatureEnabled: true,
        initialDump: true,
      }),
    ).toEqual({
      assets_ids: ["123"],
      type: "market",
      custom_feature_enabled: true,
      initial_dump: true,
    });
  });

  it("sends the optional flags explicitly rather than relying on a server default", () => {
    const frame = buildMarketSubscribeFrame({
      assetsIds: ["123"],
      customFeatureEnabled: false,
      initialDump: true,
    });
    expect(Object.keys(frame).sort()).toEqual([
      "assets_ids",
      "custom_feature_enabled",
      "initial_dump",
      "type",
    ]);
  });

  it("never sends `level`, whose three values the venue documents no meaning for", () => {
    const frame = buildMarketSubscribeFrame({
      assetsIds: ["123"],
      customFeatureEnabled: false,
      initialDump: false,
    });
    expect(frame).not.toHaveProperty("level");
  });

  it("copies the asset list so a later mutation cannot change a sent frame", () => {
    const assets = ["123"];
    const frame = buildMarketSubscribeFrame({
      assetsIds: assets,
      customFeatureEnabled: false,
      initialDump: true,
    });
    assets.push("456");
    expect(frame["assets_ids"]).toEqual(["123"]);
  });
});

describe("dynamic subscription frames", () => {
  it("builds the documented subscribe update", () => {
    expect(buildMarketSubscribeUpdateFrame(["a", "b"], true)).toEqual({
      operation: "subscribe",
      assets_ids: ["a", "b"],
      custom_feature_enabled: true,
    });
  });

  it("builds the documented unsubscribe update", () => {
    expect(buildMarketUnsubscribeUpdateFrame(["a"])).toEqual({
      operation: "unsubscribe",
      assets_ids: ["a"],
    });
  });
});

describe("decodeInboundFrame", () => {
  it("recognizes the heartbeat reply", () => {
    expect(decodeInboundFrame("PONG")).toEqual({ kind: "pong" });
    expect(decodeInboundFrame(" PONG\n")).toEqual({ kind: "pong" });
  });

  it("wraps a single event object in a one-element batch", () => {
    const decoded = decodeInboundFrame('{"event_type":"book"}');
    expect(decoded).toEqual({ kind: "values", values: [{ event_type: "book" }] });
  });

  it("preserves every event of a batched frame", () => {
    // The official SDK's market socket branches on `Array.isArray(message)`, so
    // a client that assumed one event per frame would lose all but the first.
    const decoded = decodeInboundFrame('[{"event_type":"book"},{"event_type":"price_change"}]');
    expect(decoded).toEqual({
      kind: "values",
      values: [{ event_type: "book" }, { event_type: "price_change" }],
    });
  });

  it("reports a frame it cannot read instead of throwing", () => {
    expect(decodeInboundFrame("{not json").kind).toBe("unparsable");
    expect(decodeInboundFrame("").kind).toBe("unparsable");
    expect(decodeInboundFrame("42").kind).toBe("unparsable");
    expect(decodeInboundFrame('"PING"').kind).toBe("unparsable");
  });
});
