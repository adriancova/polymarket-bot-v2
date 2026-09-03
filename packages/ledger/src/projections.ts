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
 * `UNATTRIBUTED` entry becomes an `UnattributedActivityRecord` whose
 * `haltRequired` is the literal `true` — the projection can record the §9.15
 * halt obligation but can never waive it (the domain's `FeedGapDetected`
 * pattern). Halting itself is the composition root's act (§9.9); this
 * package is pure.
 *
 * Every balance line is keyed by the ENTRY's `accountRef`, never the
 * transaction header's (WP-040 obligation F20): a transfer between two
 * accounts is one transaction with legs in two of them, and reading the
 * header would attribute both legs to whoever initiated it.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, isZeroDecimal, subDecimal } from "@polymarket-bot/decimal";

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
 * - `ACTUAL_ARRIVAL` — the transaction moved the `ACTUAL_ACCOUNT` holding of
 *   this asset and nobody claimed the movement. This IS the §9.15 trigger,
 *   and its `haltRequired` is the literal `true`: the record can state the
 *   obligation, never waive it (an `ACTUAL_ARRIVAL` with `haltRequired:
 *   false` does not typecheck, so no code path can produce one).
 * - `REATTRIBUTION` — the transaction moved value BETWEEN attribution buckets
 *   (`UNATTRIBUTED` ⇄ `VIRTUAL_STRATEGY`) with no actual balance change. That
 *   is the REMEDIATION for an earlier arrival, and treating it as a fresh
 *   halt trigger would mean every fix re-raises the alarm it is fixing. It
 *   stays in the audit trail — attribution history is not erasable — with
 *   `haltRequired: false`.
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
  /** `scope|accountRef|assetId` -> balance line (zero lines dropped). */
  readonly balances: ReadonlyMap<string, BalanceLine>;
  /** `instanceId|assetId` -> virtual position line (zero lines dropped). */
  readonly virtualPositions: ReadonlyMap<string, VirtualPositionLine>;
  /** Every unattributed entry ever folded, in ledger order. Never dropped. */
  readonly unattributedActivity: readonly UnattributedActivityRecord[];
}

/** The empty projection. */
export function emptyProjection(): LedgerProjection {
  return Object.freeze({
    transactionCount: 0,
    balances: new Map<string, BalanceLine>(),
    virtualPositions: new Map<string, VirtualPositionLine>(),
    unattributedActivity: Object.freeze([]),
  });
}

