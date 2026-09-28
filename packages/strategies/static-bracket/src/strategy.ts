/**
 * The Static Bracket strategy object: WP-170's `Strategy<TParams, TState>`,
 * implemented (handoff §9.6, §13).
 *
 * What this file is responsible for, and nothing else:
 *
 * - present the four §9.6 identity members (`name`, `version`, `paramsSchema`,
 *   `stateSchemaVersion`);
 * - implement the nine callbacks, each returning EXACTLY ONE `DecisionResult`
 *   (§7.5, §6 invariant 3 — the RUNTIME guarantees the persistence, this object
 *   guarantees the single return value);
 * - convert a {@link Plan} from `decide.ts` into that result, echoing the
 *   feature snapshot reference the evaluation actually saw so the §6 invariant 4
 *   traceability chain is intact.
 *
 * TOTALITY. Every callback body is wrapped so that a defect here becomes a
 * recorded `skip` decision rather than a thrown callback: ADR-005 §3 makes a
 * throw a RUNTIME-attributed containment that PAUSES the instance, which is a
 * worse outcome than a strategy-attributed skip carrying a reason code. The one
 * deliberate exception is a failure to read the feature snapshot reference
 * itself: without it no valid decision can be constructed at all, so that case
 * is left to the runtime, which owns it.
 *
 * PURITY. No clock (time is `ctx.now()`), no randomness (the seeded
 * `ctx.rng()` is available and deliberately unused — this strategy is
 * deterministic without it), no I/O, no `node:` import, no module loader, no
 * evaluator. `check:deps` rule 3 enforces this mechanically for
 * `packages/strategies/**`.
 *
 * CONTEXT DISCIPLINE (WP-170 `follow_up` 2): the context is INVOCATION-SCOPED
 * and every capability on it is revoked when the callback returns. Nothing here
 * retains `ctx`, and every view is read exactly once, into
 * `observe.ts`'s validated snapshot, before any decision logic runs.
 */

import type {
  DecisionResult,
  ResolutionView,
  Strategy,
  StrategyContext,
  StrategyFill,
  StrategyOrderView,
} from "@polymarket-bot/strategy-sdk";

import {
  planClosing,
  planFill,
  planOrderUpdate,
  planResolved,
  planStop,
  planTick,
  type ConfirmedFill,
  type Plan,
} from "./decide.js";
import { isDecimal, isPrice } from "./economics.js";
import { observe, orderView, type Observation } from "./observe.js";
import { staticBracketParamsSchema, type StaticBracketParams } from "./params.js";
import { hasOwn } from "./plain.js";
import { REASONS } from "./reasons.js";
import {
  INITIAL_STATE,
  STATIC_BRACKET_STATE_SCHEMA_VERSION,
  readState,
  stateToPatch,
  withState,
  type StaticBracketState,
} from "./state.js";
import { formatInstantMs } from "./time.js";

/**
 * §9.6 identity. A change to either value starts a new run.
 *
 * `1.1.0` (`BRACKET-1a`): the protective reduction is tracked, held while live,
 * never cancelled by take-profit maintenance, retired only by its own expired
 * `validUntil`, and an exit terminal on the venue waits for its fill — a
 * behaviour change a run must not straddle. The state document's SHAPE is
 * unchanged (`STATIC_BRACKET_STATE_SCHEMA_VERSION` stays 2).
 */
export const STATIC_BRACKET_NAME = "static-bracket";
export const STATIC_BRACKET_VERSION = "1.1.0";

function decision(
  snapshotRef: string,
  type: DecisionResult["decisionType"],
  reasons: readonly string[],
  intents: DecisionResult["intents"],
  statePatch: Record<string, unknown> | undefined,
  modelOutputs: Readonly<Record<string, string | boolean | null>> | null,
  nextWakeupAt: string | undefined,
): DecisionResult {
  return {
    decisionType: type,
    reasonCodes: [...reasons],
    featureSnapshotRef: snapshotRef,
    ...(modelOutputs === null ? {} : { modelOutputs: { ...modelOutputs } }),
    ...(statePatch === undefined ? {} : { statePatch }),
    intents,
    ...(nextWakeupAt === undefined ? {} : { nextWakeupAt }),
  };
}

/** Renders a plan as the callback's single `DecisionResult`. */
function render(plan: Plan, previous: StaticBracketState, snapshotRef: string): DecisionResult {
  const changed = plan.state !== previous;
  let nextWakeupAt: string | undefined;
  if (plan.nextWakeupAtMs !== null) {
    const formatted = formatInstantMs(plan.nextWakeupAtMs, "nextWakeupAt");
    if (formatted.ok) {
      nextWakeupAt = formatted.value;
    }
  }
  return decision(
    snapshotRef,
    plan.decisionType,
    plan.reasons,
    plan.intents,
    changed ? stateToPatch(plan.state) : undefined,
    plan.modelOutputs,
    nextWakeupAt,
  );
}

