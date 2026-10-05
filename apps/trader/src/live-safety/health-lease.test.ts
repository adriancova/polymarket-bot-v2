/**
 * WP-320 / handoff §9.18 / ADR-008 §3: the heartbeat health lease requires
 * RECENT proof from all seven inputs, asks every one at every evaluation, and
 * caches nothing: a proof recorded once ages out.
 */

import { describe, expect, it } from "vitest";

import { ManualClock } from "./fakes.test-support.js";
import { EventLoopProbe, HEALTH_INPUTS, HealthLease, HealthLeaseConfigurationError, ProofBoard, type HealthInput, type HealthProofSource } from "./health-lease.js";

const MAX_AGE: Record<HealthInput, number> = {
  MARKET_DATA: 3_000,
  USER_DATA: 15_000,
  EVENT_LOOP: 2_000,
  OMS: 1_000,
  DATABASE: 4_000,
  RECONCILER: 30_000,
  KILL_SWITCH: 3_000,
};

function provedLease(): { clock: ManualClock; board: ProofBoard; lease: HealthLease } {
  const clock = new ManualClock();
  const board = new ProofBoard();
  const sources = Object.fromEntries(HEALTH_INPUTS.map((input) => [input, board.source(input)])) as Record<HealthInput, HealthProofSource>;
  const lease = new HealthLease({ clock, sources, maxAgeMs: MAX_AGE });
  for (const input of HEALTH_INPUTS) board.prove(input, clock.now);
  return { clock, board, lease };
}

describe("the seven inputs of §9.18 are all required", () => {
  it("names exactly market data, user data, event loop, OMS, database, reconciler and kill-switch state", () => {
    expect([...HEALTH_INPUTS]).toEqual(["MARKET_DATA", "USER_DATA", "EVENT_LOOP", "OMS", "DATABASE", "RECONCILER", "KILL_SWITCH"]);
  });

  for (const missing of HEALTH_INPUTS) {
    it(`refuses a lease without ${missing}`, () => {
      const board = new ProofBoard();
      const sources: Partial<Record<HealthInput, HealthProofSource>> = Object.fromEntries(HEALTH_INPUTS.map((input) => [input, board.source(input)]));
      delete sources[missing];
      expect(() => new HealthLease({ clock: new ManualClock(), sources: sources as Record<HealthInput, HealthProofSource>, maxAgeMs: MAX_AGE })).toThrow(
        HealthLeaseConfigurationError,
      );
    });
  }

  it("refuses an input it does not know, and a bound outside 1 ms … 60 s", () => {
    const board = new ProofBoard();
    const sources = Object.fromEntries(HEALTH_INPUTS.map((input) => [input, board.source(input)])) as Record<HealthInput, HealthProofSource>;
    expect(() => new HealthLease({ clock: new ManualClock(), sources: { ...sources, REDIS: board.source("OMS") } as never, maxAgeMs: MAX_AGE })).toThrow(HealthLeaseConfigurationError);
    expect(() => new HealthLease({ clock: new ManualClock(), sources, maxAgeMs: { ...MAX_AGE, OMS: 0 } })).toThrow(HealthLeaseConfigurationError);
    expect(() => new HealthLease({ clock: new ManualClock(), sources, maxAgeMs: { ...MAX_AGE, RECONCILER: 60_001 } })).toThrow(HealthLeaseConfigurationError);
  });

  it("is healthy only when every input proves itself", () => {
    const { lease } = provedLease();
    expect(lease.evaluate()).toMatchObject({ healthy: true, failures: [] });
  });

  for (const input of HEALTH_INPUTS) {
    it(`fails, naming ${input}, when ${input} alone reports a failure`, () => {
      const { board, lease } = provedLease();
      board.fail(input, "SUBSYSTEM_DOWN");
      const verdict = lease.evaluate();
      expect(verdict.healthy).toBe(false);
      expect(verdict.failures).toEqual([{ input, reason: "SUBSYSTEM_DOWN" }]);
      expect(verdict.reasons).toEqual([`HEALTH_${input}_SUBSYSTEM_DOWN`]);
    });
  }
});

