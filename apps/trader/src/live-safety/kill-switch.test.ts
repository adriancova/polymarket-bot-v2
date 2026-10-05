/**
 * WP-320 kill-switch enforcement (§14.1; ADR-008 §8; ADR-033 D1 item 3):
 * the fold of the durable rows, what each switch does to this process, and
 * the monitor's fail-closed read.
 */

import { describe, expect, it } from "vitest";

import { engageRow, FakeKillSwitchReader, ManualClock, releaseRow } from "./fakes.test-support.js";
import { foldKillSwitchRows, KILL_SWITCH_ACTIONS, killSwitchEffects, KillSwitchMonitor } from "./kill-switch.js";

const ACCOUNT = "acct-1";
const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";

function effectsOf(rows: readonly unknown[]): ReturnType<typeof killSwitchEffects> {
  return killSwitchEffects(foldKillSwitchRows(rows), ACCOUNT);
}

describe("ADR-033 D1 item 3: which switches stop the heartbeat", () => {
  for (const action of KILL_SWITCH_ACTIONS) {
    const stops = action === "FULL_HALT" || action === "CANCEL_ALL" || action === "CANCEL_MARKET";
    it(`a GLOBAL ${action} ${stops ? "STOPS" : "does not stop"} the heartbeat, and blocks every new entry`, () => {
      const effects = effectsOf([engageRow({ id: "e1", scope: "GLOBAL", scopeRef: null, action })]);
      expect(effects.stopsHeartbeat).toBe(stops);
      expect(effects.blocksAllEntries).toBe(true);
      expect(effects.blocksAllSubmissions).toBe(stops);
    });

    it(`an ACCOUNT ${action} on THIS account acts as GLOBAL does; on another account it does nothing`, () => {
      const own = effectsOf([engageRow({ id: "e1", scope: "ACCOUNT", scopeRef: ACCOUNT, action })]);
      expect(own.stopsHeartbeat).toBe(stops);
      expect(own.blocksAllEntries).toBe(true);
      const other = effectsOf([engageRow({ id: "e1", scope: "ACCOUNT", scopeRef: "acct-2", action })]);
      expect(other.stopsHeartbeat).toBe(false);
      expect(other.blocksAllEntries).toBe(false);
    });

    it(`a MARKET or STRATEGY_INSTANCE ${action} NEVER stops the heartbeat, and blocks entries in its scope only`, () => {
      const effects = effectsOf([
        engageRow({ id: "m1", scope: "MARKET", scopeRef: MARKET, action }),
        engageRow({ id: "i1", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action }),
      ]);
      expect(effects.stopsHeartbeat).toBe(false);
      expect(effects.blocksAllEntries).toBe(false);
      expect(effects.blocksAllSubmissions).toBe(false);
      expect([...effects.entryBlockedMarkets]).toEqual([MARKET]);
      expect([...effects.entryBlockedInstances]).toEqual([INSTANCE]);
      expect(effects.submissionBlockedMarkets.has(MARKET)).toBe(stops);
    });
  }

  it("asks for cancels: the account for an account-ending switch, the market or instance for a scope-ending one", () => {
    const effects = effectsOf([
      engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "CANCEL_ALL" }),
      engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "CANCEL_MARKET" }),
      engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" }),
      engageRow({ id: "h", scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" }),
    ]);
    expect(effects.cancels).toEqual([
      { directive: { scope: "ACCOUNT" }, killSwitchEventId: "g" },
      { directive: { scope: "MARKET", marketId: MARKET }, killSwitchEventId: "m" },
      { directive: { scope: "STRATEGY_INSTANCE", instanceId: INSTANCE }, killSwitchEventId: "i" },
    ]);
  });
});

