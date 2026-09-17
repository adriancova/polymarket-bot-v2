/**
 * The market lifecycle ledger (`UNIV-4`): the gateway's durable memory of
 * which lifecycle events it has already produced for each configured market,
 * and with which instants.
 *
 * ## Why it exists
 *
 * `packages/universe`'s fold REFUSES a `MarketOpened` whose `openedAt`
 * differs from the one it already recorded (`lifecycle.ts` `applyOpened`:
 * "an open instant is a fact about the past: it happened once"). The WAL is
 * a per-epoch log of RAW frames — a restart mints a new epoch and a new
 * directory, and nothing in it says what the previous epoch DERIVED. So a
 * restarted gateway that re-observed a ready market would mint a fresh
 * first-observation instant, publish a contradicting `MarketOpened`, and the
 * market would never open again for any consumer holding the first one.
 *
 * This ledger is the journal of the DERIVED facts: per market, the `openedAt`
 * the feed emitted and where it came from, whether the scheduled
 * `MarketClosing` was emitted, whether the observed one was, and whether the
 * venue contradicted the configuration before the market ever opened. The
 * feed reads it at start and never mints an instant the ledger already holds.
 *
 * ## Where it lives, and how it is written
 *
 * `<walRoot>/market-lifecycle-ledger.json`, beside the per-epoch WAL
 * directories, through the SAME `WalFileSystem` port the journal uses —
 * whose `writeWholeFile` is temp-file-plus-fsync-plus-rename
 * (`packages/storage-wal/src/node-file-system.ts`), so a crash mid-write
 * leaves the previous ledger intact rather than a torn one. It is a file,
 * not a directory, so no WAL tool can mistake it for an epoch. Writes are
 * serialized on one chain: two markets opening in the same cycle cannot
 * interleave their rewrites.
 *
 * ## Encoding and reading are own-data
 *
 * Encoded with `@polymarket-bot/risk/plain-json`, the own-data encoder every
 * persisted line in the WAL uses since `SER-2` (`JSON.stringify` resolves
 * `toJSON` through the prototype chain). Read back through
 * `./config-door.ts`'s `readOwnConfig`: own descriptors only, null
 * prototypes, no accessor invoked. A ledger that cannot be read — not JSON,
 * not the documented shape, a record without an `openedAt` — is REFUSED at
 * open, and the gateway fails to start: minting a fresh instant over an
 * unreadable ledger is exactly the contradiction the ledger exists to
 * prevent, so an unreadable ledger is an operator's problem to repair, not a
 * default to fall back from.
 *
 * ## What it is not
 *
 * Not the universe projection (that is the trader's, folded from the
 * stream), not a cache of venue state (every poll is re-derived from the
 * venue's answer), and not evidence of the venue (the WAL holds that). It
 * records only what THIS gateway emitted, so that it never emits a
 * contradiction.
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
import type { WalFileSystem } from "@polymarket-bot/storage-wal";

import { isOwnRecord, readOwnConfig, type OwnRecord } from "./config-door.js";
import { GatewayStateError } from "./errors.js";

/** File name under the WAL root. */
export const LIFECYCLE_LEDGER_FILE_NAME = "market-lifecycle-ledger.json";

/** The ledger's own format version, checked on read. */
export const LIFECYCLE_LEDGER_SCHEMA_VERSION = 1;

/** Where a market's `openedAt` came from (the derivation rule in `feeds/market-lifecycle.ts`). */
export type OpenedAtOrigin = "configuration" | "observation";

/** Everything the feed has emitted for one market. */
export interface LifecycleLedgerRecord {
  readonly internalMarketId: string;
  /** The `openedAt` the emitted `MarketOpened` carried. Absent until emitted. */
  readonly openedAt?: string;
  readonly openedAtOrigin?: OpenedAtOrigin;
  /** The receipt instant of the poll whose response first showed the market trade-ready. */
  readonly firstReadyObservedAt?: string;
  /** The `closesAt` of the emitted scheduled `MarketClosing` (the configured `closeTime`). */
  readonly scheduledClosesAt?: string;
  /** The `closesAt` of the emitted observed `MarketClosing` (an observation instant). */
  readonly observedClosesAt?: string;
  /** The instant a poll showed `closed`/`archived` before the market ever opened. */
  readonly contradictedAt?: string;
}

