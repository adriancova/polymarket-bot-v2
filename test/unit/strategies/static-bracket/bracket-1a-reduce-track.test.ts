/**
 * `BRACKET-1a` — the protective reduction gets an order track, so an instance
 * survives its own exit (RISK-2 residual 5).
 *
 * Until this round `planProtectedReduce` moved the bracket into `EXIT_PLANNED`
 * and wrote NO order track. Every ladder evaluation before the fill re-emitted
 * the whole reduction (the scoping's probe P1b), and the reduction's own fill
 * matched no track, so the strategy called it `SB.UNATTRIBUTED_FILL` and PAUSED
 * (P1). The scoping also REPRODUCED why a track alone is not a fix: it cancels
 * its own working order (P2a), take-profit maintenance cancels it once a stop
 * clears (P5a), a redelivered terminal view of the replaced take-profit hijacks
 * it (P2d), and an exit terminal on the venue before its fill is folded either
 * pauses for good or over-sells (P4c/P4d). This file pins the fix against every
 * one of those sequences, and pins the user's rulings R2 (a reduction nobody
 * answers) and R3 (the reduction is sticky).
 *
 * THE PINS ARE WRITTEN TO DISTINGUISH A TRACK-ONLY FIX. Everything that tests
 * BEHAVIOUR below names reason codes by their literal strings and uses only the
 * package surface that existed at base `f034c0b`; only the `exitRole` block
 * (D2) and the code-vocabulary block (D8) touch what this round added. So the
 * file LOADS against the base sources and against the scoping's track-only
 * "variant A", and each pin fails there on the behaviour it is about — the
 * handoff names which.
 */

import { describe, expect, it } from "vitest";

