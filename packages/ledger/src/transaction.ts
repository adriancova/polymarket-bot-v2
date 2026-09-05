/**
 * Ledger transaction and entry input shapes (§9.15, §10.5, ADR-006).
 *
 * PERSISTENCE BOUNDARY (recorded WP-200 decision): this package owns the RULE
 * — what a legal transaction is — and the typed records; it owns no
 * connection. The record fields mirror the WP-040 `accounting` schema
 * (`ledger_transactions` / `ledger_entries`) field-for-field in camelCase so
 * the composition root binds an `AppendedLedgerTransaction` to those tables
 * with no mapping layer. §10 is the tables' shape authority; this module does
 * not restate their SQL constraints — it enforces the same invariants in pure
 * code so a violation is refused BEFORE anything reaches a database.
 *
 * Identifiers are caller-supplied: a pure layer-1 package reads no clock and
 * no randomness, so it cannot mint UUIDv7 values. It validates them instead —
 * lowercase canonical only, refusal carrying the raw value (ADR-016 §2).
 *
 * THE DOOR (ADR-020 §3, `docs/contracts/schema-boundary.md` §1 D1-D4;
 * `WP-200-FU1`, 2026-09-04). {@link validateTransactionInput} is the package's
 * primary caller boundary and it performs all four steps — see the function's
 * own comment for which line does which, and for the two transcripts of what
 * this door accepted before the change.
 */

import { isZeroDecimal } from "@polymarket-bot/decimal";
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

import type { LedgerRefusal, LedgerResult } from "./refusals.js";
import {
  contained,
  ledgerFailure,
  ledgerOk,
  ledgerRefusal,
  readInputAsData,
} from "./refusals.js";
import {
  AssetKindSchema,
  LedgerEventTypeSchema,
  LedgerScopeSchema,
  TradeSettlementStateSchema,
} from "./vocabulary.js";

/** SHA-256 hex reference, lowercase (matches the WP-040 `sha256_hex` domain). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u, {
  message: "must be 64 lowercase hexadecimal characters",
});

/**
 * One leg of a balanced transaction.
 *
 * The entry's `accountRef` is the account the value actually moved in, and it
 * need not be the transaction header's: a transfer is one transaction whose
 * header names the initiating account and whose legs name one account each.
 * Positions, net movements, and balances read the LEG accounts (the WP-040
 * `netByAsset` precedent).
 */
export const LedgerEntryInputSchema = z.strictObject({
  scope: LedgerScopeSchema,
  accountRef: NonEmptyStringSchema,
  /** ADR-006 §7 rule 1: every entry carries an explicit asset identifier. */
  assetId: NonEmptyStringSchema,
  assetKind: AssetKindSchema,
  /** Signed canonical decimal string; a balanced transaction has both sides. */
  amount: DecimalStringSchema,
  instanceId: Uuidv7Schema.optional(),
  runId: Uuidv7Schema.optional(),
  marketId: Uuidv7Schema.optional(),
  detail: DetailStringSchema.optional(),
});

export type LedgerEntryInput = Readonly<z.infer<typeof LedgerEntryInputSchema>>;

/** Everything a ledger transaction carries regardless of what it books. */
export const LedgerTransactionInputSchema = z.strictObject({
  /** Caller-minted UUIDv7 (this package reads no randomness). */
  ledgerTransactionId: Uuidv7Schema,
  eventType: LedgerEventTypeSchema,
  environment: RunModeSchema,
  /** The initiating account (header); legs carry their own accounts. */
  accountRef: NonEmptyStringSchema,
  source: EventSourceSchema,
  occurredAt: IsoTimestampSchema,
  entries: z.array(LedgerEntryInputSchema),
  marketId: Uuidv7Schema.optional(),
  orderId: Uuidv7Schema.optional(),
  fillId: Uuidv7Schema.optional(),
  walletOperationId: Uuidv7Schema.optional(),
  reconciliationRunId: Uuidv7Schema.optional(),
  settlementState: TradeSettlementStateSchema.optional(),
  /** ADR-006 §5.2: a failure is a compensating reversal, never an edit. */
  reversesLedgerTransactionId: Uuidv7Schema.optional(),
  referenceHash: Sha256HexSchema.optional(),
  detail: DetailStringSchema.optional(),
});

export type LedgerTransactionInput = Readonly<
  Omit<z.infer<typeof LedgerTransactionInputSchema>, "entries">
> & {
  readonly entries: readonly LedgerEntryInput[];
};

/**
 * **D2** — the door's PARSING COPY of {@link LedgerTransactionInputSchema},
 * built and WARMED at module load.
 *
 * Same validation, node for node (`@polymarket-bot/risk/schema-arena`), with
 * every `_zod` container severed from `Object.prototype` and every lazy
 * structure forced while the process is still clean. That closes three
 * measured classes at once on this schema: an inherited `skipChecks` can no
 * longer turn `Uuidv7Schema`'s and `IsoTimestampSchema`'s format checks into
 * no-ops, an inherited `optin`/`optout` pair can no longer waive a required
 * key, and an enumerable inherited property during a cold first parse can no
 * longer abort — and permanently poison — the lazy build.
 *
 * Its ANSWER is used; its OUTPUT is discarded (**D3**).
 */
