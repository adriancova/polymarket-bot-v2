/**
 * `BACKTEST-2` — the backtest executable's OWN assembly of the shared core,
 * over the REAL core (`@polymarket-bot/trading-core`) and the committed
 * fixture `test/replay-golden/backtest/static-bracket/` (read only).
 *
 * Pinned here:
 *
 * - startup safety runs FIRST, with the core's own check beside this root's —
 *   a production secret NAME is refused by presence, before anything is read;
 * - BT1-R2: a run pin that disagrees with the core's configuration is
 *   REFUSED before a core is built, naming the field — each of the four pins
 *   the configuration also states, and an instance's own run seed;
 * - BT1-R3, on the REAL core: a halt already latched refuses the first event
 *   before it is ingested; a halt the core latches mid-run (its production
 *   store closed under it: `STORE_UNAVAILABLE`) stops the replay after that
 *   drain, as the live pump returns `HALTED`, and no later recorded event
 *   reaches the core; the same core driven WITHOUT the latch keeps delivering;
 * - `run` refuses a dataset pinned to a normalizer whose stream the core
 *   does not consume;
 * - `CADENCE-1` (ADR-026 D1.3-D1.6): the core runs the evaluation cadence its
 *   run pins state; the per-frame value 0 only for a DECLARED reproduction,
 *   1000/5000 otherwise, anything else refused before a core is built.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReplayRunPins } from "@polymarket-bot/simulation";
import { PAPER_ACCOUNTING_CHECKS, parseTraderConfig, type IngestedEvent } from "@polymarket-bot/trading-core";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "./archive.js";
import {
  assembleBacktestCore,
  checkBacktestCoreSafety,
  reconcileRunPinsWithCoreConfig,
  runBacktestCore,
} from "./assembly.js";
import { replayDrivenCoreLoop } from "./core-loop.js";
import { normalizedEnvelopeNormalizer } from "./normalizer.js";
import { runBacktest } from "./run.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "replay-golden",
  "backtest",
  "static-bracket",
);
const FIRST_INSTANT = { receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" };
const ID_NAMESPACE = "backtest-1-static-bracket-replay";
/** `CADENCE-1` (ADR-026 D1.6): the fixture's pins state 0; its golden is what a run of them reproduces. */
const REPRODUCES = "test/replay-golden/backtest/static-bracket/expected-artifact.txt";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE, file), "utf8")) as T;
}
function pins(): ReplayRunPins {
  return readJson<ReplayRunPins>("run-pins.json");
}
function traderConfig(): Record<string, unknown> {
  return readJson<Record<string, unknown>>("trader-config.json");
}
function safeEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
  };
}
function assemble(overrides: { readonly runPins?: ReplayRunPins; readonly traderConfig?: unknown } = {}) {
  return assembleBacktestCore({
    environment: safeEnvironment(),
    traderConfig: overrides.traderConfig ?? traderConfig(),
    runPins: overrides.runPins ?? pins(),
    clockStart: FIRST_INSTANT,
    idNamespace: ID_NAMESPACE,
    accountingChecks: PAPER_ACCOUNTING_CHECKS,
    reproduces: REPRODUCES,
  });
}

