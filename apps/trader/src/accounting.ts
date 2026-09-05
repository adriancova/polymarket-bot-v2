/**
 * The accounting hop of the loop — §9.15 ledger, §9.16 PnL, and §6 invariant 4's
 * traceability chain.
 *
 * > "**Every fill is traceable:** `fill → order → submission attempt →
 * > execution plan → intent → decision → feature snapshot → source event`."
 *   — handoff §6 invariant 4
 *
 * That chain is not a comment here, it is a VALUE: {@link TraceLink} carries
 * one identifier per hop, is built as the loop walks the hops, and is what the
 * end-to-end acceptance fixture asserts hop by hop. A chain with a missing hop
 * is not constructible — every field is required — so a fill that reached the
 * ledger without a plan behind it cannot be recorded as traceable.
 *
 * ## What this module does, and what it refuses to do
 *
 * It converts one simulated fill into:
 *
 * 1. a `FillFact` (`packages/simulation`'s `toFillFact`, whose four
 *    caller-supplied identities — the ledger's `fillId`, the `accountRef` and
 *    the two asset ids — are stated here because ADR-006 §7 rule 1 forbids an
 *    implicit "cash" asset and the simulator may not invent them);
 * 2. an allocation across the strategy instances that claim it
 *    (`allocateFill`), with any remainder landing in the EXPLICIT
 *    `UNATTRIBUTED` scope carrying `haltRequired: true`;
 * 3. balanced ledger transactions and the PnL records they imply
 *    (`buildFillPosting`);
 * 4. an append to the real `Ledger`, whose per-asset zero-sum and attribution
 *    parity rules are what actually enforce §9.15.
 *
 * It computes NO economics of its own. Every decimal here comes from a merged
 * package; this module supplies identity and ordering.
 *
 * ## Ids are minted deterministically, and that is a §12.4 requirement
 *
 * `packages/ledger` reads no randomness and demands caller-minted UUIDv7 ids.
 * A `randomUUID()` here would break "a fixed dataset, code commit, config,
 * feature version, model version, simulator version, and seed must produce
 * byte-identical … ledger events". So ids are DERIVED — a run-scoped namespace
 * plus a monotonic ordinal, rendered in the UUIDv7 shape the schemas require —
 * and the derivation is pure. Two runs over the same events mint the same ids.
 */

import {
  Ledger,
  allocateFill,
  buildFillPosting,
  projectLedger,
  type AppendedLedgerTransaction,
  type FillAllocationResult,
  type LedgerProjection,
  type LedgerRefusal,
  type LedgerTransactionInput,
  type PnlFeeRecord,
  type PnlTradeRecord,
} from "@polymarket-bot/ledger";
import type { RunMode } from "@polymarket-bot/domain";
import { toFillFact, type SimulatedFill } from "@polymarket-bot/simulation";

/**
 * §6 invariant 4's chain, as one value.
 *
 * Every hop is REQUIRED. The chain is built forward as the loop walks the hops
 * and is completed only when a fill arrives, so a chain that exists is a chain
 * whose every link was really taken.
 */
export interface TraceLink {
  /** The §7.1 `eventId` that triggered the evaluation. */
  readonly sourceEventId: string;
  /** The feature snapshot the strategy saw (`packages/features` content address). */
  readonly featureSnapshotRef: string;
  /** `(runId, evaluationSeq)` — the persisted decision's key (§10.3). */
  readonly runId: string;
  readonly evaluationSeq: number;
  /** The §7.7 intent the decision emitted. */
  readonly intentId: string;
  /** The approved-intent record `packages/risk` issued. */
  readonly approvedIntentId: string;
  /** The immutable plan `packages/execution-planner` sealed. */
  readonly executionPlanId: string;
  /** The submission attempt: one venue submit of one plan. */
  readonly submissionAttemptId: string;
  /** The order the venue booked. */
  readonly venueOrderId: string;
  /** The fill the venue produced. */
  readonly venueFillId: string;
  /** The ledger's own fill identity, which the postings carry. */
  readonly ledgerFillId: string;
  /** The transactions this fill produced, in append order. */
  readonly ledgerTransactionIds: readonly string[];
}