const LedgerTransactionInputDoor = prototypeFreeParser(LedgerTransactionInputSchema);

/**
 * A transaction as appended: the validated input, deep-frozen, plus its
 * position in the ledger. `sequence` is the ledger's own append ordinal
 * (0-based); it is derived state, assigned by `Ledger.append`, and exists so
 * projections and serializations are reproducible without trusting caller
 * timestamps for ordering (§8.4: replay follows recorded order).
 */
export interface AppendedLedgerTransaction {
  readonly sequence: number;
  readonly transaction: LedgerTransactionInput;
}

/**
 * The UUID grammar, case-insensitively: used ONLY to distinguish "UUID-shaped
 * but non-canonical" (ADR-016 refusal carrying the raw value) from "not a
 * UUID at all" (plain schema failure). Never used to accept anything.
 */
const UUID_SHAPED_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

const CANONICAL_UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const UUID_FIELDS = [
  "ledgerTransactionId",
  "marketId",
  "orderId",
  "fillId",
  "walletOperationId",
  "reconciliationRunId",
  "reversesLedgerTransactionId",
] as const;

const ENTRY_UUID_FIELDS = ["instanceId", "runId", "marketId"] as const;

function uuidRefusal(field: string, raw: string): LedgerRefusal {
  return ledgerRefusal(
    "LEDGER_UUID_NOT_CANONICAL",
    `${field} is UUID-shaped but not the canonical lowercase UUIDv7 spelling; ` +
      "refused, not normalized (ADR-016 §2)",
    { field, raw },
  );
}

/**
 * ADR-016 pre-check: refuse a UUID-shaped, non-canonical id with the raw value.
 *
 * Runs on the MATERIALIZED tree (`WP-200-FU1`), so `record[field]` is an
 * own-property read on an object with no prototype chain: an inherited
 * `marketId` is not seen here any more than it is seen by the schema, and a
 * getter has already been refused by D1 rather than invoked by this walk.
 */
function collectUuidRefusals(value: unknown): readonly LedgerRefusal[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Readonly<Record<string, unknown>>;
  const refusals: LedgerRefusal[] = [];
  const check = (field: string, candidate: unknown): void => {
    if (
      typeof candidate === "string" &&
      UUID_SHAPED_PATTERN.test(candidate) &&
      !CANONICAL_UUID_V7_PATTERN.test(candidate)
    ) {
      refusals.push(uuidRefusal(field, candidate));
    }
  };
  for (const field of UUID_FIELDS) {
    check(field, record[field]);
  }
  const entries = record["entries"];
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      if (typeof entry === "object" && entry !== null) {
        const entryRecord = entry as Readonly<Record<string, unknown>>;
        for (const field of ENTRY_UUID_FIELDS) {
          check(`entries[${index}].${field}`, entryRecord[field]);
        }
      }
    });
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

/**
 * Validates the transaction input shape (schema + per-entry structural rules).
 * Balance, parity, and cross-transaction rules live in `balance.ts` and
 * `ledger.ts`; this function refuses what is wrong about ONE transaction in
 * isolation, before any accounting rule runs.
 *
 * A PROTOTYPE-FREE DOOR (`WP-200-FU1`, 2026-09-04), performing all four steps
 * of `docs/contracts/schema-boundary.md` §1:
 *
 * - **D1** `readInputAsData` materializes the caller's value into a fresh tree
 *   of plain own data with NO PROTOTYPE, reading descriptors rather than
 *   properties;
 * - **D2** the parse goes through {@link LedgerTransactionInputDoor}, the
 *   severed, warmed arena copy;
 * - **D3** every value below comes from the materialized tree, never from
 *   `parsed.data` — the library ANSWERED, it did not supply;
 * - **D4** the returned record is that same prototype-free tree, deep-frozen.
 *
 * WHAT IT ACCEPTED BEFORE, measured at `main` `761db76` (probe P; the
 * transcript is quoted in full in the header of
 * `test/unit/ledger/schema-boundary.test.ts`, which also pins each row as a
 * regression):
 *
 * ```text
 * P1 fillId, no own marketId, clean            → LEDGER_MARKET_REQUIRED  (F16)
 * P2 fillId, no own marketId, NE inherited     → ACCEPTED, marketId adopted
 * P3 "totally-not-a-uuid" / "yesterday-ish"    → LEDGER_INPUT_INVALID
 * P4 the same, NE inherited skipChecks         → ACCEPTED, both kept verbatim
 * ```
 *
 * P2 defeated `WP-040` obligation **F16** — a fill-booking transaction with no
 * market — which this function is the only enforcement of.
 *
 * ORDER IS UNCHANGED except for D1, which is new and runs first: the ADR-016
 * canonicality pre-check still precedes the grammar so a UUID-shaped
 * non-canonical id reports `LEDGER_UUID_NOT_CANONICAL` with its raw value, and
 * the structural rules still run after the grammar. What changed is that the
 * pre-check now reads the MATERIALIZED tree, so it can no longer be handed a
 * getter and can no longer see an inherited value.
 */
