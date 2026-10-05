/**
 * The emergency CLI's audit trail (WP-330 acceptance: "Output is explicit and
 * audited"; design requirement 3; handoff §14.1 "Every change is append-only
 * audited with actor, reason, timestamp, prior state, and resulting state";
 * §14.2: the cancel path must work without the trader database).
 *
 * ## The local log is the record of truth
 *
 * Every invocation appends records to a LOCAL, append-only JSON Lines file.
 * Each record is written with ONE `write` on a descriptor opened
 * `O_WRONLY | O_APPEND`, then `fsync`ed, then closed, and the file's
 * directory is `fsync`ed, BEFORE the CLI goes on:
 *
 * - `INVOKED` once WP-260's signer gate has given its verdict (a pure
 *   evaluation of the run-mode flags; the record carries it) and before the
 *   configuration, the credentials, the lease store or the venue are touched
 *   (a refusal is audited too). Only the record's own best-effort database
 *   copy (below) may touch the database before it;
 * - `ACTING` immediately before the first venue cancel or the lease revoke,
 *   naming the confirmed scope and the plan;
 * - `OUTCOME` after the result is known, with the exit code, and BEFORE any
 *   resource is released (`run.ts`).
 *
 * A record that cannot be written and synced before acting STOPS the command
 * (`AUDIT_UNAVAILABLE`, exit 5): nothing is done that is not on the record.
 * An OUTCOME record that cannot be written exits `OUTCOME_UNRECORDED` (18):
 * the command may already have acted, and the output says so (`run.ts`).
 * The file is never truncated or rewritten. It is opened with `O_NOFOLLOW`
 * and `O_NONBLOCK` and must be a regular file, so a symlink planted at the
 * path is refused rather than followed, and a FIFO is refused at once rather
 * than waited on (WP-330 r1, WP330-V1-02).
 *
 * EVERY append also `fsync`s the file's directory, so the file's existence is
 * as durable as its contents (WP-330 r2, CX330-R2-01). A record is durable
 * only once BOTH syncs have succeeded IN THIS APPEND. An existing file proves
 * nothing about its directory entry: its creator's directory sync may have
 * failed, or may still be pending in another invocation. A directory that
 * cannot be opened read-only and synced (for example mode 0300: writable, not
 * readable) therefore refuses every record (`DIRECTORY_SYNC_FAILED`), not only
 * the first.
 *
 * A FAILED APPEND MAY STILL LEAVE ITS LINE (WP-330 r3, WP330-V3-01). An append
 * that fails at or after its write (a failed or short write, a failed file or
 * directory `fsync`) may leave its line in the file, not durable. The trail
 * spends that line's sequence number, so the numbers stay unique; the output
 * names the line, and the OUTCOME record lists it (`auditNotDurable`). Such a
 * line records nothing done: a command acts only after its `ACTING` append
 * has resolved.
 *
 * A SHORT WRITE LEAVES A FRAGMENT, AND NO RECORD IS JOINED TO IT (WP-330 r4,
 * WP330-V4-01). A short write (`SHORT_WRITE`), or a crash in the middle of a
 * write, can leave part of a line with no newline after it. Every append to
 * a file it did not create first reads the file's last byte; when that is not
 * a newline, it writes one before its record, in the same `write`. The
 * fragment stays in the file as a line of its own that does not parse, and
 * the record after it, in this invocation or a later one, parses. The byte is
 * read through a second, read-only descriptor (`O_NOFOLLOW`, `O_NONBLOCK`),
 * and only when that descriptor names the same file (device and inode) as the
 * one written. The check is best effort: when it cannot be made (the file
 * cannot be read, or the path now names another file), the record is written
 * as before. Two invocations appending to one log at the same instant may
 * then leave an empty line; an empty line carries nothing.
 *
 * ## The database mirror is best effort, and never on the cancel path
 *
 * When a database is configured, each record is also appended to
 * `ops.config_change_audit` (`audit-mirror.ts`). The mirror is started after
 * the local write and NOT awaited before acting: a database that is down, or
 * hangs, delays nothing (§14.2). At the end the CLI waits a bounded time for
 * the mirrors and prints which landed.
 *
 * ## Nothing secret is written
 *
 * Records are built from an allow-list of fields (the command, its operands,
 * the operator, the account, the reason, the gate's verdict, counts and venue
 * ids), never from a credential, an error's free text or a venue payload.
 * WP-260's `redactForLog` is applied as the second line, then the record is
 * encoded with the repository's own-data JSON encoder
 * (`@polymarket-bot/risk/plain-json`: no inherited `toJSON` can substitute
 * bytes). The operator's own `--reason` text is free text and is recorded as
 * typed (bounded, no control characters), EXCEPT that the grammar refuses a
 * reason that assigns a value to a credential-like name (`grammar.ts`
 * `namesCredentialAssignment`, by WP-260's `isSensitiveKey`); a bare secret
 * with no name cannot be told from prose, so do not paste one into it.
 */

