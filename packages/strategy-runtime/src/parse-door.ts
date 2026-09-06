/**
 * THE PACKAGE'S ONE D2 SURFACE — every schema this runtime asks a question of,
 * asked through the canonical prototype-free parsing arena.
 *
 * `docs/contracts/schema-boundary.md` §1 defines a door as D1–D4 and §5 item 2
 * assigns this package "D2/D3 added to the existing materializer, covering the
 * `DecisionResult` parse at `runtime.ts:918` and the six scalar identifier
 * parses in `input.ts`". This module is D2: it holds the arena copies, built
 * ONCE at module load — which is clean by definition — and nothing else in the
 * package parses through a raw domain schema.
 *
 * The arena itself is NOT copied here. It is imported from `packages/risk`
 * across the `docs/contracts/dependency-direction.md` §2.1 **S7** same-layer
 * edge (`@polymarket-bot/risk/schema-arena`), which is the `WP-180-FU2`
 * mirror-collapse ruling applied to the fifth consumer: "consumes one
 * implementation instead of copying a fourth". A copy of either door module
 * under this package's `src` fails
 * `test/unit/execution-planner/mirrors.test.ts`, and this package's use of the
 * edge is pinned door-only by `test/unit/strategy-runtime/ports.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MEASURED, AND WHY THE RAW SCHEMAS ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * Reproduced at base `53e9f62` against this package, with ONE non-enumerable
 * data property on `Object.prototype` and nothing else:
 *
 * ```text
 * Object.prototype.skipChecks = true          (non-enumerable)
 *   validateEvaluationInput({ …, evaluatedAt: "yesterday",
 *                             market.marketId: "018F4A7E-1111-…-0123456789AB" })
 *     clean    → ok:false  "evaluatedAt must be an ISO-8601 timestamp"
 *     polluted → ok:TRUE
 *   acquireEvaluationInput(the same input)
 *     clean    → ok:false
 *     polluted → ok:TRUE, and the snapshot the callback and the persisted
 *                record then carry is marketId "018F4A7E-…" (UPPERCASE) with
 *                evaluatedAt "yesterday" — ADR-016's "refused, never
 *                case-folded" no longer enforced by anything.
 *
 *   per-parse, one field at a time (clean → polluted):
 *     evaluatedAt              IsoTimestampSchema           false → TRUE
 *     market.marketId          Uuidv7Schema                 false → TRUE
 *     sourceEvent.eventId      UuidSchema                   false → TRUE
 *     sourceEvent.gatewayEpoch UuidSchema                   false → TRUE
 *     sourceEvent.ingestSeq    UnsignedBigIntStringSchema   false → TRUE
 *     resolution.outcome       TerminalMarketOutcomeState   false → false
 *
 *   runtime.evaluate(), the DecisionResult parse:
 *     clean    → CONTAINED, RUNTIME.DECISION_INVALID, attribution RUNTIME
 *     polluted → DECIDED, attribution STRATEGY, and the persisted record is
 *                {"decisionType":"hold","reasonCodes":["not a reason code"],
 *                 …,"nextWakeupAt":"yesterday"}; with an intent, the record
 *                carries intentId "018F4A7E-2222-…" and validUntil "whenever".
 * ```
 *
 * The `resolution.outcome` row is the honest exception and is recorded rather
 * than rounded up: `TerminalMarketOutcomeStateSchema` is a `z.enum`, and enum
 * membership is decided by the node itself rather than by a `check`, so
 * `skipChecks` does not reach it. It is routed through the arena anyway — the
 * other classes §2 measures (`optin`/`optout`, `when`, `values`, the assembly
 * setters) do reach an enum, and a door that protects five of six parses on the
 * same code path is a door with a hole in it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SPLIT, AND WHY IT EXISTS: `modelOutputs`
 * ---------------------------------------------------------------------------
 *
 * MEASURED, not chosen. `prototypeFreeParser` FAILS CLOSED on a node type it
 * has never been measured against, and `DecisionResultSchema` contains one:
 *
 * ```text
 * prototypeFreeParser(DecisionResultSchema)
 *   → THROWS "schema arena: a door schema contains the node type "null",
 *             which the arena cannot copy."
 *   node-type census of DecisionResultSchema:
 *     array, boolean, enum, literal, never, NULL, number, object, optional,
 *     readonly, record, string, union, unknown
 *   ARENA_NODE_TYPES has all of those except `null`.
 * ```
 *
 * The single `null` node is `ModelOutputValueSchema`
 * (`z.union([z.string(), z.boolean(), z.null()])`, `domain/src/decision.ts:37`)
 * under `modelOutputs`. Widening `ARENA_NODE_TYPES` is a one-line change to
 * `packages/risk/src/schema-arena.ts` — plus its node-type equality assertion
 * in `test/unit/risk/schema-arena.test.ts` and the body sha256 pinned by
 * `test/unit/execution-planner/mirrors.test.ts` — and all three are outside
 * this package's grant. So `WP-170-FU1` does what it can do inside its grant
 * and states the rest:
 *
 * - `modelOutputs` is ISOLATED out of the parsed value exactly as `statePatch`
 *   already is, and the remaining decision is parsed through the ARENA copy of
 *   `DecisionResultSchema.omit({ modelOutputs: true })` — the library's own
 *   combinator, applied at module load, which leaves the frozen original
 *   untouched (asserted) and keeps `catchall: never`, i.e. strictness;
 * - the isolated `modelOutputs` is validated by the RAW
 *   `DecisionResultSchema.pick({ modelOutputs: true })`. **This is the residual,
 *   and it is bounded by measurement** — see the next section for exactly how
 *   far the bound reaches, which is less far than this round's first draft
 *   claimed.
 *
 * When the `packages/risk` widening lands, this split collapses to a single
 * `prototypeFreeParser(DecisionResultSchema)` and the residual disappears.
 *
 * ---------------------------------------------------------------------------
 * THE RESIDUAL'S ACTUAL BOUND — RESTATED 2026-09-06, REMEDIATION ROUND 1
 * ---------------------------------------------------------------------------
 *
 * Review round 1, LOW 2. The first draft of this header and the pin in
 * `test/unit/strategy-runtime/schema-door.test.ts` said "THE RESIDUAL, BOUNDED:
 * `skipChecks` cannot move the raw `modelOutputs` parse". That is TRUE and it is
 * NOT the whole bound. Measured base `53e9f62` vs tip, one non-enumerable
 * property at a time, an honest decision carrying `modelOutputs: {edge:"0.03"}`:
 *
 * ```text
 *   Object.prototype.<name> = true   (non-enumerable)     base        tip
 *     skipChecks   with modelOutputs      DECIDED     DECIDED     DECIDED
 *     optin/optout/propValues/pattern     DECIDED     DECIDED     DECIDED
 *     values       with modelOutputs      DECIDED     CONTAINED   CONTAINED
 *     values       WITHOUT modelOutputs   DECIDED     DECIDED     DECIDED
 *     when         with modelOutputs      DECIDED     ESCAPED     DECIDED
 *                                                     TypeError
 * ```
 *
 * Three statements, all measured:
 *
 * 1. the `skipChecks` half of the bound holds — that subtree is
 *    `z.record(z.string(), z.union([string, boolean, null])).optional()` and
 *    contains ZERO format checks, so the class that defeats every other parse in
 *    this package is a no-op on it. `schema-door.test.ts` pins it as a
 *    differential over a corpus, and pins that the split's VERDICT equals the
 *    whole raw schema's verdict on every clean value — the split changes refusal
 *    COMPOSITION (ADR-020 §6 permits that) and never permission;
 * 2. the `values`/AVAILABILITY class DOES reach it. It is PRE-EXISTING and
 *    IDENTICAL at base and tip — the door neither opened nor closed it — and it
 *    is FAIL-CLOSED (an honest decision is contained, never a bad one accepted),
 *    which ADR-020 §6 permits. It is closed by the queued `packages/risk`
 *    `ARENA_NODE_TYPES` widening, which lets this subtree through the arena like
 *    every other parse here;
 * 3. the `when` class was an ESCAPED `TypeError` at base and is a typed outcome
 *    at tip, because the rest of the decision now parses through the arena.
 *
 * The COLD-LAZY class is a fourth, and it is closed here rather than disclosed:
 * see {@link RawModelOutputsSchema}.
 */

