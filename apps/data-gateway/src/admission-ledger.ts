/**
 * The series ADMISSION LEDGER (`ROLLOVER-1`; ADR-030 Decisions 1 and 3): the
 * gateway's durable memory of every window of a reviewed series it has judged
 * — admitted, refused, or retired — and of which admissions the publisher has
 * CONFIRMED.
 *
 * ## Why it exists (the `UNIV-4` lifecycle ledger's reasons, applied here)
 *
 * - **No window is judged twice.** A refusal is FINAL: ADR-030 Decision 1.4
 *   says a window that does not match "opens an incident and waits for a human
 *   review", so a refused window is never re-judged by a later poll (whose
 *   answer could differ — a tick size changes at run time, F-21). An admission
 *   is final too: a restarted gateway does not re-admit a window, and so never
 *   publishes a second, contradicting admission.
 * - **Intent before dispatch; confirmation after publication.** The admission
 *   is written as an INTENT before its events are dispatched, and confirmed
 *   once the publisher reports `published: true`. An intent without its
 *   confirmation is RE-EMITTED, unchanged, by the next epoch (the
 *   `feeds/market-lifecycle.ts` rule): a publication halt or a crash between
 *   dispatch and confirmation can neither lose an admission nor mint a
 *   different one.
 * - **Restart re-attaches the live windows.** An admitted window that is not
 *   retired is re-registered in the directory, re-subscribed and re-polled by
 *   the lifecycle feed at the next start.
 *
 * ## Bounded (§8.3)
 *
 * A 15-minute series produces 96 windows a day. A RETIRED or REFUSED record
 * whose window closed more than {@link ADMISSION_LEDGER_RETENTION_MS} ago is
 * PRUNED: discovery skips every window whose close has passed (its `endDate`
 * bound and the late rule), so such a window can never be a candidate again,
 * and its record has nothing left to protect. An ADMITTED (live) record is
 * never pruned, nor is a refusal whose close is unknown.
 *
 * ## Where it lives, how it is written and read
 *
 * `<walRoot>/series-admission-ledger.json`, through the same `WalFileSystem`
 * port the journal uses (temp-file, fsync, rename), on one serial write chain,
 * encoded with `@polymarket-bot/risk/plain-json` (own data only) and read back
 * through `./config-door.ts`'s `readOwnConfig` and a strict schema. A ledger
 * that cannot be read is REFUSED at open and the gateway fails to start:
 * re-judging over an unreadable ledger could admit a window twice.
 */

import { IsoTimestampSchema } from "@polymarket-bot/domain";
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
import type { WalFileSystem } from "@polymarket-bot/storage-wal";
import { z } from "zod";

import { containedConfigParse, isOwnRecord, readOwnConfig } from "./config-door.js";
import { GatewayStateError } from "./errors.js";

/** File name under the WAL root. */
export const ADMISSION_LEDGER_FILE_NAME = "series-admission-ledger.json";

/** The ledger's own format version, checked on read. */
export const ADMISSION_LEDGER_SCHEMA_VERSION = 1;

/** Retired or refused records of windows closed longer ago than this are pruned (2 days). */
export const ADMISSION_LEDGER_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** At most this many mismatch lines are kept per refusal, each at most 500 characters. */
const MAX_RECORDED_MISMATCHES = 12;
const MAX_MISMATCH_LENGTH = 500;

const Instant = IsoTimestampSchema;
const Text = z.string().min(1).max(2_000);

/** One admitted window's facts, as `SeriesWindowAdmitted@1` and its companions carry them. */
const AdmittedWindowSchema = z.strictObject({
  internalMarketId: Text,
  conditionId: Text,
  gammaEventId: Text,
  gammaMarketId: Text,
  yesTokenId: Text,
  noTokenId: Text,
  scheduledOpenAt: Instant,
  scheduledCloseAt: Instant,
  tickSize: Text,
  windowTitle: Text,
  /** The universe directory's parameter-version reference for version 1. */
  parameterVersionRef: Text,
  /** The two journaled responses the admission was judged from (§6 invariant 4). */
  keysetRawIngestSeq: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  clobRawIngestSeq: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
});
export type AdmittedWindowRecord = z.infer<typeof AdmittedWindowSchema>;

