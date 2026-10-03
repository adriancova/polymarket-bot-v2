/**
 * `CADENCE-1` — the evaluation cadence's pure parts (ADR-026 D1, D2): the
 * policy every composition root and the core loop apply, and the clock the
 * loop drives. The loop-level behaviour is `loop-cadence.test.ts`'s.
 */

import { describe, expect, it } from "vitest";

import {
  EVALUATION_HEARTBEAT_MS,
  EVALUATION_INTERVAL_MS,
  EvaluationCadenceClock,
  FORWARD_JUMP_ALARM_FALLBACK_MS,
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  evaluationCadenceProblem,
} from "./cadence.js";

const T0 = Date.parse("2026-05-01T09:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

/** A clock at the PAPER cadence that has applied events at `offsets` (ms after T0). */
function paperClock(...offsets: number[]): EvaluationCadenceClock {
  const clock = new EvaluationCadenceClock(PAPER_EVALUATION_CADENCE);
  for (const offset of offsets) clock.observeApplied(T0 + offset, at(offset));
  return clock;
}

describe("ADR-026 D1.5-D1.6: the policy", () => {
  it("the defaults are exactly 1,000 ms and 5,000 ms, and the per-frame value is 0 and 0", () => {
    expect([EVALUATION_INTERVAL_MS, EVALUATION_HEARTBEAT_MS]).toEqual([1_000, 5_000]);
    expect(PAPER_EVALUATION_CADENCE).toEqual({ intervalMs: 1_000, heartbeatMs: 5_000 });
    expect(PER_FRAME_EVALUATION_CADENCE).toEqual({ intervalMs: 0, heartbeatMs: 0 });
    expect(Object.isFrozen(PAPER_EVALUATION_CADENCE)).toBe(true);
    expect(FORWARD_JUMP_ALARM_FALLBACK_MS).toBe(5_000);
  });

  it("accepts 1,000 / 5,000, with or without a declared reproduction", () => {
    expect(evaluationCadenceProblem({ intervalMs: 1_000, heartbeatMs: 5_000 })).toBeUndefined();
    expect(evaluationCadenceProblem({ intervalMs: 1_000, heartbeatMs: 5_000, reproduces: "a-golden.json" })).toBeUndefined();
  });

  it("accepts 0 / 0 ONLY with a declared reproduction (D1.6)", () => {
    expect(evaluationCadenceProblem({ intervalMs: 0, heartbeatMs: 0, reproduces: "test/replay-golden/x.json" })).toBeUndefined();
    const undeclared = evaluationCadenceProblem({ intervalMs: 0, heartbeatMs: 0 });
    expect(undeclared).toContain("accepted only by a replay that declares");
  });

  it.each([
    [999, 5_000],
    [1_001, 5_000],
    [1_000, 4_999],
    [1_000, 5_001],
    [0, 5_000],
    [1_000, 0],
    [2_000, 10_000],
    [500, 2_500],
    [-1_000, 5_000],
    [1_000.5, 5_000],
    [Number.NaN, 5_000],
    [Number.POSITIVE_INFINITY, 5_000],
  ])("refuses %s / %s, declared reproduction or not: other values need a new ruling (D1.5)", (intervalMs, heartbeatMs) => {
    expect(evaluationCadenceProblem({ intervalMs, heartbeatMs })).toContain("refused");
    expect(evaluationCadenceProblem({ intervalMs, heartbeatMs, reproduces: "a-golden.json" })).toContain("refused");
  });

  it("refuses a shape that is not the two numbers: strings, missing fields, a non-record", () => {
    expect(evaluationCadenceProblem({ intervalMs: "1000", heartbeatMs: "5000" })).toContain("refused");
    expect(evaluationCadenceProblem({ intervalMs: 1_000 })).toContain("(absent)");
    expect(evaluationCadenceProblem({})).toContain("refused");
    expect(evaluationCadenceProblem(null)).toContain("must be a record");
    expect(evaluationCadenceProblem(1_000)).toContain("must be a record");
    // Inherited values are not the record's own: a prototype cannot supply the cadence.
    const inherited = Object.create({ intervalMs: 1_000, heartbeatMs: 5_000 }) as object;
    expect(evaluationCadenceProblem(inherited)).toContain("refused");
  });

  it("refuses a reproduction label that would not print as one key=value field", () => {
    for (const reproduces of ["", " ", "a b", "line\nbreak", "tab\there", "é", "x".repeat(257), 7, null]) {
      expect(
        evaluationCadenceProblem({ intervalMs: 0, heartbeatMs: 0, reproduces }),
        JSON.stringify(reproduces),
      ).toContain("reproduces must name");
    }
    expect(evaluationCadenceProblem({ intervalMs: 0, heartbeatMs: 0, reproduces: "x".repeat(256) })).toBeUndefined();
  });
});

describe("ADR-026 D2.1, D2.8: the clock is the high-water mark of applied instants", () => {
  it("moves forward with later instants and never backwards", () => {
    const clock = paperClock(0, 1_500, 700, 1_499, 2_000);
    expect(clock.now).toBe(T0 + 2_000);
    expect(paperClock(3_000, 1_000).now).toBe(T0 + 3_000);
    expect(new EvaluationCadenceClock(PAPER_EVALUATION_CADENCE).now).toBeUndefined();
  });
});

describe("ADR-026 D2.4-D2.7: rule 4, per market, at t = now", () => {
  it("an owed market with no last is due; one that is NOT owed gets no heartbeat until its first evaluation", () => {
    const clock = paperClock(0);
    expect(clock.due("A", true)).toBe(true);
    expect(clock.due("A", false)).toBe(false);
    clock.observeApplied(T0 + 60_000, at(60_000));
    expect(clock.due("A", false)).toBe(false);
  });

  it("owed: due exactly from t − last = intervalMs (999 no, 1,000 yes)", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 999, at(999));
    expect(clock.due("A", true)).toBe(false);
    clock.observeApplied(T0 + 1_000, at(1_000));
    expect(clock.due("A", true)).toBe(true);
  });

  it("not owed: due exactly from t − last = heartbeatMs (4,999 no, 5,000 yes)", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 4_999, at(4_999));
    expect(clock.due("A", false)).toBe(false);
    expect(clock.due("A", true)).toBe(true);
    clock.observeApplied(T0 + 5_000, at(5_000));
    expect(clock.due("A", false)).toBe(true);
  });

  it("markEvaluated sets last to t and clears the market's carried debt; carry keeps it owed", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 300, at(300));
    expect(clock.due("A", true)).toBe(false);
    clock.carry("A");
    expect(clock.isCarried("A")).toBe(true);
    expect(clock.carriedCount()).toBe(1);
    clock.observeApplied(T0 + 1_300, at(1_300));
    expect(clock.due("A", clock.isCarried("A"))).toBe(true);
    clock.markEvaluated("A");
    expect(clock.isCarried("A")).toBe(false);
    // last is now 1,300: a market evaluated at a close is not due again at it.
    expect(clock.due("A", true)).toBe(false);
  });

  it("D2.11: a halted market's owed evaluation is dropped, its last kept", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.carry("A");
    clock.dropOwed("A");
    expect(clock.isCarried("A")).toBe(false);
    clock.observeApplied(T0 + 999, at(999));
    expect(clock.due("A", true)).toBe(false);
  });

  it("markets are independent", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 400, at(400));
    expect(clock.due("B", true)).toBe(true);
    clock.markEvaluated("B");
    clock.observeApplied(T0 + 1_000, at(1_000));
    expect(clock.due("A", true)).toBe(true);
    expect(clock.due("B", true)).toBe(false);
  });
});

