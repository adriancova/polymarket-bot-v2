/**
 * Settlement evidence: the boundary that makes "only an OBSERVED payout
 * realizes a reward" (ADR-006 §6, §9.16) a checked fact rather than a claim.
 *
 * THE DEFECT THIS CLOSES (review round 1, MEDIUM). A `REWARD_PAYOUT` record
 * carried a `ledgerTransactionId`, and the engine checked only that the string
 * was a canonical UUIDv7. Nothing verified that the transaction existed, that
 * it booked a reward, that it booked THIS reward, or that it credited THIS
 * owner — so a caller could mint a UUID and realize any amount. The estimate
 * path was airtight and the payout path, which is the one that moves money,
 * was a naming convention.
 *
 * THE BOUNDARY. A payout now realizes only against a `PnlSettlementEvidence`
 * value, and that value can be built ONLY by `PnlSettlementEvidence.from(...)`
 * from whole booked ledger transactions — the composition root hands over the
 * transactions it appended, not their ids. The engine then requires, for the
 * named transaction:
 *
 *  1. the event type §9.15 gives that reward program (`MAKER_REBATE_PAYOUT`,
 *     `TAKER_REBATE_PAYOUT`, `LIQUIDITY_REWARD`) — a trade posting cannot pass
 *     as a reward;
 *  2. the same `environment` as the stream — a LIVE booking can never realize
 *     into a PAPER stream, or the reverse (§10.8 separation);
 *  3. a settlement state that is absent or `CONFIRMED` — a `FAILED`,
 *     `RETRYING`, or merely `MATCHED` booking is not an observed payout
 *     (ADR-006 §5, venue report §4);
 *  4. `REWARD_INCOME` entries in the claimed denomination summing to exactly
 *     the negation of the claimed amount — ADR-006 §6: "only an observed
 *     payout creates a `REWARD_INCOME` entry", and the income account is the
 *     counter-side, so value leaving it is the value arriving in the wallet
 *     (the `FEE_EXPENSE` convention, mirrored);
 *  5. entries crediting the OWNER's own bucket — its scope, its account, and
 *     its instance — by exactly the claimed amount, so one instance's payout
 *     cannot be realized into another's stream, or into another account's.
 *
 * AND THE EVIDENCE STAYS THE EVIDENCE (review round 2, HIGH-3). Round 1 froze
 * the transaction object only, leaving its legs writable and handing the
 * internal value out of `find()`, so a genuine 5 pUSD booking could be edited
 * into a 999 pUSD booking AFTER it passed all six checks. Every booking is now
 * sealed leg by leg on the way in, copied and sealed again on the way out, and
 * the verification reads a value no caller has ever held. A boundary that
 * checks a document and then lets the document be rewritten is not a boundary.
 *
 * WHAT IT DOES NOT CLAIM. This package cannot verify that the supplied
 * transactions were really appended to a real ledger — it is layer 1 and owns
 * no connection, and no `docs/contracts/dependency-direction.md` §2.1 row
 * permits an edge to `@polymarket-bot/ledger`. What it guarantees is that a
 * reward cannot be realized from an identifier alone: the caller must produce
 * a complete, balanced, correctly-scoped booking, which is an act the ledger
 * and the database record. The remaining trust is in the composition root
 * that reads the ledger, and it is stated here rather than implied.
 *
 * STRUCTURAL CONTRACT. The evidence schemas mirror
 * `@polymarket-bot/ledger`'s transaction and entry shapes field for field.
 * There is deliberately no package edge; the agreement is pinned by the
 * cross-package suite in `test/unit/ledger/`, which parses real
 * `buildFillPosting` output and a real appended reward posting under these
 * schemas and would fail if either side drifted.
 *
 * AND THE DOCUMENT MUST BE A DOCUMENT (`WP-200-FU1`, 2026-09-04). Round 2
 * closed "the evidence stays the evidence"; this closes "the evidence says only
 * what its author wrote". Measured at `main` `761db76`, before this change:
 *
 * ```text
 * a booking with no own `environment`, clean         → PNL_INPUT_INVALID
 * the same, one NON-ENUMERABLE Object.prototype.environment = "PAPER"
 *                                                    → ACCEPTED into the set
 * ```
 *
 * The environment is check 2 of the six above — the §10.8 rule that a LIVE
 * booking can never realize into a PAPER stream — and it was satisfiable
 * without the booking naming an environment at all. `from()` now performs
 * D1-D4.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, isZeroDecimal, negateDecimal, subDecimal } from "@polymarket-bot/decimal";
import {
  DecimalStringSchema,
  DetailStringSchema,
  EventSourceSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  RunModeSchema,
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import { z } from "zod";

import { plainFrozen } from "./immutable.js";
import type { PnlOwner } from "./records.js";
import type { PnlRefusal, PnlResult } from "./refusals.js";
import {
  PnlConfigurationError,
  contained,
  pnlFailure,
  pnlOk,
  pnlRefusal,
  readInputAsData,
} from "./refusals.js";

const ZERO: DecimalString = "0";

/**
 * The six §9.15 scopes, re-declared here because layer 1 cannot import the
 * ledger package. Pinned token-for-token against
 * `@polymarket-bot/ledger`'s `LEDGER_SCOPES` by the cross-package suite.
 */
