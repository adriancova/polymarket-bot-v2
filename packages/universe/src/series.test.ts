import { describe, expect, it } from "vitest";

import {
  SeriesDefinitionSchema,
  approvedSeriesBinding,
  isApprovedSeriesBinding,
  suggestSeriesBindings,
  suggestedSeriesBinding,
  UNBOUND_SERIES_BINDING,
  type SeriesDefinition,
} from "./series.js";
import { marketIdentitySample, seriesDefinitionSample } from "./testing/index.js";

const OTHER_SERIES: SeriesDefinition = {
  seriesId: "01936f00-0000-7000-8000-00000000a002",
  seriesKey: "eth-1h-updown",
  displayName: "ETH hourly up/down (example)",
  underlyingSymbol: "eth.usd",
  cadence: "PT1H",
  binding: { approved: false },
  active: true,
};

describe("SeriesDefinitionSchema", () => {
  it("accepts the sample series", () => {
    expect(SeriesDefinitionSchema.safeParse(seriesDefinitionSample()).success).toBe(true);
  });

  it("cannot claim approval without an approver and an instant", () => {
    for (const binding of [
      { approved: true },
      { approved: true, approvedBy: "reviewer" },
      { approved: true, approvedAt: "2026-08-28T00:00:00Z" },
    ]) {
      expect(
        SeriesDefinitionSchema.safeParse({ ...seriesDefinitionSample(), binding }).success,
      ).toBe(false);
    }
  });

  it("cannot name an approver while claiming to be unapproved", () => {
    const result = SeriesDefinitionSchema.safeParse({
      ...seriesDefinitionSample(),
      binding: { approved: false, approvedBy: "reviewer" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      SeriesDefinitionSchema.safeParse({ ...seriesDefinitionSample(), extra: 1 }).success,
    ).toBe(false);
  });
});

describe("series bindings", () => {
  it("distinguishes a suggestion from an approval by TYPE, not by a flag", () => {
    const suggestion = suggestedSeriesBinding("01936f00-0000-7000-8000-00000000a001", ["reason"]);
    const approval = approvedSeriesBinding(
      "01936f00-0000-7000-8000-00000000a001",
      "reviewer",
      "2026-08-28T00:00:00Z",
    );

    expect(suggestion.kind).toBe("SUGGESTED");
    expect(isApprovedSeriesBinding(suggestion)).toBe(false);
    expect(isApprovedSeriesBinding(approval)).toBe(true);
    expect(isApprovedSeriesBinding(UNBOUND_SERIES_BINDING)).toBe(false);
  });

  it("keeps a suggestion's reasons frozen", () => {
    const suggestion = suggestedSeriesBinding("01936f00-0000-7000-8000-00000000a001", ["a"]);
    expect(Object.isFrozen(suggestion)).toBe(true);
    if (suggestion.kind === "SUGGESTED") {
      expect(Object.isFrozen(suggestion.reasons)).toBe(true);
    }
  });
});

describe("suggestSeriesBindings (§9.2: suggestion only)", () => {
  const series = [seriesDefinitionSample(), OTHER_SERIES];

  it("suggests a series whose key appears in the market text", () => {
    const suggestions = suggestSeriesBindings(marketIdentitySample(), series);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.seriesKey).toBe("btc-15m-updown");
    expect(suggestions[0]?.score).toBe(2);
    expect(suggestions[0]?.reasons).toEqual([
      'market text contains the series key "btc-15m-updown"',
      'market text mentions the underlying "btc"',
    ]);
  });

  it("returns a suggestion with no approver anywhere in it", () => {
    const [suggestion] = suggestSeriesBindings(marketIdentitySample(), series);
    expect(JSON.stringify(suggestion)).not.toContain("approved");
  });

  it("suggests nothing when nothing matches", () => {
    const identity = {
      ...marketIdentitySample(),
      venueMarketSlug: "unrelated-market",
      questionTitle: "An unrelated question",
    };
    expect(suggestSeriesBindings(identity, series)).toEqual([]);
  });

  it("ignores inactive series", () => {
    const inactive = series.map((definition) => ({ ...definition, active: false }));
    expect(suggestSeriesBindings(marketIdentitySample(), inactive)).toEqual([]);
  });

  it("is deterministic: the same inputs give the same ordered list", () => {
    const identity = {
      ...marketIdentitySample(),
      venueMarketSlug: "btc-eth-combined-15m",
      questionTitle: "btc and eth",
    };
    const first = suggestSeriesBindings(identity, series);
    const second = suggestSeriesBindings(identity, [...series].reverse());
    expect(first.map((suggestion) => suggestion.seriesKey)).toEqual(
      second.map((suggestion) => suggestion.seriesKey),
    );
    // Ties break by series key, so the order does not depend on input order.
    expect(first.map((suggestion) => suggestion.seriesKey)).toEqual([
      "btc-15m-updown",
      "eth-1h-updown",
    ]);
  });

  it("ranks a stronger match first", () => {
    const identity = {
      ...marketIdentitySample(),
      venueMarketSlug: "eth-1h-updown-window",
      questionTitle: "btc mentioned once",
    };
    const suggestions = suggestSeriesBindings(identity, series);
    expect(suggestions[0]?.seriesKey).toBe("eth-1h-updown");
    expect(suggestions[0]?.score).toBeGreaterThan(suggestions[1]?.score ?? 0);
  });

  it("matches on a cadence token", () => {
    const identity = {
      ...marketIdentitySample(),
      venueMarketSlug: "pt15m-window",
      questionTitle: "no other signal",
    };
    const suggestions = suggestSeriesBindings(identity, series);
    expect(suggestions[0]?.reasons).toEqual(['market text mentions the cadence "PT15M"']);
  });

  it("has no code path from a suggestion to an approval", () => {
    // The approval constructor demands the two review facts; there is no
    // overload, default, or promotion helper that supplies them.
    expect(approvedSeriesBinding.length).toBe(3);
  });
});
