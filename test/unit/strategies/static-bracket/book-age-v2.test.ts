/**
 * `THROUGHPUT-1c` (ADR-023 D6) — the strategy's book-age read under grammar
 * version 2, and that version 1 is unchanged.
 *
 * Version 2 reads the traded (configured-direction) book's age from the
 * composition root's measurement, `quality.input_feed_ages@polymarket.book`,
 * projected as an integer string. What is pinned:
 *
 * 1. a quiet book the root vouches for is FRESH under version 2 even though
 *    its view `asOf` (last change) is old — the H1 run-1 finding;
 * 2. the root's age governs in BOTH directions: an old measured age is stale
 *    even when the view's last change is recent;
 * 3. an absent, missing or malformed measurement is STALE (fail closed), never
 *    replaced by the view's age;
 * 4. the OTHER outcome's book (a complement leg) keeps the version-1 age: the
 *    feature snapshot says nothing about it;
 * 5. a version-1 configuration ignores the feature and keeps `now - asOf`.
 *
 * Every one of 1-4 fails on the base commit, where version 2 does not exist
 * and `validateStaticBracketParams` refuses it.
 */

import { describe, expect, it } from "vitest";

import {
  BOOK_AGE_FEATURE_KEY,
  REASONS,
  measureBookAge,
  staticBracketParamsSchema,
  staticBracketStrategy,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { Observation } from "../../../../packages/strategies/static-bracket/src/observe.js";
import {
  HEALTHY_YES,
  T_NOW,
  configWith,
  context,
  parsedParams,
  stateWith,
} from "./helpers.js";

const NOW_MS = Date.parse(T_NOW);
/** Ten seconds before `T_NOW`: a book this old is stale under a 2 000 ms bound. */
const OLD_AS_OF = "2026-03-04T12:04:50.000Z";

function v2Config(): Record<string, unknown> {
  return configWith({ version: 2, "data_quality.book_age_feature_key": BOOK_AGE_FEATURE_KEY });
}

function staleReasoned(reasonCodes: readonly string[]): boolean {
  return reasonCodes.includes(REASONS.staleBook);
}

describe("grammar version 2 reads the root's book age (ADR-023 D6)", () => {
  it("a quiet book the root vouches for is fresh, although its last change is 10 s old", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(v2Config(), stateWith({}), {
        yes: { ...HEALTHY_YES, asOf: OLD_AS_OF },
        features: { [BOOK_AGE_FEATURE_KEY]: "150" },
      }),
    );
    expect(staleReasoned(decision.reasonCodes), decision.reasonCodes.join(",")).toBe(false);
  });

  it("the SAME inputs under version 1 are stale: version 1 keeps now - asOf", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(configWith({}), stateWith({}), {
        yes: { ...HEALTHY_YES, asOf: OLD_AS_OF },
        features: { [BOOK_AGE_FEATURE_KEY]: "150" },
      }),
    );
    expect(staleReasoned(decision.reasonCodes)).toBe(true);
    expect(decision.modelOutputs?.["bookAgeMs"]).toBe("10000");
  });

  it("the measured age governs when it is OLDER than the view's: a 2 500 ms age is stale", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(v2Config(), stateWith({}), {
        // The view's last change is `now`, age 0.
        features: { [BOOK_AGE_FEATURE_KEY]: "2500" },
      }),
    );
    expect(staleReasoned(decision.reasonCodes)).toBe(true);
    expect(decision.modelOutputs?.["bookAgeMs"]).toBe("2500");
  });

  it("the bound is inclusive, as before: exactly 2 000 ms is fresh, 2 001 is stale", () => {
    const at = (age: string) =>
      staticBracketStrategy.onFeatures(
        context(v2Config(), stateWith({}), { features: { [BOOK_AGE_FEATURE_KEY]: age } }),
      );
    expect(staleReasoned(at("2000").reasonCodes)).toBe(false);
    expect(staleReasoned(at("2001").reasonCodes)).toBe(true);
  });

  it("an ABSENT, missing or malformed measurement is stale, never replaced by the view", () => {
    const cases: { name: string; features?: Record<string, string | boolean | null>; omit?: string[] }[] = [
      { name: "absent (null)", features: { [BOOK_AGE_FEATURE_KEY]: null } },
      { name: "key missing", omit: [BOOK_AGE_FEATURE_KEY] },
      { name: "a boolean", features: { [BOOK_AGE_FEATURE_KEY]: true } },
      { name: "a decimal", features: { [BOOK_AGE_FEATURE_KEY]: "1.5" } },
      { name: "a leading zero", features: { [BOOK_AGE_FEATURE_KEY]: "0150" } },
      { name: "text", features: { [BOOK_AGE_FEATURE_KEY]: "fresh" } },
      { name: "beyond the safe range", features: { [BOOK_AGE_FEATURE_KEY]: "99999999999999999999" } },
    ];
    for (const entry of cases) {
      const decision = staticBracketStrategy.onFeatures(
        context(v2Config(), stateWith({}), {
          // The view is FRESH (asOf = now): a fallback to it would read healthy.
          ...(entry.features === undefined ? {} : { features: entry.features }),
          ...(entry.omit === undefined ? {} : { omitFeatures: entry.omit }),
        }),
      );
      expect(staleReasoned(decision.reasonCodes), entry.name).toBe(true);
    }
  });

  it("a negative measured age (a confirmation stamped after now) reads as fresh, as a negative view age always did", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(v2Config(), stateWith({}), {
        yes: { ...HEALTHY_YES, asOf: OLD_AS_OF },
        features: { [BOOK_AGE_FEATURE_KEY]: "-3" },
      }),
    );
    expect(staleReasoned(decision.reasonCodes)).toBe(false);
  });
});