export const PNL_EVIDENCE_SCOPES = [
  "ACTUAL_ACCOUNT",
  "VIRTUAL_STRATEGY",
  "UNATTRIBUTED",
  "EXTERNAL_CLEARING",
  "FEE_EXPENSE",
  "REWARD_INCOME",
] as const;

/** ADR-006 §7: an asset always declares its kind; there is no implicit cash. */
export const PNL_EVIDENCE_ASSET_KINDS = ["COLLATERAL", "OUTCOME_TOKEN"] as const;

/**
 * The §9.15 event that books each ADR-006 §6 incentive program's payout.
 * Pinned against the ledger's event vocabulary by the cross-package suite.
 */
export const PNL_REWARD_LEDGER_EVENTS = Object.freeze({
  MAKER_REBATE: "MAKER_REBATE_PAYOUT",
  TAKER_REBATE: "TAKER_REBATE_PAYOUT",
  LIQUIDITY_REWARD: "LIQUIDITY_REWARD",
} as const);

/**
 * The only settlement state that is an observed, final payout (venue report
 * §4: `CONFIRMED` is the terminal success). Absent is permitted — a reward
 * booking is not a trade settlement and `settlement_state` is nullable in
 * `accounting.ledger_transactions` — but a stated non-terminal or failed
 * state is refused rather than treated as good enough.
 */
const SETTLED_STATE = "CONFIRMED";

/** One leg of a booked transaction (mirrors the ledger's entry shape). */
export const PnlEvidenceEntrySchema = z.strictObject({
  scope: z.enum(PNL_EVIDENCE_SCOPES),
  accountRef: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  assetKind: z.enum(PNL_EVIDENCE_ASSET_KINDS),
  amount: DecimalStringSchema,
  instanceId: Uuidv7Schema.optional(),
  runId: Uuidv7Schema.optional(),
  marketId: Uuidv7Schema.optional(),
  detail: DetailStringSchema.optional(),
});

export type PnlEvidenceEntry = Readonly<z.infer<typeof PnlEvidenceEntrySchema>>;

/**
 * A booked ledger transaction, as evidence (mirrors the ledger's transaction
 * shape field for field).
 *
 * `eventType` and `settlementState` are validated as identifiers rather than
 * as enums: this package must not own the §9.15 event vocabulary, and the
 * only tokens it needs to RECOGNIZE are the three reward events above.
 */
export const PnlEvidenceTransactionSchema = z.strictObject({
  ledgerTransactionId: Uuidv7Schema,
  eventType: NonEmptyStringSchema,
  environment: RunModeSchema,
  accountRef: NonEmptyStringSchema,
  source: EventSourceSchema,
  occurredAt: IsoTimestampSchema,
  entries: z.array(PnlEvidenceEntrySchema),
  marketId: Uuidv7Schema.optional(),
  orderId: Uuidv7Schema.optional(),
  fillId: Uuidv7Schema.optional(),
  walletOperationId: Uuidv7Schema.optional(),
  reconciliationRunId: Uuidv7Schema.optional(),
  settlementState: NonEmptyStringSchema.optional(),
  reversesLedgerTransactionId: Uuidv7Schema.optional(),
  referenceHash: NonEmptyStringSchema.optional(),
  detail: DetailStringSchema.optional(),
});

