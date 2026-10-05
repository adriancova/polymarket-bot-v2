/**
 * The process composition (`main.ts`), run in-process: it binds NOTHING live.
 * Under the repository defaults every venue command is refused by the gate;
 * with live-shaped flags it still finds no emergency credential and no venue;
 * a configured database is only ever a best-effort mirror, and an unreachable
 * one changes no outcome. The database URL is never printed.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT, args, DESTRUCTIVE_REASON, FakeClock, LIVE_FLAGS, NON_INTERACTIVE, testConfiguration } from "./harness.test-support.js";
import { AUDIT_LOG_ENV, CONFIG_ENV, DATABASE_URL_ENV, isProcessEntry, main, processIo, runIfProcessEntry, UNBOUND_VENUE, UNCONFIGURED_CREDENTIALS, type ProcessIo } from "./main.js";

let tripwire: NetworkTripwire;
let scratch: string;
beforeEach(async () => {
  tripwire = installNetworkTripwire();
  scratch = await mkdtemp(path.join(tmpdir(), "ops-cli-main-"));
});
afterEach(async () => {
  tripwire.uninstall();
  await rm(scratch, { recursive: true, force: true });
});

function io(argv: string[], env: Record<string, string | undefined>): ProcessIo & { readonly lines: string[] } {
  const lines: string[] = [];
  return { argv, env, out: { line: (text: string) => void lines.push(text) }, prompt: NON_INTERACTIVE, clock: new FakeClock(), lines };
}

const CANCEL_ALL = args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`);

describe("main: the shipped composition binds nothing live", () => {
  it("the repository defaults (no RUN_MODE, MAX_RUN_MODE PAPER, no real orders): RUN_MODE_REFUSED, audited to the file", async () => {
    const audit = path.join(scratch, "audit.jsonl");
    const process = io(CANCEL_ALL, { [AUDIT_LOG_ENV]: audit });
    const outcome = await main(process);
    expect(outcome.exitName).toBe("RUN_MODE_REFUSED");
    expect((await readFile(audit, "utf8")).trimEnd().split("\n")).toHaveLength(2);
    expect(tripwire.refused()).toEqual([]);
  });

  it("live-shaped flags and a valid configuration: still no emergency credential source, so nothing is sent (CREDENTIALS_UNAVAILABLE)", async () => {
    const config = path.join(scratch, "ops.json");
    await writeFile(config, JSON.stringify(testConfiguration()));
    const process = io(CANCEL_ALL, { ...LIVE_FLAGS, [AUDIT_LOG_ENV]: path.join(scratch, "audit.jsonl"), [CONFIG_ENV]: config });
    const outcome = await main(process);
    expect(outcome.exitName).toBe("CREDENTIALS_UNAVAILABLE");
    expect(process.lines.join("\n")).toContain("no emergency credential: NO_EMERGENCY_CREDENTIAL_SOURCE");
    expect(tripwire.refused()).toEqual([]);
  });

  it("the bound ports themselves: no credential, no venue", async () => {
    expect(await UNCONFIGURED_CREDENTIALS.load({ accountRef: ACCOUNT, gate: { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true } })).toEqual({ kind: "UNAVAILABLE", reason: "NO_EMERGENCY_CREDENTIAL_SOURCE" });
    expect(await UNBOUND_VENUE.open({ gate: { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true }, credential: { accountRef: ACCOUNT }, onRateLimitUpdate: () => undefined })).toEqual({
      kind: "UNAVAILABLE",
      reason: "NO_LIVE_VENUE_BINDING",
    });
  });

  it("no configuration file: CONFIGURATION_REFUSED", async () => {
    const process = io(CANCEL_ALL, { ...LIVE_FLAGS, [AUDIT_LOG_ENV]: path.join(scratch, "audit.jsonl") });
    expect((await main(process)).exitName).toBe("CONFIGURATION_REFUSED");
  });

  it("an UNREACHABLE database (the network is refused): the mirror fails, the outcome is unchanged, and the URL is never printed", async () => {
    const url = "postgresql://opsuser:hunter2-not-real@db.invalid:5432/polymarket_bot";
    const process = io(args("account-snapshot"), { [AUDIT_LOG_ENV]: path.join(scratch, "audit.jsonl"), [DATABASE_URL_ENV]: url });
    const outcome = await main(process);
    expect(outcome.exitName).toBe("RUN_MODE_REFUSED");
    const text = process.lines.join("\n");
    expect(text).toMatch(/database copy \(ops\.config_change_audit\): 0 landed, \d failed/u);
    expect(text).not.toContain("hunter2");
    // The only network attempts were the mirror's, to the database host, and each was refused.
    expect(tripwire.refused().length).toBeGreaterThan(0);
    expect(tripwire.refused().every((attempt) => attempt.via === "net.Socket.connect" && attempt.target === "5432")).toBe(true);
  });

  it("stop-heartbeat against an unreachable database, live-shaped: DATABASE_UNAVAILABLE, nothing revoked", async () => {
    const process = io(args("stop-heartbeat", ...DESTRUCTIVE_REASON, "--confirm", "x"), { ...LIVE_FLAGS, [AUDIT_LOG_ENV]: path.join(scratch, "audit.jsonl"), [DATABASE_URL_ENV]: "postgresql://u:p@db.invalid:5432/d" });
    const outcome = await main(process);
    expect(outcome.exitName).toBe("DATABASE_UNAVAILABLE");
    expect(tripwire.refused().every((attempt) => attempt.via === "net.Socket.connect" && attempt.target === "5432")).toBe(true);
  });

  it("--help prints the usage and touches nothing", async () => {
    const process = io(["--help"], {});
    expect((await main(process)).exitName).toBe("COMPLETED");
    expect(process.lines.join("\n")).toContain("usage: ops-cli <command>");
    expect(tripwire.refused()).toEqual([]);
  });
});

describe("the process shell (WP-330 r0: the shell-runnable bundle)", () => {
  it("isProcessEntry: the file Node runs, as given or through a symlink, is the entry; a same-named file elsewhere, an importer, a missing path and no path are not", async () => {
    const root = await realpath(scratch);
    await mkdir(path.join(root, "real dir"));
    await mkdir(path.join(root, "elsewhere"));
    const bundle = path.join(root, "real dir", "main.mjs");
    await writeFile(bundle, "");
    await writeFile(path.join(root, "elsewhere", "main.mjs"), "");
    await symlink(path.join(root, "real dir"), path.join(root, "linked"));
    // Node names its main module by its real path (the URL escapes the space).
    const moduleUrl = pathToFileURL(bundle).href;
    expect(moduleUrl).toContain("real%20dir");

    expect(isProcessEntry(moduleUrl, bundle)).toBe(true);
    // Through a symlinked directory: the as-given URL differs, the real path matches.
    expect(pathToFileURL(path.join(root, "linked", "main.mjs")).href).not.toBe(moduleUrl);
    expect(isProcessEntry(moduleUrl, path.join(root, "linked", "main.mjs"))).toBe(true);
    // A file name is not an identity.
    expect(isProcessEntry(moduleUrl, path.join(root, "elsewhere", "main.mjs"))).toBe(false);
    // An importer (this test file) is never the entry; nor is a missing path, or none.
    expect(isProcessEntry(import.meta.url, process.argv[1])).toBe(false);
    expect(isProcessEntry(moduleUrl, path.join(root, "missing", "main.mjs"))).toBe(false);
    expect(isProcessEntry(moduleUrl, undefined)).toBe(false);
    expect(isProcessEntry(moduleUrl, "")).toBe(false);
  });

  it("runIfProcessEntry from an importer runs nothing and leaves the exit code alone", async () => {
    const before = process.exitCode;
    expect(await runIfProcessEntry(import.meta.url)).toBeNull();
    expect(process.exitCode).toBe(before);
  });

  it("a CLOSED stdout (EPIPE) never kills the command: processIo installs an error sink before anything is written", () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const closed = new Writable({
      write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        callback(epipe);
      },
    });
    // CONTROL: with no listener, an error event throws (Node's uncaught-exception path).
    expect(() => new Writable().emit("error", epipe)).toThrow("write EPIPE");

    const io = processIo({ stdin: Readable.from([]), stdout: closed });
    expect(closed.listenerCount("error")).toBeGreaterThan(0);
    expect(() => closed.emit("error", epipe)).not.toThrow();
    expect(() => {
      io.out.line("RESULT: …");
    }).not.toThrow();
    // Neither stream is a terminal: a destructive command never waits on a prompt.
    expect(io.prompt.interactive).toBe(false);
  });
});
