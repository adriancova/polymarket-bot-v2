/**
 * `TRADER-SIGNALS` — the SEQUENCE a stop runs (`main.ts` `runUntilStopped`),
 * with injected fakes.
 *
 * The REAL `pump`, the REAL `recordHaltsBeforeExit`, the REAL
 * `HaltController` and the REAL `GracefulStop` (through recording ports, so a
 * test delivers a signal exactly where it wants one). Faked: the core loop
 * (its drain is gated, so a signal can land mid-drain), the feed, the store,
 * and the closeables, every one of which writes to one shared journal — so
 * each test asserts the ORDER of what happened, not merely that it happened.
 *
 * What is pinned:
 *
 * - a signal mid-drain, or mid-poll: the batch in hand is drained (durably)
 *   and its position recorded, and NO further batch is read; the pipelined
 *   path records the pending batch once its rows are durable;
 * - then the SHUTDOWN rebuild check, then the halt record (only when a halt
 *   is latched), then the closes in the reverse order of opening, then the
 *   exit code and its line;
 * - fail closed: a halt latched in the batch in hand, before the signal, or
 *   during the closes keeps the exit 75; a failed check is 70 whatever
 *   stopped the pump; a close that throws is logged and the rest still run;
 * - with no stop wired, the pump runs until a halt, as before.
 *
 * The signal plumbing and the forced exits are `graceful-stop.test.ts`; the
 * shipped bundle is `test/integration/paper-trader/graceful-stop-postgres-redis.test.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HaltController,
  parseTraderConfig,
  portFailed,
  portOk,
  type CoreLoop,
  type FeedMark,
  type IngestedEvent,
  type MarketEventFeed,
  type TraderConfig,
} from "@polymarket-bot/trading-core";
import { describe, expect, it } from "vitest";

import { installGracefulStop, type GracefulStop, type GracefulStopPorts, type StopSignal } from "./graceful-stop.js";
import type { HaltIncidentRow } from "./halt-record.js";
import { EXIT_CODES, exitCodeAfterStop, runUntilStopped, traderStoppedLine, type OpenedResources } from "./main.js";

const AT = "2026-03-04T12:00:01Z";

function exampleConfig(): TraderConfig {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const parsed = parseTraderConfig(
    JSON.parse(readFileSync(path.join(repoRoot, "infra/compose/trader/trader.config.example.json"), "utf8")) as unknown,
  );
  if (!parsed.ok) throw new Error(`the example configuration was refused: ${parsed.refusal.detail}`);
  return parsed.config;
}

/** A promise the test resolves by hand. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** A stand-in event: the fake loop reads only its name. */
function event(name: string): IngestedEvent {
  return { envelope: { eventId: name }, identity: {} } as unknown as IngestedEvent;
}

function nameOf(ingested: IngestedEvent): string {
  return (ingested.envelope as unknown as { eventId: string }).eventId;
}

interface FakeLoopOptions {
  readonly groupCommits?: boolean;
  /** Runs inside drain `index` (1-based), before it completes. */
  readonly onDrain?: (index: number) => Promise<void> | void;
  /** What `durabilityMark()` answers (pipelined path). */
  readonly durable?: () => Promise<boolean>;
  /** The SHUTDOWN check finds a mismatch (and latches its halt, as the real loop does). */
  readonly mismatch?: boolean;
}

/** The core loop's surface the pump and the stop use, journalled. */
function fakeLoop(journal: string[], halts: HaltController, options: FakeLoopOptions = {}): CoreLoop {
  let drains = 0;
  const loop = {
    groupCommits: options.groupCommits ?? false,
    ingest: (ingested: IngestedEvent): boolean => {
      journal.push(`ingest ${nameOf(ingested)}`);
      return true;
    },
    drain: async (drainOptions?: { readonly awaitDurable?: boolean }): Promise<void> => {
      drains += 1;
      const index = drains;
      journal.push(`drain ${String(index)} start`);
      await options.onDrain?.(index);
      journal.push(`drain ${String(index)} ${drainOptions?.awaitDurable === false ? "requested" : "durable"}`);
    },
    durabilityMark: (): Promise<boolean> => {
      journal.push("durability mark taken");
      return options.durable?.() ?? Promise.resolve(true);
    },
    health: () => ({ asOf: AT, halts: halts.records() }),
    bookRefusals: () => ({}),
    checkAccountingRebuild: (trigger: "SHUTDOWN" | "END_OF_RUN") => {
      journal.push(`rebuild check ${trigger}`);
      if (options.mismatch === true) {
        halts.halt({ kind: "GLOBAL" }, "ACCOUNTING_REBUILD_MISMATCH", "the held ledger view differs from its rebuild", AT);
        return { matched: false, pnlStreamsChecked: 0 };
      }
      return { matched: true, pnlStreamsChecked: 0 };
    },
  };
  return loop as unknown as CoreLoop;
}

