/**
 * `WP-170-FU1` — the strategy-runtime schema-boundary door.
 *
 * Executes `docs/contracts/schema-boundary.md` §5 item 2 and pins its §3 row.
 * Every `describe` below is a row of that audit or a defeat this round measured
 * on the same code path, and every one of them carries the BASE transcript it
 * was reproduced from at `53e9f62` next to the TIP behaviour it asserts. A
 * regression here is a re-opened defeat, not a style change.
 *
 * The bound this file holds the door to is `schema-boundary.md` §4 item 5 /
 * ADR-020 §6: under a pollution battery, **permission never varies** (nothing
 * a clean process refuses may be accepted), **no throw escapes**, and refusal
 * COMPOSITION may vary.
 *
 * Every test restores `Object.prototype` in a `finally`.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DecisionResultSchema } from "../../../packages/domain/src/index.js";
import type { DecisionResult } from "../../../packages/strategy-sdk/src/index.js";
import {
  acquireEvaluationInput,
  validateEvaluationInput,
} from "../../../packages/strategy-runtime/src/input.js";
import {
  canonicalJsonStringify,
  materializeDecisionViewAt,
  materializeEvaluationViewAt,
} from "../../../packages/strategy-runtime/src/json.js";
import {
  DECISION_FIELD_NAMES,
  DoorDecisionWithoutModelOutputsSchema,
  DoorIsoTimestampSchema,
  DoorTerminalMarketOutcomeStateSchema,
  DoorUnsignedBigIntStringSchema,
  DoorUuidSchema,
  DoorUuidv7Schema,
  MODEL_OUTPUTS_KEY,
  RawModelOutputsSchema,
} from "../../../packages/strategy-runtime/src/parse-door.js";
import {
  createStrategyInstanceRuntime,
  type EvaluationOutcome,
} from "../../../packages/strategy-runtime/src/index.js";
import {
  makeDefinition,
  makeHarness,
  makeInput,
  makeStrategy,
  MARKET_ID,
  SNAPSHOT_REF,
  T0,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// pollution harness
// ---------------------------------------------------------------------------

/** One shape of inherited property, applied to `Object.prototype` by name. */
type Shape = "data" | "getOnly" | "accessor" | "enumerable";

interface Pollution {
  readonly name: string;
  readonly shape: Shape;
  readonly value?: unknown;
}

/** Every setter invocation any battery run observed, so a probe can count them. */
let setterCalls = 0;

function apply(pollution: Pollution): void {
  const { name, shape } = pollution;
  const value = pollution.value ?? true;
  if (shape === "data" || shape === "enumerable") {
    Object.defineProperty(Object.prototype, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: shape === "enumerable",
    });
    return;
  }
  if (shape === "getOnly") {
    Object.defineProperty(Object.prototype, name, {
      get: () => value,
      configurable: true,
      enumerable: false,
    });
    return;
  }
  Object.defineProperty(Object.prototype, name, {
    get: () => value,
    set: () => {
      setterCalls += 1;
    },
    configurable: true,
    enumerable: false,
  });
}

/**
 * Runs `body` with `pollution` on `Object.prototype` and RESTORES the previous
 * state afterwards, whatever happens.
 *
 * Restore, not delete. Several names in the derived key material — `toString`,
 * `constructor`, `valueOf`, `hasOwnProperty` — are REAL members of
 * `Object.prototype`, and a `deleteProperty` in the `finally` removes them from
 * the process for every later test rather than undoing the pollution. That is
 * not a hypothetical: the first draft of this battery did exactly that, and the
 * two cross-product tests then failed inside `expect` itself with
 * `TypeError: Cannot read properties of undefined (reading 'call')`.
 */
function under<T>(pollution: Pollution, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, pollution.name);
  apply(pollution);
  try {
    return body();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(Object.prototype, pollution.name);
    } else {
      Object.defineProperty(Object.prototype, pollution.name, original);
    }
  }
}

/** A non-enumerable `skipChecks: true` — the §2 class this round exists for. */
const SKIP_CHECKS: Pollution = { name: "skipChecks", shape: "data", value: true };

/** The outcome of a probe, as a string, so a base/tip pair compares by value. */
function verdict(body: () => string): string {
  try {
    return body();
  } catch (cause) {
    return `ESCAPED ${(cause as Error).name}: ${String((cause as Error).message).slice(0, 80)}`;
  }
}

function badFormatInput(): Record<string, unknown> {
  const input = makeInput("onFeatures") as unknown as Record<string, unknown>;
  return {
    ...input,
    evaluatedAt: "yesterday",
    market: { ...(input["market"] as object), marketId: MARKET_ID.toUpperCase() },
  };
}

// ---------------------------------------------------------------------------
// A — the §3 row, verbatim
// ---------------------------------------------------------------------------

describe("§3 row: the input door refuses format-invalid input under `skipChecks`", () => {
  it("REPRODUCED-THEN-FLIPPED: `evaluatedAt: \"yesterday\"` + an UPPERCASE marketId", () => {
    // BASE `53e9f62`:
    //   validateEvaluationInput  clean    → {"ok":false,"detail":"evaluatedAt must be…"}
    //                            polluted → {"ok":TRUE}
    //   acquireEvaluationInput   polluted → ok:TRUE, and the snapshot the callback
    //                            and the record then carry is
    //                            marketId "018F4A7E-1111-7ABC-8DEF-0123456789AB",
    //                            evaluatedAt "yesterday".
    const clean = validateEvaluationInput(badFormatInput());
    expect(clean.ok).toBe(false);
    const polluted = under(SKIP_CHECKS, () => validateEvaluationInput(badFormatInput()));
    expect(polluted).toEqual(clean);

    const cleanAcquire = acquireEvaluationInput(badFormatInput());
    const pollutedAcquire = under(SKIP_CHECKS, () => acquireEvaluationInput(badFormatInput()));
    expect(cleanAcquire.ok).toBe(false);
    expect(pollutedAcquire.ok).toBe(false);
    expect(pollutedAcquire).toEqual(cleanAcquire);
  });

  it("REPRODUCED-THEN-FLIPPED: each scalar identifier parse, one field at a time", () => {
    // BASE `53e9f62`, clean.ok → polluted.ok under one NE `skipChecks`:
    //   evaluatedAt               false → TRUE
    //   market.marketId           false → TRUE
    //   sourceEvent.eventId       false → TRUE
    //   sourceEvent.gatewayEpoch  false → TRUE
    //   sourceEvent.ingestSeq     false → TRUE
    //   resolution.outcome        false → false   (an enum: no `check` to skip)
    const base = (): Record<string, unknown> =>
      makeInput("onFeatures") as unknown as Record<string, unknown>;
    const resolved = (): Record<string, unknown> =>
      makeInput("onMarketResolved") as unknown as Record<string, unknown>;
    const rows: Array<[string, () => unknown]> = [
      ["evaluatedAt", () => ({ ...base(), evaluatedAt: "yesterday" })],
      [
        "market.marketId",
        () => ({
          ...base(),
          market: { ...(base()["market"] as object), marketId: MARKET_ID.toUpperCase() },
        }),
      ],
      ["sourceEvent.eventId", () => ({ ...base(), sourceEvent: { eventId: "NOT-A-UUID" } })],
      [
        "sourceEvent.gatewayEpoch",
        () => ({
          ...base(),
          sourceEvent: { gatewayEpoch: "018F4A7E-1111-7ABC-8DEF-0123456789AB" },
        }),
      ],
      ["sourceEvent.ingestSeq", () => ({ ...base(), sourceEvent: { ingestSeq: "007" } })],
      [
        "resolution.outcome",
        () => ({
          ...resolved(),
          resolution: { ...(resolved()["resolution"] as object), outcome: "yes_win" },
        }),
      ],
    ];
    for (const [label, build] of rows) {
      const clean = validateEvaluationInput(build());
      expect(clean.ok, `${label} must be refused on a clean process`).toBe(false);
      const polluted = under(SKIP_CHECKS, () => validateEvaluationInput(build()));
      expect(polluted, `${label} under skipChecks`).toEqual(clean);
    }
  });

  it("ADR-016: a non-canonical UUID is REFUSED, never case-folded — polluted or not", () => {
    const lower = MARKET_ID;
    const upper = MARKET_ID.toUpperCase();
    expect(upper).not.toBe(lower);

    const withMarket = (marketId: string): Record<string, unknown> => {
      const input = makeInput("onFeatures") as unknown as Record<string, unknown>;
      return { ...input, market: { ...(input["market"] as object), marketId } };
    };

    for (const pollution of [undefined, SKIP_CHECKS] as const) {
      const run = <T>(body: () => T): T =>
        pollution === undefined ? body() : under(pollution, body);
      // The canonical form is accepted…
      const accepted = run(() => acquireEvaluationInput(withMarket(lower)));
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      // …and it is carried through BYTE-IDENTICALLY. Nothing normalizes it.
      expect(accepted.input.market.marketId).toBe(lower);
      // The uppercase variant is REFUSED, and the refusal says so.
      const refused = run(() => acquireEvaluationInput(withMarket(upper)));
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.detail).toContain("never case-folded");
      // And it is never folded into the canonical form on the way out.
      expect(refused.detail).not.toContain(lower);
    }
  });
});

