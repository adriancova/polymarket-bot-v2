/**
 * The local audit file (design requirement 3): append-only, one durable line
 * per record, never through a symlink, owner-only, never a secret, and
 * immune to an inherited `toJSON` (the SER lesson: the own-data encoder).
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_SCHEMA, AuditTrail, AuditUnavailableError, createFileAuditLog, encodeAuditLine, type AuditRecord } from "./audit-log.js";
import { FakeClock, uuidSource } from "./harness.test-support.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ops-cli-audit-unit-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function record(sequence: number, detail: AuditRecord["detail"] = {}): AuditRecord {
  return {
    schema: AUDIT_SCHEMA,
    recordId: `01a10bef-6200-7000-8000-${String(sequence).padStart(12, "0")}`,
    invocationId: "01a10bef-6200-7000-8000-ffffffffffff",
    sequence,
    phase: sequence === 0 ? "INVOKED" : "OUTCOME",
    at: "2026-10-05T12:00:00.000Z",
    command: "cancel-all",
    operator: "op",
    accountRef: "acct",
    reason: "why",
    runMode: null,
    detail,
  };
}

describe("the file log", () => {
  it("appends: existing content is never rewritten, each record is one JSON line", async () => {
    const file = path.join(scratch, "audit.jsonl");
    await writeFile(file, '{"earlier":"line"}\n', { mode: 0o600 });
    const log = createFileAuditLog(file);
    await log.append(record(0));
    await log.append(record(1));
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines[0]).toBe('{"earlier":"line"}');
    expect(lines.slice(1).map((line) => (JSON.parse(line) as AuditRecord).sequence)).toEqual([0, 1]);
  });

  it("a new file is created owner-only (0600)", async () => {
    const file = path.join(scratch, "new.jsonl");
    await createFileAuditLog(file).append(record(0));
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  it("a symlink at the path is refused, not followed: the target is untouched", async () => {
    const target = path.join(scratch, "elsewhere.txt");
    await writeFile(target, "precious\n");
    const link = path.join(scratch, "audit.jsonl");
    await symlink(target, link);
    await expect(createFileAuditLog(link).append(record(0))).rejects.toMatchObject({ name: "AuditUnavailableError", code: "OPEN_FAILED" });
    expect(await readFile(target, "utf8")).toBe("precious\n");
  });

  it("a directory at the path is refused", async () => {
    await expect(createFileAuditLog(scratch).append(record(0))).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("WP-330 r1 (WP330-V1-02): a FIFO with NO reader is refused at once (O_NONBLOCK: ENXIO, OPEN_FAILED), never waited on", async () => {
    const fifo = path.join(scratch, "audit.fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const attempt = createFileAuditLog(fifo).append(record(0));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        attempt.then(
          () => "WRITTEN" as const,
          (error: unknown) => error,
        ),
        new Promise<"HUNG">((resolve) => (timer = setTimeout(() => resolve("HUNG"), 2_000))),
      ]);
      expect(settled).not.toBe("HUNG");
      expect(settled).toMatchObject({ name: "AuditUnavailableError", code: "OPEN_FAILED" });
    } finally {
      clearTimeout(timer);
      // Release a writer blocked in open(2) (fb9edcc's flags), so no thread is left behind.
      const reader = await open(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      await reader.close();
      await attempt.catch(() => undefined);
    }
  });

  it("a FIFO WITH a reader opens, and is then refused as not a regular file: the reader receives nothing", async () => {
    const fifo = path.join(scratch, "audit.fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const reader = await open(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      await expect(createFileAuditLog(fifo).append(record(0))).rejects.toMatchObject({ code: "NOT_A_REGULAR_FILE" });
      const buffer = Buffer.alloc(64);
      const read = await reader.read(buffer, 0, buffer.length, null).catch((error: NodeJS.ErrnoException) => ({ bytesRead: error.code === "EAGAIN" ? 0 : -1 }));
      expect(read.bytesRead).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it("a missing directory is refused (nothing is created silently elsewhere)", async () => {
    await expect(createFileAuditLog(path.join(scratch, "no", "such", "dir", "a.jsonl")).append(record(0))).rejects.toMatchObject({ code: "OPEN_FAILED" });
  });

  it("a short write or a failed fsync is a refusal, so the command does not act", async () => {
    const short = createFileAuditLog("/x/a.jsonl", {
      open: () => Promise.resolve({ write: () => Promise.resolve({ bytesWritten: 1 }), sync: () => Promise.resolve(), stat: () => Promise.resolve({ isFile: () => true, isDirectory: () => false }), close: () => Promise.resolve() }),
    });
    await expect(short.append(record(0))).rejects.toMatchObject({ code: "SHORT_WRITE" });
    const unsynced = createFileAuditLog("/x/a.jsonl", {
      open: () =>
        Promise.resolve({
          write: (data: Uint8Array) => Promise.resolve({ bytesWritten: data.length }),
          sync: () => Promise.reject(new Error("EIO")),
          stat: () => Promise.resolve({ isFile: () => true, isDirectory: () => false }),
          close: () => Promise.resolve(),
        }),
    });
    await expect(unsynced.append(record(0))).rejects.toMatchObject({ code: "SYNC_FAILED" });
  });
});

describe("the bytes", () => {
  it("WP-260's redaction runs as the second line: a sensitive-looking key's value never reaches the line", () => {
    const line = encodeAuditLine(record(0, { apiKey: "k-SECRET", nested: { passphrase: "p-SECRET", signature: "0xSIG" }, venueOrderId: "o-1", tokenId: "123" }));
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("0xSIG");
    expect(line).toContain('"venueOrderId":"o-1"');
    expect(line).toContain('"tokenId":"123"');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
  });

  it("an inherited toJSON cannot substitute the bytes (own-data encoder)", () => {
    const clean = encodeAuditLine(record(0, { list: ["a"], inner: { b: 1 } }));
    const polluted = Object.prototype as unknown as { toJSON?: () => unknown };
    const arrays = Array.prototype as unknown as { toJSON?: () => unknown };
    polluted.toJSON = () => "INJECTED";
    arrays.toJSON = () => "INJECTED";
    try {
      expect(encodeAuditLine(record(0, { list: ["a"], inner: { b: 1 } }))).toBe(clean);
    } finally {
      delete polluted.toJSON;
      delete arrays.toJSON;
    }
    // CONTROL: JSON.stringify is fooled by the same pollution.
    polluted.toJSON = () => "INJECTED";
    try {
      expect(JSON.stringify({ a: 1 })).toBe('"INJECTED"');
    } finally {
      delete polluted.toJSON;
    }
  });

  it("free text with newlines is escaped: a record is always exactly one line", () => {
    const line = encodeAuditLine(record(0, { note: "a\nb\r\nc" }));
    expect(line.split("\n")).toHaveLength(2);
  });
});

describe("the trail", () => {
  it("numbers records in order and stops on the first failure (the failed record is not counted)", async () => {
    const clock = new FakeClock();
    const records: AuditRecord[] = [];
    let fail = false;
    const trail = new AuditTrail(
      {
        sink: { location: "memory", append: (entry) => (fail ? Promise.reject(new AuditUnavailableError("WRITE_FAILED", "memory")) : (records.push(entry), Promise.resolve())) },
        mirror: null,
        clock,
        newId: uuidSource(),
        invocationId: "inv",
      },
      { command: "cancel-all", operator: "op", accountRef: "acct", reason: "r" },
    );
    await trail.write("INVOKED", {});
    fail = true;
    await expect(trail.write("ACTING", {})).rejects.toBeInstanceOf(AuditUnavailableError);
    fail = false;
    await trail.write("OUTCOME", {});
    expect(records.map((entry) => [entry.phase, entry.sequence])).toEqual([
      ["INVOKED", 0],
      ["OUTCOME", 1],
    ]);
    expect(trail.records()).toHaveLength(2);
  });
});
