/**
 * `EvaluationInput` — everything one evaluation may observe, supplied by the
 * event loop per §8.1 ("update local market/account state → update feature
 * snapshots → invoke subscribed strategies"). The runtime validates the input
 * SHALLOWLY and with typed detail before invoking anything: identifiers must
 * be canonical (a UUID-shaped value that is not canonical lowercase is
 * REFUSED, never case-folded — ADR-016), timestamps must be ISO-8601, the
 * callback payload must match the callback. An invalid input is a REFUSED
 * evaluation: the callback never runs and no decision record exists.
 *
 * Deep economic validation of view contents (book prices, position shares) is
 * deliberately NOT repeated here: views are produced in-process by components
 * that validated their own inputs against the frozen domain contracts, and
 * §8.1 gives the core loop a latency budget. The boundary re-validation lives
 * where untrusted bytes enter (adapters), not on every tick.
 *
 * Ownership — REPLACED 2026-09-03, remediation round 3 (review round 3's HIGH).
 * The runtime no longer takes ownership of the caller's objects at all: it
 * ACQUIRES one inert snapshot of the whole input (`acquireEvaluationInput`
 * below), reading every caller-supplied property exactly once inside a guard,
 * and every downstream consumer — validation, the `StrategyContext`, the
 * callback, the persisted `DecisionRecord`, the checkpoint — reads that one
 * snapshot and never the caller's object again.
 *
 * What that replaced, and why (the prior text is preserved in the paragraph
 * below so the change is legible): the runtime used to deep-freeze the caller's
 * view objects IN PLACE and then re-read them afterwards. Freezing makes
 * properties non-configurable; it does NOT make a `Proxy` trap or a getter
 * inert. Two consequences were reproduced verbatim against the round-2 code:
 *
 *     outcome=THREW:POST_CALLBACK_MARKET_ID_GET
 *     invoked=1  persist=0  checkpoints=0  evaluationSeq=0  status=ACTIVE
 *
 *     outcome=DECIDED
 *     callbackSaw=018f4a7e-1111-7abc-8def-0123456789ab
 *     recorded=018f4a7e-2222-7abc-8def-0123456789ab
 *     frozen=true
 *
 * — a market view whose third `marketId` read threw made `evaluate()` throw
 * AFTER the callback had run (so the RNG had advanced but no record and no
 * checkpoint represented the evaluation, and sequence 0 was still unused), and
 * a getter-based view handed market A to the callback and market B to the
 * persisted record while `Object.isFrozen` reported `true`. A bigger
 * `try`/`catch` would have contained the first and left the second silent.
 *
 * SUPERSEDED TEXT (round 1, kept for the record): "by passing an
 * `EvaluationInput`, the caller hands the view objects to the runtime, which
 * deep-freezes them IN PLACE before the strategy can see them (§7.6 read-only
 * views). The caller therefore may not keep mutating a view it passes: the
 * first evaluation freezes the producer's own object, and its next in-place
 * write throws in strict mode." — followed by a BINDING OBLIGATION on WP-230 to
 * pass a fresh or copied view per evaluation and to carry an integration test
 * proving it.
 *
 * That obligation is DISCHARGED by construction as of this round: the runtime
 * copies, so a producer may keep and mutate its own view objects, and no
 * caller-visible object is frozen by an evaluation. What WP-230 gains instead
 * is a cost — one deep copy of the views per evaluation, measured rather than
 * asserted in `docs/handoffs/WP-170.md` (remediation round 3) — and one rule
 * that survives: what the strategy sees is the snapshot, so a producer that
 * mutates a view AFTER `evaluate()` returns changes nothing about that
 * evaluation's record, checkpoint, or replay.
 */

import { MAX_IDENTIFIER_LENGTH } from "@polymarket-bot/domain";
import type { IsoTimestamp } from "@polymarket-bot/domain";
import {
  STRATEGY_CALLBACK_NAMES,
  type FeatureSnapshot,
  type MarketView,
  type OrderBookView,
  type ResolutionView,
  type RiskBudgetView,
  type SourceEventRef,
  type StrategyFill,
  type StrategyOrderView,
  type VirtualPositionView,
} from "@polymarket-bot/strategy-sdk";

import { deepFreeze, materializeEvaluationViewAt } from "./json.js";
import {
  DoorIsoTimestampSchema,
  DoorTerminalMarketOutcomeStateSchema,
  DoorUnsignedBigIntStringSchema,
  DoorUuidSchema,
  DoorUuidv7Schema,
} from "./parse-door.js";

export interface EvaluationViews {
  readonly market: MarketView;
  readonly books: { readonly yes: OrderBookView; readonly no: OrderBookView };
  readonly features: FeatureSnapshot;
  readonly position: VirtualPositionView;
  readonly orders: readonly StrategyOrderView[];
  readonly riskBudget: RiskBudgetView;
}

interface EvaluationBase extends EvaluationViews {
  /** Logical evaluation time — the value `ctx.now()` returns. */
  readonly evaluatedAt: IsoTimestamp;
  readonly sourceEvent?: SourceEventRef;
}