import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { redactForLog } from "@polymarket-bot/polymarket-secure";
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import type { OpsClock } from "./ports.js";

export const AUDIT_SCHEMA = "polymarket-bot/ops-cli-audit@1" as const;

export type AuditPhase = "INVOKED" | "ACTING" | "OUTCOME";

/** A JSON value built by this module from its allow-list. */
export type AuditValue = string | number | boolean | null | readonly AuditValue[] | { readonly [key: string]: AuditValue };

export interface AuditRecord {
  readonly schema: typeof AUDIT_SCHEMA;
  readonly recordId: string;
  /** One id for every record of one invocation. */
  readonly invocationId: string;
  /**
   * 0 for `INVOKED`, then 1, 2, … in the order the appends were made. Unique
   * within an invocation: an append that failed after its line may have
   * reached the file spends its number, so no later record reuses it
   * (WP-330 r3, WP330-V3-01), and the OUTCOME lists it (`auditNotDurable`).
   */
  readonly sequence: number;
  readonly phase: AuditPhase;
  /** ISO-8601 UTC instant. */
  readonly at: string;
  /** The command, or `null` when the arguments named none that parses. */
  readonly command: string | null;
  readonly operator: string | null;
  readonly accountRef: string | null;
  readonly reason: string | null;
  /** The run mode the gate permitted, or `null` while the gate has not permitted one. */
  readonly runMode: string | null;
  readonly detail: { readonly [key: string]: AuditValue };
}

/** Where records go first. `append` resolves only once the record is durable; it throws otherwise. */
export interface AuditSink {
  readonly location: string;
  append(record: AuditRecord): Promise<void>;
}

/** The database copy of a record (`audit-mirror.ts`). Best effort. */
export interface AuditMirror {
  append(record: AuditRecord): Promise<void>;
}

export type AuditUnavailableCode = "OPEN_FAILED" | "NOT_A_REGULAR_FILE" | "WRITE_FAILED" | "SHORT_WRITE" | "SYNC_FAILED" | "DIRECTORY_SYNC_FAILED" | "ENCODE_FAILED" | "RECORD_TOO_LARGE";

/**
 * The refusals raised before any byte of the line can have reached the file:
 * the line was never encoded, was too large, or the file was never opened as
 * a regular file. Every other refusal comes from the write or after it (a
 * failed or short write, a failed file or directory `fsync`), so its line MAY
 * be in the file without being durable (WP-330 r3, WP330-V3-01).
 */
const REFUSED_BEFORE_ANY_WRITE: ReadonlySet<AuditUnavailableCode> = new Set<AuditUnavailableCode>(["ENCODE_FAILED", "RECORD_TOO_LARGE", "OPEN_FAILED", "NOT_A_REGULAR_FILE"]);

/** Why a record could not be made durable. Carries a fixed code and the path; never an OS message with data in it. */
export class AuditUnavailableError extends Error {
  override readonly name = "AuditUnavailableError";
  /** The append failed after its line may have reached the file: the line may be in the log, not durable (WP330-V3-01). */
  readonly lineMayBeInLog: boolean;
  constructor(
    readonly code: AuditUnavailableCode,
    readonly location: string,
  ) {
    super(`the audit log ${location} could not record the invocation (${code})`);
    this.lineMayBeInLog = !REFUSED_BEFORE_ANY_WRITE.has(code);
  }
}

/** Whether a failed append may have left its line in the log. A failure that is not the sink's own refusal proves nothing, so it may have. */
export function lineMayBeInLog(error: unknown): boolean {
  return !(error instanceof AuditUnavailableError) || error.lineMayBeInLog;
}

