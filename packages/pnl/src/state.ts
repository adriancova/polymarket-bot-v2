/**
 * The PnL fold (§9.16, §6 invariants 8 and 14).
 *
 * A `PnlState` is an immutable value folding one STREAM's records — one
 * strategy instance in one account, one account, or one account's
 * unattributed bucket, in one environment — exactly the identity of the
 * §10.5 `pnl_snapshots` rows it produces (`PnlStreamIdentity` in
 * `records.ts`, which states why the identity is the stream's and not the
 * snapshot call's). Applying a record returns a NEW state; `foldPnlRecords`
 * rebuilds from zero through the SAME step, so rebuild-equals-incremental
 * holds by construction and is verified byte-for-byte in tests (§6
 * invariant 8).
 *
 * A reward payout realizes ONLY against `PnlSettlementEvidence` — the booked
 * ledger transaction itself, not its identifier (`evidence.ts`).
 *
 * Everything monetary is per DENOMINATION ASSET and never summed across
 * denominations (ADR-006 §7: USDC and pUSD are never interchangeable; the
 * C-2 conflict is unresolved and is not resolved here by assumption).
 *
 * Realized versus unrealized: this fold accumulates only REALIZED facts
 * (recognized trades, settlement-grade realizations, fees, observed reward
 * payouts) and non-monetary analytics (reward estimates). Unrealized PnL is
 * computed at snapshot time from open lots and caller-supplied marks
 * (`snapshot.ts`), so the separation is structural, not a convention.
 *
 * Cost method: average cost per token asset. Removing q shares from a lot of
 * Q shares with basis B removes basis B·q/Q — computed exactly when q = Q,
 * otherwise via `divDecimal`'s documented policy (34 significant digits,
 * ROUND_HALF_EVEN), with the REMAINING basis derived by exact subtraction so
 * total basis is conserved to the penny across any split.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import {
  addDecimal,
  compareDecimal,
  divDecimal,
  isZeroDecimal,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";

import type { PnlSettlementEvidence } from "./evidence.js";
import { verifyRewardPayoutEvidence } from "./evidence.js";
import { frozenMap, frozenSet } from "./immutable.js";
import type { PnlRefusal, PnlResult } from "./refusals.js";
import { PnlConfigurationError, pnlFailure, pnlOk, pnlRefusal } from "./refusals.js";
import type {
  PnlCostBasisInjectionRecord,
  PnlFeeRecord,
  PnlOwner,
  PnlRealizationRecord,
  PnlRecord,
  PnlRewardEstimateRecord,
  PnlRewardPayoutRecord,
  PnlStreamIdentity,
  PnlTradeRecord,
  PnlTradeReversalRecord,
} from "./records.js";
import { PnlRecordSchema, PnlStreamIdentitySchema, pnlOwnerOf } from "./records.js";

const ZERO: DecimalString = "0";

/** An open average-cost lot for one token asset. */
export interface OpenLot {
  readonly shares: DecimalString;
  readonly costBasis: DecimalString;
  readonly denominationAsset: string;
  readonly marketId: string | null;
}

/** What a folded trade did — kept so a reversal can unwind it exactly. */
interface AppliedTradeEffect {
  readonly side: "BUY" | "SELL";
  readonly tokenAssetId: string;
  readonly shares: DecimalString;
  /** Signed basis change the trade applied to the lot. */
  readonly basisDelta: DecimalString;
  /** Signed realized-trading change the trade applied. */
  readonly realizedDelta: DecimalString;
  readonly denominationAsset: string;
}

/** Composite map key, collision-free for arbitrary identifier content. */
function key2(a: string, b: string): string {
  return JSON.stringify([a, b]);
}

