import { describe, expect, it } from "vitest";

import { EventProvenanceMismatchError, EventValidationError } from "../errors.js";
import { assertEnvelopePayloadProvenance, checkEnvelopePayloadProvenance } from "../provenance.js";
import { EventSourceSchema } from "../envelope.js";
import { DOMAIN_EVENT_REGISTRY } from "../registry.js";
import { EVENT_SAMPLES, envelopeForSample, sampleEnvelope } from "../testing/samples.js";
import { BookSnapshotPayloadSchema, BookLevelSchema } from "./book.js";
import {
  FeedGapDetectedPayloadSchema,
  FeedResynchronizedPayloadSchema,
} from "./feed.js";
import { DOMAIN_EVENT_CONTRACTS, DOMAIN_EVENT_TYPES } from "./index.js";
import {
  MarketOutcomeStateSchema,
  MarketResolvedPayloadSchema,
  NON_TERMINAL_MARKET_OUTCOME_STATES,
  TerminalMarketOutcomeStateSchema,
  TradingParameterKindSchema,
  TradingParametersChangedPayloadSchema,
  isTerminalMarketOutcomeState,
} from "./market-lifecycle.js";
import { REFERENCE_VENUES, ReferenceVenueSchema } from "./reference.js";

const contractsByType = new Map(
  DOMAIN_EVENT_CONTRACTS.map((contract) => [contract.eventType, contract]),
);

type SamplePath = readonly (string | number)[];

