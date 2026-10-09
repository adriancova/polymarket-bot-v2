/**
 * WP-340, work-plan acceptance 4: "Live maximum defaults remain zero."
 * (packet scenario 5).
 *
 * 1. FROM THE SHIPPED CONFIGURATIONS: the repository's safety state
 *    (`AGENTS.md`, the brief) states the four defaults; the shipped trader
 *    example runs PAPER with both live-micro caps at "0"; no compose
 *    fragment or CI workflow sets any of the four to anything else.
 * 2. FROM THE CODE DEFAULTS, by behaviour: an absent setting means PAPER, no
 *    real orders, caps "0" (WP-260's `signerGateContextFromSafetyFlags`,
 *    `packages/trading-core`'s startup floor, `apps/backtest-cli`'s floor,
 *    `packages/capital-allocator`'s fenced caps), and each raised value is
 *    REFUSED by name, never clamped.
 * 3. EVERY LIVE-CAPABLE COMPONENT REFUSES IN PAPER (and under the repository
 *    ceiling even when a live mode is asked for): WP-260's secure client
 *    (the real factory and the test factory), WP-280's user-stream manager,
 *    WP-320's heartbeat controller, fencing authority, live-safety
 *    composition and PostgreSQL lease store, and every venue-touching
 *    command of WP-330's CLI. Each refusal happens before its port is
 *    touched: the fake SDK factory, the socket, the heartbeat transport, the
 *    database handle and the CLI's credential and venue ports all record
 *    zero calls.
 *
 * PAPER only. Nothing here constructs a credential; the database handle is a
 * proxy that fails the test if anything reads it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkBacktestSafety } from "../../../apps/backtest-cli/src/safety.js";
import { LEASES_FORBIDDEN, NON_INTERACTIVE, PAPER_FLAGS, testConfiguration, uuidSource } from "../../../apps/ops-cli/src/emergency/harness.test-support.js";
import type { AuditRecord, AuditSink } from "../../../apps/ops-cli/src/emergency/audit-log.js";
import { runOpsCli } from "../../../apps/ops-cli/src/emergency/run.js";
import {
  FakeBodyPort,
  FakeKillSwitchReader,
  FakeReleaseFinality,
  FakeCancels,
  FakeCoordinator,
  FakeOms,
  HEALTH_MAX_AGE,
  ManualClock,
  MemoryFencingStore,
  NOT_BLOCKED,
  RecordingAlerts,
  RecordingJournal,
  REPOSITORY_DEFAULTS_LIVE_MICRO,
} from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import { createLiveSafety, FencingAuthority, LiveFencingRefusal, OmsProgressMonitor } from "../../../apps/trader/src/live-safety/index.js";
import { LIVE_MICRO_CAP_FIELDS, LIVE_MICRO_CAP_FLOOR, parseAllocatorCaps } from "../../../packages/capital-allocator/src/caps.js";
import {
  createSecureVenueClient,
  evaluateSignerGate,
  signerGateContextFromSafetyFlags,
  SignerBoundaryRefusal,
} from "../../../packages/polymarket-secure/src/index.js";
import { createOrderHeartbeatController } from "../../../packages/polymarket-secure/src/heartbeat/index.js";
import { budgetFrom, ManualTime } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createFakeSdkFactory, createMockSignerHandle, createSecureVenueClientForTesting, installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { createUserStreamManager } from "../../../packages/polymarket-secure/src/user-stream/index.js";
import { FakeUserSocketPort, ManualTimers } from "../../../packages/polymarket-secure/src/user-stream/testing/fake-socket-port.js";
import { createFencingLeaseStore, NonRealModeFencingLeaseError } from "../../../packages/storage-postgres/src/index.js";
import { checkPaperTraderSafety, REPOSITORY_MAXIMUM_RUN_MODE } from "../../../packages/trading-core/src/safety.js";
import { RATE_LIMIT_SNAPSHOT } from "./support/safety-node.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8");

const DEFAULTS = Object.freeze({ MAX_RUN_MODE: "PAPER", ALLOW_REAL_ORDERS: "false", LIVE_MICRO_MAX_ORDER_NOTIONAL: "0", LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0" });
/** The repository's PAPER context, and a live mode asked for under the repository ceiling. */
const PAPER_CONTEXT = Object.freeze({ runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false });
const CONTEXTS_THAT_MUST_REFUSE: readonly (readonly [string, unknown])[] = [
  ["PAPER", PAPER_CONTEXT],
  ["the flags' defaults (nothing set)", signerGateContextFromSafetyFlags({})],
  ["the shipped flags", signerGateContextFromSafetyFlags(PAPER_FLAGS)],
  ["LIVE_MICRO asked for under MAX_RUN_MODE=PAPER, ALLOW_REAL_ORDERS=false", REPOSITORY_DEFAULTS_LIVE_MICRO],
  ["BACKTEST", { runMode: "BACKTEST", maximumRunMode: "PAPER", allowRealOrders: false }],
  ["SHADOW", { runMode: "SHADOW", maximumRunMode: "SHADOW", allowRealOrders: false }],
];

