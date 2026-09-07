/**
 * The central invariant, as pure functions over one transaction.
 *
 * §9.15 / §10.7 / ADR-006 §1: "Every ledger transaction balances to zero
 * **per asset** using explicit external-clearing accounts." The check is
 * per-asset, never a global sum — two assets that are each unbalanced but
 * happen to cancel numerically are TWO violations, not zero.
 *
 * ADR-006 §2 adds the attribution rule this module enforces alongside it:
 * virtual allocation never creates or destroys value, so within every
 * transaction the actual movement of an asset equals its attributed movement
 * (`VIRTUAL_STRATEGY` + `UNATTRIBUTED`). Enforcing it per transaction makes
 * §6 invariant 7 hold inductively from the empty ledger.
 *
 * KEY GRANULARITY (remediation round 1, 2026-09-02). Attribution parity is
 * keyed by `(accountRef, assetId)`, not by `assetId` alone. Netting an asset
 * across accounts lets one account's real, unattributed movement cancel
 * against another account's, so a transaction in which account A loses 5 with
 * no attribution at all and account B gains 5 passed a per-asset parity check
 * with both violations invisible. §9.15 is explicit — "Any actual balance
 * change lacking attribution is allocated to UNATTRIBUTED" — and the balance
 * that changed is an ACCOUNT's, which is why `ledger_entries.account_ref` is
 * NOT NULL for every scope (WP-040 obligation F20). One account's attribution
 * is not another account's, so the two are never summed.
 *
 * All arithmetic is exact decimal-string arithmetic (`addDecimal`); no float
 * ever touches an amount.
 *
 * THE DOOR (ADR-020 §3; `WP-200-FU1` review round 1, finding L1). Every function
 * this module exports is re-exported by `packages/ledger`'s index, so every one
 * of them is a CALLER-INPUT boundary — a type says `LedgerTransactionInput` and
 * a type stops a TypeScript caller and nobody else. Measured at tip `7d5ac34`,
 * before this change, with one non-enumerable inherited property or one
 * throwing inherited getter:
 *
 * ```text
 * legKey(an UNATTRIBUTED leg with no own instanceId)
 *   clean                          -> ["UNATTRIBUTED","acct-1",null,"pUSD"]
 *   NE inherited instanceId        -> ["UNATTRIBUTED","acct-1","01936f00-…","pUSD"]  ← ADOPTED
 *   throwing inherited instanceId  -> THREW Error (untyped, escaped)
 * legDeltas(a three-entry transaction)
 *   NE inherited instanceId        -> ALL THREE leg keys carry the adopted instance
 *   throwing inherited instanceId  -> THREW Error
 * netByAsset / attributionBuckets / checkPerAssetBalance / checkAttributionParity
 *   throwing inherited amount|scope-> THREW Error (untyped, escaped)
 * attributionBucketKey({ toJSON: () => "acct-1" }, "pUSD")
 *                                  -> ["acct-1","pUSD"]   ← caller code ran inside the key
 * isExactNegation(realMap, { size: 1, get: () => "-1" })
 *                                  -> true                ← a Map LOOKALIKE answered
 * ```
 *
 * The adoption is the one that matters most: `legKey` is the identity a
 * COMPENSATING REVERSAL is matched on (ADR-006 §5.2), and this module's own
 * header says a merged leg signature "can make a reversal that is NOT an exact
 * negation look like one". An inherited `instanceId` rewrites every leg's
 * identity at once, which is the same class `buildFillPosting` closes when it
 * chooses between `VIRTUAL_STRATEGY` and `UNATTRIBUTED` on
 * `slice.instanceId !== undefined`.
 *
 * So the eight exports are **D1** doors: each materializes its argument through
 * the canonical prototype-free read before it looks at it. Absence stays
 * absence, no getter runs, no `Proxy` trap runs.
 *
 * WHERE THE REFUSAL GOES, per signature. The two functions that already answer
 * in refusals answer in refusals (`LEDGER_INPUT_INVALID`), and are wrapped so
 * nothing escapes them at all. The DERIVATIONS have no refusal channel — an
 * empty map returned for an unreadable transaction would make `isExactNegation`
 * report that two unreadable transactions cancel — so they use this package's
 * documented construction-time channel and throw `LedgerConfigurationError`.
 * Both are fail-closed; neither invents a value.
 *
 * THE `…OfValidated` CORES ARE NOT AN EXCEPTION TO THE RULE. `ledger.ts` and
 * `projections.ts` reach these checks with a transaction this package has
 * ALREADY materialized and frozen, so calling the door again would re-walk the
 * whole tree per transaction per projection — and, worse, would put a new throw
 * site inside `projectLedger`, which has no containment guard. The cores carry
 * that precondition in their names, are NOT re-exported by `src/index.ts`, and
 * are the only thing the two internal callers use. `buildFillPosting` uses the
 * same shape (`buildMaterializedFillPosting`).
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, isZeroDecimal, subDecimal } from "@polymarket-bot/decimal";

import { appendData } from "@polymarket-bot/risk/plain-data";
import type { LedgerRefusal } from "./refusals.js";
import { LedgerConfigurationError, ledgerRefusal, readInputAsData } from "./refusals.js";
import type { LedgerTransactionInput } from "./transaction.js";

const ZERO: DecimalString = "0";

// ---------------------------------------------------------------------------
// D1 — the shared materialization step
// ---------------------------------------------------------------------------

/**
 * **D1** — materializes a caller-supplied value into plain own data, or THROWS
 * `LedgerConfigurationError`.
 *
 * The derivations use this one; the two refusal-returning checks use
 * {@link readAsRefusable} instead, so each function answers in the vocabulary
 * its own signature already speaks.
 */
