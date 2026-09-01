/**
 * Property evidence for acceptance 4 — "parameter changes create immutable
 * history".
 *
 * The example tests pin specific transitions; these properties assert the
 * invariant over generated sequences, where a mutation-in-place bug that a
 * hand-written case happened to miss would show up.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendParameterVersion,
  createParameterHistory,
  currentParameterVersion,
  parametersAsOf,
  type MarketParameterHistory,
  type MarketParameterVersion,
  type MarketParameters,
} from "./parameters.js";
import { SAMPLE_MARKET_ID, parameterObservationSample } from "./testing/index.js";
import { instantMilliseconds } from "./time.js";

const CONDITION_ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

interface ParameterChange {
  readonly tickSizeDecimals: number;
  readonly minimumOrderSize: number;
  readonly negRisk: boolean;
  readonly tradingDelaySeconds: number;
  readonly status: "DISCOVERED" | "OPEN" | "CLOSING";
}

const parameterChange: fc.Arbitrary<ParameterChange> = fc.record({
  tickSizeDecimals: fc.integer({ min: 1, max: 6 }),
  minimumOrderSize: fc.integer({ min: 1, max: 500 }),
  negRisk: fc.boolean(),
  tradingDelaySeconds: fc.integer({ min: 0, max: 600 }),
  status: fc.constantFrom("DISCOVERED" as const, "OPEN" as const, "CLOSING" as const),
});

function parametersFrom(change: ParameterChange, base: MarketParameters): MarketParameters {
  return {
    ...base,
    tickSize: `0.${"0".repeat(change.tickSizeDecimals - 1)}1`,
    minimumOrderSize: String(change.minimumOrderSize),
    negRisk: change.negRisk,
    tradingDelaySeconds: change.tradingDelaySeconds,
    status: change.status,
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function minuteInstant(minute: number): string {
  const hour = 12 + Math.floor(minute / 60);
  return `2026-08-28T${String(hour).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
}

describe("parameter history (property)", () => {
  it("never rewrites a recorded version, whatever the sequence of changes", () => {
    fc.assert(
      fc.property(fc.array(parameterChange, { minLength: 1, maxLength: 12 }), (changes) => {
        let history: MarketParameterHistory = createParameterHistory(
          SAMPLE_MARKET_ID,
          parameterObservationSample(),
        );
        const first = currentParameterVersion(history);
        const snapshots: MarketParameterVersion[] = [deepClone(first)];
        const identities: MarketParameterVersion[] = [first];
        let minute = 0;

        for (const change of changes) {
          minute += 1;
          const result = appendParameterVersion(
            history,
            {
              parameters: parametersFrom(change, currentParameterVersion(history).parameters),
              observedAt: minuteInstant(minute),
              source: "polymarket",
            },
            CONDITION_ID,
          );
          if (!result.ok) {
            // The only legal refusal here is "nothing changed", and the history
            // must then be untouched.
            expect(result.refusals.map((refusal) => refusal.code)).toEqual([
              "UNIVERSE_PARAMETERS_UNCHANGED",
            ]);
            continue;
          }
          const previousLength = history.versions.length;
          history = result.value.history;
          expect(history.versions).toHaveLength(previousLength + 1);
          snapshots.push(deepClone(result.value.version));
          identities.push(result.value.version);
        }

        // Every version ever recorded is still present, unchanged, and still
        // the same object.
        expect(history.versions).toHaveLength(snapshots.length);
        history.versions.forEach((version, index) => {
          expect(version).toEqual(snapshots[index]);
          expect(version).toBe(identities[index]);
          expect(version.parametersVersion).toBe(index + 1);
          expect(version.previousParametersVersion).toBe(index === 0 ? undefined : index);
        });
      }),
      { numRuns: 100 },
    );
  });

  it("answers `parametersAsOf` with the newest version not observed after the instant", () => {
    fc.assert(
      fc.property(fc.array(parameterChange, { minLength: 1, maxLength: 8 }), (changes) => {
        let history: MarketParameterHistory = createParameterHistory(
          SAMPLE_MARKET_ID,
          parameterObservationSample(),
        );
        let minute = 0;
        for (const change of changes) {
          minute += 1;
          const result = appendParameterVersion(
            history,
            {
              parameters: parametersFrom(change, currentParameterVersion(history).parameters),
              observedAt: minuteInstant(minute),
              source: "polymarket",
            },
            CONDITION_ID,
          );
          if (result.ok) {
            history = result.value.history;
          }
        }

        for (const version of history.versions) {
          const found = parametersAsOf(history, version.observedAt);
          expect(found).toBeDefined();
          if (found === undefined) {
            continue;
          }
          expect(found.parametersVersion).toBeGreaterThanOrEqual(version.parametersVersion);
          // Nothing observed after the query instant is ever returned.
          expect(instantMilliseconds(found.observedAt)).toBeLessThanOrEqual(
            instantMilliseconds(version.observedAt) ?? 0,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});
