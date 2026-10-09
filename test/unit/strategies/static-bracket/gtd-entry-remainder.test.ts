/**
 * `C1-TIF` r1, finding C1-TIF-01: a GTD entry's RESTING REMAINDER is still the
 * bracket's entry, so the bracket may not certify CLOSED (or fall back to
 * `OPEN`) while it is live.
 *
 * Since `C1-TIF` an immediate entry is GTD (FAK and FOK are refused at
 * validation), and a GTD entry that fills in part rests its remainder until its
 * deadline. The exit is sized from the fold (§13.3 rule 1), so the take-profit
 * could sell everything folded while the remainder still rested. Before r1 the
 * take-profit's fill then certified CLOSED; the remainder's later fill had no
 * §13.3 edge out of CLOSED, was refused as `SB.ILLEGAL_TRANSITION`, and was
 * never folded; the bracket resumed into CLOSED holding the shares, with no
 * exit, no stop and no halt (reproduced by both verifiers of r0).
 *
 * Every test here drives the SHIPPED callbacks only, carrying the state
 * document forward the way the runtime does. Each fails against `e4d7ef0`.
 */

import { describe, expect, it } from "vitest";

import type { DecisionResult } from "../../../../packages/domain/src/index.js";
import {
  EXIT_ROLE_PREFIXES,
  parseInstantMs,
  staticBracketParamsSchema,
  staticBracketStrategy,
  type StaticBracketParams,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { StrategyOrderView } from "../../../../packages/strategy-sdk/src/index.js";

import {
  MARKET_ID,
  baseConfig,
  configWith,
  context,
  order,
  orderTrack,
  parsedParams,
  stateWith,
  type ViewOptions,
} from "./helpers.js";

const at = (clock: string): string => `2026-03-04T${clock}Z`;
function ms(clock: string): number {
  const parsed = parseInstantMs(at(clock), "fixture instant");
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
}

const CLOSED = "SB.CLOSED";
const ILLEGAL_TRANSITION = "SB.ILLEGAL_TRANSITION";
const POSITION_MISMATCH = "SB.POSITION_MISMATCH";
const PAUSED = "SB.PAUSED";
const HALTED = "SB.HALTED";
const ENTRY_ORDER_WORKING = "SB.ENTRY_ORDER_WORKING";
const TAKE_PROFIT_INTENT = "SB.TAKE_PROFIT_INTENT";
const EXIT_INTENT_EXPIRED = "SB.EXIT_INTENT_EXPIRED";

/** The shipped callbacks, with the state document carried forward. */
class Bracket {
  readonly log: DecisionResult[] = [];

  constructor(
    readonly config: StaticBracketParams,
    public state: StaticBracketState = stateWith({}),
  ) {}

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

  fill(views: ViewOptions, fill: Record<string, unknown>): DecisionResult {
    const payload = {
      orderId: "order-1",
      marketId: MARKET_ID,
      outcome: "YES",
      side: "BUY",
      price: "0.35",
      shares: "50",
      filledAt: views.now,
      ...fill,
    };
    return this.take(staticBracketStrategy.onFill(context(this.config, this.state, views), payload as never));
  }

  update(views: ViewOptions, view: Partial<StrategyOrderView>): DecisionResult {
    const delivered = order(view);
    return this.take(
      staticBracketStrategy.onOrderUpdate(context(this.config, this.state, { orders: [delivered], ...views }), delivered),
    );
  }

  codes(): string[] {
    return this.log.flatMap((decision) => [...decision.reasonCodes]);
  }
}

const TP_VIEW = { orderId: "order-2", side: "SELL", price: "0.5" } as const;

/**
 * The verifiers' sequence: the 50-share entry fills 30 and its remainder RESTS
 * (GTD); the take-profit for those 30 is seen OPEN and fills whole.
 */
function takeProfitSellsTheFoldedPart(b: Bracket): DecisionResult {
  b.start({ now: at("12:00:01.000") });
  b.features({ now: at("12:00:02.000") });
  b.fill({ now: at("12:00:03.000"), yesShares: "30" }, { shares: "30", price: "0.34" });
  b.update({ now: at("12:00:03.000"), yesShares: "30" }, { ...TP_VIEW, requestedShares: "30", status: "OPEN" });
  return b.fill(
    { now: at("12:00:04.000"), yesShares: "0" },
    { orderId: "order-2", side: "SELL", price: "0.5", shares: "30" },
  );
}

function expectNeverPaused(b: Bracket): void {
  const codes = b.codes();
  expect(codes).not.toContain(ILLEGAL_TRANSITION);
  expect(codes).not.toContain(POSITION_MISMATCH);
  expect(codes).not.toContain(PAUSED);
  expect(codes).not.toContain(HALTED);
}

describe("C1-TIF-01 — a GTD entry's resting remainder keeps the bracket open", () => {
  it("the take-profit selling every FOLDED share does not certify CLOSED while the entry still rests", () => {
    const b = new Bracket(parsedParams(staticBracketParamsSchema, baseConfig()));
    const tp = takeProfitSellsTheFoldedPart(b);
    expect(b.state.entryOrder?.state).toBe("WORKING");
    expect(tp.reasonCodes).not.toContain(CLOSED);
    expect(tp.reasonCodes).toContain(ENTRY_ORDER_WORKING);
    expect(b.state.instanceState).not.toBe("CLOSED");
    // An evaluation in between waits too: it does not close over the rest.
    const between = b.features({ now: at("12:00:04.500"), yesShares: "0" });
    expect(between.reasonCodes).not.toContain(CLOSED);
    expect(between.reasonCodes).toContain(ENTRY_ORDER_WORKING);
    expect(b.state.instanceState).not.toBe("CLOSED");
  });

  it("the remainder's late fill FOLDS and is exited: a take-profit for the 20, and CLOSED only once it fills", () => {
    const b = new Bracket(parsedParams(staticBracketParamsSchema, baseConfig()));
    takeProfitSellsTheFoldedPart(b);
    const late = b.fill({ now: at("12:00:05.000"), yesShares: "20" }, { shares: "20", price: "0.34" });
    expect(late.reasonCodes).toContain(TAKE_PROFIT_INTENT);
    expect(`${b.state.allocatedShares} ${b.state.exitedShares}`).toBe("50 30");
    expect(b.state.exitOrder?.requestedShares).toBe("20");
    expect(b.state.instanceState).toBe("EXIT_PLANNED");
    b.update({ now: at("12:00:05.000"), yesShares: "20" }, { orderId: "order-3", side: "SELL", price: "0.5", requestedShares: "20", status: "OPEN" });
    const last = b.fill({ now: at("12:00:06.000"), yesShares: "0" }, { orderId: "order-3", side: "SELL", price: "0.5", shares: "20" });
    expect(last.reasonCodes).toContain(CLOSED);
    expect(b.state.instanceState).toBe("CLOSED");
    expect(`${b.state.allocatedShares} ${b.state.exitedShares}`).toBe("50 50");
    expectNeverPaused(b);
  });

  it("the remainder EXPIRES unfilled at its deadline: its terminal view clears the entry, and the next evaluation closes", () => {
    const b = new Bracket(parsedParams(staticBracketParamsSchema, baseConfig()));
    takeProfitSellsTheFoldedPart(b);
    b.update({ now: at("12:00:32.000"), yesShares: "0" }, { orderId: "order-1", status: "EXPIRED", filledShares: "30" });
    expect(b.state.entryOrder).toBeNull();
    const next = b.features({ now: at("12:00:33.000"), yesShares: "0" });
    expect(next.reasonCodes).toContain(CLOSED);
    expect(b.state.instanceState).toBe("CLOSED");
    expect(`${b.state.allocatedShares} ${b.state.exitedShares}`).toBe("30 30");
    expectNeverPaused(b);
  });

  it("a take-profit CANCELLED while the entry still rests does not fall back to OPEN: the remainder's fill folds", () => {
    const b = new Bracket(parsedParams(staticBracketParamsSchema, baseConfig()));
    b.start({ now: at("12:00:01.000") });
    b.features({ now: at("12:00:02.000") });
    b.fill({ now: at("12:00:03.000"), yesShares: "30" }, { shares: "30", price: "0.34" });
    b.update({ now: at("12:00:03.000"), yesShares: "30" }, { ...TP_VIEW, requestedShares: "30", status: "OPEN" });
    b.update({ now: at("12:00:04.000"), yesShares: "30" }, { ...TP_VIEW, requestedShares: "30", status: "CANCELED" });
    expect(b.state.entryOrder?.state).toBe("WORKING");
    expect(b.state.instanceState).not.toBe("OPEN");
    const late = b.fill({ now: at("12:00:05.000"), yesShares: "50" }, { shares: "20", price: "0.34" });
    expect(late.reasonCodes).not.toContain(ILLEGAL_TRANSITION);
    expect(b.state.allocatedShares).toBe("50");
    expectNeverPaused(b);
  });

  /** 30 of the 50 folded; the remainder is live (`entry`), and the bracket is in an exit state. */
  function partlyFilled(changes: Partial<StaticBracketState>): StaticBracketState {
    return stateWith({
      allocatedShares: "30",
      allocatedCost: "10.2",
      legOutcome: "YES",
      entriesExecuted: 1,
      openedAtMs: ms("12:14:00.000"),
      entryOrder: orderTrack({ filledShares: "30", viewFilledShares: "30", placedAtMs: ms("12:14:00.000") }),
      ...changes,
    });
  }

  it("a CANCEL_PENDING entry is still live: the take-profit selling the folded 30 does not close over it", () => {
    // The cancel races the remainder's fill (a final policy withdrew it), so
    // the remainder can still fill until the cancel is confirmed.
    const b = new Bracket(
      parsedParams(staticBracketParamsSchema, baseConfig()),
      partlyFilled({
        instanceState: "EXIT_WORKING",
        entryOrder: orderTrack({ state: "CANCEL_PENDING", filledShares: "30", viewFilledShares: "30" }),
        exitOrder: orderTrack({
          kind: "EXIT",
          intentId: `${EXIT_ROLE_PREFIXES.TAKE_PROFIT}1-${MARKET_ID}`,
          orderId: "order-2",
          side: "SELL",
          limitPrice: "0.5",
          requestedShares: "30",
        }),
      }),
    );
    const tp = b.fill({ now: at("12:00:04.000"), yesShares: "0" }, { orderId: "order-2", side: "SELL", price: "0.5", shares: "30" });
    expect(tp.reasonCodes).not.toContain(CLOSED);
    expect(b.state.instanceState).not.toBe("CLOSED");
    const late = b.fill({ now: at("12:00:05.000"), yesShares: "20" }, { shares: "20", price: "0.34" });
    expect(late.reasonCodes).not.toContain(ILLEGAL_TRANSITION);
    expect(`${b.state.allocatedShares} ${b.state.exitedShares}`).toBe("50 30");
    expectNeverPaused(b);
  });

  it("a protective reduction retired by its expired intent does not fall back to OPEN over a live entry", () => {
    // CANCEL_ONLY at the exit cutoff withdraws the entry, and the remainder's
    // fill can still beat the cancel: from OPEN it was refused as illegal.
    const b = new Bracket(
      parsedParams(staticBracketParamsSchema, configWith({ "exit.final_policy": "CANCEL_ONLY" })),
      partlyFilled({
        instanceState: "EXIT_PLANNED",
        exitOrder: orderTrack({
          kind: "EXIT",
          intentId: `${EXIT_ROLE_PREFIXES.PROTECTED_REDUCE}1-${MARKET_ID}`,
          orderId: null,
          state: "PENDING",
          side: "SELL",
          limitPrice: "0.26",
          requestedShares: "30",
          placedAtMs: ms("12:14:00.000"),
        }),
      }),
    );
    // 50 s after it was placed (validity 30 s), 10 s before the close.
    const retired = b.features({ now: at("12:14:50.000"), yesShares: "30" });
    expect(retired.reasonCodes).toContain(EXIT_INTENT_EXPIRED);
    expect(b.state.entryOrder?.state).toBe("CANCEL_PENDING");
    expect(b.state.instanceState).toBe("EXIT_PLANNED");
    const late = b.fill({ now: at("12:14:51.000"), yesShares: "50" }, { shares: "20", price: "0.34" });
    expect(late.reasonCodes).not.toContain(ILLEGAL_TRANSITION);
    expect(b.state.allocatedShares).toBe("50");
    expectNeverPaused(b);
  });
});