export type PnlEvidenceTransaction = Readonly<
  Omit<z.infer<typeof PnlEvidenceTransactionSchema>, "entries">
> & { readonly entries: readonly PnlEvidenceEntry[] };

/**
 * **D2** — the evidence schema's parsing copy, built and WARMED at module load
 * (`@polymarket-bot/risk/schema-arena`, §2.1 **S6**). Its ANSWER is used; its
 * OUTPUT is discarded (**D3**).
 */
const PnlEvidenceTransactionDoor = prototypeFreeParser(PnlEvidenceTransactionSchema);

/** Only `from()` may construct evidence; a forged instance is not accepted. */
const CONSTRUCTION_TOKEN: unique symbol = Symbol("polymarket-bot/pnl/settlement-evidence");

/**
 * A private, deeply frozen COPY of a booked transaction.
 *
 * THE DEFECT THIS CLOSES (review round 2, HIGH-3). `from()` froze the
 * transaction OBJECT and nothing else, so its `entries` array and every entry
 * in it stayed writable — and `find()` handed the internal transaction out. A
 * caller could therefore build evidence from a genuine 5 pUSD booking,
 * afterwards edit the `REWARD_INCOME` leg from `−5` to `−999` and the owner's
 * leg from `+5` to `+999` by ordinary property assignment, and realize a 999
 * pUSD payout. Validating a value and then handing out a mutable reference to
 * it validates nothing: the check ran on a document that no longer exists.
 *
 * So every transaction is copied leg by leg and frozen at every level on the
 * way IN, and copied and frozen again on the way OUT, so the set never shares
 * an object with anyone. Two copies rather than one because the internal copy
 * is what the verification reads (through {@link SEALED_BOOKINGS}): even if a
 * future edit made the outbound copy shallow again, the evidence the check runs
 * against would still be untouched.
 */
function sealedTransaction(transaction: PnlEvidenceTransaction): PnlEvidenceTransaction {
  // D4 (`WP-200-FU1`): the sealed copy has NO PROTOTYPE at either level. The
  // checks below read OPTIONAL fields off it — `booked.settlementState`,
  // `entry.instanceId` — and on an ordinary object those reads are answered by
  // `Object.prototype`: an inherited `instanceId` would make a leg "credit the
  // owner" of a stream whose instance the booking never named.
  const entries = transaction.entries.map((entry) => plainFrozen({ ...entry }));
  return plainFrozen({ ...transaction, entries: Object.freeze(entries) });
}

/**
 * Module-private access to each evidence set's sealed bookings.
 *
 * `verifyRewardPayoutEvidence` reads THIS, not `evidence.find(...)`: a method
 * call dispatches through `PnlSettlementEvidence.prototype`, and a prototype is
 * a mutable object in JavaScript, so a caller could have replaced `find` with
 * one that returns whatever it likes. A `WeakMap` populated by the constructor
 * cannot be reached from outside this module and holds nothing alive.
 */
const SEALED_BOOKINGS = new WeakMap<
  PnlSettlementEvidence,
  ReadonlyMap<string, PnlEvidenceTransaction>
>();

/**
 * The booked transactions a fold may realize payouts against.
 *
 * DEEPLY immutable, and constructible ONLY through
 * {@link PnlSettlementEvidence.from}, which validates every transaction and
 * seals it leg by leg. An identifier is not evidence; this value is — and,
 * since review round 2, it is evidence that still says what it said when it was
 * checked (see {@link sealedTransaction}).
 */
export class PnlSettlementEvidence {
  readonly #transactions: ReadonlyMap<string, PnlEvidenceTransaction>;