interface FakeFeedOptions {
  /** The batches `poll` answers, in order; an empty batch (idle) after them. */
  readonly batches: readonly (readonly string[])[];
  /** Runs inside poll `index` (1-based), before it answers. */
  readonly onPoll?: (index: number) => Promise<void> | void;
  /** Poll `index` fails `UNAVAILABLE`. */
  readonly failAt?: number;
  /** The feed can mark positions (the pipelined path). */
  readonly marks?: boolean;
}

function fakeFeed(journal: string[], options: FakeFeedOptions): MarketEventFeed {
  let polls = 0;
  const names = new WeakMap<FeedMark, string>();
  const feed: MarketEventFeed = {
    poll: async () => {
      polls += 1;
      const index = polls;
      journal.push(`poll ${String(index)}`);
      await options.onPoll?.(index);
      if (options.failAt === index) return portFailed("UNAVAILABLE", "the stand-in transport stopped answering");
      return portOk((options.batches[index - 1] ?? []).map(event));
    },
    commit: async (upTo?: FeedMark) => {
      journal.push(upTo === undefined ? "commit" : `commit ${names.get(upTo) ?? "an unknown mark"}`);
      return portOk(null);
    },
    close: async () => {
      journal.push("close the event subscription");
    },
  };
  if (options.marks !== true) return feed;
  return {
    ...feed,
    mark: () => {
      const mark: FeedMark = Object.freeze({ feedMark: true });
      names.set(mark, `mark of poll ${String(polls)}`);
      return mark;
    },
  };
}

interface Harness {
  readonly journal: string[];
  readonly lines: string[];
  readonly halts: HaltController;
  readonly records: HaltIncidentRow[];
  readonly stop: GracefulStop;
  /** Delivers a signal to the stop's installed listener, as the process would. */
  readonly signal: (signal: StopSignal) => void;
  /** Every phase the sequence reported to the stop, in order. */
  readonly phases: string[];
  readonly run: () => Promise<number>;
}

interface HarnessOptions {
  readonly loop?: FakeLoopOptions;
  readonly feed: FakeFeedOptions;
  /** Overrides for the opened resources (a close that throws, say). */
  readonly opened?: (journal: string[], halts: HaltController) => Partial<OpenedResources>;
  /** `false`: no stop is wired at all (a caller like the existing tests). */
  readonly wireStop?: boolean;
}

function harness(options: HarnessOptions): Harness {
  const journal: string[] = [];
  const lines: string[] = [];
  const records: HaltIncidentRow[] = [];
  const phases: string[] = [];
  const halts = new HaltController();
  const listeners = new Map<StopSignal, () => void>();
  const ports: GracefulStopPorts = {
    listen: (signal, listener) => listeners.set(signal, listener),
    unlisten: (signal) => listeners.delete(signal),
    exit: (code) => journal.push(`FORCED EXIT ${String(code)}`),
    writeLine: (line) => {
      journal.push(line.slice(0, line.indexOf(":")));
      lines.push(line);
    },
    timer: () => () => undefined,
    nowMs: () => 0,
  };
  const stop = installGracefulStop(ports);
  const enter = stop.enter.bind(stop);
  stop.enter = (phase, detail) => {
    phases.push(detail === undefined ? phase : `${phase}: ${detail}`);
    enter(phase, detail);
  };
  const opened: OpenedResources = {
    transport: {
      close: async () => {
        journal.push("close the Redis transport");
      },
    },
    store: {
      recordHalts: async (rows) => {
        journal.push(`halt record: ${String(rows.length)} row(s)`);
        records.push(...rows);
        return { status: "written", rows: rows.length };
      },
      close: async () => {
        journal.push("close the PostgreSQL pool");
      },
    },
    healthServer: {
      close: async () => {
        journal.push("close the health endpoint");
      },
    },
    feed: fakeFeed(journal, options.feed),
    transportLag: {
      stop: () => {
        journal.push("stop the transport-lag sampler");
      },
    },
    ...options.opened?.(journal, halts),
  };
  const run = async (): Promise<number> =>
    await runUntilStopped({
      trader: { loop: fakeLoop(journal, halts, options.loop), halts },
      config: exampleConfig(),
      opened,
      log: (line) => {
        lines.push(line);
      },
      ...(options.wireStop === false ? {} : { stop }),
    });
  const signal = (name: StopSignal): void => {
    const listener = listeners.get(name);
    if (listener === undefined) throw new Error(`no listener for ${name}`);
    journal.push(`SIGNAL ${name}`);
    listener();
  };
  return { journal, lines, halts, records, stop, signal, phases, run };
}

