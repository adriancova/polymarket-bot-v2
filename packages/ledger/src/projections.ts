/**
 * Rebuildable balance and position projections (§9.15, §10.5, §6 invariant 8).
 *
 * "Projections are not truth" (ADR-006 §1): they are folds over the
 * append-only ledger, rebuildable from zero, and a rebuild must equal the
 * incremental state (work-plan WP-200 acceptance 2). Both paths run the SAME
 * `applyTransaction` fold step, and equality is testable byte-for-byte via
 * `serializeProjection` — a deterministic canonical form with sorted keys.
 *
 * The fold NEVER fails: every transaction it sees was already validated by
 * `Ledger.append` (or `Ledger.rebuild`, which re-validates recorded history).
 * Tampering with recorded history is therefore detected either as an append
 * refusal on rebuild or as a byte divergence between serializations.
 *
 * Unattributed activity is surfaced VISIBLY (work-plan acceptance 4): every
 * `UNATTRIBUTED` entry becomes an `UnattributedActivityRecord`, and one whose
 * bucket saw a real movement carries the literal `haltRequired: true` — the
 * projection can record the §9.15 halt obligation but can never waive it (the
 * domain's `FeedGapDetected` pattern). Halting itself is the composition
 * root's act (§9.9); this package is pure.
 *
 * THE FOLD VALIDATES THE ADR-006 §2 PARTITION ITSELF, and fails CLOSED
 * (remediation round 2, 2026-09-03, review HIGH-1). `Ledger.append` refuses a
 * transaction whose actual movement is not attributed in its own
 * `(accountRef, assetId)` bucket, but the WP-040 tables enforce only the
 * per-asset zero-sum in SQL, so history written by another writer can reach
 * this fold without ever passing that refusal. Round 1 answered that with a
 * classification rule alone, and the rule was local: it asked only whether the
 * UNATTRIBUTED entry's OWN bucket carried an actual leg, so a transaction that
 * moved a real holding in ONE bucket and re-attributed in ANOTHER — a different
 * asset, a different account, or three accounts at once — reported the entry as
 * a harmless `REATTRIBUTION` and raised no halt. So the fold now recomputes
 * `attributionBuckets` for every transaction it sees:
 *
 *  - every bucket whose actual movement is not matched by its attributed
 *    movement becomes an `UnexplainedActualMovementRecord` carrying the
 *    literal `haltRequired: true` — including when the transaction contains no
 *    `UNATTRIBUTED` entry at all, which is the case a classification rule can
 *    never see; and
 *  - an `UNATTRIBUTED` entry is a `REATTRIBUTION` only when the WHOLE
 *    transaction's partition holds and its own bucket has no actual leg.
 *    Under exactly those two conditions the entry's bucket has zero actual
 *    movement and its attributed movement nets to zero, so it provably moved
 *    value between attribution buckets and touched no holding.
 *
 * Validation happens INSIDE the fold rather than in front of it, and its
 * outcome is a recorded halt rather than a refusal, because the fold must stay
 * total: damaged history that cannot be projected cannot be SEEN, and §9.15's
 * remedy for an unattributed actual movement is to halt the affected market,
 * not to stop reporting. Nothing a caller can skip stands between external
 * history and this check.
 *
 * Every balance line is keyed by the ENTRY's `accountRef`, never the
 * transaction header's (WP-040 obligation F20): a transfer between two
 * accounts is one transaction with legs in two of them, and reading the
 * header would attribute both legs to whoever initiated it. The same rule
 * governs every OTHER key in this module — the halt classification, the
 * unattributed exposure summary, and the partition audit are all keyed by
 * `(accountRef, assetId)`, because a number that nets two accounts together
 * describes no account (remediation round 1, 2026-09-02).
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, isZeroDecimal, subDecimal } from "@polymarket-bot/decimal";

// `attributionBucketsOfValidated`, not the D1 door: `appended.transaction` was
// materialized by `validateTransactionInput` before it was appended, and the
// door would put a new throw site inside `projectLedger`, which has no
// containment guard. See `balance.ts`'s header.
import { appendData } from "@polymarket-bot/risk/plain-data";
import { attributionBucketKey, attributionBucketsOfValidated } from "./balance.js";
import { deepFreeze, frozenMap, plainRecord } from "./immutable.js";
import type { Ledger } from "./ledger.js";
import type { AppendedLedgerTransaction } from "./transaction.js";
import type { AssetKind, LedgerScope } from "./vocabulary.js";

const ZERO: DecimalString = "0";

/** Fields every unattributed entry contributes to the audit trail. */
interface UnattributedActivityBase {
  readonly ledgerTransactionId: string;
  readonly sequence: number;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly accountRef: string;
  readonly amount: DecimalString;
  /** §9.15: "the affected market is halted." Null when no market is named. */
  readonly affectedMarketId: string | null;
}

