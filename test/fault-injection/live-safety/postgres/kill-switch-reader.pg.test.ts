/**
 * The durable kill-switch read against a REAL PostgreSQL (`WP-320` r1,
 * findings I6 and I7). Testcontainers, every migration applied; the rows are
 * written by the REAL `ControlPlane` through its REAL
 * `PostgresControlAuditSink`, and read by the REAL
 * `createPostgresKillSwitchReader` into the REAL `KillSwitchMonitor`, whose
 * monotonic clock is a manual one (the settle window is the monitor's, timed
 * from first sight; the database's clock decides nothing about it).
 *
 * - I6: a `KILL_SWITCH_RELEASE` whose audit append outlives the control
 *   plane's bound is refused `503` and NOT applied; its APPLIED row lands in
 *   `ops.kill_switch_events` afterwards, and the control plane then voids it
 *   in `ops.config_change_audit`. The trader must keep the switch engaged —
 *   in the window BEFORE the VOID lands too. On the candidate the trader read
 *   the switch as released while the control plane still held it.
 * - I7: the reader's SECOND ordering (`occurred_at`) is what keeps a switch
 *   engaged when the database's `recorded_at` order shows its release last.
 *
 * Docker is required (`vitest.config.ts` beside this file). Throwaway
 * credentials only; no venue, no signer, no real credential. PAPER only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresControlAuditSink } from "../../../../apps/control-api/src/adapters/postgres-audit-sink.js";
import { ControlPlane } from "../../../../apps/control-api/src/control-plane.js";
import { ManualClock } from "../../../../apps/trader/src/live-safety/fakes.test-support.js";
import { createPostgresKillSwitchReader } from "../../../../apps/trader/src/live-safety/kill-switch-postgres.js";
import { KillSwitchMonitor } from "../../../../apps/trader/src/live-safety/kill-switch.js";
import type { AuditAppendResult, ControlAuditRecord, ControlAuditSink } from "../../../../packages/observability/src/index.js";
import { uuidV7 } from "../../../../packages/storage-postgres/src/ids.js";
import { createIsolatedDatabase, createMigratedContext, startPostgresContainer, type TestContext } from "../../../../packages/storage-postgres/src/testing/index.js";

const ACCOUNT = "acct-1";
const SETTLE_MS = 2_000;
const MARKET = "0190a3e0-0000-7000-8000-00000000000c";

let container: Awaited<ReturnType<typeof startPostgresContainer>> | undefined;
let context: TestContext | undefined;

function database(): TestContext {
  if (context === undefined) throw new Error("the PostgreSQL context was not created");
  return context;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const isolated = await createIsolatedDatabase(container.getConnectionUri(), "wp320_kill_switch_reader");
  context = await createMigratedContext(isolated.connectionString);
});

afterAll(async () => {
  await context?.close();
  await container?.stop();
});

/** A sink that holds, unanswered, every append `hold` selects, until the test lands it. */
function holdingSink(inner: ControlAuditSink): { sink: ControlAuditSink; hold: (select: (record: ControlAuditRecord) => boolean) => void; held: () => number; land: () => Promise<void> } {
  let select: (record: ControlAuditRecord) => boolean = () => false;
  const parked: (() => Promise<void>)[] = [];
  return {
    sink: {
      append(record: ControlAuditRecord): Promise<AuditAppendResult> {
        if (!select(record)) return inner.append(record);
        return new Promise<AuditAppendResult>((resolve) => {
          parked.push(async () => {
            resolve(await inner.append(record));
          });
        });
      },
    },
    hold: (next) => {
      select = next;
    },
    held: () => parked.length,
    land: async () => {
      const next = parked.shift();
      if (next === undefined) throw new Error("nothing is held");
      await next();
    },
  };
}

function voidsOf(record: ControlAuditRecord): unknown {
  const state = record.resultingState;
  return typeof state === "object" && state !== null && !Array.isArray(state) ? (state as Record<string, unknown>)["voidsRecordId"] : undefined;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("the condition never held");
}

function setup(): {
  control: ControlPlane;
  holding: ReturnType<typeof holdingSink>;
  monitor: KillSwitchMonitor;
  clock: ManualClock;
} {
  const holding = holdingSink(new PostgresControlAuditSink({ db: database().db, environment: "PAPER" }));
  const control = new ControlPlane({
    audit: holding.sink,
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
    auditAppendTimeoutMs: 25,
    auditRecordSource: { now: () => new Date().toISOString(), nextAuditRecordId: () => uuidV7() },
  });
  const clock = new ManualClock();
  const monitor = new KillSwitchMonitor({ reader: createPostgresKillSwitchReader(database().db), clock, accountRef: ACCOUNT, releaseSettleMs: SETTLE_MS });
  return { control, holding, monitor, clock };
}