describe("startup safety — §6 invariant 17, before anything is read", () => {
  it("a clean PAPER-floor environment passes both checks", () => {
    expect(checkBacktestCoreSafety(safeEnvironment())).toEqual({ ok: true });
    expect(checkBacktestCoreSafety({})).toEqual({ ok: true });
  });

  it("a production secret NAME is refused by PRESENCE, including one the root's value-triggered scan misses", () => {
    for (const [name, value] of [
      ["POLY_API_KEY", "x"],
      ["POLYMARKET_PRIVATE_KEY", ""],
      ["POLYMARKET_WALLET_ADDRESS", "0xabc"],
    ] as const) {
      const outcome = checkBacktestCoreSafety({ ...safeEnvironment(), [name]: value });
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.violations.join("\n"), name).toMatch(/PAPER_PRODUCTION_(SECRET|ACCOUNT)_NAME_PRESENT/u);
      // The name is reported; the value never is.
      if (value !== "") expect(outcome.violations.join("\n")).not.toContain(`=${value}`);
    }
  });

  it("a raised default is refused by BOTH checks; the four floors are never raised", () => {
    const outcome = checkBacktestCoreSafety({
      MAX_RUN_MODE: "LIVE",
      ALLOW_REAL_ORDERS: "true",
      LIVE_MICRO_MAX_ORDER_NOTIONAL: "5",
      LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "5",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const codes = outcome.violations.map((line) => line.split(":")[0]);
    expect(codes).toEqual([
      "BACKTEST_RUN_MODE_CEILING_RAISED",
      "BACKTEST_REAL_ORDERS_ENABLED",
      "BACKTEST_LIVE_MICRO_CAP_NONZERO",
      "BACKTEST_LIVE_MICRO_CAP_NONZERO",
      "PAPER_RUN_MODE_CEILING_RAISED",
      "PAPER_REAL_ORDERS_ENABLED",
      "PAPER_LIVE_MICRO_CAP_NONZERO",
      "PAPER_LIVE_MICRO_CAP_NONZERO",
    ]);
  });

  it("BT1-R5: the core is the PAPER core, so RUN_MODE may be unset or PAPER — BACKTEST is refused by the core's own check", () => {
    expect(checkBacktestCoreSafety({ ...safeEnvironment(), RUN_MODE: "PAPER" })).toEqual({ ok: true });
    const backtest = checkBacktestCoreSafety({ ...safeEnvironment(), RUN_MODE: "BACKTEST" });
    expect(backtest.ok).toBe(false);
    if (backtest.ok) return;
    expect(backtest.violations.join("\n")).toContain("PAPER_RUN_MODE_NOT_PERMITTED");
  });

  it("the assembly refuses an unsafe environment before it parses anything, and builds no core", () => {
    const assembled = assembleBacktestCore({
      environment: { ...safeEnvironment(), POLY_API_KEY: "x" },
      traderConfig: "this is not even a configuration",
      runPins: pins(),
      clockStart: FIRST_INSTANT,
    });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusal.code).toBe("BACKTEST_UNSAFE_ENVIRONMENT");
  });
});

describe("BT1-R2 — the run pins are reconciled against the core's configuration", () => {
  const parsed = parseTraderConfig(traderConfig());
  if (!parsed.ok) throw new Error("the fixture configuration was refused");

  it("the committed fixture agrees, and assembles", () => {
    expect(reconcileRunPinsWithCoreConfig(pins(), parsed.config)).toEqual([]);
    expect(assemble().ok).toBe(true);
  });

  for (const [pin, value, field] of [
    ["fillModelVersion", "tier0.somewhere-else", "simulation.fillModelVersion"],
    ["fillModelParametersHash", "d".repeat(64), "simulation.fillModelParametersHash"],
    ["feeSnapshotVersion", "fees.somewhere-else", "simulation.feeSchedule.snapshotVersion"],
    ["runSeed", "7", "instances[019b1e00-0000-7000-8000-000000000002].runSeed"],
  ] as const) {
    it(`a ${pin} the configuration does not state is REFUSED before a core is built, naming ${field}`, () => {
      const mutated = { ...pins(), [pin]: value } as ReplayRunPins;
      const assembled = assemble({ runPins: mutated });
      expect(assembled.ok).toBe(false);
      if (assembled.ok) return;
      expect(assembled.refusal.code).toBe("BACKTEST_PINS_DISAGREE_WITH_CONFIG");
      expect(assembled.refusal.issues).toHaveLength(1);
      expect(assembled.refusal.issues[0]).toContain(`${pin}: the run pins say ${JSON.stringify(value)}`);
      expect(assembled.refusal.issues[0]).toContain(`(${field})`);
    });
  }

  it("the CONFIGURATION side is read too: an instance whose own run seed differs from the pin is refused", () => {
    const document = traderConfig();
    const instances = document["instances"] as Record<string, unknown>[];
    document["instances"] = instances.map((instance) => ({ ...instance, runSeed: "1" }));
    const assembled = assemble({ traderConfig: document });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusal.issues.join("\n")).toContain('runSeed: the run pins say "250250" and the core\'s configuration says "1"');
  });
});

