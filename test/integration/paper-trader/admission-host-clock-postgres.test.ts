/**
 * `CO2-N1` (ADR-031) T4 — the SHIPPED clock: `assembleDurableTrader`, the
 * process's own steps 3b/4, with the unmodified `SystemPaperClock` (the host's
 * clock, as `startup()` builds it), against a real PostgreSQL.
 *
 * The fixture's six recorded events, its market's open and its close are
 * shifted TOGETHER relative to the host clock (`support/host-clock.ts`
 * `shiftScenario`), so the scenario is the fixture's own, happening as many
 * seconds ago as the case says:
 *
 * - the last event 11 minutes ago: the entry (one second before it) is about
 *   661 s old when admitted, past the fixture's 600 000 ms features bound, and
 *   the close is still about 4 minutes away — refused `RISK_FEATURES_STALE`,
 *   and that refusal is durable (`ops.risk_events`, `PROVENANCE-1`);
 * - the last event 1 minute ago: the lag is about 61 s, inside the bound —
 *   approved and filled.
 *
 * The registered `catalog.markets` row keeps the fixture's unshifted
 * open/close: the trader's registration check does not compare them, and the
 * trader reads its market's times from the configuration document, which is
 * shifted.
 *
 * Docker: Testcontainers, its own `beforeAll`, as the other container files.
 * PAPER only; throwaway credentials; no venue, no signer, no real order.
 */

import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { recordedEvents, safeEnvironment } from "./support/fixture.js";
import { shiftScenario } from "./support/host-clock.js";
import { CONDITION_ID, documentFor, registerThroughTheRepositories, withFreshDatabase } from "./support/registration.js";
import { startReadyPostgresContainer } from "./support/containers.js";

let container: Awaited<ReturnType<typeof startReadyPostgresContainer>>;

beforeAll(async () => {
  container = await startReadyPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

const MINUTE_MS = 60_000;

/** Registers, shifts the scenario so its last event is `lastEventAgoMs` before the host's now, and runs it. */
async function runShifted(label: string, lastEventAgoMs: number) {
  return await withFreshDatabase(container.getConnectionUri(), label, async ({ connectionString, context }) => {
    const registered = await registerThroughTheRepositories(context, label);
    const recorded = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
    const last = recorded.at(-1);
    if (last === undefined) throw new Error("the fixture lost its events");
    const clock = new SystemPaperClock();
    const deltaMs = Date.parse(clock.now()) - lastEventAgoMs - Date.parse(last.envelope.receivedAt);
    const { events, document } = shiftScenario(recorded, documentFor(registered, label), deltaMs);
    const parsed = parseTraderConfig(document);
    if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
    const lines: string[] = [];
    const assembled = await assembleDurableTrader({
      env: safeEnvironment(),
      config: parsed.config,
      document,
      postgresUrl: connectionString,
      clock,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(assembled.ok ? "ok" : lines.join("\n")).toBe("ok");
    if (!assembled.ok) throw new Error("unreachable");
    const { trader, store } = assembled;
    try {
      for (const event of events) expect(trader.loop.ingest(event)).toBe(true);
      await trader.loop.drain();
      const refusalRows = await context.db
        .selectFrom("ops.risk_events")
        .select(["reason_code", "outcome"])
        .where("run_id", "=", registered.runId)
        .execute();
      const decisions = await context.db
        .selectFrom("strategy.decisions")
        .select(["decision_type"])
        .where("run_id", "=", registered.runId)
        .execute();
      return { health: trader.loop.health(), refusalRows, decisions, events };
    } finally {
      await store.close();
    }
  });
}

describe("ADR-031 T4: the shipped SystemPaperClock, the fixture shifted relative to the host clock", () => {
  it("the last event 11 minutes ago (the entry ~661 s late, the bound 600 000 ms): refused at admission, RISK_FEATURES_STALE only, durably; nothing filled", async () => {
    const run = await runShifted("co2n1-t4-late", 11 * MINUTE_MS);
    expect(run.decisions.some((row) => row.decision_type === "enter")).toBe(true);
    expect(run.health.risk.approvals).toBe(0);
    expect(run.health.risk.refusals).toBeGreaterThanOrEqual(1);
    expect(run.health.risk.refusalsByCode).toEqual({ RISK_FEATURES_STALE: run.health.risk.refusals });
    expect(run.health.execution.plansBuilt).toBe(0);
    expect(run.health.execution.fillsObserved).toBe(0);
    expect(run.health.halts).toEqual([]);
    expect(run.refusalRows.length).toBe(run.health.risk.refusals);
    for (const row of run.refusalRows) expect(row).toEqual({ reason_code: "RISK_FEATURES_STALE", outcome: "VETOED" });
  }, 120_000);

  it("the last event 1 minute ago (the entry ~61 s late, inside the bound): approved and filled", async () => {
    const run = await runShifted("co2n1-t4-timely", MINUTE_MS);
    expect(run.health.risk.approvals).toBeGreaterThanOrEqual(1);
    expect(run.health.risk.refusals).toBe(0);
    expect(run.health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
    expect(run.health.halts).toEqual([]);
    expect(run.refusalRows).toEqual([]);
  }, 120_000);
});
