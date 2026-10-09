/**
 * `C1-HALTS` (the user's rulings of 2026-10-08), against a real PostgreSQL:
 *
 * - **NEW-RUN** (OPS-03 (a)): `register --new-run <instanceId>` mints ONE new
 *   `strategy.runs` row for an instance a completed document already names,
 *   reusing the market and instance rows only when the trader's own
 *   registration check (`BOOT-1`) accepts them with the new run. The pin is
 *   the operator's remedy end to end: a run that holds decisions is refused
 *   `TRADER_REGISTRATION_RUN_NOT_RESUMABLE` (BOOT-1, unchanged), `--new-run`
 *   writes the document for a new run, and the trader starts and decides on it.
 * - **HALT-PAGES** (OPS-04 as amended): a new run's start marks its instance's
 *   earlier OPEN halt rows RESOLVED — the INFRASTRUCTURE codes only. The
 *   accounting and order-state codes, `BOOK_DESYNCHRONIZED`, another
 *   instance's rows and an already-resolved row are left as they were.
 *
 * Docker: Testcontainers, no skip. PAPER only; no venue, no signer, no real
 * order; throwaway credentials.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSupersededHalts } from "../../../apps/trader/src/halt-record.js";
import { REGISTER_EXIT_CODES } from "../../../apps/trader/src/register/main.js";
import { recordedEvents } from "./support/fixture.js";
import {
  Scratch,
  assemble,
  conditionFor,
  printedIdentities,
  registerArgv,
  registerEnvironment,
  registrationRowCounts,
  runRegister,
  templateFor,
} from "./support/register-command.js";
import { registerThroughTheRepositories, withFreshDatabase as withFreshDatabaseOn, type Fresh } from "./support/registration.js";
import { startReadyPostgresContainer } from "./support/containers.js";

let container: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
const scratch = new Scratch("c1-halts");

beforeAll(async () => {
  container = await startReadyPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
  await scratch.remove();
});

async function withFreshDatabase<T>(label: string, run: (fresh: Fresh) => Promise<T>): Promise<T> {
  return await withFreshDatabaseOn(container.getConnectionUri(), label, run);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function newRunArgv(input: { readonly instanceId: string; readonly template: string; readonly out: string }): string[] {
  return ["--new-run", input.instanceId, "--template", input.template, "--out", input.out, "--code-commit", "c1-halts-new-run"];
}

describe("C1-HALTS NEW-RUN: register --new-run <instanceId>", () => {
  it("the operator's remedy: a run holding decisions is refused at start; --new-run mints a run for the same instance, and the trader starts and decides on it", async () => {
    await withFreshDatabase("c1-new-run", async ({ connectionString, context }) => {
      const directory = await scratch.directory("new-run");
      const template = await scratch.write(directory, "template.json", templateFor("new-run"));
      const first = path.join(directory, "first.json");
      const registered = await runRegister(
        registerArgv({ template, out: first, instanceName: "static-bracket-new-run" }),
        registerEnvironment(connectionString),
      );
      expect(registered.code, registered.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(registered);

      // Run 1 decides, so BOOT-1 will not resume it.
      const firstDocument = JSON.parse(await readFile(first, "utf8")) as Record<string, unknown>;
      const one = await assemble(firstDocument, connectionString);
      if (!one.result.ok) throw new Error(one.log);
      try {
        for (const event of recordedEvents(ids.marketId, conditionFor("new-run"))) one.result.trader.loop.ingest(event);
        await one.result.trader.loop.drain();
        expect(one.result.trader.loop.decisions().length).toBeGreaterThanOrEqual(1);
      } finally {
        await one.result.store.close();
      }
      const refused = await assemble(firstDocument, connectionString);
      expect(refused.result.ok).toBe(false);
      expect(refused.log).toContain("TRADER_REGISTRATION_RUN_NOT_RESUMABLE");

      // --new-run: one new strategy.runs row, nothing else.
      const before = await registrationRowCounts(context.db);
      const second = path.join(directory, "second.json");
      const run = await runRegister(newRunArgv({ instanceId: ids.instanceId, template: first, out: second }), registerEnvironment(connectionString));
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.registered);
      const printed = JSON.parse(run.printed.trim()) as Record<string, unknown>;
      expect(printed).toMatchObject({ registered: true, newRun: true, instanceId: ids.instanceId, previousRunId: ids.runId, completedDocument: second });
      const newRunId = String(printed["runId"]);
      expect(newRunId).not.toBe(ids.runId);
      expect(await registrationRowCounts(context.db)).toEqual({ ...before, "strategy.runs": before["strategy.runs"] + 1 });
      const row = await context.db.selectFrom("strategy.runs").selectAll().where("run_id", "=", newRunId).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        instance_id: ids.instanceId,
        config_id: ids.configId,
        definition_id: ids.definitionId,
        environment: "PAPER",
        status: "RUNNING",
        code_commit: "c1-halts-new-run",
        evaluation_interval_ms: 1000,
        evaluation_heartbeat_ms: 5000,
      });

      // The new document is the old one with that instance's runId replaced.
      const secondDocument = JSON.parse(await readFile(second, "utf8")) as Record<string, unknown>;
      const [instance] = secondDocument["instances"] as Record<string, unknown>[];
      expect(instance?.["runId"]).toBe(newRunId);
      expect({ ...secondDocument, instances: [{ ...instance, runId: ids.runId }] }).toEqual(firstDocument);

      // C1-HALTS (TAINT): the start states the feed whose market-less
      // incidents taint an epoch (here the default; the fixture is LAST_CHANGE).
      const confirmed = await assemble(
        { ...secondDocument, bookFreshness: { basis: "CONNECTION_CONFIRMED", maximumLastChangeAgeMs: 30_000 } },
        connectionString,
      );
      if (confirmed.result.ok) await confirmed.result.store.close();
      expect(confirmed.log).toContain('book freshness: CONNECTION_CONFIRMED; a market-less incident from feed "polymarket-market"');

      // The trader starts on it, and decides under the new run.
      const two = await assemble(secondDocument, connectionString);
      if (!two.result.ok) throw new Error(two.log);
      try {
        expect(two.log).toContain("registration: OK");
        expect(two.log).toContain("book freshness: LAST_CHANGE");
        for (const event of recordedEvents(ids.marketId, conditionFor("new-run"))) two.result.trader.loop.ingest(event);
        await two.result.trader.loop.drain();
        const decisions = await context.db.selectFrom("strategy.decisions").select("run_id").where("run_id", "=", newRunId).execute();
        expect(decisions.length).toBeGreaterThanOrEqual(1);
      } finally {
        await two.result.store.close();
      }
    });
  }, 240_000);

  it("refuses an instance the document does not name, and a document the registered rows disagree with — nothing written, no output", async () => {
    await withFreshDatabase("c1-new-run-refused", async ({ connectionString, context }) => {
      const directory = await scratch.directory("new-run-refused");
      const template = await scratch.write(directory, "template.json", templateFor("new-run-refused"));
      const first = path.join(directory, "first.json");
      const registered = await runRegister(
        registerArgv({ template, out: first, instanceName: "static-bracket-new-run-refused" }),
        registerEnvironment(connectionString),
      );
      expect(registered.code, registered.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(registered);
      const before = await registrationRowCounts(context.db);

      const unknown = path.join(directory, "unknown.json");
      const notNamed = await runRegister(
        newRunArgv({ instanceId: "c18f4a7e-0000-7abc-8def-0123456789ab", template: first, out: unknown }),
        registerEnvironment(connectionString),
      );
      expect(notNamed.code).toBe(REGISTER_EXIT_CODES.refused);
      expect(notNamed.log).toContain("the document names no instance");
      expect(await exists(unknown)).toBe(false);

      // The document's params no longer match the registered config: the
      // trader's own check refuses, and the minted run is rolled back.
      const document = JSON.parse(await readFile(first, "utf8")) as Record<string, unknown>;
      const [instance] = document["instances"] as Record<string, unknown>[];
      const params = instance?.["params"] as Record<string, unknown>;
      const edited = await scratch.write(directory, "edited.json", {
        ...document,
        instances: [{ ...instance, params: { ...params, reentry: { maximum_entries_per_market: 2, cooldown_seconds: 30 } } }],
      });
      const disagreeing = path.join(directory, "disagreeing.json");
      const refused = await runRegister(newRunArgv({ instanceId: ids.instanceId, template: edited, out: disagreeing }), registerEnvironment(connectionString));
      expect(refused.code, refused.log).toBe(REGISTER_EXIT_CODES.refused);
      expect(refused.log).toContain("REGISTER_NEW_RUN_DISAGREES");
      expect(refused.log).toContain("TRADER_REGISTRATION_MISMATCH");
      expect(await exists(disagreeing)).toBe(false);
      expect(await registrationRowCounts(context.db)).toEqual(before);
    });
  }, 180_000);
});

describe("C1-HALTS HALT-PAGES: a new run supersedes only its instance's INFRASTRUCTURE halt rows", () => {
  it("resolves TRANSPORT/STORE/QUEUE/EVENT_UNREADABLE rows of that instance; accounting, order-state and BOOK_DESYNCHRONIZED rows, another instance's, and resolved rows are untouched", async () => {
    await withFreshDatabase("c1-halt-pages", async ({ context }) => {
      const registered = await registerThroughTheRepositories(context, "halt-pages");
      const other = await context.repositories.strategy.createInstance({
        instanceName: "static-bracket-halt-pages-other",
        definitionId: registered.definitionId,
        configId: registered.configId,
        environment: "PAPER",
        accountRef: "paper-account",
        defaultOwnershipMode: "SHADOW",
        evaluationPriority: 1,
      });
      const row = (failureClass: string, scope: { readonly instanceId?: string; readonly marketId?: string }, extra: Record<string, unknown> = {}) => ({
        incident_key: scope.marketId === undefined ? "TRADER_HALT:GLOBAL" : "TRADER_HALT:MARKET",
        environment: "PAPER" as const,
        account_ref: "paper-account",
        severity: "PAGE" as const,
        status: "OPEN" as const,
        failure_class: failureClass,
        action: null,
        market_id: scope.marketId ?? null,
        instance_id: scope.instanceId ?? null,
        detail: `${failureClass} detail`,
        opened_at: "2026-10-08T00:00:00.000Z",
        ...extra,
      });
      const mine = { instanceId: registered.instanceId };
      await context.db
        .insertInto("ops.incidents")
        .values([
          row("TRANSPORT_UNAVAILABLE", mine),
          row("TRANSPORT_RESYNC_REQUIRED", mine),
          row("STORE_UNAVAILABLE", mine),
          row("QUEUE_BACKPRESSURE", mine),
          row("EVENT_UNREADABLE", mine),
          row("ACCOUNTING_REBUILD_MISMATCH", mine),
          row("UNATTRIBUTED_ACTIVITY", mine),
          row("CANCEL_UNRESOLVED", mine),
          row("RUNTIME_PERSISTENCE_FAILED", mine),
          row("BOOK_DESYNCHRONIZED", { marketId: registered.marketId }),
          row("TRANSPORT_UNAVAILABLE", { instanceId: other }),
          row("STORE_UNAVAILABLE", mine, { status: "RESOLVED", resolved_at: "2026-10-08T00:01:00.000Z", resolution: "fixed by hand" }),
        ])
        .execute();

      const lines: string[] = [];
      const resolved = await resolveSupersededHalts(context.db, [{ instanceId: registered.instanceId, runId: registered.runId }], (line) => {
        lines.push(line);
      });
      expect(resolved).toBe(5);
      expect(lines.join("\n")).toContain("halt rows: 5 earlier OPEN infrastructure halt row(s)");

      const rows = await context.db
        .selectFrom("ops.incidents")
        .select(["failure_class", "instance_id", "status", "resolution"])
        .orderBy("incident_id")
        .execute();
      const superseded = `superseded by run ${registered.runId}`;
      // One insert mints the ids in the same millisecond, so their order is not
      // the insert's: compare as a sorted set.
      const sorted = (list: readonly (readonly (string | null)[])[]): string[] => list.map((entry) => JSON.stringify(entry)).sort();
      expect(sorted(rows.map((found) => [found.failure_class, found.instance_id === other ? "other" : found.instance_id === null ? "market" : "mine", found.status, found.resolution]))).toEqual(sorted([
        ["TRANSPORT_UNAVAILABLE", "mine", "RESOLVED", superseded],
        ["TRANSPORT_RESYNC_REQUIRED", "mine", "RESOLVED", superseded],
        ["STORE_UNAVAILABLE", "mine", "RESOLVED", superseded],
        ["QUEUE_BACKPRESSURE", "mine", "RESOLVED", superseded],
        ["EVENT_UNREADABLE", "mine", "RESOLVED", superseded],
        ["ACCOUNTING_REBUILD_MISMATCH", "mine", "OPEN", null],
        ["UNATTRIBUTED_ACTIVITY", "mine", "OPEN", null],
        ["CANCEL_UNRESOLVED", "mine", "OPEN", null],
        ["RUNTIME_PERSISTENCE_FAILED", "mine", "OPEN", null],
        ["BOOK_DESYNCHRONIZED", "market", "OPEN", null],
        ["TRANSPORT_UNAVAILABLE", "other", "OPEN", null],
        ["STORE_UNAVAILABLE", "mine", "RESOLVED", "fixed by hand"],
      ]));

      // A failure is logged and refuses nothing: the rows stay as they are.
      const failing = await resolveSupersededHalts(
        context.db,
        [{ instanceId: "not-a-uuid", runId: registered.runId }],
        (line) => {
          lines.push(line);
        },
      );
      expect(failing).toBeUndefined();
      expect(lines.at(-1)).toContain("could not be marked superseded");
    });
  }, 180_000);
});