/** A decision that records a refusal and changes nothing. */
function refusal(snapshotRef: string, reasons: readonly string[], detail: string): DecisionResult {
  return decision(snapshotRef, "skip", reasons, [], undefined, { detail: detail.slice(0, 500) }, undefined);
}

/**
 * A decision that halts the instance and records why. Used when the state
 * document or the position view cannot be read: an instance that cannot tell
 * what it holds must not act (§6 invariant 12).
 */
function haltDecision(
  snapshotRef: string,
  previous: StaticBracketState,
  reason: string,
  detail: string,
): DecisionResult {
  const halted = withState(previous, {
    instanceState: "HALTED",
    haltReason: detail.slice(0, 500),
  });
  return decision(
    snapshotRef,
    "hold",
    [reason, REASONS.halted],
    [],
    stateToPatch(halted),
    { detail: detail.slice(0, 500) },
    undefined,
  );
}

interface Prepared {
  readonly params: StaticBracketParams;
  readonly state: StaticBracketState;
  readonly observation: Observation;
}

type PrepareResult =
  | { readonly ok: true; readonly value: Prepared }
  | { readonly ok: false; readonly decision: DecisionResult };

/**
 * Reads params, state and views once, in that order, and turns any failure into
 * a decision rather than an exception.
 *
 * Params are re-validated here even though the runtime already validated them
 * at creation. That is not distrust of the runtime: `ctx.params()` answers with
 * the runtime's own materialized COPY, whose objects carry `Object.prototype`,
 * so re-running this package's total validator over the copy is what makes
 * every later read an own-property read of a value this strategy has checked.
 * It is also cheap — a fixed-size tree of scalars — and it means a wiring that
 * ever hands this strategy something else fails as a recorded refusal instead
 * of as arithmetic on a string nobody validated.
 */
function prepare(ctx: StrategyContext, snapshotRef: string): PrepareResult {
  const parsed = staticBracketParamsSchema.safeParse(ctx.params<unknown>());
  if (!parsed.success) {
    return {
      ok: false,
      decision: refusal(snapshotRef, [REASONS.paramsUnreadable], parsed.error.message),
    };
  }
  const state = readState(ctx.state<unknown>());
  if (!state.ok) {
    return {
      ok: false,
      decision: haltDecision(snapshotRef, INITIAL_STATE, REASONS.stateUnreadable, state.problem),
    };
  }
  const observation = observe(ctx);
  if (!observation.ok) {
    if (observation.fault.severity === "HALT") {
      return {
        ok: false,
        decision: haltDecision(
          snapshotRef,
          state.value,
          REASONS.viewUnusable,
          observation.fault.problem,
        ),
      };
    }
    // A PAUSE-severity view fault: the instance stops acting and says why. No
    // cancel intent is emitted here because the market id itself is among the
    // things that could not be read.
    const paused = withState(state.value, {
      instanceState: state.value.instanceState === "HALTED" ? "HALTED" : "PAUSED",
      resumeTo:
        state.value.instanceState === "PAUSED" || state.value.instanceState === "HALTED"
          ? state.value.resumeTo
          : state.value.instanceState,
      lastIncident: observation.fault.problem.slice(0, 500),
    });
    return {
      ok: false,
      decision: decision(
        snapshotRef,
        "hold",
        [REASONS.viewUnusable, REASONS.incidentPolicyFirst, REASONS.paused],
        [],
        stateToPatch(paused),
        { detail: observation.fault.problem.slice(0, 500) },
        undefined,
      ),
    };
  }
  return {
    ok: true,
    value: { params: parsed.data, state: state.value, observation: observation.value },
  };
}

/** Reads the snapshot reference; without it no valid decision can be built. */
function snapshotRefOf(ctx: StrategyContext): string | null {
  const snapshot = ctx.features();
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !hasOwn(snapshot, "snapshotRef") ||
    typeof snapshot.snapshotRef !== "string" ||
    snapshot.snapshotRef.length === 0
  ) {
    return null;
  }
  return snapshot.snapshotRef;
}

/**
 * Runs one callback body totally.
 *
 * A throw from inside the body is turned into a recorded `skip`. The snapshot
 * reference is read first and OUTSIDE the guard: when it cannot be read the
 * runtime's own refusal is the correct outcome, because a decision that cannot
 * name the snapshot it saw is not a decision the runtime may persist.
 */
function evaluate(
  ctx: StrategyContext,
  body: (prepared: Prepared, snapshotRef: string) => DecisionResult,
): DecisionResult {
  const snapshotRef = snapshotRefOf(ctx);
  if (snapshotRef === null) {
    throw new Error(
      "static-bracket: the feature snapshot view carries no usable snapshotRef, so no decision " +
        "can name the snapshot this evaluation saw (§6 invariant 4)",
    );
  }
  try {
    const prepared = prepare(ctx, snapshotRef);
    if (!prepared.ok) {
      return prepared.decision;
    }
    return body(prepared.value, snapshotRef);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "a non-Error value was thrown";
    return refusal(snapshotRef, [REASONS.internalRefusal], detail);
  }
}

