/**
 * WP-340, packet scenario 4: THE INDEPENDENT CANCEL PATH. `ops-cli cancel-all`
 * (WP-330's `runOpsCli`, the whole invocation: the signer gate, the audit,
 * the scoped confirmation, the budget, the venue session, the command) runs
 * against the mock CLOB in a live-shaped test context while the trader
 * process is DOWN and its database UNREACHABLE.
 *
 * - The trader (`bootNode`: WP-270's OMS over WP-260's client, WP-290's
 *   coordinator, WP-280's manager) places orders under its own API key, then
 *   dies mid-session; one order is part-filled, and the account also holds an
 *   order the trader never knew (placed by another tool of the account).
 * - The trader's database is then made unreachable: its OMS store and its
 *   reconciliation journal's durable sink reject every call, and are counted.
 * - The CLI gets ONLY its own ports (handoff §15, ADR-008 §6): the emergency
 *   credential (an opaque `{ accountRef }`, no secret), a venue factory that
 *   builds WP-260's REAL client over the mock CLOB under the SEPARATE
 *   `emergency` API key (built with the gate context the CLI hands it, as
 *   WP-330's own `secure-client.test.ts` does: the signer gate makes a
 *   credential-free live-shaped context impossible otherwise, so the CLI's
 *   injected ports are used), the venue's authenticated reads, a real file
 *   audit log, an audit mirror whose database is unreachable, and a lease
 *   store that THROWS if it is ever opened.
 *
 * Asserted: every open order of the account is canceled at the venue; the
 * audit file holds INVOKED, ACTING and OUTCOME, in order, durable, mode 0600,
 * with no credential or signature in it; the CLI never touched the trader's
 * store, journal, process or lease store; and when the trader comes back,
 * its reconciliation reflects the emergency cancels. Under the repository's
 * PAPER flags, the same invocation is refused before any port is touched.
 *
 * Venue assumptions in play (`docs/experiments/phase-3-verification.md`):
 * A1 (one account's API keys see and cancel its orders), A2 (whose orders
 * `DELETE /cancel-all` cancels; both readings are run), A9 (the 429 a cancel
 * blocked by D-21 gets, and its `Retry-After`). The two keys are keys of ONE
 * signer, so they share its rate-limit buckets (§8): one case runs the CLI
 * against the trader's D-21 debt. No credential exists anywhere in this
 * test: the "emergency credential" is a label.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileAuditLog, type AuditMirror, type AuditRecord } from "../../../apps/ops-cli/src/emergency/audit-log.js";
import {
  LEASES_FORBIDDEN,
  LIVE_FLAGS,
  NON_INTERACTIVE,
  PAPER_FLAGS,
  testConfiguration,
  uuidSource,
} from "../../../apps/ops-cli/src/emergency/harness.test-support.js";
import type { EmergencyVenueFactory, OpsClock } from "../../../apps/ops-cli/src/emergency/ports.js";
import { runOpsCli, type OpsCliDependencies } from "../../../apps/ops-cli/src/emergency/run.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import type { RateLimitObservation } from "../../../packages/polymarket-secure/src/index.js";
import {
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  FAKE_SDK_CREDENTIALS,
  installNetworkTripwire,
  type NetworkTripwire,
} from "../../../packages/polymarket-secure/src/testing/index.js";
import { STANDARD_TIER } from "./support/mock-clob.js";
import { bootNode, liveWorld, NO, reconcileUntilResumedOrReviewed, YES, type LiveWorld } from "./support/live-node.js";
import { atRest, recoveryProblems, signaturesIn } from "./support/oracle.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

let tripwire: NetworkTripwire;
let scratch: string;
beforeEach(() => {
  tripwire = installNetworkTripwire();
  scratch = mkdtempSync(path.join(tmpdir(), "wp340-ops-cli-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

/** The account the operator names (the emergency credential acts for it). */
const ACCOUNT = "acct-live-1";
const OPERATOR = "operator-ana";
const G_YES = group(34601, { tokenId: YES, plannedShares: "5" });
const G_NO = group(34602, { tokenId: NO, plannedShares: "5" });

interface Downed {
  readonly world: LiveWorld;
  readonly openBefore: readonly string[];
  /** How many requests the venue had logged when the trader died. */
  readonly loggedAtDeath: number;
  /** Every call the dead trader's database received after it became unreachable. */
  readonly databaseCalls: string[];
}

/**
 * A trader that placed orders, part-filled one, and died; then its database became unreachable. With `debtSweep`,
 * the trader's own last cancel was a market sweep of that many resting orders, which put the cancel bucket of the
 * signer it SHARES with the emergency key into D-21 debt (J4, WP-340 r1).
 */