describe("BT1-R3 — on the REAL core, a latched halt stops the replay where the live pump returns HALTED", () => {
  it("a halt already latched refuses the FIRST event before it is ingested: nothing reaches the core", async () => {
    const assembled = assemble();
    if (!assembled.ok) throw new Error(assembled.refusal.detail);
    const core = assembled.core;
    core.trader.halts.halt({ kind: "GLOBAL" }, "OPERATOR_HALT", "latched before the run", FIRST_INSTANT.receivedAt);
    const outcome = await runBacktest({
      datasetDirectory: FIXTURE,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: pins(),
      environment: safeEnvironment(),
      coreLoop: core.driver.coreLoop,
      venue: core.venue,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || !("refusal" in outcome)) return;
    expect(outcome.refusal.details).toMatchObject({
      halts: "OPERATOR_HALT@GLOBAL",
      stoppedAt: "BEFORE_INGEST",
      ingestSeq: "1",
    });
    expect(core.driver.observations()).toEqual({ eventsIngested: 0, drains: 0 });
    expect(core.trader.loop.decisions()).toEqual([]);
  });

  it("a halt the core latches MID-RUN stops the replay after that drain; the same core without the latch keeps delivering", async () => {
    // The production store, closed under the core: its next write is refused,
    // and the core latches STORE_UNAVAILABLE inside the drain that wrote.
    const halting = assemble();
    if (!halting.ok) throw new Error(halting.refusal.detail);
    await halting.core.store.close();
    const outcome = await runBacktest({
      datasetDirectory: FIXTURE,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: pins(),
      environment: safeEnvironment(),
      coreLoop: halting.core.driver.coreLoop,
      venue: halting.core.venue,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || !("refusal" in outcome)) return;
    expect(outcome.refusal.details).toMatchObject({ halts: "STORE_UNAVAILABLE@GLOBAL", stoppedAt: "AFTER_DRAIN" });
    const stoppedAt = Number(outcome.refusal.details["ingestSeq"]);
    const observed = halting.core.driver.observations();
    // Every event up to the halting one was ingested and drained; none after it.
    expect(observed).toEqual({ eventsIngested: stoppedAt, drains: stoppedAt });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(8);
    expect(halting.core.trader.halts.records().map((halt) => halt.code)).toEqual(["STORE_UNAVAILABLE"]);

    // CONTROL: the same assembly, the same closed store, driven WITHOUT the
    // halt latch — BACKTEST-1's driver — delivers all eight events into the
    // halted core. That difference is what BT1-R3 decided.
    const control = assemble();
    if (!control.ok) throw new Error(control.refusal.detail);
    await control.core.store.close();
    const blind = replayDrivenCoreLoop({ loop: control.core.trader.loop, clock: control.core.clock });
    const delivered = await runBacktest({
      datasetDirectory: FIXTURE,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: pins(),
      environment: safeEnvironment(),
      coreLoop: blind.coreLoop,
      venue: control.core.venue,
    });
    expect(delivered.ok).toBe(true);
    expect(blind.observations()).toEqual({ eventsIngested: 8, drains: 8 });
    expect(control.core.trader.halts.anyHalt).toBe(true);
  });
});

describe("runBacktestCore — what the run command runs", () => {
  it("refuses a dataset pinned to a normalizer whose stream the core does not consume, before any file is read", async () => {
    const started = await runBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: { ...pins(), normalizerVersion: "backtest-cli/recorded-frame-passthrough/v1" },
      datasetDirectory: join(FIXTURE, "no-such-directory"),
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal.code).toBe("BACKTEST_NORMALIZER_NOT_SUPPORTED");
  });

  it("refuses a manifest it cannot read, by name, rather than throwing", async () => {
    const started = await runBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: pins(),
      datasetDirectory: join(FIXTURE, "no-such-directory"),
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal.code).toBe("BACKTEST_DATASET_REFUSED");
  });

  it("drives the committed fixture to completion with the core it built, under the PAPER cadence, with no halt", async () => {
    const started = await runBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: pins(),
      datasetDirectory: FIXTURE,
      idNamespace: ID_NAMESPACE,
      reproduces: REPRODUCES,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.run.outcome.ok).toBe(true);
    expect(started.run.driver).toEqual({ eventsIngested: 8, drains: 8 });
    expect(started.run.core.trader.halts.anyHalt).toBe(false);
    expect(started.run.core.store.decisions.length).toBe(12);
    expect(started.run.core.trader.loop.health().seams.folds.checkEveryFills).toBe(PAPER_ACCOUNTING_CHECKS.everyFills);
  });
});