function readOrThrow<T>(value: unknown, path: string, what: string): T {
  const read = readInputAsData(value, path, what);
  if (!read.ok) {
    throw new LedgerConfigurationError(`the ${what} is not a data record`, {
      issues: read.refusal.details["issues"] ?? [],
    });
  }
  return read.value as T;
}

/** **D1** for the two functions whose contract is already a refusal list. */
function readAsRefusable(
  value: unknown,
  path: string,
  what: string,
): { readonly ok: true; readonly value: LedgerTransactionInput } | { readonly ok: false; readonly refusals: readonly LedgerRefusal[] } {
  const read = readInputAsData(value, path, what);
  if (read.ok) {
    return { ok: true, value: read.value as LedgerTransactionInput };
  }
  return { ok: false, refusals: Object.freeze([read.refusal]) };
}

/**
 * The totality half of ADR-020 §6 for the DERIVATIONS: whatever goes wrong, the
 * function's documented contract is "returns, or throws
 * `LedgerConfigurationError`", and it holds for every input rather than for the
 * ones somebody thought of. Same shape as `Ledger.empty`'s guard.
 *
 * The thrown value's TYPE is never read and never coerced: reading `.message`
 * off a caller-supplied thrown object is one more place caller code runs
 * (`refusals.ts`'s `contained` gives the same reason).
 */
function containedDerivation<T>(what: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof LedgerConfigurationError) {
      throw error;
    }
    throw new LedgerConfigurationError(
      `${what} could not be derived from this input and is refused rather than throwing an ` +
        "untyped error (ADR-020 §6)",
      {},
    );
  }
}

/**
 * The totality half of ADR-020 §6 for the two refusal-returning checks: a throw
 * from anywhere inside becomes the same typed refusal these functions already
 * return. Same form as `refusals.ts`'s `contained`, narrowed to a refusal LIST
 * because that, not a `LedgerResult`, is what these two promise.
 */
function containedRefusals(body: () => readonly LedgerRefusal[]): readonly LedgerRefusal[] {
  try {
    return body();
  } catch (error) {
    if (error instanceof LedgerConfigurationError) {
      return Object.freeze([
        ledgerRefusal("LEDGER_INPUT_INVALID", error.message, error.details),
      ]);
    }
    return Object.freeze([
      ledgerRefusal(
        "LEDGER_INPUT_INVALID",
        "the balance check could not be completed on this input and is refused rather than " +
          "throwing; a ledger boundary answers with a typed refusal (ADR-020 §6)",
        {},
      ),
    ]);
  }
}

function addInto(map: Map<string, DecimalString>, key: string, amount: DecimalString): void {
  map.set(key, addDecimal(map.get(key) ?? ZERO, amount));
}

/**
 * Exact net movement per asset over every entry of the transaction.
 *
 * **D1**: throws `LedgerConfigurationError` on a value that is not plain own
 * data. See the module header for why a derivation refuses that way.
 */