const ctx = (auditRecordId: string = uuidV7()): Parameters<ControlPlane["engageKillSwitch"]>[1] => ({
  actor: "operator-a",
  at: new Date().toISOString(),
  auditRecordId,
  reason: "a stated reason",
});

async function voidLanded(recordId: string): Promise<boolean> {
  const rows = await database().pool.query<{ count: string }>(`select count(*)::text as count from ops.config_change_audit where new_value ->> 'voidsRecordId' = $1`, [recordId]);
  return rows.rows[0]?.count === "1";
}

describe("r1 I6: a release the control plane refused and voided never releases the trader (real control plane, real sink, real PostgreSQL)", () => {
  it("a GLOBAL FULL_HALT: the late release row is enforced as the switch before its VOID lands, and for good after; the control plane agrees", async () => {
    const { control, holding, monitor, clock } = setup();
    expect((await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, ctx())).ok).toBe(true);
    expect(await monitor.refresh()).toBe(true);
    expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true } });

    // The release's append outlives the 25 ms bound: refused 503, not applied.
    const releaseId = uuidV7();
    holding.hold((record) => record.recordId === releaseId || voidsOf(record) === releaseId);
    const refused = await control.releaseKillSwitch({ scope: "GLOBAL", scopeRef: null, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } }, ctx(releaseId));
    expect(refused.ok).toBe(false);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);

    // The APPLIED release row lands late; its VOID is held: the window BEFORE the VOID.
    await holding.land();
    await waitFor(async () => holding.held() === 1);
    const late = await database().pool.query<{ count: string }>(`select count(*)::text as count from ops.kill_switch_events where kill_switch_event_id = $1`, [releaseId]);
    expect(late.rows[0]?.count).toBe("1");
    for (const elapsed of [0, SETTLE_MS - 1]) {
      await clock.advance(elapsed);
      expect(await monitor.refresh()).toBe(true);
      expect(monitor.snapshot()).toMatchObject({ known: true, effects: { stopsHeartbeat: true, blocksAllSubmissions: true } });
    }

    // The VOID lands: the release is voided, and stays enforced as the switch however long it is seen.
    await holding.land();
    await waitFor(async () => voidLanded(releaseId));
    for (let step = 0; step < 4; step += 1) {
      await clock.advance(SETTLE_MS);
      expect(await monitor.refresh()).toBe(true);
      const snapshot = monitor.snapshot();
      expect(snapshot).toMatchObject({ known: true, effects: { stopsHeartbeat: true } });
      // Both orderings return the voided release; each is enforced as the FULL_HALT it did not release.
      const global = snapshot.known ? snapshot.effects.engaged.filter((entry) => entry.scope === "GLOBAL") : [];
      expect(global.map((entry) => [entry.killSwitchEventId, entry.release, entry.action])).toEqual([
        [releaseId, "VOIDED", "FULL_HALT"],
        [releaseId, "VOIDED", "FULL_HALT"],
      ]);
    }
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("the control: a release the control plane APPLIED releases the trader once seen for the settle window, not before", async () => {
    const { control, monitor, clock } = setup();
    expect((await control.engageKillSwitch({ scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" }, ctx())).ok).toBe(true);
    expect(await monitor.refresh()).toBe(true);
    expect(monitor.snapshot()).toMatchObject({ known: true });
    const snapshot = monitor.snapshot();
    expect(snapshot.known && snapshot.effects.submissionBlockedMarkets.has(MARKET)).toBe(true);
    expect((await control.releaseKillSwitch({ scope: "MARKET", scopeRef: MARKET, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } }, ctx())).ok).toBe(true);
    expect(await monitor.refresh()).toBe(true);
    const pending = monitor.snapshot();
    expect(pending.known && pending.effects.submissionBlockedMarkets.has(MARKET)).toBe(true);
    await clock.advance(SETTLE_MS);
    expect(await monitor.refresh()).toBe(true);
    const released = monitor.snapshot();
    expect(released.known && released.effects.entryBlockedMarkets.has(MARKET)).toBe(false);
    expect(released.known ? released.effects.engaged.filter((entry) => entry.scopeRef === MARKET) : null).toEqual([]);
  });
});

describe("r1 I7: the reader's two orderings and its VOID lookup, on real rows", () => {
  async function insertEvent(input: { readonly id: string; readonly scope: string; readonly scopeRef: string | null; readonly engaged: boolean; readonly occurredAt: string; readonly recordedAt: string; readonly environment?: string }): Promise<void> {
    const state = input.engaged
      ? { engaged: "true", scope: input.scope, scopeRef: input.scopeRef, action: "FULL_HALT", reason: "r", since: input.occurredAt, actor: "operator-a" }
      : { engaged: "false", scope: input.scope, scopeRef: input.scopeRef };
    await database().pool.query(
      `insert into ops.kill_switch_events (kill_switch_event_id, scope, scope_ref, action, environment, actor, actor_kind, reason, prior_state, resulting_state, occurred_at, recorded_at)
       values ($1, $2::internal.kill_switch_scope, $3, 'FULL_HALT', $4::internal.run_mode, 'operator-a', 'HUMAN', 'a stated reason', '{}'::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz)`,
      [input.id, input.scope, input.scopeRef, input.environment ?? "LIVE_MICRO", JSON.stringify(state), input.occurredAt, input.recordedAt],
    );
  }

  it("by recorded_at the release is last, by occurred_at the engage is: the switch stays ENGAGED (dropping either ordering would release it)", async () => {
    const scopeRef = "0190a3e0-0000-7000-8000-0000000000a7";
    // Engage: occurred later, recorded EARLIER (a database clock that stepped back).
    await insertEvent({ id: uuidV7(), scope: "MARKET", scopeRef, engaged: true, occurredAt: "2026-10-05T10:00:10Z", recordedAt: "2026-10-05T10:00:00Z" });
    await insertEvent({ id: uuidV7(), scope: "MARKET", scopeRef, engaged: false, occurredAt: "2026-10-05T10:00:05Z", recordedAt: "2026-10-05T10:00:20Z" });
    const reader = createPostgresKillSwitchReader(database().db);
    const rows = (await reader.read()).filter((row) => row.scopeRef === scopeRef);
    expect(rows.map((row) => (row.resultingState as { engaged: string }).engaged)).toEqual(["false", "true"]);
    const clock = new ManualClock();
    const monitor = new KillSwitchMonitor({ reader, clock, accountRef: ACCOUNT, releaseSettleMs: SETTLE_MS });
    await monitor.refresh();
    await clock.advance(SETTLE_MS);
    await monitor.refresh();
    const snapshot = monitor.snapshot();
    expect(snapshot.known && snapshot.effects.submissionBlockedMarkets.has(scopeRef)).toBe(true);
  });

  it("and the converse (the release occurred last, the engage was recorded last): engaged again", async () => {
    const scopeRef = "0190a3e0-0000-7000-8000-0000000000a8";
    await insertEvent({ id: uuidV7(), scope: "MARKET", scopeRef, engaged: true, occurredAt: "2026-10-05T11:00:00Z", recordedAt: "2026-10-05T11:00:20Z" });
    await insertEvent({ id: uuidV7(), scope: "MARKET", scopeRef, engaged: false, occurredAt: "2026-10-05T11:00:10Z", recordedAt: "2026-10-05T11:00:05Z" });
    const rows = (await createPostgresKillSwitchReader(database().db).read()).filter((row) => row.scopeRef === scopeRef);
    expect(rows.map((row) => (row.resultingState as { engaged: string }).engaged)).toEqual(["true", "false"]);
  });

  it("a VOID naming the row in UPPER case still voids it; a VOID naming another row does not; the rows of another environment are returned too", async () => {
    const voided = uuidV7();
    const clean = uuidV7();
    await insertEvent({ id: voided, scope: "MARKET", scopeRef: "0190a3e0-0000-7000-8000-0000000000a9", engaged: false, occurredAt: "2026-10-05T12:00:00Z", recordedAt: "2026-10-05T12:00:00Z" });
    await insertEvent({ id: clean, scope: "MARKET", scopeRef: "0190a3e0-0000-7000-8000-0000000000aa", engaged: false, occurredAt: "2026-10-05T12:00:00Z", recordedAt: "2026-10-05T12:00:00Z", environment: "PAPER" });
    await database().pool.query(
      `insert into ops.config_change_audit (config_change_id, actor, actor_kind, change_kind, target_schema, target_table, target_id, previous_value, new_value, reason, environment, occurred_at)
       values ($1, 'control-api', 'AUTOMATED', 'KILL_SWITCH_RELEASE_REFUSED', 'ops', 'kill_switch_events', null, '{}'::jsonb, $2::jsonb, 'VOID', 'PAPER', clock_timestamp())`,
      [uuidV7(), JSON.stringify({ voidsRecordId: voided.toUpperCase() })],
    );
    const rows = await createPostgresKillSwitchReader(database().db).read();
    expect(rows.filter((row) => row.killSwitchEventId === voided).map((row) => row.voided)).toEqual([true, true]);
    expect(rows.filter((row) => row.killSwitchEventId === clean).map((row) => [row.voided, row.environment])).toEqual([
      [false, "PAPER"],
      [false, "PAPER"],
    ]);
  });
});