/**
 * One entry in the `UNATTRIBUTED` scope, classified by what it actually did.
 *
 * §9.15 states the halt trigger precisely: "Any actual BALANCE CHANGE lacking
 * attribution is allocated to UNATTRIBUTED, and the affected market is
 * halted." Two different things land in this scope and only one of them is
 * that trigger:
 *
 * - `ACTUAL_ARRIVAL` — the transaction touched the `ACTUAL_ACCOUNT` holding of
 *   this entry's OWN `(accountRef, assetId)` bucket. This IS the §9.15
 *   trigger, and its `haltRequired` is the literal `true`: the record can
 *   state the obligation, never waive it (an `ACTUAL_ARRIVAL` with
 *   `haltRequired: false` does not typecheck, so no code path can produce
 *   one).
 * - `REATTRIBUTION` — the transaction's attribution partition HOLDS in every
 *   bucket, and it carries NO `ACTUAL_ACCOUNT` entry in this entry's bucket at
 *   all: it moved value BETWEEN attribution buckets (`UNATTRIBUTED` ⇄
 *   `VIRTUAL_STRATEGY`) of one account and asset, touching no real holding.
 *   That is the REMEDIATION for an earlier arrival, and treating it as a fresh
 *   halt trigger would mean every fix re-raises the alarm it is fixing. It
 *   stays in the audit trail — attribution history is not erasable — with
 *   `haltRequired: false`.
 *
 * THE CLASSIFICATION RULE, and why it is PRESENCE plus a whole-transaction
 * partition check rather than a net:
 *
 * The original version asked "did the per-ASSET actual movement of this
 * transaction net to zero?", which two different cancellations could defeat
 * (remediation round 1). Across accounts: `ACTUAL A −5`, `ACTUAL B +5`,
 * `VIRTUAL B −5`, `UNATTRIBUTED B +5` nets to zero for the asset, so account
 * B's real +5 arrival was classified `REATTRIBUTION` and never halted. Within
 * one bucket: a real −5 and a real +5 in the same account and asset also net to
 * zero. A re-attribution is recognizable WITHOUT arithmetic on the actual side
 * — it is a transaction with no actual leg in the bucket — so round 1 asked
 * that instead.
 *
 * That was still too local (remediation round 2). Asking only about the
 * entry's OWN bucket makes the answer depend on where the writer PUT the
 * attribution, and a writer that put it in the wrong bucket is exactly the
 * writer this rule exists to catch:
 *
 *     ACTUAL       A  pUSD  +5      UNATTRIBUTED     A  USDC  +5
 *     CLEARING        pUSD  −5      VIRTUAL_STRATEGY A  USDC  −5
 *
 * Each asset nets to zero, so the WP-040 tables admit it, and account A really
 * received 5 pUSD that nobody claimed — yet the USDC entry sits in a different
 * bucket, so it read as a harmless remediation. The rule therefore adds the
 * WHOLE transaction's partition as a precondition: if ANY bucket's actual
 * movement is unmatched, nothing in the transaction is a proven re-attribution
 * and every `UNATTRIBUTED` entry in it is an `ACTUAL_ARRIVAL`. The
 * over-classification is deliberate — §2's fail-safe says halt rather than
 * guess, and a transaction whose partition is broken is not a transaction whose
 * attribution can be trusted at entry granularity.
 *
 * A broken partition ALSO produces an {@link UnexplainedActualMovementRecord}
 * per breached bucket, so the halt does not depend on the writer having emitted
 * an `UNATTRIBUTED` entry anywhere at all.
 *
 * Halting itself is the composition root's act (§9.9); this package is pure.
 */
export type UnattributedActivityRecord =
  | (UnattributedActivityBase & {
      readonly activityKind: "ACTUAL_ARRIVAL";
      readonly haltRequired: true;
    })
  | (UnattributedActivityBase & {
      readonly activityKind: "REATTRIBUTION";
      readonly haltRequired: false;
    });