describe("WP-340 acceptance 4, from the shipped configurations: the four defaults", () => {
  it("the repository's safety state states all four, verbatim (AGENTS.md and the brief)", () => {
    for (const file of ["AGENTS.md", "IMPLEMENTATION_STATUS.md"]) {
      const text = read(file);
      for (const [name, value] of Object.entries(DEFAULTS)) expect(text, `${file}: ${name}`).toContain(`${name}=${value}`);
    }
    expect(read("IMPLEMENTATION_STATUS.md")).toContain("Maximum permitted run mode: `PAPER`");
  });

  it("the shipped trader example runs PAPER with both live-micro caps at exactly \"0\"", () => {
    const example = JSON.parse(read("infra/compose/trader/trader.config.example.json")) as { environment: unknown; allocatorCaps: Record<string, unknown> };
    expect(example.environment).toBe("PAPER");
    expect(example.allocatorCaps["liveMicroMaxOrderNotional"]).toBe("0");
    expect(example.allocatorCaps["liveMicroMaxAccountExposure"]).toBe("0");
    // The shipped caps pass the allocator's fence as they are.
    expect(parseAllocatorCaps(example.allocatorCaps).ok).toBe(true);
  });

  it("no compose fragment and no CI workflow SETS any of the four (comments may name them)", () => {
    for (const file of ["infra/compose/paper/compose.yaml", "docker-compose.yml", ".github/workflows/ci.yml"]) {
      const code = read(file)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"));
      for (const name of Object.keys(DEFAULTS)) expect(code.filter((line) => line.includes(name)), `${file} sets ${name}`).toEqual([]);
    }
  });
});

