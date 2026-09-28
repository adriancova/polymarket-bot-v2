/**
 * `FOLD-1` — the core loop's HELD accounting state, and the check that a
 * rebuild from zero equals it (§6 invariant 8).
 *
 * ## What changed, and why it is not a new accounting
 *
 * The loop used to rebuild its ledger view with `projectLedger` — a fold of
 * the WHOLE in-memory ledger — several times per event, and to rebuild each
 * instance's PnL state with `foldPnlRecords` — a fold of the whole record
 * stream — once per fill. Both costs grew with the run (`LOOPMEM-FOLD`: about
 * 33 µs per ledger transaction per call, and a PnL fold that is quadratic in
 * the stream). Both folds are LEFT FOLDS of a step each package exports:
 *
 * - `projectLedger(ledger)` is `emptyProjection()` folded with
 *   `applyTransaction` over `ledger.transactions()`
 *   (`packages/ledger/src/projections.ts`, "the single fold step both the
 *   incremental path and the rebuild path share");
 * - `foldPnlRecords(identity, records)` is `emptyPnlState(identity)` folded
 *   with `applyPnlRecord` over the records, stopping at the first refusal
 *   (`packages/pnl/src/state.ts`).
 *
 * So the loop now HOLDS the fold's result and advances it with the SAME step
 * over only what is new: the transactions a posting appended, the records a
 * fill produced. An incremental fold equals the rebuild BY CONSTRUCTION —
 * same step, same inputs, same order (the ledger view's Map insertion order
 * included) — and nothing here computes a number either package does not.
 * `projectLedger` and `foldPnlRecords` stay pure and uncached; they are what
 * the check below runs.
 *
 * ## §6 invariant 8, as recorded for `FOLD-1`
 *
 * "Positions, balances, and PnL projections are rebuildable from append-only
 * events." The orchestrator's recorded reading (IMPLEMENTATION_STATUS.md,
 * `FOLD-1`): an INCREMENTAL state is allowed provided a from-zero rebuild
 * EQUALS it and is RUN as a check — ADR-006 §1 ("A rebuild from zero must
 * equal the incremental state"), handoff §16.2 ("Position projection rebuilt
 * from events equals incremental projection"). So the rebuild is RUN, on
 * serialized bytes (`serializeProjection`, `serializePnlState`):
 *
 * - the LEDGER view after every `everyFills`-th posted fill (the PAPER
 *   cadence is {@link PAPER_ACCOUNTING_CHECKS}: every 50 fills), and at
 *   shutdown or the end of a run (`CoreLoop.checkAccountingRebuild`);
 * - each instance's PnL stream at the same points — every due posted fill,
 *   owned OR unowned, and shutdown or the end of a run — ONLY when `pnl` is
 *   on: the test and golden harnesses' {@link EVERY_FILL_ACCOUNTING_CHECKS}.
 *   A from-zero PnL fold is quadratic in the stream today, so the user's
 *   ruling F2 keeps it out of PAPER until `FOLD-2` makes it cheap. A PnL
 *   check answers for the instance's WHOLE record list, never a prefix: a
 *   stream a failed store write left behind is caught up first
 *   ({@link HeldAccounting.checkPnl}, `FOLD1-R1-1`).
 *
 * A mismatch is never silent: it is counted here (`seams.folds`), the loop
 * latches a GLOBAL `ACCOUNTING_REBUILD_MISMATCH` halt (fail-closed), and the
 * held state is REPLACED by the rebuild — the ledger is the source of truth,
 * so the accounting reads and PnL snapshots that still happen under a halt
 * (the loop's "the books stay truthful") read the rebuild, not the state that
 * diverged from it. (Only a rebuild that itself fails leaves the held state in
 * place, and the halt detail says so; the mismatch is counted and halted
 * either way.)
 *
 * ## What a held state newly risks, and what catches it
 *
 * A fresh fold per call could not carry a corruption from one call to the
 * next; a held one can. `packages/ledger`'s container guard documents its own
 * bypass (`Map.prototype.set.call(guarded, k, v)` still reaches the internal
 * slot), and a step that skipped or doubled a transaction would drift the
 * same way. That is exactly what the rebuild check is for, and why its
 * mismatch halts rather than logs. The loop and its view are also moved
 * TOGETHER, in one place ({@link HeldAccounting.adopt}), and a view whose
 * transaction count does not match the ledger it is adopted with is refused
 * as a failed posting — so the loop can never hold a view of a ledger it does
 * not hold.
 *
 * ## The PnL refusal behaviour is unchanged (user ruling F3)
 *
 * The loop's stream is append-only, so once record `k` is refused, every
 * from-zero fold refuses at `k` too and the instance gets no further PnL
 * snapshot. A held stream reproduces that by RETRYING FROM THE FAILURE POINT:
 * it keeps the state before record `k` and re-applies `k` on every later
 * advance. That equals the from-zero fold whether a refusal is permanent or
 * (hypothetically) transient; skipping the refused record and continuing
 * would NOT (the `FOLD-1` scoping reproduced the divergence). What F3 adds is
 * visibility: each refused record is COUNTED once, by instance and refusal
 * code, on `seams.folds.pnlRefusals`.
 *
 * NOT MEMORY-BOUNDED. The ledger and the loop's PnL record lists are kept
 * whole (every accessor and golden reads them, and they are what a rebuild
 * reads); bounding them is `LOOPMEM-FOLD` Option 4, deferred behind
 * `RECON2-DURABLE`.
 */

