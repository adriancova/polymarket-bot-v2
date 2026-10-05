/**
 * Work-plan WP-330 acceptance 2: "Output is explicit and audited" (design
 * requirements 1 and 3).
 *
 * - Explicit: every command prints PLAN, RESULT, UNKNOWN and OUTCOME, in that
 *   order, and the exit code is distinct per outcome.
 * - Audited: every invocation (a refusal or a usage error included) appends to
 *   an append-only LOCAL log, each record written and fsynced before the CLI
 *   goes on: INVOKED before anything is touched, ACTING before the first
 *   destructive call, OUTCOME after. A log that cannot be written stops the
 *   command before it acts. The database copy is best effort.
 * - No secret reaches the log or the output.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_SCHEMA, AuditUnavailableError, createFileAuditLog, NODE_AUDIT_FILE_SYSTEM, type AuditFileSystem, type AuditMirror, type AuditRecord, type AuditSink } from "./audit-log.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  ACCOUNT,
  args,
  CONDITION,
  DESTRUCTIVE_REASON,
  fakeLeases,
  harness,
  LEASE_ID,
  OPERATOR,
  order,
  PAPER_FLAGS,
  phases,
} from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
let scratch: string;
beforeEach(async () => {
  tripwire = installNetworkTripwire();
  scratch = await mkdtemp(path.join(tmpdir(), "ops-cli-audit-"));
});
afterEach(async () => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  await rm(scratch, { recursive: true, force: true });
});

const SECTION_ORDER = ["PLAN (what will happen):", "RESULT (what happened):", "UNKNOWN (what is not known):", "OUTCOME:"];

function sectionsInOrder(text: string): boolean {
  let at = -1;
  for (const section of SECTION_ORDER) {
    const next = text.indexOf(section, at + 1);
    if (next <= at) return false;
    at = next;
  }
  return true;
}

describe("acceptance 2: explicit output", () => {
  const invocations: readonly (readonly [string, string[]])[] = [
    ["cancel-all", args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)],
    ["cancel-order", args("cancel-order", "o-1", ...DESTRUCTIVE_REASON, "--confirm", `cancel-order:o-1@${ACCOUNT}`)],
    ["cancel-market", args("cancel-market", CONDITION, ...DESTRUCTIVE_REASON, "--confirm", `cancel-market:${CONDITION}@${ACCOUNT}`)],
    ["account-snapshot", args("account-snapshot")],
    ["reconcile", args("reconcile")],
    ["stop-heartbeat", args("stop-heartbeat", ...DESTRUCTIVE_REASON, "--confirm", `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`)],
    ["cancel-all --dry-run", args("cancel-all", ...DESTRUCTIVE_REASON, "--dry-run")],
    ["cancel-all, unconfirmed", args("cancel-all", ...DESTRUCTIVE_REASON)],
  ];
  for (const [label, argv] of invocations) {
    it(`${label}: PLAN, RESULT, UNKNOWN and OUTCOME are all printed, in order, with the exit code`, async () => {
      const h = harness();
      h.venue.add(order("o-1"));
      const leases = fakeLeases();
      const outcome = await runOpsCli(h.deps(argv, { leases: leases.factory }));
      const text = h.text();
      expect(sectionsInOrder(text), text).toBe(true);
      expect(text).toContain(`${outcome.exitName} (exit ${String(outcome.exitCode)})`);
    });
  }

  it("every exit name has its own code", () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT_CODES.COMPLETED).toBe(0);
  });
});

describe("acceptance 2: every invocation is audited, durably, before it acts", () => {
  it("records share one invocation id, run in sequence, and carry the operator, the account, the reason and the run mode", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)));
    const records = h.audit.records;
    expect(phases(records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(new Set(records.map((record) => record.invocationId)).size).toBe(1);
    expect(records.map((record) => record.sequence)).toEqual([0, 1, 2]);
    expect(new Set(records.map((record) => record.recordId)).size).toBe(3);
    for (const record of records) {
      expect(record.schema).toBe(AUDIT_SCHEMA);
      expect(record.command).toBe("cancel-all");
      expect(record.operator).toBe(OPERATOR);
      expect(record.accountRef).toBe(ACCOUNT);
      expect(record.reason).toBe(DESTRUCTIVE_REASON[1]);
    }
    expect(records[0]?.runMode).toBeNull();
    expect(records[2]?.runMode).toBe("LIVE_MICRO");
  });

  it("INVOKED is durable before the configuration, the credential or the venue is touched", async () => {
    const h = harness();
    const touchedAtAppend: number[] = [];
    const sink = h.audit;
    const original = sink.append.bind(sink);
    sink.append = (record: AuditRecord) => {
      touchedAtAppend.push(h.touched.length);
      return original(record);
    };
    await runOpsCli(h.deps(args("account-snapshot")));
    expect(touchedAtAppend[0]).toBe(0);
  });

  it("ACTING is durable before the first cancel reaches the venue", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    const atCancel: string[][] = [];
    h.venue.beforeCall = (method) => {
      if (method.startsWith("cancel")) atCancel.push(phases(h.audit.records));
    };
    await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)));
    expect(atCancel).toEqual([["INVOKED", "ACTING"]]);
  });

  it("the INVOKED record cannot be written: AUDIT_UNAVAILABLE, and nothing is touched", async () => {
    const h = harness();
    h.audit.failOn = "INVOKED";
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)));
    expect(outcome.exitName).toBe("AUDIT_UNAVAILABLE");
    expect(outcome.exitCode).toBe(EXIT_CODES.AUDIT_UNAVAILABLE);
    expect(h.touched).toEqual([]);
    expect(h.venue.calls).toEqual([]);
  });

  it("the ACTING record cannot be written: AUDIT_UNAVAILABLE, and no cancel is sent", async () => {
    const h = harness();
    h.audit.failOn = "ACTING";
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)));
    expect(outcome.exitName).toBe("AUDIT_UNAVAILABLE");
    expect(h.venue.callsOf("cancelAll")).toEqual([]);
    expect(h.venue.open()).toHaveLength(1);
    expect(h.text()).toContain("the ACTING record could not be written");
  });

  it("the ACTING record cannot be written: stop-heartbeat revokes nothing", async () => {
    const h = harness();
    h.audit.failOn = "ACTING";
    const leases = fakeLeases();
    const outcome = await runOpsCli(h.deps(args("stop-heartbeat", ...DESTRUCTIVE_REASON, "--confirm", `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`), { leases: leases.factory }));
    expect(outcome.exitName).toBe("AUDIT_UNAVAILABLE");
    expect(leases.revoked).toEqual([]);
  });

  it("no audit log at all: AUDIT_UNAVAILABLE, nothing touched", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(args("account-snapshot"), { defaultAuditLogPath: null }));
    expect(outcome.exitName).toBe("AUDIT_UNAVAILABLE");
    expect(h.touched).toEqual([]);
    expect(h.text()).toContain("pass --audit-log <path> or set OPS_CLI_AUDIT_LOG");
  });

  it("a usage error is audited too, when a log is named", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(["cancel-all", "--account", ACCOUNT, "--operator", OPERATOR, "--yes"]));
    expect(outcome.exitName).toBe("USAGE");
    expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
    expect(h.audit.records[0]?.detail["usageError"]).toMatch(/a bare yes names no scope/u);
    expect(h.audit.records[0]?.operator).toBe(OPERATOR);
  });

  it("a refused run mode is audited (INVOKED with the gate's reasons, OUTCOME)", async () => {
    const h = harness();
    await runOpsCli(h.deps(args("account-snapshot"), { runModeFlags: PAPER_FLAGS }));
    expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
    expect(h.audit.records[1]?.detail["gateReasons"]).toEqual(["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"]);
  });

  it("the database copy: every record is mirrored when it works, and the local log stays the record of truth", async () => {
    const mirrored: AuditRecord[] = [];
    const database: AuditMirror = { append: (record) => (mirrored.push(record), Promise.resolve()) };
    const h = harness({ mirror: database });
    h.venue.add(order("o-1"));
    await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`)));
    expect(mirrored.map((record) => record.recordId)).toEqual(h.audit.records.map((record) => record.recordId));
    expect(h.text()).toContain("database copy (ops.config_change_audit): 3 landed, 0 failed, 0 still pending");
  });
});

describe("acceptance 2: the real file log, end to end", () => {
  it("cancel-all appends three JSON lines to the file; each is written and fsynced, the ACTING one before the venue's cancel", async () => {
    const file = path.join(scratch, "audit.jsonl");
    const events: string[] = [];
    const observed: AuditFileSystem = {
      async open(target, flags, mode) {
        const handle = await NODE_AUDIT_FILE_SYSTEM.open(target, flags, mode);
        const name = target === file ? "file" : "dir";
        return {
          write: async (data) => (events.push(`${name}:write`), handle.write(data)),
          sync: async () => (events.push(`${name}:sync`), handle.sync()),
          stat: () => handle.stat(),
          close: async () => (events.push(`${name}:close`), handle.close()),
        };
      },
    };
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    h.venue.beforeCall = (method) => {
      if (method === "cancelAll") events.push("venue:cancelAll");
    };
    const outcome = await runOpsCli(
      h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", file), { openAuditLog: (target) => createFileAuditLog(target, observed) }),
    );
    expect(outcome.exitName).toBe("COMPLETED");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as AuditRecord).phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    // write, sync, close for each record, then its directory synced (every record: WP-330 r2, CX330-R2-01);
    // the cancel only after the ACTING record's directory sync.
    expect(events).toEqual([
      "file:write",
      "file:sync",
      "file:close",
      "dir:sync",
      "dir:close",
      "file:write",
      "file:sync",
      "file:close",
      "dir:sync",
      "dir:close",
      "venue:cancelAll",
      "file:write",
      "file:sync",
      "file:close",
      "dir:sync",
      "dir:close",
    ]);
  });

  it("nothing secret reaches the log or the output: a credential that carries secrets is never read past its account", async () => {
    const file = path.join(scratch, "audit.jsonl");
    const secret = "SECRET-WP330-must-never-appear";
    const h = harness();
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(
      h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", file), {
        openAuditLog: (target) => createFileAuditLog(target),
        credentials: {
          load: () => Promise.resolve({ kind: "LOADED" as const, credential: { accountRef: ACCOUNT, apiKey: secret, secret, passphrase: secret, privateKey: secret } as { accountRef: string } }),
        },
      }),
    );
    expect(outcome.exitName).toBe("COMPLETED");
    expect(await readFile(file, "utf8")).not.toContain(secret);
    expect(h.text()).not.toContain(secret);
  });
});

describe("WP330-V1-01: an OUTCOME that cannot be written never lets the command's own exit stand", () => {
  const CANCEL_ALL = args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`);

  it("the OUTCOME WRITE fails after the cancel: OUTCOME_UNRECORDED (18), and the output says the command MAY ALREADY HAVE ACTED", async () => {
    const h = harness();
    h.audit.failOn = "OUTCOME";
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(h.deps(CANCEL_ALL));
    expect(EXIT_CODES.OUTCOME_UNRECORDED).toBe(18);
    expect(outcome.exitName).toBe("OUTCOME_UNRECORDED");
    expect(outcome.exitCode).toBe(18);
    // It did act: the cancel was sent and applied; only its record is missing.
    expect(h.venue.callsOf("cancelAll")).toHaveLength(1);
    expect(h.venue.open()).toEqual([]);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING"]);
    expect(h.text()).toContain("the OUTCOME record could NOT be written to memory://ops-cli-audit (WRITE_FAILED). The command MAY ALREADY HAVE ACTED");
    expect(h.text()).toContain("OUTCOME_UNRECORDED (exit 18): the command's own outcome, COMPLETED (exit 0), is NOT in the audit log");
    // Not the pre-action wording.
    expect(h.text()).not.toMatch(/Nothing was done|nothing was sent/u);
  });

  it("the OUTCOME FSYNC fails after the cancel, through the real file sink: OUTCOME_UNRECORDED (18)", async () => {
    const file = path.join(scratch, "audit.jsonl");
    let fileSyncs = 0;
    const failingThirdSync: AuditFileSystem = {
      async open(target, flags, mode) {
        const handle = await NODE_AUDIT_FILE_SYSTEM.open(target, flags, mode);
        return {
          write: (data) => handle.write(data),
          sync: async () => {
            if (target === file) {
              fileSyncs += 1;
              if (fileSyncs === 3) throw Object.assign(new Error("EIO"), { code: "EIO" });
            }
            return handle.sync();
          },
          stat: () => handle.stat(),
          close: () => handle.close(),
        };
      },
    };
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    const outcome = await runOpsCli(h.deps([...CANCEL_ALL, "--audit-log", file], { openAuditLog: (target) => createFileAuditLog(target, failingThirdSync) }));
    expect(outcome.exitName).toBe("OUTCOME_UNRECORDED");
    expect(outcome.exitCode).toBe(EXIT_CODES.OUTCOME_UNRECORDED);
    expect(h.venue.open()).toEqual([]);
    expect(h.text()).toContain("(SYNC_FAILED). The command MAY ALREADY HAVE ACTED");
  });

  it("no ACTING record (a PAPER refusal) and the OUTCOME cannot be written: OUTCOME_UNRECORDED too, and the output says nothing was sent", async () => {
    const h = harness();
    h.audit.failOn = "OUTCOME";
    const outcome = await runOpsCli(h.deps(CANCEL_ALL, { runModeFlags: PAPER_FLAGS }));
    expect(outcome.exitName).toBe("OUTCOME_UNRECORDED");
    expect(phases(h.audit.records)).toEqual(["INVOKED"]);
    expect(h.text()).toContain("No ACTING record was written, so this invocation sent no cancel and revoked no lease");
    expect(h.text()).toContain("the command's own outcome, RUN_MODE_REFUSED (exit 4), is NOT in the audit log");
    expect(h.touched).toEqual([]);
  });

  it("an OUTCOME refused as too large is written again with the exit alone (detailOmitted): the outcome is never lost to its own size", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    let refusedOnce = false;
    const sink: AuditSink = {
      location: h.audit.location,
      append(record: AuditRecord): Promise<void> {
        if (record.phase === "OUTCOME" && !refusedOnce) {
          refusedOnce = true;
          return Promise.reject(new AuditUnavailableError("RECORD_TOO_LARGE", h.audit.location));
        }
        return h.audit.append(record);
      },
    };
    const outcome = await runOpsCli(h.deps(CANCEL_ALL, { openAuditLog: () => sink }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(h.audit.records[2]?.sequence).toBe(2);
    expect(h.audit.records[2]?.detail).toEqual({ exit: "COMPLETED", exitCode: 0, detailOmitted: "RECORD_TOO_LARGE" });
    expect(h.text()).toContain("so it records the exit alone (detailOmitted)");
  });
});

describe("WP330-V1-02: a FIFO at the audit-log path is refused at once, never waited on", () => {
  it("a FIFO with no reader: AUDIT_UNAVAILABLE (OPEN_FAILED) at once, and nothing is touched", async () => {
    const fifo = path.join(scratch, "audit.fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const h = harness();
    h.venue.add(order("o-1"));
    const run = runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", fifo), { openAuditLog: (target) => createFileAuditLog(target) }));
    try {
      const settled = await Promise.race([run, new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 2_000))]);
      expect(settled).not.toBe("HUNG");
      expect(settled).toMatchObject({ exitName: "AUDIT_UNAVAILABLE" });
      expect(h.text()).toContain("could not record this invocation (OPEN_FAILED). Nothing was done");
      expect(h.touched).toEqual([]);
      expect(h.venue.calls).toEqual([]);
    } finally {
      // Release a writer blocked in open(2) (fb9edcc's flags), so no thread is left behind.
      const reader = await open(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      await reader.close();
      await run.catch(() => undefined);
    }
  });
});

describe("WP-330 r2 (CX330-R2-01): no invocation acts before the log's directory entry is durable, whoever created the file", () => {
  const cancelAll = (file: string): string[] => args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", file);
  const eio = (): Error => Object.assign(new Error("EIO"), { code: "EIO" });

  /** The real file system, observed; the directory's `fsync` goes through `directorySync`, which is handed the real one. */
  function observedFileSystem(file: string, events: string[], directorySync: (real: () => Promise<void>) => Promise<void> = (real) => real()): AuditFileSystem {
    return {
      async open(target, flags, mode) {
        const handle = await NODE_AUDIT_FILE_SYSTEM.open(target, flags, mode);
        const name = target === file ? "file" : "dir";
        return {
          write: (data) => handle.write(data),
          sync: async () => {
            await (name === "dir" ? directorySync(() => handle.sync()) : handle.sync());
            events.push(`${name}:synced`);
          },
          stat: () => handle.stat(),
          close: () => handle.close(),
        };
      },
    };
  }

  /** The directory syncs that SUCCEEDED before the venue's first cancel-all. */
  function directorySyncsBeforeCancel(events: readonly string[]): number {
    const cancelAt = events.indexOf("venue:cancelAll");
    expect(cancelAt).toBeGreaterThan(-1);
    return events.slice(0, cancelAt).filter((event) => event === "dir:synced").length;
  }

  it("the retry, the directory sync still failing: the invocation that finds the file refuses too (AUDIT_UNAVAILABLE), and nothing is touched", async () => {
    const file = path.join(scratch, "audit.jsonl");
    const failing = observedFileSystem(file, [], () => Promise.reject(eio()));
    for (const attempt of ["creates the file", "finds the file"]) {
      const h = harness();
      h.venue.add(order("o-1"));
      const outcome = await runOpsCli(h.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target, failing) }));
      expect(outcome.exitName, attempt).toBe("AUDIT_UNAVAILABLE");
      expect(outcome.exitCode).toBe(EXIT_CODES.AUDIT_UNAVAILABLE);
      expect(h.text()).toContain(`the audit log ${file} could not record this invocation (DIRECTORY_SYNC_FAILED). Nothing was done`);
      expect(h.touched, attempt).toEqual([]);
      expect(h.venue.calls, attempt).toEqual([]);
      expect(h.venue.open()).toHaveLength(1);
    }
  });

  it("the retry after ONE failed directory sync: the next invocation cancels only after its own INVOKED and ACTING records' directory syncs have succeeded", async () => {
    const file = path.join(scratch, "audit.jsonl");
    const events: string[] = [];
    let failures = 1;
    const fileSystem = observedFileSystem(file, events, async (real) => {
      if (failures > 0) {
        failures -= 1;
        throw eio();
      }
      await real();
    });
    const first = harness();
    first.venue.add(order("o-1"));
    expect((await runOpsCli(first.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target, fileSystem) }))).exitName).toBe("AUDIT_UNAVAILABLE");
    expect(first.venue.calls).toEqual([]);

    const second = harness();
    second.venue.add(order("o-1"));
    second.venue.beforeCall = (method) => {
      if (method === "cancelAll") events.push("venue:cancelAll");
    };
    const outcome = await runOpsCli(second.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target, fileSystem) }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(directorySyncsBeforeCancel(events)).toBe(2);
  });

  it("overlapping creation: while the creator's directory sync is still pending, a second invocation on the same log cancels only after directory syncs of its own", async () => {
    const file = path.join(scratch, "audit.jsonl");
    let signalBlocked: (() => void) | undefined;
    const creatorBlocked = new Promise<void>((resolve) => (signalBlocked = resolve));
    let releaseCreator: (() => void) | undefined;
    const creatorReleased = new Promise<void>((resolve) => (releaseCreator = resolve));
    const creatorEvents: string[] = [];
    let creatorDirectorySyncs = 0;
    const creatorFileSystem = observedFileSystem(file, creatorEvents, async (real) => {
      creatorDirectorySyncs += 1;
      if (creatorDirectorySyncs === 1) {
        signalBlocked?.();
        await creatorReleased;
      }
      await real();
    });
    const creatorHarness = harness();
    creatorHarness.venue.add(order("o-1"));
    const creatorRun = runOpsCli(creatorHarness.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target, creatorFileSystem) }));
    await creatorBlocked; // its INVOKED line is in the file; its directory sync has not finished

    const events: string[] = [];
    const second = harness();
    second.venue.add(order("o-2"));
    second.venue.beforeCall = (method) => {
      if (method === "cancelAll") events.push("venue:cancelAll");
    };
    const outcome = await runOpsCli(second.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target, observedFileSystem(file, events)) }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(directorySyncsBeforeCancel(events)).toBe(2);
    expect(creatorEvents).not.toContain("dir:synced");

    releaseCreator?.();
    expect((await creatorRun).exitName).toBe("COMPLETED");
    expect(creatorEvents).toContain("dir:synced");
  });

  // Root ignores directory permissions; the injected cases above cover it there.
  it.skipIf(process.getuid?.() === 0)(
    "no fault injection: a log directory this user may write but not read (0300): the first invocation AND the identical second one refuse (AUDIT_UNAVAILABLE); nothing is canceled",
    async () => {
      const directory = path.join(scratch, "write-only");
      await mkdir(directory, { mode: 0o700 });
      const file = path.join(directory, "audit.jsonl");
      await chmod(directory, 0o300);
      try {
        for (const attempt of ["creates the file", "finds the file"]) {
          const h = harness();
          h.venue.add(order("o-1"));
          const outcome = await runOpsCli(h.deps(cancelAll(file), { openAuditLog: (target) => createFileAuditLog(target) }));
          expect(outcome.exitName, attempt).toBe("AUDIT_UNAVAILABLE");
          expect(h.text()).toContain("(DIRECTORY_SYNC_FAILED). Nothing was done");
          expect(h.venue.calls, attempt).toEqual([]);
          expect(h.venue.open()).toHaveLength(1);
        }
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );
});