/**
 * One `(accountRef, assetId)` bucket in which ONE folded transaction moved an
 * actual holding without attributing it — §9.15's "any actual balance change
 * lacking attribution", detected at the fold (remediation round 2, 2026-09-03).
 *
 * This is the barrier for history the SQL layer admits but `Ledger.append`
 * would have refused. It does not depend on the writer having emitted an
 * `UNATTRIBUTED` entry: the plainest hidden arrival of all —
 * `ACTUAL A +5`, `EXTERNAL_CLEARING −5`, nothing else — has no unattributed
 * entry to classify, balances per asset, and used to fold into a projection
 * that said nothing at all. It says this now.
 *
 * `haltRequired` is the literal `true`: a record that waives the obligation
 * does not typecheck, so no code path can produce one. Recorded per
 * transaction and never erased — a later transaction that fixes the
 * attribution is a new transaction, not a deletion (ADR-006 §1).
 */
export interface UnexplainedActualMovementRecord {
  readonly ledgerTransactionId: string;
  readonly sequence: number;
  readonly accountRef: string;
  readonly assetId: string;
  /** Net `ACTUAL_ACCOUNT` movement of this bucket in this transaction. */
  readonly actualDelta: DecimalString;
  /** Net `VIRTUAL_STRATEGY` + `UNATTRIBUTED` movement of the same bucket. */
  readonly attributedDelta: DecimalString;
  /** `actualDelta − attributedDelta`: the movement nobody claimed. */
  readonly unexplained: DecimalString;
  /** §9.15: "the affected market is halted." Null when no market is named. */
  readonly affectedMarketId: string | null;
  /** The §9.15 halt obligation, stated and never waivable. */
  readonly haltRequired: true;
}

interface BalanceKeyParts {
  readonly scope: LedgerScope;
  readonly accountRef: string;
  readonly assetId: string;
}

/** A per-(scope, accountRef, assetId) balance line. */
export interface BalanceLine extends BalanceKeyParts {
  readonly assetKind: AssetKind;
  readonly balance: DecimalString;
}

/** A per-(instanceId, assetId) virtual position line. */
export interface VirtualPositionLine {
  readonly instanceId: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly marketId: string | null;
  readonly balance: DecimalString;
}

/**
 * The projection state. Immutable to callers; `applyTransaction` returns a
 * new value. Maps are keyed canonically so serialization is deterministic.
 */
export interface LedgerProjection {
  /** Count of transactions folded in, for staleness/rebuild comparison. */
  readonly transactionCount: number;
  /** {@link balanceLineKey} -> balance line (zero lines dropped). */
  readonly balances: ReadonlyMap<string, BalanceLine>;
  /** {@link virtualPositionKey} -> virtual position line (zero lines dropped). */
  readonly virtualPositions: ReadonlyMap<string, VirtualPositionLine>;
  /** Every unattributed entry ever folded, in ledger order. Never dropped. */
  readonly unattributedActivity: readonly UnattributedActivityRecord[];
  /**
   * Every ADR-006 §2 partition breach the fold has seen, in ledger order.
   * Empty for any projection folded from a `Ledger` (append enforces the
   * partition per transaction); non-empty exactly when externally-written
   * history moved a holding nobody claimed.
   */
  readonly unexplainedMovements: readonly UnexplainedActualMovementRecord[];
}

/** The empty projection. */
export function emptyProjection(): LedgerProjection {
  return Object.freeze({
    transactionCount: 0,
    balances: frozenMap(new Map<string, BalanceLine>()),
    virtualPositions: frozenMap(new Map<string, VirtualPositionLine>()),
    unattributedActivity: Object.freeze([]),
    unexplainedMovements: Object.freeze([]),
  });
}

/**
 * The key of one balance line.
 *
 * JSON-encoded rather than `scope|account|asset`, because an account
 * reference or an asset id may contain the delimiter: `NonEmptyStringSchema`
 * bounds the length and nothing else. Two different lines that joined to one
 * string would MERGE — silently, in a monetary projection — and the merge
 * would survive every balance and parity check, because both are computed
 * before the fold. Exported so callers and tests read a line by asking for
 * its key rather than by re-deriving the format (remediation round 1,
 * 2026-09-02; the `pnlCompositeKey` precedent).
 */
export function balanceLineKey(
  scope: LedgerScope,
  accountRef: string,
  assetId: string,
): string {
  return JSON.stringify([scope, accountRef, assetId]);
}

