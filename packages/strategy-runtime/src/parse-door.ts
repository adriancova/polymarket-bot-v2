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
 *   and it is bounded by measurement**: that subtree is
 *   `z.record(z.string(), z.union([string, boolean, null])).optional()` and
 *   contains ZERO format checks, so `skipChecks` — the class that defeats every
 *   other parse in this package — is a no-op on it. `test/unit/strategy-runtime/
 *   schema-door.test.ts` pins that as a differential over a corpus, and pins
 *   that the split's VERDICT equals the whole raw schema's verdict on every
 *   clean value, so the split changes refusal COMPOSITION (ADR-020 §6 permits
 *   that) and never permission.
 *
 * When the `packages/risk` widening lands, this split collapses to a single
 * `prototypeFreeParser(DecisionResultSchema)` and the residual disappears.
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
 */
export const RawModelOutputsSchema = DecisionResultSchema.pick({ modelOutputs: true });

/** The key held aside from the decision parse, named once. */
export const MODEL_OUTPUTS_KEY = "modelOutputs";

/**
 * The §7.5 field names, taken from the frozen contract rather than written out
 * here — D3's key list has to be the SCHEMA's, or the door emits this package's
 * opinion of the contract instead of the contract.
 *
 * `getOwnPropertyNames` on the shape, deliberately: a bracket read of
 * `shape["__proto__"]` answers `Object.prototype` on an ordinary object, which
 * is exactly how a returned decision carrying an own `__proto__` data property
 * is treated as a RECOGNIZED key by the library's own unknown-key walk. D3
 * copies only the names below, so such a key is dropped from the emitted
 * decision — the behaviour `WP-170`'s round-4 test pinned, preserved through
 * the change of value source.
 */
export const DECISION_FIELD_NAMES: readonly string[] = Object.freeze(
  Object.getOwnPropertyNames(DecisionResultSchema.shape),
);