export type EvaluationInput =
  | (EvaluationBase & {
      readonly callback: "onStart" | "onMarketOpen" | "onFeatures" | "onTimer";
    })
  | (EvaluationBase & { readonly callback: "onFill"; readonly fill: StrategyFill })
  | (EvaluationBase & { readonly callback: "onOrderUpdate"; readonly order: StrategyOrderView })
  | (EvaluationBase & { readonly callback: "onMarketClosing"; readonly secondsRemaining: number })
  | (EvaluationBase & {
      readonly callback: "onMarketResolved";
      readonly resolution: ResolutionView;
    })
  | (EvaluationBase & { readonly callback: "onStop"; readonly reason: string });

export type InputValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * The result of taking one inert snapshot of a caller-supplied evaluation
 * input. `input` is fresh, plain, deep-frozen data that shares no object with
 * the caller.
 */
export type AcquireEvaluationInputResult =
  | { readonly ok: true; readonly input: EvaluationInput }
  | { readonly ok: false; readonly detail: string };

const CALLBACKS_WITHOUT_PAYLOAD = new Set(["onStart", "onMarketOpen", "onFeatures", "onTimer"]);

function bad(detail: string): InputValidationResult {
  return { ok: false, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * Whether the door schema ACCEPTS `value` — and never anything else.
 *
 * `safeParse` catches the library's own validation errors; it does not catch a
 * throw from the library's ISSUE and ERROR CONSTRUCTION, which runs OUTSIDE the
 * arena's reach (`_safeParse` finalizes issues against its own ordinary context
 * object, and `$ZodError` defines properties with object-literal descriptors).
 * Measured at this round's tip, on the REFUSAL path only, one non-enumerable
 * property on `Object.prototype` each:
 *
 * ```text
 * Object.prototype.error    = true   → TypeError: ctx?.error is not a function
 * Object.prototype.get      = true   → TypeError: Getter must be a function: true
 * Object.prototype.set      = true   → TypeError: Setter must be a function: true
 * Object.prototype.value    = true   → TypeError: Invalid property descriptor…
 * Object.prototype.writable = true   → TypeError: Invalid property descriptor…
 * ```
 *
 * Each of those escaped out of `validateEvaluationInput`, whose contract is
 * "Never throws" — ADR-020 §6's no-escape bound, broken by the library's error
 * path rather than by its parse path. A throw is therefore FAIL-CLOSED here,
 * and closing it costs nothing in fidelity: this function's callers never read
 * the library's message. Every refusal below is the door's OWN sentence, so a
 * refusal caused by a throw is byte-identical to the ordinary one.
 */
function accepts(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown): boolean {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

/**
 * Takes the runtime's ONE inert snapshot of a caller-supplied evaluation input
 * and validates it. Never throws.
 *
 * Order matters and is the whole point (round 3): the snapshot is taken FIRST,
 * so validation, the context, the callback, the record and the checkpoint all
 * read the same materialized data. Validating the caller's live object and then
 * using that object is the shape of the defect this replaced — the reads can
 * disagree, and nothing about the first read binds the second.
 *
 * The snapshot is deep-frozen because it is the runtime's own data by then:
 * freezing it cannot run caller code and cannot fail.
 */
export function acquireEvaluationInput(input: unknown): AcquireEvaluationInputResult {
  const materialized = materializeEvaluationViewAt(input, "input");
  if (!materialized.ok) {
    return {
      ok: false,
      detail:
        `evaluation input could not be read into an inert snapshot (${materialized.problem}); ` +
        "every view passed to evaluate() must be plain data the runtime can copy — the " +
        "callback was not invoked and no record was persisted",
    };
  }
  const snapshot = deepFreeze(materialized.value);
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    return validation;
  }
  return { ok: true, input: snapshot as EvaluationInput };
}

/**
 * Validates one evaluation input. Returns typed detail; never throws.
 *
 * TOTAL since remediation round 3: the value is materialized into an inert
 * snapshot first, so no read this function performs can run caller code. The
 * snapshot is then DISCARDED, which is safe here and is not the round-2 footgun
 * (`checkpointableJsonProblem`), because the runtime never trusts a prior
 * validation: `evaluate()` acquires its own snapshot and validates that. A
 * caller may use this to pre-check an input; it cannot use it to smuggle an
 * unvalidated object past `evaluate()`.
 */
export function validateEvaluationInput(input: unknown): InputValidationResult {
  const materialized = materializeEvaluationViewAt(input, "input");
  if (!materialized.ok) {
    return bad(
      `evaluation input could not be read into an inert snapshot: ${materialized.problem}`,
    );
  }
  return validateSnapshot(materialized.value);
}

/**
 * The shallow, typed validation — always applied to an inert snapshot.
 *
 * D1/D2/D3 (`docs/contracts/schema-boundary.md` §1), and the order is the whole
 * point:
 *
 * - **D1** the value handed here is the materialized tree, never the caller's
 *   object, and since `WP-170-FU1` that tree is PROTOTYPE-FREE — so
 *   `input["sourceEvent"]` on an input that carries no `sourceEvent` answers
 *   `undefined` rather than whatever a caller put on `Object.prototype`;
 * - **D2** every schema below is the ARENA copy from `./parse-door.js`, not the
 *   raw domain schema. Five of these six parses were measured accepting garbage
 *   under one non-enumerable inherited `skipChecks` at base `53e9f62`
 *   (transcript in `parse-door.ts`), which is precisely how ADR-016's "a
 *   UUID-shaped value that is not canonical lowercase is REFUSED, never
 *   case-folded" stopped being enforced;
 * - **D3** every value validated is read from that same tree and the tree is
 *   what the caller gets back — no parse output is consumed anywhere.
 */
function validateSnapshot(input: unknown): InputValidationResult {
  if (!isRecord(input)) {
    return bad("input must be an object");
  }
  const callback = input["callback"];
  if (
    typeof callback !== "string" ||
    !(STRATEGY_CALLBACK_NAMES as readonly string[]).includes(callback)
  ) {
    return bad(`callback must be one of ${STRATEGY_CALLBACK_NAMES.join(", ")}`);
  }
  if (!accepts(DoorIsoTimestampSchema, input["evaluatedAt"])) {
    return bad("evaluatedAt must be an ISO-8601 timestamp");
  }

  const market = input["market"];
  if (!isRecord(market)) {
    return bad("market view is required");
  }
  if (!accepts(DoorUuidv7Schema, market["marketId"])) {
    return bad(
      "market.marketId must be a canonical lowercase UUIDv7 — a non-canonical UUID-shaped " +
        "identifier is refused, never case-folded (ADR-016)",
    );
  }

  const books = input["books"];
  if (!isRecord(books) || !isRecord(books["yes"]) || !isRecord(books["no"])) {
    return bad("books.yes and books.no order-book views are required");
  }

  const features = input["features"];
  if (!isRecord(features)) {
    return bad("features snapshot view is required");
  }
  if (!isBoundedNonEmptyString(features["snapshotRef"])) {
    return bad(
      `features.snapshotRef must be a non-empty string of at most ${String(MAX_IDENTIFIER_LENGTH)} characters`,
    );
  }
  if (!isRecord(features["values"])) {
    return bad("features.values must be an object");
  }

  if (!isRecord(input["position"])) {
    return bad("position view is required");
  }
  if (!Array.isArray(input["orders"])) {
    return bad("orders must be an array of StrategyOrderView");
  }
  if (!isRecord(input["riskBudget"])) {
    return bad("riskBudget view is required");
  }

  const sourceEvent = input["sourceEvent"];
  if (sourceEvent !== undefined) {
    if (!isRecord(sourceEvent)) {
      return bad("sourceEvent must be an object when present");
    }
    const eventId = sourceEvent["eventId"];
    if (eventId !== undefined && !accepts(DoorUuidSchema, eventId)) {
      return bad("sourceEvent.eventId must be a canonical lowercase UUID (ADR-016)");
    }
    const gatewayEpoch = sourceEvent["gatewayEpoch"];
    if (gatewayEpoch !== undefined && !accepts(DoorUuidSchema, gatewayEpoch)) {
      return bad("sourceEvent.gatewayEpoch must be a canonical lowercase UUID (ADR-016)");
    }
    const ingestSeq = sourceEvent["ingestSeq"];
    if (ingestSeq !== undefined && !accepts(DoorUnsignedBigIntStringSchema, ingestSeq)) {
      return bad("sourceEvent.ingestSeq must be a canonical unsigned integer string");
    }
  }

  if (CALLBACKS_WITHOUT_PAYLOAD.has(callback)) {
    return { ok: true };
  }
  switch (callback) {
    case "onFill": {
      if (!isRecord(input["fill"])) {
        return bad("onFill requires a fill payload");
      }
      return { ok: true };
    }
    case "onOrderUpdate": {
      if (!isRecord(input["order"])) {
        return bad("onOrderUpdate requires an order payload");
      }
      return { ok: true };
    }
    case "onMarketClosing": {
      const seconds = input["secondsRemaining"];
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return bad("onMarketClosing requires a finite non-negative secondsRemaining");
      }
      return { ok: true };
    }
    case "onMarketResolved": {
      const resolution = input["resolution"];
      if (!isRecord(resolution)) {
        return bad("onMarketResolved requires a resolution payload");
      }
      if (!accepts(DoorTerminalMarketOutcomeStateSchema, resolution["outcome"])) {
        return bad(
          "resolution.outcome must be a terminal market outcome state " +
            "(YES_WIN, NO_WIN, SPLIT_50_50, CANCELLED) — a dispute is market state, not a resolution",
        );
      }
      return { ok: true };
    }
    case "onStop": {
      if (!isBoundedNonEmptyString(input["reason"])) {
        return bad("onStop requires a non-empty reason string");
      }
      return { ok: true };
    }
    default:
      return bad(`unhandled callback ${callback}`);
  }
}