describe("measureBookAge — which book the measurement describes", () => {
  const v2 = parsedParams(staticBracketParamsSchema, v2Config());
  const v1 = parsedParams(staticBracketParamsSchema, configWith({}));

  function observation(features: Record<string, string | boolean | null>): Observation {
    const bookAt = (asOfMs: number) => ({ bids: [], asks: [], asOfMs });
    return {
      nowMs: NOW_MS,
      nowIso: T_NOW,
      snapshotRef: "snapshot-1",
      market: {
        marketId: "m",
        tickSize: "0.01",
        minimumOrderSize: "5",
        closeTimeMs: null,
        openTimeMs: null,
      },
      books: { YES: bookAt(NOW_MS - 10_000), NO: bookAt(NOW_MS - 7_000) },
      features,
      position: { yesShares: "0", noShares: "0" },
      orders: [],
    };
  }

  it("version 2, configured direction (YES): the measured age", () => {
    expect(measureBookAge(v2, observation({ [BOOK_AGE_FEATURE_KEY]: "42" }), "YES")).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("version 2, the OTHER outcome (a complement leg): the view's age, never the subject's", () => {
    expect(measureBookAge(v2, observation({ [BOOK_AGE_FEATURE_KEY]: "42" }), "NO")).toEqual({
      ok: true,
      value: 7_000,
    });
  });

  it("version 1: the view's age for either outcome, whatever the features say", () => {
    const seen = observation({ [BOOK_AGE_FEATURE_KEY]: "42" });
    expect(measureBookAge(v1, seen, "YES")).toEqual({ ok: true, value: 10_000 });
    expect(measureBookAge(v1, seen, "NO")).toEqual({ ok: true, value: 7_000 });
  });

  it("version 2, unmeasurable: refused, carrying the view's age only as a diagnostic", () => {
    const measured = measureBookAge(v2, observation({ [BOOK_AGE_FEATURE_KEY]: null }), "YES");
    expect(measured.ok).toBe(false);
    if (measured.ok) return;
    expect(measured.viewAgeMs).toBe(10_000);
  });
});