/** The key of one virtual position line, collision-free for the same reason. */
export function virtualPositionKey(instanceId: string, assetId: string): string {
  return JSON.stringify([instanceId, assetId]);
}

/**
 * Folds ONE appended transaction into the projection. This is the single
 * fold step both the incremental path and the rebuild path share.
 */
export function applyTransaction(
  projection: LedgerProjection,
  appended: AppendedLedgerTransaction,
): LedgerProjection {
  const balances = new Map(projection.balances);
  const virtualPositions = new Map(projection.virtualPositions);
  const unattributed: UnattributedActivityRecord[] = [];

  // The `(accountRef, assetId)` buckets in which THIS transaction touches a
  // real holding, and the market each bucket names — collected before the fold
  // so every unattributed entry can be classified against its OWN bucket.
  // Presence, not a net: see the rule on `UnattributedActivityRecord`. The key
  // comes from `balance.ts`, so the classification and the parity check can
  // never drift apart.
  const actualBuckets = new Set<string>();
  const bucketMarkets = new Map<string, string>();
  for (const entry of appended.transaction.entries) {
    if (
      entry.scope !== "ACTUAL_ACCOUNT" &&
      entry.scope !== "VIRTUAL_STRATEGY" &&
      entry.scope !== "UNATTRIBUTED"
    ) {
      continue;
    }
    const bucketKey = attributionBucketKey(entry.accountRef, entry.assetId);
    if (entry.scope === "ACTUAL_ACCOUNT") {
      actualBuckets.add(bucketKey);
    }
    if (entry.marketId !== undefined && !bucketMarkets.has(bucketKey)) {
      bucketMarkets.set(bucketKey, entry.marketId);
    }
  }

  // MANDATORY partition validation, inside the fold (review round 2, HIGH-1).
  // `Ledger.append` refuses these; the WP-040 tables do not, so anything that
  // reaches a fold from outside is checked here, per `(accountRef, assetId)`,
  // by the SAME `attributionBuckets` the refusal uses.
  const breachedBuckets = new Set<string>();
  const unexplained: UnexplainedActualMovementRecord[] = [];
  for (const [bucketKey, bucket] of attributionBucketsOfValidated(appended.transaction)) {
    const gap = subDecimal(bucket.actualDelta, bucket.attributedDelta);
    if (isZeroDecimal(gap)) {
      continue;
    }
    breachedBuckets.add(bucketKey);
    appendData(
      unexplained,
      Object.freeze({
        ledgerTransactionId: appended.transaction.ledgerTransactionId,
        sequence: appended.sequence,
        accountRef: bucket.accountRef,
        assetId: bucket.assetId,
        actualDelta: bucket.actualDelta,
        attributedDelta: bucket.attributedDelta,
        unexplained: gap,
        affectedMarketId:
          bucketMarkets.get(bucketKey) ?? appended.transaction.marketId ?? null,
        haltRequired: true as const,
      }),
    );
  }
  // Fail closed: a transaction whose partition is broken ANYWHERE cannot prove
  // that any entry in it is a mere re-attribution.
  const partitionBroken = breachedBuckets.size > 0;

  for (const entry of appended.transaction.entries) {
    const key = balanceLineKey(entry.scope, entry.accountRef, entry.assetId);
    const existing = balances.get(key);
    const balance = addDecimal(existing?.balance ?? ZERO, entry.amount);
    if (isZeroDecimal(balance)) {
      balances.delete(key);
    } else {
      balances.set(key, {
        scope: entry.scope,
        accountRef: entry.accountRef,
        assetId: entry.assetId,
        assetKind: entry.assetKind,
        balance,
      });
    }

    if (entry.scope === "VIRTUAL_STRATEGY" && entry.instanceId !== undefined) {
      const virtualKey = virtualPositionKey(entry.instanceId, entry.assetId);
      const existingVirtual = virtualPositions.get(virtualKey);
      const virtualBalance = addDecimal(existingVirtual?.balance ?? ZERO, entry.amount);
      if (isZeroDecimal(virtualBalance)) {
        virtualPositions.delete(virtualKey);
      } else {
        virtualPositions.set(virtualKey, {
          instanceId: entry.instanceId,
          assetId: entry.assetId,
          assetKind: entry.assetKind,
          marketId: entry.marketId ?? existingVirtual?.marketId ?? null,
          balance: virtualBalance,
        });
      }
    }

    if (entry.scope === "UNATTRIBUTED") {
      const base: UnattributedActivityBase = {
        ledgerTransactionId: appended.transaction.ledgerTransactionId,
        sequence: appended.sequence,
        assetId: entry.assetId,
        assetKind: entry.assetKind,
        accountRef: entry.accountRef,
        amount: entry.amount,
        affectedMarketId: entry.marketId ?? appended.transaction.marketId ?? null,
      };
      const touchedActual = actualBuckets.has(
        attributionBucketKey(entry.accountRef, entry.assetId),
      );
      appendData(
        unattributed,
        touchedActual || partitionBroken
          ? Object.freeze({ ...base, activityKind: "ACTUAL_ARRIVAL" as const, haltRequired: true as const })
          : Object.freeze({ ...base, activityKind: "REATTRIBUTION" as const, haltRequired: false as const }),
      );
    }
  }

  return Object.freeze({
    transactionCount: projection.transactionCount + 1,
    balances: frozenMap(balances),
    virtualPositions: frozenMap(virtualPositions),
    unattributedActivity: deepFreeze([
      ...projection.unattributedActivity,
      ...unattributed,
    ]),
    unexplainedMovements: deepFreeze([
      ...projection.unexplainedMovements,
      ...unexplained,
    ]),
  });
}