export interface PnlState {
  /**
   * Who this stream is, in the persistence identity the §10.5
   * `pnl_snapshots` rows require: scope, environment, account, and (for a
   * strategy stream) instance, plus any run/market scoping.
   */
  readonly identity: PnlStreamIdentity;
  /** The owner half of {@link identity} — what every record's owner must match. */
  readonly owner: PnlOwner;
  readonly recordCount: number;
  readonly refs: ReadonlySet<string>;
  /** tokenAssetId -> open lot (closed lots are dropped). */
  readonly lots: ReadonlyMap<string, OpenLot>;
  /** denominationAsset -> realized trading PnL (§9.16 "realized PnL"). */
  readonly realizedTrading: ReadonlyMap<string, DecimalString>;
  /** denominationAsset -> fees paid (§9.16 "fees paid"). */
  readonly feesPaid: ReadonlyMap<string, DecimalString>;
  /** [denominationAsset, scheduleVersionRef|""] -> fees (§9.16 versioning). */
  readonly feesBySchedule: ReadonlyMap<string, DecimalString>;
  /** denominationAsset -> observed reward payouts (§9.16 "realized rewards"). */
  readonly realizedRewards: ReadonlyMap<string, DecimalString>;
  /** [denominationAsset, programType] -> observed payouts. */
  readonly rewardsByProgram: ReadonlyMap<string, DecimalString>;
  /** denominationAsset -> reward estimates (§9.16 "reward estimates"). */
  readonly rewardEstimates: ReadonlyMap<string, DecimalString>;
  /** [denominationAsset, programType] -> estimates. */
  readonly estimatesByProgram: ReadonlyMap<string, DecimalString>;
  /** trade ref -> applied effect (for exact reversals). */
  readonly tradeLog: ReadonlyMap<string, AppliedTradeEffect>;
  readonly reversedRefs: ReadonlySet<string>;
}

/**
 * An empty state for one stream. Throws on a malformed identity — including
 * one missing `environment` or `accountRef`, which are NOT NULL columns of
 * `accounting.pnl_snapshots` and are not derivable from a PnL value, so a
 * stream that cannot state them is a stream whose rows cannot be written.
 */
export function emptyPnlState(identity: PnlStreamIdentity): PnlState {
  const parsed = PnlStreamIdentitySchema.safeParse(identity);
  if (!parsed.success) {
    throw new PnlConfigurationError("value is not a PnL stream identity", {
      raw: identity,
      issues: formatIssues(parsed.error),
    });
  }
  return Object.freeze({
    identity: Object.freeze(parsed.data),
    owner: pnlOwnerOf(parsed.data),
    recordCount: 0,
    refs: frozenSet(new Set<string>()),
    lots: frozenMap(new Map<string, OpenLot>()),
    realizedTrading: frozenMap(new Map<string, DecimalString>()),
    feesPaid: frozenMap(new Map<string, DecimalString>()),
    feesBySchedule: frozenMap(new Map<string, DecimalString>()),
    realizedRewards: frozenMap(new Map<string, DecimalString>()),
    rewardsByProgram: frozenMap(new Map<string, DecimalString>()),
    rewardEstimates: frozenMap(new Map<string, DecimalString>()),
    estimatesByProgram: frozenMap(new Map<string, DecimalString>()),
    tradeLog: frozenMap(new Map<string, AppliedTradeEffect>()),
    reversedRefs: frozenSet(new Set<string>()),
  });
}

/**
 * Owner equality. Every owner names an account, and a strategy owner names
 * the account its attribution partitions as well as its instance: the same
 * instance's records booked in a DIFFERENT account belong to a different
 * stream and a different `pnl_snapshots` row.
 */
function sameOwner(a: PnlOwner, b: PnlOwner): boolean {
  if (a.scope !== b.scope || a.accountRef !== b.accountRef) {
    return false;
  }
  if (a.scope === "VIRTUAL_STRATEGY" && b.scope === "VIRTUAL_STRATEGY") {
    return a.instanceId === b.instanceId;
  }
  return true;
}

const UUID_SHAPED_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

const CANONICAL_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const UUID_FIELDS = ["ref", "reversesRef", "marketId", "ledgerTransactionId"] as const;

/** ADR-016 pre-check: refuse a UUID-shaped, non-canonical id with the raw value. */
function collectUuidRefusals(value: unknown): readonly PnlRefusal[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Readonly<Record<string, unknown>>;
  const refusals: PnlRefusal[] = [];
  const check = (field: string, candidate: unknown): void => {
    if (
      typeof candidate === "string" &&
      UUID_SHAPED_PATTERN.test(candidate) &&
      !CANONICAL_UUID_V7_PATTERN.test(candidate)
    ) {
      refusals.push(
        pnlRefusal(
          "PNL_UUID_NOT_CANONICAL",
          `${field} is UUID-shaped but not the canonical lowercase UUIDv7 spelling; ` +
            "refused, not normalized (ADR-016 §2)",
          { field, raw: candidate },
        ),
      );
    }
  };
  for (const field of UUID_FIELDS) {
    check(field, record[field]);
  }
  const owner = record["owner"];
  if (typeof owner === "object" && owner !== null) {
    check("owner.instanceId", (owner as Readonly<Record<string, unknown>>)["instanceId"]);
  }
  return refusals;
}

function formatIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

interface MutableState {
  identity: PnlStreamIdentity;
  owner: PnlOwner;
  recordCount: number;
  refs: Set<string>;
  lots: Map<string, OpenLot>;
  realizedTrading: Map<string, DecimalString>;
  feesPaid: Map<string, DecimalString>;
  feesBySchedule: Map<string, DecimalString>;
  realizedRewards: Map<string, DecimalString>;
  rewardsByProgram: Map<string, DecimalString>;
  rewardEstimates: Map<string, DecimalString>;
  estimatesByProgram: Map<string, DecimalString>;
  tradeLog: Map<string, AppliedTradeEffect>;
  reversedRefs: Set<string>;
}

function thaw(state: PnlState): MutableState {
  return {
    identity: state.identity,
    owner: state.owner,
    recordCount: state.recordCount,
    refs: new Set(state.refs),
    lots: new Map(state.lots),
    realizedTrading: new Map(state.realizedTrading),
    feesPaid: new Map(state.feesPaid),
    feesBySchedule: new Map(state.feesBySchedule),
    realizedRewards: new Map(state.realizedRewards),
    rewardsByProgram: new Map(state.rewardsByProgram),
    rewardEstimates: new Map(state.rewardEstimates),
    estimatesByProgram: new Map(state.estimatesByProgram),
    tradeLog: new Map(state.tradeLog),
    reversedRefs: new Set(state.reversedRefs),
  };
}

/**
 * Seals a folded state: every container is frozen against runtime mutation as
 * well as against the type system (`immutable.ts`), because a `readonly` type
 * stops a TypeScript caller and nothing else.
 */
function freeze(state: MutableState): PnlState {
  return Object.freeze({
    identity: state.identity,
    owner: state.owner,
    recordCount: state.recordCount,
    refs: frozenSet(state.refs),
    lots: frozenMap(state.lots),
    realizedTrading: frozenMap(state.realizedTrading),
    feesPaid: frozenMap(state.feesPaid),
    feesBySchedule: frozenMap(state.feesBySchedule),
    realizedRewards: frozenMap(state.realizedRewards),
    rewardsByProgram: frozenMap(state.rewardsByProgram),
    rewardEstimates: frozenMap(state.rewardEstimates),
    estimatesByProgram: frozenMap(state.estimatesByProgram),
    tradeLog: frozenMap(state.tradeLog),
    reversedRefs: frozenSet(state.reversedRefs),
  });
}

function addTo(map: Map<string, DecimalString>, key: string, amount: DecimalString): void {
  map.set(key, addDecimal(map.get(key) ?? ZERO, amount));
}

/**
 * Basis removed when q of Q shares leave a lot with basis B: exactly B when
 * the lot closes, otherwise B·q/Q under `divDecimal`'s documented policy,
 * with the REMAINDER computed by exact subtraction (conservation).
 */
function basisOfRemoval(
  lot: OpenLot,
  shares: DecimalString,
): { readonly removed: DecimalString; readonly remaining: DecimalString } {
  if (compareDecimal(shares, lot.shares) === 0) {
    return { removed: lot.costBasis, remaining: ZERO };
  }
  const removed = divDecimal(mulDecimal(lot.costBasis, shares), lot.shares);
  return { removed, remaining: subDecimal(lot.costBasis, removed) };
}

/**
 * Applies one record, returning the new state or the refusals. The receiver
 * is never modified.
 *
 * `evidence` is required only by `REWARD_PAYOUT`, which realizes money and
 * therefore must be proven against the booked ledger transaction rather than
 * against its identifier (`evidence.ts`). Every other record kind carries its
 * own facts and ignores it.
 */