  private constructor(
    token: symbol,
    transactions: ReadonlyMap<string, PnlEvidenceTransaction>,
  ) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new PnlConfigurationError(
        "settlement evidence is built by PnlSettlementEvidence.from(bookedTransactions), " +
          "never constructed directly",
      );
    }
    this.#transactions = transactions;
    SEALED_BOOKINGS.set(this, transactions);
    Object.freeze(this);
  }

  /**
   * Validates booked ledger transactions into an evidence set. Every supplied
   * value must be a whole transaction; a duplicate id is refused, because two
   * different bookings claiming one id make "the transaction that booked it"
   * ambiguous.
   */
  static from(transactions: readonly unknown[]): PnlResult<PnlSettlementEvidence> {
    return contained(() => PnlSettlementEvidence.fromMaterialized(transactions));
  }

  private static fromMaterialized(
    transactions: readonly unknown[],
  ): PnlResult<PnlSettlementEvidence> {
    const byId = new Map<string, PnlEvidenceTransaction>();
    const refusals: PnlRefusal[] = [];
    transactions.forEach((candidate, index) => {
      // D1.
      const read = readInputAsData(
        candidate,
        `evidence[${index}]`,
        `booked ledger transaction ${index}`,
      );
      if (!read.ok) {
        refusals.push(
          pnlRefusal(
            "PNL_INPUT_INVALID",
            `settlement evidence ${index} is not a booked ledger transaction`,
            { index, issues: read.refusal.details["issues"] ?? [] },
          ),
        );
        return;
      }
      // D2.
      const parsed = PnlEvidenceTransactionDoor.safeParse(read.value);
      if (!parsed.success) {
        refusals.push(
          pnlRefusal(
            "PNL_INPUT_INVALID",
            `settlement evidence ${index} is not a booked ledger transaction`,
            {
              index,
              issues: parsed.error.issues.map((issue) => {
                const path = issue.path.map((segment) => String(segment)).join(".");
                return `${path === "" ? "(root)" : path}: ${issue.message}`;
              }),
            },
          ),
        );
        return;
      }
      // D3 — the booking IS the materialized tree.
      const transaction = read.value as PnlEvidenceTransaction;
      if (byId.has(transaction.ledgerTransactionId)) {
        refusals.push(
          pnlRefusal(
            "PNL_INPUT_INVALID",
            `settlement evidence ${index} repeats ledger transaction ` +
              `${transaction.ledgerTransactionId}; one id is one booking`,
            { index, ledgerTransactionId: transaction.ledgerTransactionId },
          ),
        );
        return;
      }
      byId.set(transaction.ledgerTransactionId, sealedTransaction(transaction));
    });
    if (refusals.length > 0) {
      return pnlFailure(...refusals);
    }
    return pnlOk(new PnlSettlementEvidence(CONSTRUCTION_TOKEN, byId));
  }

  /**
   * A deeply frozen COPY of the booked transaction with this id, if this
   * evidence set holds one.
   *
   * A copy, not the internal value: nothing outside this class ever holds a
   * reference to the evidence the verification reads (review round 2, HIGH-3).
   * The copy is itself frozen at every level, so a caller cannot edit what it
   * was handed either — the mutation fails loudly instead of producing a
   * document that disagrees with the one that was checked.
   */
  find(ledgerTransactionId: string): PnlEvidenceTransaction | undefined {
    const booked = this.#transactions.get(ledgerTransactionId);
    return booked === undefined ? undefined : sealedTransaction(booked);
  }


  /** How many bookings this evidence set carries. */
  get size(): number {
    return this.#transactions.size;
  }
}

/** What a payout claims, reduced to the fields the evidence must support. */
export interface RewardPayoutClaim {
  readonly ref: string;
  readonly ledgerTransactionId: string;
  readonly programType: keyof typeof PNL_REWARD_LEDGER_EVENTS;
  readonly amount: DecimalString;
  readonly denominationAsset: string;
}

function sumEntries(
  transaction: PnlEvidenceTransaction,
  keep: (entry: PnlEvidenceEntry) => boolean,
): DecimalString {
  return transaction.entries.reduce<DecimalString>(
    (sum, entry) => (keep(entry) ? addDecimal(sum, entry.amount) : sum),
    ZERO,
  );
}

function creditsOwner(entry: PnlEvidenceEntry, owner: PnlOwner): boolean {
  if (entry.scope !== owner.scope || entry.accountRef !== owner.accountRef) {
    return false;
  }
  return owner.scope !== "VIRTUAL_STRATEGY" || entry.instanceId === owner.instanceId;
}

/**
 * Proves a reward payout against the supplied evidence, or returns EVERY
 * reason it is not proven. An empty list means the payout is settlement-grade.
 */