/** Rebuilds the projection from zero by folding the whole ledger. */
export function projectLedger(ledger: Ledger): LedgerProjection {
  let projection = emptyProjection();
  for (const appended of ledger.transactions()) {
    projection = applyTransaction(projection, appended);
  }
  return projection;
}

/**
 * All balance lines of one scope, sorted canonically.
 *
 * The returned ARRAY is frozen and its lines are the projection's own frozen
 * lines: a reader cannot edit a balance through this view either.
 */
export function balancesOfScope(
  projection: LedgerProjection,
  scope: LedgerScope,
): readonly BalanceLine[] {
  return Object.freeze(
    [...projection.balances.values()]
      .filter((line) => line.scope === scope)
      .sort((a, b) =>
        a.accountRef === b.accountRef
          ? a.assetId < b.assetId
            ? -1
            : 1
          : a.accountRef < b.accountRef
            ? -1
            : 1,
      ),
  );
}

/**
 * Actual outcome-token positions per (accountRef, assetId) — the
 * `actual_position_projection` shape (§10.5) minus average cost, which is
 * PnL-engine state (§9.16), not a ledger fact.
 */
export function actualPositions(projection: LedgerProjection): readonly BalanceLine[] {
  return Object.freeze(
    balancesOfScope(projection, "ACTUAL_ACCOUNT").filter(
      (line) => line.assetKind === "OUTCOME_TOKEN",
    ),
  );
}

/** Virtual positions per (instanceId, assetId), sorted canonically. */
export function virtualPositions(
  projection: LedgerProjection,
): readonly VirtualPositionLine[] {
  return Object.freeze(
    [...projection.virtualPositions.values()].sort((a, b) =>
      a.instanceId === b.instanceId
        ? a.assetId < b.assetId
          ? -1
          : 1
        : a.instanceId < b.instanceId
          ? -1
          : 1,
    ),
  );
}

/** One account's unattributed exposure in one asset, summarized for an operator. */
export interface UnattributedExposureLine {
  /**
   * The account whose balance is exposed. Present because exposure is a
   * per-account fact: netting two accounts' unexplained movements into one
   * number reports an exposure nobody has (the same key-granularity rule the
   * parity check follows).
   */
  readonly accountRef: string;
  readonly assetId: string;
  /** Net of every UNATTRIBUTED entry in this bucket: equals its balance line. */
  readonly net: DecimalString;
  /**
   * Net actual movement in this bucket that no attribution leg claimed, summed
   * over every {@link UnexplainedActualMovementRecord} the fold recorded for it
   * (remediation round 2). Zero for a bucket whose partition always held.
   *
   * Kept SEPARATE from `net` rather than added into it: `net` is the sum of
   * recorded `UNATTRIBUTED` entries and equals the bucket's `UNATTRIBUTED`
   * balance line, and an operator reconciling against the database needs that
   * to stay literally true. This figure is the movement the writer should have
   * recorded there and did not.
   */
  readonly unexplainedActualMovement: DecimalString;
  /** Markets named by the contributing entries, sorted. */
  readonly affectedMarketIds: readonly string[];
  /**
   * How many §9.15 halt triggers this bucket has: `ACTUAL_ARRIVAL` records
   * plus unexplained actual movements.
   */
  readonly haltTriggerCount: number;
  /** True while any halt trigger exists for the bucket. */
  readonly haltRequired: boolean;
}