import {
  applyTransaction,
  projectLedger,
  serializeProjection,
  type Ledger,
  type LedgerProjection,
} from "@polymarket-bot/ledger";
import {
  applyPnlRecord,
  emptyPnlState,
  foldPnlRecords,
  serializePnlState,
  type PnlRecord,
  type PnlState,
  type PnlStreamIdentity,
} from "@polymarket-bot/pnl";

import type { PostFillOutcome } from "./accounting.js";

/**
 * How often the loop runs its rebuild checks. A CoreLoop constructor option
 * set in CODE by a composition, never operator configuration (orchestrator
 * call O1): no configuration document carries it.
 */
export interface AccountingChecks {
  /**
   * The ledger rebuild check runs after every `everyFills`-th posted fill
   * (owned and unowned alike). A positive safe integer; default 50.
   */
  readonly everyFills?: number;
  /**
   * Also compare each PnL stream with its from-zero fold at every check.
   * Default `false`: a from-zero PnL fold is quadratic in the stream today
   * (user ruling F2 — tests only, until `FOLD-2`).
   */
  readonly pnl?: boolean;
}

/** The PAPER cadence (ruling F2): the ledger every 50 fills, plus shutdown or end of run; no PnL check. */
export const PAPER_ACCOUNTING_CHECKS: Readonly<Required<AccountingChecks>> = Object.freeze({
  everyFills: 50,
  pnl: false,
});

/**
 * The test and golden harnesses' cadence (orchestrator call O1): the ledger
 * AND every PnL stream after EVERY fill.
 */
export const EVERY_FILL_ACCOUNTING_CHECKS: Readonly<Required<AccountingChecks>> = Object.freeze({
  everyFills: 1,
  pnl: true,
});

/** Why a cadence is refused, or `undefined` when it is acceptable. */
export function accountingChecksProblem(checks: AccountingChecks): string | undefined {
  const everyFills: unknown = checks.everyFills;
  if (
    everyFills !== undefined &&
    (typeof everyFills !== "number" || !Number.isSafeInteger(everyFills) || everyFills < 1)
  ) {
    return `accountingChecks.everyFills must be a positive safe integer; received ${String(everyFills)}`;
  }
  const pnl: unknown = checks.pnl;
  if (pnl !== undefined && typeof pnl !== "boolean") {
    return `accountingChecks.pnl must be a boolean; received ${String(pnl)}`;
  }
  return undefined;
}

/**
 * `seams.folds` — the held state's counters (`FOLD-1`). A NEW seam key, and
 * deliberately not a field under `health.accounting` / `health.loop`: the
 * paper-e2e golden copies those sections whole, so a counter there would
 * change its bytes.
 */