// ---------------------------------------------------------------------------
// B — the DecisionResult parse at runtime.ts:918
// ---------------------------------------------------------------------------

describe("§3 row: the DecisionResult parse refuses under `skipChecks`", () => {
  const badDecision = {
    decisionType: "hold",
    reasonCodes: ["not a reason code"],
    featureSnapshotRef: SNAPSHOT_REF,
    intents: [],
    nextWakeupAt: "yesterday",
  };

  const badIntentDecision = {
    decisionType: "enter",
    reasonCodes: ["TEST.ENTER"],
    featureSnapshotRef: SNAPSHOT_REF,
    intents: [
      {
        type: "POSITION",
        intentId: "018F4A7E-2222-7ABC-8DEF-0123456789AB",
        marketId: MARKET_ID,
        direction: "YES",
        targetMode: "ABSOLUTE",
        targetShares: "10",
        urgency: "NORMAL",
        liquidityPreference: "MAKER_ONLY",
        partialFillPolicy: "ACCEPT_ANY",
        validUntil: "whenever",
        tags: [],
      },
    ],
  };

  function evaluateReturning(decision: unknown): string {
    const harness = makeHarness({
      strategy: makeStrategy({ onFeatures: () => decision as never }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    const record = harness.sink.calls[0]?.record;
    return [
      `kind=${outcome.kind}`,
      `persists=${String(harness.sink.calls.length)}`,
      `attribution=${String(record?.attribution)}`,
      `reason=${String(record?.decision.reasonCodes[0])}`,
      `intents=${String(record?.decision.intents.length)}`,
    ].join(" ");
  }

  it("REPRODUCED-THEN-FLIPPED: a garbage reason code and `nextWakeupAt`", () => {
    // BASE `53e9f62`:
    //   clean    → kind=CONTAINED persists=1 attribution=RUNTIME
    //              reason=RUNTIME.DECISION_INVALID
    //   polluted → kind=DECIDED   persists=1 attribution=STRATEGY
    //              reason="not a reason code", nextWakeupAt "yesterday"
    //              PERSISTED as this evaluation's one decision (§6 invariant 3).
    const clean = verdict(() => evaluateReturning(badDecision));
    expect(clean).toContain("kind=CONTAINED");
    expect(clean).toContain("attribution=RUNTIME");
    const polluted = verdict(() => under(SKIP_CHECKS, () => evaluateReturning(badDecision)));
    expect(polluted).toBe(clean);
  });

  it("REPRODUCED-THEN-FLIPPED: an UPPERCASE intentId and a garbage validUntil", () => {
    // BASE `53e9f62`: clean → CONTAINED, intents=0;
    //   polluted → DECIDED with the intent recorded verbatim, intentId
    //   "018F4A7E-2222-7ABC-8DEF-0123456789AB" and validUntil "whenever".
    const clean = verdict(() => evaluateReturning(badIntentDecision));
    expect(clean).toContain("kind=CONTAINED");
    const polluted = verdict(() => under(SKIP_CHECKS, () => evaluateReturning(badIntentDecision)));
    expect(polluted).toBe(clean);
  });

  it("REPRODUCED-THEN-FLIPPED (AVAILABILITY): one ENUMERABLE inherited key no longer traps a valid decision", () => {
    // BASE `53e9f62`, and this one was a fail-CLOSED defeat rather than a
    // fail-open: `z.strictObject` finds unknown keys with `for…in`, which
    // enumerates INHERITED enumerable names, so the isolation copy's ordinary
    // prototype made every valid decision refuse —
    //   Object.prototype.zzUnrelated = 1  (enumerable)
    //     → CONTAINED  RUNTIME.DECISION_INVALID
    //       "unrecognized_keys": ["zzUnrelated"]
    // on EVERY parse, not only a cold one. The isolation copy is prototype-free
    // since this round, so `for…in` over it sees own keys only.
    const good: DecisionResult = {
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
    };
    const clean = verdict(() => evaluateReturning(good));
    expect(clean).toContain("kind=DECIDED");
    const polluted = verdict(() =>
      under({ name: "zzUnrelated", shape: "enumerable", value: 1 }, () =>
        evaluateReturning(good),
      ),
    );
    expect(polluted).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// C — the D1 materializer's own containers
// ---------------------------------------------------------------------------

describe("D1: the materializer's copy cannot be reached through Object.prototype", () => {
  it("REPRODUCED-THEN-FLIPPED (ESCAPE): a get-only inherited accessor on a declared key", () => {
    // BASE `53e9f62`:
    //   Object.prototype.marketId = { get(){…} }   (non-enumerable)
    //     validateEvaluationInput(a VALID input)
    //       clean → {"ok":true}
    //       polluted → THREW TypeError: "Cannot set property marketId of
    //                  #<Object> which has only a getter"
    //   — an escaped throw out of a function documented "Never throws"
    //     (ADR-020 §6's no-escape bound).
    const clean = verdict(() => JSON.stringify(validateEvaluationInput(makeInput("onFeatures"))));
    const polluted = verdict(() =>
      under({ name: "marketId", shape: "getOnly", value: "018f4a7e-9999-7abc-8def-0123456789ab" }, () =>
        JSON.stringify(validateEvaluationInput(makeInput("onFeatures"))),
      ),
    );
    expect(clean).toBe('{"ok":true}');
    expect(polluted).toBe(clean);
  });

  it("REPRODUCED-THEN-FLIPPED (LOSS): an accepting inherited setter no longer runs, and nothing is lost", () => {
    // BASE `53e9f62`:
    //   Object.prototype.marketId = { get(){…}, set(){…} }   (non-enumerable)
    //     materializeEvaluationViewAt({ marketId:"x", other:1 })
    //       clean    → {"marketId":"x","other":1}
    //       polluted → {"other":1}        setterCalls=1
    //   — the copy LOST a property the input carried, and caller code ran
    //     inside the door.
    const source = { marketId: "x", other: 1 };
    const read = (): string => {
      const result = materializeEvaluationViewAt(source, "input");
      return result.ok ? JSON.stringify(result.value) : `refused:${result.problem}`;
    };
    const clean = verdict(read);
    expect(clean).toBe('{"marketId":"x","other":1}');
    setterCalls = 0;
    const polluted = verdict(() =>
      under({ name: "marketId", shape: "accessor", value: "FROM-THE-PROTOTYPE" }, read),
    );
    expect(polluted).toBe(clean);
    expect(setterCalls, "no caller code may run inside the door").toBe(0);
  });

  it("REPRODUCED-THEN-FLIPPED (ESCAPE): an inherited `get` no longer breaks every descriptor", () => {
    // BASE `53e9f62`:
    //   Object.prototype.get = 1   (non-enumerable data)
    //     materializeEvaluationViewAt(JSON.parse('{"__proto__":{"a":1}}'))
    //       clean → ok:true
    //       polluted → THREW TypeError: "Getter must be a function: 1"
    //   — the descriptor was an object LITERAL, and a literal descriptor is
    //     read with HasProperty, which walks the chain.
    const read = (): string => {
      const result = materializeEvaluationViewAt(
        JSON.parse('{"__proto__":{"a":1}}') as unknown,
        "input",
      );
      return result.ok ? "ok" : `refused:${result.problem}`;
    };
    const clean = verdict(read);
    expect(clean).toBe("ok");
    for (const value of [1, (): number => 1] as const) {
      const polluted = verdict(() => under({ name: "get", shape: "data", value }, read));
      expect(polluted).toBe(clean);
      const asSet = verdict(() => under({ name: "set", shape: "data", value }, read));
      expect(asSet).toBe(clean);
    }
  });

  it("MUTATION PIN (review round 1, LOW 1): `topOf`'s empty-stack length check is load-bearing", () => {
    // The mutation this kills — reviewer mutation F6 — is reverting `topOf` in
    // `json.ts` to `stack[stack.length - 1]`. It SURVIVED the entire package
    // suite at `4c1bcde`. `stack[-1]` on an EMPTY array is a property read of
    // the name `"-1"`, which walks the prototype chain exactly like an index
    // name does, so one inherited `"-1"` is read back as a work FRAME the
    // moment the stack drains — which is every completed walk, on every value.
    //
    // THE SHAPE OF THE PIN IS DELIBERATE. With a FRAME-SHAPED inherited value
    // the mutant loops forever (the reviewer measured >120s); a synchronous
    // infinite loop cannot be interrupted by a `testTimeout`, so pinning that
    // shape would HANG the suite instead of failing it. With any other value
    // the mutant reads `frame.kind` / `frame.keys` off a non-frame and throws a
    // `TypeError` in microseconds — out of a walk whose whole contract is that
    // it does not throw. This pins the fast shape.
    const scalars: readonly unknown[] = ["a scalar", 1, true, null];
    for (const inherited of ["X", 1, true] as const) {
      for (const shape of ["data", "getOnly"] as const) {
        for (const value of scalars) {
          const clean = verdict(() =>
            JSON.stringify(materializeEvaluationViewAt(value, "input") ?? null),
          );
          const polluted = verdict(() =>
            under({ name: "-1", shape, value: inherited }, () =>
              JSON.stringify(materializeEvaluationViewAt(value, "input") ?? null),
            ),
          );
          expect(clean, `${JSON.stringify(value)} must materialize cleanly`).toBe(
            JSON.stringify({ ok: true, value }),
          );
          expect(polluted, `"-1"/${shape}=${String(inherited)} on ${JSON.stringify(value)}`).toBe(
            clean,
          );
        }
      }
    }
    // The same guard on the serializer's own stack, which is the second
    // `topOf` call site (`canonicalJsonStringify`).
    const clean = verdict(() => canonicalJsonStringify({ a: [1, 2], b: "x" }));
    expect(clean).toBe('{"a":[1,2],"b":"x"}');
    for (const inherited of ["X", 1, true] as const) {
      expect(
        verdict(() =>
          under({ name: "-1", shape: "data", value: inherited }, () =>
            canonicalJsonStringify({ a: [1, 2], b: "x" }),
          ),
        ),
        `serializer under "-1"=${String(inherited)}`,
      ).toBe(clean);
    }
  });

  it("an inherited index name no longer intercepts an array append", () => {
    // `push` is `Set`, and `Set` consults the chain for the INDEX name — the
    // index-`"0"` family `WP-020-FU1` and `WP-200-FU1` measured. The append is
    // `defineProperty` on the index name since this round.
    const read = (): string => {
      const result = materializeEvaluationViewAt({ list: ["a", "b"] }, "input");
      return result.ok ? JSON.stringify(result.value) : `refused:${result.problem}`;
    };
    const clean = verdict(read);
    expect(clean).toBe('{"list":["a","b"]}');
    setterCalls = 0;
    for (const name of ["0", "1"]) {
      expect(verdict(() => under({ name, shape: "accessor", value: "X" }, read))).toBe(clean);
      expect(verdict(() => under({ name, shape: "getOnly", value: "X" }, read))).toBe(clean);
    }
    expect(setterCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D — the output side
// ---------------------------------------------------------------------------

describe("D4: everything this door emits has a null prototype", () => {
  it("REPRODUCED-THEN-FLIPPED: an absent `sourceEvent` is no longer fabricated into the record", () => {
    // BASE `53e9f62`:
    //   Object.prototype.sourceEvent = { eventId:"018f4a7e-3333-…", … }  (NE)
    //     runtime.evaluate(a valid input carrying NO sourceEvent)
    //       clean    → record.sourceEvent = undefined
    //       polluted → record.sourceEvent = the fabricated event
    //   — §6 invariant 4's traceability chain, naming an event that never
    //     existed. The read was closed by the snapshot's D4 and the defeat then
    //     moved into the record's own object literal, so the record is emitted
    //     prototype-free too.
    const read = (): string => {
      const harness = makeHarness();
      const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
      const record = harness.sink.calls[0]?.record as unknown as
        | Record<string, unknown>
        | undefined;
      return `${outcome.kind} sourceEvent=${JSON.stringify(record?.["sourceEvent"]) ?? "undefined"}`;
    };
    const clean = verdict(read);
    expect(clean).toBe("DECIDED sourceEvent=undefined");
    const polluted = verdict(() =>
      under(
        {
          name: "sourceEvent",
          shape: "data",
          value: {
            eventId: "018f4a7e-3333-7abc-8def-0123456789ab",
            gatewayEpoch: "018f4a7e-4444-7abc-8def-0123456789ab",
            ingestSeq: "42",
          },
        },
        read,
      ),
    );
    expect(polluted).toBe(clean);
  });

  it("the snapshot, the decision, the record and the checkpoint are all prototype-free", () => {
    const acquired = acquireEvaluationInput(makeInput("onFeatures"));
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(Object.getPrototypeOf(acquired.input)).toBeNull();
    expect(Object.getPrototypeOf(acquired.input.market)).toBeNull();
    expect(Object.getPrototypeOf(acquired.input.features)).toBeNull();
    // Arrays keep `Array.prototype` DELIBERATELY: a severed array has no `map`,
    // and these copies are iterated by strategy code (`json.ts` header).
    expect(Object.getPrototypeOf(acquired.input.orders)).toBe(Array.prototype);

    const harness = makeHarness();
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    if (outcome.kind !== "DECIDED") return;
    expect(Object.getPrototypeOf(outcome.record)).toBeNull();
    expect(Object.getPrototypeOf(outcome.record.decision)).toBeNull();
    expect(Object.getPrototypeOf(outcome.checkpoint)).toBeNull();

    // A contained evaluation emits the same shapes.
    const contained = makeHarness({
      strategy: makeStrategy({
        onFeatures: () => {
          throw new Error("boom");
        },
      }),
    });
    const containedOutcome = contained.runtime.evaluate(makeInput("onFeatures"));
    expect(containedOutcome.kind).toBe("CONTAINED");
    if (containedOutcome.kind !== "CONTAINED") return;
    expect(Object.getPrototypeOf(containedOutcome.record)).toBeNull();
    expect(Object.getPrototypeOf(containedOutcome.record.decision)).toBeNull();
    expect(Object.getPrototypeOf(containedOutcome.checkpoint)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D2 — the key the LIBRARY skips rather than validates (review round 1, MEDIUM 1)
// ---------------------------------------------------------------------------

describe("D3 emits no key the library skipped: an own `__proto__` at any depth", () => {
  /**
   * MECHANISM, read out of the pinned `zod@4.4.3` rather than inferred:
   * `v4/core/schemas.cjs:798-801` (the strict object's unknown-key walk) and
   * `:1527` (the record walk) each open with `if (key === "__proto__")
   * continue;`. The library SKIPS that name at EVERY level — neither refused as
   * unrecognized nor validated against a value schema — so it never reached
   * `parsed.data`.
   *
   * Base `53e9f62` emitted `parsed.data` and the key vanished. `WP-170-FU1`'s
   * D3 rebuild emits the MATERIALIZED TREE (which is the §1 D3 rule and is
   * right), and at `4c1bcde` that put the key back into the persisted decision.
   * No pollution is needed: `JSON.parse` of a model's output produces exactly
   * this shape. MEASURED at both SHAs, one strategy return at a time:
   *
   * ```text
   *                                  base 53e9f62   tip 4c1bcde   remediated
   *   modelOutputs.__proto__ = {…}   DROPPED        EMITTED       DROPPED
   *   modelOutputs.__proto__ = 1.5   DROPPED        EMITTED       DROPPED
   *   intents[0].__proto__   = {…}   DROPPED        EMITTED       DROPPED
   *   decision.__proto__     = {…}   DROPPED        DROPPED       DROPPED
   *   statePatch.__proto__   = {…}   KEPT           KEPT          KEPT
   * ```
   *
   * The last row is why the drop is a grammar axis on the DECISION view alone
   * and not a change to every materialization: base kept the key in
   * `statePatch` (it never travelled through a parse output), and
   * `state-patch-attribution.test.ts` and `json-exotic-values.test.ts` pin
   * that. Dropping it everywhere would have broken parity in the other
   * direction.
   *
   * The `1.5` row is the one that shows why this is not cosmetic: a JS NUMBER
   * reached persisted `modelOutputs`, whose value schema is
   * `string | boolean | null` precisely to keep numbers out — and on `main`
   * the `decisions_model_outputs_decimal_safe` DB constraint turns that into a
   * write failure instead of a decision.
   */
  function decisionBytes(returned: unknown): string {
    const harness = makeHarness({
      strategy: makeStrategy({ onFeatures: () => returned as never }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    const record = harness.sink.calls[0]?.record;
    return `${outcome.kind} ${JSON.stringify(record?.decision)}`;
  }

  /** An object with an OWN enumerable `__proto__` data property. */
  function withOwnProto(body: Record<string, unknown>, value: unknown): unknown {
    const source = JSON.parse(
      `{"__proto__":${JSON.stringify(value)},${JSON.stringify(body).slice(1)}`,
    ) as Record<string, unknown>;
    // Non-vacuity: the vector really does carry the key as OWN DATA, and the
    // literal it was built from really is what `JSON.parse` produces.
    expect(Object.hasOwn(source, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
    return source;
  }

  const VALID_INTENT: Record<string, unknown> = {
    type: "POSITION",
    intentId: "018f4a7e-2222-7abc-8def-0123456789ab",
    marketId: MARKET_ID,
    direction: "YES",
    targetMode: "ABSOLUTE",
    targetShares: "10",
    urgency: "NORMAL",
    liquidityPreference: "MAKER_ONLY",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: T0,
    tags: [],
  };

  it("REPRODUCED-THEN-FLIPPED: `modelOutputs.__proto__`, object AND number values", () => {
    // BASE `53e9f62`: the persisted decision is
    //   "modelOutputs":{"edge":"0.03"}
    // TIP `4c1bcde`:  "modelOutputs":{"edge":"0.03","__proto__":{"polluted":true}}
    //            and  "modelOutputs":{"edge":"0.03","__proto__":1.5}
    const base = (outputs: unknown): unknown => ({
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
      modelOutputs: outputs,
    });
    const expected =
      'DECIDED {"decisionType":"hold","reasonCodes":["TEST.HOLD"],"featureSnapshotRef":"snap-1"' +
      ',"modelOutputs":{"edge":"0.03"},"intents":[]}';
    expect(decisionBytes(base({ edge: "0.03" }))).toBe(expected);
    for (const value of [{ polluted: true }, 1.5, "0.5", null, [1]] as const) {
      expect(
        decisionBytes(base(withOwnProto({ edge: "0.03" }, value))),
        `modelOutputs.__proto__ = ${JSON.stringify(value)}`,
      ).toBe(expected);
    }
    // …and nothing was re-parented on the way through.
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("REPRODUCED-THEN-FLIPPED: `intents[0].__proto__` is not forwarded either", () => {
    // BASE `53e9f62`: the intent is persisted without the key.
    // TIP `4c1bcde`:  "intents":[{"__proto__":{"polluted":true},"type":"POSITION",…}]
    //                 — and that intent object is what the runtime forwards.
    const build = (intent: unknown): unknown => ({
      decisionType: "enter",
      reasonCodes: ["TEST.ENTER"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [intent],
    });
    const clean = decisionBytes(build({ ...VALID_INTENT }));
    expect(clean).toContain('"intents":[{"type":"POSITION"');
    expect(clean.startsWith("DECIDED ")).toBe(true);
    for (const value of [{ polluted: true }, 1.5] as const) {
      expect(
        decisionBytes(build(withOwnProto({ ...VALID_INTENT }, value))),
        `intents[0].__proto__ = ${JSON.stringify(value)}`,
      ).toBe(clean);
    }
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("the TOP-LEVEL drop (WP-170 round 4) and the statePatch KEEP are both unchanged", () => {
    // Two rows of the table above, asserted together because the fix would be
    // wrong if it moved either of them.
    const topLevel = decisionBytes(
      withOwnProto(
        {
          decisionType: "hold",
          reasonCodes: ["TEST.HOLD"],
          featureSnapshotRef: SNAPSHOT_REF,
          intents: [],
        },
        { polluted: true },
      ),
    );
    expect(topLevel).toBe(
      'DECIDED {"decisionType":"hold","reasonCodes":["TEST.HOLD"],"featureSnapshotRef":"snap-1"' +
        ',"intents":[]}',
    );
    // `statePatch` is NOT parsed by the library and base emitted it from the
    // checkpointable walk, so base KEPT the key — and so does this tip. Its
    // grammar does not carry the drop.
    const withPatch = decisionBytes({
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
      statePatch: withOwnProto({ a: 1 }, { alsoPolluted: true }),
    });
    expect(withPatch).toContain('"statePatch":{"__proto__":{"alsoPolluted":true},"a":1}');
  });

  it("the drop is the DECISION grammar's alone, and a NON-ENUMERABLE `__proto__` is still refused", () => {
    // The two grammars, side by side on the same value: the decision view drops
    // the key, the evaluation view (the input snapshot) copies it exactly as
    // base did. A future edit that moves the drop into the shared grammar
    // fails here.
    const source = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as unknown;
    const asView = materializeEvaluationViewAt(source, "input");
    const asDecision = materializeDecisionViewAt(source, "decision");
    expect(asView.ok && JSON.stringify(asView.value)).toBe('{"__proto__":{"polluted":true},"safe":1}');
    expect(asDecision.ok && JSON.stringify(asDecision.value)).toBe('{"safe":1}');

    // A NON-ENUMERABLE own `__proto__` is REFUSED by the loss rule, not
    // silently dropped: the drop is applied to the enumerable walked list, and
    // it is applied AFTER the hidden-own-property check.
    const hidden = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hidden, "safe", { value: 1, enumerable: true, configurable: true });
    Object.defineProperty(hidden, "__proto__", { value: 2, enumerable: false, configurable: true });
    const refused = materializeDecisionViewAt(hidden, "decision");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.problem).toContain("non-enumerable property");
    expect(refused.problem).toContain("__proto__");
  });
});

// ---------------------------------------------------------------------------
// E — the run-seed door (found by this round, not by the §3 row)
// ---------------------------------------------------------------------------

describe("the run-seed door at creation", () => {
  it("REPRODUCED-THEN-FLIPPED: a non-canonical seed is refused under `skipChecks`", () => {
    // BASE `53e9f62`, `createStrategyInstanceRuntime` with each seed:
    //   "007" / "-1" / " 12" / "1e3"
    //     clean    → REFUSED RUN_SEED_INVALID
    //     polluted → CREATED
    //   §12.4 replay rests on this value being exactly what §10.3 says it is.
    const create = (runSeed: string): string => {
      const { definition } = makeDefinition({});
      const created = createStrategyInstanceRuntime({
        ...definition,
        run: { ...definition.run, runSeed },
      });
      return created.ok ? "CREATED" : `REFUSED ${created.refusal.code}`;
    };
    for (const seed of ["007", "-1", " 12", "1e3", "1.0", ""]) {
      const clean = verdict(() => create(seed));
      expect(clean, `seed ${JSON.stringify(seed)} must be refused clean`).toBe(
        "REFUSED RUN_SEED_INVALID",
      );
      expect(verdict(() => under(SKIP_CHECKS, () => create(seed))), seed).toBe(clean);
    }
    // The canonical form still creates, polluted or not.
    expect(verdict(() => create("12345"))).toBe("CREATED");
    expect(verdict(() => under(SKIP_CHECKS, () => create("12345")))).toBe("CREATED");
  });
});

// ---------------------------------------------------------------------------
// F — the arena binding itself
// ---------------------------------------------------------------------------

describe("the door schemas are ARENA COPIES, and the frozen originals are untouched", () => {
  it("NON-VACUITY: every door schema is a different object from the domain schema it copies", () => {
    // If a future edit re-bound one of these to the raw schema, every
    // `skipChecks` assertion above would still pass structurally while the
    // door silently lost its protection. This is the differential that stops
    // that: the copy answers what the raw schema answers on a CLEAN process,
    // and diverges from it under `skipChecks`.
    const rows: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, string]> = [
      ["IsoTimestamp", DoorIsoTimestampSchema, "yesterday"],
      ["Uuidv7", DoorUuidv7Schema, MARKET_ID.toUpperCase()],
      ["Uuid", DoorUuidSchema, "NOT-A-UUID"],
      ["UnsignedBigIntString", DoorUnsignedBigIntStringSchema, "007"],
    ];
    for (const [label, door, invalid] of rows) {
      expect(door.safeParse(invalid).success, `${label} clean`).toBe(false);
      const polluted = under(SKIP_CHECKS, () => door.safeParse(invalid).success);
      expect(polluted, `${label} under skipChecks — the arena copy must still refuse`).toBe(false);
    }
    // The enum is routed through the arena too, and is honest about WHY: it is
    // not defeated by `skipChecks` in the first place (no `check` to skip).
    expect(DoorTerminalMarketOutcomeStateSchema.safeParse("yes_win").success).toBe(false);
    expect(DoorTerminalMarketOutcomeStateSchema.safeParse("YES_WIN").success).toBe(true);
  });

  it("the frozen `DecisionResultSchema` is not mutated by the `.omit` derivation", () => {
    const valid = {
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
      modelOutputs: { edge: "0.03" },
    };
    // The original still accepts `modelOutputs`; the omitted copy refuses it as
    // an unrecognized key, i.e. it is still STRICT.
    expect(DecisionResultSchema.safeParse(valid).success).toBe(true);
    expect(DoorDecisionWithoutModelOutputsSchema.safeParse(valid).success).toBe(false);
    const withoutOutputs = { ...valid, modelOutputs: undefined };
    delete (withoutOutputs as Record<string, unknown>)["modelOutputs"];
    expect(DoorDecisionWithoutModelOutputsSchema.safeParse(withoutOutputs).success).toBe(true);
    expect(
      DoorDecisionWithoutModelOutputsSchema.safeParse({ ...withoutOutputs, surprise: 1 }).success,
    ).toBe(false);
  });

  it("D3's field list is the CONTRACT's, not this package's", () => {
    expect([...DECISION_FIELD_NAMES].sort()).toEqual(
      Object.getOwnPropertyNames(DecisionResultSchema.shape).sort(),
    );
    expect(DECISION_FIELD_NAMES).toContain(MODEL_OUTPUTS_KEY);
    expect(DECISION_FIELD_NAMES).not.toContain("__proto__");
  });

  it("D3 emits exactly the fields the strategy returned — no absent optional is invented", () => {
    // The field list is the contract's, but the door copies only what the
    // MATERIALIZED TREE actually has. Without the `hasOwn` gate, every absent
    // optional (`modelOutputs`, `statePatch`, `nextWakeupAt`) would land as an
    // own key holding `undefined` — invisible to `JSON.stringify` and to
    // `toEqual`, and visible to every `Object.hasOwn` a consumer writes.
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: () =>
          ({
            decisionType: "hold",
            reasonCodes: ["TEST.HOLD"],
            featureSnapshotRef: SNAPSHOT_REF,
            intents: [],
          }) as never,
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    if (outcome.kind !== "DECIDED") return;
    expect(Reflect.ownKeys(outcome.record.decision).sort()).toEqual([
      "decisionType",
      "featureSnapshotRef",
      "intents",
      "reasonCodes",
    ]);
    // …and the fields it DID return are all there, with the patch added.
    const withEverything = makeHarness({
      strategy: makeStrategy({
        onFeatures: () =>
          ({
            decisionType: "quote",
            reasonCodes: ["TEST.Q"],
            featureSnapshotRef: SNAPSHOT_REF,
            intents: [],
            modelOutputs: { edge: "0.03" },
            statePatch: { a: 1 },
            nextWakeupAt: T0,
          }) as never,
      }),
    });
    const full = withEverything.runtime.evaluate(makeInput("onFeatures"));
    expect(full.kind).toBe("DECIDED");
    if (full.kind !== "DECIDED") return;
    expect(Reflect.ownKeys(full.record.decision).sort()).toEqual([
      "decisionType",
      "featureSnapshotRef",
      "intents",
      "modelOutputs",
      "nextWakeupAt",
      "reasonCodes",
      "statePatch",
    ]);
  });
});

// ---------------------------------------------------------------------------
// G — the disclosed `modelOutputs` residual, bounded by measurement
// ---------------------------------------------------------------------------

describe("the `modelOutputs` split: equivalent on a clean process, and no format checks to defeat", () => {
  /** A corpus that exercises every field of the §7.5 contract. */
  const CORPUS: unknown[] = [
    { decisionType: "hold", reasonCodes: ["TEST.HOLD"], featureSnapshotRef: "s", intents: [] },
    {
      decisionType: "quote",
      reasonCodes: ["TEST.Q"],
      featureSnapshotRef: "s",
      intents: [],
      modelOutputs: { a: "0.1", b: true, c: null },
      nextWakeupAt: T0,
    },
    // invalid modelOutputs values, one per union member that is missing
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], modelOutputs: { n: 1 } },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], modelOutputs: { o: {} } },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], modelOutputs: [] },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], modelOutputs: null },
    // invalid elsewhere
    { decisionType: "HOLD", reasonCodes: [], featureSnapshotRef: "s", intents: [] },
    { decisionType: "hold", reasonCodes: ["no edge"], featureSnapshotRef: "s", intents: [] },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "", intents: [] },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], nextWakeupAt: "x" },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s" },
    { decisionType: "hold", reasonCodes: [], featureSnapshotRef: "s", intents: [], surprise: 1 },
    // both halves wrong at once
    { decisionType: "HOLD", reasonCodes: [], featureSnapshotRef: "s", intents: [], modelOutputs: { n: 1 } },
    // an own `__proto__` at each level — the key `zod@4.4.3` SKIPS rather than
    // validates (review round 1, MEDIUM 1). Verdict equality has to hold on
    // these too, or the split would disagree with the contract about a value
    // the contract silently tolerates.
    JSON.parse(
      '{"__proto__":{"polluted":true},"decisionType":"hold","reasonCodes":[],' +
        '"featureSnapshotRef":"s","intents":[]}',
    ) as unknown,
    {
      decisionType: "hold",
      reasonCodes: [],
      featureSnapshotRef: "s",
      intents: [],
      modelOutputs: JSON.parse('{"__proto__":1.5,"edge":"0.03"}') as unknown,
    },
  ];

  /** The door's composed verdict: the omitted parse AND the picked parse. */
  function doorVerdict(value: unknown): boolean {
    if (value === null || typeof value !== "object") {
      return DoorDecisionWithoutModelOutputsSchema.safeParse(value).success;
    }
    const record = value as Record<string, unknown>;
    const rest: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(record)) {
      if (key === MODEL_OUTPUTS_KEY) continue;
      // `defineProperty`, never `rest[key] = …` — the door itself builds its
      // copies this way (`ownData`), and on an ordinary target an assignment to
      // `__proto__` RE-PARENTS the object instead of storing a key, which would
      // make this helper measure something other than the door.
      Object.defineProperty(rest, key, {
        value: record[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (!DoorDecisionWithoutModelOutputsSchema.safeParse(rest).success) return false;
    if (!Object.hasOwn(record, MODEL_OUTPUTS_KEY)) return true;
    return RawModelOutputsSchema.safeParse({
      [MODEL_OUTPUTS_KEY]: record[MODEL_OUTPUTS_KEY],
    }).success;
  }

  it("the split's verdict equals the whole frozen schema's verdict on every corpus value", () => {
    for (const value of CORPUS) {
      expect(doorVerdict(value), JSON.stringify(value)).toBe(
        DecisionResultSchema.safeParse(value).success,
      );
    }
    // Non-vacuity: the corpus is not all-true or all-false, and it is the size
    // review round 1 verified (13 + the two `__proto__` vectors that round
    // added). A corpus that silently shrinks is a differential that silently
    // stops differentiating.
    expect(CORPUS).toHaveLength(15);
    const verdicts = CORPUS.map((value) => doorVerdict(value));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("THE RESIDUAL, BOUNDED — the `skipChecks` HALF: it cannot move the raw parse", () => {
    // RESTATED 2026-09-06, remediation round 1 (review round 1, LOW 2). This
    // test used to be titled "THE RESIDUAL, BOUNDED", which overstated what it
    // measures. It measures the `skipChecks` HALF of the bound and nothing
    // else; the next test states the half it does NOT cover.
    //
    // The disclosed residual (`parse-door.ts` header) is that this ONE subtree
    // is asked of the raw schema, because the arena fails closed on the `null`
    // node inside `ModelOutputValueSchema`. This half of the bound is measured
    // rather than argued: the subtree carries zero format checks, so the class
    // that defeats every other parse in this package is a no-op on it.
    for (const value of CORPUS) {
      const probe =
        value !== null && typeof value === "object" && Object.hasOwn(value, MODEL_OUTPUTS_KEY)
          ? { [MODEL_OUTPUTS_KEY]: (value as Record<string, unknown>)[MODEL_OUTPUTS_KEY] }
          : {};
      const clean = RawModelOutputsSchema.safeParse(probe).success;
      const polluted = under(SKIP_CHECKS, () => RawModelOutputsSchema.safeParse(probe).success);
      expect(polluted, JSON.stringify(probe)).toBe(clean);
    }
  });

  it("THE HALF THE BOUND DOES NOT COVER: `values` reaches this parse, at base and at tip alike", () => {
    // Review round 1, LOW 2. The `values`/AVAILABILITY class DOES reach the one
    // parse that is not an arena copy. MEASURED at base `53e9f62` and at tip,
    // one non-enumerable property at a time, an honest decision:
    //
    //   Object.prototype.<name> = true   (non-enumerable)   base       tip
    //     skipChecks   with modelOutputs                    DECIDED    DECIDED
    //     optin/optout/propValues/pattern                   DECIDED    DECIDED
    //     values       with modelOutputs                    CONTAINED  CONTAINED
    //     values       WITHOUT modelOutputs                 DECIDED    DECIDED
    //     when         with modelOutputs                    ESCAPED    DECIDED
    //                                                       TypeError
    //
    // Three properties, and this test asserts all three:
    //  1. `values` is PRE-EXISTING and IDENTICAL base→tip — the door neither
    //     opened nor closed it — and it is FAIL-CLOSED, which ADR-020 §6
    //     permits. It is closed by the queued `packages/risk`
    //     `ARENA_NODE_TYPES` widening, after which this subtree goes through
    //     the arena like everything else;
    //  2. it reaches the decision ONLY through `modelOutputs`: the same
    //     pollution leaves a decision without that field DECIDED, which is what
    //     localizes the residual to the one unprotected parse;
    //  3. `when` was an ESCAPED TypeError at base and is a typed outcome now,
    //     because the rest of the decision parses through the arena.
    const honest = (withOutputs: boolean): unknown => ({
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: SNAPSHOT_REF,
      intents: [],
      ...(withOutputs ? { modelOutputs: { edge: "0.03" } } : {}),
    });
    const run = (withOutputs: boolean): string => {
      const harness = makeHarness({
        strategy: makeStrategy({ onFeatures: () => honest(withOutputs) as never }),
      });
      const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
      return `${outcome.kind}/${String(harness.sink.calls[0]?.record.attribution)}`;
    };
    expect(verdict(() => run(true))).toBe("DECIDED/STRATEGY");
    expect(verdict(() => run(false))).toBe("DECIDED/STRATEGY");

    const values: Pollution = { name: "values", shape: "data", value: true };
    // 1 — the residual: fail-CLOSED, and it does move.
    expect(verdict(() => under(values, () => run(true)))).toBe("CONTAINED/RUNTIME");
    // 2 — and only through `modelOutputs`.
    expect(verdict(() => under(values, () => run(false)))).toBe("DECIDED/STRATEGY");
    // 3 — the classes the door DID close on this same decision stay closed, so
    // this test cannot be read as "the door does nothing here".
    for (const name of ["skipChecks", "optin", "optout", "when", "propValues", "pattern"]) {
      expect(
        verdict(() => under({ name, shape: "data", value: true }, () => run(true))),
        `${name} must leave an honest decision alone`,
      ).toBe("DECIDED/STRATEGY");
    }
  });
});

// ---------------------------------------------------------------------------
// G2 — the honest-path bound, pinned to the BASE bytes
// ---------------------------------------------------------------------------

/**
 * `CKPT-1`: the 9-stage honest run's outcome bytes under ADR-027 (measured on
 * the `CKPT-1` candidate); the base value is reconstructed in the test.
 */
const CKPT1_NINE_STAGE_SHA256 = "23da29d6600ecd131d284ac515140b52aae3715adfc79a0ac098553fc35cbe69";

describe("the honest path is byte-identical to base `53e9f62`", () => {
  it("a 9-stage run hashes to the value measured at base, before the door existed", () => {
    // Measured base→tip in a `/dev/shm` scratch pair: sha256
    // fa9f1b6345939072599dfeaf9ddbb447cff7e2bf85fe8d9ee4993cc56f6c89d9 over
    // 7,805 UTF-8 bytes, identical at both SHAs. It is pinned because the first
    // draft of the D3 rebuild DID diverge here — `modelOutputs` was appended
    // after the contract loop instead of at its declared position, which is the
    // same bytes in a different order and is exactly the kind of drift a
    // structural assertion does not see. The `stack` in `deepFreeze`, the
    // decision's key order, and the record's field order are all held by this
    // one number.
    let n = 0;
    const harness = makeHarness({
      strategy: makeStrategy({
        onStart: (ctx) => ({
          decisionType: "hold" as const,
          reasonCodes: ["TEST.START"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [],
          statePatch: { started: true },
        }),
        onFeatures: (ctx) => {
          n += 1;
          return {
            decisionType: "quote" as const,
            reasonCodes: ["TEST.Q"],
            featureSnapshotRef: ctx.features().snapshotRef,
            modelOutputs: { tick: String(n), flag: n % 2 === 0, none: null },
            statePatch: { count: n, nested: { list: [n, n + 1] } },
            intents: [],
            nextWakeupAt: "2026-01-02T03:04:06.000Z",
          };
        },
        onStop: (ctx) => ({
          decisionType: "skip" as const,
          reasonCodes: ["TEST.STOP"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [],
        }),
      }),
    });
    const outcomes: EvaluationOutcome[] = [];
    outcomes.push(harness.runtime.evaluate(makeInput("onStart")));
    for (let i = 0; i < 6; i += 1) {
      outcomes.push(harness.runtime.evaluate(makeInput("onFeatures")));
    }
    outcomes.push(harness.runtime.evaluate(makeInput("onMarketResolved")));
    outcomes.push(harness.runtime.evaluate(makeInput("onStop")));
    const text = outcomes.map((outcome) => JSON.stringify(outcome)).join("\n");
    expect(harness.sink.calls).toHaveLength(9);
    // `CKPT-1` re-pin (ADR-027 D1). Two things moved, and ONLY these two:
    //
    // 1. every DECIDED outcome carries `checkpointTransitions` after its
    //    `checkpoint` (the transitions that decided it);
    // 2. `onMarketResolved` (sequence 7) is a no-change hold — no patch, no
    //    draw, same status, same instant — so it owes no checkpoint: its
    //    `checkpoint` is `null` and the store holds 8 checkpoints, not 9.
    //
    // The base bytes are RECONSTRUCTED below by undoing exactly those two
    // differences, and must still hash to the value measured at base: so the
    // record, decision and checkpoint bytes of the honest path did not move.
    expect(harness.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 1, 2, 3, 4, 5, 6, 8]);
    expect(new TextEncoder().encode(text).length).toBe(7759);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(CKPT1_NINE_STAGE_SHA256);
    let previous: Record<string, unknown> | undefined;
    const reconstructed = outcomes.map((outcome) => {
      expect(outcome.kind).toBe("DECIDED");
      if (outcome.kind !== "DECIDED") return "";
      const { checkpointTransitions, ...rest } = outcome;
      expect(checkpointTransitions.length === 0).toBe(rest.checkpoint === null);
      const checkpoint =
        rest.checkpoint === null
          ? { ...previous, checkpointSeq: rest.record.evaluationSeq }
          : (rest.checkpoint as unknown as Record<string, unknown>);
      previous = checkpoint;
      return JSON.stringify({ ...rest, checkpoint });
    });
    const baseText = reconstructed.join("\n");
    expect(new TextEncoder().encode(baseText).length).toBe(7805);
    expect(createHash("sha256").update(baseText, "utf8").digest("hex")).toBe(
      "fa9f1b6345939072599dfeaf9ddbb447cff7e2bf85fe8d9ee4993cc56f6c89d9",
    );
  });
});

// ---------------------------------------------------------------------------
// H — the bounded pollution battery
// ---------------------------------------------------------------------------

describe("the bounded pollution battery: permission never varies and no throw escapes", () => {
  /**
   * DERIVED key material, not a hand-written list: every own key name that
   * appears anywhere in a valid evaluation input and a valid decision, plus the
   * `zod@4.4.3` state slots `schema-boundary.md` §2 names, plus the descriptor
   * fields, plus the index names the `WP-020-FU1` family is about.
   */
  function derivedNames(): readonly string[] {
    const names = new Set<string>();
    const walk = (value: unknown, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== "object") return;
      for (const key of Object.getOwnPropertyNames(value)) {
        names.add(key);
        walk((value as Record<string, unknown>)[key], depth + 1);
      }
    };
    for (const callback of [
      "onFeatures",
      "onFill",
      "onOrderUpdate",
      "onMarketClosing",
      "onMarketResolved",
      "onStop",
    ] as const) {
      walk(makeInput(callback), 0);
    }
    walk(
      {
        ...(makeInput("onFeatures") as unknown as Record<string, unknown>),
        sourceEvent: {
          eventId: "018f4a7e-3333-7abc-8def-0123456789ab",
          gatewayEpoch: "018f4a7e-4444-7abc-8def-0123456789ab",
          ingestSeq: "42",
        },
      },
      0,
    );
    walk(
      {
        decisionType: "quote",
        reasonCodes: ["TEST.Q"],
        featureSnapshotRef: SNAPSHOT_REF,
        modelOutputs: { edge: "0.1" },
        statePatch: { count: 1 },
        intents: [],
        nextWakeupAt: T0,
      },
      0,
    );
    for (const slot of [
      // §2's measured library reads
      "skipChecks",
      "optin",
      "optout",
      "when",
      "values",
      "jitless",
      "direction",
      // the arena's pinned internals
      "def",
      "constr",
      "run",
      "check",
      "propValues",
      "bag",
      "shape",
      "catchall",
      "checks",
      "error",
      "async",
      // descriptor fields
      "get",
      "set",
      "value",
      "writable",
      "enumerable",
      "configurable",
      // index names and the usual suspects
      "0",
      "1",
      "length",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      names.add(slot);
    }
    return [...names].sort();
  }

  const NAMES = derivedNames();
  const SHAPES: readonly Shape[] = ["data", "getOnly", "accessor", "enumerable"];

  it("the derived key material is non-vacuous and covers the names the audit names", () => {
    expect(NAMES.length).toBeGreaterThan(40);
    for (const required of [
      "skipChecks",
      "optin",
      "optout",
      "when",
      "values",
      "marketId",
      "evaluatedAt",
      "snapshotRef",
      "sourceEvent",
      "decisionType",
      "reasonCodes",
      "intents",
      "0",
    ]) {
      expect(NAMES, `derived key material must include ${required}`).toContain(required);
    }
  });

  /**
   * One evaluation, with CREATION modelled as a typed refusal channel.
   *
   * `makeHarness` throws when creation is refused, which is right for an
   * ordinary test and wrong for a battery: `createStrategyInstanceRuntime`
   * REFUSING is a typed, fail-closed outcome that ADR-020 §6 permits, and
   * several polluted names produce exactly that — an inherited `get`/`set`
   * makes every own-property descriptor look like an accessor, so the params
   * grammar answers `PARAMS_NOT_MATERIALIZABLE`, and an inherited `run` makes
   * the run-identity read answer `STRATEGY_SHAPE_INVALID`. Modelling those as
   * escapes would be the mistake `WP-200-FU1` remediation r1 corrected in the
   * PnL battery; this returns them as `CREATION_REFUSED:<code>` instead.
   */
  function evaluateOnce(strategy?: Parameters<typeof makeStrategy>[0]): string {
    const { definition } = makeDefinition(
      strategy === undefined ? {} : { strategy: makeStrategy(strategy) },
    );
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) return `CREATION_REFUSED:${created.refusal.code}`;
    const outcome = created.runtime.evaluate(makeInput("onFeatures"));
    // The OUTCOME's record, not the recording sink's. `RecordingSink.persist`
    // appends with `Array.prototype.push`, and `push` is `Set`, so an inherited
    // accessor at `"0"` swallows the first element and `calls[0]` then answers
    // from the prototype — the test double is defeated by the very class this
    // battery sweeps. That is a property of a `push`-based CONSUMER (a real one
    // has it too; it is the index-name family the queued `packages/risk`
    // grant-and-widen round owns), not of the door, so the battery reads what
    // the door EMITTED.
    const emitted = (outcome as { record?: { attribution?: string } }).record;
    return `${outcome.kind}/${String(emitted?.attribution)}`;
  }

  const INVALID_DECISION = {
    decisionType: "hold",
    reasonCodes: ["not a reason code"],
    featureSnapshotRef: SNAPSHOT_REF,
    intents: [],
    nextWakeupAt: "yesterday",
  };

  it("NOTHING a clean process refuses is ever accepted, and no throw escapes", () => {
    // The clean answers, computed once.
    expect(validateEvaluationInput(badFormatInput()).ok).toBe(false);
    expect(evaluateOnce({ onFeatures: () => INVALID_DECISION as never })).toBe(
      "CONTAINED/RUNTIME",
    );

    const divergences: string[] = [];
    /** Fail-closed outcomes, recorded rather than asserted away. */
    const availability: string[] = [];

    for (const name of NAMES) {
      for (const shape of SHAPES) {
        const pollution: Pollution = { name, shape, value: shape === "enumerable" ? 1 : true };

        // 1. PERMISSION — a format-invalid input must never be accepted, and
        //    the door must not throw (`validateEvaluationInput` never throws).
        try {
          const observed = under(pollution, () => {
            const result = validateEvaluationInput(badFormatInput());
            return result.ok ? "ACCEPTED" : "REFUSED";
          });
          if (observed !== "REFUSED") {
            divergences.push(`${name}/${shape} ACCEPTED a format-invalid input`);
          }
        } catch (cause) {
          divergences.push(`${name}/${shape} validateEvaluationInput ESCAPED ${String(cause)}`);
        }

        // 2. PERMISSION — an invalid DECISION must never be persisted as one.
        try {
          const observed = under(pollution, () =>
            evaluateOnce({ onFeatures: () => INVALID_DECISION as never }),
          );
          if (observed.startsWith("DECIDED")) {
            divergences.push(`${name}/${shape} PERSISTED an invalid decision (${observed})`);
          } else if (observed !== "CONTAINED/RUNTIME") {
            availability.push(`${name}/${shape} ${observed}`);
          }
        } catch (cause) {
          divergences.push(`${name}/${shape} evaluate() ESCAPED ${String(cause)}`);
        }

        // 3. AVAILABILITY — a valid run may be refused (fail-closed is
        //    permitted, ADR-020 §6), but it must be a TYPED outcome, never a
        //    throw. A constructor that refuses under descriptor-name or
        //    index-name interference arrives here as a refusal channel,
        //    exactly as the `WP-200-FU1` PnL battery models it.
        try {
          const honest = under(pollution, () => evaluateOnce());
          if (honest !== "DECIDED/STRATEGY") availability.push(`${name}/${shape} ${honest}`);
        } catch (cause) {
          divergences.push(`${name}/${shape} honest path ESCAPED ${String(cause)}`);
        }
      }
    }

    expect(divergences, "permission divergences and escaped throws").toEqual([]);
    // The fail-closed rows are ASSERTED to be typed channels, not silently
    // ignored: every one of them names a refusal code or an outcome kind.
    for (const row of availability) {
      expect(
        /(?:CREATION_REFUSED:[A-Z_]+|CONTAINED\/|REFUSED\/|HALTED\/)/u.test(row),
        `availability row must be a typed channel: ${row}`,
      ).toBe(true);
    }
    // Non-vacuity: the battery really did run the whole cross product, and it
    // really did exercise the fail-closed channel.
    expect(NAMES.length * SHAPES.length).toBeGreaterThan(160);
    expect(availability.length).toBeGreaterThan(0);
  });

  it("the honest path is BYTE-IDENTICAL under every polluted name, or a typed refusal", () => {
    // The `SAFETY_CANCEL`-analogue of §4 item 5 for this package: the one
    // persisted decision an honest evaluation produces, serialized, must be
    // either exactly the clean bytes or a typed refusal — never different
    // bytes.
    const honestBytes = (): string => {
      const { definition } = makeDefinition({});
      const created = createStrategyInstanceRuntime(definition);
      if (!created.ok) return `NOT-DECIDED:CREATION_REFUSED:${created.refusal.code}`;
      const outcome = created.runtime.evaluate(makeInput("onFeatures"));
      if (outcome.kind !== "DECIDED") return `NOT-DECIDED:${outcome.kind}`;
      // The door's emission, for the reason `evaluateOnce` records.
      return JSON.stringify({
        record: outcome.record,
        // `CKPT-1`: a first decision is the START transition, so it has one.
        stateJson: outcome.checkpoint?.stateJson,
      });
    };
    const clean = honestBytes();
    expect(clean.startsWith("NOT-DECIDED")).toBe(false);
    const divergences: string[] = [];
    let failedClosed = 0;
    for (const name of NAMES) {
      for (const shape of SHAPES) {
        let observed: string;
        try {
          observed = under({ name, shape, value: shape === "enumerable" ? 1 : true }, honestBytes);
        } catch (cause) {
          divergences.push(`${name}/${shape} ESCAPED ${String(cause)}`);
          continue;
        }
        if (observed === clean) continue;
        if (observed.startsWith("NOT-DECIDED")) {
          failedClosed += 1;
          continue; // fail-closed is permitted (ADR-020 §6)
        }
        divergences.push(`${name}/${shape} produced DIFFERENT bytes`);
      }
    }
    expect(divergences).toEqual([]);
    // Non-vacuity: at least one name really does fail closed, so "no
    // divergence" is not the answer of a battery that silently did nothing.
    expect(failedClosed).toBeGreaterThan(0);
  });
});