export function validateTransactionInput(
  input: unknown,
): LedgerResult<LedgerTransactionInput> {
  return contained(() => validateMaterializedTransaction(input));
}

function validateMaterializedTransaction(
  input: unknown,
): LedgerResult<LedgerTransactionInput> {
  // D1.
  const read = readInputAsData(input, "transaction", "ledger transaction");
  if (!read.ok) {
    return ledgerFailure(read.refusal);
  }
  const materialized = read.value;

  const uuidRefusals = collectUuidRefusals(materialized);
  if (uuidRefusals.length > 0) {
    return ledgerFailure(...uuidRefusals);
  }

  // D2 — the answer is the library's; the output is discarded.
  const parsed = LedgerTransactionInputDoor.safeParse(materialized);
  if (!parsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a ledger transaction", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  // D3 — the validated transaction IS the materialized tree.
  const transaction = materialized as LedgerTransactionInput;
  const refusals: LedgerRefusal[] = [];

  if (transaction.entries.length === 0) {
    refusals.push(
      ledgerRefusal(
        "LEDGER_TRANSACTION_EMPTY",
        "a ledger transaction records at least one balanced pair of entries (§9.15)",
        { ledgerTransactionId: transaction.ledgerTransactionId },
      ),
    );
  }

  if (
    (transaction.fillId !== undefined || transaction.orderId !== undefined) &&
    transaction.marketId === undefined
  ) {
    refusals.push(
      ledgerRefusal(
        "LEDGER_MARKET_REQUIRED",
        "a transaction that books an order or a fill must name its market " +
          "(WP-040 obligation F16; execution facts always have a market)",
        {
          ledgerTransactionId: transaction.ledgerTransactionId,
          orderId: transaction.orderId ?? null,
          fillId: transaction.fillId ?? null,
        },
      ),
    );
  }

  transaction.entries.forEach((entry, index) => {
    if (isZeroDecimal(entry.amount)) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ENTRY_AMOUNT_ZERO",
          "an entry amount of zero moves nothing and records nothing",
          { ledgerTransactionId: transaction.ledgerTransactionId, entryIndex: index },
        ),
      );
    }
    const isVirtual = entry.scope === "VIRTUAL_STRATEGY";
    const hasInstance = entry.instanceId !== undefined;
    if (isVirtual !== hasInstance) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_INSTANCE_SCOPE_MISMATCH",
          isVirtual
            ? "a VIRTUAL_STRATEGY entry must name the instance it attributes to (ADR-006 §2)"
            : `a ${entry.scope} entry must not carry an instanceId; only VIRTUAL_STRATEGY attributes (ADR-006 §2)`,
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            entryIndex: index,
            scope: entry.scope,
            instanceId: entry.instanceId ?? null,
          },
        ),
      );
    }
  });

  // Asset-kind consistency WITHIN the transaction (cross-transaction
  // consistency is the ledger's append-time registry).
  const kinds = new Map<string, { kind: string; entryIndex: number }>();
  transaction.entries.forEach((entry, index) => {
    const seen = kinds.get(entry.assetId);
    if (seen === undefined) {
      kinds.set(entry.assetId, { kind: entry.assetKind, entryIndex: index });
    } else if (seen.kind !== entry.assetKind) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ASSET_KIND_CONFLICT",
          "one asset id was declared with two different asset kinds in one transaction",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            assetId: entry.assetId,
            firstKind: seen.kind,
            firstEntryIndex: seen.entryIndex,
            conflictingKind: entry.assetKind,
            conflictingEntryIndex: index,
          },
        ),
      );
    }
  });

  if (refusals.length > 0) {
    return ledgerFailure(...refusals);
  }
  return ledgerOk(deepFreezeTransaction(transaction));
}

/**
 * **D4** — the emitted record is prototype-free and deep-frozen.
 *
 * The prototype-free half is structural: this is the materialized tree, whose
 * objects were created with `Object.create(null)`, so a later `?? default` read
 * by a consumer cannot be answered from `Object.prototype`. The freeze is the
 * `WP-200` property this function already had and keeps.
 */
function deepFreezeTransaction(transaction: LedgerTransactionInput): LedgerTransactionInput {
  for (const entry of transaction.entries) {
    Object.freeze(entry);
  }
  Object.freeze(transaction.entries);
  return Object.freeze(transaction);
}
