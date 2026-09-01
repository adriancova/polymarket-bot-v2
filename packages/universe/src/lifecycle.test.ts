import type { MarketOutcomeState } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import type { UniverseResult } from "./errors.js";
import {
  applyMarketLifecycleEvent,
  clarificationsAfterOpen,
  effectiveCloseInstant,
  effectiveLifecycleState,
  recordObservedOutcomeState,
  type MarketLifecycleInput,
  type MarketProjection,
  type ProjectionApplied,
} from "./lifecycle.js";
import { createParameterHistory } from "./parameters.js";
import { UNBOUND_SERIES_BINDING } from "./series.js";
import {
  SAMPLE_MARKET_ID,
  marketIdentitySample,
  parameterObservationSample,
} from "./testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;
const MARKET_REF = { internalMarketId: SAMPLE_MARKET_ID, conditionId: CONDITION_ID } as const;

function discoveredProjection(): MarketProjection {
  return {
    identity: marketIdentitySample(),
    seriesBinding: UNBOUND_SERIES_BINDING,
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion: 1,
    clarifications: [],
    parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
  };
}

function apply(
  projection: MarketProjection,
  input: MarketLifecycleInput,
): UniverseResult<ProjectionApplied> {
  return applyMarketLifecycleEvent(projection, input);
}