export interface FoldHealth {
  /** The cadence: the ledger check runs after every `checkEveryFills`-th posted fill. */
  readonly checkEveryFills: number;
  /** Whether each check also compares every PnL stream with its from-zero fold. */
  readonly pnlCheck: boolean;
  /** Postings (owned and unowned fills) that advanced the held ledger view. */
  readonly fillsPosted: number;
  /** Ledger rebuild checks run: on the cadence, at shutdown and at the end of a run. */
  readonly ledgerChecks: number;
  /**
   * PnL stream comparisons run: one per instance with PnL records, per check —
   * on the cadence at every due posted fill, owned or unowned, and at shutdown
   * or the end of a run. Each compares the instance's WHOLE record list.
   */
  readonly pnlChecks: number;
  /** `fillsPosted` when the last ledger check ran; `null` before the first — never a zero nobody measured. */
  readonly fillsAtLastCheck: number | null;
  /** Ledger checks whose rebuild differed from the held view. Each latched a GLOBAL halt. */
  readonly ledgerMismatches: number;
  /** PnL comparisons whose rebuild differed from the held stream. Each latched a GLOBAL halt. */
  readonly pnlMismatches: number;
  /**
   * Ruling F3: refused PnL records, `instanceId -> refusal code -> count`,
   * each record counted ONCE — when its stream first stopped on it (the
   * retries that follow are the same refusal, not new ones). An instance
   * listed here gets no further PnL snapshot while its stream is stopped,
   * exactly as before `FOLD-1`. BOUNDED: the instances are the registry's,
   * fixed at startup, and the codes are `packages/pnl`'s closed vocabulary.
   * Keys are emitted sorted.
   */
  readonly pnlRefusals: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** A posting that failed — `postFill`'s own failures, plus the held view's fold. */
export interface FailedPosting {
  readonly ok: false;
  readonly stage: "ALLOCATE" | "BUILD_POSTING" | "APPEND" | "VIEW_FOLD";
  readonly code: string;
  readonly detail: string;
  readonly issues: readonly string[];
}

/** A posting whose appended transactions were folded onto the held view, NOT yet adopted. */
export type FoldedPosting =
  | (Extract<PostFillOutcome, { readonly ok: true }> & { readonly view: LedgerProjection })
  | FailedPosting;

/** A check that found a difference: what it found, and whether the held state was replaced by the rebuild. */
export interface RebuildMismatch {
  readonly detail: string;
  /** `false` only when the rebuild itself could not say what the state is; the held state is then kept. */
  readonly replaced: boolean;
}

/** One instance's held PnL stream. */
interface HeldPnlStream {
  readonly identity: PnlStreamIdentity;
  /** The fold of `records[0, applied)`. */
  state: PnlState;
  /** How many records `state` has folded; `< seen` while a refused record stops the stream. */
  applied: number;
  /**
   * How many records the stream had at its last advance — by a snapshot or
   * by a check's catch-up. A snapshot is computed only when `applied` has
   * reached it with no refusal ({@link HeldAccounting.completePnlState}).
   */
  seen: number;
  /** The index of the refused record that stops the stream, if any. */
  refusedAt: number | undefined;
  /** That record's (first) refusal code. */
  refusalCode: string | undefined;
}

/** A thrown value's TYPE, never its message (`packages/pnl`'s `contained` rule). */
function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.name;
  return value === null ? "null" : typeof value;
}

/** The first differing offset of two strings, and a short excerpt of each there. */
function firstDifference(held: string, rebuilt: string): string {
  let offset = 0;
  const shorter = Math.min(held.length, rebuilt.length);
  while (offset < shorter && held.charCodeAt(offset) === rebuilt.charCodeAt(offset)) offset += 1;
  const excerpt = (text: string): string => JSON.stringify(text.slice(offset, offset + 48));
  return (
    `held ${String(held.length)} bytes, rebuilt ${String(rebuilt.length)} bytes, first difference at ` +
    `byte ${String(offset)}: held ${excerpt(held)} vs rebuilt ${excerpt(rebuilt)}`
  );
}

/**
 * The index a `foldPnlRecords` refusal names — `packages/pnl`'s own wrapper,
 * `PNL_INPUT_INVALID` "fold refused at record index k" with `details.index`
 * — and the refused record's own first code, which follows it.
 */
function foldRefusalAt(
  refusals: readonly { readonly code: string; readonly details?: unknown }[],
): { readonly index: number | undefined; readonly code: string | undefined } {
  const details = refusals[0]?.details;
  const index =
    typeof details === "object" && details !== null && Object.hasOwn(details, "index")
      ? (details as { readonly index: unknown }).index
      : undefined;
  return {
    index: typeof index === "number" ? index : undefined,
    code: refusals[1]?.code,
  };
}

/**
 * The loop's ledger, its held view, and its held PnL streams — held TOGETHER.
 *
 * The ledger and the view have exactly one writer, {@link HeldAccounting.adopt},
 * which sets both; there is no path that moves one without the other.
 */