import type { DecisionResult, Intent } from "../../../../packages/domain/src/index.js";
import {
  EXIT_ROLE_PREFIXES,
  REASONS,
  TAGS,
  exitRole,
  formatInstantMs,
  parseInstantMs,
  staticBracketParamsSchema,
  staticBracketStrategy,
  type OrderTrack,
  type StaticBracketParams,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { StrategyOrderView } from "../../../../packages/strategy-sdk/src/index.js";
import {
  createStrategyInstanceRuntime,
  type EvaluationInput,
  type StrategyInstanceRuntime,
} from "../../../../packages/strategy-runtime/src/index.js";
import {
  CONFIG_ID,
  INSTANCE_ID,
  MARKET_ID,
  ManualClock,
  RUN_ID,
  RUN_SEED,
  RecordingSink,
  RecordingStore,
  STOP_KEY,
  TRIGGER_KEY,
  T_NOW,
  baseConfig,
  configWith,
  context,
  evaluationInput,
  fillPayload,
  order,
  parsedParams,
  stateWith,
  type ViewOptions,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// The codes, by their literal strings (see the header)
// ---------------------------------------------------------------------------

const EXIT_ORDER_WORKING = "SB.EXIT_ORDER_WORKING";
const EXIT_ORDER_TERMINAL = "SB.EXIT_ORDER_TERMINAL";
const EXIT_FILLED = "SB.EXIT_FILLED";
const CLOSED = "SB.CLOSED";
const AWAITING_CANCEL = "SB.AWAITING_CANCEL_CONFIRMATION";
const AWAITING_FILL = "SB.AWAITING_FILL_ALLOCATION";
const AWAITING_RECONCILIATION = "SB.AWAITING_RECONCILIATION";
const UNATTRIBUTED_FILL = "SB.UNATTRIBUTED_FILL";
const POSITION_MISMATCH = "SB.POSITION_MISMATCH";
const PAUSED = "SB.PAUSED";
const HALTED = "SB.HALTED";
const TAKE_PROFIT_REPLACED = "SB.TAKE_PROFIT_REPLACED";
const SAFETY_CANCEL = "SB.SAFETY_CANCEL";
const STOP_TRIGGERED = "SB.STOP_TRIGGERED";
const HOLDING_TIMEOUT = "SB.HOLDING_TIMEOUT";
const EXIT_CUTOFF = "SB.EXIT_CUTOFF";
const RESOLUTION_HOLD_DISALLOWED = "SB.RESOLUTION_HOLD_DISALLOWED";
const EXIT_SIZED = "SB.EXIT_SIZED_TO_ALLOCATION";
const FINAL_PROTECTED_REDUCE = "SB.FINAL_PROTECTED_REDUCE";
const REFUSED_MAXIMUM_ENTRIES = "SB.REFUSED_MAXIMUM_ENTRIES";
const REFUSED_COOLDOWN = "SB.REFUSED_COOLDOWN";
const REARMED = "SB.REARMED";
const IDLE = "SB.IDLE";
// New in BRACKET-1a (D8), pinned to their strings in the vocabulary block.
const PROTECTED_REDUCE = "SB.PROTECTED_REDUCE";
const EXIT_INTENT_EXPIRED = "SB.EXIT_INTENT_EXPIRED";
const EXIT_SUBMISSION_UNKNOWN = "SB.EXIT_SUBMISSION_UNKNOWN";
const EXIT_RECONCILED = "SB.EXIT_RECONCILED";

// ---------------------------------------------------------------------------
// Driving the strategy the way the runtime folds it
// ---------------------------------------------------------------------------

/**
 * Instants, through the package's OWN strict-UTC codec — no `Date` anywhere in
 * this file (the suite's determinism rule, `helpers.ts`).
 */
function instantMs(text: string): number {
  const parsed = parseInstantMs(text, "fixture instant");
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
}
const NOW_MS = instantMs(T_NOW);
/** An instant on the fixture day, e.g. `at("12:14:49.500")`. */
const at = (clock: string): string => `2026-03-04T${clock}Z`;
/** `NOW_MS + offset`, as the instant text a view carries. */
function plus(offsetMs: number): string {
  const formatted = formatInstantMs(NOW_MS + offsetMs, "fixture instant");
  if (!formatted.ok) throw new Error(formatted.problem);
  return formatted.value;
}

function params(config: Record<string, unknown> = baseConfig()): StaticBracketParams {
  return parsedParams(staticBracketParamsSchema, config);
}

type PositionIntent = Extract<Intent, { readonly type: "POSITION" }>;

function positions(decision: DecisionResult): readonly PositionIntent[] {
  return decision.intents.filter(
    (intent): intent is PositionIntent => intent.type === "POSITION",
  );
}

function cancels(decision: DecisionResult): readonly Intent[] {
  return decision.intents.filter((intent) => intent.type === "CANCEL");
}

function sharesOf(intent: Intent): string {
  return intent.type === "POSITION" ? String(intent.targetShares) : "";
}

/**
 * Calls the SHIPPED callbacks in sequence and carries the state document
 * forward exactly as the runtime does: a decision's `statePatch` is the whole
 * document, and an absent patch means nothing changed.
 */
class Bracket {
  state: StaticBracketState;
  readonly log: DecisionResult[] = [];

  constructor(
    readonly config: StaticBracketParams,
    initial: StaticBracketState = stateWith({}),
  ) {
    this.state = initial;
  }

  private take(decision: DecisionResult): DecisionResult {
    if (decision.statePatch !== undefined) {
      this.state = decision.statePatch as unknown as StaticBracketState;
    }
    this.log.push(decision);
    return decision;
  }

  start(views: ViewOptions): DecisionResult {
    return this.take(staticBracketStrategy.onStart(context(this.config, this.state, views)));
  }

  features(views: ViewOptions): DecisionResult {
    return this.take(staticBracketStrategy.onFeatures(context(this.config, this.state, views)));
  }

  closing(views: ViewOptions, seconds: number): DecisionResult {
    return this.take(
      staticBracketStrategy.onMarketClosing(context(this.config, this.state, views), seconds),
    );
  }

  fill(views: ViewOptions, fill: Record<string, unknown>): DecisionResult {
    const payload = {
      orderId: "order-1",
      marketId: MARKET_ID,
      outcome: "YES",
      side: "BUY",
      price: "0.35",
      shares: "50",
      filledAt: views.now ?? T_NOW,
      ...fill,
    };
    return this.take(
      staticBracketStrategy.onFill(context(this.config, this.state, views), payload as never),
    );
  }

  /** `onOrderUpdate`, with the view also listed in `ctx.orders()` unless told otherwise. */
  update(views: ViewOptions, view: Partial<StrategyOrderView>): DecisionResult {
    const delivered = order(view);
    return this.take(
      staticBracketStrategy.onOrderUpdate(
        context(this.config, this.state, { orders: [delivered], ...views }),
        delivered,
      ),
    );
  }

  codes(): string[] {
    return this.log.flatMap((decision) => [...decision.reasonCodes]);
  }

  exit(): OrderTrack | null {
    return this.state.exitOrder;
  }
}

/** Views of the take-profit (`order-2`) and the reduction (`order-3`). */
const TP_VIEW = { orderId: "order-2", side: "SELL", price: "0.5" } as const;
const REDUCE_VIEW = { orderId: "order-3", side: "SELL", price: "0.26", requestedShares: "50" } as const;

/**
 * The paper e2e golden's own sequence, at strategy level (the scoping's probe
 * P1): an entry of 50 filled 30 + 20 against a position view that already holds
 * both, a take-profit placed for the first 30 and cancelled when the allocation
 * grew, and the close-cutoff reduction of all 50.
 */
function goldenToReduce(b: Bracket): DecisionResult {
  b.start({ now: at("12:00:01.000") });
  b.features({ now: at("12:00:02.000") });
  b.fill({ now: at("12:00:02.000"), yesShares: "50" }, { shares: "30", price: "0.34" });
  b.fill({ now: at("12:00:02.000"), yesShares: "50" }, { shares: "20", price: "0.35" });
  b.update(
    { now: at("12:00:02.000"), yesShares: "50" },
    { orderId: "order-1", status: "FILLED", filledShares: "50" },
  );
  b.update(
    { now: at("12:00:02.000"), yesShares: "50" },
    { ...TP_VIEW, requestedShares: "30", status: "OPEN" },
  );
  b.features({ now: at("12:00:03.000"), yesShares: "50" });
  b.update(
    { now: at("12:00:03.000"), yesShares: "50" },
    { ...TP_VIEW, requestedShares: "30", status: "CANCELED" },
  );
  return b.features({ now: at("12:14:49.000"), yesShares: "50" });
}

/** A bracket holding 50 YES, entered a second ago, with nothing resting. */
function openBracket(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
  return stateWith({
    instanceState: "OPEN",
    allocatedShares: "50",
    allocatedCost: "17.5",
    legOutcome: "YES",
    entriesExecuted: 1,
    openedAtMs: NOW_MS - 1000,
    ...overrides,
  });
}

const STOPPED = { [STOP_KEY]: "0.2" } as const;

/** No decision in the log paused, halted, or failed to name a fill. */
function expectNeverPaused(b: Bracket): void {
  const codes = b.codes();
  expect(codes).not.toContain(UNATTRIBUTED_FILL);
  expect(codes).not.toContain(POSITION_MISMATCH);
  expect(codes).not.toContain(PAUSED);
  expect(codes).not.toContain(HALTED);
}

// ---------------------------------------------------------------------------
// D1 — the track, for every cause
// ---------------------------------------------------------------------------

describe("D1 — planProtectedReduce records an EXIT track, for every cause", () => {
  const cases: {
    readonly cause: string;
    readonly decide: () => DecisionResult;
    readonly codes: readonly string[];
    readonly side: "SELL" | "BUY";
    readonly floor: string;
  }[] = [
    {
      cause: "the stop",
      decide: () =>
        staticBracketStrategy.onFeatures(
          context(params(), openBracket(), { yesShares: "50", features: STOPPED }),
        ),
      codes: [STOP_TRIGGERED, EXIT_SIZED, PROTECTED_REDUCE],
      side: "SELL",
      floor: "0.26",
    },
    {
      cause: "the holding timeout",
      decide: () =>
        staticBracketStrategy.onFeatures(
          context(params(), openBracket({ openedAtMs: NOW_MS - 180_000 }), { yesShares: "50" }),
        ),
      codes: [HOLDING_TIMEOUT, EXIT_SIZED, PROTECTED_REDUCE],
      side: "SELL",
      floor: "0.26",
    },
    {
      cause: "the close cutoff",
      decide: () =>
        staticBracketStrategy.onMarketClosing(
          context(params(), openBracket(), { yesShares: "50" }),
          19,
        ),
      codes: [EXIT_CUTOFF, RESOLUTION_HOLD_DISALLOWED, EXIT_SIZED, FINAL_PROTECTED_REDUCE],
      side: "SELL",
      floor: "0.26",
    },
    {
      cause: "the stop, on the COMPLEMENT leg (a buy-back)",
      decide: () =>
        staticBracketStrategy.onFeatures(
          context(
            params(configWith({ "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY" })),
            openBracket({ legOutcome: "NO", legBaselineShares: "100", allocatedCost: "35" }),
            { noShares: "50", features: STOPPED },
          ),
        ),
      codes: [STOP_TRIGGERED, EXIT_SIZED, PROTECTED_REDUCE],
      side: "BUY",
      floor: "0.74",
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.cause}: one reduction, and its track — PENDING, id-less, sized to the open allocation`, () => {
      const decision = testCase.decide();
      expect(decision.decisionType).toBe("reduce");
      expect(decision.reasonCodes).toEqual(testCase.codes);
      const [intent] = positions(decision);
      expect(positions(decision)).toHaveLength(1);
      expect(intent?.tags).toContain(TAGS.protectedReduce);
      const patch = decision.statePatch as unknown as StaticBracketState;
      expect(patch.instanceState).toBe("EXIT_PLANNED");
      expect(patch.exitOrder).toEqual({
        kind: "EXIT",
        intentId: intent?.type === "POSITION" ? intent.intentId : "?",
        orderId: null,
        state: "PENDING",
        outcome: patch.legOutcome,
        side: testCase.side,
        limitPrice: testCase.floor,
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS,
        escalated: false,
      });
      expect(patch.exitOrder?.intentId.startsWith("sb-protected-reduce-")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// D2 — the role, from the minted prefix
// ---------------------------------------------------------------------------

describe("D2 — exitRole reads the role from the minted prefix, and refuses what it did not mint", () => {
  const exitTrack = (intentId: string): OrderTrack => ({
    kind: "EXIT",
    intentId,
    orderId: null,
    state: "PENDING",
    outcome: "YES",
    side: "SELL",
    limitPrice: "0.5",
    requestedShares: "50",
    filledShares: "0",
    viewFilledShares: "0",
    placedAtMs: NOW_MS,
    escalated: false,
  });

  it("the two minted exit prefixes are exactly two, disjoint, and name one role each", () => {
    expect(EXIT_ROLE_PREFIXES).toEqual({
      TAKE_PROFIT: "sb-take-profit-",
      PROTECTED_REDUCE: "sb-protected-reduce-",
    });
    const prefixes = Object.values(EXIT_ROLE_PREFIXES);
    for (const one of prefixes) {
      for (const other of prefixes) {
        if (one === other) continue;
        // Neither is a prefix of the other, so no minted id can carry both.
        expect(one.startsWith(other) || other.startsWith(one)).toBe(false);
      }
    }
  });

  it("every exit id the strategy actually MINTS maps to exactly one role", () => {
    // A take-profit, minted from an entry fill…
    const tp = staticBracketStrategy.onFill(
      context(
        params(),
        stateWith({
          instanceState: "ENTRY_WORKING",
          intentSequence: 7,
          entryOrder: {
            kind: "ENTRY",
            intentId: "sb-entry-6",
            orderId: "order-1",
            state: "WORKING",
            outcome: "YES",
            side: "BUY",
            limitPrice: "0.35",
            requestedShares: "50",
            filledShares: "0",
            viewFilledShares: "0",
            placedAtMs: NOW_MS,
            escalated: true,
          },
        }),
        { yesShares: "50" },
      ),
      fillPayload()["fill"] as never,
    );
    // …and a reduction for each cause.
    const reductions = [
      staticBracketStrategy.onFeatures(
        context(params(), openBracket({ intentSequence: 8 }), { yesShares: "50", features: STOPPED }),
      ),
      staticBracketStrategy.onMarketClosing(
        context(params(), openBracket({ intentSequence: 9 }), { yesShares: "50" }),
        19,
      ),
    ];
    const minted: [DecisionResult, string][] = [
      [tp, "TAKE_PROFIT"],
      ...reductions.map((decision): [DecisionResult, string] => [decision, "PROTECTED_REDUCE"]),
    ];
    for (const [decision, role] of minted) {
      const track = (decision.statePatch as unknown as StaticBracketState).exitOrder as OrderTrack;
      const [intent] = positions(decision);
      expect(intent?.type === "POSITION" && intent.intentId).toBe(track.intentId);
      const read = exitRole(track);
      expect(read.ok && read.value).toBe(role);
      expect(
        Object.values(EXIT_ROLE_PREFIXES).filter((prefix) => track.intentId.startsWith(prefix)),
      ).toHaveLength(1);
    }
  });

  it("an unknown prefix, a near-miss and an ENTRY track are REFUSED by name, never guessed", () => {
    for (const intentId of [
      "sb-stop-1",
      "sb-take-profit",
      "xsb-take-profit-1",
      "SB-TAKE-PROFIT-1",
      "sb-entry-1",
      "sb-protected-reduce",
    ]) {
      const read = exitRole(exitTrack(intentId));
      expect(read.ok, intentId).toBe(false);
      if (!read.ok) expect(read.problem).toContain("refused, not guessed");
    }
    const entry = exitRole({ ...exitTrack("sb-take-profit-1"), kind: "ENTRY" });
    expect(entry.ok).toBe(false);
  });

  it("an evaluation holding an exit track of unknown role HALTS, naming it, on every role-reading callback", () => {
    const corrupt = stateWith({
      ...openBracket(),
      instanceState: "EXIT_WORKING",
      exitOrder: { ...exitTrack("sb-mystery-4"), orderId: "order-2", state: "WORKING" },
    });
    const views = { yesShares: "50", features: STOPPED };
    const decisions = [
      staticBracketStrategy.onFeatures(context(params(), corrupt, views)),
      staticBracketStrategy.onMarketClosing(context(params(), corrupt, views), 10),
      staticBracketStrategy.onFill(
        context(params(), corrupt, views),
        fillPayload({ orderId: "order-2", side: "SELL", shares: "10" })["fill"] as never,
      ),
      staticBracketStrategy.onOrderUpdate(
        context(params(), corrupt, views),
        order({ ...TP_VIEW, requestedShares: "50", status: "CANCELED" }),
      ),
    ];
    for (const decision of decisions) {
      expect(decision.reasonCodes).toEqual([HALTED]);
      expect(positions(decision)).toHaveLength(0);
      const patch = decision.statePatch as unknown as StaticBracketState;
      expect(patch.instanceState).toBe("HALTED");
      expect(patch.haltReason).toContain("sb-mystery-4");
      expect(patch.haltReason).toContain("refused, not guessed");
    }
  });
});

// ---------------------------------------------------------------------------
// D3 — no re-emission, no self-cancel (P1b, P2a)
// ---------------------------------------------------------------------------

describe("D3 — a live reduction is recognised: no second reduction and no cancel of it", () => {
  it("P1b: consecutive ladder evaluations while it is PENDING re-emit nothing", () => {
    const b = new Bracket(params());
    const reduce = goldenToReduce(b);
    expect(reduce.decisionType).toBe("reduce");
    expect(reduce.reasonCodes).toEqual([
      EXIT_CUTOFF,
      RESOLUTION_HOLD_DISALLOWED,
      EXIT_SIZED,
      FINAL_PROTECTED_REDUCE,
    ]);
    expect(b.exit()?.state).toBe("PENDING");
    expect(b.exit()?.orderId).toBeNull();

    const again = b.features({ now: at("12:14:49.500"), yesShares: "50" });
    const closing = b.closing({ now: at("12:14:50.000"), yesShares: "50" }, 10);
    for (const decision of [again, closing]) {
      expect(decision.decisionType).toBe("hold");
      expect(positions(decision)).toHaveLength(0);
      expect(cancels(decision)).toHaveLength(0);
      expect(decision.reasonCodes).toEqual([EXIT_CUTOFF, RESOLUTION_HOLD_DISALLOWED, EXIT_ORDER_WORKING]);
      // A track alone (the scoping's variant A) answered this evaluation with a
      // cancel it never sent: SB.AWAITING_CANCEL_CONFIRMATION on its own order.
      expect(decision.reasonCodes).not.toContain(AWAITING_CANCEL);
    }
    // Across the whole run: exactly ONE reduction was ever emitted.
    expect(b.log.flatMap((decision) => positions(decision)).filter((intent) =>
      intent.tags.includes(TAGS.protectedReduce),
    )).toHaveLength(1);
  });

  it("P2a: once it is WORKING — and partly filled — the ladder never cancels it", () => {
    const b = new Bracket(params());
    goldenToReduce(b);
    b.features({ now: at("12:14:49.500"), yesShares: "50" });
    const opened = b.update({ now: at("12:14:49.600"), yesShares: "50" }, { ...REDUCE_VIEW, status: "OPEN" });
    expect(opened.reasonCodes).toEqual([EXIT_ORDER_WORKING]);
    expect(b.state.instanceState).toBe("EXIT_WORKING");
    expect(b.exit()).toMatchObject({ orderId: "order-3", state: "WORKING" });

    const working = [
      b.closing({ now: at("12:14:50.000"), yesShares: "50" }, 10),
      b.features({ now: at("12:14:50.500"), yesShares: "50" }),
    ];
    b.fill(
      { now: at("12:14:51.000"), yesShares: "30" },
      { orderId: "order-3", side: "SELL", price: "0.32", shares: "20" },
    );
    expect(b.state.instanceState).toBe("EXIT_WORKING");
    expect(b.exit()).toMatchObject({ state: "WORKING", filledShares: "20" });
    working.push(
      b.features({ now: at("12:14:51.500"), yesShares: "30" }),
      b.closing({ now: at("12:14:52.000"), yesShares: "30" }, 8),
    );
    for (const decision of working) {
      expect(decision.decisionType).toBe("hold");
      expect(positions(decision)).toHaveLength(0);
      expect(cancels(decision)).toHaveLength(0);
      expect(decision.reasonCodes).toContain(EXIT_ORDER_WORKING);
      expect(decision.reasonCodes).not.toContain(SAFETY_CANCEL);
    }
    const last = b.fill(
      { now: at("12:14:52.500"), yesShares: "0" },
      { orderId: "order-3", side: "SELL", price: "0.3", shares: "30" },
    );
    expect(last.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expectNeverPaused(b);
  });

  it("with a stop or a timeout too, a live reduction is held — whichever cause re-evaluates", () => {
    for (const views of [
      { yesShares: "50", features: STOPPED },
      { yesShares: "50", now: plus(200_000) },
    ]) {
      const b = new Bracket(params(), openBracket());
      const placed = b.features(views);
      expect(placed.decisionType).toBe("reduce");
      const held = b.features({ ...views, now: plus(views.now === undefined ? 1000 : 201_000) });
      expect(held.decisionType).toBe("hold");
      expect(positions(held)).toHaveLength(0);
      expect(cancels(held)).toHaveLength(0);
      expect(held.reasonCodes).toContain(EXIT_ORDER_WORKING);
    }
  });
});

// ---------------------------------------------------------------------------
// The reduction's fill folds — both delivery orders
// ---------------------------------------------------------------------------

describe("the reduction's own fill folds, fill-before-view AND view-before-fill", () => {
  it("fill before view (the golden's order): complete → CLOSED with closedAtMs, then the golden's tail", () => {
    const b = new Bracket(params());
    goldenToReduce(b);
    const filled = b.fill(
      { now: at("12:14:49.000"), yesShares: "0" },
      { orderId: "order-3", side: "SELL", price: "0.32", shares: "50" },
    );
    // Golden decision 9, as it now reads.
    expect(filled.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expect(filled.modelOutputs).toBeUndefined();
    expect(b.state).toMatchObject({
      instanceState: "CLOSED",
      exitOrder: null,
      exitedShares: "50",
      closedAtMs: instantMs(at("12:14:49.000")),
    });
    // Golden decision 10: the reduction's own FILLED view names no track now.
    const view = b.update(
      { now: at("12:14:49.000"), yesShares: "0" },
      { ...REDUCE_VIEW, filledShares: "50", status: "FILLED" },
    );
    expect(view.reasonCodes).toEqual([IDLE]);
    // Golden decision 11: reentry max 1, and planRearm checks it before the cooldown.
    const closing = b.closing({ now: at("12:14:50.000"), yesShares: "0" }, 10);
    expect(closing.reasonCodes).toEqual([REFUSED_MAXIMUM_ENTRIES]);
    expectNeverPaused(b);
  });

  it("fill before view, partial: EXIT_WORKING, then the rest closes it", () => {
    const b = new Bracket(params(), openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    const partial = b.fill(
      { yesShares: "30", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "20" },
    );
    expect(partial.reasonCodes).toEqual([EXIT_FILLED]);
    expect(b.state.instanceState).toBe("EXIT_WORKING");
    expect(b.exit()).toMatchObject({ orderId: "order-3", state: "WORKING", filledShares: "20" });
    b.update(
      { yesShares: "30", features: STOPPED },
      { ...REDUCE_VIEW, filledShares: "20", status: "PARTIALLY_FILLED" },
    );
    const rest = b.fill(
      { yesShares: "0", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.26", shares: "30" },
    );
    expect(rest.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expect(b.state.closedAtMs).toBe(NOW_MS);
    expectNeverPaused(b);
  });

  it("view before fill: a LIVE view names it, a terminal FILLED view waits for the fold, the fill closes", () => {
    const b = new Bracket(params(), openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    b.update({ yesShares: "50", features: STOPPED }, { ...REDUCE_VIEW, status: "OPEN" });
    b.update(
      { yesShares: "50", features: STOPPED },
      { ...REDUCE_VIEW, filledShares: "20", status: "PARTIALLY_FILLED" },
    );
    const partial = b.fill(
      { yesShares: "30", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "20" },
    );
    expect(partial.reasonCodes).toEqual([EXIT_FILLED]);
    expect(b.state.instanceState).toBe("EXIT_WORKING");
    // The venue reports the order FILLED before the last 30 are delivered.
    const done = b.update(
      { yesShares: "0", features: STOPPED },
      { ...REDUCE_VIEW, filledShares: "50", status: "FILLED" },
    );
    expect(done.reasonCodes).toEqual([EXIT_ORDER_WORKING, EXIT_ORDER_TERMINAL, AWAITING_FILL]);
    expect(b.exit()).toMatchObject({ state: "FILLED", filledShares: "20", viewFilledShares: "50" });
    // An evaluation in between places nothing.
    const between = b.features({ yesShares: "0", features: STOPPED });
    expect(positions(between)).toHaveLength(0);
    expect(between.reasonCodes).toContain(AWAITING_FILL);
    const last = b.fill(
      { yesShares: "0", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.26", shares: "30" },
    );
    expect(last.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expectNeverPaused(b);
  });

  it("view before fill, never seen alive: its FILLED view names nothing, and the fill still closes it", () => {
    const b = new Bracket(params(), openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    const view = b.update(
      { yesShares: "0", features: STOPPED },
      { ...REDUCE_VIEW, filledShares: "50", status: "FILLED" },
    );
    expect(view.reasonCodes).toEqual([IDLE]);
    const filled = b.fill(
      { yesShares: "0", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "50" },
    );
    expect(filled.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expectNeverPaused(b);
  });
});

// ---------------------------------------------------------------------------
// R3 / D4 — take-profit maintenance never touches a live reduction
// ---------------------------------------------------------------------------

describe("R3 / D4 — the reduction is sticky, and a take-profit is sized by what it still has to sell", () => {
  /** The scoping's P5a opening: a working take-profit withdrawn by a stop, then the stop reduction. */
  function stopReducePlaced(b: Bracket): DecisionResult {
    b.start({ now: at("12:00:01.000") });
    b.features({ now: at("12:00:02.000") });
    b.fill({ now: at("12:00:03.000"), yesShares: "50" }, {});
    b.update(
      { now: at("12:00:03.000"), yesShares: "50" },
      { orderId: "order-1", status: "FILLED", filledShares: "50" },
    );
    b.update(
      { now: at("12:00:03.000"), yesShares: "50" },
      { ...TP_VIEW, requestedShares: "50", status: "OPEN" },
    );
    const withdraw = b.features({ now: at("12:00:04.000"), yesShares: "50", features: STOPPED });
    expect(withdraw.decisionType).toBe("cancel");
    b.update(
      { now: at("12:00:04.000"), yesShares: "50" },
      { ...TP_VIEW, requestedShares: "50", status: "CANCELED" },
    );
    return b.features({ now: at("12:00:05.000"), yesShares: "50", features: STOPPED });
  }

  it("P5a: a stop reduction partly filled, then the stop clears — held, never cancelled or replaced", () => {
    const b = new Bracket(params());
    const reduce = stopReducePlaced(b);
    expect(reduce.reasonCodes).toEqual([STOP_TRIGGERED, EXIT_SIZED, PROTECTED_REDUCE]);
    b.update({ now: at("12:00:05.000"), yesShares: "50" }, { ...REDUCE_VIEW, status: "OPEN" });
    b.fill(
      { now: at("12:00:06.000"), yesShares: "30" },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "20" },
    );
    // The stop is back above its trigger: the ladder falls through to
    // take-profit maintenance, with the reduction live and 30 of 50 left.
    const cleared = b.features({ now: at("12:00:07.000"), yesShares: "30" });
    expect(cleared.decisionType).toBe("hold");
    expect(cleared.reasonCodes).toEqual([EXIT_ORDER_WORKING]);
    expect(cleared.reasonCodes).not.toContain(TAKE_PROFIT_REPLACED);
    expect(cancels(cleared)).toHaveLength(0);
    expect(positions(cleared)).toHaveLength(0);
    // …and it keeps being held, never re-priced, until it completes.
    const later = b.features({ now: at("12:00:30.000"), yesShares: "30" });
    expect(later.reasonCodes).toEqual([EXIT_ORDER_WORKING]);
    expect(b.exit()).toMatchObject({ orderId: "order-3", limitPrice: "0.26", requestedShares: "50" });
    const last = b.fill(
      { now: at("12:00:31.000"), yesShares: "0" },
      { orderId: "order-3", side: "SELL", price: "0.3", shares: "30" },
    );
    expect(last.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expectNeverPaused(b);
  });

  it("P4a: a take-profit's OWN partial fill no longer triggers cancel-and-replace", () => {
    const b = new Bracket(params());
    b.start({ now: at("12:00:01.000") });
    b.features({ now: at("12:00:02.000") });
    b.fill({ now: at("12:00:03.000"), yesShares: "50" }, {});
    b.update({ now: at("12:00:03.000"), yesShares: "50" }, { orderId: "order-1", status: "FILLED", filledShares: "50" });
    b.update({ now: at("12:00:03.000"), yesShares: "50" }, { ...TP_VIEW, requestedShares: "50", status: "OPEN" });
    b.fill(
      { now: at("12:00:10.000"), yesShares: "30" },
      { orderId: "order-2", side: "SELL", price: "0.5", shares: "20" },
    );
    const next = b.features({ now: at("12:00:11.000"), yesShares: "30" });
    expect(next.decisionType).toBe("hold");
    expect(next.reasonCodes).toEqual([EXIT_ORDER_WORKING]);
    expect(cancels(next)).toHaveLength(0);
    // The remainder 50 − 20 = 30 is exactly the open allocation.
    expect(b.exit()).toMatchObject({ requestedShares: "50", filledShares: "20", state: "WORKING" });
  });

  it("a take-profit whose remainder no longer matches IS still cancelled first (the allocation grew)", () => {
    // The discrimination for the line above: the comparison moved, the rule
    // did not. A resting 30 against an allocation of 50 is withdrawn.
    const b = new Bracket(params());
    goldenToReduce(b);
    const resize = b.log.find((decision) => decision.reasonCodes.includes(TAKE_PROFIT_REPLACED));
    expect(resize?.decisionType).toBe("cancel");
    expect(resize?.reasonCodes).toEqual([TAKE_PROFIT_REPLACED, SAFETY_CANCEL]);
  });

  it("CANCEL_ONLY at the close leaves a live stop reduction working (it is not the policy's to withdraw)", () => {
    const config = params(configWith({ "exit.final_policy": "CANCEL_ONLY" }));
    const b = new Bracket(config, openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    b.update({ yesShares: "50", features: STOPPED }, { ...REDUCE_VIEW, status: "OPEN" });
    const atClose = b.closing({ yesShares: "50" }, 10);
    expect(atClose.decisionType).toBe("hold");
    expect(cancels(atClose)).toHaveLength(0);
    expect(b.exit()?.state).toBe("WORKING");
  });
});

// ---------------------------------------------------------------------------
// D5 — a stale terminal view never hijacks an id-less reduction
// ---------------------------------------------------------------------------

describe("D5 — an id-less reduction is named only by a LIVE view", () => {
  it("P2d: the replaced take-profit's CANCELED view, redelivered, is not the reduction's — it ends CLOSED", () => {
    const b = new Bracket(params());
    goldenToReduce(b);
    const stale = b.update(
      { now: at("12:14:49.000"), yesShares: "50" },
      { ...TP_VIEW, requestedShares: "30", status: "CANCELED" },
    );
    expect(stale.reasonCodes).toEqual([IDLE]);
    expect(b.exit()).toMatchObject({ orderId: null, state: "PENDING" });
    const filled = b.fill(
      { now: at("12:14:49.000"), yesShares: "0" },
      { orderId: "order-3", side: "SELL", price: "0.32", shares: "50" },
    );
    expect(filled.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
    expect(b.state.instanceState).toBe("CLOSED");
    expectNeverPaused(b);
  });

  it("the ladder does not ADOPT a stale terminal view either; it adopts the reduction's live one", () => {
    const b = new Bracket(params());
    goldenToReduce(b);
    const staleTp = order({ ...TP_VIEW, requestedShares: "30", status: "CANCELED" });
    const ignored = b.features({ now: at("12:14:49.500"), yesShares: "50", orders: [staleTp] });
    expect(ignored.reasonCodes).toContain(EXIT_ORDER_WORKING);
    expect(b.exit()).toMatchObject({ orderId: null, state: "PENDING" });
    const live = order({ ...REDUCE_VIEW, status: "OPEN" });
    b.closing({ now: at("12:14:50.000"), yesShares: "50", orders: [staleTp, live] }, 10);
    expect(b.exit()).toMatchObject({ orderId: "order-3", state: "WORKING" });
    expect(b.state.instanceState).toBe("EXIT_WORKING");
  });
});

// ---------------------------------------------------------------------------
// D6 — an exit terminal on the venue waits for its fill (P4c, P4d)
// ---------------------------------------------------------------------------

describe("D6 — exit settlement waits while the venue reports more executed than is folded", () => {
  /** A 50-share bracket with its take-profit working, withdrawn at the cutoff. */
  function tpWithdrawnAtCutoff(b: Bracket): void {
    b.start({ now: at("12:00:01.000") });
    b.features({ now: at("12:00:02.000") });
    b.fill({ now: at("12:00:03.000"), yesShares: "50" }, {});
    b.update({ now: at("12:00:03.000"), yesShares: "50" }, { orderId: "order-1", status: "FILLED", filledShares: "50" });
    b.update({ now: at("12:00:03.000"), yesShares: "50" }, { ...TP_VIEW, requestedShares: "50", status: "OPEN" });
    const withdraw = b.features({ now: at("12:14:41.000"), yesShares: "50" });
    expect(withdraw.decisionType).toBe("cancel");
  }

  it("P4c: the CANCELED view (20 of 50 sold) outruns its fill — no pause, the late fill folds by id, then the remainder", () => {
    const b = new Bracket(params());
    tpWithdrawnAtCutoff(b);
    const terminal = b.update(
      { now: at("12:14:42.000"), yesShares: "30" },
      { ...TP_VIEW, requestedShares: "50", filledShares: "20", status: "CANCELED" },
    );
    expect(terminal.reasonCodes).toEqual([EXIT_ORDER_WORKING, EXIT_ORDER_TERMINAL, AWAITING_FILL]);
    expect(b.exit()).toMatchObject({ orderId: "order-2", state: "CANCELED", viewFilledShares: "20" });
    // A position view that already reflects the sale: the instance waits.
    const leading = b.features({ now: at("12:14:43.000"), yesShares: "30" });
    expect(leading.decisionType).toBe("hold");
    expect(leading.reasonCodes).toEqual([EXIT_ORDER_TERMINAL, AWAITING_FILL]);
    expect(positions(leading)).toHaveLength(0);
    // The late fill matches the kept track BY ORDER ID and is folded.
    const late = b.fill(
      { now: at("12:14:44.000"), yesShares: "30" },
      { orderId: "order-2", side: "SELL", price: "0.5", shares: "20" },
    );
    expect(late.reasonCodes).toEqual([EXIT_FILLED]);
    expect(b.state.exitedShares).toBe("20");
    // Now the order settles, and the cutoff reduces exactly what is left.
    const reduce = b.features({ now: at("12:14:45.000"), yesShares: "30" });
    expect(reduce.decisionType).toBe("reduce");
    expect(positions(reduce).map(sharesOf)).toEqual(["-30"]);
    expectNeverPaused(b);
  });

  it("P4d: the same race with a LAGGING position view never names more than the folded remainder", () => {
    const b = new Bracket(params());
    tpWithdrawnAtCutoff(b);
    b.update(
      { now: at("12:14:42.000"), yesShares: "50" },
      { ...TP_VIEW, requestedShares: "50", filledShares: "20", status: "CANCELED" },
    );
    const lagging = b.features({ now: at("12:14:43.000"), yesShares: "50" });
    // At base this evaluation emitted a reduction of ALL 50 with 30 left.
    expect(positions(lagging)).toHaveLength(0);
    expect(lagging.reasonCodes).toContain(AWAITING_FILL);
    b.fill(
      { now: at("12:14:44.000"), yesShares: "30" },
      { orderId: "order-2", side: "SELL", price: "0.5", shares: "20" },
    );
    b.features({ now: at("12:14:45.000"), yesShares: "30" });
    // Every reduction the whole run emitted is within what was open when it was named.
    const named = b.log.flatMap((decision) => positions(decision)).filter((intent) =>
      intent.tags.includes(TAGS.protectedReduce),
    );
    expect(named.map(sharesOf)).toEqual(["-30"]);
  });
});

// ---------------------------------------------------------------------------
// R2 — a reduction nobody answers
// ---------------------------------------------------------------------------

describe("R2 — SUBMISSION_UNKNOWN after the silence bound; retired only by its own expired validUntil, never once named", () => {
  // baseConfig: submission_unknown_after_ms 5000, order_validity_ms 30000.
  function placed(config: StaticBracketParams = params()): Bracket {
    const b = new Bracket(config, openBracket());
    const reduce = b.features({ yesShares: "50", features: STOPPED });
    expect(reduce.decisionType).toBe("reduce");
    return b;
  }
  const stopAt = (offsetMs: number, held = "50"): ViewOptions => ({
    now: plus(offsetMs),
    yesShares: held,
    features: STOPPED,
  });

  it("PENDING until the silence bound, then SUBMISSION_UNKNOWN, reported as the entry reports it", () => {
    const b = placed();
    const early = b.features(stopAt(4999));
    expect(early.reasonCodes).toEqual([STOP_TRIGGERED, EXIT_ORDER_WORKING]);
    expect(early.nextWakeupAt).toBe(plus(5000));
    expect(b.exit()?.state).toBe("PENDING");

    const unknown = b.features(stopAt(5000));
    expect(unknown.decisionType).toBe("hold");
    expect(unknown.reasonCodes).toEqual([
      STOP_TRIGGERED,
      EXIT_ORDER_WORKING,
      EXIT_SUBMISSION_UNKNOWN,
      AWAITING_RECONCILIATION,
    ]);
    expect(unknown.modelOutputs).toEqual({ submissionUnknown: true });
    expect(positions(unknown)).toHaveLength(0);
    expect(cancels(unknown)).toHaveLength(0);
    expect(b.exit()?.state).toBe("SUBMISSION_UNKNOWN");

    // Still unknown, still held, still nothing re-sent — up to and INCLUDING
    // the instant the intent's own validUntil names.
    for (const offset of [10_000, 29_999, 30_000]) {
      const held = b.features(stopAt(offset));
      expect(held.reasonCodes, String(offset)).toEqual([
        STOP_TRIGGERED,
        EXIT_ORDER_WORKING,
        EXIT_SUBMISSION_UNKNOWN,
        AWAITING_RECONCILIATION,
      ]);
      expect(positions(held)).toHaveLength(0);
    }
  });

  it("retired strictly AFTER validUntil, and the ladder re-plans ONE reduction, gated by positionAgrees", () => {
    const b = placed();
    const firstId = b.exit()?.intentId;
    b.features(stopAt(5000));
    const retired = b.features(stopAt(30_001));
    expect(retired.decisionType).toBe("reduce");
    expect(retired.reasonCodes).toEqual([
      EXIT_INTENT_EXPIRED,
      STOP_TRIGGERED,
      EXIT_SIZED,
      PROTECTED_REDUCE,
    ]);
    const [replanned] = positions(retired);
    expect(positions(retired)).toHaveLength(1);
    expect(sharesOf(replanned as Intent)).toBe("-50");
    expect(replanned?.type === "POSITION" && replanned.intentId).not.toBe(firstId);
    expect(replanned?.type === "POSITION" && replanned.validUntil).toBe(plus(30_001 + 30_000));
    expect(b.exit()).toMatchObject({ state: "PENDING", orderId: null, placedAtMs: NOW_MS + 30_001 });
  });

  it("at most one reduction per validity window, however often the ladder runs", () => {
    const b = placed();
    const emittedAt: number[] = [0];
    for (let offset = 500; offset <= 100_000; offset += 500) {
      const decision = b.features(stopAt(offset));
      if (positions(decision).length > 0) emittedAt.push(offset);
      expect(cancels(decision)).toHaveLength(0);
    }
    // 0, then strictly after each window: 30 001 → 30 500 (the first ladder
    // run past it), 60 501 → 61 000, 91 001 → 91 500.
    expect(emittedAt).toEqual([0, 30_500, 61_000, 91_500]);
    for (let index = 1; index < emittedAt.length; index += 1) {
      expect((emittedAt[index] as number) - (emittedAt[index - 1] as number)).toBeGreaterThan(30_000);
    }
  });

  it("the re-plan is still gated by positionAgrees: a disagreeing view reconciles instead", () => {
    const b = placed();
    const retired = b.features(stopAt(30_001, "30"));
    expect(retired.reasonCodes).toContain(EXIT_INTENT_EXPIRED);
    expect(retired.reasonCodes).toContain(POSITION_MISMATCH);
    expect(positions(retired)).toHaveLength(0);
  });

  it("a track NAMED by a live view is never retired by expiry, however long it is silent", () => {
    const b = placed();
    b.update(stopAt(1000), { ...REDUCE_VIEW, status: "OPEN" });
    expect(b.exit()).toMatchObject({ orderId: "order-3", state: "WORKING" });
    for (const offset of [30_001, 60_000, 290_000]) {
      const decision = b.features(stopAt(offset));
      expect(decision.reasonCodes, String(offset)).toEqual([STOP_TRIGGERED, EXIT_ORDER_WORKING]);
      expect(positions(decision)).toHaveLength(0);
    }
    expect(b.codes()).not.toContain(EXIT_INTENT_EXPIRED);
  });

  it("a track NAMED by a fill is never retired by expiry either", () => {
    const b = placed();
    b.fill(stopAt(1000, "30"), { orderId: "order-3", side: "SELL", price: "0.27", shares: "20" });
    expect(b.exit()).toMatchObject({ orderId: "order-3", filledShares: "20" });
    for (const offset of [30_001, 290_000]) {
      const decision = b.features(stopAt(offset, "30"));
      expect(decision.reasonCodes).toEqual([STOP_TRIGGERED, EXIT_ORDER_WORKING]);
      expect(positions(decision)).toHaveLength(0);
    }
    expect(b.codes()).not.toContain(EXIT_INTENT_EXPIRED);
  });

  it("a SUBMISSION_UNKNOWN reduction found by a live view is reconciled as an EXIT", () => {
    const b = placed();
    b.features(stopAt(5000));
    const found = b.update(stopAt(6000), { ...REDUCE_VIEW, status: "OPEN" });
    expect(found.reasonCodes).toEqual([EXIT_ORDER_WORKING, EXIT_RECONCILED]);
    expect(b.exit()).toMatchObject({ orderId: "order-3", state: "WORKING" });
    expect(b.state.instanceState).toBe("EXIT_WORKING");
  });

  it("a reduction rejected on arrival (a terminal view, never alive, nothing filled) is retired once its intent expires", () => {
    const b = placed();
    const rejected = b.update(stopAt(100), { ...REDUCE_VIEW, status: "REJECTED" });
    expect(rejected.reasonCodes).toEqual([IDLE]);
    const retired = b.features(stopAt(30_001));
    expect(retired.reasonCodes[0]).toBe(EXIT_INTENT_EXPIRED);
    expect(positions(retired)).toHaveLength(1);
  });

  it("a validity window shorter than the silence bound retires straight from PENDING", () => {
    const b = placed(params(configWith({ "entry.execution.order_validity_ms": 3000 })));
    const retired = b.features(stopAt(3001));
    expect(retired.reasonCodes).toEqual([
      EXIT_INTENT_EXPIRED,
      STOP_TRIGGERED,
      EXIT_SIZED,
      PROTECTED_REDUCE,
    ]);
    expect(b.codes()).not.toContain(EXIT_SUBMISSION_UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// Repeated brackets, through the real WP-170 runtime
// ---------------------------------------------------------------------------

describe("repeated brackets — a reduction-closed bracket re-arms and enters again (max entries 2)", () => {
  function harness(): { runtime: StrategyInstanceRuntime; store: RecordingStore; sink: RecordingSink } {
    const config = baseConfig();
    (config["reentry"] as Record<string, unknown>)["maximum_entries_per_market"] = 2;
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const store = new RecordingStore();
    const created = createStrategyInstanceRuntime({
      strategy: staticBracketStrategy,
      params: config,
      run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: RUN_SEED },
      watchdog: { evaluationBudgetUs: 500_000 },
      clock,
      decisionSink: sink,
      checkpointStore: store,
    });
    if (!created.ok) throw new Error(`the runtime refused the strategy: ${created.refusal.code}`);
    return { runtime: created.runtime, store, sink };
  }

  function step(
    runtime: StrategyInstanceRuntime,
    callback: EvaluationInput["callback"],
    views: ViewOptions,
    payload: Record<string, unknown> = {},
  ): DecisionResult {
    const outcome = runtime.evaluate(evaluationInput(callback, views, payload));
    if (outcome.kind !== "DECIDED") throw new Error(`expected DECIDED, got ${outcome.kind}`);
    return outcome.record.decision;
  }

  function stateOf(store: RecordingStore): StaticBracketState {
    const last = store.checkpoints[store.checkpoints.length - 1];
    return JSON.parse((last as { stateJson: string }).stateJson) as StaticBracketState;
  }

  const cases = [
    {
      cause: "a STOP",
      trigger: { now: at("12:00:10.000"), features: STOPPED },
      reduceAt: { now: at("12:00:11.000"), features: STOPPED },
      code: STOP_TRIGGERED,
      closedAt: at("12:00:11.000"),
      cooling: at("12:00:20.000"),
      rearm: at("12:00:41.000"),
      enter: at("12:00:42.000"),
    },
    {
      cause: "a HOLDING TIMEOUT",
      trigger: { now: at("12:03:03.000") },
      reduceAt: { now: at("12:03:04.000") },
      code: HOLDING_TIMEOUT,
      closedAt: at("12:03:04.000"),
      cooling: at("12:03:20.000"),
      rearm: at("12:03:34.000"),
      enter: at("12:03:35.000"),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.cause}: reduce → EXIT_FILLED, CLOSED → cooldown → REARMED → a second entry`, () => {
      const { runtime, store, sink } = harness();
      step(runtime, "onStart", { now: at("12:00:01.000") });
      const entry = step(runtime, "onFeatures", { now: at("12:00:02.000"), features: { [TRIGGER_KEY]: "0.35" } });
      expect(entry.decisionType).toBe("enter");
      step(runtime, "onOrderUpdate", { now: at("12:00:02.000"), orders: [order()] }, { order: order() });
      step(runtime, "onFill", { now: at("12:00:03.000"), yesShares: "50" }, fillPayload());
      const tp = order({ ...TP_VIEW, requestedShares: "50" });
      step(runtime, "onOrderUpdate", { now: at("12:00:03.000"), yesShares: "50", orders: [tp] }, { order: tp });
      // The cause withdraws the resting take-profit first…
      const withdraw = step(runtime, "onFeatures", { ...testCase.trigger, yesShares: "50" });
      expect(withdraw.decisionType).toBe("cancel");
      const tpDone = order({ ...TP_VIEW, requestedShares: "50", status: "CANCELED" });
      step(runtime, "onOrderUpdate", { ...testCase.trigger, yesShares: "50", orders: [tpDone] }, { order: tpDone });
      // …then reduces, with a TRACK.
      const reduce = step(runtime, "onFeatures", { ...testCase.reduceAt, yesShares: "50" });
      expect(reduce.decisionType).toBe("reduce");
      expect(reduce.reasonCodes).toEqual([testCase.code, EXIT_SIZED, PROTECTED_REDUCE]);
      expect(stateOf(store).exitOrder).toMatchObject({ state: "PENDING", orderId: null });
      const filled = step(
        runtime,
        "onFill",
        { ...testCase.reduceAt, yesShares: "0" },
        fillPayload({ orderId: "order-3", side: "SELL", price: "0.27", shares: "50" }),
      );
      expect(filled.reasonCodes).toEqual([EXIT_FILLED, CLOSED]);
      expect(stateOf(store)).toMatchObject({
        instanceState: "CLOSED",
        entriesExecuted: 1,
        closedAtMs: instantMs(testCase.closedAt),
      });
      const cooling = step(runtime, "onFeatures", { now: testCase.cooling, yesShares: "0" });
      expect(cooling.reasonCodes).toEqual([REFUSED_COOLDOWN]);
      const rearmed = step(runtime, "onFeatures", { now: testCase.rearm, yesShares: "0" });
      expect(rearmed.reasonCodes).toEqual([REARMED]);
      expect(stateOf(store)).toMatchObject({ instanceState: "ARMED", exitOrder: null, entryOrder: null });
      const second = step(runtime, "onFeatures", {
        now: testCase.enter,
        yesShares: "0",
        features: { [TRIGGER_KEY]: "0.35" },
      });
      expect(second.decisionType).toBe("enter");
      expect(positions(second)).toHaveLength(1);
      step(runtime, "onFill", { now: testCase.enter, yesShares: "50" }, fillPayload({ orderId: "order-4" }));
      expect(stateOf(store).entriesExecuted).toBe(2);
      // No decision anywhere paused, halted or failed to name a fill.
      const codes = sink.decisions.flatMap((decision) => [...decision.reasonCodes]);
      expect(codes).not.toContain(UNATTRIBUTED_FILL);
      expect(codes).not.toContain(PAUSED);
      expect(codes).not.toContain(HALTED);
    });
  }
});

// ---------------------------------------------------------------------------
// Stale data, pause and resume with a reduction on the books
// ---------------------------------------------------------------------------

describe("stale data with a working reduction: cancel and pause (never a blind flatten); a paused fill folds; resume closes", () => {
  const STALE = { asOf: at("12:04:00.000") };

  it("incidentPlan cancels the WORKING reduction, the cancel-race fill folds while PAUSED, resume closes the bracket", () => {
    const b = new Bracket(params(), openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    b.update({ yesShares: "50", features: STOPPED }, { ...REDUCE_VIEW, status: "OPEN" });
    expect(b.state.instanceState).toBe("EXIT_WORKING");

    const incident = b.features({
      yesShares: "50",
      features: STOPPED,
      yes: { bids: [["0.34", "2000"]], asks: [["0.35", "2000"]], ...STALE },
    });
    expect(incident.decisionType).toBe("cancel");
    expect(positions(incident)).toHaveLength(0);
    expect(cancels(incident)).toHaveLength(1);
    const [cancel] = cancels(incident);
    expect(cancel?.type === "CANCEL" && cancel.orderIds).toEqual(["order-3"]);
    expect(incident.reasonCodes).toContain(PAUSED);
    expect(incident.reasonCodes).toContain("SB.NO_BLIND_FLATTEN");
    expect(b.state).toMatchObject({ instanceState: "PAUSED", resumeTo: "EXIT_WORKING" });
    expect(b.exit()?.state).toBe("CANCEL_PENDING");

    // The cancel lost the race: the reduction filled. The fill folds while paused.
    const paused = b.fill(
      { yesShares: "0", yes: { bids: [["0.34", "2000"]], asks: [["0.35", "2000"]], ...STALE } },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "50" },
    );
    expect(paused.reasonCodes).toEqual([EXIT_FILLED, "SB.FILL_FOLDED_WHILE_PAUSED", PAUSED]);
    expect(b.state).toMatchObject({ instanceState: "PAUSED", exitedShares: "50", exitOrder: null });

    // Fresh data: resume, and the bracket is finished.
    const resumed = b.features({ now: plus(1000), yesShares: "0" });
    expect(resumed.reasonCodes).toEqual(["SB.RESUMED", CLOSED]);
    expect(b.state).toMatchObject({ instanceState: "CLOSED", closedAtMs: NOW_MS + 1000 });
    expect(b.codes()).not.toContain(UNATTRIBUTED_FILL);
  });

  it("with a PENDING reduction, stale data still cancels and pauses and emits no reduction", () => {
    const b = new Bracket(params(), openBracket());
    b.features({ yesShares: "50", features: STOPPED });
    const incident = b.features({
      yesShares: "50",
      features: STOPPED,
      yes: { bids: [["0.34", "2000"]], asks: [["0.35", "2000"]], ...STALE },
    });
    expect(positions(incident)).toHaveLength(0);
    expect(incident.reasonCodes).toContain("SB.STOP_SUPPRESSED_STALE_DATA");
    expect(b.state.instanceState).toBe("PAUSED");
  });
});

// ---------------------------------------------------------------------------
// A late ENTRY fill after the reduction was placed
// ---------------------------------------------------------------------------

describe("a late ENTRY fill after the reduction was placed", () => {
  it("returns the bracket to the exit states, places nothing beside the reduction, and the reduction's fill still folds", () => {
    // The entry's view said FILLED 50 while only 30 were delivered; a lagging
    // position view (30) let the stop reduce the 30 it knew about.
    const state = openBracket({
      instanceState: "EXIT_PLANNED",
      allocatedShares: "30",
      allocatedCost: "10.2",
      intentSequence: 2,
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "FILLED",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.35",
        requestedShares: "50",
        filledShares: "30",
        viewFilledShares: "50",
        placedAtMs: NOW_MS - 2000,
        escalated: true,
      },
      exitOrder: {
        kind: "EXIT",
        intentId: `sb-protected-reduce-1-${MARKET_ID}`,
        orderId: null,
        state: "PENDING",
        outcome: "YES",
        side: "SELL",
        limitPrice: "0.26",
        requestedShares: "30",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS - 500,
        escalated: false,
      },
    });
    const b = new Bracket(params(), state);
    const late = b.fill({ yesShares: "50", features: STOPPED }, { orderId: "order-1", shares: "20" });
    expect(late.decisionType).toBe("hold");
    expect(late.reasonCodes).toEqual(["SB.ALLOCATION_CONFIRMED", EXIT_ORDER_WORKING]);
    expect(positions(late)).toHaveLength(0);
    expect(cancels(late)).toHaveLength(0);
    expect(b.state).toMatchObject({ instanceState: "EXIT_PLANNED", allocatedShares: "50" });
    expect(b.exit()).toMatchObject({ requestedShares: "30", state: "PENDING" });

    // The reduction fills its 30 — folded, not refused as an illegal transition.
    const reduced = b.fill(
      { yesShares: "20", features: STOPPED },
      { orderId: "order-3", side: "SELL", price: "0.27", shares: "30" },
    );
    expect(reduced.reasonCodes).toEqual([EXIT_FILLED]);
    expect(b.state).toMatchObject({ instanceState: "EXIT_WORKING", exitedShares: "30" });
    // Its FILLED view settles it; the stop then reduces the 20 the entry added.
    b.update({ yesShares: "20", features: STOPPED }, { ...REDUCE_VIEW, requestedShares: "30", filledShares: "30", status: "FILLED" });
    const rest = b.features({ yesShares: "20", features: STOPPED });
    expect(rest.decisionType).toBe("reduce");
    expect(positions(rest).map(sharesOf)).toEqual(["-20"]);
    expectNeverPaused(b);
  });
});