const RecordSchema = z.strictObject({
  /** The condition id, or `event:<gammaEventId>` when none was readable. */
  key: Text,
  seriesId: Text,
  seriesConfigHash: z.string().regex(/^[0-9a-f]{64}$/u),
  status: z.enum(["ADMITTED", "REFUSED", "RETIRED"]),
  /** The receipt instant of the poll the window was judged on. */
  judgedAt: Instant,
  /** The window's close when it is known (the admitted schedule, or a refused window's `endDate`). */
  closeAt: Instant.optional(),
  window: AdmittedWindowSchema.optional(),
  /** When the publisher confirmed the admission's events (absent: an unconfirmed intent). */
  admissionConfirmedAt: Instant.optional(),
  retiredAt: Instant.optional(),
  /**
   * Why the window was retired. `ROLLOVER-1` r2 (R2-ASTRA-02): only its
   * handled resolution retires a window (ADR-030 Decision 4.4); r0 and r1
   * also retired an unresolved one (`UNRESOLVED_AFTER_CLOSE`), which cut off
   * the delivery of its late resolution. That value is no longer written or
   * read: a ledger carrying it is refused at open (fail closed).
   */
  retiredReason: z.enum(["RESOLVED"]).optional(),
  mismatches: z.array(z.string().min(1).max(MAX_MISMATCH_LENGTH)).min(1).max(MAX_RECORDED_MISMATCHES).optional(),
});
export type AdmissionLedgerRecord = z.infer<typeof RecordSchema>;

const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(ADMISSION_LEDGER_SCHEMA_VERSION),
  windows: z.record(z.string(), z.unknown()),
});

/** The consistency every record must have beyond its shape. */
function recordProblem(record: AdmissionLedgerRecord): string | undefined {
  if (record.status === "REFUSED") {
    if (record.mismatches === undefined) return "a REFUSED record names no mismatch";
    if (record.window !== undefined || record.admissionConfirmedAt !== undefined) return "a REFUSED record carries an admission";
  } else {
    if (record.window === undefined) return `an ${record.status} record carries no window`;
    if (record.window.conditionId !== record.key) return "an admitted record's key is not its condition id";
    if (record.mismatches !== undefined) return "an admitted record carries mismatches";
  }
  if ((record.status === "RETIRED") !== (record.retiredAt !== undefined && record.retiredReason !== undefined)) {
    return "retiredAt and retiredReason are present exactly on a RETIRED record";
  }
  return undefined;
}

/** Bounds a refusal's mismatch list to what the ledger keeps. */
export function boundedMismatches(mismatches: readonly string[]): readonly string[] {
  const kept = mismatches.slice(0, MAX_RECORDED_MISMATCHES).map((line) =>
    line.length > MAX_MISMATCH_LENGTH ? `${line.slice(0, MAX_MISMATCH_LENGTH - 1)}…` : line,
  );
  return kept.length > 0 ? kept : ["(no mismatch recorded)"];
}

export interface AdmissionLedgerOptions {
  readonly fileSystem: WalFileSystem;
  readonly walRootPath: string;
}

export interface AdmissionLedgerMetrics {
  readonly recordsLoaded: number;
  readonly writes: number;
  readonly pruned: number;
}

export class AdmissionLedger {
  readonly #fileSystem: WalFileSystem;
  readonly #path: string;
  readonly #records = new Map<string, AdmissionLedgerRecord>();
  readonly #loaded: number;
  #writes = 0;
  #pruned = 0;
  #chain: Promise<void> = Promise.resolve();

  private constructor(fileSystem: WalFileSystem, path: string, records: readonly AdmissionLedgerRecord[]) {
    this.#fileSystem = fileSystem;
    this.#path = path;
    for (const record of records) this.#records.set(record.key, record);
    this.#loaded = records.length;
  }

  /** Opens the ledger, refusing anything that is not the documented shape (module header). */
  static async open(options: AdmissionLedgerOptions): Promise<AdmissionLedger> {
    await options.fileSystem.ensureDirectory(options.walRootPath);
    const path = options.fileSystem.joinPath(options.walRootPath, ADMISSION_LEDGER_FILE_NAME);
    const length = await options.fileSystem.fileByteLength(path);
    if (length === null) return new AdmissionLedger(options.fileSystem, path, []);
    const bytes = await options.fileSystem.readWholeFile(path);
    return new AdmissionLedger(options.fileSystem, path, AdmissionLedger.decode(Buffer.from(bytes).toString("utf8")));
  }

  /** The ledger's document, read as own data and checked record by record. */
  static decode(text: string): readonly AdmissionLedgerRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new GatewayStateError("the series admission ledger is not JSON; repair or remove it before starting", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const read = readOwnConfig(parsed);
    if (!read.ok) {
      throw new GatewayStateError("the series admission ledger is not plain JSON data", { detail: read.detail });
    }
    const document = containedConfigParse(DocumentSchema, read.value);
    if (!document.ok || !isOwnRecord(read.value)) {
      throw new GatewayStateError("the series admission ledger is not the documented shape", {
        issues: document.ok ? [] : document.issues,
      });
    }
    const windows = read.value["windows"];
    if (!isOwnRecord(windows)) throw new GatewayStateError("the series admission ledger has no windows object");
    return Object.keys(windows).map((key) => {
      const value = windows[key];
      const judged = containedConfigParse(RecordSchema, value);
      if (!judged.ok) {
        throw new GatewayStateError("the series admission ledger holds a record that is not the documented shape", {
          key,
          issues: judged.issues,
        });
      }
      const record = value as AdmissionLedgerRecord;
      if (record.key !== key) {
        throw new GatewayStateError("the series admission ledger holds a record whose key does not match its entry", { key });
      }
      const problem = recordProblem(record);
      if (problem !== undefined) {
        throw new GatewayStateError(`the series admission ledger holds an inconsistent record: ${problem}`, { key });
      }
      return record;
    });
  }