/** The fixed code of a failed append: the sink's own, or `WRITE_FAILED` for any other failure. */
export function auditFailureCode(error: unknown): string {
  return error instanceof AuditUnavailableError ? error.code : "WRITE_FAILED";
}

/**
 * A record line is bounded. Every record builder is bounded BY CONSTRUCTION
 * below this, whatever the venue answers (WP-330 r1, WP330-V1-01): ids are
 * kept to the order-id alphabet and 200 characters, id lists to 200 samples
 * with their count, a cancel command's itemized attempts to 20 with totals
 * over all of them, and free text to fixed lengths (`context.ts`
 * `auditId`/`auditText`; `commands/cancel.ts` `auditAttempts`). The worst
 * case of a cancel command's OUTCOME, and the realistic 3,000-order sweep,
 * are pinned below this by `audit-bounds.test.ts`. A line that still exceeds
 * it is refused before any byte is written (`RECORD_TOO_LARGE`); for an
 * OUTCOME record, `run.ts` then records the exit alone, with
 * `detailOmitted: "RECORD_TOO_LARGE"`.
 */
export const MAX_AUDIT_LINE_BYTES = 256 * 1024;

/** The record as one JSON line: allow-listed fields, then WP-260's redaction, then own-data JSON. */
export function encodeAuditLine(record: AuditRecord): string {
  return `${encodePlainJson(redactForLog(record))}\n`;
}

/** The record as a JSON document (the database mirror's `new_value`). */
export function encodeAuditDocument(record: AuditRecord): string {
  return encodePlainJson(redactForLog(record));
}

// ---------------------------------------------------------------------------
// The file sink.

/** The file operations the sink uses; `NODE_AUDIT_FILE_SYSTEM` is the real one, a test may observe it. */
export interface AuditFileSystem {
  open(path: string, flags: number, mode: number): Promise<AuditFileHandle>;
}

export interface AuditFileHandle {
  write(data: Uint8Array): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  stat(): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  close(): Promise<void>;
  /**
   * Whether the file this descriptor writes is not empty and its last byte is
   * not a newline: a line was left unterminated (WP330-V4-01). A handle that
   * cannot tell answers `false`, or omits the method; the append is then
   * written as it would have been without the check.
   */
  endsMidLine?(): Promise<boolean>;
}

const NEWLINE = 0x0a;
/** The second descriptor `endsMidLine` reads the last byte through: read-only, never following a symlink, never waiting on a FIFO. */
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/**
 * The last byte of the file `written` names, read through a new read-only
 * descriptor on `path`, and only when that descriptor names the SAME file
 * (device and inode): a path that now names another file is not read, and
 * the answer is `false`.
 */