async function traderDownDatabaseUnreachable(cancelAllScope: "CREDENTIAL" | "ACCOUNT", debtSweep = 0): Promise<Downed> {
  const world = await liveWorld({ cancelAllScope });
  const headers: RateLimitObservation[] = [];
  const trader = await bootNode(world, { credential: "trader", source: "trader", onRateLimitUpdate: (observation) => void headers.push(observation) });
  expect(await reconcileUntilResumedOrReviewed(world, trader)).toBe(true);
  const oms = trader.oms as OrderManager;
  for (const spec of [G_YES, G_NO]) expect((await oms.registerGroup(spec)).ok).toBe(true);
  if (debtSweep > 0) {
    for (let index = 0; index < debtSweep; index += 1) world.clob.placeForeign({ tokenId: NO, side: "BUY", price: "0.1", size: "1" });
    const swept = await trader.client.cancelMarketOrders({ assetId: NO });
    expect(swept.kind === "COMPLETED" ? swept.canceled.length : -1).toBe(debtSweep);
    // D-21: 120 − 1 (up front) − one per order canceled, on the bucket of the signer the trader shares with the emergency key.
    expect(headers.at(-1)).toMatchObject({ bucket: "cancel", remaining: STANDARD_TIER.cancelBurst - 1 - debtSweep });
  }
  expect((await oms.submit(ticket(G_YES, { n: 1, shares: "2" }))).ok).toBe(true);
  expect((await oms.submit(ticket(G_NO, { n: 2, shares: "1" }))).ok).toBe(true);
  world.clob.match(world.clob.receipts[0] as string, "0.5");
  await world.time.advance(0);
  // An order of the account the trader never knew (another tool, the website): cancel-all must not depend on trader state.
  world.clob.placeForeign({ tokenId: YES, side: "BUY", price: "0.2", size: "3" });
  // The trader dies mid-session.
  trader.reap();
  const loggedAtDeath = world.clob.log.length;
  // Its database becomes unreachable: every call is refused, and counted.
  const databaseCalls: string[] = [];
  const unreachable = (name: string) => (): Promise<never> => {
    databaseCalls.push(name);
    return Promise.reject(new Error("connect ECONNREFUSED (synthetic): the trader database is unreachable"));
  };
  world.u.store.apply = unreachable("oms.store.apply");
  world.u.store.load = unreachable("oms.store.load");
  // The reconciliation journal's durable sink (the same database) refuses appends too.
  Object.defineProperty(world.u.journalEvents, "push", {
    configurable: true,
    value: () => {
      databaseCalls.push("journal.append");
      throw new Error("connect ECONNREFUSED (synthetic): the trader database is unreachable");
    },
  });
  const openBefore = [...world.clob.orders.values()].filter((order) => order.status === "LIVE").map((order) => order.venueOrderId);
  expect(openBefore).toHaveLength(3);
  return { world, openBefore, loggedAtDeath, databaseCalls };
}

interface Cli {
  readonly deps: OpsCliDependencies;
  readonly output: string[];
  readonly auditPath: string;
  readonly mirrorAttempts: AuditRecord[];
  readonly opened: { venues: number; credentials: number };
}

function cli(world: LiveWorld, flags: Readonly<Record<string, string>>, argv: readonly string[]): Cli {
  const output: string[] = [];
  const auditPath = path.join(scratch, "ops-cli-audit.jsonl");
  const mirrorAttempts: AuditRecord[] = [];
  const opened = { venues: 0, credentials: 0 };
  // The audit's database copy: that database is unreachable too (best effort; never gates the command).
  const mirror: AuditMirror = {
    append: (record) => {
      mirrorAttempts.push(record);
      return Promise.reject(new Error("connect ECONNREFUSED (synthetic)"));
    },
  };
  const clock: OpsClock = { nowMs: () => world.time.epochMs(), sleep: (ms) => world.time.advance(ms) };
  const venues: EmergencyVenueFactory = {
    open: async ({ gate, onRateLimitUpdate }) => {
      opened.venues += 1;
      // WP-260's REAL client, built with the context the CLI's gate permitted, under the SEPARATE emergency API key.
      const cancels = await createSecureVenueClientForTesting(
        { runModeContext: { ...gate }, signer: createMockSignerHandle().handle, onRateLimitUpdate },
        world.clob.sdk("emergency", { source: "ops-cli" }),
      );
      return { kind: "OPEN" as const, venue: { cancels, reads: world.clob.readPort() } };
    },
  };
  const deps: OpsCliDependencies = {
    argv,
    runModeFlags: flags,
    defaultAuditLogPath: auditPath,
    out: { line: (text: string) => void output.push(text) },
    prompt: NON_INTERACTIVE,
    clock,
    newId: uuidSource(world.time.epochMs()),
    openAuditLog: (target: string) => createFileAuditLog(target),
    auditMirror: mirror,
    configuration: { load: () => Promise.resolve({ kind: "LOADED" as const, document: testConfiguration() }) },
    credentials: {
      load: (request) => {
        opened.credentials += 1;
        return Promise.resolve({ kind: "LOADED" as const, credential: { accountRef: request.accountRef } });
      },
    },
    venues,
    leases: LEASES_FORBIDDEN,
    projection: null,
  };
  return { deps, output, auditPath, mirrorAttempts, opened };
}