/** Every path in `value` that addresses a string, including inside nested objects and arrays. */
function stringPaths(value: unknown, prefix: SamplePath = []): SamplePath[] {
  if (typeof value === "string") {
    return [prefix];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => stringPaths(entry, [...prefix, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => stringPaths(entry, [...prefix, key]));
  }
  return [];
}

/** Immutable set-at-path over nested objects and arrays. */
function setAtPath(root: unknown, path: SamplePath, next: unknown): unknown {
  if (path.length === 0) {
    return next;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    const index = head as number;
    copy[index] = setAtPath(copy[index], rest, next);
    return copy;
  }
  const copy = { ...(root as Record<string, unknown>) };
  const key = head as string;
  copy[key] = setAtPath(copy[key], rest, next);
  return copy;
}

function renderPath(path: SamplePath): string {
  return path.map((segment) => String(segment)).join(".");
}

describe("the §7.4 minimum event list is complete", () => {
  it("declares exactly the specified 22 event types", () => {
    expect(DOMAIN_EVENT_TYPES).toHaveLength(22);
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(22);
  });

  it("registers one contract per declared event type", () => {
    expect([...contractsByType.keys()].sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it("versions every contract explicitly", () => {
    for (const contract of DOMAIN_EVENT_CONTRACTS) {
      expect(Number.isInteger(contract.schemaVersion)).toBe(true);
      expect(contract.schemaVersion).toBeGreaterThan(0);
    }
  });

  it("covers every event type with a sample", () => {
    expect(EVENT_SAMPLES.map((sample) => sample.eventType).sort()).toEqual(
      [...DOMAIN_EVENT_TYPES].sort(),
    );
  });
});

describe("the recursive string-field walk used by the number-rejection test", () => {
  // The walk is what makes "every string field of every sample" a true claim
  // rather than "every top-level string field". If it regressed to a shallow
  // scan these assertions would fail and the number-rejection test would start
  // passing vacuously on nested payloads.
  it("descends into arrays of objects", () => {
    const snapshot = EVENT_SAMPLES.find((entry) => entry.eventType === "BookSnapshot");
    expect(snapshot).toBeDefined();
    const paths = stringPaths(snapshot?.payload).map(renderPath);
    expect(paths).toContain("bids.0.price");
    expect(paths).toContain("bids.0.size");
    expect(paths).toContain("asks.0.price");
    expect(paths).toContain("internalMarketId");
  });

  it("descends into arrays of strings", () => {
    const gap = EVENT_SAMPLES.find((entry) => entry.eventType === "FeedGapDetected");
    expect(gap).toBeDefined();
    expect(stringPaths(gap?.payload).map(renderPath)).toContain("affectedMarketIds.0");
  });

  it("rebuilds the payload immutably at any depth", () => {
    const original = { a: "x", b: [{ c: "y" }] };
    const mutated = setAtPath(original, ["b", 0, "c"], 1.5);
    expect(mutated).toEqual({ a: "x", b: [{ c: 1.5 }] });
    expect(original).toEqual({ a: "x", b: [{ c: "y" }] });
  });

  it("finds at least one nested string across the sample set", () => {
    const nested = EVENT_SAMPLES.flatMap((entry) =>
      stringPaths(entry.payload).filter((path) => path.length > 1),
    );
    expect(nested.length).toBeGreaterThan(0);
  });
});

describe.each(EVENT_SAMPLES)("$eventType", (sample) => {
  const contract = contractsByType.get(sample.eventType);

  it("has a registered contract", () => {
    expect(contract).toBeDefined();
  });

  it("accepts its valid sample payload", () => {
    const result = contract?.payloadSchema.safeParse(sample.payload);
    expect(result?.success).toBe(true);
  });

  it("accepts its valid sample envelope", () => {
    const envelope = envelopeForSample(sample, contract?.schemaVersion ?? 1);
    const result = contract?.envelopeSchema.safeParse(envelope);
    if (result !== undefined && !result.success) {
      throw new Error(
        `${sample.eventType} envelope rejected: ${result.error.issues
          .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    expect(result?.success).toBe(true);
  });

  it("rejects an unknown payload key", () => {
    expect(
      contract?.payloadSchema.safeParse({ ...sample.payload, unexpected: "value" }).success,
    ).toBe(false);
  });

  it("rejects the wrong event type on its envelope", () => {
    const envelope = sampleEnvelope("SomeOtherEvent", contract?.schemaVersion ?? 1, sample.payload);
    expect(contract?.envelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("rejects a JavaScript number in place of any string field, at any depth", () => {
    const paths = stringPaths(sample.payload);
    // The claim is "every string field of every sample", so the walk must
    // actually reach something — an empty path list would pass vacuously.
    expect(paths.length, `${sample.eventType} has no string fields to mutate`).toBeGreaterThan(0);

    for (const path of paths) {
      for (const numeric of [1.5, 0, -1, 1e21]) {
        const mutated = setAtPath(sample.payload, path, numeric);
        expect(
          contract?.payloadSchema.safeParse(mutated).success,
          `${sample.eventType}.${renderPath(path)} accepted the number ${String(numeric)}`,
        ).toBe(false);
      }
    }
  });


  it("rejects non-canonical decimals on every economic field", () => {
    for (const field of sample.economicFields) {
      for (const bad of ["1e5", "1.50", "+1", "-0", "1.", ""]) {
        const mutated = { ...sample.payload, [field]: bad };
        expect(
          contract?.payloadSchema.safeParse(mutated).success,
          `${sample.eventType}.${field} accepted ${JSON.stringify(bad)}`,
        ).toBe(false);
      }
    }
  });

  it("requires every field that is not declared optional", () => {
    for (const key of Object.keys(sample.payload)) {
      const mutated: Record<string, unknown> = { ...sample.payload };
      delete mutated[key];
      expect(
        contract?.payloadSchema.safeParse(mutated).success,
        `${sample.eventType}.${key} optionality mismatch`,
      ).toBe(sample.optionalFields.includes(key));
    }
  });
});

describe("book level economics", () => {
  it("validates nested levels exactly", () => {
    expect(BookLevelSchema.safeParse({ price: "0.52", size: "100" }).success).toBe(true);
    expect(BookLevelSchema.safeParse({ price: 0.52, size: "100" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.52", size: 100 }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "1.5", size: "100" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.52", size: "-1" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.520", size: "100" }).success).toBe(false);
  });

  it("rejects numbers nested inside a snapshot", () => {
    const base = {
      internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
      tokenId: "12345",
      bids: [{ price: 0.52, size: "100" }],
      asks: [],
    };
    expect(BookSnapshotPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("accepts an empty book", () => {
    expect(
      BookSnapshotPayloadSchema.safeParse({
        internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
        tokenId: "12345",
        bids: [],
        asks: [],
      }).success,
    ).toBe(true);
  });
});

describe("settlement outcome states (§9.3)", () => {
  it("enumerates exactly the required states", () => {
    expect(MarketOutcomeStateSchema.options).toEqual([
      "YES_WIN",
      "NO_WIN",
      "SPLIT_50_50",
      "CANCELLED",
      "DISPUTED",
      "PENDING",
      "PENDING_CLARIFICATION",
    ]);
    expect(MarketOutcomeStateSchema.safeParse("RESOLVED").success).toBe(false);
  });

  it("splits the vocabulary into terminal and non-terminal states", () => {
    expect(TerminalMarketOutcomeStateSchema.options).toEqual([
      "YES_WIN",
      "NO_WIN",
      "SPLIT_50_50",
      "CANCELLED",
    ]);
    expect([...TerminalMarketOutcomeStateSchema.options, ...NON_TERMINAL_MARKET_OUTCOME_STATES]
      .slice()
      .sort()).toEqual([...MarketOutcomeStateSchema.options].sort());
    for (const state of TerminalMarketOutcomeStateSchema.options) {
      expect(isTerminalMarketOutcomeState(state)).toBe(true);
    }
    for (const state of NON_TERMINAL_MARKET_OUTCOME_STATES) {
      expect(isTerminalMarketOutcomeState(state)).toBe(false);
    }
  });
});

describe("MarketResolved accepts terminal outcomes only", () => {
  const base = {
    internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
    conditionId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    resolvedAt: "2026-08-26T12:00:00.000Z",
  };

  it.each(["YES_WIN", "NO_WIN", "SPLIT_50_50", "CANCELLED"])("accepts %s", (outcome) => {
    expect(MarketResolvedPayloadSchema.safeParse({ ...base, outcome }).success).toBe(true);
  });

  // A resolution event must assert a determined payoff. `DISPUTED` is an
  // in-flight process, `PENDING*` are explicitly unresolved — see the ruling on
  // `TerminalMarketOutcomeStateSchema`.
  it.each(["PENDING", "PENDING_CLARIFICATION", "DISPUTED"])("rejects %s", (outcome) => {
    expect(MarketResolvedPayloadSchema.safeParse({ ...base, outcome }).success).toBe(false);
    // ...while the state itself remains part of the settlement vocabulary.
    expect(MarketOutcomeStateSchema.safeParse(outcome).success).toBe(true);
  });
});

describe("the gap-recovery invariant is unconditional (§7.1, §9.1)", () => {
  const gap = {
    feedId: "polymarket-market",
    detectedAt: "2026-08-26T12:00:00.000Z",
    reasonCode: "SEQUENCE_GAP",
    requiresAuthoritativeSnapshot: true,
  };
  const resync = {
    feedId: "polymarket-market",
    resynchronizedAt: "2026-08-26T12:00:00.000Z",
    subscriptionGeneration: 1,
    authoritativeSnapshotApplied: true,
  };

  it("accepts a gap that requires a snapshot", () => {
    expect(FeedGapDetectedPayloadSchema.safeParse(gap).success).toBe(true);
  });

  it("rejects a gap that claims no snapshot is required", () => {
    expect(
      FeedGapDetectedPayloadSchema.safeParse({ ...gap, requiresAuthoritativeSnapshot: false })
        .success,
    ).toBe(false);
  });

  it("rejects a non-boolean or missing snapshot requirement", () => {
    for (const value of ["true", 1, null, undefined]) {
      expect(
        FeedGapDetectedPayloadSchema.safeParse({
          ...gap,
          requiresAuthoritativeSnapshot: value,
        }).success,
      ).toBe(false);
    }
    const { requiresAuthoritativeSnapshot, ...withoutFlag } = gap;
    expect(requiresAuthoritativeSnapshot).toBe(true);
    expect(FeedGapDetectedPayloadSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("accepts a resynchronization that applied a snapshot", () => {
    expect(FeedResynchronizedPayloadSchema.safeParse(resync).success).toBe(true);
  });

  it("rejects a resynchronization that applied no snapshot", () => {
    expect(
      FeedResynchronizedPayloadSchema.safeParse({ ...resync, authoritativeSnapshotApplied: false })
        .success,
    ).toBe(false);
  });

  // The same negative matrix the gap flag gets. Both fields are pinned to
  // `z.literal(true)`, so both must reject `false`, every truthy stand-in for
  // `true`, `null`, `undefined`, and omission.
  it.each([
    ["false", false],
    ["the string \"true\"", "true"],
    ["the string \"false\"", "false"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["undefined", undefined],
  ])("rejects a resynchronization whose snapshot flag is %s", (_description, value) => {
    expect(
      FeedResynchronizedPayloadSchema.safeParse({
        ...resync,
        authoritativeSnapshotApplied: value,
      }).success,
    ).toBe(false);
  });

  it("rejects a resynchronization that omits the snapshot flag", () => {
    const { authoritativeSnapshotApplied, ...withoutFlag } = resync;
    expect(authoritativeSnapshotApplied).toBe(true);
    expect(FeedResynchronizedPayloadSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("rejects the same stand-ins on the gap flag", () => {
    // Kept explicit so the two matrices cannot drift apart.
    for (const value of [false, "true", "false", 1, 0, null, undefined]) {
      expect(
        FeedGapDetectedPayloadSchema.safeParse({
          ...gap,
          requiresAuthoritativeSnapshot: value,
        }).success,
      ).toBe(false);
    }
  });
});

describe("TradingParametersChanged addresses the whole versioned parameter set", () => {
  const base = {
    internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
    conditionId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    parametersVersion: 3,
    parameterVersionRef: "market-params/018f3a5c-1111-7000-8000-000000000001/3",
    changedParameters: ["fee_schedule"],
  };

  it("covers every versioned parameter category the handoff names", () => {
    // §9.2 names tick size, minimum size, `negRisk`, fee schedule, trading
    // delay, and open/close timestamps. §10.1 `market_parameter_history` adds
    // status ("Tick, minimum size, delay, `negRisk`, fees, status"). The
    // vocabulary is exactly the union, with nothing invented.
    expect(TradingParameterKindSchema.options).toEqual([
      "tick_size",
      "minimum_order_size",
      "fee_schedule",
      "trading_delay",
      "neg_risk",
      "open_time",
      "close_time",
      "status",
    ]);
    for (const kind of TradingParameterKindSchema.options) {
      expect(
        TradingParametersChangedPayloadSchema.safeParse({ ...base, changedParameters: [kind] })
          .success,
        `${kind} was rejected`,
      ).toBe(true);
    }
  });

  it("expresses a rescheduled open or close as a parameter change (§9.2)", () => {
    // The open/close *timestamps* are versioned parameters and can be
    // rescheduled before the transition is observed; `MarketOpened` /
    // `MarketClosing` record the observed transition, not the schedule.
    for (const kinds of [["open_time"], ["close_time"], ["open_time", "close_time"]]) {
      expect(
        TradingParametersChangedPayloadSchema.safeParse({ ...base, changedParameters: kinds })
          .success,
        `${kinds.join("+")} was rejected`,
      ).toBe(true);
    }
  });

  it("accepts the whole vocabulary in one change list", () => {
    expect(
      TradingParametersChangedPayloadSchema.safeParse({
        ...base,
        changedParameters: [...TradingParameterKindSchema.options],
      }).success,
    ).toBe(true);
  });

  it("expresses a fee-schedule change with no tick or size detail", () => {
    expect(TradingParametersChangedPayloadSchema.safeParse(base).success).toBe(true);
  });

  it("still carries tick size and minimum size when they are known", () => {
    expect(
      TradingParametersChangedPayloadSchema.safeParse({
        ...base,
        changedParameters: ["tick_size", "minimum_order_size"],
        tickSize: "0.01",
        minimumOrderSize: "5",
      }).success,
    ).toBe(true);
  });

  it("requires an authoritative snapshot reference", () => {
    const { parameterVersionRef, ...withoutRef } = base;
    expect(parameterVersionRef).toContain("market-params/");
    expect(TradingParametersChangedPayloadSchema.safeParse(withoutRef).success).toBe(false);
  });

  it("rejects an empty or unknown change list", () => {
    // Non-empty: an event that changed nothing is not a change event.
    const empty = TradingParametersChangedPayloadSchema.safeParse({
      ...base,
      changedParameters: [],
    });
    expect(empty.success).toBe(false);
    expect(
      empty.success === false &&
        empty.error.issues.some((issue) => issue.path.map(String).join(".") === "changedParameters"),
    ).toBe(true);

    for (const unknownKind of ["liquidity_mining", "open_close", "openTime", "TICK_SIZE", ""]) {
      expect(
        TradingParametersChangedPayloadSchema.safeParse({
          ...base,
          changedParameters: [unknownKind],
        }).success,
        `${JSON.stringify(unknownKind)} was accepted as a parameter category`,
      ).toBe(false);
    }

    // A single unknown entry poisons an otherwise valid list.
    expect(
      TradingParametersChangedPayloadSchema.safeParse({
        ...base,
        changedParameters: ["open_time", "liquidity_mining"],
      }).success,
    ).toBe(false);

    // ...and the field itself must be an array of strings.
    for (const bad of ["open_time", 1, null, undefined, [1], [null]]) {
      expect(
        TradingParametersChangedPayloadSchema.safeParse({ ...base, changedParameters: bad })
          .success,
        `${JSON.stringify(bad)} was accepted as a change list`,
      ).toBe(false);
    }
  });

  it("keeps economic detail fields as exact decimal strings", () => {
    expect(
      TradingParametersChangedPayloadSchema.safeParse({ ...base, tickSize: 0.01 }).success,
    ).toBe(false);
    expect(
      TradingParametersChangedPayloadSchema.safeParse({ ...base, tickSize: "0.010" }).success,
    ).toBe(false);
  });
});

describe("reference-event provenance agrees with the envelope (§7.1)", () => {
  it("draws payload venues from the envelope source vocabulary", () => {
    for (const venue of REFERENCE_VENUES) {
      expect(EventSourceSchema.safeParse(venue).success).toBe(true);
      expect(ReferenceVenueSchema.safeParse(venue).success).toBe(true);
    }
    expect(ReferenceVenueSchema.safeParse("polymarket").success).toBe(false);
    expect(ReferenceVenueSchema.safeParse("internal").success).toBe(false);
  });

  it("ships reference samples whose envelope source matches the payload venue", () => {
    const referenceSamples = EVENT_SAMPLES.filter((entry) =>
      entry.eventType.startsWith("Reference"),
    );
    expect(referenceSamples).toHaveLength(3);
    for (const entry of referenceSamples) {
      const envelope = envelopeForSample(entry, 1);
      expect(envelope["source"]).toBe(entry.payload["venue"]);
      expect(() =>
        assertEnvelopePayloadProvenance(
          envelope as unknown as { source: string; eventType?: string },
          entry.payload,
        ),
      ).not.toThrow();
    }
  });

  it("rejects a payload venue that contradicts the envelope source", () => {
    const trade = EVENT_SAMPLES.find((entry) => entry.eventType === "ReferenceTradeObserved");
    expect(trade).toBeDefined();
    const mismatched = sampleEnvelope("ReferenceTradeObserved", 1, trade?.payload, {
      source: "coinbase",
      sourceChannel: "ticker",
    });

    // The *payload* schema still accepts the payload on its own — a payload
    // cannot know its envelope — which is why the pairing is checked by the
    // envelope schema and by the registry, not only by this helper.
    expect(
      contractsByType.get("ReferenceTradeObserved")?.payloadSchema.safeParse(trade?.payload)
        .success,
    ).toBe(true);

    const outcome = checkEnvelopePayloadProvenance(
      mismatched as unknown as { source: string },
      trade?.payload,
    );
    expect(outcome.ok).toBe(false);
    expect(() =>
      assertEnvelopePayloadProvenance(
        mismatched as unknown as { source: string; eventType?: string },
        trade?.payload,
      ),
    ).toThrow(EventProvenanceMismatchError);
  });

  // The helper above is only as good as the callers that remember it. These
  // assertions pin the enforcement to the CANONICAL validation path: the
  // registered envelope schema and `DOMAIN_EVENT_REGISTRY.parseEnvelope`.
  const referenceEventTypes = ["ReferenceTradeObserved", "ReferenceTopOfBookChanged",
    "ReferenceTwapObserved"] as const;

  const mismatchCases = referenceEventTypes.flatMap((eventType) => {
    const sample = EVENT_SAMPLES.find((entry) => entry.eventType === eventType);
    const payloadVenue = String(sample?.payload["venue"]);
    return EventSourceSchema.options
      .filter((source) => source !== payloadVenue)
      .map((source) => ({ eventType, payloadVenue, source }));
  });

  it("builds a mismatch case for every reference event and every other source", () => {
    // 3 reference events × (5 §7.1 sources − its own) = 12 cases; a change to
    // either vocabulary must not silently shrink the matrix below.
    expect(mismatchCases).toHaveLength(12);
    for (const eventType of referenceEventTypes) {
      expect(mismatchCases.filter((entry) => entry.eventType === eventType)).toHaveLength(4);
    }
  });

  it.each(mismatchCases)(
    "the registry rejects $eventType (payload venue $payloadVenue) under envelope source $source",
    ({ eventType, source }) => {
      const sample = EVENT_SAMPLES.find((entry) => entry.eventType === eventType);
      expect(sample).toBeDefined();
      const mismatched = sampleEnvelope(eventType, 1, sample?.payload, {
        source,
        sourceChannel: "trade",
      });

      const contract = contractsByType.get(eventType);
      const parsed = contract?.envelopeSchema.safeParse(mismatched);
      expect(parsed?.success, `${eventType}/${source} passed the pinned envelope schema`).toBe(
        false,
      );
      expect(
        parsed?.success === false &&
          parsed.error.issues.some(
            (issue) => issue.path.map(String).join(".") === "payload.venue",
          ),
      ).toBe(true);

      expect(() => DOMAIN_EVENT_REGISTRY.parseEnvelope(mismatched)).toThrow(EventValidationError);

      const result = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(mismatched);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("venue");
      }
    },
  );

  it.each(referenceEventTypes)("the registry accepts a matching %s pair", (eventType) => {
    const sample = EVENT_SAMPLES.find((entry) => entry.eventType === eventType);
    expect(sample).toBeDefined();
    if (sample === undefined) {
      return;
    }
    const envelope = envelopeForSample(sample, 1);
    expect(envelope["source"]).toBe(sample.payload["venue"]);
    const parsed = DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope);
    expect(parsed.eventType).toBe(eventType);
    expect(DOMAIN_EVENT_REGISTRY.safeParseEnvelope(envelope).ok).toBe(true);
  });

  it("leaves events that do not restate their provenance routable from any source", () => {
    const opened = EVENT_SAMPLES.find((entry) => entry.eventType === "MarketOpened");
    expect(opened).toBeDefined();
    for (const source of EventSourceSchema.options) {
      const envelope = sampleEnvelope("MarketOpened", 1, opened?.payload, {
        source,
        sourceChannel: "market",
      });
      expect(DOMAIN_EVENT_REGISTRY.safeParseEnvelope(envelope).ok).toBe(true);
    }
  });

  it("passes payloads that do not restate their provenance", () => {
    const opened = EVENT_SAMPLES.find((entry) => entry.eventType === "MarketOpened");
    expect(opened).toBeDefined();
    expect(checkEnvelopePayloadProvenance({ source: "polymarket" }, opened?.payload).ok).toBe(true);
    expect(checkEnvelopePayloadProvenance({ source: "polymarket" }, undefined).ok).toBe(true);
    expect(checkEnvelopePayloadProvenance({ source: "polymarket" }, null).ok).toBe(true);
  });

  it("treats a non-string payload venue as a mismatch", () => {
    const outcome = checkEnvelopePayloadProvenance({ source: "binance" }, { venue: 7 });
    expect(outcome.ok).toBe(false);
    expect(() =>
      assertEnvelopePayloadProvenance({ source: "binance" }, { venue: 7 }),
    ).toThrow(EventProvenanceMismatchError);
  });
});