/** The closes, in the reverse order `startup()` opened what they close. */
const CLOSES_IN_REVERSE = [
  "stop the transport-lag sampler",
  "close the event subscription",
  "close the health endpoint",
  "close the PostgreSQL pool",
  "close the Redis transport",
] as const;

const CLOSE_PHASES = [
  "CLOSING: the transport-lag sampler",
  "CLOSING: the event subscription",
  "CLOSING: the health endpoint",
  "CLOSING: the PostgreSQL pool",
  "CLOSING: the Redis transport",
] as const;

function lineStarting(lines: readonly string[], prefix: string): string {
  const found = lines.find((line) => line.startsWith(prefix));
  if (found === undefined) throw new Error(`no line starts "${prefix}":\n${lines.join("\n")}`);
  return found;
}

describe("a requested stop, in order (TRADER-SIGNALS)", () => {
  it("SIGTERM mid-drain: the batch in hand finishes its durable writes and records its position; no batch is read after it; then the check, then the closes in reverse order; exit 0", async () => {
    const draining = gate();
    const h = harness({
      feed: { batches: [["e1", "e2"], ["e3"]] },
      loop: {
        onDrain: async (index) => {
          if (index === 1) {
            h.signal("SIGTERM");
            await draining.opened;
          }
        },
      },
    });
    const running = h.run();
    // The signal landed inside drain 1, which is still waiting: nothing after it has run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.journal.at(-1)).toBe("STOP REQUESTED");
    draining.open();
    const code = await running;

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.journal).toStrictEqual([
      "poll 1",
      "ingest e1",
      "ingest e2",
      "drain 1 start",
      "SIGNAL SIGTERM",
      "STOP REQUESTED",
      "drain 1 durable",
      "commit",
      // No "poll 2": the stop is read before the next poll, and e3 is never read.
      "rebuild check SHUTDOWN",
      // No halt is latched, so no halt record is written.
      ...CLOSES_IN_REVERSE,
    ]);
    expect(h.records).toStrictEqual([]);
    expect(h.phases).toStrictEqual(["PUMP", "HALT_RECORD", ...CLOSE_PHASES]);
    expect(lineStarting(h.lines, "pump stopped: ")).toBe(
      "pump stopped: STOPPED after 1 poll(s), 2 event(s) ingested: SIGTERM was requested, so no batch was read " +
        "after it, and the batch in hand finished its durable writes and recorded its position first",
    );
    expect(h.lines).toContain("accounting rebuild check at shutdown: the held ledger view equals its rebuild from zero");
    expect(h.lines.filter((line) => line.startsWith("HALT"))).toStrictEqual([]);
    expect(h.lines.at(-1)).toBe(
      "trader stopped: exit 0 — a clean stop on SIGTERM: no halt is latched and the SHUTDOWN rebuild check " +
        "matched; everything opened was closed",
    );
  });

  it("SIGINT mid-POLL: the batch that poll answers is the batch in hand — ingested, drained durably, its position recorded — and no further poll", async () => {
    const h = harness({
      feed: {
        batches: [["e1"], ["e2", "e3"], ["e4"]],
        onPoll: (index) => {
          if (index === 2) h.signal("SIGINT");
        },
      },
    });
    expect(await h.run()).toBe(EXIT_CODES.ok);
    expect(h.journal).toStrictEqual([
      "poll 1",
      "ingest e1",
      "drain 1 start",
      "drain 1 durable",
      "commit",
      "poll 2",
      "SIGNAL SIGINT",
      "STOP REQUESTED",
      "ingest e2",
      "ingest e3",
      "drain 2 start",
      "drain 2 durable",
      "commit",
      "rebuild check SHUTDOWN",
      ...CLOSES_IN_REVERSE,
    ]);
    expect(lineStarting(h.lines, "pump stopped: ")).toMatch(/^pump stopped: STOPPED after 2 poll\(s\), 3 event\(s\) ingested: SIGINT was requested/u);
  });

  it("the PIPELINED path: the pending batch's position is recorded only once its rows are durable, and before the check", async () => {
    const durable = gate();
    const h = harness({
      loop: {
        groupCommits: true,
        onDrain: (index) => {
          if (index === 1) h.signal("SIGTERM");
        },
        durable: async () => {
          await durable.opened;
          h.journal.push("rows durable");
          return true;
        },
      },
      feed: { batches: [["e1", "e2"], ["e3"]], marks: true },
    });
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Waiting for batch 1's rows: its position is not recorded and nothing else has run.
    expect(h.journal).not.toContain("commit mark of poll 1");
    expect(h.journal).not.toContain("rebuild check SHUTDOWN");
    durable.open();
    expect(await running).toBe(EXIT_CODES.ok);
    expect(h.journal).toStrictEqual([
      "poll 1",
      "ingest e1",
      "ingest e2",
      "drain 1 start",
      "SIGNAL SIGTERM",
      "STOP REQUESTED",
      "drain 1 requested",
      "durability mark taken",
      "rows durable",
      "commit mark of poll 1",
      "rebuild check SHUTDOWN",
      ...CLOSES_IN_REVERSE,
    ]);
  });

  it("a stop requested before the pump ever ran (a signal during startup): no batch is read at all, the check runs, everything closes, exit 0", async () => {
    const h = harness({ feed: { batches: [["e1"]] } });
    h.signal("SIGTERM");
    expect(await h.run()).toBe(EXIT_CODES.ok);
    expect(h.journal).toStrictEqual(["SIGNAL SIGTERM", "STOP REQUESTED", "rebuild check SHUTDOWN", ...CLOSES_IN_REVERSE]);
    expect(lineStarting(h.lines, "pump stopped: ")).toMatch(/^pump stopped: STOPPED after 0 poll\(s\), 0 event\(s\) ingested: /u);
    expect(h.lines[0]).toMatch(/^STOP REQUESTED: SIGTERM received during startup, before the pump ran\. /u);
  });
});