describe("proof is RECENT proof: nothing is cached forever", () => {
  for (const input of HEALTH_INPUTS) {
    it(`a ${input} proof recorded once fails the lease once it is older than ${String(MAX_AGE[input])} ms`, async () => {
      const { clock, board, lease } = provedLease();
      const others = HEALTH_INPUTS.filter((other) => other !== input);
      await clock.advance(MAX_AGE[input]);
      for (const other of others) board.prove(other, clock.now);
      expect(lease.evaluate().healthy).toBe(true);
      await clock.advance(1);
      for (const other of others) board.prove(other, clock.now);
      expect(lease.evaluate().failures).toEqual([{ input, reason: "PROOF_STALE" }]);
    });
  }

  it("a proof from the future fails (the source's clock is not the lease's)", () => {
    const { clock, board, lease } = provedLease();
    board.prove("DATABASE", clock.now + 1);
    expect(lease.evaluate().failures).toEqual([{ input: "DATABASE", reason: "PROOF_IN_FUTURE" }]);
  });

  it("an input never proved reads NO_PROOF", () => {
    const clock = new ManualClock();
    const board = new ProofBoard();
    const sources = Object.fromEntries(HEALTH_INPUTS.map((input) => [input, board.source(input)])) as Record<HealthInput, HealthProofSource>;
    const verdict = new HealthLease({ clock, sources, maxAgeMs: MAX_AGE }).evaluate();
    expect(verdict.failures.map((failure) => failure.reason)).toEqual(HEALTH_INPUTS.map(() => "NO_PROOF"));
  });

  it("a late, older proof does not replace a newer one; a failure replaces any proof", () => {
    const board = new ProofBoard();
    board.prove("OMS", 100);
    board.prove("OMS", 50);
    expect(board.source("OMS").read()).toEqual({ healthy: true, provenAtMs: 100 });
    board.fail("OMS", "FAULTED");
    expect(board.source("OMS").read()).toEqual({ healthy: false, reason: "FAULTED" });
  });

  it("a source that throws, or answers outside the two shapes, fails", () => {
    const clock = new ManualClock();
    const board = new ProofBoard();
    for (const input of HEALTH_INPUTS) board.prove(input, clock.now);
    const sources = Object.fromEntries(HEALTH_INPUTS.map((input) => [input, board.source(input)])) as Record<HealthInput, HealthProofSource>;
    const odd = (read: () => unknown): HealthProofSource => ({ read: read as HealthProofSource["read"] });
    const cases: [HealthInput, HealthProofSource, string][] = [
      [
        "OMS",
        odd(() => {
          throw new Error("x");
        }),
        "SOURCE_THREW",
      ],
      ["USER_DATA", odd(() => ({ healthy: "true", provenAtMs: clock.now })), "UNREADABLE"],
      ["MARKET_DATA", odd(() => ({ healthy: true, provenAtMs: Number.NaN })), "UNREADABLE"],
      ["EVENT_LOOP", odd(() => Object.defineProperty({ provenAtMs: clock.now }, "healthy", { get: () => true })), "UNREADABLE"],
      ["RECONCILER", odd(() => true), "UNREADABLE"],
      ["DATABASE", odd(() => ({ healthy: false, reason: "lower case" })), "UNHEALTHY"],
    ];
    for (const [input, source, reason] of cases) {
      const verdict = new HealthLease({ clock, sources: { ...sources, [input]: source }, maxAgeMs: MAX_AGE }).evaluate();
      expect(verdict.failures).toEqual([{ input, reason }]);
    }
  });
});

describe("the event-loop input", () => {
  it("proves the loop each time its timer fires on time; stop() clears its timer", async () => {
    const clock = new ManualClock();
    const board = new ProofBoard();
    const probe = new EventLoopProbe({ board, clock, timers: clock, intervalMs: 500, maxLagMs: 200 });
    probe.start();
    await clock.advance(500);
    expect(board.source("EVENT_LOOP").read()).toEqual({ healthy: true, provenAtMs: clock.now });
    await clock.advance(500);
    expect(board.source("EVENT_LOOP").read()).toEqual({ healthy: true, provenAtMs: clock.now });
    expect(clock.pendingTimers()).toBe(1);
    probe.stop();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("a loop that stalls past the bound fails EVENT_LOOP (LOOP_LAGGING)", async () => {
    const clock = new ManualClock();
    const board = new ProofBoard();
    let skew = 0;
    const skewed = { monotonicMs: () => clock.monotonicMs() + skew };
    const probe = new EventLoopProbe({ board, clock: skewed, timers: clock, intervalMs: 500, maxLagMs: 200 });
    probe.start();
    // The timer is due at +500 by the probe's reading; when it fires the probe reads +500 + 300.
    skew = 300;
    await clock.advance(500);
    expect(board.source("EVENT_LOOP").read()).toEqual({ healthy: false, reason: "LOOP_LAGGING" });
    probe.stop();
  });
});