  get(key: string): AdmissionLedgerRecord | undefined {
    return this.#records.get(key);
  }

  /** Every record, in key order. */
  records(): readonly AdmissionLedgerRecord[] {
    return [...this.#records.keys()].sort().flatMap((key) => {
      const record = this.#records.get(key);
      return record === undefined ? [] : [record];
    });
  }

  /** The ADMITTED (live) records of one series, in admission order of their scheduled open. */
  liveWindows(seriesId?: string): readonly AdmissionLedgerRecord[] {
    return this.records()
      .filter((record) => record.status === "ADMITTED" && (seriesId === undefined || record.seriesId === seriesId))
      .sort((left, right) =>
        (left.window?.scheduledOpenAt ?? "") < (right.window?.scheduledOpenAt ?? "")
          ? -1
          : (left.window?.scheduledOpenAt ?? "") > (right.window?.scheduledOpenAt ?? "")
            ? 1
            : left.key < right.key
              ? -1
              : 1,
      );
  }

  /**
   * Replaces one record and rewrites the file durably. A failed write ROLLS
   * BACK the in-memory record (the `LifecycleLedger.put` rule), so a reader
   * after a failure sees the durable truth.
   */
  put(record: AdmissionLedgerRecord): Promise<void> {
    const problem = recordProblem(record);
    if (problem !== undefined) {
      return Promise.reject(new GatewayStateError(`refusing to write an inconsistent admission record: ${problem}`, { key: record.key }));
    }
    const judged = containedConfigParse(RecordSchema, record);
    if (!judged.ok) {
      return Promise.reject(new GatewayStateError("refusing to write an admission record that is not the documented shape", { key: record.key, issues: judged.issues }));
    }
    const write = this.#chain.then(async () => {
      const previous = this.#records.get(record.key);
      this.#records.set(record.key, record);
      try {
        await this.#write();
      } catch (error) {
        if (previous === undefined) this.#records.delete(record.key);
        else this.#records.set(record.key, previous);
        throw error;
      }
      this.#writes += 1;
    });
    this.#chain = write.catch(() => undefined);
    return write;
  }

  /**
   * Prunes RETIRED and REFUSED records whose window closed before
   * `nowMs − retentionMs` (module header). Resolves to the pruned records; a
   * failed write restores them.
   */
  prune(nowMs: number, retentionMs: number = ADMISSION_LEDGER_RETENTION_MS): Promise<readonly AdmissionLedgerRecord[]> {
    const pruning = this.#chain.then(async () => {
      const removed: AdmissionLedgerRecord[] = [];
      for (const record of this.#records.values()) {
        if (record.status === "ADMITTED" || record.closeAt === undefined) continue;
        const closeMs = Date.parse(record.closeAt);
        if (Number.isFinite(closeMs) && closeMs < nowMs - retentionMs) removed.push(record);
      }
      if (removed.length === 0) return [];
      for (const record of removed) this.#records.delete(record.key);
      try {
        await this.#write();
      } catch (error) {
        for (const record of removed) this.#records.set(record.key, record);
        throw error;
      }
      this.#writes += 1;
      this.#pruned += removed.length;
      return removed;
    });
    this.#chain = pruning.then(
      () => undefined,
      () => undefined,
    );
    return pruning;
  }

  async #write(): Promise<void> {
    await this.#fileSystem.writeWholeFile(this.#path, Buffer.from(this.encode(), "utf8"));
  }

  /** The document as own-data JSON, keys in a stable order. */
  encode(): string {
    const windows: Record<string, unknown> = {};
    for (const record of this.records()) windows[record.key] = record;
    return encodePlainJson({ schemaVersion: ADMISSION_LEDGER_SCHEMA_VERSION, windows }, { indent: 2 });
  }

  /** Waits for every queued rewrite to settle. */
  async settle(): Promise<void> {
    let chain = this.#chain;
    for (;;) {
      await chain;
      if (this.#chain === chain) return;
      chain = this.#chain;
    }
  }

  get path(): string {
    return this.#path;
  }

  metrics(): AdmissionLedgerMetrics {
    return { recordsLoaded: this.#loaded, writes: this.#writes, pruned: this.#pruned };
  }
}