describe("fail closed: a stop clears no halt (TRADER-SIGNALS)", () => {
  it("a halt latched IN the batch in hand while the stop was requested: the pump stops HALTED, the position is NOT recorded, the halt is recorded, exit 75 — never 0", async () => {
    const h = harness({
      feed: { batches: [["e1"], ["e2"]] },
      loop: {
        onDrain: (index) => {
          if (index === 1) {
            h.signal("SIGTERM");
            h.halts.halt({ kind: "MARKET", marketId: "018f4a7e-1111-7abc-8def-0123456789ab" }, "UNATTRIBUTED_ACTIVITY", "a balance moved with no attribution", AT);
          }
        },
      },
    });
    expect(await h.run()).toBe(EXIT_CODES.halted);
    expect(h.journal).toStrictEqual([
      "poll 1",
      "ingest e1",
      "drain 1 start",
      "SIGNAL SIGTERM",
      "STOP REQUESTED",
      "drain 1 durable",
      // No commit: the pump's rule — nothing is recorded after a halt.
      "rebuild check SHUTDOWN",
      "halt record: 1 row(s)",
      ...CLOSES_IN_REVERSE,
    ]);
    expect(lineStarting(h.lines, "pump stopped: ")).toBe("pump stopped: HALTED after 1 poll(s)");
    expect(h.lines).toContain(
      "HALT MARKET UNATTRIBUTED_ACTIVITY: a balance moved with no attribution",
    );
    expect(h.records.map((row) => [row.incident_key, row.failure_class])).toStrictEqual([["TRADER_HALT:MARKET", "UNATTRIBUTED_ACTIVITY"]]);
    expect(h.lines.at(-1)).toBe(
      "trader stopped: exit 75 — halted: 1 halt(s) latched (the HALT lines above); the stop SIGTERM requested " +
        "clears no halt, so this is not a clean stop; everything opened was closed",
    );
  });

  it("a signal during a halt's own shutdown (the pump already stopped HALTED): the exit stays 75, and the stop's phases go on as before", async () => {
    const h = harness({
      feed: { batches: [["e1"]], failAt: 2 },
      opened: (journal) => ({
        store: {
          recordHalts: async (rows) => {
            journal.push(`halt record: ${String(rows.length)} row(s)`);
            h.signal("SIGINT");
            return { status: "written", rows: rows.length };
          },
          close: async () => {
            journal.push("close the PostgreSQL pool");
          },
        },
      }),
    });
    expect(await h.run()).toBe(EXIT_CODES.halted);
    expect(h.journal).toStrictEqual([
      "poll 1",
      "ingest e1",
      "drain 1 start",
      "drain 1 durable",
      "commit",
      "poll 2",
      "rebuild check SHUTDOWN",
      "halt record: 1 row(s)",
      "SIGNAL SIGINT",
      "STOP REQUESTED",
      ...CLOSES_IN_REVERSE,
    ]);
    expect(h.lines.find((line) => line.startsWith("STOP REQUESTED"))).toMatch(
      /^STOP REQUESTED: SIGINT received during the halt record \(every latched halt being written to ops\.incidents\)\. .*1 halt\(s\) are latched \(GLOBAL TRANSPORT_UNAVAILABLE\), so the exit stays non-zero\. /u,
    );
    expect(h.lines.at(-1)).toMatch(/^trader stopped: exit 75 — halted: 1 halt\(s\) latched \(the HALT lines above\); the stop SIGINT requested clears no halt/u);
  });

  it("the SHUTDOWN check FAILS on a requested stop: its halt is recorded, everything still closes, and the exit is 70 — distinct from 75 and never 0", async () => {
    const h = harness({
      feed: {
        batches: [["e1"]],
        onPoll: (index) => {
          if (index === 2) h.signal("SIGTERM");
        },
      },
      loop: { mismatch: true },
    });
    expect(await h.run()).toBe(EXIT_CODES.shutdownCheckFailed);
    expect(h.journal.slice(h.journal.indexOf("rebuild check SHUTDOWN"))).toStrictEqual([
      "rebuild check SHUTDOWN",
      "halt record: 1 row(s)",
      ...CLOSES_IN_REVERSE,
    ]);
    expect(h.lines).toContain(
      "accounting rebuild check at shutdown: MISMATCH — the held accounting state differs from its rebuild " +
        "from zero (see the ACCOUNTING_REBUILD_MISMATCH halt)",
    );
    expect(h.records.map((row) => row.failure_class)).toStrictEqual(["ACCOUNTING_REBUILD_MISMATCH"]);
    expect(h.lines.at(-1)).toBe(
      "trader stopped: exit 70 — the SHUTDOWN rebuild check FAILED (ACCOUNTING_REBUILD_MISMATCH, §6 invariant 8): " +
        "the held accounting state differs from its rebuild from zero, so this run's accounting is not to be " +
        "trusted; 1 halt(s) latched in all; everything opened was closed",
    );
  });

  it("the check fails after a GLOBAL run halt, no stop wired: 70 over 75, whatever stopped the pump — and only the exit code shows it", async () => {
    const h = harness({ feed: { batches: [["e1"]], failAt: 2 }, loop: { mismatch: true }, wireStop: false });
    expect(await h.run()).toBe(EXIT_CODES.shutdownCheckFailed);
    // The controller keeps the FIRST record per scope, so the check's GLOBAL
    // halt is not a second record beside TRANSPORT_UNAVAILABLE: the MISMATCH
    // line and the exit code are what say the check failed. That is why the
    // code takes precedence over `halted`.
    expect(h.records.map((row) => row.failure_class)).toStrictEqual(["TRANSPORT_UNAVAILABLE"]);
    expect(h.lines).toContain(
      "accounting rebuild check at shutdown: MISMATCH — the held accounting state differs from its rebuild " +
        "from zero (see the ACCOUNTING_REBUILD_MISMATCH halt)",
    );
    expect(h.lines.at(-1)).toMatch(/^trader stopped: exit 70 — the SHUTDOWN rebuild check FAILED /u);
  });

  it("a halt latched DURING the closes (after the record): logged as such, and the exit is 75", async () => {
    const h = harness({
      feed: { batches: [] },
      opened: (journal, halts) => ({
        store: {
          recordHalts: async () => ({ status: "written", rows: 0 }),
          close: async () => {
            journal.push("close the PostgreSQL pool");
            halts.halt({ kind: "GLOBAL" }, "STORE_UNAVAILABLE", "the pool lost an idle connection", AT);
          },
        },
      }),
    });
    h.signal("SIGTERM");
    expect(await h.run()).toBe(EXIT_CODES.halted);
    expect(h.lines).toContain(
      "HALT GLOBAL STORE_UNAVAILABLE: the pool lost an idle connection (latched during the stop, " +
        "after the halt record was written; it is not in ops.incidents)",
    );
    expect(h.lines.at(-1)).toMatch(/^trader stopped: exit 75 — halted: 1 halt\(s\) latched/u);
  });

  it("a close that THROWS is logged, the closes after it still run, and the exit is unchanged", async () => {
    const h = harness({
      feed: { batches: [] },
      opened: (journal) => ({
        healthServer: {
          close: async () => {
            journal.push("close the health endpoint");
            throw new Error("the listener was already closed");
          },
        },
      }),
    });
    h.signal("SIGTERM");
    expect(await h.run()).toBe(EXIT_CODES.ok);
    expect(h.journal.slice(-5)).toStrictEqual([...CLOSES_IN_REVERSE]);
    expect(h.lines).toContain(
      "CLOSE FAILED: the health endpoint: Error: the listener was already closed; the stop goes on to the next close",
    );
    expect(h.lines.at(-1)).toBe(
      "trader stopped: exit 0 — a clean stop on SIGTERM: no halt is latched and the SHUTDOWN rebuild check " +
        "matched; 1 close(s) failed (the health endpoint; logged above)",
    );
  });

  it("no health endpoint configured: that close is skipped, the others keep their order", async () => {
    const h = harness({ feed: { batches: [] }, opened: () => ({ healthServer: undefined }) });
    h.signal("SIGTERM");
    expect(await h.run()).toBe(EXIT_CODES.ok);
    expect(h.journal.slice(-4)).toStrictEqual(CLOSES_IN_REVERSE.filter((step) => step !== "close the health endpoint"));
  });
});