export function applyPnlRecord(
  state: PnlState,
  input: unknown,
  evidence?: PnlSettlementEvidence,
): PnlResult<PnlState> {
  const uuidRefusals = collectUuidRefusals(input);
  if (uuidRefusals.length > 0) {
    return pnlFailure(...uuidRefusals);
  }
  const parsed = PnlRecordSchema.safeParse(input);
  if (!parsed.success) {
    return pnlFailure(
      pnlRefusal("PNL_INPUT_INVALID", "the value is not a PnL record", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  const record: PnlRecord = parsed.data;

  if (!sameOwner(record.owner, state.owner)) {
    return pnlFailure(
      pnlRefusal("PNL_OWNER_MISMATCH", "this state folds a different owner's stream", {
        stateOwner: state.owner,
        recordOwner: record.owner,
      }),
    );
  }
  if (state.refs.has(record.ref)) {
    return pnlFailure(
      pnlRefusal("PNL_DUPLICATE_REF", `record ${record.ref} was already folded`, {
        ref: record.ref,
      }),
    );
  }

  switch (record.kind) {
    case "TRADE":
      return applyTrade(state, record);
    case "TRADE_REVERSAL":
      return applyTradeReversal(state, record);
    case "REALIZATION":
      return applyRealization(state, record);
    case "COST_BASIS_INJECTION":
      return applyInjection(state, record);
    case "FEE":
      return applyFee(state, record);
    case "REWARD_PAYOUT":
      return applyRewardPayout(state, record, evidence);
    case "REWARD_ESTIMATE":
      return applyRewardEstimate(state, record);
  }
}

/** Folds a whole stream from zero — the rebuild path (§6 invariant 8). */
export function foldPnlRecords(
  identity: PnlStreamIdentity,
  records: readonly unknown[],
  evidence?: PnlSettlementEvidence,
): PnlResult<PnlState> {
  let state = emptyPnlState(identity);
  for (const [index, record] of records.entries()) {
    const result = applyPnlRecord(state, record, evidence);
    if (!result.ok) {
      return pnlFailure(
        pnlRefusal("PNL_INPUT_INVALID", `fold refused at record index ${index}`, {
          index,
          refusals: result.refusals,
        }),
        ...result.refusals,
      );
    }
    state = result.value;
  }
  return pnlOk(state);
}

// ---------------------------------------------------------------------------
// Record handlers
// ---------------------------------------------------------------------------

function denominationConflict(
  record: { readonly ref: string; readonly denominationAsset: string },
  lot: OpenLot,
  tokenAssetId: string,
): PnlRefusal {
  return pnlRefusal(
    "PNL_DENOMINATION_CONFLICT",
    `token ${tokenAssetId} is denominated in ${lot.denominationAsset}; refused a ` +
      `${record.denominationAsset} record (ADR-006 §7: denominations never interchange)`,
    {
      ref: record.ref,
      tokenAssetId,
      lotDenomination: lot.denominationAsset,
      recordDenomination: record.denominationAsset,
    },
  );
}

function applyTrade(state: PnlState, record: PnlTradeRecord): PnlResult<PnlState> {
  if (record.settlementState === "FAILED") {
    return pnlFailure(
      pnlRefusal(
        "PNL_SETTLEMENT_FAILED_TRADE",
        `trade ${record.ref} is already FAILED; a failure is a compensating reversal ` +
          "of a recognized trade, never a fresh recognition (ADR-006 §5)",
        { ref: record.ref, settlementState: record.settlementState },
      ),
    );
  }
  const lot = state.lots.get(record.tokenAssetId);
  if (lot !== undefined && lot.denominationAsset !== record.denominationAsset) {
    return pnlFailure(denominationConflict(record, lot, record.tokenAssetId));
  }
  const next = thaw(state);
  const notional = mulDecimal(record.price, record.shares);

  if (record.side === "BUY") {
    const shares = addDecimal(lot?.shares ?? ZERO, record.shares);
    const costBasis = addDecimal(lot?.costBasis ?? ZERO, notional);
    next.lots.set(record.tokenAssetId, {
      shares,
      costBasis,
      denominationAsset: record.denominationAsset,
      marketId: record.marketId,
    });
    next.tradeLog.set(record.ref, {
      side: "BUY",
      tokenAssetId: record.tokenAssetId,
      shares: record.shares,
      basisDelta: notional,
      realizedDelta: ZERO,
      denominationAsset: record.denominationAsset,
    });
  } else {
    const held = lot?.shares ?? ZERO;
    if (lot === undefined || compareDecimal(record.shares, held) > 0) {
      return pnlFailure(
        pnlRefusal(
          "PNL_OVERSELL",
          `trade ${record.ref} sells ${record.shares} of token ${record.tokenAssetId} ` +
            `but the position holds ${held} (selling requires inventory)`,
          {
            ref: record.ref,
            tokenAssetId: record.tokenAssetId,
            sharesSold: record.shares,
            sharesHeld: held,
          },
        ),
      );
    }
    const { removed, remaining } = basisOfRemoval(lot, record.shares);
    const realizedDelta = subDecimal(notional, removed);
    const shares = subDecimal(lot.shares, record.shares);
    if (isZeroDecimal(shares)) {
      next.lots.delete(record.tokenAssetId);
    } else {
      next.lots.set(record.tokenAssetId, { ...lot, shares, costBasis: remaining });
    }
    addTo(next.realizedTrading, record.denominationAsset, realizedDelta);
    next.tradeLog.set(record.ref, {
      side: "SELL",
      tokenAssetId: record.tokenAssetId,
      shares: record.shares,
      basisDelta: subDecimal(ZERO, removed),
      realizedDelta,
      denominationAsset: record.denominationAsset,
    });
  }

  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

function applyTradeReversal(
  state: PnlState,
  record: PnlTradeReversalRecord,
): PnlResult<PnlState> {
  const effect = state.tradeLog.get(record.reversesRef);
  if (effect === undefined) {
    return pnlFailure(
      pnlRefusal(
        "PNL_REVERSAL_UNKNOWN",
        `reversal ${record.ref} references trade ${record.reversesRef}, which this ` +
          "state never folded",
        { ref: record.ref, reversesRef: record.reversesRef },
      ),
    );
  }
  if (state.reversedRefs.has(record.reversesRef)) {
    return pnlFailure(
      pnlRefusal(
        "PNL_ALREADY_REVERSED",
        `trade ${record.reversesRef} was already reversed once`,
        { ref: record.ref, reversesRef: record.reversesRef },
      ),
    );
  }

  const next = thaw(state);
  const lot = state.lots.get(effect.tokenAssetId);

  if (effect.side === "BUY") {
    // Unwind a buy: the lot must still hold the shares and the basis.
    const held = lot?.shares ?? ZERO;
    const basis = lot?.costBasis ?? ZERO;
    if (
      lot === undefined ||
      compareDecimal(effect.shares, held) > 0 ||
      compareDecimal(effect.basisDelta, basis) > 0
    ) {
      return pnlFailure(
        pnlRefusal(
          "PNL_REVERSAL_INSUFFICIENT_POSITION",
          `reversal ${record.ref} cannot unwind trade ${record.reversesRef}: the ` +
            "position no longer holds its shares or basis; book a reconciliation " +
            "correction instead",
          {
            ref: record.ref,
            reversesRef: record.reversesRef,
            sharesHeld: held,
            basisHeld: basis,
            sharesToRemove: effect.shares,
            basisToRemove: effect.basisDelta,
          },
        ),
      );
    }
    const shares = subDecimal(lot.shares, effect.shares);
    const costBasis = subDecimal(lot.costBasis, effect.basisDelta);
    if (isZeroDecimal(shares) && isZeroDecimal(costBasis)) {
      next.lots.delete(effect.tokenAssetId);
    } else {
      next.lots.set(effect.tokenAssetId, { ...lot, shares, costBasis });
    }
  } else {
    // Unwind a sell: restore the shares and basis, take back the realized PnL.
    const restoredBasis = subDecimal(ZERO, effect.basisDelta);
    next.lots.set(effect.tokenAssetId, {
      shares: addDecimal(lot?.shares ?? ZERO, effect.shares),
      costBasis: addDecimal(lot?.costBasis ?? ZERO, restoredBasis),
      denominationAsset: effect.denominationAsset,
      marketId: lot?.marketId ?? null,
    });
    addTo(next.realizedTrading, effect.denominationAsset, subDecimal(ZERO, effect.realizedDelta));
  }

  next.reversedRefs.add(record.reversesRef);
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

function applyRealization(
  state: PnlState,
  record: PnlRealizationRecord,
): PnlResult<PnlState> {
  const lot = state.lots.get(record.tokenAssetId);
  const held = lot?.shares ?? ZERO;
  if (lot === undefined || compareDecimal(record.shares, held) > 0) {
    return pnlFailure(
      pnlRefusal(
        "PNL_OVERSELL",
        `realization ${record.ref} settles ${record.shares} of token ` +
          `${record.tokenAssetId} but the position holds ${held}`,
        {
          ref: record.ref,
          tokenAssetId: record.tokenAssetId,
          sharesSettled: record.shares,
          sharesHeld: held,
        },
      ),
    );
  }
  if (lot.denominationAsset !== record.denominationAsset) {
    return pnlFailure(denominationConflict(record, lot, record.tokenAssetId));
  }
  const next = thaw(state);
  const { removed, remaining } = basisOfRemoval(lot, record.shares);
  const proceeds = mulDecimal(record.payoutPerShare, record.shares);
  addTo(next.realizedTrading, record.denominationAsset, subDecimal(proceeds, removed));
  const shares = subDecimal(lot.shares, record.shares);
  if (isZeroDecimal(shares)) {
    next.lots.delete(record.tokenAssetId);
  } else {
    next.lots.set(record.tokenAssetId, { ...lot, shares, costBasis: remaining });
  }
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

function applyInjection(
  state: PnlState,
  record: PnlCostBasisInjectionRecord,
): PnlResult<PnlState> {
  const lot = state.lots.get(record.tokenAssetId);
  if (lot !== undefined && lot.denominationAsset !== record.denominationAsset) {
    return pnlFailure(denominationConflict(record, lot, record.tokenAssetId));
  }
  const next = thaw(state);
  next.lots.set(record.tokenAssetId, {
    shares: addDecimal(lot?.shares ?? ZERO, record.shares),
    costBasis: addDecimal(lot?.costBasis ?? ZERO, record.costBasis),
    denominationAsset: record.denominationAsset,
    marketId: record.marketId ?? lot?.marketId ?? null,
  });
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

function applyFee(state: PnlState, record: PnlFeeRecord): PnlResult<PnlState> {
  const next = thaw(state);
  addTo(next.feesPaid, record.denominationAsset, record.amount);
  addTo(
    next.feesBySchedule,
    key2(record.denominationAsset, record.scheduleVersionRef ?? ""),
    record.amount,
  );
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

/**
 * ADR-006 §6: "only an observed payout creates a `REWARD_INCOME` entry."
 *
 * The observation is the BOOKED LEDGER TRANSACTION, and this handler will not
 * move `realizedRewards` until the supplied evidence proves that transaction
 * books this program's payout, in this environment, for this owner, in this
 * denomination, for exactly this amount. A caller holding only a canonical
 * UUID cannot realize anything (`evidence.ts` states what the boundary does
 * and does not guarantee).
 */
function applyRewardPayout(
  state: PnlState,
  record: PnlRewardPayoutRecord,
  evidence: PnlSettlementEvidence | undefined,
): PnlResult<PnlState> {
  const unproven = verifyRewardPayoutEvidence(
    {
      ref: record.ref,
      ledgerTransactionId: record.ledgerTransactionId,
      programType: record.programType,
      amount: record.amount,
      denominationAsset: record.denominationAsset,
    },
    state.owner,
    state.identity.environment,
    evidence,
  );
  if (unproven.length > 0) {
    return pnlFailure(...unproven);
  }
  const next = thaw(state);
  addTo(next.realizedRewards, record.denominationAsset, record.amount);
  addTo(next.rewardsByProgram, key2(record.denominationAsset, record.programType), record.amount);
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

/**
 * §9.16, verbatim: "Reward estimates are never booked as realized." This
 * handler touches the ESTIMATE buckets and record bookkeeping — nothing
 * else. It cannot reach `realizedTrading`, `realizedRewards`, `feesPaid`,
 * or the lots; the acceptance-3 tests pin that byte-for-byte.
 */
function applyRewardEstimate(
  state: PnlState,
  record: PnlRewardEstimateRecord,
): PnlResult<PnlState> {
  const next = thaw(state);
  addTo(next.rewardEstimates, record.denominationAsset, record.amount);
  addTo(next.estimatesByProgram, key2(record.denominationAsset, record.programType), record.amount);
  next.refs.add(record.ref);
  next.recordCount += 1;
  return pnlOk(freeze(next));
}

export { key2 as pnlCompositeKey };