export class HeldAccounting {
  readonly #everyFills: number;
  readonly #pnlCheck: boolean;
  #ledger: Ledger;
  #view: LedgerProjection;
  readonly #streams = new Map<string, HeldPnlStream>();

  #fillsPosted = 0;
  #ledgerChecks = 0;
  #pnlChecks = 0;
  #fillsAtLastCheck: number | null = null;
  #ledgerMismatches = 0;
  #pnlMismatches = 0;
  readonly #pnlRefusals = new Map<string, Map<string, number>>();

  /**
   * Folds the starting ledger ONCE, from zero — the only `projectLedger` call
   * outside the checks. Throws on a refused cadence, as the loop's other
   * bounds do; `createPaperTrader` refuses one by name first.
   */
  constructor(ledger: Ledger, checks: AccountingChecks = {}) {
    const problem = accountingChecksProblem(checks);
    if (problem !== undefined) {
      throw new RangeError(`${problem}; the rebuild check needs a cadence it can keep (FOLD-1)`);
    }
    this.#everyFills = checks.everyFills ?? PAPER_ACCOUNTING_CHECKS.everyFills;
    this.#pnlCheck = checks.pnl ?? PAPER_ACCOUNTING_CHECKS.pnl;
    this.#ledger = ledger;
    this.#view = projectLedger(ledger);
  }

  /** The ledger the loop posts to. */
  get ledger(): Ledger {
    return this.#ledger;
  }

  /** The held view of {@link ledger}: what the loop's four read sites read. */
  get view(): LedgerProjection {
    return this.#view;
  }

  /** Whether checks also compare the PnL streams. */
  get pnlCheck(): boolean {
    return this.#pnlCheck;
  }

  /** `fillsPosted`, for a check's detail. */
  get fillsPosted(): number {
    return this.#fillsPosted;
  }

  /** The cadence, for a check's detail. */
  get everyFills(): number {
    return this.#everyFills;
  }

  /**
   * Folds a posting's APPENDED transactions onto the held view, without
   * adopting anything. A failed posting passes through unchanged. A fold that
   * throws, or whose result does not count the new ledger's transactions,
   * becomes a failed posting at stage `VIEW_FOLD` — which the loop treats
   * exactly as it treats a posting failure at that site: the fill is not
   * booked, neither the ledger nor the view moves, and the market halts
   * `LEDGER_POSTING_REFUSED`.
   */
  fold(outcome: PostFillOutcome): FoldedPosting {
    if (!outcome.ok) return outcome;
    let view = this.#view;
    for (const appended of outcome.appended) {
      try {
        view = applyTransaction(view, appended);
      } catch (error) {
        return {
          ok: false,
          stage: "VIEW_FOLD",
          code: "LEDGER_VIEW_FOLD_FAILED",
          detail:
            `the held ledger view could not fold transaction ${appended.transaction.ledgerTransactionId} ` +
            `(sequence ${String(appended.sequence)}): applyTransaction threw a ${describeThrown(error)}; ` +
            "the posting is not adopted, so the ledger and its view stay together (FOLD-1)",
          issues: [],
        };
      }
    }
    if (view.transactionCount !== outcome.ledger.length) {
      return {
        ok: false,
        stage: "VIEW_FOLD",
        code: "LEDGER_VIEW_OUT_OF_STEP",
        detail:
          `the held ledger view would count ${String(view.transactionCount)} transactions for a ledger ` +
          `of ${String(outcome.ledger.length)}; the posting did not extend the ledger this view folds, so ` +
          "it is not adopted (FOLD-1: one ledger and one view, always moved together)",
        issues: [],
      };
    }
    return { ...outcome, view };
  }

  /**
   * Adopts a folded posting: the ledger AND its view, together — the ONLY
   * writer of either. Answers whether the cadence's checks are due.
   */
  adopt(posting: Extract<FoldedPosting, { readonly ok: true }>): boolean {
    this.#ledger = posting.ledger;
    this.#view = posting.view;
    this.#fillsPosted += 1;
    return this.#fillsPosted % this.#everyFills === 0;
  }

