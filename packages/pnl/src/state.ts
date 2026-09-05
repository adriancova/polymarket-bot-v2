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
import { frozenMap, frozenSet, plainFrozen } from "./immutable.js";
import type { PnlRefusal, PnlResult } from "./refusals.js";
import {
  PnlConfigurationError,
  contained,
  pnlFailure,
  pnlOk,
  pnlRefusal,
  readInputAsData,
} from "./refusals.js";
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
import { PnlRecordDoor, PnlStreamIdentityDoor, pnlOwnerOf } from "./records.js";

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
  /**
   * ledgerTransactionId -> the record `ref` that realized it.
   *
   * ONE OBSERVED PAYOUT IS ONE REALIZATION (review round 2, HIGH-2). Round 1
   * deduplicated the PnL record's own `ref` and tracked no ledger evidence, so
   * two records with different refs naming the SAME booked 5 pUSD transaction
   * both folded and `realizedRewards` became 10 — the same money booked twice
   * from one observation. This map is the consumed-evidence identity, and it
   * lives IN the folded state rather than in a caller's memory: it is derived
   * from the record stream, so a rebuild reconstructs it exactly, and it is
   * carried by `serializePnlState`/`serializeRealizedPnl` so the byte oracle
   * sees it. A consumed set held outside the state would vanish on rebuild and
   * let the second record through.
   */
  readonly consumedRewardEvidence: ReadonlyMap<string, string>;
}

/**
 * An empty state for one stream. Throws on a malformed identity — including
 * one missing `environment` or `accountRef`, which are NOT NULL columns of
 * `accounting.pnl_snapshots` and are not derivable from a PnL value, so a
 * stream that cannot state them is a stream whose rows cannot be written.
 *
 * A PROTOTYPE-FREE DOOR (`WP-200-FU1`): **D1** the identity is materialized
 * before it is parsed, **D2** through {@link PnlStreamIdentityDoor}, **D3** the
 * stored identity is the materialized tree, **D4** which has no prototype.
 * Measured at `main` `761db76`, before this change: an identity with no own
 * `accountRef`, under one NON-ENUMERABLE `Object.prototype.accountRef`, opened
 * a stream on an account nobody named — and `accountRef` is a NOT NULL identity
 * column of the rows this stream produces, so the fabricated value would have
 * been written.
 *
 * The THROW is deliberate and unchanged: a malformed identity is a
 * construction-time contract violation, not a recoverable refusal. What IS new
 * is that it is the ONLY throw this function can produce (`WP-200-FU1`): the
 * outer guard converts anything else into the same typed error, so the
 * documented contract — "throws `PnlConfigurationError`, or returns a state" —
 * holds for every input rather than for the ones somebody thought of. Measured
 * need: under an inherited get-only accessor at an ARRAY-INDEX name the shared
 * door's own accumulator throws a bare `TypeError`, and that escaped
 * `foldPnlRecords` untyped.
 */
export function emptyPnlState(identity: PnlStreamIdentity): PnlState {
  try {
    return openPnlStream(identity);
  } catch (error) {
    if (error instanceof PnlConfigurationError) {
      throw error;
    }
    throw new PnlConfigurationError("a PnL stream could not be opened for this identity", {
      raw: identity,
    });
  }
}

function openPnlStream(identity: PnlStreamIdentity): PnlState {
  const read = readInputAsData(identity, "identity", "PnL stream identity");
  if (!read.ok) {
    throw new PnlConfigurationError("value is not a PnL stream identity", {
      raw: identity,
      issues: read.refusal.details["issues"] ?? [],
    });
  }
  const parsed = PnlStreamIdentityDoor.safeParse(read.value);
  if (!parsed.success) {
    throw new PnlConfigurationError("value is not a PnL stream identity", {
      raw: identity,
      issues: formatIssues(parsed.error),
    });
  }
  // D3/D4 — the identity IS the materialized, prototype-free tree.
  const materialized = deepFreezeIdentity(read.value as PnlStreamIdentity);
  return plainFrozen({
    identity: materialized,
    owner: pnlOwnerOf(materialized),
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
    consumedRewardEvidence: frozenMap(new Map<string, string>()),
  });
}