/**
 * Net unattributed exposure per `(accountRef, assetId)`, with the §9.15 halt
 * triggers counted, sorted by account then asset.
 *
 * A zero net is STILL REPORTED when the bucket has any unattributed history:
 * "it nets to zero now" is not the same statement as "no unexplained movement
 * ever happened here", and only the second one is a reason to stop looking.
 *
 * This is the single surface an operator reads for the halt obligation, so it
 * reports BOTH kinds of trigger: an `UNATTRIBUTED` entry classified as an
 * arrival, and a partition breach — which can exist in a bucket with no
 * unattributed entry at all and would otherwise be invisible here.
 */
export function unattributedExposure(
  projection: LedgerProjection,
): readonly UnattributedExposureLine[] {
  interface ExposureBucket {
    readonly accountRef: string;
    readonly assetId: string;
    net: DecimalString;
    unexplained: DecimalString;
    markets: Set<string>;
    triggers: number;
  }
  const byBucket = new Map<string, ExposureBucket>();
  const bucketOf = (accountRef: string, assetId: string): ExposureBucket => {
    const key = attributionBucketKey(accountRef, assetId);
    const existing = byBucket.get(key) ?? {
      accountRef,
      assetId,
      net: ZERO,
      unexplained: ZERO,
      markets: new Set<string>(),
      triggers: 0,
    };
    byBucket.set(key, existing);
    return existing;
  };

  for (const record of projection.unattributedActivity) {
    const bucket = bucketOf(record.accountRef, record.assetId);
    bucket.net = addDecimal(bucket.net, record.amount);
    if (record.affectedMarketId !== null) {
      bucket.markets.add(record.affectedMarketId);
    }
    if (record.activityKind === "ACTUAL_ARRIVAL") {
      bucket.triggers += 1;
    }
  }
  for (const movement of projection.unexplainedMovements) {
    const bucket = bucketOf(movement.accountRef, movement.assetId);
    bucket.unexplained = addDecimal(bucket.unexplained, movement.unexplained);
    if (movement.affectedMarketId !== null) {
      bucket.markets.add(movement.affectedMarketId);
    }
    bucket.triggers += 1;
  }

  return [...byBucket.values()]
    .sort((a, b) =>
      a.accountRef === b.accountRef
        ? a.assetId < b.assetId
          ? -1
          : 1
        : a.accountRef < b.accountRef
          ? -1
          : 1,
    )
    .map(({ accountRef, assetId, net, unexplained, markets, triggers }) =>
      Object.freeze({
        accountRef,
        assetId,
        net,
        unexplainedActualMovement: unexplained,
        affectedMarketIds: Object.freeze([...markets].sort()),
        haltTriggerCount: triggers,
        haltRequired: triggers > 0,
      }),
    );
}

/** One `(accountRef, assetId)` bucket in which the §2 partition does not hold. */
export interface AttributionPartitionViolation {
  readonly accountRef: string;
  readonly assetId: string;
  readonly actual: DecimalString;
  readonly attributed: DecimalString;
}

/**
 * ADR-006 §2 partition audit over a WHOLE projection: for every
 * `(accountRef, assetId)` bucket, the `ACTUAL_ACCOUNT` holding equals
 * `VIRTUAL_STRATEGY` + `UNATTRIBUTED` in that same bucket.
 *
 * Always empty for a projection folded from a `Ledger` (parity is enforced per
 * append at exactly this granularity, so it holds inductively); non-empty
 * exactly when externally-loaded state is inconsistent — which is the case
 * that matters, because the WP-040 tables enforce the per-asset zero-sum in
 * SQL but NOT this partition, so history written by another writer can reach a
 * fold without ever passing `Ledger.append`.
 *
 * Keyed per account for the same reason the parity check is: one account's
 * unattributed surplus must not cancel another account's shortfall.
 *
 * This is the CUMULATIVE view and it is NOT the halt barrier: a later
 * transaction that attributes an earlier unexplained movement makes the
 * cumulative audit clean again, and an operator has to remember to call it.
 * The per-transaction {@link UnexplainedActualMovementRecord}s the fold records
 * are the barrier — append-only, and reported by
 * {@link unattributedExposure} without being asked.
 */