const CANCEL_ALL = ["cancel-all", "--account", ACCOUNT, "--operator", OPERATOR, "--reason", "incident 340: the trader is down", "--confirm", `cancel-all:${ACCOUNT}`];

function auditRecords(file: string): AuditRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

describe("WP-340 scenario 4: ops-cli cancel-all with the trader down and its database unreachable", () => {
  for (const scope of ["CREDENTIAL", "ACCOUNT"] as const) {
    it(`cancels every open order of the account (cancel-all scope ${scope}, A2), with a complete audit trail and no trader-state dependency`, async () => {
      const down = await traderDownDatabaseUnreachable(scope);
      const run = cli(down.world, LIVE_FLAGS, CANCEL_ALL);
      const outcome = await runOpsCli(run.deps);
      expect(outcome, run.output.join("\n")).toEqual({ exitName: "COMPLETED", exitCode: 0 });

      // The venue: nothing of the account rests, the trader's orders and the foreign one included.
      expect([...down.world.clob.orders.values()].filter((order) => order.status === "LIVE")).toEqual([]);
      const byCli = down.world.clob.log.filter((entry) => entry.source === "ops-cli" && entry.effective);
      expect(byCli.every((entry) => entry.credential === "emergency")).toBe(true);
      const canceledByCli = new Set(byCli.flatMap((entry) => (entry.kind === "CANCEL_ALL" ? entry.detail.split(",") : [entry.detail])));
      expect([...canceledByCli].sort()).toEqual([...down.openBefore].sort());
      // A2: under the credential-scoped reading, DELETE /cancel-all cancels nothing the trader's key placed; the
      // by-id sweep of venue truth does.
      if (scope === "CREDENTIAL") expect(byCli.filter((entry) => entry.kind === "CANCEL").length).toBe(3);

      // No trader-state dependency: the trader's database was never asked, its lease store never opened, and the
      // trader's process is gone (only the CLI's own ports were touched).
      expect(down.databaseCalls).toEqual([]);
      expect(run.opened).toEqual({ venues: 1, credentials: 1 });
      expect(down.world.clob.log.slice(down.loggedAtDeath).filter((entry) => entry.source !== "ops-cli")).toEqual([]);

      // The audit trail: three durable records, in order, one invocation, mode 0600, the outcome stated.
      const records = auditRecords(run.auditPath);
      expect(records.map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
      expect(new Set(records.map((record) => record.invocationId)).size).toBe(1);
      expect(records.map((record) => record.sequence)).toEqual([0, 1, 2]);
      expect(records.every((record) => record.command === "cancel-all" && record.accountRef === ACCOUNT && record.operator === OPERATOR)).toBe(true);
      // INVOKED is written before the gate's permission is acted on; ACTING and OUTCOME carry the permitted mode.
      expect(records.map((record) => record.runMode)).toEqual([null, "LIVE_MICRO", "LIVE_MICRO"]);
      expect(records[0]?.detail).toMatchObject({ gate: { permitted: true, runMode: "LIVE_MICRO" }, confirmGiven: true });
      // ACTING, written BEFORE any cancel was sent, names the venue truth it planned against: the dead trader's
      // orders and the one it never knew.
      expect(records[1]?.detail).toMatchObject({ scope: `cancel-all:${ACCOUNT}`, listedBefore: { count: 3 } });
      expect(records[2]?.detail).toMatchObject({ exit: "COMPLETED", exitCode: 0, verified: true });
      expect(statSync(run.auditPath).mode & 0o777).toBe(0o600);
      // The unreachable mirror was tried for each record, and never gated the command.
      expect(run.mirrorAttempts.map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
      // Nothing secret anywhere it wrote: the SDK object's fake L2 credential, or any signature the venue issued.
      const written = `${readFileSync(run.auditPath, "utf8")}\n${run.output.join("\n")}`;
      for (const value of Object.values(FAKE_SDK_CREDENTIALS)) expect(written).not.toContain(value);
      expect(signaturesIn(down.world, written)).toEqual([]);
    });
  }

  it("when the trader comes back, its restart reconciles to the emergency cancels: every order CANCELED (one part-filled), nothing resting, the account consistent and resumed", async () => {
    const down = await traderDownDatabaseUnreachable("CREDENTIAL");
    const run = cli(down.world, LIVE_FLAGS, CANCEL_ALL);
    expect((await runOpsCli(run.deps)).exitName).toBe("COMPLETED");
    // The database is reachable again (the incident is over): restore the store's own methods.
    const store = down.world.u.store as unknown as Record<string, unknown>;
    delete store["apply"];
    delete store["load"];
    delete (down.world.u.journalEvents as unknown as Record<string, unknown>)["push"];
    expect(down.databaseCalls).toEqual([]);
    const trader = await bootNode(down.world, { credential: "trader", source: "trader" });
    const resumed = await reconcileUntilResumedOrReviewed(down.world, trader);
    const oms = trader.oms as OrderManager;
    expect(oms.orders().map((order) => [order.state, order.filledShares]).sort()).toEqual([
      ["CANCELED", "0"],
      ["CANCELED", "0.5"],
    ]);
    expect(oms.orders().every((order) => order.reservation.released)).toBe(true);
    // The order the trader never knew was canceled unmatched before the restart: no activity of it is left to attribute.
    expect(down.world.clob.openOrderIds()).toEqual([]);
    expect(recoveryProblems(down.world, trader, resumed)).toEqual([]);
    // No halt was released or refused by the recovery driver on the way (J1, WP-340 r1).
    expect(down.world.findings).toEqual([]);
    expect(down.world.refusedReleases).toEqual([]);
    expect(signaturesIn(down.world, atRest(down.world))).toEqual([]);
  });

  it("the trader's last market sweep left the cancel bucket of the signer it SHARES with the emergency key in D-21 debt: the CLI's DELETE /cancel-all is refused 429, its by-id sweep waits out Retry-After and cancels every order; COMPLETED, verified, the 429 audited", async () => {
    // The trader's sweep: 120 − 1 (up front) − 140 (one per order canceled) = −21 (§8, D-21).
    const down = await traderDownDatabaseUnreachable("CREDENTIAL", 140);
    const run = cli(down.world, LIVE_FLAGS, CANCEL_ALL);
    const outcome = await runOpsCli(run.deps);
    expect(outcome, run.output.join("\n")).toEqual({ exitName: "COMPLETED", exitCode: 0 });
    expect([...down.world.clob.orders.values()].filter((order) => order.status === "LIVE")).toEqual([]);
    // The venue's record: the cancel-all was refused (the trader's debt, not the CLI's own spend), then the sweep acted.
    const byCli = down.world.clob.log.filter((entry) => entry.source === "ops-cli");
    expect(byCli.map((entry) => [entry.kind, entry.effective])).toEqual([["CANCEL_ALL", false], ["CANCEL", true], ["CANCEL", true], ["CANCEL", true]]);
    expect(byCli[0]?.detail).toBe("cancel-all:429");
    expect(byCli.filter((entry) => entry.effective).map((entry) => entry.detail).sort()).toEqual([...down.openBefore].sort());
    // The audit states what happened: one UNKNOWN (RATE_LIMITED) answer, one COMPLETED sweep, verified by a final read.
    const records = auditRecords(run.auditPath);
    expect(records.map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(records[2]?.detail).toMatchObject({
      exit: "COMPLETED",
      verified: true,
      attempts: { count: 2, answers: { COMPLETED: 1, UNKNOWN: 1 }, itemized: [expect.objectContaining({ endpoint: "DELETE /cancel-all", errorKind: "RATE_LIMITED" }), expect.objectContaining({ endpoint: "DELETE /orders", canceled: 3 })] },
    });
    expect(down.databaseCalls).toEqual([]);
    // The premise: one signer, so one pair of buckets, for both keys.
    expect(down.world.clob.signerOf("trader")).toBe(down.world.clob.signerOf("emergency"));
  });

  it("under the repository's PAPER flags the same invocation is refused by the signer gate before any configuration, credential, venue or lease is touched, and every order stays", async () => {
    const down = await traderDownDatabaseUnreachable("CREDENTIAL");
    const run = cli(down.world, PAPER_FLAGS, CANCEL_ALL);
    const outcome = await runOpsCli(run.deps);
    expect(outcome).toEqual({ exitName: "RUN_MODE_REFUSED", exitCode: 4 });
    expect(run.opened).toEqual({ venues: 0, credentials: 0 });
    expect([...down.world.clob.orders.values()].filter((order) => order.status === "LIVE")).toHaveLength(3);
    expect(down.world.clob.log.some((entry) => entry.source === "ops-cli")).toBe(false);
    // It still audits that it was asked, and refused.
    expect(auditRecords(run.auditPath).map((record) => record.phase)).toEqual(["INVOKED", "OUTCOME"]);
  });
});