/** Freezes the materialized identity (a flat record of strings). */
function deepFreezeIdentity(identity: PnlStreamIdentity): PnlStreamIdentity {
  return Object.freeze(identity);
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

/**
 * ADR-016 pre-check: refuse a UUID-shaped, non-canonical id with the raw value.
 *
 * Runs on the MATERIALIZED tree (`WP-200-FU1`), so `record[field]` and
 * `owner["instanceId"]` are own-property reads on objects with no prototype
 * chain, and a getter has already been refused by D1 rather than invoked here.
 */
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
  consumedRewardEvidence: Map<string, string>;
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
    consumedRewardEvidence: new Map(state.consumedRewardEvidence),
  };
}

/**
 * Seals a folded state: every container is frozen against runtime mutation as
 * well as against the type system (`immutable.ts`), because a `readonly` type
 * stops a TypeScript caller and nothing else.
 *
 * `frozenMap`/`frozenSet` also DEEP-FREEZE what they hold (review round 2,
 * HIGH-4): sealing `lots` while leaving the `OpenLot` inside it writable let a
 * consumer rewrite a cost basis from 4 to 999 by ordinary property assignment,
 * and the next snapshot reported the 999.
 */
function freeze(state: MutableState): PnlState {
  // D4 — the folded state has no prototype, so `state.consumedRewardEvidence`
  // and every other container read on a value this package handed out is
  // answered by the state or not at all.
  return plainFrozen({
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
    consumedRewardEvidence: frozenMap(state.consumedRewardEvidence),
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
 *
 * A PROTOTYPE-FREE DOOR (`WP-200-FU1`, 2026-09-04), performing all four steps
 * of `docs/contracts/schema-boundary.md` §1:
 *
 * - **D1** `readInputAsData` materializes the record into a fresh tree of plain
 *   own data with NO PROTOTYPE, reading descriptors rather than properties;
 * - **D2** the parse goes through {@link PnlRecordDoor}, the severed, warmed
 *   arena copy — which is also what stops the cold-first-parse `TypeError` from
 *   escaping and poisoning the union (transcript at that constant);
 * - **D3** the record folded below is the materialized tree, not `parsed.data`;
 * - **D4** the state this returns has no prototype, and neither do the lots and
 *   trade effects inside it.
 *
 * ORDER IS UNCHANGED except for D1: the ADR-016 canonicality pre-check still
 * runs before the grammar, owner and duplicate-ref checks still follow it, and
 * every refusal code, message and detail is the one `WP-200` shipped.
 */
export function applyPnlRecord(
  state: PnlState,
  input: unknown,
  evidence?: PnlSettlementEvidence,
): PnlResult<PnlState> {
  return contained(() => applyMaterializedPnlRecord(state, input, evidence));
}

function applyMaterializedPnlRecord(
  state: PnlState,
  input: unknown,
  evidence: PnlSettlementEvidence | undefined,
): PnlResult<PnlState> {
  // D1.
  const read = readInputAsData(input, "record", "PnL record");
  if (!read.ok) {
    return pnlFailure(read.refusal);
  }
  const materialized = read.value;

  const uuidRefusals = collectUuidRefusals(materialized);
  if (uuidRefusals.length > 0) {
    return pnlFailure(...uuidRefusals);
  }
  // D2 — the answer is the library's; the output is discarded.
  const parsed = PnlRecordDoor.safeParse(materialized);
  if (!parsed.success) {
    return pnlFailure(
      pnlRefusal("PNL_INPUT_INVALID", "the value is not a PnL record", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  // D3 — the folded record IS the materialized tree.
  const record = materialized as PnlRecord;

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
  // `emptyPnlState` is deliberately OUTSIDE the containment guard: its
  // `PnlConfigurationError` is the documented construction-time contract.
  let state = emptyPnlState(identity);
  return contained(() => {
    for (const [index, record] of records.entries()) {
      const result = applyPnlRecord(state, record, evidence);
      if (!result.ok) {
        return pnlFailure<PnlState>(
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
  });
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
    next.lots.set(
      record.tokenAssetId,
      plainFrozen({
        shares,
        costBasis,
        denominationAsset: record.denominationAsset,
        marketId: record.marketId,
      }),
    );
    next.tradeLog.set(
      record.ref,
      plainFrozen({
        side: "BUY" as const,
        tokenAssetId: record.tokenAssetId,
        shares: record.shares,
        basisDelta: notional,
        realizedDelta: ZERO,
        denominationAsset: record.denominationAsset,
      }),
    );
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
      next.lots.set(record.tokenAssetId, plainFrozen({ ...lot, shares, costBasis: remaining }));
    }
    addTo(next.realizedTrading, record.denominationAsset, realizedDelta);
    next.tradeLog.set(
      record.ref,
      plainFrozen({
        side: "SELL" as const,
        tokenAssetId: record.tokenAssetId,
        shares: record.shares,
        basisDelta: subDecimal(ZERO, removed),
        realizedDelta,
        denominationAsset: record.denominationAsset,
      }),
    );
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
      next.lots.set(effect.tokenAssetId, plainFrozen({ ...lot, shares, costBasis }));
    }
  } else {
    // Unwind a sell: restore the shares and basis, take back the realized PnL.
    const restoredBasis = subDecimal(ZERO, effect.basisDelta);
    next.lots.set(
      effect.tokenAssetId,
      plainFrozen({
        shares: addDecimal(lot?.shares ?? ZERO, effect.shares),
        costBasis: addDecimal(lot?.costBasis ?? ZERO, restoredBasis),
        denominationAsset: effect.denominationAsset,
        marketId: lot?.marketId ?? null,
      }),
    );
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
    next.lots.set(record.tokenAssetId, plainFrozen({ ...lot, shares, costBasis: remaining }));
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
  next.lots.set(
    record.tokenAssetId,
    plainFrozen({
      shares: addDecimal(lot?.shares ?? ZERO, record.shares),
      costBasis: addDecimal(lot?.costBasis ?? ZERO, record.costBasis),
      denominationAsset: record.denominationAsset,
      marketId: record.marketId ?? lot?.marketId ?? null,
    }),
  );
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
 *
 * AND ONE OBSERVATION REALIZES ONCE (review round 2, HIGH-2). The evidence
 * check is stateless — it answers "does this booking support this claim?" — so
 * on its own it answers YES every time it is asked. Two payout records with
 * different `ref`s naming one booked 5 pUSD transaction therefore both folded
 * and booked 10. The stream now records which bookings it has consumed and
 * refuses the second, naming the record that consumed it first.
 *
 * The consumption key is the LEDGER TRANSACTION ID alone, not
 * `(transaction, denomination)` or `(transaction, program)`. A transaction
 * carries one `eventType`, so one booking supports one program; the only shape
 * this coarser key refuses that a finer one would admit is a single booking
 * crediting rewards in two denominations at once. That is refused deliberately:
 * no reward-posting builder exists yet (`follow_up`), ADR-006 §7 keeps
 * denominations apart anyway, and a loud refusal of an unusual booking is the
 * right way to lose that argument — double-realized money is not.
 */
function applyRewardPayout(
  state: PnlState,
  record: PnlRewardPayoutRecord,
  evidence: PnlSettlementEvidence | undefined,
): PnlResult<PnlState> {
  const consumedBy = state.consumedRewardEvidence.get(record.ledgerTransactionId);
  if (consumedBy !== undefined) {
    return pnlFailure(
      pnlRefusal(
        "PNL_REWARD_EVIDENCE_ALREADY_REALIZED",
        `reward payout ${record.ref} names ledger transaction ` +
          `${record.ledgerTransactionId}, which record ${consumedBy} already realized in ` +
          "this stream; one observed payout is realized once (ADR-006 §6)",
        {
          ref: record.ref,
          ledgerTransactionId: record.ledgerTransactionId,
          alreadyRealizedBy: consumedBy,
        },
      ),
    );
  }
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
  next.consumedRewardEvidence.set(record.ledgerTransactionId, record.ref);
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
