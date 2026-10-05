/**
 * WP-320 kill-switch enforcement (§14.1; ADR-008 §8; ADR-033 D1 item 3):
 * the fold of the durable rows, what each switch does to this process, and
 * the monitor's fail-closed read.
 */

import { describe, expect, it } from "vitest";

import { engageRow, FakeKillSwitchReader, FakeReleaseFinality, ManualClock, releaseRow } from "./fakes.test-support.js";
import { foldKillSwitchRows, KILL_SWITCH_ACTIONS, killSwitchEffects, KillSwitchMonitor } from "./kill-switch.js";

const ACCOUNT = "acct-1";
const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";

/** Every release settled (the monitor's window passed): the fold alone. */
const SETTLED = (): boolean => true;
const UNSETTLED = (): boolean => false;
/** Every release positively final (the composition holds evidence the control plane applied it), or none (r2 X2). */
const FINAL = (): boolean => true;
const NOT_FINAL = (): boolean => false;
const SETTLE = 2_000;

function effectsOf(rows: readonly unknown[]): ReturnType<typeof killSwitchEffects> {
  return killSwitchEffects(foldKillSwitchRows(rows, SETTLED, FINAL), ACCOUNT);
}

/** A monitor whose releases are all final unless the test says otherwise (`finality.all = false`). */
function monitorOf(options: { readonly reader: ConstructorParameters<typeof KillSwitchMonitor>[0]["reader"]; readonly clock: ManualClock; readonly abandonAfterMs?: number; readonly finality?: FakeReleaseFinality }): KillSwitchMonitor {
  return new KillSwitchMonitor({
    reader: options.reader,
    clock: options.clock,
    accountRef: ACCOUNT,
    releaseSettleMs: SETTLE,
    releaseFinality: options.finality ?? new FakeReleaseFinality(),
    ...(options.abandonAfterMs === undefined ? {} : { abandonAfterMs: options.abandonAfterMs }),
  });
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
  it("a SETTLED, unvoided release row is not engaged", () => {
    expect(foldKillSwitchRows([releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })], SETTLED, FINAL)).toEqual([]);
  });

  it("r1 I6: a release a VOID names is still the switch it released, engaged in full: heartbeat stopped, cancels requested", () => {
    const engaged = foldKillSwitchRows([releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", voided: true })], SETTLED, FINAL);
    expect(engaged).toEqual([{ environment: "LIVE_MICRO", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", killSwitchEventId: "r", unreadable: false, release: "VOIDED" }]);
    const effects = killSwitchEffects(engaged, ACCOUNT);
    expect(effects.stopsHeartbeat).toBe(true);
    expect(effects.cancels).toEqual([{ directive: { scope: "ACCOUNT" }, killSwitchEventId: "r" }]);
  });

  /**
   * r3, J3 (Opus R3-L2): at round 2 a PENDING release asked for no cancel, so the engage's cancel obligation lapsed for
   * up to `releaseSettleMs` while the scope's submissions stayed blocked. A release that is not final is now the
   * switch it releases IN FULL, cancels included, under its own event id.
   */
  it("r1 I6 / r3 J3: a release not yet SETTLED is still the switch it releases, in full: heartbeat stopped, entries and submissions blocked, and its cancels requested under the release's own event id", () => {
    const engaged = foldKillSwitchRows([releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })], UNSETTLED, FINAL);
    expect(engaged).toMatchObject([{ scope: "GLOBAL", action: "FULL_HALT", release: "PENDING", unreadable: false }]);
    const effects = killSwitchEffects(engaged, ACCOUNT);
    expect(effects.stopsHeartbeat).toBe(true);
    expect(effects.blocksAllSubmissions).toBe(true);
    // On f42019a: [] (no cancel while PENDING).
    expect(effects.cancels).toEqual([{ directive: { scope: "ACCOUNT" }, killSwitchEventId: "r" }]);
    for (const [scope, scopeRef, directive] of [
      ["MARKET", MARKET, { scope: "MARKET", marketId: MARKET }],
      ["STRATEGY_INSTANCE", INSTANCE, { scope: "STRATEGY_INSTANCE", instanceId: INSTANCE }],
    ] as const) {
      const scoped = killSwitchEffects(foldKillSwitchRows([releaseRow({ id: `p-${scope}`, scope, scopeRef, action: "FULL_HALT" })], UNSETTLED, FINAL), ACCOUNT);
      expect(scoped.cancels, scope).toEqual([{ directive, killSwitchEventId: `p-${scope}` }]);
      expect(scoped.stopsHeartbeat, scope).toBe(false);
    }
    const market = killSwitchEffects(foldKillSwitchRows([releaseRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" })], UNSETTLED, FINAL), ACCOUNT);
    expect([...market.entryBlockedMarkets]).toEqual([MARKET]);
    expect(market.stopsHeartbeat).toBe(false);
  });

  it("r1 I6: a release whose `voided` is anything but the boolean false counts as voided; an unreadable released action is a FULL_HALT", () => {
    for (const voided of [undefined, "false", 0, null]) {
      const row = { ...releaseRow({ id: "r", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), voided };
      expect(foldKillSwitchRows([row], SETTLED, FINAL)).toMatchObject([{ release: "VOIDED", action: "HALT_NEW_ENTRIES" }]);
    }
    const garbled = { ...releaseRow({ id: "r", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" }), action: "SOMETHING" };
    expect(foldKillSwitchRows([garbled], UNSETTLED, FINAL)).toMatchObject([{ action: "FULL_HALT", unreadable: true, release: "PENDING" }]);
  });

  it("a settle predicate that throws settles nothing", () => {
    const throwing = (): boolean => {
      throw new Error("x");
    };
    expect(foldKillSwitchRows([releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "CANCEL_ALL" })], throwing, FINAL)).toMatchObject([{ release: "PENDING" }]);
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
      const engaged = foldKillSwitchRows([row], SETTLED, FINAL);
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
    const monitor = monitorOf({ reader, clock });
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
    const monitor = monitorOf({ reader, clock });
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
    const monitor = monitorOf({ reader, clock, abandonAfterMs: 1_000 });
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
    const monitor = monitorOf({ reader, clock: new ManualClock() });
    await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
    expect(reader.reads).toBe(1);
  });

  it("refuses a settle window outside 1 ms … 1 h", () => {
    for (const releaseSettleMs of [0, -1, 1.5, 3_600_001, Number.NaN]) {
      expect(() => new KillSwitchMonitor({ reader: new FakeKillSwitchReader(), clock: new ManualClock(), accountRef: ACCOUNT, releaseSettleMs, releaseFinality: new FakeReleaseFinality() })).toThrow(TypeError);
    }
  });
});

describe("r1 I6: a release releases only once SETTLED (seen for the window) and not VOIDED", () => {
  async function released(): Promise<{ clock: ManualClock; reader: FakeKillSwitchReader; monitor: KillSwitchMonitor }> {
    const clock = new ManualClock();
    const reader = new FakeKillSwitchReader();
    const monitor = monitorOf({ reader, clock });
    reader.rows = [engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    return { clock, reader, monitor };
  }

  it("a release stays enforced as the switch until a read that STARTS the settle window after its first sight; then it releases", async () => {
    const { clock, reader, monitor } = await released();
    reader.rows = [releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    const firstSight = clock.now;
    expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "ENGAGED_STOPS_HEARTBEAT" });
    await clock.advance(SETTLE - 1);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true } });
    await clock.advance(1);
    expect(clock.now - firstSight).toBe(SETTLE);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: false, engaged: [] } });
  });

  it("the refused-and-voided release (control plane 503, its late row, then its VOID) never releases, however long it is seen", async () => {
    const { clock, reader, monitor } = await released();
    reader.rows = [releaseRow({ id: "late", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    await clock.advance(500);
    // The VOID lands within the window.
    reader.rows = [releaseRow({ id: "late", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", voided: true })];
    for (let step = 0; step < 10; step += 1) {
      await clock.advance(1_000);
      await monitor.refresh();
      expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "ENGAGED_STOPS_HEARTBEAT" });
    }
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { engaged: [{ release: "VOIDED", action: "FULL_HALT" }] } });
  });

  it("a release that stops being returned and is returned again restarts its window", async () => {
    const { clock, reader, monitor } = await released();
    reader.rows = [releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    await clock.advance(SETTLE);
    // Another switch's row replaces it as the latest (the release is no longer returned) …
    reader.rows = [engageRow({ id: "e2", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    // … and when it is returned again, its window starts again.
    reader.rows = [releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    await clock.advance(SETTLE - 1);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true } });
  });
});

/**
 * r2, X2 (HIGH). At round 1 a settled, unvoided release was honoured on elapsed time alone. The control plane's VOID
 * of a refused release is one best-effort append (no retry; refused when the ordinary audit tier is full; lost if the
 * control plane dies), so a release whose VOID is late or never lands was honoured while the control plane still
 * held the switch (both verifiers reproduced it on real PostgreSQL with GLOBAL FULL_HALT). A release now needs
 * POSITIVE finality from the injected port; without it the switch stays enforced in full, for as long as it is seen.
 */
describe("r2 X2: a release releases only with POSITIVE finality; no VOID, at any age, is not evidence", () => {
  it("a settled, unvoided release with no finality stays a GLOBAL FULL_HALT for as long as it is seen: heartbeat stopped, every submission blocked, cancels requested (UNCONFIRMED); it releases at the first read after the port confirms it", async () => {
    const clock = new ManualClock();
    const reader = new FakeKillSwitchReader();
    const finality = new FakeReleaseFinality();
    finality.all = false;
    const monitor = monitorOf({ reader, clock, finality });
    reader.rows = [engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    reader.rows = [releaseRow({ id: "late-release", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    for (let step = 0; step < 20; step += 1) {
      await clock.advance(SETTLE);
      expect(await monitor.refresh()).toBe(true);
      // On 21aee56 this read released the switch (engaged: [], stopsHeartbeat: false) from the first settled read on.
      expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true, blocksAllEntries: true, blocksAllSubmissions: true } });
      expect(monitor.proofSource().read()).toEqual({ healthy: false, reason: "ENGAGED_STOPS_HEARTBEAT" });
    }
    const snapshot = monitor.snapshot();
    expect(snapshot.known ? snapshot.effects.engaged : null).toEqual([
      { environment: "LIVE_MICRO", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", killSwitchEventId: "late-release", unreadable: false, release: "UNCONFIRMED" },
    ]);
    expect(snapshot.known ? snapshot.effects.cancels : null).toEqual([{ directive: { scope: "ACCOUNT" }, killSwitchEventId: "late-release" }]);
    expect(finality.asked).toContain("late-release");
    // The composition obtains positive evidence that the control plane applied THIS release: it releases.
    finality.confirmed.add("late-release");
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: false, engaged: [] } });
  });

  it("the port is asked only about a SETTLED, unvoided release; an answer that is not the boolean true, or a throw, is not final", () => {
    const row = releaseRow({ id: "r", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" });
    const asked: unknown[] = [];
    const recording = (release: unknown): boolean => {
      asked.push(release);
      return true;
    };
    expect(foldKillSwitchRows([row], UNSETTLED, recording)).toMatchObject([{ release: "PENDING" }]);
    expect(foldKillSwitchRows([{ ...row, voided: true }], SETTLED, recording)).toMatchObject([{ release: "VOIDED" }]);
    expect(asked).toEqual([]);
    expect(foldKillSwitchRows([row], SETTLED, recording)).toEqual([]);
    expect(asked).toEqual([{ killSwitchEventId: "r", environment: "LIVE_MICRO", scope: "MARKET", scopeRef: MARKET }]);
    for (const answer of [false, "true", 1, undefined, null]) {
      expect(foldKillSwitchRows([row], SETTLED, () => answer as never)).toMatchObject([{ release: "UNCONFIRMED", action: "FULL_HALT", scope: "MARKET" }]);
    }
    const throwing = (): boolean => {
      throw new Error("x");
    };
    expect(foldKillSwitchRows([row], SETTLED, throwing)).toMatchObject([{ release: "UNCONFIRMED" }]);
    const effects = killSwitchEffects(foldKillSwitchRows([row], SETTLED, NOT_FINAL), ACCOUNT);
    expect(effects.submissionBlockedMarkets.has(MARKET)).toBe(true);
    expect(effects.stopsHeartbeat).toBe(false);
    expect(effects.cancels).toEqual([{ directive: { scope: "MARKET", marketId: MARKET }, killSwitchEventId: "r" }]);
  });

  it("a monitor without a usable finality port is refused at construction", () => {
    for (const releaseFinality of [undefined, null, {}, { isFinal: "yes" }]) {
      expect(() => new KillSwitchMonitor({ reader: new FakeKillSwitchReader(), clock: new ManualClock(), accountRef: ACCOUNT, releaseSettleMs: SETTLE, releaseFinality: releaseFinality as never })).toThrow(TypeError);
    }
  });

  /**
   * r2 O2 (Opus R2-L2, mutant M12): the settle window is judged from the START of the read that judges the release,
   * never its completion. A read that started inside the window and completed after it carries a VOID check made
   * inside the window, so it must not settle the release.
   */
  it("r2 O2 (M12): a read that STARTED inside the window and COMPLETED after it does not settle the release", async () => {
    const clock = new ManualClock();
    let hold: (() => void) | null = null;
    let rows: readonly unknown[] = [engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    const reader = {
      read: async (): Promise<readonly never[]> => {
        if (hold !== null) {
          await new Promise<void>((resolve) => {
            hold = resolve;
          });
        }
        return rows as readonly never[];
      },
    };
    const monitor = monitorOf({ reader, clock });
    await monitor.refresh();
    rows = [releaseRow({ id: "r", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })];
    await monitor.refresh();
    // First sight now. The next read starts 500 ms before the window ends and completes 500 ms after it.
    await clock.advance(SETTLE - 500);
    hold = (): void => undefined;
    const slow = monitor.refresh();
    await clock.advance(1_000);
    (hold as () => void)();
    hold = null;
    expect(await slow).toBe(true);
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true, engaged: [{ killSwitchEventId: "r", release: "PENDING" }] } });
    // The next read, which STARTS after the window, settles it.
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: false, engaged: [] } });
  });
});