import {
  DecisionResultSchema,
  IsoTimestampSchema,
  TerminalMarketOutcomeStateSchema,
  UnsignedBigIntStringSchema,
  Uuidv7Schema,
  UuidSchema,
} from "@polymarket-bot/domain";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";

/**
 * The five scalar identifier/timestamp doors of `input.ts`, plus the terminal
 * outcome enum. Copies are built at module load, when the process is clean, and
 * every lazy structure inside them is forced there too ({@link
 * prototypeFreeParser} warms every node) — so a cold first parse under
 * enumerable pollution answers what a clean one answers.
 */
export const DoorIsoTimestampSchema = prototypeFreeParser(IsoTimestampSchema);
export const DoorUuidv7Schema = prototypeFreeParser(Uuidv7Schema);
export const DoorUuidSchema = prototypeFreeParser(UuidSchema);
export const DoorUnsignedBigIntStringSchema = prototypeFreeParser(UnsignedBigIntStringSchema);
export const DoorTerminalMarketOutcomeStateSchema = prototypeFreeParser(
  TerminalMarketOutcomeStateSchema,
);

/**
 * The §7.5 decision contract WITHOUT `modelOutputs`, through the arena.
 *
 * `.omit` is the library's own combinator and builds a NEW schema from the same
 * shape members; the frozen `DecisionResultSchema` is not mutated (pinned).
 * `catchall` stays `never`, so the copy is still strict and still refuses an
 * unrecognized key.
 */