describe("ADR-026 D2.8: a backward step neither adds an evaluation nor stops one", () => {
  it("a stamp behind now leaves t unchanged: no evaluation it adds, and the next one comes when now has moved on", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 1_200, at(1_200));
    expect(clock.due("A", true)).toBe(true);
    clock.markEvaluated("A");
    // Back by 1,100 ms: measured from its OWN instant it would look 1,100 ms
    // after the last evaluation's event; measured on `now` it is 0.
    clock.observeApplied(T0 + 100, at(100));
    expect(clock.now).toBe(T0 + 1_200);
    expect(clock.due("A", true)).toBe(false);
    clock.observeApplied(T0 + 2_199, at(2_199));
    expect(clock.due("A", true)).toBe(false);
    clock.observeApplied(T0 + 2_200, at(2_200));
    expect(clock.due("A", true)).toBe(true);
  });
});

describe("ADR-026 D2.10: the forward-jump alarm", () => {
  it("counts every applied event lying MORE than heartbeatMs behind now; one RAISED and one CLEARED per episode", () => {
    const clock = paperClock(0);
    expect(clock.alarmBoundMs).toBe(5_000);
    const jump = clock.observeApplied(T0 + 3_600_000, at(3_600_000));
    expect(jump).toEqual({ alarmed: false, transition: undefined });
    const first = clock.observeApplied(T0 + 1_000, at(1_000));
    expect(first.alarmed).toBe(true);
    expect(first.transition).toEqual({
      kind: "RAISED",
      eventAt: at(1_000),
      clockAt: at(3_600_000),
      behindMs: 3_599_000,
      boundMs: 5_000,
    });
    const second = clock.observeApplied(T0 + 2_000, at(2_000));
    expect(second).toEqual({ alarmed: true, transition: undefined });
    // Exactly the bound behind is not "more than" the bound: the episode ends.
    const caught = clock.observeApplied(T0 + 3_595_000, at(3_595_000));
    expect(caught.alarmed).toBe(false);
    expect(caught.transition?.kind).toBe("CLEARED");
    expect(caught.transition?.behindMs).toBe(5_000);
    expect(clock.observeApplied(T0 + 3_595_000, at(3_595_000))).toEqual({ alarmed: false, transition: undefined });
    // 5,001 ms behind: a new episode.
    expect(clock.observeApplied(T0 + 3_594_999, at(3_594_999)).transition?.kind).toBe("RAISED");
  });

  it("the hold: after the jump no market is due — owed or by heartbeat — until now has moved on by the interval", () => {
    const clock = paperClock(0);
    clock.markEvaluated("A");
    clock.observeApplied(T0 + 3_600_000, at(3_600_000));
    expect(clock.due("A", true)).toBe(true);
    clock.markEvaluated("A");
    for (let offset = 1_000; offset <= 60_000; offset += 1_000) {
      clock.observeApplied(T0 + offset, at(offset));
      expect(clock.due("A", true), String(offset)).toBe(false);
      expect(clock.due("A", false), String(offset)).toBe(false);
    }
    clock.observeApplied(T0 + 3_600_999, at(3_600_999));
    expect(clock.due("A", true)).toBe(false);
    clock.observeApplied(T0 + 3_601_000, at(3_601_000));
    expect(clock.due("A", true)).toBe(true);
  });

  it("with the heartbeat off (the per-frame value) the bound is 5,000 ms", () => {
    const clock = new EvaluationCadenceClock(PER_FRAME_EVALUATION_CADENCE);
    expect(clock.alarmBoundMs).toBe(FORWARD_JUMP_ALARM_FALLBACK_MS);
    clock.observeApplied(T0 + 10_000, at(10_000));
    expect(clock.observeApplied(T0 + 5_000, at(5_000)).alarmed).toBe(false);
    expect(clock.observeApplied(T0 + 4_999, at(4_999)).alarmed).toBe(true);
  });
});

describe("ADR-026 D1.6: the per-frame value 0 is ADR-024's cadence", () => {
  it("every owed market is due, nothing is carried, there is no heartbeat", () => {
    const clock = new EvaluationCadenceClock(PER_FRAME_EVALUATION_CADENCE);
    expect(clock.perFrame).toBe(true);
    clock.observeApplied(T0, at(0));
    for (let offset = 0; offset < 20_000; offset += 1) {
      if (offset % 997 !== 0) continue;
      clock.observeApplied(T0 + offset, at(offset));
      expect(clock.due("A", true)).toBe(true);
      expect(clock.due("A", false)).toBe(false);
      clock.markEvaluated("A");
      clock.carry("A");
      expect(clock.isCarried("A")).toBe(false);
    }
    expect(new EvaluationCadenceClock(PAPER_EVALUATION_CADENCE).perFrame).toBe(false);
  });
});