const RECORD_KEYS = [
  "internalMarketId",
  "openedAt",
  "openedAtOrigin",
  "firstReadyObservedAt",
  "scheduledClosesAt",
  "observedClosesAt",
  "contradictedAt",
] as const;

function ownString(record: OwnRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readRecord(value: unknown, internalMarketId: string): LifecycleLedgerRecord {
  if (!isOwnRecord(value)) {
    throw new GatewayStateError("the lifecycle ledger holds a market entry that is not an object", {
      internalMarketId,
    });
  }
  for (const key of Object.keys(value)) {
    if (!(RECORD_KEYS as readonly string[]).includes(key)) {
      throw new GatewayStateError("the lifecycle ledger holds a market entry with an unknown key", {
        internalMarketId,
        key,
      });
    }
  }
  if (ownString(value, "internalMarketId") !== internalMarketId) {
    throw new GatewayStateError(
      "the lifecycle ledger holds a market entry whose internalMarketId does not match its key",
      { internalMarketId },
    );
  }
  const openedAt = ownString(value, "openedAt");
  const origin = ownString(value, "openedAtOrigin");
  if (origin !== undefined && origin !== "configuration" && origin !== "observation") {
    throw new GatewayStateError("the lifecycle ledger holds an unknown openedAtOrigin", {
      internalMarketId,
      openedAtOrigin: origin,
    });
  }
  if ((openedAt === undefined) !== (origin === undefined)) {
    throw new GatewayStateError(
      "the lifecycle ledger holds openedAt without its origin (or the reverse); the record cannot be trusted",
      { internalMarketId },
    );
  }
  for (const key of RECORD_KEYS) {
    if (key === "internalMarketId") continue;
    const raw = value[key];
    if (raw !== undefined && typeof raw !== "string") {
      throw new GatewayStateError("the lifecycle ledger holds a non-string instant", {
        internalMarketId,
        key,
      });
    }
  }
  const firstReadyObservedAt = ownString(value, "firstReadyObservedAt");
  const scheduledClosesAt = ownString(value, "scheduledClosesAt");
  const observedClosesAt = ownString(value, "observedClosesAt");
  const contradictedAt = ownString(value, "contradictedAt");
  return ownLedgerRecord({
    internalMarketId,
    ...(openedAt === undefined ? {} : { openedAt }),
    ...(origin === undefined ? {} : { openedAtOrigin: origin }),
    ...(firstReadyObservedAt === undefined ? {} : { firstReadyObservedAt }),
    ...(scheduledClosesAt === undefined ? {} : { scheduledClosesAt }),
    ...(observedClosesAt === undefined ? {} : { observedClosesAt }),
    ...(contradictedAt === undefined ? {} : { contradictedAt }),
  });
}

/**
 * D4: a record with no prototype and only the keys it carries, so a later
 * `record.openedAt !== undefined` cannot be answered by `Object.prototype`.
 */
function ownLedgerRecord(record: LifecycleLedgerRecord): LifecycleLedgerRecord {
  const built = Object.create(null) as Record<string, unknown>;
  for (const key of RECORD_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    const value: unknown = descriptor.value;
    if (value === undefined) continue;
    // A prototype-free descriptor: an inherited `get` on `Object.prototype`
    // makes every object-literal descriptor throw (ADR-020 §1 class 8).
    const data = Object.create(null) as PropertyDescriptor;
    data.value = value;
    data.enumerable = true;
    data.writable = false;
    data.configurable = false;
    Object.defineProperty(built, key, data);
  }
  return Object.freeze(built) as unknown as LifecycleLedgerRecord;
}

export interface LifecycleLedgerOptions {
  readonly fileSystem: WalFileSystem;
  readonly walRootPath: string;
}

export interface LifecycleLedgerMetrics {
  readonly recordsLoaded: number;
  readonly writes: number;
}

export class LifecycleLedger {
  readonly #fileSystem: WalFileSystem;
  readonly #path: string;
  readonly #records = new Map<string, LifecycleLedgerRecord>();
  #writes = 0;
  readonly #loaded: number;
  /** One serial chain, so two rewrites never interleave. */
  #chain: Promise<void> = Promise.resolve();

  private constructor(
    fileSystem: WalFileSystem,
    path: string,
    records: readonly LifecycleLedgerRecord[],
  ) {
    this.#fileSystem = fileSystem;
    this.#path = path;
    for (const record of records) {
      this.#records.set(record.internalMarketId, record);
    }
    this.#loaded = records.length;
  }

  /**
   * Opens the ledger: reads the file if it exists, refusing anything that is
   * not the documented shape (module header: an unreadable ledger fails the
   * start rather than being replaced).
   */
  static async open(options: LifecycleLedgerOptions): Promise<LifecycleLedger> {
    await options.fileSystem.ensureDirectory(options.walRootPath);
    const path = options.fileSystem.joinPath(options.walRootPath, LIFECYCLE_LEDGER_FILE_NAME);
    const length = await options.fileSystem.fileByteLength(path);
    if (length === null) {
      return new LifecycleLedger(options.fileSystem, path, []);
    }
    const bytes = await options.fileSystem.readWholeFile(path);
    return new LifecycleLedger(
      options.fileSystem,
      path,
      LifecycleLedger.decode(Buffer.from(bytes).toString("utf8")),
    );
  }

  /** The ledger's document, read as own data and checked field by field. */
  static decode(text: string): readonly LifecycleLedgerRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new GatewayStateError("the lifecycle ledger is not JSON; repair or remove it before starting", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const read = readOwnConfig(parsed);
    if (!read.ok || !isOwnRecord(read.value)) {
      throw new GatewayStateError("the lifecycle ledger is not a plain JSON object", {
        detail: read.ok ? "not an object" : read.detail,
      });
    }
    const document = read.value;
    if (document["schemaVersion"] !== LIFECYCLE_LEDGER_SCHEMA_VERSION) {
      throw new GatewayStateError("the lifecycle ledger has an unknown schemaVersion", {
        schemaVersion: document["schemaVersion"],
        expected: LIFECYCLE_LEDGER_SCHEMA_VERSION,
      });
    }
    const markets = document["markets"];
    if (!isOwnRecord(markets)) {
      throw new GatewayStateError("the lifecycle ledger has no markets object");
    }
    return Object.keys(markets).map((internalMarketId) =>
      readRecord(markets[internalMarketId], internalMarketId),
    );
  }

  /** The record for one market, or `undefined` when the feed has emitted nothing for it. */
  get(internalMarketId: string): LifecycleLedgerRecord | undefined {
    return this.#records.get(internalMarketId);
  }

  /** Every record, for diagnostics. */
  records(): readonly LifecycleLedgerRecord[] {
    return [...this.#records.values()];
  }

  /**
   * Replaces one market's record and rewrites the file durably. Resolves when
   * the rewrite has completed (or rejects with the filesystem's error, which
   * the feed reports as a recording failure).
   */
  put(record: LifecycleLedgerRecord): Promise<void> {
    const own = ownLedgerRecord(record);
    this.#records.set(own.internalMarketId, own);
    const write = this.#chain.then(async () => {
      await this.#fileSystem.writeWholeFile(this.#path, Buffer.from(this.encode(), "utf8"));
      this.#writes += 1;
    });
    // The chain itself must not stay rejected forever: a failed write is the
    // caller's to report, and the next write must still be attempted.
    this.#chain = write.catch(() => undefined);
    return write;
  }

  /** The document as own-data JSON, keys in a stable order. */
  encode(): string {
    const markets: Record<string, unknown> = {};
    for (const internalMarketId of [...this.#records.keys()].sort()) {
      const record = this.#records.get(internalMarketId);
      if (record === undefined) continue;
      const entry: Record<string, unknown> = {};
      for (const key of RECORD_KEYS) {
        const value = record[key];
        if (value !== undefined) entry[key] = value;
      }
      markets[internalMarketId] = entry;
    }
    return encodePlainJson(
      { schemaVersion: LIFECYCLE_LEDGER_SCHEMA_VERSION, markets },
      { indent: 2 },
    );
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

  metrics(): LifecycleLedgerMetrics {
    return { recordsLoaded: this.#loaded, writes: this.#writes };
  }
}
