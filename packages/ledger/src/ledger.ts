/**
 * The append-only ledger value (§9.15, ADR-006 §1).
 *
 * A `Ledger` is an immutable value: `append` returns a NEW ledger and never
 * mutates the receiver, so historical states remain valid references (the
 * `universe` registry pattern). Internally consecutive appends share one
 * backing buffer (persistent-vector style) so building an n-transaction
 * ledger is O(n), because ADR-006's consequence list makes rebuild speed a
 * tracked property — an invariant that is too slow to check quietly stops
 * being checked. Branching from a non-tip state copies the visible prefix.
 *
 * Every append machine-checks, in order:
 *  1. input shape (schema, ADR-016 UUID refusal, zero amounts,
 *     instance⇔scope, per-transaction asset-kind consistency, market
 *     required with execution links) — `transaction.ts`;
 *  2. environment match (§10.8 separation);
 *  3. duplicate transaction id (append-only, §10.7);
 *  4. asset-kind and asset-market consistency against the ledger's history;
 *  5. THE CENTRAL INVARIANT: per-asset zero-sum — `balance.ts`;
 *  6. ADR-006 §2 attribution parity;
 *  7. compensating-reversal exactness (ADR-006 §5.2).
 *
 * Refusal, never adjustment: no code path modifies an input to make it
 * appendable.
 *
 * THE DOOR (ADR-020 §3; `WP-200-FU1`, 2026-09-04). `append` and `rebuild` are
 * caller boundaries and both delegate their input validation to
 * `validateTransactionInput`, which performs D1-D4. What this module adds is
 * the outer containment guard on both (ADR-020 §6: a function that promises a
 * typed refusal keeps that promise) and the arena copy of `RunModeSchema` that
 * `Ledger.empty` asks — the environment is the §10.8 PAPER/LIVE discriminator,
 * so its parse is not a place to leave a raw schema.
 *
 * `Ledger.empty`'s THROW is deliberately outside every guard: a malformed run
 * mode is a construction-time contract violation, not a recoverable refusal,
 * and `WP-200`'s tests pin `LedgerConfigurationError` there.
 */