  /**
   * The held view against `projectLedger(ledger)`, on serialized bytes.
   * `undefined` when they are equal; otherwise the difference, stated — and
   * the held view is REPLACED by the rebuild (see the module header), unless
   * the rebuild itself failed.
   */
  checkLedger(): RebuildMismatch | undefined {
    this.#ledgerChecks += 1;
    this.#fillsAtLastCheck = this.#fillsPosted;
    let rebuilt: LedgerProjection;
    let rebuiltBytes: string;
    try {
      rebuilt = projectLedger(this.#ledger);
      rebuiltBytes = serializeProjection(rebuilt);
    } catch (error) {
      this.#ledgerMismatches += 1;
      return {
        detail:
          `the rebuild itself failed (projectLedger or serializeProjection threw a ${describeThrown(error)}), ` +
          "so the held view cannot be confirmed",
        replaced: false,
      };
    }
    let heldBytes: string;
    try {
      heldBytes = serializeProjection(this.#view);
    } catch (error) {
      this.#ledgerMismatches += 1;
      this.#view = rebuilt;
      return {
        detail: `the held view could not be serialized (serializeProjection threw a ${describeThrown(error)})`,
        replaced: true,
      };
    }
    if (heldBytes === rebuiltBytes) return undefined;
    this.#ledgerMismatches += 1;
    const detail =
      `held transactionCount ${String(this.#view.transactionCount)}, rebuilt ` +
      `${String(rebuilt.transactionCount)}; ${firstDifference(heldBytes, rebuiltBytes)}`;
    this.#view = rebuilt;
    return { detail, replaced: true };
  }

  /**
   * Advances one instance's held PnL stream over `records` — RETRYING FROM THE
   * FAILURE POINT — and answers its state when every record is folded, or
   * `undefined` while a refused record stops the stream.
   *
   * Opened on the first call with records (unless a check opened it first,
   * {@link checkPnl}), from `identity()`: `emptyPnlState` throws
   * `PnlConfigurationError` on an identity it refuses, and that throw leaves
   * here exactly where `foldPnlRecords` used to throw it from (the loop's
   * `#writePnlSnapshot`), every time, because a refused stream is never
   * stored — by this method or by a check.
   */
  advancePnl(
    instanceId: string,
    identity: () => PnlStreamIdentity,
    records: readonly PnlRecord[],
  ): PnlState | undefined {
    let stream = this.#streams.get(instanceId);
    if (stream === undefined) {
      const opened = identity();
      stream = {
        identity: opened,
        state: emptyPnlState(opened),
        applied: 0,
        seen: 0,
        refusedAt: undefined,
        refusalCode: undefined,
      };
      this.#streams.set(instanceId, stream);
    }
    return this.#advance(instanceId, stream, records) ? stream.state : undefined;
  }

  /**
   * THE incremental PnL step, shared by {@link advancePnl} and
   * {@link checkPnl}: folds `records[applied, length)` onto the held state
   * with `applyPnlRecord`, RETRYING FROM THE FAILURE POINT, and answers
   * whether every record is folded. A refused record is counted ONCE (F3) —
   * the first time its stream stops on it, whichever of the two meets it.
   */
  #advance(instanceId: string, stream: HeldPnlStream, records: readonly PnlRecord[]): boolean {
    stream.seen = records.length;
    while (stream.applied < records.length) {
      const result = applyPnlRecord(stream.state, records[stream.applied]);
      if (!result.ok) {
        if (stream.refusedAt !== stream.applied) {
          const code = result.refusals[0]?.code ?? "PNL_INPUT_INVALID";
          stream.refusedAt = stream.applied;
          stream.refusalCode = code;
          this.#countRefusal(instanceId, code);
        }
        return false;
      }
      stream.state = result.value;
      stream.applied += 1;
      stream.refusedAt = undefined;
      stream.refusalCode = undefined;
    }
    return true;
  }

  /**
   * The held PnL state of one instance — the fold of the records it has
   * applied (all of them, unless a refused record stops the stream) — or
   * `undefined` before its first snapshot.
   */
  pnlState(instanceId: string): PnlState | undefined {
    return this.#streams.get(instanceId)?.state;
  }

  /**
   * The held state a snapshot may be computed from: the fold of EVERY record
   * the stream has seen — `undefined` while a refused record stops it (the
   * from-zero fold would have refused), or before it was opened.
   */
  completePnlState(instanceId: string): PnlState | undefined {
    const stream = this.#streams.get(instanceId);
    if (stream === undefined || stream.refusedAt !== undefined || stream.applied < stream.seen) {
      return undefined;
    }
    return stream.state;
  }

  /** The instances with a held stream, sorted. */
  pnlStreamIds(): readonly string[] {
    return [...this.#streams.keys()].sort();
  }

  /**
   * One instance's PnL stream against `foldPnlRecords` over its WHOLE record
   * list, on serialized bytes. `undefined` when they agree — both folded
   * every record to the same bytes, or both refused at the same index with
   * the same code from the same state — otherwise the difference, and the
   * held stream is REPLACED by the rebuild.
   *
   * The check answers for EVERY record the loop has adopted (`FOLD1-R1-1`),
   * never a prefix. A fill whose ledger-store write failed returns before
   * its snapshot, so its records are in the list while the held stream has
   * not folded them yet — exactly as base's snapshot had not. The check
   * therefore first CATCHES THE HELD STREAM UP with the same step the next
   * snapshot would run ({@link advancePnl}'s: retry from the failure point, a
   * refused record counted once), opening it when no snapshot has yet, and
   * only then compares; `matched` is never said of a state that is behind.
   * The catch-up is what that snapshot would have folded, so the snapshots
   * the loop writes are unchanged.
   *
   * `identity` opens a stream that is not open yet. A stream whose identity
   * `packages/pnl` refuses cannot be opened, and the rebuild — which opens the
   * SAME identity — must refuse it too; the two agree only then (the loop
   * throws from `#writePnlSnapshot` as before, and never stores a stream).
   * `undefined` for an instance the loop cannot name is a mismatch: records
   * with no stream and no identity to open one from are not checkable.
   */
  checkPnl(
    instanceId: string,
    identity: (() => PnlStreamIdentity) | undefined,
    records: readonly PnlRecord[],
  ): RebuildMismatch | undefined {
    this.#pnlChecks += 1;
    let stream = this.#streams.get(instanceId);
    if (stream === undefined) {
      const opened = this.#openForCheck(identity, records);
      if (!opened.ok) {
        if (opened.mismatch === undefined) return undefined;
        this.#pnlMismatches += 1;
        return { detail: opened.mismatch, replaced: false };
      }
      stream = opened.stream;
      this.#streams.set(instanceId, stream);
    }
    this.#advance(instanceId, stream, records);
    const mismatch = this.#comparePnl(stream, records);
    if (mismatch === undefined) return undefined;
    this.#pnlMismatches += 1;
    return { detail: mismatch, replaced: this.#repairPnl(stream, records) };
  }

  /**
   * Opens a stream for {@link checkPnl}, or says why it cannot: `mismatch`
   * `undefined` when the rebuild refuses the identity the same way (the two
   * agree — neither holds a state), otherwise the difference.
   */
  #openForCheck(
    identity: (() => PnlStreamIdentity) | undefined,
    records: readonly PnlRecord[],
  ):
    | { readonly ok: true; readonly stream: HeldPnlStream }
    | { readonly ok: false; readonly mismatch: string | undefined } {
    if (identity === undefined) {
      return {
        ok: false,
        mismatch:
          `the instance has ${String(records.length)} PnL records, no held stream, and no registered ` +
          "identity to open one from, so its state cannot be checked",
      };
    }
    let heldThrew: string;
    try {
      const opened = identity();
      return {
        ok: true,
        stream: {
          identity: opened,
          state: emptyPnlState(opened),
          applied: 0,
          seen: 0,
          refusedAt: undefined,
          refusalCode: undefined,
        },
      };
    } catch (error) {
      heldThrew = describeThrown(error);
    }
    try {
      foldPnlRecords(identity(), records);
    } catch (error) {
      const rebuildThrew = describeThrown(error);
      if (rebuildThrew === heldThrew) return { ok: false, mismatch: undefined };
      return {
        ok: false,
        mismatch: `the held stream could not be opened (a ${heldThrew}); the rebuild threw a ${rebuildThrew}`,
      };
    }
    return {
      ok: false,
      mismatch: `the held stream could not be opened (a ${heldThrew}), but the rebuild from zero could`,
    };
  }

  #comparePnl(stream: HeldPnlStream, records: readonly PnlRecord[]): string | undefined {
    try {
      const rebuilt = foldPnlRecords(stream.identity, records);
      if (stream.refusedAt === undefined) {
        if (stream.applied !== records.length) {
          // Unreachable after the catch-up (`#advance` folds to the end or stops on a refusal); a
          // held stream that says neither is not one the check can vouch for.
          return (
            `the held stream folded ${String(stream.applied)} of the ${String(records.length)} records ` +
            "without stopping on a refusal"
          );
        }
        if (!rebuilt.ok) {
          const at = foldRefusalAt(rebuilt.refusals);
          return (
            `the held stream folded all ${String(records.length)} records; the rebuild refused at record ` +
            `${String(at.index)} (${String(at.code ?? rebuilt.refusals[0]?.code)})`
          );
        }
        const heldBytes = serializePnlState(stream.state);
        const rebuiltBytes = serializePnlState(rebuilt.value);
        return heldBytes === rebuiltBytes ? undefined : firstDifference(heldBytes, rebuiltBytes);
      }
      if (rebuilt.ok) {
        return (
          `the held stream is stopped at record ${String(stream.refusedAt)} (${String(stream.refusalCode)}); ` +
          `the rebuild folded all ${String(records.length)} records`
        );
      }
      const at = foldRefusalAt(rebuilt.refusals);
      if (at.index !== stream.refusedAt || at.code !== stream.refusalCode) {
        return (
          `the held stream is stopped at record ${String(stream.refusedAt)} (${String(stream.refusalCode)}); ` +
          `the rebuild refused at record ${String(at.index)} (${String(at.code)})`
        );
      }
      // Both stop at the same record: the state BEFORE it must agree too.
      const before = foldPnlRecords(stream.identity, records.slice(0, stream.refusedAt));
      if (!before.ok) {
        return `the rebuild of the ${String(stream.refusedAt)} records before the stop refused`;
      }
      const heldBytes = serializePnlState(stream.state);
      const rebuiltBytes = serializePnlState(before.value);
      return heldBytes === rebuiltBytes ? undefined : firstDifference(heldBytes, rebuiltBytes);
    } catch (error) {
      return `the comparison could not be completed (a ${describeThrown(error)} was thrown)`;
    }
  }

  /**
   * Replaces a held stream by its rebuild from zero, when the rebuild can say
   * what that is; answers whether it did. A stream the rebuild cannot describe
   * is left as it was rather than invented — the mismatch is counted and
   * halted either way.
   */
  #repairPnl(stream: HeldPnlStream, records: readonly PnlRecord[]): boolean {
    try {
      const rebuilt = foldPnlRecords(stream.identity, records);
      if (rebuilt.ok) {
        stream.state = rebuilt.value;
        stream.applied = records.length;
        stream.seen = records.length;
        stream.refusedAt = undefined;
        stream.refusalCode = undefined;
        return true;
      }
      const at = foldRefusalAt(rebuilt.refusals);
      if (at.index === undefined) return false;
      const before = foldPnlRecords(stream.identity, records.slice(0, at.index));
      if (!before.ok) return false;
      stream.state = before.value;
      stream.applied = at.index;
      stream.seen = records.length;
      stream.refusedAt = at.index;
      stream.refusalCode = at.code;
      return true;
    } catch {
      return false;
    }
  }