function balanceKey(scope: LedgerScope, accountRef: string, assetId: string): string {
  return `${scope}|${accountRef}|${assetId}`;
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

  // Per-asset ACTUAL_ACCOUNT movement of THIS transaction, computed before the
  // fold so every unattributed entry can be classified against it. A non-zero
  // actual movement is the §9.15 halt trigger; a zero one is a re-attribution.
  const actualDeltaByAsset = new Map<string, DecimalString>();
  for (const entry of appended.transaction.entries) {
    if (entry.scope === "ACTUAL_ACCOUNT") {
      actualDeltaByAsset.set(
        entry.assetId,
        addDecimal(actualDeltaByAsset.get(entry.assetId) ?? ZERO, entry.amount),
      );
    }
  }

  for (const entry of appended.transaction.entries) {
    const key = balanceKey(entry.scope, entry.accountRef, entry.assetId);
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
      const virtualKey = `${entry.instanceId}|${entry.assetId}`;
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
      const movedActual = !isZeroDecimal(actualDeltaByAsset.get(entry.assetId) ?? ZERO);
      unattributed.push(
        movedActual
          ? Object.freeze({ ...base, activityKind: "ACTUAL_ARRIVAL" as const, haltRequired: true as const })
          : Object.freeze({ ...base, activityKind: "REATTRIBUTION" as const, haltRequired: false as const }),
      );
    }
  }

  return Object.freeze({
    transactionCount: projection.transactionCount + 1,
    balances,
    virtualPositions,
    unattributedActivity: Object.freeze([
      ...projection.unattributedActivity,
      ...unattributed,
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

/** All balance lines of one scope, sorted canonically. */
export function balancesOfScope(
  projection: LedgerProjection,
  scope: LedgerScope,
): readonly BalanceLine[] {
  return [...projection.balances.values()]
    .filter((line) => line.scope === scope)
    .sort((a, b) =>
      a.accountRef === b.accountRef
        ? a.assetId < b.assetId
          ? -1
          : 1
        : a.accountRef < b.accountRef
          ? -1
          : 1,
    );
}

/**
 * Actual outcome-token positions per (accountRef, assetId) — the
 * `actual_position_projection` shape (§10.5) minus average cost, which is
 * PnL-engine state (§9.16), not a ledger fact.
 */
export function actualPositions(projection: LedgerProjection): readonly BalanceLine[] {
  return balancesOfScope(projection, "ACTUAL_ACCOUNT").filter(
    (line) => line.assetKind === "OUTCOME_TOKEN",
  );
}

/** Virtual positions per (instanceId, assetId), sorted canonically. */
export function virtualPositions(
  projection: LedgerProjection,
): readonly VirtualPositionLine[] {
  return [...projection.virtualPositions.values()].sort((a, b) =>
    a.instanceId === b.instanceId
      ? a.assetId < b.assetId
        ? -1
        : 1
      : a.instanceId < b.instanceId
        ? -1
        : 1,
  );
}

/** One asset's unattributed exposure, summarized for an operator. */
export interface UnattributedExposureLine {
  readonly assetId: string;
  /** Net of every UNATTRIBUTED entry: equals the scope's balance line. */
  readonly net: DecimalString;
  /** Markets named by the contributing entries, sorted. */
  readonly affectedMarketIds: readonly string[];
  /** How many `ACTUAL_ARRIVAL` records this asset has — §9.15 halt triggers. */
  readonly haltTriggerCount: number;
  /** True while any halt trigger exists for the asset. */
  readonly haltRequired: boolean;
}

/**
 * Net unattributed exposure per asset, with the §9.15 halt triggers counted.
 *
 * A zero net is STILL REPORTED when the asset has any unattributed history:
 * "it nets to zero now" is not the same statement as "no unexplained movement
 * ever happened here", and only the second one is a reason to stop looking.
 */
export function unattributedExposure(
  projection: LedgerProjection,
): readonly UnattributedExposureLine[] {
  const byAsset = new Map<
    string,
    { net: DecimalString; markets: Set<string>; triggers: number }
  >();
  for (const record of projection.unattributedActivity) {
    const existing = byAsset.get(record.assetId) ?? {
      net: ZERO,
      markets: new Set<string>(),
      triggers: 0,
    };
    existing.net = addDecimal(existing.net, record.amount);
    if (record.affectedMarketId !== null) {
      existing.markets.add(record.affectedMarketId);
    }
    if (record.activityKind === "ACTUAL_ARRIVAL") {
      existing.triggers += 1;
    }
    byAsset.set(record.assetId, existing);
  }
  return [...byAsset.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([assetId, { net, markets, triggers }]) =>
      Object.freeze({
        assetId,
        net,
        affectedMarketIds: Object.freeze([...markets].sort()),
        haltTriggerCount: triggers,
        haltRequired: triggers > 0,
      }),
    );
}

/**
 * ADR-006 §2 partition audit over a WHOLE projection: for every asset, the
 * `ACTUAL_ACCOUNT` holding equals `VIRTUAL_STRATEGY` + `UNATTRIBUTED`.
 * Always empty for a projection folded from a `Ledger` (parity is enforced
 * per append); non-empty exactly when externally-loaded state is inconsistent.
 */
export function auditAttributionPartition(
  projection: LedgerProjection,
): readonly {
  readonly assetId: string;
  readonly actual: DecimalString;
  readonly attributed: DecimalString;
}[] {
  const actual = new Map<string, DecimalString>();
  const attributed = new Map<string, DecimalString>();
  for (const line of projection.balances.values()) {
    if (line.scope === "ACTUAL_ACCOUNT") {
      actual.set(line.assetId, addDecimal(actual.get(line.assetId) ?? ZERO, line.balance));
    } else if (line.scope === "VIRTUAL_STRATEGY" || line.scope === "UNATTRIBUTED") {
      attributed.set(
        line.assetId,
        addDecimal(attributed.get(line.assetId) ?? ZERO, line.balance),
      );
    }
  }
  const assetIds = new Set([...actual.keys(), ...attributed.keys()]);
  const violations: { assetId: string; actual: DecimalString; attributed: DecimalString }[] = [];
  for (const assetId of [...assetIds].sort()) {
    const actualNet = actual.get(assetId) ?? ZERO;
    const attributedNet = attributed.get(assetId) ?? ZERO;
    if (!isZeroDecimal(subDecimal(actualNet, attributedNet))) {
      violations.push({ assetId, actual: actualNet, attributed: attributedNet });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Canonical serialization — the byte-equality oracle format
// ---------------------------------------------------------------------------

/** Serialization domain prefix; changing the format is a versioned decision. */
export const LEDGER_PROJECTION_SERIALIZATION_DOMAIN = "polymarket-bot/ledger-projection/v1";

function sortedRecord<T>(map: ReadonlyMap<string, T>): Readonly<Record<string, T>> {
  const record: Record<string, T> = {};
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
