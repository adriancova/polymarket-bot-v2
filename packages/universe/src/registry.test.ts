import { describe, expect, it } from "vitest";

import type { UniverseResult } from "./errors.js";
import {
  applyMarketEvent,
  approveSeries,
  bindMarketToSeries,
  createUniverseRegistry,
  findMarketByConditionId,
  findMarketByTokenId,
  recordMarketOutcomeState,
  recordMarketParameters,
  recordSeriesSuggestion,
  registerMarket,
  registerSeries,
  suggestSeriesForMarket,
  type UniverseRegistry,
} from "./registry.js";
import {
  SAMPLE_MARKET_ID,
  SAMPLE_SERIES_ID,
  marketIdentitySample,
  parameterObservationSample,
  seriesDefinitionSample,
} from "./testing/index.js";

function codes<T>(result: UniverseResult<T>): readonly string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

function value<T>(result: UniverseResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.refusals.map((r) => r.code).join(", ")}`);
  }
  return result.value;
}

function registryWithMarket(): UniverseRegistry {
  const registry = createUniverseRegistry();
  return value(
    registerMarket(registry, {
      identity: marketIdentitySample(),
      parameters: parameterObservationSample(),
    }),
  ).registry;
}

function registryWithApprovedSeries(): UniverseRegistry {
  let registry = value(registerSeries(registryWithMarket(), seriesDefinitionSample()));
  registry = value(
    approveSeries(registry, {
      seriesId: SAMPLE_SERIES_ID,
      approvedBy: "reviewer",
      approvedAt: "2026-08-28T00:00:00Z",
    }),
  );
  return registry;
}

describe("registerMarket", () => {
  it("registers a market, starts its parameter history, and leaves it unbound", () => {
    const registered = value(
      registerMarket(createUniverseRegistry(), {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );

    expect(registered.projection.lifecycleState).toBe("DISCOVERED");
    expect(registered.projection.outcomeState).toBe("PENDING");
    expect(registered.projection.seriesBinding).toEqual({ kind: "UNBOUND" });
    expect(registered.projection.parameters.versions).toHaveLength(1);
    expect(registered.registry.markets.size).toBe(1);
  });

  it("leaves the registry it was given untouched", () => {
    const empty = createUniverseRegistry();
    value(
      registerMarket(empty, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );
    expect(empty.markets.size).toBe(0);
  });

  it("emits a MarketDiscovered payload that names no series while none is approved", () => {
    const registered = value(
      registerMarket(createUniverseRegistry(), {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );
    expect(registered.event).toEqual({
      internalMarketId: SAMPLE_MARKET_ID,
      conditionId: marketIdentitySample().conditionId,
      yesTokenId: "1000000001",
      noTokenId: "1000000002",
      metadataVersion: 1,
    });
    expect(registered.event.seriesId).toBeUndefined();
  });

  it("refuses an identity whose outcome tokens are the same token", () => {
    const result = registerMarket(createUniverseRegistry(), {
      identity: { ...marketIdentitySample(), noTokenId: "1000000001" },
      parameters: parameterObservationSample(),
    });
    expect(codes(result)).toEqual(["UNIVERSE_INPUT_INVALID"]);
  });

  it("is idempotent for the identical identity", () => {
    const first = registryWithMarket();
    const again = value(
      registerMarket(first, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );
    expect(again.registry).toBe(first);
  });

  it("refuses a different identity under an id already registered", () => {
    const result = registerMarket(registryWithMarket(), {
      identity: { ...marketIdentitySample(), conditionId: "0xsomethingelse" },
      parameters: parameterObservationSample(),
    });
    expect(codes(result)).toEqual(["UNIVERSE_MARKET_IDENTITY_CONFLICT"]);
  });

  it("refuses a condition id another market already claims", () => {
    const result = registerMarket(registryWithMarket(), {
      identity: {
        ...marketIdentitySample(),
        internalMarketId: "01936f00-0000-7000-8000-00000000d002",
        yesTokenId: "2000000001",
        noTokenId: "2000000002",
      },
      parameters: parameterObservationSample(),
    });
    expect(codes(result)).toEqual(["UNIVERSE_CONDITION_ID_ALREADY_BOUND"]);
  });

  it("refuses an outcome token another market already claims", () => {
    const result = registerMarket(registryWithMarket(), {
      identity: {
        ...marketIdentitySample(),
        internalMarketId: "01936f00-0000-7000-8000-00000000d002",
        conditionId: "0xanother-condition",
        noTokenId: "2000000002",
      },
      parameters: parameterObservationSample(),
    });
    expect(codes(result)).toEqual(["UNIVERSE_TOKEN_ID_ALREADY_BOUND"]);
  });

  it("indexes the market by condition id and by both token ids", () => {
    const registry = registryWithMarket();
    const identity = marketIdentitySample();
    expect(findMarketByConditionId(registry, identity.conditionId)?.identity.internalMarketId).toBe(
      SAMPLE_MARKET_ID,
    );
    expect(findMarketByTokenId(registry, "1000000001")?.identity.internalMarketId).toBe(
      SAMPLE_MARKET_ID,
    );
    expect(findMarketByTokenId(registry, "1000000002")?.identity.internalMarketId).toBe(
      SAMPLE_MARKET_ID,
    );
    expect(findMarketByTokenId(registry, "9999")).toBeUndefined();
    expect(findMarketByConditionId(registry, "0xnope")).toBeUndefined();
  });
});

describe("series registration and binding (§9.2 configuration)", () => {
  it("registers a series and refuses a conflicting redefinition", () => {
    const registry = value(registerSeries(createUniverseRegistry(), seriesDefinitionSample()));
    expect(registry.series.size).toBe(1);

    expect(value(registerSeries(registry, seriesDefinitionSample()))).toBe(registry);

    expect(
      codes(
        registerSeries(registry, { ...seriesDefinitionSample(), displayName: "Something else" }),
      ),
    ).toEqual(["UNIVERSE_SERIES_CONFLICT"]);
  });

  it("refuses a series key another series already owns", () => {
    const registry = value(registerSeries(createUniverseRegistry(), seriesDefinitionSample()));
    const result = registerSeries(registry, {
      ...seriesDefinitionSample(),
      seriesId: "01936f00-0000-7000-8000-00000000a009",
    });
    expect(codes(result)).toEqual(["UNIVERSE_SERIES_KEY_ALREADY_BOUND"]);
  });

  it("refuses an invalid series definition", () => {
    expect(codes(registerSeries(createUniverseRegistry(), { seriesKey: "x" }))).toEqual([
      "UNIVERSE_INPUT_INVALID",
    ]);
  });

  it("refuses to bind a market to a series nobody approved", () => {
    const registry = value(registerSeries(registryWithMarket(), seriesDefinitionSample()));
    const result = bindMarketToSeries(registry, {
      internalMarketId: SAMPLE_MARKET_ID,
      seriesId: SAMPLE_SERIES_ID,
      approvedBy: "reviewer",
      approvedAt: "2026-08-28T00:00:00Z",
    });
    expect(codes(result)).toEqual(["UNIVERSE_SERIES_BINDING_NOT_APPROVED"]);
  });

  it("binds a market to an approved series with the approver recorded", () => {
    const registry = value(
      bindMarketToSeries(registryWithApprovedSeries(), {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
    );
    expect(registry.markets.get(SAMPLE_MARKET_ID)?.seriesBinding).toEqual({
      kind: "APPROVED",
      seriesId: SAMPLE_SERIES_ID,
      approvedBy: "reviewer",
      approvedAt: "2026-08-28T00:00:00Z",
    });
  });

  it("refuses to bind to an inactive series", () => {
    let registry = value(registerSeries(registryWithMarket(), {
      ...seriesDefinitionSample(),
      active: false,
    }));
    registry = value(
      approveSeries(registry, {
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
    );
    expect(
      codes(
        bindMarketToSeries(registry, {
          internalMarketId: SAMPLE_MARKET_ID,
          seriesId: SAMPLE_SERIES_ID,
          approvedBy: "reviewer",
          approvedAt: "2026-08-28T00:00:00Z",
        }),
      ),
    ).toEqual(["UNIVERSE_SERIES_INACTIVE"]);
  });

  it("refuses to bind an unknown market or to an unknown series", () => {
    expect(
      codes(
        bindMarketToSeries(registryWithApprovedSeries(), {
          internalMarketId: "01936f00-0000-7000-8000-00000000d777",
          seriesId: SAMPLE_SERIES_ID,
          approvedBy: "reviewer",
          approvedAt: "2026-08-28T00:00:00Z",
        }),
      ),
    ).toEqual(["UNIVERSE_MARKET_UNKNOWN"]);

    expect(
      codes(
        bindMarketToSeries(registryWithApprovedSeries(), {
          internalMarketId: SAMPLE_MARKET_ID,
          seriesId: "01936f00-0000-7000-8000-00000000a777",
          approvedBy: "reviewer",
          approvedAt: "2026-08-28T00:00:00Z",
        }),
      ),
    ).toEqual(["UNIVERSE_SERIES_UNKNOWN"]);
  });

  it("refuses to approve an unknown series", () => {
    expect(
      codes(
        approveSeries(createUniverseRegistry(), {
          seriesId: SAMPLE_SERIES_ID,
          approvedBy: "reviewer",
          approvedAt: "2026-08-28T00:00:00Z",
        }),
      ),
    ).toEqual(["UNIVERSE_SERIES_UNKNOWN"]);
  });

  it("emits the series KEY on MarketDiscovered only once the binding is approved", () => {
    const registry = value(
      bindMarketToSeries(registryWithApprovedSeries(), {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
    );
    const registered = value(
      registerMarket(registry, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );
    expect(registered.event.seriesId).toBe("btc-15m-updown");
  });
});

describe("series suggestions never approve anything", () => {
  it("returns a shortlist without touching the registry", () => {
    const registry = value(registerSeries(registryWithMarket(), seriesDefinitionSample()));
    const suggestions = value(suggestSeriesForMarket(registry, SAMPLE_MARKET_ID));
    expect(suggestions[0]?.seriesKey).toBe("btc-15m-updown");
    expect(registry.markets.get(SAMPLE_MARKET_ID)?.seriesBinding.kind).toBe("UNBOUND");
  });

  it("records a suggestion as a SUGGESTED binding, never an APPROVED one", () => {
    const registry = value(
      recordSeriesSuggestion(
        value(registerSeries(registryWithMarket(), seriesDefinitionSample())),
        SAMPLE_MARKET_ID,
      ),
    );
    const binding = registry.markets.get(SAMPLE_MARKET_ID)?.seriesBinding;
    expect(binding?.kind).toBe("SUGGESTED");
    expect(JSON.stringify(binding)).not.toContain("approvedBy");
  });

  it("never overwrites an approved binding with a suggestion", () => {
    const approved = value(
      bindMarketToSeries(registryWithApprovedSeries(), {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
    );
    expect(value(recordSeriesSuggestion(approved, SAMPLE_MARKET_ID))).toBe(approved);
  });

  it("records nothing when nothing matches", () => {
    const registry = registryWithMarket();
    expect(value(recordSeriesSuggestion(registry, SAMPLE_MARKET_ID))).toBe(registry);
  });

  it("refuses an unknown market", () => {
    expect(codes(suggestSeriesForMarket(createUniverseRegistry(), SAMPLE_MARKET_ID))).toEqual([
      "UNIVERSE_MARKET_UNKNOWN",
    ]);
    expect(codes(recordSeriesSuggestion(createUniverseRegistry(), SAMPLE_MARKET_ID))).toEqual([
      "UNIVERSE_MARKET_UNKNOWN",
    ]);
    expect(codes(suggestSeriesForMarket(createUniverseRegistry(), "not-a-uuid"))).toEqual([
      "UNIVERSE_INPUT_INVALID",
    ]);
  });
});

describe("recordMarketParameters", () => {
  it("appends a version and returns the event to publish", () => {
    const recorded = value(
      recordMarketParameters(registryWithMarket(), SAMPLE_MARKET_ID, {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, status: "OPEN" },
        observedAt: "2026-08-28T12:00:00Z",
      }),
    );

    expect(recorded.version.parametersVersion).toBe(2);
    expect(recorded.event.changedParameters).toEqual(["status"]);
    expect(
      recorded.registry.markets.get(SAMPLE_MARKET_ID)?.parameters.versions,
    ).toHaveLength(2);
  });

  it("propagates the no-op refusal", () => {
    expect(
      codes(
        recordMarketParameters(
          registryWithMarket(),
          SAMPLE_MARKET_ID,
          parameterObservationSample(),
        ),
      ),
    ).toEqual(["UNIVERSE_PARAMETERS_UNCHANGED"]);
  });

  it("refuses an unknown market", () => {
    expect(
      codes(
        recordMarketParameters(
          createUniverseRegistry(),
          SAMPLE_MARKET_ID,
          parameterObservationSample(),
        ),
      ),
    ).toEqual(["UNIVERSE_MARKET_UNKNOWN"]);
  });
});

describe("applyMarketEvent", () => {
  it("folds an event into the registry", () => {
    const applied = value(
      applyMarketEvent(registryWithMarket(), SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: marketIdentitySample().conditionId,
          openedAt: "2026-08-28T12:00:00Z",
        },
      }),
    );
    expect(applied.registry.markets.get(SAMPLE_MARKET_ID)?.lifecycleState).toBe("OPEN");
    expect(applied.changed).toBe(true);
  });

  it("refuses an unknown market and propagates a projection refusal", () => {
    expect(
      codes(
        applyMarketEvent(createUniverseRegistry(), SAMPLE_MARKET_ID, {
          eventType: "MarketOpened",
          payload: {},
        }),
      ),
    ).toEqual(["UNIVERSE_MARKET_UNKNOWN"]);

    expect(
      codes(
        applyMarketEvent(registryWithMarket(), SAMPLE_MARKET_ID, {
          eventType: "MarketOpened",
          payload: {},
        }),
      ),
    ).toEqual(["UNIVERSE_INPUT_INVALID"]);
  });

  it("records a non-terminal observed outcome state", () => {
    const applied = value(
      recordMarketOutcomeState(registryWithMarket(), SAMPLE_MARKET_ID, {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
    );
    expect(applied.registry.markets.get(SAMPLE_MARKET_ID)?.outcomeState).toBe("DISPUTED");

    expect(
      codes(
        recordMarketOutcomeState(createUniverseRegistry(), SAMPLE_MARKET_ID, {
          outcomeState: "DISPUTED",
          observedAt: "2026-08-28T12:30:00Z",
          observedBy: "operator:test",
        }),
      ),
    ).toEqual(["UNIVERSE_MARKET_UNKNOWN"]);

    expect(
      codes(
        recordMarketOutcomeState(registryWithMarket(), SAMPLE_MARKET_ID, {
          outcomeState: "YES_WIN",
          observedAt: "2026-08-28T12:30:00Z",
          observedBy: "operator:test",
        }),
      ),
    ).toEqual(["UNIVERSE_TERMINAL_OUTCOME_REQUIRES_EVENT"]);
  });
});