function expectApplied(result: UniverseResult<ProjectionApplied>): ProjectionApplied {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.refusals.map((r) => r.code).join(", ")}`);
  }
  return result.value;
}

function codes(result: UniverseResult<ProjectionApplied>): readonly string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

function opened(projection = discoveredProjection()): MarketProjection {
  return expectApplied(
    apply(projection, {
      eventType: "MarketOpened",
      payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
    }),
  ).projection;
}

function resolved(outcome = "YES_WIN", projection = opened()): MarketProjection {
  return expectApplied(
    apply(projection, {
      eventType: "MarketResolved",
      payload: { ...MARKET_REF, outcome, resolvedAt: "2026-08-28T12:15:30Z" },
    }),
  ).projection;
}

describe("applyMarketLifecycleEvent", () => {
  it("refuses a payload that fails the frozen domain contract", () => {
    const result = apply(discoveredProjection(), {
      eventType: "MarketOpened",
      payload: { ...MARKET_REF, openedAt: "yesterday" },
    });
    expect(codes(result)).toEqual(["UNIVERSE_INPUT_INVALID"]);
  });

  it("refuses an event naming a different market", () => {
    const result = apply(discoveredProjection(), {
      eventType: "MarketOpened",
      payload: {
        internalMarketId: "01936f00-0000-7000-8000-00000000d999",
        conditionId: CONDITION_ID,
        openedAt: "2026-08-28T12:00:00Z",
      },
    });
    expect(codes(result)).toEqual(["UNIVERSE_MARKET_IDENTITY_CONFLICT"]);
  });

  it("refuses an event that does not advance ingestSeq within its gateway epoch", () => {
    const order = { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e", ingestSeq: "10" };
    const first = expectApplied(
      apply(discoveredProjection(), {
        eventType: "MarketOpened",
        payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
        order,
      }),
    ).projection;

    const replayed = apply(first, {
      eventType: "MarketClosing",
      payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
      order: { ...order, ingestSeq: "10" },
    });
    expect(codes(replayed)).toEqual(["UNIVERSE_EVENT_REPLAYED"]);

    // A new gateway epoch restarts the sequence and is not a regression.
    const afterRestart = apply(first, {
      eventType: "MarketClosing",
      payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
      order: { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1f", ingestSeq: "1" },
    });
    expect(afterRestart.ok).toBe(true);
  });

  describe("MarketOpened", () => {
    it("moves DISCOVERED to OPEN and records the instant", () => {
      const result = expectApplied(
        apply(discoveredProjection(), {
          eventType: "MarketOpened",
          payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
        }),
      );
      expect(result.changed).toBe(true);
      expect(result.projection.lifecycleState).toBe("OPEN");
      expect(result.projection.openedAt).toBe("2026-08-28T12:00:00Z");
    });

    it("is idempotent for the same instant, however spelled", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketOpened",
          payload: { ...MARKET_REF, openedAt: "2026-08-28T14:00:00+02:00" },
        }),
      );
      expect(result.changed).toBe(false);
      expect(result.idempotent).toBe(true);
    });

    it("refuses a different open instant: an open is a fact, not a schedule", () => {
      const result = apply(opened(), {
        eventType: "MarketOpened",
        payload: { ...MARKET_REF, openedAt: "2026-08-28T12:05:00Z" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_LIFECYCLE_CONFLICT"]);
    });

    it("refuses to reopen a resolved market", () => {
      // A market that resolved without an observed open: the regression rule,
      // not the "already open" rule, is what must refuse this.
      const resolvedWithoutOpen: MarketProjection = {
        ...discoveredProjection(),
        lifecycleState: "RESOLVED",
        outcomeState: "YES_WIN",
        resolvedAt: "2026-08-28T12:15:30Z",
      };
      const result = apply(resolvedWithoutOpen, {
        eventType: "MarketOpened",
        payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_LIFECYCLE_REGRESSION"]);
    });
  });

  describe("MarketClosing", () => {
    it("moves an open market to CLOSING", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketClosing",
          payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
        }),
      );
      expect(result.projection.lifecycleState).toBe("CLOSING");
      expect(result.projection.closesAt).toBe("2026-08-28T12:15:00Z");
    });

    it("accepts a reschedule, because a close instant is a schedule (§9.2)", () => {
      const closing = expectApplied(
        apply(opened(), {
          eventType: "MarketClosing",
          payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
        }),
      ).projection;

      const rescheduled = expectApplied(
        apply(closing, {
          eventType: "MarketClosing",
          payload: { ...MARKET_REF, closesAt: "2026-08-28T12:20:00Z" },
        }),
      );
      expect(rescheduled.changed).toBe(true);
      expect(rescheduled.projection.closesAt).toBe("2026-08-28T12:20:00Z");
    });

    it("is idempotent for the same close instant", () => {
      const closing = expectApplied(
        apply(opened(), {
          eventType: "MarketClosing",
          payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
        }),
      ).projection;
      const again = expectApplied(
        apply(closing, {
          eventType: "MarketClosing",
          payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
        }),
      );
      expect(again.changed).toBe(false);
    });

    it("refuses to close a resolved market", () => {
      const result = apply(resolved(), {
        eventType: "MarketClosing",
        payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_LIFECYCLE_REGRESSION"]);
    });
  });

  describe("MarketResolved", () => {
    it.each(["YES_WIN", "NO_WIN", "SPLIT_50_50", "CANCELLED"] as const)(
      "records the terminal outcome %s",
      (outcome) => {
        const projection = resolved(outcome);
        expect(projection.lifecycleState).toBe("RESOLVED");
        expect(projection.outcomeState).toBe(outcome);
        expect(projection.resolvedAt).toBe("2026-08-28T12:15:30Z");
      },
    );

    it("cannot carry a non-terminal outcome: the frozen contract forbids it", () => {
      const result = apply(opened(), {
        eventType: "MarketResolved",
        payload: { ...MARKET_REF, outcome: "DISPUTED", resolvedAt: "2026-08-28T12:15:30Z" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_INPUT_INVALID"]);
    });

    it("is idempotent for an identical resolution", () => {
      const result = expectApplied(
        apply(resolved(), {
          eventType: "MarketResolved",
          payload: { ...MARKET_REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:15:30Z" },
        }),
      );
      expect(result.changed).toBe(false);
    });

    it("refuses a second, different resolution", () => {
      const result = apply(resolved(), {
        eventType: "MarketResolved",
        payload: { ...MARKET_REF, outcome: "NO_WIN", resolvedAt: "2026-08-28T12:15:30Z" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_TERMINAL_OUTCOME_CONFLICT"]);
    });

    it("records the rules version the resolution names", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketResolved",
          payload: {
            ...MARKET_REF,
            outcome: "YES_WIN",
            resolvedAt: "2026-08-28T12:15:30Z",
            rulesVersionId: "rules-v2",
          },
        }),
      );
      expect(result.projection.rulesVersionId).toBe("rules-v2");
    });
  });

  describe("MarketClarificationObserved (the post-open case)", () => {
    it("moves an open market to PENDING_CLARIFICATION and marks the clarification after-open", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-1",
            observedAt: "2026-08-28T12:07:00Z",
          },
        }),
      );

      expect(result.projection.outcomeState).toBe("PENDING_CLARIFICATION");
      expect(result.projection.clarifications).toHaveLength(1);
      expect(result.projection.clarifications[0]?.afterOpen).toBe(true);
      expect(result.projection.clarifications[0]?.afterResolution).toBe(false);
      expect(clarificationsAfterOpen(result.projection)).toHaveLength(1);
    });

    it("marks a pre-open clarification as not after-open", () => {
      const result = expectApplied(
        apply(discoveredProjection(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-0",
            observedAt: "2026-08-28T11:00:00Z",
          },
        }),
      );
      expect(result.projection.clarifications[0]?.afterOpen).toBe(false);
      expect(result.projection.outcomeState).toBe("PENDING_CLARIFICATION");
      expect(clarificationsAfterOpen(result.projection)).toHaveLength(0);
    });

    it("judges after-open by the OBSERVATION instant, not by delivery order", () => {
      // Issued before the open, delivered while the market is already trading.
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-early",
            observedAt: "2026-08-28T11:30:00Z",
          },
        }),
      );
      expect(result.projection.clarifications[0]?.afterOpen).toBe(false);
      // It still halts the market for re-review: the rules the spec was
      // reviewed against have been amended either way.
      expect(result.projection.outcomeState).toBe("PENDING_CLARIFICATION");
    });

    it("records a post-resolution clarification without un-resolving the market", () => {
      const result = expectApplied(
        apply(resolved(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-late",
            observedAt: "2026-08-28T13:00:00Z",
          },
        }),
      );
      expect(result.projection.outcomeState).toBe("YES_WIN");
      expect(result.projection.clarifications[0]?.afterResolution).toBe(true);
    });

    it("is idempotent for a repeated clarification and refuses a contradicting one", () => {
      const first = expectApplied(
        apply(opened(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-1",
            observedAt: "2026-08-28T12:07:00Z",
          },
        }),
      ).projection;

      expect(
        expectApplied(
          apply(first, {
            eventType: "MarketClarificationObserved",
            payload: {
              ...MARKET_REF,
              clarificationId: "clar-1",
              observedAt: "2026-08-28T12:07:00Z",
            },
          }),
        ).changed,
      ).toBe(false);

      const conflicting = apply(first, {
        eventType: "MarketClarificationObserved",
        payload: {
          ...MARKET_REF,
          clarificationId: "clar-1",
          observedAt: "2026-08-28T12:09:00Z",
        },
      });
      expect(codes(conflicting)).toEqual(["UNIVERSE_LIFECYCLE_CONFLICT"]);
    });

    it("keeps the clarification's rules version separate from the market's", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketClarificationObserved",
          payload: {
            ...MARKET_REF,
            clarificationId: "clar-1",
            observedAt: "2026-08-28T12:07:00Z",
            rulesVersionId: "rules-v1",
          },
        }),
      );
      expect(result.projection.clarifications[0]?.rulesVersionId).toBe("rules-v1");
      // Only MarketRulesChanged moves the market's own rules version.
      expect(result.projection.rulesVersionId).toBeUndefined();
    });
  });

  describe("MarketRulesChanged", () => {
    it("records a new rules version", () => {
      const result = expectApplied(
        apply(opened(), {
          eventType: "MarketRulesChanged",
          payload: { ...MARKET_REF, rulesVersionId: "rules-v2", changedFields: ["resolution"] },
        }),
      );
      expect(result.projection.rulesVersionId).toBe("rules-v2");
    });

    it("refuses a change that follows a version the projection never saw", () => {
      const result = apply(opened(), {
        eventType: "MarketRulesChanged",
        payload: {
          ...MARKET_REF,
          rulesVersionId: "rules-v3",
          previousRulesVersionId: "rules-v2",
          changedFields: ["resolution"],
        },
      });
      expect(codes(result)).toEqual(["UNIVERSE_RULES_VERSION_MISMATCH"]);
    });

    it("is idempotent for the version already recorded", () => {
      const first = expectApplied(
        apply(opened(), {
          eventType: "MarketRulesChanged",
          payload: { ...MARKET_REF, rulesVersionId: "rules-v2", changedFields: ["resolution"] },
        }),
      ).projection;
      const again = expectApplied(
        apply(first, {
          eventType: "MarketRulesChanged",
          payload: { ...MARKET_REF, rulesVersionId: "rules-v2", changedFields: ["resolution"] },
        }),
      );
      expect(again.changed).toBe(false);
    });
  });

  describe("MarketMetadataChanged / MarketDiscovered", () => {
    it("advances the metadata version", () => {
      const result = expectApplied(
        apply(discoveredProjection(), {
          eventType: "MarketMetadataChanged",
          payload: {
            ...MARKET_REF,
            metadataVersion: 2,
            previousMetadataVersion: 1,
            changedFields: ["title"],
          },
        }),
      );
      expect(result.projection.metadataVersion).toBe(2);
    });

    it("refuses a metadata version that goes backwards or skips a version", () => {
      const projection = expectApplied(
        apply(discoveredProjection(), {
          eventType: "MarketMetadataChanged",
          payload: { ...MARKET_REF, metadataVersion: 3, changedFields: ["title"] },
        }),
      ).projection;

      expect(
        codes(
          apply(projection, {
            eventType: "MarketMetadataChanged",
            payload: { ...MARKET_REF, metadataVersion: 2, changedFields: ["title"] },
          }),
        ),
      ).toEqual(["UNIVERSE_METADATA_VERSION_NOT_ADVANCING"]);

      expect(
        codes(
          apply(projection, {
            eventType: "MarketMetadataChanged",
            payload: {
              ...MARKET_REF,
              metadataVersion: 5,
              previousMetadataVersion: 4,
              changedFields: ["title"],
            },
          }),
        ),
      ).toEqual(["UNIVERSE_METADATA_VERSION_NOT_ADVANCING"]);
    });

    it("treats MarketDiscovered for a registered market as an identity cross-check", () => {
      const identity = marketIdentitySample();
      const same = expectApplied(
        apply(discoveredProjection(), {
          eventType: "MarketDiscovered",
          payload: {
            ...MARKET_REF,
            yesTokenId: identity.yesTokenId,
            noTokenId: identity.noTokenId,
            metadataVersion: 1,
          },
        }),
      );
      expect(same.idempotent).toBe(true);

      const different = apply(discoveredProjection(), {
        eventType: "MarketDiscovered",
        payload: {
          ...MARKET_REF,
          yesTokenId: "999",
          noTokenId: identity.noTokenId,
          metadataVersion: 1,
        },
      });
      expect(codes(different)).toEqual(["UNIVERSE_MARKET_IDENTITY_CONFLICT"]);
    });

    it("refuses a MarketDiscovered carrying an older metadata version", () => {
      const projection = { ...discoveredProjection(), metadataVersion: 4 };
      const identity = marketIdentitySample();
      const result = apply(projection, {
        eventType: "MarketDiscovered",
        payload: {
          ...MARKET_REF,
          yesTokenId: identity.yesTokenId,
          noTokenId: identity.noTokenId,
          metadataVersion: 2,
        },
      });
      expect(codes(result)).toEqual(["UNIVERSE_METADATA_VERSION_NOT_ADVANCING"]);
    });
  });

  describe("TradingParametersChanged", () => {
    const base = {
      ...MARKET_REF,
      parametersVersion: 1,
      parameterVersionRef: `${SAMPLE_MARKET_ID}/v1`,
      changedParameters: ["tick_size"],
    } as const;

    it("accepts an event that agrees with the recorded version", () => {
      const result = expectApplied(
        apply(discoveredProjection(), {
          eventType: "TradingParametersChanged",
          payload: { ...base, tickSize: "0.01", minimumOrderSize: "5" },
        }),
      );
      expect(result.changed).toBe(false);
      expect(result.idempotent).toBe(true);
    });

    it("refuses an event naming a version the registry has not recorded", () => {
      const result = apply(discoveredProjection(), {
        eventType: "TradingParametersChanged",
        payload: { ...base, parametersVersion: 7, parameterVersionRef: `${SAMPLE_MARKET_ID}/v7` },
      });
      expect(codes(result)).toEqual(["UNIVERSE_PARAMETERS_VERSION_UNKNOWN"]);
    });

    it("refuses an event that contradicts the recorded version", () => {
      const result = apply(discoveredProjection(), {
        eventType: "TradingParametersChanged",
        payload: { ...base, tickSize: "0.05" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_PARAMETERS_EVENT_DISAGREES"]);
    });

    it("refuses an event whose version ref does not match", () => {
      const result = apply(discoveredProjection(), {
        eventType: "TradingParametersChanged",
        payload: { ...base, parameterVersionRef: "somewhere-else/v1" },
      });
      expect(codes(result)).toEqual(["UNIVERSE_PARAMETERS_EVENT_DISAGREES"]);
    });
  });
});

describe("recordObservedOutcomeState", () => {
  it("records DISPUTED, which no §7.4 event carries (ADR-009 §4)", () => {
    const result = expectApplied(
      recordObservedOutcomeState(opened(), {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
    );
    expect(result.projection.outcomeState).toBe("DISPUTED");
    expect(result.projection.lifecycleState).toBe("OPEN");
  });

  it.each(["YES_WIN", "NO_WIN", "SPLIT_50_50", "CANCELLED"] as const)(
    "refuses the terminal state %s: only MarketResolved determines a payoff",
    (outcomeState) => {
      const result = recordObservedOutcomeState(opened(), {
        outcomeState,
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusals.map((refusal) => refusal.code)).toEqual([
          "UNIVERSE_TERMINAL_OUTCOME_REQUIRES_EVENT",
        ]);
      }
    },
  );

  it("refuses to move a resolved market back to a non-terminal state", () => {
    const result = recordObservedOutcomeState(resolved(), {
      outcomeState: "DISPUTED",
      observedAt: "2026-08-28T12:30:00Z",
      observedBy: "operator:test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_TERMINAL_OUTCOME_CONFLICT",
      ]);
    }
  });

  it("refuses a state outside the §9.3 vocabulary", () => {
    const result = recordObservedOutcomeState(opened(), {
      outcomeState: "SOMETHING_ELSE" as unknown as MarketOutcomeState,
      observedAt: "2026-08-28T12:30:00Z",
      observedBy: "operator:test",
    });
    expect(result.ok).toBe(false);
  });

  it("is idempotent for the state already recorded", () => {
    const disputed = expectApplied(
      recordObservedOutcomeState(opened(), {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
    ).projection;
    const again = expectApplied(
      recordObservedOutcomeState(disputed, {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:31:00Z",
        observedBy: "operator:test",
      }),
    );
    expect(again.changed).toBe(false);
  });
});

describe("effectiveLifecycleState", () => {
  it("derives CLOSED from the announced close instant, using the caller's clock", () => {
    const closing = expectApplied(
      apply(opened(), {
        eventType: "MarketClosing",
        payload: { ...MARKET_REF, closesAt: "2026-08-28T12:15:00Z" },
      }),
    ).projection;

    expect(effectiveLifecycleState(closing, "2026-08-28T12:14:59Z")).toBe("CLOSING");
    expect(effectiveLifecycleState(closing, "2026-08-28T12:15:00Z")).toBe("CLOSED");
    expect(effectiveLifecycleState(closing, "2026-08-28T12:20:00Z")).toBe("CLOSED");
  });

  it("falls back to the scheduled close parameter when no event announced one", () => {
    const projection = opened();
    expect(effectiveCloseInstant(projection)).toBe("2026-08-28T12:15:00Z");
    expect(effectiveLifecycleState(projection, "2026-08-28T12:16:00Z")).toBe("CLOSED");
  });

  it("prefers the announced close over the scheduled parameter", () => {
    const closing = expectApplied(
      apply(opened(), {
        eventType: "MarketClosing",
        payload: { ...MARKET_REF, closesAt: "2026-08-28T12:30:00Z" },
      }),
    ).projection;
    expect(effectiveCloseInstant(closing)).toBe("2026-08-28T12:30:00Z");
    expect(effectiveLifecycleState(closing, "2026-08-28T12:16:00Z")).toBe("CLOSING");
  });

  it("keeps RESOLVED regardless of the instant", () => {
    expect(effectiveLifecycleState(resolved(), "2020-01-01T00:00:00Z")).toBe("RESOLVED");
  });

  it("returns the event-driven state when an instant is unparseable", () => {
    expect(effectiveLifecycleState(opened(), "not-a-timestamp")).toBe("OPEN");
  });
});