describe("CX330-R1-03 and WP330-V1-05: operator text that may be a pasted secret reaches no output, log, mirror or lease", () => {
  const CANARY = "FAKE-CANARY-not-a-secret-7f3a";

  it("a --reason assigning a value to a credential name, in a PAPER refusal: a usage error that repeats nothing, in the file, the mirror or the output", async () => {
    for (const reason of [`apiKey=${CANARY}`, `passphrase: ${CANARY}`, `{"secret":"${CANARY}"}`, `Authorization: Bearer ${CANARY}`, `incident 7, my_private_key = ${CANARY}`]) {
      const file = path.join(scratch, `paper-${String(reason.length)}.jsonl`);
      const mirrored: AuditRecord[] = [];
      const h = harness({ mirror: { append: (record) => (mirrored.push(record), Promise.resolve()) } });
      const outcome = await runOpsCli(
        h.deps(args("cancel-all", "--reason", reason, "--dry-run", "--audit-log", file), { runModeFlags: PAPER_FLAGS, openAuditLog: (target) => createFileAuditLog(target) }),
      );
      expect(outcome.exitName, reason).toBe("USAGE");
      expect(await readFile(file, "utf8"), reason).not.toContain(CANARY);
      expect(JSON.stringify(mirrored), reason).not.toContain(CANARY);
      expect(h.text(), reason).not.toContain(CANARY);
      expect(h.text()).toContain("--reason is refused: it assigns a value to a credential-like name");
      expect(mirrored.map((record) => record.reason)).toEqual([null, null]);
    }
  });

  it("live-shaped: cancel-all sends nothing, and stop-heartbeat opens no lease store and revokes nothing, with such a reason", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    const cancel = await runOpsCli(h.deps(args("cancel-all", "--reason", `apiKey=${CANARY}`, "--confirm", `cancel-all:${ACCOUNT}`)));
    expect(cancel.exitName).toBe("USAGE");
    expect(h.venue.calls).toEqual([]);
    const leases = fakeLeases();
    const stop = await runOpsCli(h.deps(args("stop-heartbeat", "--reason", `token: ${CANARY}`, "--confirm", `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`), { leases: leases.factory }));
    expect(stop.exitName).toBe("USAGE");
    expect(leases.opened).toBe(0);
    expect(leases.revoked).toEqual([]);
    expect(JSON.stringify(h.audit.records)).not.toContain(CANARY);
    expect(h.text()).not.toContain(CANARY);
  });

  it("an unknown command or option that is not a command word is not repeated, in the file or the output", async () => {
    const file = path.join(scratch, "unknown.jsonl");
    const h = harness();
    for (const argv of [["0xdeadbeefSECRETKEY", "--account", "a1", "--operator", "op"], ["cancel-all", "--account", "a1", "--operator", "op", "--reason", "r", "--Key9SECRETKEY=x"]]) {
      const outcome = await runOpsCli(h.deps([...argv, "--audit-log", file], { openAuditLog: (target) => createFileAuditLog(target) }));
      expect(outcome.exitName).toBe("USAGE");
    }
    expect(await readFile(file, "utf8")).not.toContain("SECRETKEY");
    expect(h.text()).not.toContain("SECRETKEY");
    expect(h.text()).toContain("unknown command (not repeated: it is not a command or option word)");
    expect(h.text()).toContain("unknown option (not repeated: it is not a command or option word)");
  });
});