describe("the fold fails closed", () => {
  it("a release row is not engaged", () => {
    expect(foldKillSwitchRows([releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })])).toEqual([]);
  });

  it("when the two orderings disagree (one shows the engage, one the release), the switch is engaged", () => {
    const effects = effectsOf([
      releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }),
      engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }),
    ]);
    expect(effects.stopsHeartbeat).toBe(true);
  });

  it("another environment's release never releases this environment's engage", () => {
    const effects = effectsOf([
      engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", environment: "LIVE" }),
      releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", environment: "PAPER" }),
    ]);
    expect(effects.stopsHeartbeat).toBe(true);
  });

  it("a switch engaged in ANY environment's control plane is honoured", () => {
    expect(effectsOf([engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", environment: "PAPER" })]).stopsHeartbeat).toBe(true);
  });

  for (const [name, row] of [
    ["an unreadable resulting state", { ...engageRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), resultingState: "garbled" }],
    ["an engaged flag that is not the string", { ...engageRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), resultingState: { engaged: true, scope: "MARKET" } }],
    ["an unknown action", engageRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "PAUSE_A_BIT" })],
    ["a state whose action is not the row's", { ...engageRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), action: "CANCEL_MARKET" }],
    ["a state whose scope is not the row's", { ...releaseRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" }), scope: "GLOBAL", scopeRef: null }],
  ] as const) {
    it(`${name} is a FULL_HALT at the row's scope`, () => {
      const engaged = foldKillSwitchRows([row]);
      expect(engaged).toHaveLength(1);
      expect(engaged[0]).toMatchObject({ action: "FULL_HALT", unreadable: true });
    });
  }

  it("an unreadable scope is a GLOBAL FULL_HALT: it stops the heartbeat", () => {
    const effects = effectsOf([{ ...engageRow({ id: "x", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), scope: "SOMEWHERE" }]);
    expect(effects.stopsHeartbeat).toBe(true);
    expect(effectsOf([null, 7, "row"]).stopsHeartbeat).toBe(true);
  });
});

describe("the monitor: the latest read decides, and a failed read is unknown state", () => {
  it("never read, read, failed: unknown, known, unknown again", async () => {
    const clock = new ManualClock();
    const reader = new FakeKillSwitchReader();
    const monitor = new KillSwitchMonitor({ reader, clock, accountRef: ACCOUNT });
    expect(monitor.snapshot()).toEqual({ known: false, reason: "NEVER_READ" });
    expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "NEVER_READ" });
    expect(await monitor.refresh()).toBe(true);
    expect(monitor.snapshot()).toMatchObject({ known: true, readStartedAtMs: clock.now });
    expect(monitor.proofSource().read()).toEqual({ healthy: true, provenAtMs: clock.now });
    reader.failing = true;
    expect(await monitor.refresh()).toBe(false);
    expect(monitor.snapshot()).toEqual({ known: false, reason: "READ_FAILED" });
    expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "READ_FAILED" });
  });

  it("the KILL_SWITCH health input fails while an account-ending switch is engaged, and holds for a MARKET switch", async () => {
    const clock = new ManualClock();
    const reader = new FakeKillSwitchReader();
    const monitor = new KillSwitchMonitor({ reader, clock, accountRef: ACCOUNT });
    reader.rows = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })];
    await monitor.refresh();
    expect(monitor.proofSource().read().healthy).toBe(true);
    reader.rows.push(engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }));
    await monitor.refresh();
    expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "ENGAGED_STOPS_HEARTBEAT" });
  });

  it("a hung read is abandoned after abandonAfterMs: unknown at once, a new read starts, and the old answer is discarded when it lands", async () => {
    const clock = new ManualClock();
    const answers: ((rows: readonly unknown[]) => void)[] = [];
    let reads = 0;
    const reader = {
      read: (): Promise<readonly never[]> => {
        reads += 1;
        return new Promise((resolve) => {
          answers.push((rows) => {
            resolve(rows as readonly never[]);
          });
        });
      },
    };
    const monitor = new KillSwitchMonitor({ reader, clock, accountRef: ACCOUNT, abandonAfterMs: 1_000 });
    const first = monitor.refresh();
    await clock.advance(999);
    void monitor.refresh();
    expect(reads).toBe(1);
    await clock.advance(1);
    const second = monitor.refresh();
    expect(reads).toBe(2);
    expect(monitor.snapshot()).toEqual({ known: false, reason: "READ_TIMED_OUT" });
    // The new read answers "released"; then the abandoned one lands with an engaged switch: it is discarded.
    answers[1]?.([]);
    expect(await second).toBe(true);
    answers[0]?.([engageRow({ id: "old", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })]);
    expect(await first).toBe(false);
    expect(monitor.snapshot()).toMatchObject({ known: true });
    expect(monitor.proofSource().read().healthy).toBe(true);
  });

  it("one read at a time: a refresh during a read joins it", async () => {
    const reader = new FakeKillSwitchReader();
    const monitor = new KillSwitchMonitor({ reader, clock: new ManualClock(), accountRef: ACCOUNT });
    await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
    expect(reader.reads).toBe(1);
  });
});