export function netByAsset(transaction: LedgerTransactionInput): ReadonlyMap<string, DecimalString> {
  return containedDerivation("the per-asset net", () =>
    netByAssetOfValidated(
      readOrThrow<LedgerTransactionInput>(transaction, "transaction", "ledger transaction"),
    ),
  );
}

/** {@link netByAsset} over an ALREADY-materialized transaction. */
export function netByAssetOfValidated(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, DecimalString> {
  const nets = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    addInto(nets, entry.assetId, entry.amount);
  }
  return nets;
}

/**
 * The per-asset zero-sum check. Returns one refusal PER unbalanced asset,
 * each naming the asset and its exact net imbalance, so an operator sees
 * every violation at once (never only the first).
 *
 * **D1**: a value that is not plain own data is REFUSED
 * (`LEDGER_INPUT_INVALID`), and nothing escapes this function at all.
 */
export function checkPerAssetBalance(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  return containedRefusals(() => {
    const read = readAsRefusable(transaction, "transaction", "ledger transaction");
    return read.ok ? checkPerAssetBalanceOfValidated(read.value) : read.refusals;
  });
}

/** {@link checkPerAssetBalance} over an ALREADY-materialized transaction. */
export function checkPerAssetBalanceOfValidated(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  const refusals: LedgerRefusal[] = [];
  for (const [assetId, net] of netByAssetOfValidated(transaction)) {
    if (!isZeroDecimal(net)) {
      appendData(
        refusals,
        ledgerRefusal(
          "LEDGER_UNBALANCED_ASSET",
          `transaction ${transaction.ledgerTransactionId} does not balance for asset ` +
            `${assetId}: net ${net} (§9.15: balance one-sided movement with an ` +
            "EXTERNAL_CLEARING entry)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            assetId,
            netImbalance: net,
          },
        ),
      );
    }
  }
  return refusals;
}

/**
 * The `(accountRef, assetId)` bucket an entry belongs to.
 *
 * JSON-encoded rather than delimiter-joined so no account reference containing
 * the delimiter can collide with another bucket (the `pnlCompositeKey`
 * precedent). Exported so the projection classifies unattributed activity
 * against exactly the buckets this check enforces — one key rule, one place.
 *
 * **D1**, in the only form two string parameters admit: both arguments must BE
 * strings. `JSON.stringify` invokes a `toJSON` method if the value has one, so
 * before this check `attributionBucketKey({ toJSON: () => "acct-1" }, "pUSD")`
 * ran caller code inside a bucket key and produced the key of a real account
 * (`WP-200-FU1` review round 1, finding L1 — measured). A non-string here is a
 * structurally impossible input, so it takes this package's documented
 * construction-time channel.
 */
export function attributionBucketKey(accountRef: string, assetId: string): string {
  if (typeof accountRef !== "string" || typeof assetId !== "string") {
    throw new LedgerConfigurationError(
      "an attribution bucket key is built from two strings; a value that only RENDERS as one " +
        "would run caller code inside the key",
      { accountRef: typeof accountRef, assetId: typeof assetId },
    );
  }
  return JSON.stringify([accountRef, assetId]);
}

/** One `(accountRef, assetId)` bucket's actual and attributed movement. */
export interface AttributionBucket {
  readonly accountRef: string;
  readonly assetId: string;
  /** Net `ACTUAL_ACCOUNT` movement in this bucket. */
  readonly actualDelta: DecimalString;
  /** Net `VIRTUAL_STRATEGY` + `UNATTRIBUTED` movement in this bucket. */
  readonly attributedDelta: DecimalString;
}

/**
 * Actual and attributed movement per `(accountRef, assetId)`, in first-appearance
 * order. Only holding scopes participate: `EXTERNAL_CLEARING`, `FEE_EXPENSE`,
 * and `REWARD_INCOME` are counter-accounts, not holdings, and attribute nothing.
 *
 * **D1**: throws `LedgerConfigurationError` on a value that is not plain own
 * data.
 */
