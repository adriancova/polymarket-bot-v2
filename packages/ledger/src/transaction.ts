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
import { z } from "zod";

import type { LedgerRefusal, LedgerResult } from "./refusals.js";
import { ledgerFailure, ledgerOk, ledgerRefusal } from "./refusals.js";
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

/** ADR-016 pre-check: refuse a UUID-shaped, non-canonical id with the raw value. */
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
 */
export function validateTransactionInput(
  input: unknown,
): LedgerResult<LedgerTransactionInput> {
  const uuidRefusals = collectUuidRefusals(input);
  if (uuidRefusals.length > 0) {
    return ledgerFailure(...uuidRefusals);
  }

  const parsed = LedgerTransactionInputSchema.safeParse(input);
  if (!parsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a ledger transaction", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  const transaction: LedgerTransactionInput = parsed.data;
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

function deepFreezeTransaction(transaction: LedgerTransactionInput): LedgerTransactionInput {
  for (const entry of transaction.entries) {
    Object.freeze(entry);
  }
  Object.freeze(transaction.entries);
  return Object.freeze(transaction);
}