describe("CADENCE-1 — the evaluation cadence a replay runs is its run pins' (ADR-026 D1.3-D1.6)", () => {
  it("the golden's pins state 0/0, and its declared reproduction runs exactly that, recorded on the core", () => {
    expect([pins().evaluationIntervalMs, pins().evaluationHeartbeatMs]).toEqual([0, 0]);
    const assembled = assemble();
    if (!assembled.ok) throw new Error(assembled.refusal.detail);
    expect(assembled.core.trader.loop.evaluationCadence()).toEqual({
      intervalMs: 0,
      heartbeatMs: 0,
      reproduces: REPRODUCES,
    });
  });

  it("the same pins WITHOUT a declared reproduction are refused before a core is built (D1.6)", () => {
    const assembled = assembleBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: pins(),
      clockStart: FIRST_INSTANT,
    });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusal.code).toBe("BACKTEST_CADENCE_REFUSED");
    expect(assembled.refusal.issues.join("\n")).toContain("evaluationIntervalMs 0");
  });

  it("a replay that reproduces nothing runs exactly 1000/5000 from its pins", () => {
    const assembled = assembleBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: { ...pins(), evaluationIntervalMs: 1000, evaluationHeartbeatMs: 5000 },
      clockStart: FIRST_INSTANT,
    });
    if (!assembled.ok) throw new Error(assembled.refusal.detail);
    expect(assembled.core.trader.loop.evaluationCadence()).toEqual({ intervalMs: 1000, heartbeatMs: 5000 });
  });

  for (const [interval, heartbeat] of [
    [1, 5000],
    [1000, 5001],
    [0, 5000],
    [2000, 10000],
  ] as const) {
    it(`pins of ${String(interval)}/${String(heartbeat)} are refused, declared reproduction or not (D1.5)`, () => {
      for (const reproduces of [REPRODUCES, undefined]) {
        const assembled = assembleBacktestCore({
          environment: safeEnvironment(),
          traderConfig: traderConfig(),
          runPins: { ...pins(), evaluationIntervalMs: interval, evaluationHeartbeatMs: heartbeat },
          clockStart: FIRST_INSTANT,
          ...(reproduces === undefined ? {} : { reproduces }),
        });
        expect(assembled.ok).toBe(false);
        if (assembled.ok) continue;
        expect(assembled.refusal.code).toBe("BACKTEST_CADENCE_REFUSED");
      }
    });
  }

  it("a reproduction label that would break the artifact's line grammar is refused", () => {
    for (const reproduces of ["", "two words", "line\nbreak", "x".repeat(257)]) {
      const assembled = assembleBacktestCore({
        environment: safeEnvironment(),
        traderConfig: traderConfig(),
        runPins: pins(),
        clockStart: FIRST_INSTANT,
        reproduces,
      });
      expect(assembled.ok, JSON.stringify(reproduces)).toBe(false);
      if (assembled.ok) continue;
      expect(assembled.refusal.code).toBe("BACKTEST_CADENCE_REFUSED");
    }
  });
});

describe("CADENCE-1 r1 (O03) — the backtest core logs the forward-jump alarm to its log sink (ADR-026 D2.10)", () => {
  /** One applied event for a market the fixture does not run, at `receivedAt`. */
  function unknownBook(receivedAt: string, ordinal: number): IngestedEvent {
    const gatewayEpoch = "019b1e00-0000-7000-8000-0000000000e5";
    const ingestSeq = String(ordinal);
    return {
      envelope: {
        eventId: `019b1e00-0000-7000-8000-${String(ordinal).padStart(12, "0")}`,
        eventType: "BookSnapshot",
        schemaVersion: 1,
        source: "polymarket" as const,
        sourceChannel: "market",
        receivedAt,
        receivedMonotonicNs: String(ordinal * 1_000_000),
        gatewayEpoch,
        ingestSeq,
        subscriptionGeneration: 1,
        payload: {
          internalMarketId: "019b1e00-0000-7000-8000-0000000000e1",
          tokenId: "999",
          bids: [{ price: "0.4", size: "10" }],
          asks: [],
        },
      },
      identity: { gatewayEpoch, ingestSeq, receivedAt, datasetRowOrdinal: ordinal },
    };
  }

  it("an episode's start and its end each give ONE line, naming the event and the clock", async () => {
    const lines: string[] = [];
    const assembled = assembleBacktestCore({
      environment: safeEnvironment(),
      traderConfig: traderConfig(),
      runPins: { ...pins(), evaluationIntervalMs: 1000, evaluationHeartbeatMs: 5000 },
      clockStart: FIRST_INSTANT,
      log: (line) => {
        lines.push(line);
      },
    });
    if (!assembled.ok) throw new Error(assembled.refusal.detail);
    const loop = assembled.core.trader.loop;
    // An hour ahead, then an hour behind it (beyond the 5,000 ms bound), then within it.
    for (const [index, receivedAt] of ["2026-05-01T10:00:00.000Z", "2026-05-01T09:00:01.000Z", "2026-05-01T09:59:58.000Z"].entries()) {
      expect(loop.ingest(unknownBook(receivedAt, index + 1))).toBe(true);
    }
    await loop.drain();
    expect(lines.filter((line) => line.startsWith("CADENCE CLOCK "))).toEqual([
      "CADENCE CLOCK FORWARD JUMP: event 2026-05-01T09:00:01Z lies 3599000 ms behind the event clock 2026-05-01T10:00:00Z (bound 5000 ms; ADR-026 D2.10)",
      "CADENCE CLOCK CAUGHT UP: event 2026-05-01T09:59:58Z lies 2000 ms behind the event clock 2026-05-01T10:00:00Z (bound 5000 ms; ADR-026 D2.10)",
    ]);
    expect(loop.health().loop.cadenceForwardJumpAlarms).toBe(1);
  });
});