describe("with no stop wired, nothing changes (a caller like the existing startup tests)", () => {
  it("the pump runs until a halt, the stop reports the halt, exit 75; nothing says STOPPED", async () => {
    const h = harness({ feed: { batches: [["e1"], [], ["e2"]], failAt: 4 }, wireStop: false });
    expect(await h.run()).toBe(EXIT_CODES.halted);
    expect(h.journal.filter((entry) => entry.startsWith("poll "))).toStrictEqual(["poll 1", "poll 2", "poll 3", "poll 4"]);
    expect(lineStarting(h.lines, "pump stopped: ")).toBe("pump stopped: HALTED after 4 poll(s)");
    expect(h.phases).toStrictEqual([]);
    expect(h.lines.at(-1)).toBe(
      "trader stopped: exit 75 — halted: 1 halt(s) latched (the HALT lines above); everything opened was closed",
    );
  });
});

describe("exitCodeAfterStop: shutdownCheckFailed over halted over ok", () => {
  it.each([
    ["STOPPED", true, 0, EXIT_CODES.ok],
    ["MAX_POLLS", true, 0, EXIT_CODES.ok],
    ["IDLE", true, 0, EXIT_CODES.ok],
    ["STOPPED", true, 1, EXIT_CODES.halted],
    ["HALTED", true, 1, EXIT_CODES.halted],
    // Fail closed: a pump that says HALTED is a halt even with no record in hand.
    ["HALTED", true, 0, EXIT_CODES.halted],
    ["STOPPED", false, 1, EXIT_CODES.shutdownCheckFailed],
    ["HALTED", false, 2, EXIT_CODES.shutdownCheckFailed],
  ] as const)("pump %s, check matched %s, %d halt(s) → %d", (pumpStopped, rebuildMatched, haltsLatched, expected) => {
    expect(exitCodeAfterStop({ pumpStopped, rebuildMatched, haltsLatched })).toBe(expected);
  });

  it("the last line without a signal (the halt path) names no stop", () => {
    expect(traderStoppedLine(EXIT_CODES.ok, { signal: undefined, haltsLatched: 0, failedCloses: [] })).toBe(
      "trader stopped: exit 0 — a clean stop: no halt is latched and the SHUTDOWN rebuild check matched; everything opened was closed",
    );
  });
});