  #countRefusal(instanceId: string, code: string): void {
    let byCode = this.#pnlRefusals.get(instanceId);
    if (byCode === undefined) {
      byCode = new Map<string, number>();
      this.#pnlRefusals.set(instanceId, byCode);
    }
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }

  /** `seams.folds`. Frozen; maps emitted in sorted key order. */
  health(): FoldHealth {
    const pnlRefusals = Object.create(null) as Record<string, Readonly<Record<string, number>>>;
    for (const instanceId of [...this.#pnlRefusals.keys()].sort()) {
      const byCode = this.#pnlRefusals.get(instanceId) ?? new Map<string, number>();
      const counts = Object.create(null) as Record<string, number>;
      for (const code of [...byCode.keys()].sort()) counts[code] = byCode.get(code) ?? 0;
      pnlRefusals[instanceId] = Object.freeze(counts);
    }
    return Object.freeze({
      checkEveryFills: this.#everyFills,
      pnlCheck: this.#pnlCheck,
      fillsPosted: this.#fillsPosted,
      ledgerChecks: this.#ledgerChecks,
      pnlChecks: this.#pnlChecks,
      fillsAtLastCheck: this.#fillsAtLastCheck,
      ledgerMismatches: this.#ledgerMismatches,
      pnlMismatches: this.#pnlMismatches,
      pnlRefusals: Object.freeze(pnlRefusals),
    });
  }
}
