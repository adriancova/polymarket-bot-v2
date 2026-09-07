/**
 * THE REGISTRATION DOORS' BOUNDARY SUITE — `schema-boundary.md` §5 item 9(a).
 *
 * Every pollution battery here is scoped: the property is installed on
 * `Object.prototype`, the door runs, and the property is removed in a `finally`
 * before anything is asserted. Nothing in this file leaves the prototype dirty,
 * and every registry a test folds onto is built at module load, BEFORE any
 * pollution exists.
 *
 * WHY THE ASSERTIONS READ OWN PROPERTIES. A stored series is null-prototype at
 * the tip but the value under test may not be, and `series.cadence` on a
 * prototype-BEARING record answers from `Object.prototype` while the pollution
 * is installed. Every assertion below therefore goes through {@link ownValue} /
 * {@link hasOwnKey}.
 *
 * BASE MEASUREMENT (`989d41d`, real base code, both pollution variants; the
 * transcripts are in the `UNIV-2` handoff): all 9 declared keys of
 * `SeriesDefinitionSchema` adopt — including a fabricated
 * `{approved: true, approvedBy: "ghost", approvedAt: …}` binding, after which
 * `bindMarketToSeries` returned OK; all 7 declared keys of
 * `MarketIdentitySchema` adopt; `registerMarket(registry, {})` REGISTERED A
 * MARKET; `approveSeries` and `bindMarketToSeries` take the approver, the
 * instant and the ids they act on from the prototype; an inherited `tickSize`
 * recorded `"0.99"` into an immutable parameter version;
 * `applyMarketEvent(registry, id, {})` OPENED a market and
 * `recordMarketOutcomeState(registry, id, {})` recorded `DISPUTED`, both in
 * BOTH variants; and four hostile prototype shapes turned a clean refusal into
 * an escaping `TypeError`. Each of those is a test below.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { contained, readDeclaredFields, readOwnFields, ownRecord } from "./caller-door.js";
import type { UniverseResult } from "./errors.js";
import { MarketIdentitySchema } from "./identity.js";
import { MarketParametersSchema, ParameterObservationSchema } from "./parameters.js";
import {
  LIFECYCLE_INPUT_KEYS,
  MARKET_IDENTITY_FIELDS,
  MARKET_REGISTRATION_KEYS,
  OBSERVED_OUTCOME_STATE_KEYS,
  SERIES_APPROVAL_KEYS,
  SERIES_BINDING_KEYS,
  SERIES_DEFINITION_FIELDS,
  openMarketIdentity,
  openSeriesDefinition,
} from "./registration-door.js";
import {
  applyMarketEvent,
  approveSeries,
  bindMarketToSeries,
  createUniverseRegistry,
  recordMarketOutcomeState,
  recordMarketParameters,
  recordSeriesSuggestion,
  registerMarket,
  registerSeries,
  suggestSeriesForMarket,
  type UniverseRegistry,
} from "./registry.js";
import { SeriesDefinitionSchema } from "./series.js";
import {
  SAMPLE_MARKET_ID,
  SAMPLE_SERIES_ID,
  marketIdentitySample,
  parameterObservationSample,
  seriesDefinitionSample,
} from "./testing/index.js";

// ---------------------------------------------------------------------------
// pollution and own-read helpers
// ---------------------------------------------------------------------------

/** Installs one inherited property for the duration of `run`, then removes it. */
function withInherited<T>(key: string, descriptor: PropertyDescriptor, run: () => T): T {
  Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

function inheritedValue(value: unknown, enumerable: boolean): PropertyDescriptor {
  return { value, enumerable, writable: true };
}

const VARIANTS = [
  { label: "non-enumerable", enumerable: false },
  { label: "enumerable", enumerable: true },
] as const;

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function hasOwnKey(record: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined;
}

type Attempt<T> =
  | { readonly kind: "returned"; readonly value: T }
  | { readonly kind: "threw"; readonly error: string };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { kind: "returned", value: run() };
  } catch (error: unknown) {
    return { kind: "threw", error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

/** The refusal codes, or a failure if the door let an exception escape. */
function codesOf<T>(outcome: Attempt<UniverseResult<T>>): readonly string[] {
  if (outcome.kind === "threw") {
    throw new Error(`the door let an exception escape: ${outcome.error}`);
  }
  return outcome.value.ok ? [] : outcome.value.refusals.map((refusal) => refusal.code);
}

function valueOf<T>(outcome: Attempt<UniverseResult<T>>): T {
  if (outcome.kind === "threw") {
    throw new Error(`the door let an exception escape: ${outcome.error}`);
  }
  if (!outcome.value.ok) {
    throw new Error(`expected success, got ${outcome.value.refusals.map((r) => r.code).join(", ")}`);
  }
  return outcome.value.value;
}

function withoutKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// fixtures, all built before any pollution exists
// ---------------------------------------------------------------------------

const CONDITION_ID = marketIdentitySample().conditionId;
const SERIES = seriesDefinitionSample() as unknown as Record<string, unknown>;
const IDENTITY = marketIdentitySample() as unknown as Record<string, unknown>;
const OBSERVATION = parameterObservationSample() as unknown as Record<string, unknown>;
const PARAMETERS = parameterObservationSample().parameters as unknown as Record<string, unknown>;

const EMPTY: UniverseRegistry = createUniverseRegistry();

function expectOk<T>(result: UniverseResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.refusals.map((r) => r.code).join(", ")}`);
  }
  return result.value;
}

const WITH_MARKET: UniverseRegistry = expectOk(
  registerMarket(EMPTY, {
    identity: marketIdentitySample(),
    parameters: parameterObservationSample(),
  }),
).registry;
const SEEDED: UniverseRegistry = expectOk(registerSeries(WITH_MARKET, seriesDefinitionSample()));
const APPROVED: UniverseRegistry = expectOk(
  approveSeries(SEEDED, {
    seriesId: SAMPLE_SERIES_ID,
    approvedBy: "reviewer",
    approvedAt: "2026-08-28T00:00:00Z",
  }),
);

// ---------------------------------------------------------------------------
// 1. the measured rows
// ---------------------------------------------------------------------------

describe("the measured rows of schema-boundary §3 (the registration half)", () => {
  it("refuses the GHOST APPROVAL: a series whose binding only the prototype carries", () => {
    // BASE, non-enumerable: the series registered with
    // `{"approved":true,"approvedBy":"ghost","approvedAt":"2026-08-28T00:00:00Z"}`
    // and `bindMarketToSeries` then returned OK — a market bound to a series
    // through a review that never happened (§9.2's one gate).
    const ghost = {
      approved: true,
      approvedBy: "ghost",
      approvedAt: "2026-08-28T00:00:00Z",
    };
    for (const variant of VARIANTS) {
      const outcome = withInherited("binding", inheritedValue(ghost, variant.enumerable), () =>
        attempt(() => registerSeries(WITH_MARKET, withoutKey(SERIES, "binding"))),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("refuses a binding whose approved DISCRIMINATOR only the prototype carries", () => {
    // BASE: this threw `propValues[key].add is not a function` out of
    // `registerSeries` (the cold `discriminatedUnion` build — the same class
    // `SETL-1` measured on `status`). Contained here, and refused.
    for (const variant of VARIANTS) {
      const outcome = withInherited("approved", inheritedValue(true, variant.enumerable), () =>
        attempt(() =>
          registerSeries(WITH_MARKET, {
            ...SERIES,
            binding: { approvedBy: "ghost", approvedAt: "2026-08-28T00:00:00Z" },
          }),
        ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("refuses an approveSeries whose two review facts only the prototype carries", () => {
    // BASE: stored `{"approved":true,"approvedBy":"ghost","approvedAt":"2099-01-01T00:00:00Z"}`.
    for (const variant of VARIANTS) {
      const outcome = withInherited("approvedBy", inheritedValue("ghost", variant.enumerable), () =>
        withInherited("approvedAt", inheritedValue("2099-01-01T00:00:00Z", variant.enumerable), () =>
          attempt(() => approveSeries(SEEDED, { seriesId: SAMPLE_SERIES_ID } as never)),
        ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("refuses to approve, or to bind to, a series only the prototype named", () => {
    // BASE: both returned OK — a series approved, and a market bound, on an id
    // the caller never supplied.
    for (const variant of VARIANTS) {
      const approval = withInherited(
        "seriesId",
        inheritedValue(SAMPLE_SERIES_ID, variant.enumerable),
        () =>
          attempt(() =>
            approveSeries(SEEDED, {
              approvedBy: "operator",
              approvedAt: "2026-08-28T01:00:00Z",
            } as never),
          ),
      );
      expect(codesOf(approval), variant.label).toEqual(["UNIVERSE_SERIES_UNKNOWN"]);

      const binding = withInherited(
        "seriesId",
        inheritedValue(SAMPLE_SERIES_ID, variant.enumerable),
        () =>
          attempt(() =>
            bindMarketToSeries(APPROVED, {
              internalMarketId: SAMPLE_MARKET_ID,
              approvedBy: "operator",
              approvedAt: "2026-08-28T01:00:00Z",
            } as never),
          ),
      );
      expect(codesOf(binding), variant.label).toEqual(["UNIVERSE_SERIES_UNKNOWN"]);
    }
  });

  it("records no approver a bindMarketToSeries call did not carry", () => {
    // BASE, BOTH variants: `binding.approvedBy` became `"ghost"` — the human
    // identity §9.2 requires, supplied by `Object.prototype`. `UNIV-2` closed the
    // ADOPTION and left the value UNGUARDED, so the call still succeeded and
    // stored an APPROVED binding with no approver at all; `UNIV-3` item 9(c)
    // aligns it with `approveSeries`' existing `SeriesDefinitionSchema` guard, so
    // the same call is now REFUSED. Both halves are pinned: no ghost is adopted,
    // and no approver-less approval is recorded either.
    for (const variant of VARIANTS) {
      const outcome = withInherited("approvedBy", inheritedValue("ghost", variant.enumerable), () =>
        attempt(() =>
          bindMarketToSeries(APPROVED, {
            internalMarketId: SAMPLE_MARKET_ID,
            seriesId: SAMPLE_SERIES_ID,
            approvedAt: "2026-08-28T01:00:00Z",
          } as never),
        ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
      // And the registry it was applied to is untouched: no binding was stored.
      const binding = APPROVED.markets.get(SAMPLE_MARKET_ID)?.seriesBinding as object;
      expect(ownValue(binding, "approvedBy"), variant.label).toBeUndefined();
    }
  });

  it("registers no market whose identity and parameters only the prototype carries", () => {
    // BASE: `registerMarket(registry, {})` returned OK, with a whole market.
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "identity",
        inheritedValue(marketIdentitySample(), variant.enumerable),
        () =>
          withInherited(
            "parameters",
            inheritedValue(parameterObservationSample(), variant.enumerable),
            () => attempt(() => registerMarket(EMPTY, {} as never)),
          ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("records no metadataVersion the registration did not carry", () => {
    // BASE: `projection.metadataVersion` became 77.
    for (const variant of VARIANTS) {
      const outcome = withInherited("metadataVersion", inheritedValue(77, variant.enumerable), () =>
        attempt(() =>
          registerMarket(EMPTY, {
            identity: marketIdentitySample(),
            parameters: parameterObservationSample(),
          }),
        ),
      );
      expect(ownValue(valueOf(outcome).projection, "metadataVersion"), variant.label).toBe(1);
    }
  });

  it("records no ECONOMIC parameter the observation did not carry", () => {
    // BASE: an inherited `tickSize` recorded `"0.99"` into an immutable
    // parameter version — `docs/contracts/domain.md` §6.4's versioned tick.
    for (const variant of VARIANTS) {
      const observation = {
        parameters: withoutKey(PARAMETERS, "tickSize"),
        observedAt: "2026-08-28T12:05:00Z",
        source: "polymarket",
      };
      const outcome = withInherited("tickSize", inheritedValue("0.99", variant.enumerable), () =>
        attempt(() => recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, observation as never)),
      );
      expect(outcome.kind, variant.label).toBe("threw");
      if (outcome.kind === "threw") {
        // The frozen observation schema's own verdict, unchanged from base.
        expect(outcome.error).toBe(
          "UniverseValidationError: market parameter observation is invalid: parameters.tickSize: Invalid input: expected string, received undefined",
        );
      }
    }
  });

  it("folds no event whose type, payload or order only the prototype carries", () => {
    // BASE, BOTH variants: `applyMarketEvent(registry, id, {})` OPENED the
    // market at `2099-01-01T00:00:00Z`.
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "eventType",
        inheritedValue("MarketOpened", variant.enumerable),
        () =>
          withInherited(
            "payload",
            inheritedValue(
              {
                internalMarketId: SAMPLE_MARKET_ID,
                conditionId: CONDITION_ID,
                openedAt: "2099-01-01T00:00:00Z",
              },
              variant.enumerable,
            ),
            () => attempt(() => applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {} as never)),
          ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("compares the replay guard against no ordering the event did not carry", () => {
    // BASE, BOTH variants: an inherited `order` carrying a stale `ingestSeq`
    // made the registry REFUSE an honest event as a replay.
    const opened = expectOk(
      applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: CONDITION_ID,
          openedAt: "2026-08-28T12:00:00Z",
        },
        order: { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e", ingestSeq: "5" },
      }),
    );
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "order",
        inheritedValue(
          { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e", ingestSeq: "1" },
          variant.enumerable,
        ),
        () =>
          attempt(() =>
            applyMarketEvent(opened.registry, SAMPLE_MARKET_ID, {
              eventType: "MarketClosing",
              payload: {
                internalMarketId: SAMPLE_MARKET_ID,
                conditionId: CONDITION_ID,
                closesAt: "2026-08-28T12:15:00Z",
              },
            } as never),
          ),
      );
      expect(codesOf(outcome), variant.label).toEqual([]);
    }
  });

  it("records no observed outcome state the caller did not assert", () => {
    // BASE, BOTH variants: `recordMarketOutcomeState(registry, id, {})`
    // recorded `DISPUTED` — the one state §9.3 lets an operator assert.
    for (const variant of VARIANTS) {
      const outcome = withInherited(
        "outcomeState",
        inheritedValue("DISPUTED", variant.enumerable),
        () =>
          withInherited("observedAt", inheritedValue("2099-01-01T00:00:00Z", variant.enumerable), () =>
            withInherited("observedBy", inheritedValue("ghost", variant.enumerable), () =>
              attempt(() => recordMarketOutcomeState(SEEDED, SAMPLE_MARKET_ID, {} as never)),
            ),
          ),
      );
      expect(codesOf(outcome), variant.label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. the declared-key sweeps
// ---------------------------------------------------------------------------

const SERIES_INHERITED: Readonly<Record<string, unknown>> = Object.freeze({
  seriesId: SAMPLE_SERIES_ID,
  seriesKey: "phantom-key",
  displayName: "phantom display name",
  underlyingSymbol: "eth.usd",
  cadence: "PT1H",
  description: "a description no operator wrote",
  binding: { approved: true, approvedBy: "ghost", approvedAt: "2026-08-28T00:00:00Z" },
  activeSettlementSpecId: "01936f00-0000-7000-8000-00000000c999",
  active: true,
});

const IDENTITY_INHERITED: Readonly<Record<string, unknown>> = Object.freeze({
  internalMarketId: SAMPLE_MARKET_ID,
  conditionId: "0x00000000000000000000000000000000000000000000000000000000000000ff",
  venueEventId: "event-from-the-prototype",
  venueMarketSlug: "slug-from-the-prototype",
  yesTokenId: "1000000001",
  noTokenId: "1000000002",
  questionTitle: "a question nobody asked",
});

const PARAMETERS_INHERITED: Readonly<Record<string, unknown>> = Object.freeze({
  tickSize: "0.99",
  minimumOrderSize: "999",
  negRisk: true,
  tradingDelaySeconds: 99,
  feeScheduleRef: "fee-from-the-prototype",
  openTime: "2020-01-01T00:00:00Z",
  closeTime: "2099-01-02T00:00:00Z",
  status: "OPEN",
});

const OBSERVATION_INHERITED: Readonly<Record<string, unknown>> = Object.freeze({
  parameters: { ...PARAMETERS, tickSize: "0.99" },
  observedAt: "2099-01-01T00:00:00Z",
  source: "internal",
});

describe("the declared-key sweep: registerSeries", () => {
  it("adopts no declared key from the prototype, in either variant", () => {
    const swept: string[] = [];
    for (const field of SERIES_DEFINITION_FIELDS) {
      const definition = withoutKey(SERIES, field.key);
      const clean = attempt(() => registerSeries(WITH_MARKET, { ...definition }));
      for (const variant of VARIANTS) {
        const outcome = withInherited(
          field.key,
          inheritedValue(SERIES_INHERITED[field.key], variant.enumerable),
          () => attempt(() => registerSeries(WITH_MARKET, { ...definition })),
        );
        swept.push(`${field.key}.${variant.label}`);
        if (field.required) {
          // BASE: every one of these registered.
          expect(codesOf(outcome), `${field.key} (${variant.label})`).toEqual([
            "UNIVERSE_INPUT_INVALID",
          ]);
          continue;
        }
        // An optional key is not a refusal when absent, so the pin is that the
        // registration BEHAVES as if it were absent: at base an inherited
        // `activeSettlementSpecId` became the series' active settlement spec,
        // which `eligibility.ts` compares a settlement verdict against.
        expect(codesOf(outcome), `${field.key} (${variant.label})`).toEqual(codesOf(clean));
        const stored = valueOf(outcome).series.get(SAMPLE_SERIES_ID);
        expect(stored, field.key).toBeDefined();
        expect(hasOwnKey(stored as object, field.key), `${field.key} (${variant.label})`).toBe(
          false,
        );
      }
    }
    expect(swept).toHaveLength(18);
  });
});

describe("the declared-key sweep: registerMarket", () => {
  it("adopts no identity key from the prototype, in either variant", () => {
    const swept: string[] = [];
    for (const field of MARKET_IDENTITY_FIELDS) {
      const identity = withoutKey(IDENTITY, field.key);
      for (const variant of VARIANTS) {
        const outcome = withInherited(
          field.key,
          inheritedValue(IDENTITY_INHERITED[field.key], variant.enumerable),
          () =>
            attempt(() =>
              registerMarket(EMPTY, {
                identity: { ...identity },
                parameters: parameterObservationSample(),
              }),
            ),
        );
        swept.push(`${field.key}.${variant.label}`);
        if (field.required) {
          expect(codesOf(outcome), `${field.key} (${variant.label})`).toEqual([
            "UNIVERSE_INPUT_INVALID",
          ]);
          continue;
        }
        const registered = valueOf(outcome);
        expect(
          hasOwnKey(registered.projection.identity as object, field.key),
          `${field.key} (${variant.label})`,
        ).toBe(false);
      }
    }
    expect(swept).toHaveLength(14);
  });

  it("adopts none of the input record's own three keys", () => {
    const swept: string[] = [];
    for (const key of MARKET_REGISTRATION_KEYS) {
      const inherited =
        key === "identity"
          ? marketIdentitySample()
          : key === "parameters"
            ? parameterObservationSample()
            : 77;
      const input =
        key === "metadataVersion"
          ? { identity: marketIdentitySample(), parameters: parameterObservationSample() }
          : key === "identity"
            ? { parameters: parameterObservationSample() }
            : { identity: marketIdentitySample() };
      for (const variant of VARIANTS) {
        const outcome = withInherited(key, inheritedValue(inherited, variant.enumerable), () =>
          attempt(() => registerMarket(EMPTY, input as never)),
        );
        swept.push(`${key}.${variant.label}`);
        if (key === "metadataVersion") {
          expect(ownValue(valueOf(outcome).projection, "metadataVersion")).toBe(1);
          continue;
        }
        if (key === "identity") {
          expect(codesOf(outcome), `${key} (${variant.label})`).toEqual(["UNIVERSE_INPUT_INVALID"]);
          continue;
        }
        // A missing observation is `./parameters.ts`'s documented throw, and it
        // stays that way — what it may not be is answered by the prototype.
        expect(outcome.kind, `${key} (${variant.label})`).toBe("threw");
      }
    }
    expect(swept).toHaveLength(6);
  });
});

describe("the declared-key sweep: recordMarketParameters", () => {
  it("adopts no observation key and no snapshot member from the prototype", () => {
    const swept: string[] = [];
    const observationKeys = Object.keys(ParameterObservationSchema.shape);
    const parameterKeys = Object.keys(MarketParametersSchema.shape);
    for (const key of observationKeys) {
      const observation = withoutKey({ ...OBSERVATION }, key);
      for (const variant of VARIANTS) {
        const outcome = withInherited(
          key,
          inheritedValue(OBSERVATION_INHERITED[key], variant.enumerable),
          () => attempt(() => recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, observation as never)),
        );
        swept.push(`observation.${key}.${variant.label}`);
        // BASE: `parameters`, `observedAt` and `source` all came from the
        // prototype and a new immutable version was recorded.
        expect(outcome.kind, `${key} (${variant.label})`).toBe("threw");
      }
    }
    for (const key of parameterKeys) {
      const parameters = withoutKey({ ...PARAMETERS }, key);
      const observation = {
        parameters,
        observedAt: "2026-08-28T12:05:00Z",
        source: "polymarket",
      };
      const cleanOutcome = attempt(() =>
        recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
          ...observation,
          parameters: { ...parameters },
        } as never),
      );
      for (const variant of VARIANTS) {
        const outcome = withInherited(
          key,
          inheritedValue(PARAMETERS_INHERITED[key], variant.enumerable),
          () =>
            attempt(() =>
              recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
                ...observation,
                parameters: { ...parameters },
              } as never),
            ),
        );
        swept.push(`parameters.${key}.${variant.label}`);
        if (cleanOutcome.kind === "threw") {
          expect(outcome.kind, `${key} (${variant.label})`).toBe("threw");
          continue;
        }
        // An optional member: the recorded version must carry no value the
        // observation did not carry.
        const recorded = valueOf(outcome as Attempt<UniverseResult<{ version: { parameters: object } }>>);
        expect(hasOwnKey(recorded.version.parameters, key), `${key} (${variant.label})`).toBe(false);
      }
    }
    expect(swept).toHaveLength(22);
  });

  it("sweeps exactly the keys the two frozen schemas declare", () => {
    expect(Object.keys(ParameterObservationSchema.shape).sort()).toEqual([
      "observedAt",
      "parameters",
      "source",
    ]);
    expect(Object.keys(MarketParametersSchema.shape).sort()).toEqual([
      "closeTime",
      "feeScheduleRef",
      "minimumOrderSize",
      "negRisk",
      "openTime",
      "status",
      "tickSize",
      "tradingDelaySeconds",
    ]);
  });
});

describe("the declared-key sweep: the approval and event input records", () => {
  it("adopts no key of approveSeries', bindMarketToSeries' or the event inputs", () => {
    const swept: string[] = [];
    const approvalInherited: Readonly<Record<string, unknown>> = {
      seriesId: SAMPLE_SERIES_ID,
      internalMarketId: SAMPLE_MARKET_ID,
      approvedBy: "ghost",
      approvedAt: "2099-01-01T00:00:00Z",
      outcomeState: "DISPUTED",
      observedAt: "2099-01-01T00:00:00Z",
      observedBy: "ghost",
      eventType: "MarketOpened",
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        conditionId: CONDITION_ID,
        openedAt: "2099-01-01T00:00:00Z",
      },
      order: { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e", ingestSeq: "1" },
    };
    const doors: readonly (readonly [string, readonly string[], (input: unknown) => unknown])[] = [
      [
        "approveSeries",
        SERIES_APPROVAL_KEYS,
        (input) => approveSeries(SEEDED, input as never),
      ],
      [
        "bindMarketToSeries",
        SERIES_BINDING_KEYS,
        (input) => bindMarketToSeries(APPROVED, input as never),
      ],
      [
        "applyMarketEvent",
        LIFECYCLE_INPUT_KEYS,
        (input) => applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, input as never),
      ],
      [
        "recordMarketOutcomeState",
        OBSERVED_OUTCOME_STATE_KEYS,
        (input) => recordMarketOutcomeState(SEEDED, SAMPLE_MARKET_ID, input as never),
      ],
    ];
    for (const [label, keys, run] of doors) {
      for (const key of keys) {
        for (const variant of VARIANTS) {
          // The door is called with an EMPTY record: every key it reads would
          // have to come from the prototype.
          const clean = attempt(() => run({}));
          const outcome = withInherited(
            key,
            inheritedValue(approvalInherited[key], variant.enumerable),
            () => attempt(() => run({})),
          );
          swept.push(`${label}.${key}.${variant.label}`);
          const cleanCodes =
            clean.kind === "threw" ? ["THREW"] : codesOf(clean as Attempt<UniverseResult<unknown>>);
          const pollutedCodes =
            outcome.kind === "threw"
              ? ["THREW"]
              : codesOf(outcome as Attempt<UniverseResult<unknown>>);
          expect(pollutedCodes, `${label}.${key} (${variant.label})`).toEqual(cleanCodes);
        }
      }
    }
    // 3 + 4 + 3 + 3 declared keys across the four doors, in both variants.
    expect(swept).toHaveLength(26);
  });
});

// ---------------------------------------------------------------------------
// 3. the census: the doors' read tables may not drift from the frozen schemas
// ---------------------------------------------------------------------------

describe("the doors' declared tables are derived from the frozen schemas", () => {
  const CASES = [
    ["SeriesDefinitionSchema", SeriesDefinitionSchema, SERIES_DEFINITION_FIELDS],
    ["MarketIdentitySchema", MarketIdentitySchema, MARKET_IDENTITY_FIELDS],
  ] as const;

  for (const [label, schema, fields] of CASES) {
    it(`${label}: exactly the declared keys, with the same required split`, () => {
      const shape = schema.shape as unknown as Readonly<
        Record<string, { safeParse: (value: unknown) => { success: boolean } }>
      >;
      expect([...fields].map((field) => field.key).sort()).toEqual(Object.keys(shape).sort());
      for (const field of fields) {
        const member = shape[field.key];
        expect(member, `${label}.${field.key}`).toBeDefined();
        // A key the schema accepts as `undefined` is optional; anything else is
        // required, and the door must refuse the record that omits it.
        const optionalInSchema = member?.safeParse(undefined).success === true;
        expect(field.required, `${label}.${field.key}`).toBe(!optionalInSchema);
      }
    });
  }

  it("counts 6 required + 3 optional series keys and 4 required + 3 optional identity keys", () => {
    const count = (fields: readonly { readonly required: boolean }[]): Record<string, number> => ({
      required: fields.filter((field) => field.required).length,
      optional: fields.filter((field) => !field.required).length,
    });
    expect(count(SERIES_DEFINITION_FIELDS)).toEqual({ required: 6, optional: 3 });
    expect(count(MARKET_IDENTITY_FIELDS)).toEqual({ required: 4, optional: 3 });
  });

  it("declares the input records' own key lists, which have no schema", () => {
    expect([...MARKET_REGISTRATION_KEYS]).toEqual(["identity", "parameters", "metadataVersion"]);
    expect([...SERIES_APPROVAL_KEYS]).toEqual(["seriesId", "approvedBy", "approvedAt"]);
    expect([...SERIES_BINDING_KEYS]).toEqual([
      "internalMarketId",
      "seriesId",
      "approvedBy",
      "approvedAt",
    ]);
    expect([...LIFECYCLE_INPUT_KEYS]).toEqual(["eventType", "payload", "order"]);
    expect([...OBSERVED_OUTCOME_STATE_KEYS]).toEqual([
      "outcomeState",
      "observedAt",
      "observedBy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. containment
// ---------------------------------------------------------------------------

describe("the refusal construction is contained (ADR-020 amendment 2026-09-06)", () => {
  /**
   * Shapes that drive `zod`'s own error-construction path. FOUR of these turned
   * `registerSeries`', `registerMarket`'s and `recordMarketParameters`' clean
   * refusal into an escaping `TypeError` at base.
   */
  const HOSTILE: readonly (readonly [string, PropertyDescriptor])[] = [
    ["get (data)", { value: () => undefined, enumerable: false }],
    ["get (accessor)", { get: () => () => undefined, enumerable: false }],
    ["value (data)", { value: "hijacked", enumerable: false }],
    ["value (accessor)", { get: () => "hijacked", enumerable: false }],
    ["_zod (data)", { value: {}, enumerable: false }],
    ["_zod (accessor)", { get: () => ({}), enumerable: false }],
    ["message (data)", { value: "hijacked", enumerable: false }],
    ["message (accessor)", { get: () => "hijacked", enumerable: false }],
    ["path (data)", { value: ["hijacked"], enumerable: false }],
    ["status (data)", { value: "hijacked", enumerable: false }],
    ["issues (data)", { value: [], enumerable: false }],
    ["def (data)", { value: {}, enumerable: false }],
  ];

  for (const [label, descriptor] of HOSTILE) {
    it(`refuses a malformed registration rather than throwing under an inherited ${label}`, () => {
      const key = label.slice(0, label.indexOf(" "));
      const series = withInherited(key, descriptor, () =>
        attempt(() => registerSeries(EMPTY, { ...SERIES, seriesKey: "not a code!!" })),
      );
      expect(codesOf(series), `registerSeries/${label}`).toEqual(["UNIVERSE_INPUT_INVALID"]);

      const market = withInherited(key, descriptor, () =>
        attempt(() =>
          registerMarket(EMPTY, {
            identity: { ...IDENTITY, internalMarketId: "not-a-uuid" },
            parameters: parameterObservationSample(),
          }),
        ),
      );
      expect(codesOf(market), `registerMarket/${label}`).toEqual(["UNIVERSE_INPUT_INVALID"]);

      const unknownMarket = withInherited(key, descriptor, () =>
        attempt(() => suggestSeriesForMarket(SEEDED, "not-a-uuid")),
      );
      expect(codesOf(unknownMarket), `requireMarket/${label}`).toEqual(["UNIVERSE_INPUT_INVALID"]);
    });
  }

  it("refuses rather than throwing a TypeError out of recordMarketParameters", () => {
    // The four shapes that escaped at base AND at the candidate before the
    // containment: the observation schema lives in `./parameters.ts`, whose
    // documented `UniverseValidationError` still propagates — a bare `TypeError`
    // from `zod`'s issue construction does not.
    for (const [label, descriptor] of HOSTILE.filter(([name]) =>
      ["get (data)", "value (data)", "_zod (data)", "message (data)"].includes(name),
    )) {
      const outcome = withInherited(label.slice(0, label.indexOf(" ")), descriptor, () =>
        attempt(() =>
          recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
            ...OBSERVATION,
            observedAt: "yesterday",
          } as never),
        ),
      );
      expect(codesOf(outcome), label).toEqual(["UNIVERSE_INPUT_INVALID"]);
    }
  });

  it("keeps ./parameters.ts's documented throw contract", () => {
    // The containment converts a `TypeError` into a refusal and nothing else:
    // an invalid observation still THROWS `UniverseValidationError`, which is
    // the verdict every existing caller sees.
    const outcome = attempt(() =>
      recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
        ...OBSERVATION,
        observedAt: "yesterday",
      } as never),
    );
    expect(outcome.kind).toBe("threw");
    if (outcome.kind === "threw") {
      expect(outcome.error).toBe(
        "UniverseValidationError: market parameter observation is invalid: observedAt: Invalid ISO datetime",
      );
    }
  });

  it("refuses an honest-but-wrong definition with the frozen schema's own message", () => {
    const result = registerSeries(EMPTY, { ...SERIES, seriesKey: "not a code!!" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.message).toBe(
        "series definition is invalid: seriesKey: must be an alphanumeric code without whitespace",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. D1/D3/D4
// ---------------------------------------------------------------------------

describe("D1/D3/D4 — what the doors read, and what they emit", () => {
  it("stores a series and an identity with a null prototype, frozen", () => {
    const stored = SEEDED.series.get(SAMPLE_SERIES_ID);
    expect(stored).toBeDefined();
    expect(Object.getPrototypeOf(stored as object)).toBe(null);
    expect(Object.isFrozen(stored)).toBe(true);
    const identity = SEEDED.markets.get(SAMPLE_MARKET_ID)?.identity;
    expect(Object.getPrototypeOf(identity as object)).toBe(null);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("answers an absent optional field from nothing, not from Object.prototype", () => {
    // The measured D4 cell: `eligibility.ts` asks
    // `input.series.activeSettlementSpecId === undefined` before it lets a
    // model-dependent activation through, and `series.ts` asks
    // `candidate.cadence !== undefined` before it reports a cadence match.
    const bare = expectOk(
      registerSeries(EMPTY, {
        ...withoutKey(withoutKey(SERIES, "activeSettlementSpecId"), "cadence"),
      }),
    ).series.get(SAMPLE_SERIES_ID) as { readonly activeSettlementSpecId?: string; readonly cadence?: string };
    for (const key of ["activeSettlementSpecId", "cadence"] as const) {
      const answered = withInherited(key, inheritedValue("from-the-prototype", false), () =>
        key === "cadence" ? bare.cadence : bare.activeSettlementSpecId,
      );
      expect(answered, key).toBeUndefined();
    }
  });

  it("emits a MarketDiscovered payload whose absent seriesId nothing can answer", () => {
    const registered = expectOk(
      registerMarket(EMPTY, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
    );
    expect(Object.getPrototypeOf(registered.event)).toBe(null);
    const answered = withInherited("seriesId", inheritedValue("phantom-series", false), () =>
      (registered.event as { readonly seriesId?: string }).seriesId,
    );
    expect(answered).toBeUndefined();
  });

  it("emits records whose properties cannot be replaced afterwards", () => {
    const emitted = ownRecord<Record<string, unknown>>({ a: 1, b: undefined });
    expect(Object.getPrototypeOf(emitted)).toBe(null);
    expect(hasOwnKey(emitted, "b")).toBe(false);
    expect(() => {
      "use strict";
      (emitted as { a: unknown }).a = 2;
    }).toThrow();
  });

  it("refuses an accessor on a caller record without invoking it", () => {
    let invoked = 0;
    const input = {};
    Object.defineProperty(input, "identity", {
      get: () => {
        invoked += 1;
        return marketIdentitySample();
      },
      enumerable: true,
      configurable: true,
    });
    const result = registerMarket(input as never, { identity: 1 } as never);
    expect(invoked).toBe(0);
    expect(result.ok).toBe(false);

    let orderInvoked = 0;
    const lifecycleInput = { eventType: "MarketOpened", payload: {} };
    Object.defineProperty(lifecycleInput, "order", {
      get: () => {
        orderInvoked += 1;
        return { gatewayEpoch: "x", ingestSeq: "1" };
      },
      enumerable: true,
      configurable: true,
    });
    const applied = applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, lifecycleInput as never);
    expect(orderInvoked).toBe(0);
    expect(applied.ok).toBe(false);
  });

  it("reads a declared key exactly once (no TOCTOU between the parse and the fold)", () => {
    // An inherited ACCESSOR counts every read the door performs: the
    // materialized tree has no chain, so the count is zero even though the
    // definition is registered from its own values.
    let reads = 0;
    const outcome = withInherited(
      "displayName",
      {
        get: () => {
          reads += 1;
          return "phantom";
        },
        enumerable: false,
      },
      () => attempt(() => registerSeries(EMPTY, { ...SERIES })),
    );
    expect(reads).toBe(0);
    expect(codesOf(outcome)).toEqual([]);
  });

  it("refuses a series definition that is not plain data", () => {
    class Foreign {
      readonly seriesId = SAMPLE_SERIES_ID;
    }
    expect(openSeriesDefinition(new Foreign()).ok).toBe(false);
    expect(openSeriesDefinition(JSON.parse('{"__proto__": {"active": true}}')).ok).toBe(false);
    expect(openMarketIdentity(new Foreign()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. the D2 compensation
// ---------------------------------------------------------------------------

describe("the D2 compensation holds with every zod check switched off", () => {
  it("refuses a series or identity missing a declared key under an inherited skipChecks", () => {
    // `skipChecks` is ADR-020 §1 class 4: one inherited property turns every
    // `.uuid()`, `.regex()`, `.min()` and `.datetime()` in the process into a
    // no-op. The door's own reads are not checks and do not switch off.
    for (const field of SERIES_DEFINITION_FIELDS.filter((entry) => entry.required)) {
      const read = withInherited("skipChecks", inheritedValue(true, false), () =>
        openSeriesDefinition(withoutKey(SERIES, field.key)),
      );
      expect(read.ok, field.key).toBe(false);
    }
    for (const field of MARKET_IDENTITY_FIELDS.filter((entry) => entry.required)) {
      const read = withInherited("skipChecks", inheritedValue(true, false), () =>
        openMarketIdentity(withoutKey(IDENTITY, field.key)),
      );
      expect(read.ok, field.key).toBe(false);
    }
  });

  it("refuses an empty or non-boolean declared value under an inherited skipChecks", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["displayName", ""],
      ["seriesKey", ""],
      ["active", "yes"],
      ["seriesId", 7],
    ];
    for (const [key, value] of cases) {
      const read = withInherited("skipChecks", inheritedValue(true, false), () =>
        openSeriesDefinition({ ...SERIES, [key]: value }),
      );
      expect(read.ok, key).toBe(false);
    }
  });

  it("keeps the identity cross-field rule when custom checks are skipped", () => {
    // `when` skips every `.refine`/`.superRefine` (ADR-020 §1 class 6), which is
    // where `yesTokenId !== noTokenId` lives — two markets sharing an outcome
    // token would make every book update ambiguous.
    for (const key of ["when", "skipChecks"]) {
      const read = withInherited(key, inheritedValue(true, false), () =>
        openMarketIdentity({ ...IDENTITY, noTokenId: IDENTITY["yesTokenId"] }),
      );
      expect(read.ok, key).toBe(false);
    }
  });

  it("refuses an approved binding missing a review fact under an inherited skipChecks", () => {
    const read = withInherited("skipChecks", inheritedValue(true, false), () =>
      openSeriesDefinition({ ...SERIES, binding: { approved: true, approvedBy: "reviewer" } }),
    );
    expect(read.ok).toBe(false);
  });

  it("is never STRICTER than the schema it re-states", () => {
    // schema-accept ⟹ door-accept, over a grid of honest and near-miss forms.
    const values: readonly unknown[] = [
      undefined,
      "",
      "x",
      "btc.usd",
      "PT15M",
      SAMPLE_SERIES_ID,
      "2026-08-28T00:00:00Z",
      "yesterday",
      0,
      1,
      1.5,
      true,
      false,
      null,
      [],
      {},
      "x".repeat(65),
      "x".repeat(201),
      "x".repeat(2001),
    ];
    let compared = 0;
    let drift = 0;
    for (const field of SERIES_DEFINITION_FIELDS) {
      for (const value of values) {
        const candidate = { ...SERIES, [field.key]: value };
        const schemaAccepts = SeriesDefinitionSchema.safeParse(candidate).success;
        const doorAccepts = openSeriesDefinition(candidate).ok;
        compared += 1;
        if (schemaAccepts && !doorAccepts) {
          drift += 1;
        }
      }
    }
    for (const field of MARKET_IDENTITY_FIELDS) {
      for (const value of values) {
        const candidate = { ...IDENTITY, [field.key]: value };
        const schemaAccepts = MarketIdentitySchema.safeParse(candidate).success;
        const doorAccepts = openMarketIdentity(candidate).ok;
        compared += 1;
        if (schemaAccepts && !doorAccepts) {
          drift += 1;
        }
      }
    }
    expect(compared).toBe((SERIES_DEFINITION_FIELDS.length + MARKET_IDENTITY_FIELDS.length) * 19);
    expect(drift).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. the machinery itself
// ---------------------------------------------------------------------------

describe("the caller-door machinery", () => {
  it("reads a nested variant by its OWN discriminator", () => {
    const read = readDeclaredFields(SERIES_DEFINITION_FIELDS, {
      ...SERIES,
      binding: { approved: false },
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.getPrototypeOf(read.value["binding"] as object)).toBe(null);
    }
    const noDiscriminator = readDeclaredFields(SERIES_DEFINITION_FIELDS, {
      ...SERIES,
      binding: {},
    });
    expect(noDiscriminator.ok).toBe(false);
    if (!noDiscriminator.ok) {
      expect(noDiscriminator.issues).toEqual(["binding.approved: the record carries no approved"]);
    }
    const unknownArm = readDeclaredFields(SERIES_DEFINITION_FIELDS, {
      ...SERIES,
      binding: { approved: "true" },
    });
    expect(unknownArm.ok).toBe(false);
  });

  it("turns a throw from any door step into a typed refusal", () => {
    // `contained` is the OUTER guard of `openSeriesDefinition`,
    // `openApprovedSeriesDefinition` and `openMarketIdentity`. The parse and its
    // refusal rendering are already contained one level in (`containedParse`),
    // so this guard has no measured door-level trigger today — it is what makes
    // "these doors never throw" true by construction rather than by audit, and
    // it is pinned here directly so that removing it fails the suite.
    const refused = contained<never>(() => {
      throw new TypeError("Invalid property descriptor");
    }, "series definition");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.issues).toEqual([
        "(root): the contract could not judge this series definition (its refusal could not be constructed); refused",
      ]);
    }
    const passed = contained(() => ({ ok: true, value: 1 }) as const, "series definition");
    expect(passed).toEqual({ ok: true, value: 1 });
  });

  it("reads own DATA properties only, and never a prototype", () => {
    const read = withInherited("approvedBy", inheritedValue("ghost", false), () =>
      readOwnFields({ seriesId: SAMPLE_SERIES_ID }, SERIES_APPROVAL_KEYS, "an approval"),
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.getPrototypeOf(read.value)).toBe(null);
      expect(hasOwnKey(read.value, "approvedBy")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. honest-input preservation
// ---------------------------------------------------------------------------

/** Deterministic serialization: own keys only, sorted, recursive, Map-aware. */
function stable(value: unknown, omitUndefined: boolean): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? '"[function]"' : (JSON.stringify(value) ?? "undefined");
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => stable(member, omitUndefined)).join(",")}]`;
  }
  if (value instanceof Map) {
    return `Map{${[...value.entries()]
      .map(([key, member]) => `${JSON.stringify(String(key))}:${stable(member, omitUndefined)}`)
      .sort()
      .join(",")}}`;
  }
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => {
      const member = ownValue(value as object, key);
      if (member === undefined && omitUndefined) {
        return undefined;
      }
      return `${JSON.stringify(key)}:${stable(member, omitUndefined)}`;
    })
    .filter((entry) => entry !== undefined)
    .join(",")}}`;
}

function verdict(run: () => unknown, omitUndefined: boolean): string {
  let outcome: unknown;
  try {
    outcome = run();
  } catch (error: unknown) {
    return `THREW ${(error as Error).name}: ${(error as Error).message}`;
  }
  const result = outcome as { ok: boolean; refusals?: unknown; value?: unknown };
  if (result.ok !== true) {
    return `REFUSED ${stable(result.refusals, omitUndefined)}`;
  }
  return `OK ${stable(result.value, omitUndefined)}`;
}

const HONEST_CASES: readonly (readonly [string, () => unknown])[] = [
  ["registerSeries/honest", () => registerSeries(EMPTY, seriesDefinitionSample())],
  ["registerSeries/idempotent", () => registerSeries(SEEDED, seriesDefinitionSample())],
  [
    "registerSeries/conflict",
    () => registerSeries(SEEDED, { ...seriesDefinitionSample(), displayName: "Something else" }),
  ],
  [
    "registerSeries/keyBound",
    () =>
      registerSeries(SEEDED, {
        ...seriesDefinitionSample(),
        seriesId: "01936f00-0000-7000-8000-00000000a009",
      }),
  ],
  ...Object.keys(SERIES).map(
    (key) =>
      [`registerSeries/without:${key}`, () => registerSeries(EMPTY, withoutKey(SERIES, key))] as const,
  ),
  ["registerSeries/badKey", () => registerSeries(EMPTY, { ...SERIES, seriesKey: "not a code!!" })],
  ["registerSeries/badId", () => registerSeries(EMPTY, { ...SERIES, seriesId: "not-a-uuid" })],
  ["registerSeries/emptyDisplay", () => registerSeries(EMPTY, { ...SERIES, displayName: "" })],
  ["registerSeries/unknownKey", () => registerSeries(EMPTY, { ...SERIES, invented: 1 })],
  ["registerSeries/undefinedMember", () => registerSeries(EMPTY, { ...SERIES, cadence: undefined })],
  [
    "registerSeries/approvedBinding",
    () =>
      registerSeries(EMPTY, {
        ...SERIES,
        binding: { approved: true, approvedBy: "reviewer", approvedAt: "2026-08-28T00:00:00Z" },
      }),
  ],
  [
    "registerSeries/halfApprovedBinding",
    () => registerSeries(EMPTY, { ...SERIES, binding: { approved: true, approvedBy: "reviewer" } }),
  ],
  ["registerSeries/bindingNotObject", () => registerSeries(EMPTY, { ...SERIES, binding: "yes" })],
  ["registerSeries/null", () => registerSeries(EMPTY, null)],
  ["registerSeries/string", () => registerSeries(EMPTY, "a series")],
  ["registerSeries/array", () => registerSeries(EMPTY, [])],
  ["registerSeries/empty", () => registerSeries(EMPTY, {})],

  [
    "approveSeries/honest",
    () =>
      approveSeries(SEEDED, {
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "approveSeries/unknown",
    () =>
      approveSeries(EMPTY, {
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "approveSeries/noApprover",
    () =>
      approveSeries(SEEDED, {
        seriesId: SAMPLE_SERIES_ID,
        approvedAt: "2026-08-28T00:00:00Z",
      } as never),
  ],
  [
    "approveSeries/noInstant",
    () => approveSeries(SEEDED, { seriesId: SAMPLE_SERIES_ID, approvedBy: "reviewer" } as never),
  ],
  [
    "approveSeries/emptyApprover",
    () =>
      approveSeries(SEEDED, {
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "approveSeries/badInstant",
    () =>
      approveSeries(SEEDED, {
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "yesterday" as never,
      }),
  ],
  [
    "approveSeries/noSeriesId",
    () => approveSeries(SEEDED, { approvedBy: "r", approvedAt: "2026-08-28T00:00:00Z" } as never),
  ],

  [
    "registerMarket/honest",
    () =>
      registerMarket(EMPTY, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/idempotent",
    () =>
      registerMarket(SEEDED, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/identityConflict",
    () =>
      registerMarket(SEEDED, {
        identity: { ...IDENTITY, conditionId: "0xsomethingelse" },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/conditionBound",
    () =>
      registerMarket(SEEDED, {
        identity: {
          ...IDENTITY,
          internalMarketId: "01936f00-0000-7000-8000-00000000d002",
          yesTokenId: "2000000001",
          noTokenId: "2000000002",
        },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/tokenBound",
    () =>
      registerMarket(SEEDED, {
        identity: {
          ...IDENTITY,
          internalMarketId: "01936f00-0000-7000-8000-00000000d002",
          conditionId: "0xanother",
          noTokenId: "2000000002",
        },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/sameToken",
    () =>
      registerMarket(EMPTY, {
        identity: { ...IDENTITY, noTokenId: "1000000001" },
        parameters: parameterObservationSample(),
      }),
  ],
  ...Object.keys(IDENTITY).map(
    (key) =>
      [
        `registerMarket/identityWithout:${key}`,
        () =>
          registerMarket(EMPTY, {
            identity: withoutKey(IDENTITY, key),
            parameters: parameterObservationSample(),
          }),
      ] as const,
  ),
  [
    "registerMarket/badId",
    () =>
      registerMarket(EMPTY, {
        identity: { ...IDENTITY, internalMarketId: "not-a-uuid" },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/badToken",
    () =>
      registerMarket(EMPTY, {
        identity: { ...IDENTITY, yesTokenId: "01" },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/unknownIdentityKey",
    () =>
      registerMarket(EMPTY, {
        identity: { ...IDENTITY, invented: 1 },
        parameters: parameterObservationSample(),
      }),
  ],
  [
    "registerMarket/identityNull",
    () => registerMarket(EMPTY, { identity: null, parameters: parameterObservationSample() }),
  ],
  [
    "registerMarket/identityString",
    () => registerMarket(EMPTY, { identity: "x", parameters: parameterObservationSample() }),
  ],
  [
    "registerMarket/metadataVersion",
    () =>
      registerMarket(EMPTY, {
        identity: marketIdentitySample(),
        parameters: parameterObservationSample(),
        metadataVersion: 4,
      }),
  ],
  [
    "registerMarket/noParameters",
    () => registerMarket(EMPTY, { identity: marketIdentitySample() } as never),
  ],
  [
    "registerMarket/badParameters",
    () =>
      registerMarket(EMPTY, {
        identity: marketIdentitySample(),
        parameters: { ...OBSERVATION, observedAt: "yesterday" } as never,
      }),
  ],
  [
    "registerMarket/badParameterMember",
    () =>
      registerMarket(EMPTY, {
        identity: marketIdentitySample(),
        parameters: { ...OBSERVATION, parameters: { ...PARAMETERS, tickSize: "" } } as never,
      }),
  ],
  ["registerMarket/emptyInput", () => registerMarket(EMPTY, {} as never)],

  [
    "bind/unapproved",
    () =>
      bindMarketToSeries(SEEDED, {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "bind/approved",
    () =>
      bindMarketToSeries(APPROVED, {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "bind/unknownMarket",
    () =>
      bindMarketToSeries(APPROVED, {
        internalMarketId: "01936f00-0000-7000-8000-00000000d777",
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "bind/unknownSeries",
    () =>
      bindMarketToSeries(APPROVED, {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: "01936f00-0000-7000-8000-00000000a777",
        approvedBy: "reviewer",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "bind/badMarketId",
    () =>
      bindMarketToSeries(APPROVED, {
        internalMarketId: "nope",
        seriesId: SAMPLE_SERIES_ID,
        approvedBy: "r",
        approvedAt: "2026-08-28T00:00:00Z",
      }),
  ],
  [
    "bind/noApprover",
    () =>
      bindMarketToSeries(APPROVED, {
        internalMarketId: SAMPLE_MARKET_ID,
        seriesId: SAMPLE_SERIES_ID,
        approvedAt: "2026-08-28T00:00:00Z",
      } as never),
  ],
  ["bind/emptyInput", () => bindMarketToSeries(APPROVED, {} as never)],

  ["suggest/known", () => suggestSeriesForMarket(SEEDED, SAMPLE_MARKET_ID)],
  ["suggest/unknown", () => suggestSeriesForMarket(EMPTY, SAMPLE_MARKET_ID)],
  ["suggest/badId", () => suggestSeriesForMarket(SEEDED, "not-a-uuid")],
  ["recordSuggestion/known", () => recordSeriesSuggestion(SEEDED, SAMPLE_MARKET_ID)],
  ["recordSuggestion/unknown", () => recordSeriesSuggestion(EMPTY, SAMPLE_MARKET_ID)],

  [
    "parameters/noop",
    () => recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, parameterObservationSample()),
  ],
  [
    "parameters/change",
    () =>
      recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, status: "OPEN" },
        observedAt: "2026-08-28T12:00:00Z",
      }),
  ],
  [
    "parameters/tickChange",
    () =>
      recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, tickSize: "0.02" },
        observedAt: "2026-08-28T12:00:00Z",
      }),
  ],
  [
    "parameters/outOfOrder",
    () =>
      recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, status: "OPEN" },
        observedAt: "2020-01-01T00:00:00Z",
      }),
  ],
  [
    "parameters/unknownMarket",
    () => recordMarketParameters(EMPTY, SAMPLE_MARKET_ID, parameterObservationSample()),
  ],
  [
    "parameters/badMarketId",
    () => recordMarketParameters(SEEDED, "not-a-uuid", parameterObservationSample()),
  ],
  [
    "parameters/badObservation",
    () =>
      recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, { ...OBSERVATION, source: "nasdaq" } as never),
  ],
  ["parameters/emptyObservation", () => recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, {} as never)],
  [
    "parameters/unknownKey",
    () => recordMarketParameters(SEEDED, SAMPLE_MARKET_ID, { ...OBSERVATION, invented: 1 } as never),
  ],

  [
    "applyEvent/opened",
    () =>
      applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: CONDITION_ID,
          openedAt: "2026-08-28T12:00:00Z",
        },
      }),
  ],
  [
    "applyEvent/ordered",
    () =>
      applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: CONDITION_ID,
          openedAt: "2026-08-28T12:00:00Z",
        },
        order: { gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e", ingestSeq: "7" },
      }),
  ],
  [
    "applyEvent/emptyPayload",
    () => applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, { eventType: "MarketOpened", payload: {} }),
  ],
  [
    "applyEvent/unknownMarket",
    () => applyMarketEvent(EMPTY, SAMPLE_MARKET_ID, { eventType: "MarketOpened", payload: {} }),
  ],
  [
    "applyEvent/badInstant",
    () =>
      applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {
        eventType: "MarketOpened",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          conditionId: CONDITION_ID,
          openedAt: "yesterday",
        },
      }),
  ],
  [
    "applyEvent/nullPayload",
    () => applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, { eventType: "MarketOpened", payload: null }),
  ],
  ["applyEvent/emptyInput", () => applyMarketEvent(SEEDED, SAMPLE_MARKET_ID, {} as never)],
  [
    "outcomeState/disputed",
    () =>
      recordMarketOutcomeState(SEEDED, SAMPLE_MARKET_ID, {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
  ],
  [
    "outcomeState/terminal",
    () =>
      recordMarketOutcomeState(SEEDED, SAMPLE_MARKET_ID, {
        outcomeState: "YES_WIN",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
  ],
  [
    "outcomeState/unknownMarket",
    () =>
      recordMarketOutcomeState(EMPTY, SAMPLE_MARKET_ID, {
        outcomeState: "DISPUTED",
        observedAt: "2026-08-28T12:30:00Z",
        observedBy: "operator:test",
      }),
  ],
  ["outcomeState/emptyInput", () => recordMarketOutcomeState(SEEDED, SAMPLE_MARKET_ID, {} as never)],
];

describe("honest inputs are unchanged by the doors", () => {
  it("produces the VALUE digest measured at base 989d41d, moved by UNIV-3's ONE mandated row", () => {
    // MEASURED, not asserted: this exact 87-case battery was run against the
    // REAL base code (`git stash` of `./registry.ts`, `./envelope.ts` and
    // `./lifecycle-door.ts`, so the raw `safeParse` path ran) and then against
    // the tip, and both produced `64d84df5…`. A change to any honest verdict —
    // refusal code, message, issue ORDER, thrown error, or any stored field —
    // moves this digest.
    //
    // `UNIV-3` MOVED IT, IN EXACTLY ONE ROW OF 87, AND THE MOVE WAS MEASURED THE
    // SAME WAY (`git stash` of the five edited modules at base `c2c0733`, both
    // transcripts dumped and diffed):
    //
    //   bind/noApprover
    //     base: OK — an APPROVED `seriesBinding` was stored with NO `approvedBy`
    //     tip : REFUSED UNIVERSE_INPUT_INVALID
    //           "binding.approvedBy: Invalid input: expected string, received undefined"
    //
    // That is `schema-boundary.md` §5 item 9(c)'s bounded tightening: the two
    // approval paths must agree, and `approveSeries` already round-tripped the
    // candidate through the frozen `SeriesDefinitionSchema`. The refusal message
    // is that schema's OWN — no new grammar is asserted here. The other 86 rows
    // are byte-identical to base.
    expect(HONEST_CASES).toHaveLength(87);
    const transcript = HONEST_CASES.map(
      ([label, run]) => `${label}\n${verdict(run, true)}`,
    ).join("\n");
    expect(createHash("sha256").update(transcript).digest("hex")).toBe(
      "f59037b546edb90dfb9062b42be73e119147037128b2bcc8bdb89c6eadc6b407",
    );
  });

  it("produces the tip's own key-presence digest, with the ONE disclosed difference", () => {
    // The strict serialization (which records a key present with an `undefined`
    // value) differs from base in exactly one of the 87 cases:
    // `registerSeries/undefinedMember`. At base `zod`'s output carried an own
    // `cadence: undefined`; the materializer reads an own `undefined` as ABSENT
    // (`./lifecycle-door.ts`'s documented D1 semantics, `UNIV-1`). The VALUE a
    // reader sees is identical — `undefined` either way, on a null-prototype
    // record — and `JSON.stringify` omits both, which is what the registry's own
    // re-registration comparison uses.
    //
    // `UNIV-3` moved this digest too, and the diff against base `c2c0733` is the
    // SAME single row (`bind/noApprover`) and no other: measured by dumping both
    // strict transcripts and diffing them, 1 of 87 lines changed.
    const transcript = HONEST_CASES.map(
      ([label, run]) => `${label}\n${verdict(run, false)}`,
    ).join("\n");
    expect(createHash("sha256").update(transcript).digest("hex")).toBe(
      "2a3b787be5fc12d3a2af6097092fd2be6623e125a7fa6e0281ca188f1551370d",
    );

    const stored = expectOk(
      registerSeries(EMPTY, { ...SERIES, cadence: undefined }),
    ).series.get(SAMPLE_SERIES_ID) as { readonly cadence?: string };
    expect(stored.cadence).toBeUndefined();
    expect(JSON.stringify(stored)).toBe(
      JSON.stringify(expectOk(registerSeries(EMPTY, withoutKey(SERIES, "cadence"))).series.get(
        SAMPLE_SERIES_ID,
      )),
    );
  });
});
