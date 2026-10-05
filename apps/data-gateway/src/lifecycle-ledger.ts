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
 * the feed chose and where it came from, the `closesAt` of the scheduled and
 * the observed `MarketClosing`, and whether the venue contradicted the
 * configuration before the market ever opened. The feed reads it at start
 * and never mints an instant the ledger already holds.
 *
 * ## Intent, then confirmation (`UNIV-4` r1, HIGH-1)
 *
 * Every event instant is written TWICE: first as an INTENT — before the
 * event is dispatched, so the instant is fixed whatever happens next — and
 * then, once the publisher reports `published: true`, as a CONFIRMATION
 * (`*ConfirmedAt`). An intent without its confirmation means "chosen, not
 * known to have reached the stream": the feed re-emits it, WITH THE PERSISTED
 * INSTANT, on the first successful poll of a later epoch. The first round
 * wrote the ledger once, after a fire-and-forget dispatch, so a publication
 * halt (including the gateway's designed recording-only startup mode, §4.2)
 * sealed an instant nobody received and the next epoch never re-emitted it —
 * the market stayed `PENDING` for every consumer, forever. The two writes
 * close both windows: a halt (intent persisted, unconfirmed → replayed) and a
 * crash between dispatch and write (intent persisted first → the same
 * instant is reused, so the universe fold sees an idempotent replay, never a
 * contradiction).
 *
 * ## The identity pair (`UNIV-4` r1, LOW-5)
 *
 * Each record carries the `conditionId` and `gammaMarketId` it was derived
 * under. The feed REFUSES TO START when a loaded record's pair disagrees
 * with the configuration for the same `internalMarketId` — a re-used
 * internal id must not inherit another market's phase — and reports records
 * whose `internalMarketId` the configuration no longer names (carried, never
 * deleted, named in a NOTIFY incident).
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

import { IsoTimestampSchema } from "@polymarket-bot/domain";
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

/**
 * Everything the feed has derived for one market: the instants it CHOSE
 * (intents) and which of them the publisher CONFIRMED.
 */
export interface LifecycleLedgerRecord {
  readonly internalMarketId: string;
  /** The identity pair the record was derived under (LOW-5). */
  readonly conditionId: string;
  readonly gammaMarketId: string;
  /** The receipt instant of the poll whose response first showed the market trade-ready. */
  readonly firstReadyObservedAt?: string;
  /**
   * The receipt instant of the first NOT-ready poll observed at or after the
   * configured `openTime` (R2, LOW-2): once set, `openTime` can no longer be
   * the honest open instant.
   */
  readonly notReadyAfterOpenTimeAt?: string;
  /** The `openedAt` the `MarketOpened` carries. An intent until `openedConfirmedAt`. */
  readonly openedAt?: string;
  readonly openedAtOrigin?: OpenedAtOrigin;
  readonly openedConfirmedAt?: string;
  /** The `closesAt` of the scheduled `MarketClosing` (the configured `closeTime`). */
  readonly scheduledClosesAt?: string;
  readonly scheduledClosingConfirmedAt?: string;
  /** The `closesAt` of the observed `MarketClosing` (a receipt instant). */
  readonly observedClosesAt?: string;
  readonly observedClosingConfirmedAt?: string;
  /** The instant a poll showed `closed`/`archived` before the market ever opened. */
  readonly contradictedAt?: string;
}

const RECORD_KEYS = [
  "internalMarketId",
  "conditionId",
  "gammaMarketId",
  "firstReadyObservedAt",
  "notReadyAfterOpenTimeAt",
  "openedAt",
  "openedAtOrigin",
  "openedConfirmedAt",
  "scheduledClosesAt",
  "scheduledClosingConfirmedAt",
  "observedClosesAt",
  "observedClosingConfirmedAt",
  "contradictedAt",
] as const;

/** The keys that carry an instant: every one must be an ISO-8601 instant at load (r2, MEDIUM-R1). */
const INSTANT_KEYS = [
  "firstReadyObservedAt",
  "notReadyAfterOpenTimeAt",
  "openedAt",
  "openedConfirmedAt",
  "scheduledClosesAt",
  "scheduledClosingConfirmedAt",
  "observedClosesAt",
  "observedClosingConfirmedAt",
  "contradictedAt",
] as const;

/** Each confirmation names the intent it confirms; a confirmation without its intent is refused. */
const CONFIRMATIONS = [
  ["openedConfirmedAt", "openedAt"],
  ["scheduledClosingConfirmedAt", "scheduledClosesAt"],
  ["observedClosingConfirmedAt", "observedClosesAt"],
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
  const conditionId = ownString(value, "conditionId");
  const gammaMarketId = ownString(value, "gammaMarketId");
  if (conditionId === undefined || gammaMarketId === undefined) {
    throw new GatewayStateError(
      "the lifecycle ledger holds a market entry without its conditionId and gammaMarketId; the record cannot be attributed",
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
  for (const key of INSTANT_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    // r2 (MEDIUM-R1): an instant that is not an ISO-8601 instant would reach
    // the publisher inside a replayed event and be REJECTED there — a
    // non-halting rejection a later event could overtake. Refused at load,
    // where it names the field and fails the start.
    if (typeof raw !== "string" || !IsoTimestampSchema.safeParse(raw).success) {
      throw new GatewayStateError(
        `the lifecycle ledger holds ${key} that is not an ISO-8601 instant; a replayed event would be refused by the frozen contract, so the record is refused here — repair or remove it before starting`,
        { internalMarketId, key, value: typeof raw === "string" ? raw : typeof raw },
      );
    }
  }
  for (const [confirmation, intent] of CONFIRMATIONS) {
    if (ownString(value, confirmation) !== undefined && ownString(value, intent) === undefined) {
      throw new GatewayStateError(
        `the lifecycle ledger holds ${confirmation} without its ${intent}; a confirmation of nothing cannot be trusted`,
        { internalMarketId },
      );
    }
  }
  const optional = (key: (typeof RECORD_KEYS)[number]): Record<string, string> => {
    const read = ownString(value, key);
    return read === undefined ? {} : { [key]: read };
  };
  return ownLedgerRecord({
    internalMarketId,
    conditionId,
    gammaMarketId,
    ...optional("firstReadyObservedAt"),
    ...optional("notReadyAfterOpenTimeAt"),
    ...(openedAt === undefined ? {} : { openedAt }),
    ...(origin === undefined ? {} : { openedAtOrigin: origin }),
    ...optional("openedConfirmedAt"),
    ...optional("scheduledClosesAt"),
    ...optional("scheduledClosingConfirmedAt"),
    ...optional("observedClosesAt"),
    ...optional("observedClosingConfirmedAt"),
    ...optional("contradictedAt"),
  });
}

/**
 * D4: a record with no prototype and only the keys it carries, so a later
 * `record.openedAt !== undefined` cannot be answered by `Object.prototype`.
 */
function ownLedgerRecord(record: LifecycleLedgerRecord): LifecycleLedgerRecord {
  // Built as the record type itself on a null prototype: the keys are the
  // declared ones, read by own-descriptor so an inherited value is never
  // copied, and the result is frozen.
  const built = Object.create(null) as LifecycleLedgerRecord;
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
  return Object.freeze(built);
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
   * the rewrite has completed; rejects with the filesystem's error, in which
   * case the in-memory record is ROLLED BACK to what the file still holds —
   * a caller that reads the ledger after a failed put sees the durable truth,
   * not the intent that never landed (r1: the feed's intent-before-dispatch
   * rule depends on this).
   */
  put(record: LifecycleLedgerRecord): Promise<void> {
    const own = ownLedgerRecord(record);
    const write = this.#chain.then(async () => {
      const previous = this.#records.get(own.internalMarketId);
      this.#records.set(own.internalMarketId, own);
      try {
        await this.#fileSystem.writeWholeFile(this.#path, Buffer.from(this.encode(), "utf8"));
      } catch (error) {
        if (previous === undefined) {
          this.#records.delete(own.internalMarketId);
        } else {
          this.#records.set(own.internalMarketId, previous);
        }
        throw error;
      }
      this.#writes += 1;
    });
    // The chain itself must not stay rejected forever: a failed write is the
    // caller's to report, and the next write must still be attempted.
    this.#chain = write.catch(() => undefined);
    return write;
  }

  /**
   * `ROLLOVER-1`: removes one record and rewrites the file durably — ONLY for
   * an admitted series window the admission feed has retired and whose
   * retention has passed (`../admission-ledger.ts`): such a window is never
   * polled or emitted for again, and a configured market's record is never
   * removed (the module header's "carried, never deleted" rule stands for
   * them). A failed write restores the record. Resolves to whether one was held.
   */
  remove(internalMarketId: string): Promise<boolean> {
    const removal = this.#chain.then(async () => {
      const previous = this.#records.get(internalMarketId);
      if (previous === undefined) return false;
      this.#records.delete(internalMarketId);
      try {
        await this.#fileSystem.writeWholeFile(this.#path, Buffer.from(this.encode(), "utf8"));
      } catch (error) {
        this.#records.set(internalMarketId, previous);
        throw error;
      }
      this.#writes += 1;
      return true;
    });
    this.#chain = removal.then(
      () => undefined,
      () => undefined,
    );
    return removal;
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