export function verifyRewardPayoutEvidence(
  claim: RewardPayoutClaim,
  owner: PnlOwner,
  environment: string,
  evidence: PnlSettlementEvidence | undefined,
): readonly PnlRefusal[] {
  // `instanceof`, not a duck-typed `find`: the TypeScript type is already
  // closed by the class's private field, and this closes the JavaScript path
  // as well, so a hand-made object shaped like evidence proves nothing.
  if (!(evidence instanceof PnlSettlementEvidence)) {
    return [
      pnlRefusal(
        "PNL_REWARD_EVIDENCE_MISSING",
        `reward payout ${claim.ref} names ledger transaction ${claim.ledgerTransactionId}, ` +
          "but no settlement evidence built by PnlSettlementEvidence.from(...) was " +
          "supplied; an identifier is not an observed payout (ADR-006 §6)",
        { ref: claim.ref, ledgerTransactionId: claim.ledgerTransactionId },
      ),
    ];
  }
  const booked = SEALED_BOOKINGS.get(evidence)?.get(claim.ledgerTransactionId);
  if (booked === undefined) {
    return [
      pnlRefusal(
        "PNL_REWARD_EVIDENCE_UNKNOWN",
        `reward payout ${claim.ref} names ledger transaction ${claim.ledgerTransactionId}, ` +
          "which the supplied evidence does not contain; a reward is realized only against " +
          "the transaction that booked it",
        { ref: claim.ref, ledgerTransactionId: claim.ledgerTransactionId },
      ),
    ];
  }

  const refusals: PnlRefusal[] = [];
  const mismatch = (message: string, details: Readonly<Record<string, unknown>>): void => {
    refusals.push(
      pnlRefusal("PNL_REWARD_EVIDENCE_MISMATCH", message, {
        ref: claim.ref,
        ledgerTransactionId: claim.ledgerTransactionId,
        ...details,
      }),
    );
  };

  const expectedEvent = PNL_REWARD_LEDGER_EVENTS[claim.programType];
  if (booked.eventType !== expectedEvent) {
    mismatch(
      `reward payout ${claim.ref} claims program ${claim.programType}, whose payout books as ` +
        `${expectedEvent}; the named transaction is a ${booked.eventType}`,
      { programType: claim.programType, expectedEventType: expectedEvent, eventType: booked.eventType },
    );
  }
  if (booked.environment !== environment) {
    mismatch(
      `reward payout ${claim.ref} realizes into a ${environment} stream but the named ` +
        `transaction was booked in ${booked.environment} (§10.8 separation)`,
      { streamEnvironment: environment, evidenceEnvironment: booked.environment },
    );
  }
  if (booked.settlementState !== undefined && booked.settlementState !== SETTLED_STATE) {
    mismatch(
      `reward payout ${claim.ref} names a transaction whose settlement state is ` +
        `${booked.settlementState}; only ${SETTLED_STATE} is an observed payout`,
      { settlementState: booked.settlementState },
    );
  }

  const income = sumEntries(
    booked,
    (entry) => entry.scope === "REWARD_INCOME" && entry.assetId === claim.denominationAsset,
  );
  const expectedIncome = negateDecimal(claim.amount);
  if (!isZeroDecimal(subDecimal(income, expectedIncome))) {
    mismatch(
      `reward payout ${claim.ref} claims ${claim.amount} ${claim.denominationAsset}, but the ` +
        `named transaction books ${income} of REWARD_INCOME in that asset (expected ` +
        `${expectedIncome}; ADR-006 §6: only an observed payout creates a REWARD_INCOME entry)`,
      {
        denominationAsset: claim.denominationAsset,
        claimedAmount: claim.amount,
        rewardIncome: income,
        expectedRewardIncome: expectedIncome,
      },
    );
  }

  const credited = sumEntries(
    booked,
    (entry) => entry.assetId === claim.denominationAsset && creditsOwner(entry, owner),
  );
  if (!isZeroDecimal(subDecimal(credited, claim.amount))) {
    mismatch(
      `reward payout ${claim.ref} realizes ${claim.amount} ${claim.denominationAsset} for ` +
        `${owner.scope} ${owner.accountRef}, but the named transaction credits that owner ` +
        `${credited} in that asset`,
      {
        owner,
        denominationAsset: claim.denominationAsset,
        claimedAmount: claim.amount,
        creditedToOwner: credited,
      },
    );
  }

  return refusals;
}