describe("WP-340 acceptance 4, from the code defaults: absent means PAPER, no real orders, caps \"0\"; raised means refused", () => {
  it("WP-260's flags reader: nothing set reads MAX_RUN_MODE=PAPER and ALLOW_REAL_ORDERS=false, and the gate refuses it", () => {
    expect(signerGateContextFromSafetyFlags({})).toEqual({ runMode: undefined, maximumRunMode: "PAPER", allowRealOrders: false });
    expect(signerGateContextFromSafetyFlags(PAPER_FLAGS)).toEqual({ runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false });
    expect(evaluateSignerGate(signerGateContextFromSafetyFlags({})).permitted).toBe(false);
  });

  it("the trader's startup floor: the repository ceiling is PAPER; nothing set passes as PAPER; each raised default is refused by name", () => {
    expect(REPOSITORY_MAXIMUM_RUN_MODE).toBe("PAPER");
    expect(checkPaperTraderSafety({})).toEqual({ ok: true, runMode: "PAPER" });
    expect(checkPaperTraderSafety({ ...DEFAULTS, RUN_MODE: "PAPER" })).toEqual({ ok: true, runMode: "PAPER" });
    const raised: readonly (readonly [Record<string, string>, string])[] = [
      [{ MAX_RUN_MODE: "LIVE_MICRO" }, "PAPER_RUN_MODE_CEILING_RAISED"],
      [{ ALLOW_REAL_ORDERS: "true" }, "PAPER_REAL_ORDERS_ENABLED"],
      [{ LIVE_MICRO_MAX_ORDER_NOTIONAL: "1" }, "PAPER_LIVE_MICRO_CAP_NONZERO"],
      [{ LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0.01" }, "PAPER_LIVE_MICRO_CAP_NONZERO"],
      [{ RUN_MODE: "LIVE_MICRO" }, "PAPER_RUN_MODE_NOT_PERMITTED"],
    ];
    for (const [env, code] of raised) {
      const outcome = checkPaperTraderSafety(env);
      expect(outcome.ok, JSON.stringify(env)).toBe(false);
      if (!outcome.ok) expect(outcome.violations.map((violation) => violation.code)).toContain(code);
    }
  });

  it("the backtest process's floor refuses each raised default too", () => {
    expect(checkBacktestSafety({})).toEqual({ ok: true });
    for (const [name, value, code] of [
      ["MAX_RUN_MODE", "LIVE", "BACKTEST_RUN_MODE_CEILING_RAISED"],
      ["ALLOW_REAL_ORDERS", "true", "BACKTEST_REAL_ORDERS_ENABLED"],
      ["LIVE_MICRO_MAX_ORDER_NOTIONAL", "5", "BACKTEST_LIVE_MICRO_CAP_NONZERO"],
      ["LIVE_MICRO_MAX_ACCOUNT_EXPOSURE", "5", "BACKTEST_LIVE_MICRO_CAP_NONZERO"],
    ] as const) {
      const outcome = checkBacktestSafety({ [name]: value });
      expect(outcome.ok, name).toBe(false);
      if (!outcome.ok) expect(outcome.violations.map((violation) => violation.code), name).toContain(code);
    }
  });

  it("the allocator's live-micro caps: the floor is exactly \"0\", absent caps default to it, and any other value is refused (never clamped)", () => {
    expect(LIVE_MICRO_CAP_FLOOR).toBe("0");
    expect([...LIVE_MICRO_CAP_FIELDS].sort()).toEqual(["liveMicroMaxAccountExposure", "liveMicroMaxOrderNotional"]);
    const parsed = parseAllocatorCaps({ globalAccountCap: "500", perStrategyCap: "100" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.liveMicroMaxOrderNotional).toBe("0");
      expect(parsed.value.liveMicroMaxAccountExposure).toBe("0");
    }
    for (const field of LIVE_MICRO_CAP_FIELDS) {
      for (const value of ["0.000001", "1", "10"]) {
        const refused = parseAllocatorCaps({ globalAccountCap: "500", perStrategyCap: "100", [field]: value });
        expect(refused.ok, `${field}=${value}`).toBe(false);
        if (!refused.ok) expect(refused.refusals.map((refusal) => refusal.code), `${field}=${value}`).toEqual(["CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED"]);
      }
    }
  });
});

describe("WP-340 acceptance 4: every live-capable component refuses in PAPER, before its port is touched", () => {
  for (const [label, context] of CONTEXTS_THAT_MUST_REFUSE) {
    it(`${label}: WP-260's secure client (the real factory and the test factory), WP-280's manager, WP-320's controller, fencing authority and live safety all refuse`, async () => {
      // WP-260: the real factory, and the test factory over a fake SDK that records every call.
      await expect(createSecureVenueClient({ runModeContext: context, signer: createMockSignerHandle().handle })).rejects.toBeInstanceOf(SignerBoundaryRefusal);
      const sdk = createFakeSdkFactory();
      await expect(createSecureVenueClientForTesting({ runModeContext: context, signer: createMockSignerHandle().handle }, sdk.factory)).rejects.toBeInstanceOf(SignerBoundaryRefusal);
      expect(sdk.recorder.factoryCalls).toEqual([]);
      // WP-280: the socket port is never asked.
      const socket = new FakeUserSocketPort();
      expect(() =>
        createUserStreamManager({ runModeContext: context, transport: socket, timers: new ManualTimers(), markets: [`0x${"ab".repeat(32)}`], onOutput: () => undefined }),
      ).toThrow(SignerBoundaryRefusal);
      expect(socket.connectCalls).toBe(0);
      // WP-320: the heartbeat controller never touches its transport.
      const time = new ManualTime();
      const transportCalls: unknown[] = [];
      expect(() =>
        createOrderHeartbeatController({
          runModeContext: context,
          transport: { send: async (request) => void transportCalls.push(request) },
          gate: { evaluate: () => ({ permitted: true }) },
          budget: budgetFrom(RATE_LIMIT_SNAPSHOT),
          clock: time,
          timers: time,
          heartbeatIds: { persist: async () => true },
          initialHeartbeatId: "",
          onEvent: () => undefined,
        }),
      ).toThrow(SignerBoundaryRefusal);
      expect(transportCalls).toEqual([]);
      // WP-320: the fencing authority and the whole live-safety composition refuse the context first.
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      expect(() => FencingAuthority.create({ runModeContext: context as never, accountRef: "acct-1", holderId: "trader-a", store, clock, ttlMs: 30_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 })).toThrow(
        LiveFencingRefusal,
      );
      expect(() =>
        createLiveSafety({
          runModeContext: context as never,
          accountRef: "acct-1",
          holderId: "trader-a",
          clock,
          timers: clock,
          fencing: { store, ttlMs: 30_000, renewIntervalMs: 5_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 },
          health: { maxAgeMs: HEALTH_MAX_AGE, eventLoop: { intervalMs: 500, maxLagMs: 250 } },
          killSwitch: { reader: new FakeKillSwitchReader(), refreshIntervalMs: 1_000, cancels: new FakeCancels(), releaseSettleMs: 2_000, releaseFinality: new FakeReleaseFinality() },
          eligibility: { geoblock: new FakeBodyPort(NOT_BLOCKED), closedOnly: new FakeBodyPort({ closed_only: false }), refreshIntervalMs: 30_000, maxAgeMs: 60_000 },
          oms: new FakeOms(),
          omsProgress: new OmsProgressMonitor({ clock }),
          coordinator: new FakeCoordinator(),
          recovery: { notRunPollMs: 100, failedRunSpacingMs: 1_000 },
          journal: new RecordingJournal(),
          alerts: new RecordingAlerts(),
        }),
      ).toThrow(LiveFencingRefusal);
      expect(store.rows).toEqual([]);
    });
  }

  it("WP-320's PostgreSQL lease store refuses a PAPER, BACKTEST or SHADOW acquisition before any SQL: its database handle is never read", async () => {
    const reads: PropertyKey[] = [];
    const database = new Proxy(
      {},
      {
        get: (_target, key) => {
          reads.push(key);
          throw new Error("the database handle was read");
        },
      },
    );
    const store = createFencingLeaseStore(database as never);
    for (const environment of ["PAPER", "BACKTEST", "SHADOW"]) {
      await expect(store.acquire({ accountRef: "acct-1", environment, holderId: "trader-a", ttlMs: 30_000, maximumRunMode: "PAPER", allowRealOrders: false })).rejects.toBeInstanceOf(
        NonRealModeFencingLeaseError,
      );
    }
    expect(reads).toEqual([]);
  });

  it("WP-330's CLI under the shipped flags: every venue-touching command exits RUN_MODE_REFUSED; no configuration, credential, venue or lease port is touched", async () => {
    const commands: readonly (readonly string[])[] = [
      ["cancel-all", "--reason", "drill", "--confirm", "cancel-all:acct-1"],
      ["cancel-order", "venue-1", "--reason", "drill", "--confirm", "cancel-order:acct-1:venue-1"],
      ["cancel-market", `0x${"c".repeat(64)}`, "--reason", "drill"],
      ["account-snapshot"],
      ["reconcile"],
      ["stop-heartbeat", "--reason", "drill"],
    ];
    for (const command of commands) {
      const touched: string[] = [];
      const records: AuditRecord[] = [];
      const audit: AuditSink = { location: "memory://wp340", append: (record) => (records.push(record), Promise.resolve()) };
      const outcome = await runOpsCli({
        argv: [...command, "--account", "acct-1", "--operator", "operator-ana"],
        runModeFlags: PAPER_FLAGS,
        defaultAuditLogPath: audit.location,
        out: { line: () => undefined },
        prompt: NON_INTERACTIVE,
        clock: { nowMs: () => 1_790_000_000_000, sleep: () => Promise.resolve() },
        newId: uuidSource(1_790_000_000_000),
        openAuditLog: () => audit,
        auditMirror: null,
        configuration: { load: () => (touched.push("configuration"), Promise.resolve({ kind: "LOADED" as const, document: testConfiguration() })) },
        credentials: { load: () => (touched.push("credentials"), Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NONE" })) },
        venues: { open: () => (touched.push("venues"), Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NONE" })) },
        leases: { open: () => (touched.push("leases"), LEASES_FORBIDDEN.open()) },
        projection: null,
      });
      expect(outcome.exitName, command[0]).toBe("RUN_MODE_REFUSED");
      expect(touched, command[0]).toEqual([]);
      expect(records.map((record) => record.phase), command[0]).toEqual(["INVOKED", "OUTCOME"]);
    }
  });
});