import { RunModeSchema } from "@polymarket-bot/domain";
import type { RunMode } from "@polymarket-bot/domain";
import { readPlainData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";

// The `…OfValidated` cores, not the D1 doors: every transaction that reaches
// these checks has already been materialized by `validateTransactionInput`, and
// re-walking the whole tree per append would be the only thing the door added
// here. See `balance.ts`'s header for why the cores exist and why they are not
// re-exported by `src/index.ts`.
import {
  checkAttributionParityOfValidated,
  checkPerAssetBalanceOfValidated,
  isExactNegation,
  legDeltasOfValidated,
} from "./balance.js";
import { plainFrozen } from "./immutable.js";
import type { LedgerRefusal, LedgerResult } from "./refusals.js";
import {
  LedgerConfigurationError,
  contained,
  ledgerFailure,
  ledgerOk,
  ledgerRefusal,
} from "./refusals.js";
import type { AppendedLedgerTransaction, LedgerTransactionInput } from "./transaction.js";
import { validateTransactionInput } from "./transaction.js";
import type { AssetKind } from "./vocabulary.js";

interface AssetBinding {
  readonly kind: AssetKind;
  /** Append index that recorded this binding (visible when < snapshot length). */
  readonly boundAt: number;
  /** First non-null market this OUTCOME_TOKEN asset was posted under. */
  readonly marketId: string | null;
}

/** Shared, append-only backing store for a chain of ledger snapshots. */
interface LedgerStore {
  readonly buffer: AppendedLedgerTransaction[];
  readonly byId: Map<string, number>;
  readonly assets: Map<string, AssetBinding[]>;
  /** reversed transaction id -> append index of the reversal. */
  readonly reversals: Map<string, number>;
}

function emptyStore(): LedgerStore {
  return { buffer: [], byId: new Map(), assets: new Map(), reversals: new Map() };
}

/**
 * **D2** — the parsing copy of the §11 run-mode enum, warmed at module load
 * (`@polymarket-bot/risk/schema-arena`, §2.1 **S5**).
 */
const RunModeDoor = prototypeFreeParser(RunModeSchema);

export interface LedgerAppendSuccess {
  readonly ledger: Ledger;
  readonly appended: AppendedLedgerTransaction;
}

export class Ledger {
  /** The environment every transaction in this ledger must carry (§10.8). */
  readonly environment: RunMode;
  private readonly store: LedgerStore;
  /** Number of transactions visible in THIS snapshot. */
  readonly length: number;

  private constructor(environment: RunMode, store: LedgerStore, length: number) {
    this.environment = environment;
    this.store = store;
    this.length = length;
    Object.freeze(this);
  }

  /**
   * An empty ledger bound to one environment. Throws on a malformed mode.
   *
   * D1 (`readPlainData`) then D2 (the arena copy); D3 is the `read.value` the
   * constructor is handed, not `parsed.data`. The materialization is here so
   * that a caller handing an OBJECT to the §10.8 discriminator is refused by a
   * read that runs no getter and no trap, rather than by a schema that does.
   *
   * IT IS NOT A PASS-THROUGH, and the comment that used to say it was is
   * corrected here (`WP-200-FU1` review round 1, finding M2 — measured, not
   * reasoned). A run mode is a string, but materializing even a string appends
   * to the shared door's `state.strings` accumulator with `Array.prototype
   * .push`, which is `Set` and therefore consults the prototype chain for the
   * INDEX name. So an inherited get-only accessor at `Object.prototype["0"]`
   * makes that FIRST append throw, and this constructor answers:
   *
   * ```text
   * tip 7d5ac34, get-only accessor at Object.prototype["0"]:
   *   Ledger.empty("PAPER")       -> THREW LedgerConfigurationError
   *   Ledger.rebuild("PAPER", []) -> THREW LedgerConfigurationError (cannot construct)
   * base 761db76, the same probe:
   *   Ledger.empty("PAPER")       -> OK
   *   Ledger.rebuild("PAPER", []) -> OK
   * ```
   *
   * That is a TIP-ONLY AVAILABILITY class, and it FAILS CLOSED: nothing is
   * admitted, nothing is invented, and the answer is this function's own
   * documented typed error rather than a bare `TypeError`. It is disclosed
   * rather than fixed because the root cause is `packages/risk`'s
   * `plain-data.ts` — outside `WP-200-FU1`'s allowed paths — and its widening to
   * `CreateDataProperty` appends is queued as a separate authorized round. The
   * ledger battery in `test/unit/ledger/schema-boundary.test.ts` carries `"0"`
   * in its key material precisely so this class cannot grow unobserved.
   */
  static empty(environment: RunMode): Ledger {
    try {
      return Ledger.bindEnvironment(environment);
    } catch (error) {
      if (error instanceof LedgerConfigurationError) {
        throw error;
      }
      // The ONLY throw this function can produce (`WP-200-FU1`): the documented
      // contract is "throws `LedgerConfigurationError`, or returns a ledger",
      // and it now holds for every input rather than for the ones somebody
      // thought of. Same measured need as `emptyPnlState`'s guard.
      throw new LedgerConfigurationError("environment is not a run mode", {
        raw: environment,
      });
    }
  }

  private static bindEnvironment(environment: RunMode): Ledger {
    const read = readPlainData(environment, "environment");
    if (!read.ok) {
      throw new LedgerConfigurationError("environment is not a run mode", {
        raw: environment,
      });
    }
    const parsed = RunModeDoor.safeParse(read.value);
    if (!parsed.success) {
      throw new LedgerConfigurationError("environment is not a run mode", {
        raw: environment,
      });
    }
    return new Ledger(read.value as RunMode, emptyStore(), 0);
  }

  /** The transactions visible in this snapshot, in append order. */
  transactions(): readonly AppendedLedgerTransaction[] {
    return Object.freeze(this.store.buffer.slice(0, this.length));
  }

  /** Looks a transaction up by id within this snapshot. */
  byId(ledgerTransactionId: string): AppendedLedgerTransaction | undefined {
    const index = this.store.byId.get(ledgerTransactionId);
    if (index === undefined || index >= this.length) {
      return undefined;
    }
    return this.store.buffer[index];
  }

  /** The asset kind this ledger has bound the asset id to, if any. */
  assetKindOf(assetId: string): AssetKind | undefined {
    return this.currentBinding(assetId)?.kind;
  }

  /** The market this ledger has bound the outcome-token asset to, if any. */
  assetMarketOf(assetId: string): string | undefined {
    const binding = this.currentBinding(assetId);
    return binding === undefined || binding.marketId === null ? undefined : binding.marketId;
  }

  private currentBinding(assetId: string): AssetBinding | undefined {
    const bindings = this.store.assets.get(assetId);
    if (bindings === undefined) {
      return undefined;
    }
    // Bindings are stored newest-last; the current one is the last binding
    // whose boundAt is visible in this snapshot.
    for (let i = bindings.length - 1; i >= 0; i -= 1) {
      const binding = bindings[i];
      if (binding !== undefined && binding.boundAt < this.length) {
        return binding;
      }
    }
    return undefined;
  }

  /**
   * Appends one transaction, returning the new ledger snapshot or the full
   * refusal list. The receiver is never modified.
   */
  append(input: unknown): LedgerResult<LedgerAppendSuccess> {
    return contained(() => this.appendValidated(input));
  }

  private appendValidated(input: unknown): LedgerResult<LedgerAppendSuccess> {
    const validated = validateTransactionInput(input);
    if (!validated.ok) {
      return ledgerFailure(...validated.refusals);
    }
    const transaction = validated.value;
    const refusals: LedgerRefusal[] = [];

    if (transaction.environment !== this.environment) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ENVIRONMENT_MISMATCH",
          `this ledger records ${this.environment} transactions; refused a ` +
            `${transaction.environment} transaction (§10.8 separation)`,
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            ledgerEnvironment: this.environment,
            transactionEnvironment: transaction.environment,
          },
        ),
      );
    }

    const existingIndex = this.store.byId.get(transaction.ledgerTransactionId);
    if (existingIndex !== undefined && existingIndex < this.length) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_DUPLICATE_TRANSACTION_ID",
          `transaction ${transaction.ledgerTransactionId} was already appended; ` +
            "the ledger is append-only (§10.7)",
          { ledgerTransactionId: transaction.ledgerTransactionId },
        ),
      );
    }

    refusals.push(...this.checkAssetBindings(transaction));
    refusals.push(...checkPerAssetBalanceOfValidated(transaction));
    refusals.push(...checkAttributionParityOfValidated(transaction));
    refusals.push(...this.checkReversal(transaction));

    if (refusals.length > 0) {
      return ledgerFailure(...refusals);
    }
    return ledgerOk(this.commit(transaction));
  }

  /**
   * Rebuilds a ledger from zero by re-appending recorded transactions in
   * order through the SAME validation path as live appends — so a historical
   * record that was tampered into an illegal state is refused, not replayed
   * (work-plan acceptance: a mutated history diverges detectably).
   */
  static rebuild(
    environment: RunMode,
    transactions: readonly unknown[],
  ): LedgerResult<Ledger> {
    // `Ledger.empty` is deliberately OUTSIDE the containment guard: its
    // `LedgerConfigurationError` is the documented construction-time contract.
    let ledger = Ledger.empty(environment);
    return contained(() => {
      for (const [index, transaction] of transactions.entries()) {
        const result = ledger.append(transaction);
        if (!result.ok) {
          return ledgerFailure<Ledger>(
            ledgerRefusal(
              "LEDGER_INPUT_INVALID",
              `rebuild refused at recorded transaction index ${index}`,
              { index, refusals: result.refusals },
            ),
            ...result.refusals,
          );
        }
        ledger = result.value.ledger;
      }
      return ledgerOk(ledger);
    });
  }

  // --- private helpers ------------------------------------------------------

  private checkAssetBindings(transaction: LedgerTransactionInput): readonly LedgerRefusal[] {
    const refusals: LedgerRefusal[] = [];
    const checkedKinds = new Set<string>();
    for (const entry of transaction.entries) {
      if (!checkedKinds.has(entry.assetId)) {
        checkedKinds.add(entry.assetId);
        const boundKind = this.assetKindOf(entry.assetId);
        if (boundKind !== undefined && boundKind !== entry.assetKind) {
          refusals.push(
            ledgerRefusal(
              "LEDGER_ASSET_KIND_CONFLICT",
              `asset ${entry.assetId} is already recorded as ${boundKind}; ` +
                `refused a ${entry.assetKind} entry (ADR-006 §7: one kind per asset id)`,
              {
                ledgerTransactionId: transaction.ledgerTransactionId,
                assetId: entry.assetId,
                recordedKind: boundKind,
                conflictingKind: entry.assetKind,
              },
            ),
          );
        }
      }
      if (entry.assetKind === "OUTCOME_TOKEN" && entry.marketId !== undefined) {
        const boundMarket = this.assetMarketOf(entry.assetId);
        if (boundMarket !== undefined && boundMarket !== entry.marketId) {
          refusals.push(
            ledgerRefusal(
              "LEDGER_ASSET_MARKET_CONFLICT",
              `outcome token ${entry.assetId} is already bound to market ` +
                `${boundMarket}; refused an entry naming market ${entry.marketId}`,
              {
                ledgerTransactionId: transaction.ledgerTransactionId,
                assetId: entry.assetId,
                boundMarketId: boundMarket,
                conflictingMarketId: entry.marketId,
              },
            ),
          );
        }
      }
    }
    return refusals;
  }

  private checkReversal(transaction: LedgerTransactionInput): readonly LedgerRefusal[] {
    const targetId = transaction.reversesLedgerTransactionId;
    if (targetId === undefined) {
      return [];
    }
    const target = this.byId(targetId);
    if (target === undefined) {
      return [
        ledgerRefusal(
          "LEDGER_REVERSED_TRANSACTION_UNKNOWN",
          `transaction ${transaction.ledgerTransactionId} reverses ${targetId}, ` +
            "which is not in this ledger",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            reversesLedgerTransactionId: targetId,
          },
        ),
      ];
    }
    const priorReversalIndex = this.store.reversals.get(targetId);
    if (priorReversalIndex !== undefined && priorReversalIndex < this.length) {
      const priorReversal = this.store.buffer[priorReversalIndex];
      return [
        ledgerRefusal(
          "LEDGER_ALREADY_REVERSED",
          `transaction ${targetId} was already reversed; a second reversal would ` +
            "double-compensate (§10.7)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            reversesLedgerTransactionId: targetId,
            priorReversalId: priorReversal?.transaction.ledgerTransactionId ?? null,
          },
        ),
      ];
    }
    if (
      !isExactNegation(
        legDeltasOfValidated(target.transaction),
        legDeltasOfValidated(transaction),
      )
    ) {
      return [
        ledgerRefusal(
          "LEDGER_REVERSAL_NOT_COMPENSATING",
          `transaction ${transaction.ledgerTransactionId} claims to reverse ` +
            `${targetId} but does not exactly negate it leg for leg (ADR-006 §5.2; ` +
            "book a partial correction as MANUAL_ADJUSTMENT or RECONCILIATION_CORRECTION)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            reversesLedgerTransactionId: targetId,
          },
        ),
      ];
    }
    return [];
  }

  private commit(transaction: LedgerTransactionInput): LedgerAppendSuccess {
    const store = this.store.buffer.length === this.length ? this.store : this.branchStore();
    const sequence = this.length;
    // D4 — the appended record is prototype-free, so a consumer reading
    // `record.transaction` or `record.sequence` on a value this ledger handed
    // out cannot be answered from `Object.prototype`.
    const appended: AppendedLedgerTransaction = plainFrozen({ sequence, transaction });

    store.buffer.push(appended);
    store.byId.set(transaction.ledgerTransactionId, sequence);
    if (transaction.reversesLedgerTransactionId !== undefined) {
      store.reversals.set(transaction.reversesLedgerTransactionId, sequence);
    }
    for (const entry of transaction.entries) {
      const bindings = store.assets.get(entry.assetId);
      const current = this.assetKindOf(entry.assetId);
      const currentMarket = this.assetMarketOf(entry.assetId);
      const marketId =
        entry.assetKind === "OUTCOME_TOKEN" && entry.marketId !== undefined
          ? entry.marketId
          : (currentMarket ?? null);
      if (current === undefined || (currentMarket === undefined && marketId !== null)) {
        const binding: AssetBinding = {
          kind: entry.assetKind,
          boundAt: sequence,
          marketId,
        };
        if (bindings === undefined) {
          store.assets.set(entry.assetId, [binding]);
        } else {
          bindings.push(binding);
        }
      }
    }

    return { ledger: new Ledger(this.environment, store, sequence + 1), appended };
  }

  /** Copies the visible prefix so a branch cannot see or disturb another tip. */
  private branchStore(): LedgerStore {
    const buffer = this.store.buffer.slice(0, this.length);
    const byId = new Map<string, number>();
    const assets = new Map<string, AssetBinding[]>();
    const reversals = new Map<string, number>();
    for (const [id, index] of this.store.byId) {
      if (index < this.length) {
        byId.set(id, index);
      }
    }
    for (const [assetId, bindings] of this.store.assets) {
      const visible = bindings.filter((binding) => binding.boundAt < this.length);
      if (visible.length > 0) {
        assets.set(assetId, [...visible]);
      }
    }
    for (const [id, index] of this.store.reversals) {
      if (index < this.length) {
        reversals.set(id, index);
      }
    }
    return { buffer, byId, assets, reversals };
  }
}