/** Validates the `StrategyFill` payload before it can move any allocation. */
function readFill(fill: StrategyFill): ConfirmedFill | null {
  if (typeof fill !== "object" || fill === null) return null;
  const record = fill as unknown as Record<string, unknown>;
  for (const key of ["orderId", "outcome", "side", "price", "shares"]) {
    if (!hasOwn(record, key)) return null;
  }
  const orderId = record["orderId"];
  const outcome = record["outcome"];
  const side = record["side"];
  const price = record["price"];
  const shares = record["shares"];
  if (typeof orderId !== "string" || orderId.length === 0) return null;
  if (outcome !== "YES" && outcome !== "NO") return null;
  if (side !== "BUY" && side !== "SELL") return null;
  if (!isPrice(price)) return null;
  if (!isDecimal(shares)) return null;
  return Object.freeze({ orderId, outcome, side, price, shares });
}

/**
 * The strategy. A frozen object literal rather than a class: the runtime
 * captures each callback once at creation and applies it with the strategy as
 * its receiver, and a frozen literal has no prototype surface to tamper with.
 */
export const staticBracketStrategy: Strategy<StaticBracketParams, StaticBracketState> =
  Object.freeze({
    name: STATIC_BRACKET_NAME,
    version: STATIC_BRACKET_VERSION,
    paramsSchema: staticBracketParamsSchema,
    stateSchemaVersion: STATIC_BRACKET_STATE_SCHEMA_VERSION,

    onStart(ctx: StrategyContext): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        const plan = planTick({ ...prepared, closingSecondsRemaining: null });
        const rendered = render(plan, prepared.state, snapshotRef);
        return {
          ...rendered,
          reasonCodes: [REASONS.started, ...rendered.reasonCodes],
          // A fresh instance must persist its initial document even when the
          // tick changed nothing, so a restart restores a real state rather
          // than an empty one.
          statePatch: rendered.statePatch ?? stateToPatch(plan.state),
        };
      });
    },

    onMarketOpen(ctx: StrategyContext): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        const plan = planTick({ ...prepared, closingSecondsRemaining: null });
        const rendered = render(plan, prepared.state, snapshotRef);
        return { ...rendered, reasonCodes: [REASONS.marketOpen, ...rendered.reasonCodes] };
      });
    },

    onFeatures(ctx: StrategyContext): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) =>
        render(planTick({ ...prepared, closingSecondsRemaining: null }), prepared.state, snapshotRef),
      );
    },

    onFill(ctx: StrategyContext, fill: StrategyFill): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        const confirmed = readFill(fill);
        if (confirmed === null) {
          return refusal(
            snapshotRef,
            [REASONS.viewUnusable],
            "the fill payload is not a usable §9.6 StrategyFill",
          );
        }
        return render(
          planFill(prepared.params, prepared.state, prepared.observation, confirmed),
          prepared.state,
          snapshotRef,
        );
      });
    },

    onOrderUpdate(ctx: StrategyContext, order: StrategyOrderView): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        const view = orderView(order, "order");
        if (!view.ok) {
          return refusal(snapshotRef, [REASONS.viewUnusable], view.problem);
        }
        return render(
          planOrderUpdate(prepared.params, prepared.state, prepared.observation, view.value),
          prepared.state,
          snapshotRef,
        );
      });
    },

    onTimer(ctx: StrategyContext): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) =>
        render(planTick({ ...prepared, closingSecondsRemaining: null }), prepared.state, snapshotRef),
      );
    },

    onMarketClosing(ctx: StrategyContext, secondsRemaining: number): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        const seconds =
          typeof secondsRemaining === "number" && Number.isFinite(secondsRemaining) && secondsRemaining >= 0
            ? secondsRemaining
            : null;
        if (seconds === null) {
          return refusal(
            snapshotRef,
            [REASONS.viewUnusable],
            "onMarketClosing requires a finite non-negative secondsRemaining",
          );
        }
        return render(
          planClosing(prepared.params, prepared.state, prepared.observation, seconds),
          prepared.state,
          snapshotRef,
        );
      });
    },

    onMarketResolved(ctx: StrategyContext, resolution: ResolutionView): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) => {
        // The resolution's OUTCOME is deliberately not interpreted. This
        // package binds its market series by configured id and asserts no
        // settlement fact about it (the WP-110 caveat in the README); what the
        // strategy records is that the market resolved, which ends the bracket.
        void resolution;
        return render(
          planResolved(prepared.params, prepared.state, prepared.observation),
          prepared.state,
          snapshotRef,
        );
      });
    },

    onStop(ctx: StrategyContext, reason: string): DecisionResult {
      return evaluate(ctx, (prepared, snapshotRef) =>
        render(
          planStop(
            prepared.state,
            prepared.observation,
            typeof reason === "string" ? reason.slice(0, 200) : "unstated",
          ),
          prepared.state,
          snapshotRef,
        ),
      );
    },
  });
