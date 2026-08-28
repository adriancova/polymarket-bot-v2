import { describe, expect, it } from "vitest";

import { PublicMarketConfigurationError } from "../errors.js";
import { MarketSubscriptionManager } from "./subscriptions.js";

function manager(overrides: Partial<ConstructorParameters<typeof MarketSubscriptionManager>[0]> = {}) {
  return new MarketSubscriptionManager({
    customFeatureEnabled: false,
    initialDump: true,
    ...overrides,
  });
}

describe("MarketSubscriptionManager generations", () => {
  it("starts at 0, so an unset generation is distinguishable from a real one", () => {
    expect(manager().generation).toBe(0);
  });

  it("advances on a change that will actually be sent", () => {
    const subject = manager();
    expect(subject.add(["a"]).generation).toBe(1);
    expect(subject.remove(["a"]).generation).toBe(2);
  });

  it("does NOT advance on a no-op change", () => {
    // Nothing is resubscribed, so claiming a generation boundary would tell the
    // gateway to expect a snapshot that will never arrive.
    const subject = manager();
    subject.add(["a"]);
    const repeat = subject.add(["a"]);
    expect(repeat.added).toEqual([]);
    expect(repeat.frames).toEqual([]);
    expect(repeat.generation).toBe(1);

    const absent = subject.remove(["zzz"]);
    expect(absent.removed).toEqual([]);
    expect(absent.generation).toBe(1);
  });

  it("advances on every full (re)subscription, which is what a reconnect is", () => {
    const subject = manager();
    subject.add(["a", "b"]);
    expect(subject.planFullSubscription().generation).toBe(2);
    expect(subject.planFullSubscription().generation).toBe(3);
  });

  it("does not advance a full subscription of nothing", () => {
    const subject = manager();
    const plan = subject.planFullSubscription();
    expect(plan.frames).toEqual([]);
    expect(plan.generation).toBe(0);
  });
});

describe("MarketSubscriptionManager frames", () => {
  it("sends the documented initial frame first and dynamic updates after", () => {
    const subject = manager();
    subject.add(["a"]);
    expect(subject.planFullSubscription().frames).toEqual([
      { assets_ids: ["a"], type: "market", custom_feature_enabled: false, initial_dump: true },
    ]);
    expect(subject.add(["b"]).frames).toEqual([
      { operation: "subscribe", assets_ids: ["b"], custom_feature_enabled: false },
    ]);
    expect(subject.remove(["a"]).frames).toEqual([
      { operation: "unsubscribe", assets_ids: ["a"] },
    ]);
  });

  it("keeps the desired set in request order, so frames are deterministic", () => {
    const subject = manager();
    subject.add(["c", "a", "b"]);
    expect(subject.assets).toEqual(["c", "a", "b"]);
  });

  it("propagates customFeatureEnabled onto every frame that carries it", () => {
    const subject = manager({ customFeatureEnabled: true });
    subject.add(["a"]);
    const [initial] = subject.planFullSubscription().frames;
    expect(initial).toMatchObject({ custom_feature_enabled: true });
    expect(subject.add(["b"]).frames[0]).toMatchObject({ custom_feature_enabled: true });
  });
});

describe("MarketSubscriptionManager and venue item U-3", () => {
  it("imposes no asset cap by default, and that is not a claim that none exists", () => {
    const subject = manager();
    const many = Array.from({ length: 1_000 }, (_value, index) => `token-${String(index)}`);
    subject.add(many);
    const plan = subject.planFullSubscription();
    expect(plan.frames).toHaveLength(1);
    expect((plan.frames[0] as { assets_ids: string[] }).assets_ids).toHaveLength(1_000);
  });

  it("chunks across documented frame shapes once an operator sets a cap", () => {
    const subject = manager({ maximumAssetsPerFrame: 2 });
    subject.add(["a", "b", "c", "d", "e"]);
    const plan = subject.planFullSubscription();
    expect(plan.frames).toEqual([
      { assets_ids: ["a", "b"], type: "market", custom_feature_enabled: false, initial_dump: true },
      { operation: "subscribe", assets_ids: ["c", "d"], custom_feature_enabled: false },
      { operation: "subscribe", assets_ids: ["e"], custom_feature_enabled: false },
    ]);
  });

  it("chunks incremental updates too", () => {
    const subject = manager({ maximumAssetsPerFrame: 2 });
    expect(subject.add(["a", "b", "c"]).frames).toHaveLength(2);
    expect(subject.remove(["a", "b", "c"]).frames).toHaveLength(2);
  });

  it("rejects a nonsensical cap at construction", () => {
    expect(() => manager({ maximumAssetsPerFrame: 0 })).toThrow(PublicMarketConfigurationError);
    expect(() => manager({ maximumAssetsPerFrame: 1.5 })).toThrow(PublicMarketConfigurationError);
  });
});