/**
 * A deterministic UUIDv7-shaped identifier factory.
 *
 * Not a real UUIDv7 — it encodes no timestamp and no entropy, and it says so.
 * What it IS: a value satisfying the canonical lowercase v7 grammar the domain
 * and `packages/ledger` schemas require (version nibble `7`, variant nibble in
 * `[89ab]`), derived purely from a run-scoped namespace and an ordinal.
 *
 * The alternative — `crypto.randomUUID()` — would be a real UUIDv7 and would
 * break §12.4 byte-determinism on every ledger event and PnL row. Determinism
 * is the property this repository tests; cryptographic uniqueness of an
 * in-process ordinal is not.
 */
export class DeterministicIdFactory {
  readonly #prefix: string;
  #ordinal = 0;

  /**
   * @param namespace a run-scoped seed. Two runs with the same namespace mint
   *   the same ids, which is exactly what a golden replay comparison needs.
   */
  constructor(namespace: string) {
    // A 12-hex-digit fold of the namespace: enough to separate concurrent runs
    // in one process, and fully determined by the namespace.
    let hash = 0x811c9dc5;
    for (let index = 0; index < namespace.length; index += 1) {
      hash ^= namespace.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const folded = hash.toString(16).padStart(8, "0");
    this.#prefix = `${folded}${folded.slice(0, 4)}`;
  }

  /**
   * The next id. Shape: `xxxxxxxx-xxxx-7ooo-8ooo-oooooooooooo`, where `o` is
   * the ordinal in hex.
   */
  next(): string {
    this.#ordinal += 1;
    const ordinal = this.#ordinal.toString(16).padStart(15, "0");
    return (
      `${this.#prefix.slice(0, 8)}-${this.#prefix.slice(8, 12)}-` +
      `7${ordinal.slice(0, 3)}-8${ordinal.slice(3, 6)}-${ordinal.slice(6, 15)}000`
    );
  }
}

/** One instance's claim on a fill, as the loop knows it. */
export interface FillClaim {
  readonly instanceId: string;
  readonly runId: string;
  readonly shares: string;
  readonly feeAmount?: string;
}

export interface PostingIdentity {
  readonly environment: Extract<RunMode, "BACKTEST" | "PAPER" | "SHADOW">;
  readonly accountRef: string;
  readonly denominationAssetId: string;
  readonly venueClearingRef: string;
  readonly attributionClearingRef: string;
  readonly feeExpenseRef: string;
}

export type PostFillOutcome =
  | {
      readonly ok: true;
      readonly ledger: Ledger;
      readonly allocation: FillAllocationResult;
      readonly appended: readonly AppendedLedgerTransaction[];
      readonly pnlRecords: readonly (PnlTradeRecord | PnlFeeRecord)[];
      readonly ledgerFillId: string;
      readonly ledgerTransactionIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stage: "ALLOCATE" | "BUILD_POSTING" | "APPEND";
      readonly code: string;
      readonly detail: string;
      readonly issues: readonly string[];
    };

/**
 * Books one simulated fill into the ledger and produces its PnL records.
 *
 * TOTAL: every failure is data, and the STAGE is named, because the three fail
 * for different reasons and an operator repairing one needs to know which. A
 * failure at any stage means the fill is NOT booked — the ledger is append-only
 * (ADR-006 §1), so a half-posted fill could only be corrected by a compensating
 * reversal, and the loop's response is a `LEDGER_POSTING_REFUSED` halt rather
 * than a partial append.
 */
export function postFill(input: {
  readonly ledger: Ledger;
  readonly fill: SimulatedFill;
  readonly claims: readonly FillClaim[];
  readonly identity: PostingIdentity;
  readonly ids: DeterministicIdFactory;
  /** The outcome-token asset id (ADR-006: a token IS an asset). */
  readonly tokenAssetId: string;
  readonly feeScheduleVersionRef?: string;
}): PostFillOutcome {
  const ledgerFillId = input.ids.next();
  const fact = toFillFact(input.fill, {
    fillId: ledgerFillId,
    environment: input.identity.environment,
    accountRef: input.identity.accountRef,
    tokenAssetId: input.tokenAssetId,
    denominationAssetId: input.identity.denominationAssetId,
    // §7.1's source vocabulary. A simulated fill did not come from a venue
    // socket; it came from this process, so `internal` is the honest value.
    source: "internal",
    ...(input.feeScheduleVersionRef === undefined
      ? {}
      : { feeScheduleVersionRef: input.feeScheduleVersionRef }),
  });

  const allocated = allocateFill(
    fact,
    input.claims.map((claim) => ({
      instanceId: claim.instanceId,
      runId: claim.runId,
      shares: claim.shares,
      ...(claim.feeAmount === undefined ? {} : { feeAmount: claim.feeAmount }),
    })),
  );
  if (!allocated.ok) {
    return failure("ALLOCATE", allocated.refusals);
  }

  const principalTransactionId = input.ids.next();
  const tokenTransactionId = input.ids.next();
  const feeTransactionId = input.ids.next();
  const posting = buildFillPosting(
    allocated.value,
    {
      venueClearingRef: input.identity.venueClearingRef,
      attributionClearingRef: input.identity.attributionClearingRef,
      feeExpenseRef: input.identity.feeExpenseRef,
    },
    { principalTransactionId, tokenTransactionId, feeTransactionId },
  );
  if (!posting.ok) {
    return failure("BUILD_POSTING", posting.refusals);
  }

  let ledger = input.ledger;
  const appended: AppendedLedgerTransaction[] = [];
  const transactionIds: string[] = [];
  for (const transaction of posting.value.transactions) {
    const result = ledger.append(transaction as LedgerTransactionInput);
    if (!result.ok) {
      return failure("APPEND", result.refusals);
    }
    ledger = result.value.ledger;
    appended.push(result.value.appended);
    transactionIds.push(result.value.appended.transaction.ledgerTransactionId);
  }

  return {
    ok: true,
    ledger,
    allocation: allocated.value,
    appended: Object.freeze(appended),
    pnlRecords: posting.value.pnlRecords,
    ledgerFillId,
    ledgerTransactionIds: Object.freeze(transactionIds),
  };
}

/**
 * Flattens a `packages/ledger` refusal list into this module's outcome.
 *
 * The FIRST refusal names the outcome's `code` and `detail`; every refusal,
 * including that one, is preserved in `issues`. A refusal list collapsed to its
 * head would lose the very detail an operator repairing a posting needs.
 */
function failure(
  stage: "ALLOCATE" | "BUILD_POSTING" | "APPEND",
  refusals: readonly LedgerRefusal[],
): PostFillOutcome {
  const head = refusals[0];
  return {
    ok: false,
    stage,
    code: head?.code ?? "LEDGER_INPUT_INVALID",
    detail: head?.message ?? "the ledger refused without stating a reason",
    issues: Object.freeze(
      refusals.flatMap((refusal) => [
        `${refusal.code}: ${refusal.message}`,
        ...readIssues(refusal.details),
      ]),
    ),
  };
}

function readIssues(details: unknown): readonly string[] {
  if (typeof details !== "object" || details === null) return [];
  if (!Object.hasOwn(details, "issues")) return [];
  const issues = (details as Record<string, unknown>)["issues"];
  return Array.isArray(issues) ? issues.map((issue) => String(issue)) : [];
}

/** The §6 invariant 8 projection, folded from the append-only ledger. */
export function projectionOf(ledger: Ledger): LedgerProjection {
  return projectLedger(ledger);
}