export function attributionBuckets(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, AttributionBucket> {
  return containedDerivation("the attribution buckets", () =>
    attributionBucketsOfValidated(
      readOrThrow<LedgerTransactionInput>(transaction, "transaction", "ledger transaction"),
    ),
  );
}

/** {@link attributionBuckets} over an ALREADY-materialized transaction. */
export function attributionBucketsOfValidated(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, AttributionBucket> {
  const actual = new Map<string, DecimalString>();
  const attributed = new Map<string, DecimalString>();
  const identity = new Map<string, { readonly accountRef: string; readonly assetId: string }>();
  for (const entry of transaction.entries) {
    if (
      entry.scope !== "ACTUAL_ACCOUNT" &&
      entry.scope !== "VIRTUAL_STRATEGY" &&
      entry.scope !== "UNATTRIBUTED"
    ) {
      continue;
    }
    const key = attributionBucketKey(entry.accountRef, entry.assetId);
    if (!identity.has(key)) {
      identity.set(key, { accountRef: entry.accountRef, assetId: entry.assetId });
      actual.set(key, ZERO);
      attributed.set(key, ZERO);
    }
    if (entry.scope === "ACTUAL_ACCOUNT") {
      addInto(actual, key, entry.amount);
    } else {
      addInto(attributed, key, entry.amount);
    }
  }

  const buckets = new Map<string, AttributionBucket>();
  for (const [key, { accountRef, assetId }] of identity) {
    buckets.set(key, {
      accountRef,
      assetId,
      actualDelta: actual.get(key) ?? ZERO,
      attributedDelta: attributed.get(key) ?? ZERO,
    });
  }
  return buckets;
}

/**
 * ADR-006 §2 attribution parity, per `(accountRef, assetId)`:
 *
 * Δ(ACTUAL_ACCOUNT) = Δ(VIRTUAL_STRATEGY) + Δ(UNATTRIBUTED)
 *
 * A transaction that moves an actual holding must state, in the same
 * transaction, whose it is — a strategy instance's, or explicitly
 * `UNATTRIBUTED` (§9.15: "Any actual balance change lacking attribution is
 * allocated to UNATTRIBUTED"). Re-attribution later is a new transaction
 * moving value from `UNATTRIBUTED` to `VIRTUAL_STRATEGY`; parity holds there
 * too (both sides move by zero actual).
 *
 * Keyed per ACCOUNT and asset, never per asset alone: see the key-granularity
 * note at the top of this module. A cross-account transfer therefore states
 * the attribution on BOTH sides — which account lost the value and which
 * gained it — instead of relying on the two movements cancelling in a global
 * sum. Every violation is reported, one refusal per bucket.
 *
 * **D1**: a value that is not plain own data is REFUSED
 * (`LEDGER_INPUT_INVALID`), and nothing escapes this function at all.
 */
export function checkAttributionParity(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  return containedRefusals(() => {
    const read = readAsRefusable(transaction, "transaction", "ledger transaction");
    return read.ok ? checkAttributionParityOfValidated(read.value) : read.refusals;
  });
}

/** {@link checkAttributionParity} over an ALREADY-materialized transaction. */
export function checkAttributionParityOfValidated(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  const refusals: LedgerRefusal[] = [];
  for (const bucket of attributionBucketsOfValidated(transaction).values()) {
    if (!isZeroDecimal(subDecimal(bucket.actualDelta, bucket.attributedDelta))) {
      appendData(
        refusals,
        ledgerRefusal(
          "LEDGER_ATTRIBUTION_PARITY_BROKEN",
          `transaction ${transaction.ledgerTransactionId} moves asset ${bucket.assetId} by ` +
            `${bucket.actualDelta} in ACTUAL_ACCOUNT of ${bucket.accountRef} but attributes ` +
            `${bucket.attributedDelta} there (ADR-006 §2: attribution is a partition of the ` +
            "real balance, per account — one account's attribution is not another's)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            accountRef: bucket.accountRef,
            assetId: bucket.assetId,
            actualDelta: bucket.actualDelta,
            attributedDelta: bucket.attributedDelta,
          },
        ),
      );
    }
  }
  return refusals;
}

/**
 * The identity of one leg: scope, account, instance, asset.
 *
 * JSON-encoded, like every other composite key here, because a delimiter
 * inside an identifier would merge two legs into one — and a merged leg
 * signature can make a reversal that is NOT an exact negation look like one
 * (remediation round 1, 2026-09-02).
 *
 * **D1** (`WP-200-FU1` review round 1, finding L1). `entry.instanceId` is an
 * OPTIONAL read, and on an ordinary object an absent optional is answered by
 * `Object.prototype`: one inherited `instanceId` used to rewrite an
 * `UNATTRIBUTED` leg's identity into an attributed one, on every leg at once.
 * Throws `LedgerConfigurationError` on a value that is not plain own data.
 */
export function legKey(entry: {
  readonly scope: string;
  readonly accountRef: string;
  readonly instanceId?: string | undefined;
  readonly assetId: string;
}): string {
  return containedDerivation("a leg key", () =>
    legKeyOfValidated(
      readOrThrow<Parameters<typeof legKeyOfValidated>[0]>(entry, "entry", "ledger entry"),
    ),
  );
}

/** {@link legKey} over an ALREADY-materialized entry. */
export function legKeyOfValidated(entry: {
  readonly scope: string;
  readonly accountRef: string;
  readonly instanceId?: string | undefined;
  readonly assetId: string;
}): string {
  return JSON.stringify([entry.scope, entry.accountRef, entry.instanceId ?? null, entry.assetId]);
}

/**
 * Per-leg delta signature of a transaction, keyed by {@link legKey}. Used by
 * the compensating-reversal check: a reversal must negate the original
 * exactly, leg for leg (ADR-006 §5.2).
 *
 * **D1**: throws `LedgerConfigurationError` on a value that is not plain own
 * data. An empty signature is NOT an acceptable answer for an unreadable
 * transaction — {@link isExactNegation} would then report that two unreadable
 * transactions cancel — which is why this one fails closed by throwing.
 */
export function legDeltas(transaction: LedgerTransactionInput): ReadonlyMap<string, DecimalString> {
  return containedDerivation("the per-leg delta signature", () =>
    legDeltasOfValidated(
      readOrThrow<LedgerTransactionInput>(transaction, "transaction", "ledger transaction"),
    ),
  );
}

/** {@link legDeltas} over an ALREADY-materialized transaction. */
export function legDeltasOfValidated(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, DecimalString> {
  const deltas = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    addInto(deltas, legKeyOfValidated(entry), entry.amount);
  }
  // Legs that net to zero contribute nothing to the signature.
  for (const [key, value] of deltas) {
    if (isZeroDecimal(value)) {
      deltas.delete(key);
    }
  }
  return deltas;
}

/**
 * True when `candidate` exactly negates `original`, leg for leg.
 *
 * **D1**, in the form two `Map` parameters admit (`WP-200-FU1` review round 1,
 * finding L1). A `Map` is not plain own data — it has a prototype and internal
 * slots — so it cannot be materialized like a record; what it can be is
 * REQUIRED. Before this check, a plain object with a `size` property and a `get`
 * method answered every question this function asks, and
 * `isExactNegation(realDeltas, { size: 1, get: () => "-1" })` returned **true**:
 * a reversal that reverses nothing, accepted by the check whose whole job is to
 * say otherwise (ADR-006 §5.2). Both arguments must therefore be real `Map`s,
 * and both are read through `Map.prototype` so a subclass cannot answer for
 * them either.
 */
export function isExactNegation(
  original: ReadonlyMap<string, DecimalString>,
  candidate: ReadonlyMap<string, DecimalString>,
): boolean {
  for (const [name, value] of [
    ["original", original],
    ["candidate", candidate],
  ] as const) {
    if (!(value instanceof Map)) {
      throw new LedgerConfigurationError(
        `the ${name} leg signature is not a Map; a value that merely ANSWERS like one can ` +
          "report that a reversal negates a transaction it does not",
        { argument: name },
      );
    }
  }
  return containedDerivation("the exact-negation verdict", () => {
    const sizeOf = (map: ReadonlyMap<string, DecimalString>): number =>
      Reflect.get(Map.prototype, "size", map) as number;
    const getFrom = (
      map: ReadonlyMap<string, DecimalString>,
      key: string,
    ): DecimalString | undefined => Map.prototype.get.call(map, key) as DecimalString | undefined;

    if (sizeOf(original) !== sizeOf(candidate)) {
      return false;
    }
    for (const [key, value] of Map.prototype.entries.call(original) as IterableIterator<
      [string, DecimalString]
    >) {
      const candidateValue = getFrom(candidate, key);
      if (candidateValue === undefined || !isZeroDecimal(addDecimal(value, candidateValue))) {
        return false;
      }
    }
    return true;
  });
}