async function fileEndsMidLine(path: string, written: FileHandle): Promise<boolean> {
  const own = await written.stat({ bigint: true });
  if (!own.isFile() || own.size === 0n) return false;
  const reader = await open(path, READ_FLAGS);
  try {
    const seen = await reader.stat({ bigint: true });
    if (!seen.isFile() || seen.dev !== own.dev || seen.ino !== own.ino || seen.size === 0n) return false;
    const last = new Uint8Array(1);
    const { bytesRead } = await reader.read(last, 0, 1, seen.size - 1n);
    return bytesRead === 1 && last[0] !== NEWLINE;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export const NODE_AUDIT_FILE_SYSTEM: AuditFileSystem = Object.freeze({
  async open(path: string, flags: number, mode: number): Promise<AuditFileHandle> {
    const handle: FileHandle = await open(path, flags, mode);
    return {
      write: (data: Uint8Array) => handle.write(data),
      sync: () => handle.sync(),
      stat: () => handle.stat(),
      close: () => handle.close(),
      endsMidLine: () => fileEndsMidLine(path, handle),
    };
  },
});

function withNewlineFirst(bytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(bytes.length + 1);
  payload[0] = NEWLINE;
  payload.set(bytes, 1);
  return payload;
}

/** Whether to write a newline before the record: only when the handle says, for certain, that a line was left unterminated. */
async function mustTerminateFirst(handle: AuditFileHandle): Promise<boolean> {
  if (handle.endsMidLine === undefined) return false;
  try {
    return (await handle.endsMidLine()) === true;
  } catch {
    return false;
  }
}

/**
 * `O_NONBLOCK` (WP330-V1-02): opening a FIFO for writing with no reader would
 * block forever, before the regular-file check could refuse it; with
 * `O_NONBLOCK` the open fails at once (`ENXIO`, so `OPEN_FAILED`), and with a
 * reader it opens and the check refuses it. On a regular file it changes
 * nothing.
 */
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const CREATE_FLAGS = APPEND_FLAGS | fsConstants.O_CREAT | fsConstants.O_EXCL;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY;
/** Owner read/write only: the log names accounts and operators. */
const FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * An append-only JSON Lines audit file. One `append` = open (`O_APPEND`,
 * `O_NOFOLLOW`, `O_NONBLOCK`; created `0600` when absent), check it is a
 * regular file, one write of the whole line (after a newline, when a line
 * was left unterminated: WP330-V4-01), `fsync`, close; then, ALWAYS, `fsync`
 * of its directory (CX330-R2-01: whether this append created the file or
 * found it). `append` resolves only after both syncs.
 */
export function createFileAuditLog(path: string, fileSystem: AuditFileSystem = NODE_AUDIT_FILE_SYSTEM): AuditSink {
  return Object.freeze({
    location: path,
    async append(record: AuditRecord): Promise<void> {
      let line: string;
      try {
        line = encodeAuditLine(record);
      } catch {
        throw new AuditUnavailableError("ENCODE_FAILED", path);
      }
      const bytes = new TextEncoder().encode(line);
      if (bytes.length > MAX_AUDIT_LINE_BYTES) throw new AuditUnavailableError("RECORD_TOO_LARGE", path);

      let handle: AuditFileHandle;
      let created = true;
      try {
        handle = await fileSystem.open(path, CREATE_FLAGS, FILE_MODE);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw new AuditUnavailableError("OPEN_FAILED", path);
        created = false;
        try {
          handle = await fileSystem.open(path, APPEND_FLAGS, FILE_MODE);
        } catch {
          throw new AuditUnavailableError("OPEN_FAILED", path);
        }
      }
      try {
        let regular: boolean;
        try {
          regular = (await handle.stat()).isFile();
        } catch {
          regular = false;
        }
        if (!regular) throw new AuditUnavailableError("NOT_A_REGULAR_FILE", path);
        // A fragment left by a short write or a crash is ended first, in the same write, so this record
        // is never joined to it (WP330-V4-01). A file this append created is empty: nothing to end.
        const payload = !created && (await mustTerminateFirst(handle)) ? withNewlineFirst(bytes) : bytes;
        let written: number;
        try {
          written = (await handle.write(payload)).bytesWritten;
        } catch {
          throw new AuditUnavailableError("WRITE_FAILED", path);
        }
        if (written !== payload.length) throw new AuditUnavailableError("SHORT_WRITE", path);
        try {
          await handle.sync();
        } catch {
          throw new AuditUnavailableError("SYNC_FAILED", path);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      // The directory entry is made durable by THIS append, every time (CX330-R2-01).
      // EEXIST says only that the file exists: its creator's directory sync may have
      // failed, or may still be pending in another invocation.
      let directory: AuditFileHandle | undefined;
      try {
        directory = await fileSystem.open(dirname(path), DIRECTORY_FLAGS, 0);
        await directory.sync();
      } catch {
        throw new AuditUnavailableError("DIRECTORY_SYNC_FAILED", path);
      } finally {
        await directory?.close().catch(() => undefined);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// One invocation's trail.

export interface MirrorReport {
  readonly configured: boolean;
  readonly landed: number;
  readonly failed: number;
  /** Mirrors still pending when the bound expired. */
  readonly pending: number;
}

export interface AuditTrailOptions {
  readonly sink: AuditSink;
  readonly mirror: AuditMirror | null;
  readonly clock: OpsClock;
  readonly newId: () => string;
  readonly invocationId: string;
}

export interface AuditHeader {
  readonly command: string | null;
  readonly operator: string | null;
  readonly accountRef: string | null;
  readonly reason: string | null;
}

/** An append that failed after its line may have reached the file (WP330-V3-01). */
export interface NotDurableAppend {
  readonly phase: AuditPhase;
  readonly sequence: number;
  readonly code: string;
}

/**
 * The records of one invocation, in order. `write` resolves once the record
 * is durable in the local log and throws {@link AuditUnavailableError}
 * otherwise; the mirror copy is started and not awaited.
 *
 * A FAILED append whose line may nonetheless be in the file (the sink
 * refused it at or after the write: {@link lineMayBeInLog}) spends its
 * sequence number and is kept in {@link AuditTrail.notDurable}, so the log
 * never holds two lines with one number, and the output and the OUTCOME
 * record can name the line that is there but not durable (WP-330 r3,
 * WP330-V3-01). After a short write that line is only a fragment: a line of
 * its own that does not parse, because the file sink's next append starts a
 * new line after it (WP-330 r4, WP330-V4-01). A refusal before any byte was written (too large, not
 * encodable, not opened) spends nothing: the OUTCOME written again without
 * its detail keeps the number.
 */
export class AuditTrail {
  readonly #options: AuditTrailOptions;
  readonly #header: AuditHeader;
  #sequence = 0;
  #runMode: string | null = null;
  readonly #mirrors: Promise<"LANDED" | "FAILED">[] = [];
  readonly #written: AuditRecord[] = [];
  readonly #notDurable: NotDurableAppend[] = [];

  constructor(options: AuditTrailOptions, header: AuditHeader) {
    this.#options = options;
    this.#header = header;
  }

  get location(): string {
    return this.#options.sink.location;
  }

  /** The run mode the gate permitted; recorded on every later record. */
  set runMode(value: string | null) {
    this.#runMode = value;
  }

  /** Every record made durable so far (for the output and the tests). */
  records(): readonly AuditRecord[] {
    return Object.freeze([...this.#written]);
  }

  /** Every append that failed after its line may have reached the file: such a line may be in the log, NOT durable. */
  notDurable(): readonly NotDurableAppend[] {
    return Object.freeze([...this.#notDurable]);
  }

  async write(phase: AuditPhase, detail: { readonly [key: string]: AuditValue }): Promise<AuditRecord> {
    const record: AuditRecord = Object.freeze({
      schema: AUDIT_SCHEMA,
      recordId: this.#options.newId(),
      invocationId: this.#options.invocationId,
      sequence: this.#sequence,
      phase,
      at: new Date(this.#options.clock.nowMs()).toISOString(),
      command: this.#header.command,
      operator: this.#header.operator,
      accountRef: this.#header.accountRef,
      reason: this.#header.reason,
      runMode: this.#runMode,
      detail,
    });
    try {
      await this.#options.sink.append(record);
    } catch (error) {
      if (lineMayBeInLog(error)) {
        // Its line may be in the file: the number is spent, so no later record reuses it (WP330-V3-01).
        this.#sequence += 1;
        this.#notDurable.push(Object.freeze({ phase, sequence: record.sequence, code: auditFailureCode(error) }));
      }
      throw error;
    }
    this.#sequence += 1;
    this.#written.push(record);
    const mirror = this.#options.mirror;
    if (mirror !== null) {
      // Started, not awaited: the database is never on the path to acting (§14.2).
      this.#mirrors.push(
        Promise.resolve()
          .then(() => mirror.append(record))
          .then(
            () => "LANDED" as const,
            () => "FAILED" as const,
          ),
      );
    }
    return record;
  }

  /** Wait at most `boundMs` for the mirror copies; report what landed. */
  async settleMirrors(boundMs: number): Promise<MirrorReport> {
    if (this.#options.mirror === null) return Object.freeze({ configured: false, landed: 0, failed: 0, pending: 0 });
    const outcomes: ("LANDED" | "FAILED" | "PENDING")[] = this.#mirrors.map(() => "PENDING");
    const tracked = this.#mirrors.map((promise, index) =>
      promise.then((value) => {
        outcomes[index] = value;
      }),
    );
    await Promise.race([Promise.all(tracked), this.#options.clock.sleep(boundMs)]);
    return Object.freeze({
      configured: true,
      landed: outcomes.filter((value) => value === "LANDED").length,
      failed: outcomes.filter((value) => value === "FAILED").length,
      pending: outcomes.filter((value) => value === "PENDING").length,
    });
  }
}