export const DoorDecisionWithoutModelOutputsSchema = prototypeFreeParser(
  DecisionResultSchema.omit({ modelOutputs: true }),
);

/**
 * The `modelOutputs` half, RAW — the disclosed residual explained in the module
 * header. It is deliberately a `pick` of the same frozen contract rather than a
 * hand-written rule, so the values it accepts are the contract's values and not
 * this package's opinion of them, and the issue paths it reports
 * (`["modelOutputs", <key>]`) are the ones the whole-schema parse reported.
 *
 * WARMED AT MODULE LOAD, and that line is not decoration — review round 1's
 * HIGH 1. This is the ONE schema in the package that is neither arena'd nor
 * (before this round) warmed, and `schema-boundary.md` §1 D2 requires "every
 * lazy forced at module load" for exactly the class reproduced below. A `pick`
 * normalizes its shape LAZILY, on the first parse, by walking the shape object;
 * that walk enumerates inherited enumerable names, and a half-built lazy is then
 * POISONED for the life of the process.
 *
 * Reproduced at tip `4c1bcde` (before this fix) against base `53e9f62`, ONE
 * enumerable `Object.prototype.zzUnrelated = 1` present at the FIRST-EVER
 * `modelOutputs` parse of the process, then deleted:
 *
 * ```text
 *   evaluate() returning a valid decision WITH modelOutputs
 *                              base 53e9f62            tip 4c1bcde
 *     parse 1  (polluted)      CONTAINED               CONTAINED
 *     parse 2  (polluted)      CONTAINED               CONTAINED
 *     parse 3  (CLEAN)         DECIDED   ← recovers    CONTAINED ← forever
 *     parse 4  (CLEAN)         DECIDED                 CONTAINED
 *     a decision with NO modelOutputs    DECIDED       DECIDED
 * ```
 *
 * The throw was `Invalid element at key "zzUnrelated": expected a Zod schema`,
 * raised out of `safeParse` itself rather than returned by it, so it was caught
 * only by `evaluate()`'s outer catch — the mis-attribution `runtime.ts`'s own
 * comment at the decision parse warns about. Both halves are fixed: the schema
 * is warmed here, and the call site wraps its `safeParse` in the same
 * region-attributing `try`/`catch` the decision parse already had.
 *
 * The probe value is an EMPTY record, which is the cheapest value that forces
 * the whole subtree: the `pick`'s shape getter and normalized key tables, the
 * optional wrapper, and the `z.record` node beneath it. Its verdict is
 * discarded. This is the same discipline `packages/risk`'s `warmNode` applies to
 * every arena copy, applied by hand to the one schema the arena cannot copy.
 */
export const RawModelOutputsSchema = DecisionResultSchema.pick({ modelOutputs: true });

RawModelOutputsSchema.safeParse({ modelOutputs: {} });

/** The key held aside from the decision parse, named once. */
export const MODEL_OUTPUTS_KEY = "modelOutputs";

/**
 * The §7.5 field names, taken from the frozen contract rather than written out
 * here — D3's key list has to be the SCHEMA's, or the door emits this package's
 * opinion of the contract instead of the contract.
 *
 * `getOwnPropertyNames` on the shape, deliberately: it reports the shape's OWN
 * names and cannot be answered from `Object.prototype`, so the emitted key list
 * is the contract's and only the contract's.
 *
 * CORRECTED 2026-09-06, remediation round 1 (review round 1, MEDIUM 1). The
 * previous text here claimed that "a bracket read of `shape["__proto__"]`
 * answers `Object.prototype` on an ordinary object, which is exactly how a
 * returned decision carrying an own `__proto__` data property is treated as a
 * RECOGNIZED key by the library's own unknown-key walk". That is NOT the
 * mechanism, and the difference matters because the wrong one predicts only the
 * top-level case. MEASURED in the pinned `zod@4.4.3` source: the strict object's
 * unknown-key walk (`v4/core/schemas.cjs:798-801`) and the record walk
 * (`:1527`) each open with `if (key === "__proto__") continue;`. The library
 * SKIPS that name at EVERY level, in objects and records alike — it is neither
 * refused as unrecognized nor validated against a value schema, and it never
 * reaches `parsed.data`.
 *
 * Two consequences, both now handled:
 *
 * - at the TOP level the name is dropped because D3 copies only the names
 *   below (the behaviour `WP-170`'s round-4 test pinned, preserved through the
 *   change of value source);
 * - at every NESTED level the field list cannot help, so the drop is made by
 *   the materializer's decision grammar instead (`json.ts`, `dropOwnProtoKey`).
 *   Without it, a D3 rebuild that emits the materialized tree emits a key the
 *   library never validated — including a JS number inside `modelOutputs`,
 *   whose value schema is `string|boolean|null` precisely to keep numbers out.
 */
export const DECISION_FIELD_NAMES: readonly string[] = Object.freeze(
  Object.getOwnPropertyNames(DecisionResultSchema.shape),
);