export function auditAttributionPartition(
  projection: LedgerProjection,
): readonly AttributionPartitionViolation[] {
  const actual = new Map<string, DecimalString>();
  const attributed = new Map<string, DecimalString>();
  const identity = new Map<string, { readonly accountRef: string; readonly assetId: string }>();
  for (const line of projection.balances.values()) {
    if (
      line.scope !== "ACTUAL_ACCOUNT" &&
      line.scope !== "VIRTUAL_STRATEGY" &&
      line.scope !== "UNATTRIBUTED"
    ) {
      continue;
    }
    const key = attributionBucketKey(line.accountRef, line.assetId);
    identity.set(key, { accountRef: line.accountRef, assetId: line.assetId });
    if (line.scope === "ACTUAL_ACCOUNT") {
      actual.set(key, addDecimal(actual.get(key) ?? ZERO, line.balance));
    } else {
      attributed.set(key, addDecimal(attributed.get(key) ?? ZERO, line.balance));
    }
  }
  const violations: AttributionPartitionViolation[] = [];
  for (const key of [...identity.keys()].sort()) {
    const bucket = identity.get(key);
    if (bucket === undefined) {
      continue;
    }
    const actualNet = actual.get(key) ?? ZERO;
    const attributedNet = attributed.get(key) ?? ZERO;
    if (!isZeroDecimal(subDecimal(actualNet, attributedNet))) {
      appendData(
        violations,
        Object.freeze({
          accountRef: bucket.accountRef,
          assetId: bucket.assetId,
          actual: actualNet,
          attributed: attributedNet,
        }),
      );
    }
  }
  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// Canonical serialization — the byte-equality oracle format
// ---------------------------------------------------------------------------

/**
 * Serialization domain prefix; changing the format is a versioned decision.
 *
 * v2 (remediation round 1, 2026-09-02): the balance and virtual-position map
 * keys are JSON-encoded composites instead of `a|b|c` strings, so the sorted
 * key order — and therefore the bytes — changed. The projection's CONTENT is
 * unchanged.
 *
 * v3 (remediation round 2, 2026-09-03): the projection carries
 * `unexplainedMovements`, and the oracle covers it. A section left out of the
 * oracle is a section a mutated history can change without the byte comparison
 * noticing, which is the whole point of comparing bytes.
 */
export const LEDGER_PROJECTION_SERIALIZATION_DOMAIN = "polymarket-bot/ledger-projection/v3";

/**
 * A sorted own-data record from a map.
 *
 * The accumulator is PROTOTYPE-FREE (`WP-200-FU1`): `record[key] = value` on an
 * ordinary object is `Set`, which walks the chain, and these keys are composite
 * strings built from caller-chosen account and asset identifiers — so an
 * inherited get-only accessor at one of them made this ORACLE throw out of
 * `serializeProjection`, which has no refusal channel to turn it into. The same
 * class and the same fix as `packages/pnl`'s serializer, measured there.
 */
function sortedRecord<T>(map: ReadonlyMap<string, T>): Readonly<Record<string, T>> {
  const record = plainRecord<T>();
  for (const key of [...map.keys()].sort()) {
    const value = map.get(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic canonical bytes for a projection: same state, same bytes,
 * regardless of the order state was accumulated in.
 */
export function serializeProjection(projection: LedgerProjection): string {
  return (
    `${LEDGER_PROJECTION_SERIALIZATION_DOMAIN}:` +
    stableStringify({
      transactionCount: projection.transactionCount,
      balances: sortedRecord(projection.balances),
      virtualPositions: sortedRecord(projection.virtualPositions),
      unattributedActivity: projection.unattributedActivity,
      unexplainedMovements: projection.unexplainedMovements,
    })
  );
}

/** Serialization domain for a whole ledger's recorded history. */
export const LEDGER_SERIALIZATION_DOMAIN = "polymarket-bot/ledger/v1";

/** Deterministic canonical bytes for the ledger's visible history. */
export function serializeLedger(ledger: Ledger): string {
  return (
    `${LEDGER_SERIALIZATION_DOMAIN}:` +
    stableStringify({
      environment: ledger.environment,
      transactions: ledger.transactions(),
    })
  );
}