// ---------------------------------------------------------------------------
// D8 — the vocabulary
// ---------------------------------------------------------------------------

describe("D8 — the reason codes this round added, and the one it narrowed", () => {
  it("names each new code by its stable string", () => {
    expect(REASONS.protectedReduce).toBe(PROTECTED_REDUCE);
    expect(REASONS.exitIntentExpired).toBe(EXIT_INTENT_EXPIRED);
    expect(REASONS.exitSubmissionUnknown).toBe(EXIT_SUBMISSION_UNKNOWN);
    expect(REASONS.exitReconciled).toBe(EXIT_RECONCILED);
    expect(REASONS.finalProtectedReduce).toBe(FINAL_PROTECTED_REDUCE);
  });

  it("SB.FINAL_PROTECTED_REDUCE marks the close cutoff only; a stop or a timeout says SB.PROTECTED_REDUCE", () => {
    const stop = staticBracketStrategy.onFeatures(
      context(params(), openBracket(), { yesShares: "50", features: STOPPED }),
    );
    const timeout = staticBracketStrategy.onFeatures(
      context(params(), openBracket({ openedAtMs: NOW_MS - 180_000 }), { yesShares: "50" }),
    );
    const cutoff = staticBracketStrategy.onMarketClosing(
      context(params(), openBracket(), { yesShares: "50", features: STOPPED }),
      19,
    );
    for (const decision of [stop, timeout]) {
      expect(decision.reasonCodes).toContain(PROTECTED_REDUCE);
      expect(decision.reasonCodes).not.toContain(FINAL_PROTECTED_REDUCE);
    }
    expect(cutoff.reasonCodes).toContain(FINAL_PROTECTED_REDUCE);
    expect(cutoff.reasonCodes).not.toContain(PROTECTED_REDUCE);
  });
});
