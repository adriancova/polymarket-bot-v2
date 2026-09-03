/**
 * The WP-040 persistence binding, checked instead of claimed (review round 1,
 * HIGH-2).
 *
 * `docs/handoffs/WP-200.md` states that these two layer-1 packages ship
 * records whose fields mirror the `accounting` columns "field-for-field in
 * camelCase, so a composition root binds … with no mapping layer". For the
 * ledger that was true. For PnL it was NOT: `accounting.pnl_snapshots`
 * requires `scope`, `environment`, and a NOT NULL `account_ref`, and keys its
 * rows by `(scope, environment, account_ref, instance_id, market_id, as_of)`,
 * while a `PnlSnapshot` carried an owner (an instance id, with no account) and
 * measures. Three required fields were not derivable from the value, so the
 * claimed binding could not be written at all.
 *
 * This suite makes the claim executable, in two independent ways, because the
 * two catch different drift:
 *
 * 1. AT COMPILE TIME, against `packages/storage-postgres`'s table types: the
 *    binding is written out as a typed object, so a column that gains a
 *    required insert type, changes type, or disappears fails `pnpm typecheck`.
 * 2. AT RUNTIME, against `db/migrations/0006_accounting.up.sql` — the actual
 *    DDL, which is the authority both packages derive from. Every field these
 *    packages emit must be a real column, and every NOT NULL column without a
 *    database default must be emitted by somebody, with the exceptions named
 *    and justified below rather than silently skipped.
 *
 * Nothing here connects to a database: the migration is read as text and the
 * table types are imported as TYPES only (erased at runtime), which is also
 * why this does not create a package edge from layer 1 to layer 2 — the
 * dependency lives in the root test tree, where the cross-package suites live.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LedgerEntryInputSchema,
  LedgerTransactionInputSchema,
  LEDGER_SCOPES,
  LEDGER_EVENT_TYPES,
  ASSET_KINDS,
} from "../../../packages/ledger/src/index.js";
import type { AppendedLedgerTransaction } from "../../../packages/ledger/src/index.js";
import {
  PNL_EVIDENCE_ASSET_KINDS,
  PNL_EVIDENCE_SCOPES,
  PNL_REWARD_LEDGER_EVENTS,
  computePnlSnapshot,
  foldPnlRecords,
  toPnlSnapshotRow,
} from "../../../packages/pnl/src/index.js";
import type { PnlSnapshotRow } from "../../../packages/pnl/src/index.js";
import type {
  AccountingLedgerEntriesTable,
  AccountingLedgerTransactionsTable,
  AccountingPnlSnapshotsTable,
} from "../../../packages/storage-postgres/src/schema/accounting.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The DDL with `--` comments removed FIRST.
 *
 * Not cosmetic: this migration's comments are long prose that contains commas
 * and SQL keywords, and a parser that split on commas before stripping them
 * read "never merged into the core one" as a column. Comments out, then
 * structure.
 */
const MIGRATION = readFileSync(
  join(REPO_ROOT, "db", "migrations", "0006_accounting.up.sql"),
  "utf8",
)
  .split("\n")
  .map((line) => {
    const comment = line.indexOf("--");
    return comment < 0 ? line : line.slice(0, comment);
  })
  .join("\n");

// ---------------------------------------------------------------------------
// The DDL, parsed
// ---------------------------------------------------------------------------

interface Column {
  readonly name: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

const CONSTRAINT_KEYWORDS = new Set([
  "constraint",
  "check",
  "unique",
  "primary",
  "foreign",
  "exclude",
  "like",
]);

/**
 * Columns of one `create table` block.
 *
 * Depth-tracked rather than line-matched: a multi-line CHECK body indents
 * lines that look exactly like column definitions, and counting parentheses is
 * the difference between reading the table and reading a constraint's prose.
 */
function columnsOf(table: string): readonly Column[] {
  const start = MIGRATION.indexOf(`create table ${table} (`);
  if (start < 0) {
    throw new Error(`migration has no create table ${table}`);
  }
  const body = MIGRATION.slice(start);
  const columns: Column[] = [];
  let depth = 0;
  let current = "";
  for (let index = body.indexOf("(") ; index < body.length; index += 1) {
    const character = body[index];
    if (character === undefined) {
      break;
    }
    if (character === "(") {
      depth += 1;
      if (depth === 1) {
        continue;
      }
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    if (character === "," && depth === 1) {
      columns.push(...parseDefinition(current));
      current = "";
      continue;
    }
    current += character;
  }
  columns.push(...parseDefinition(current));
  return columns;
}

function parseDefinition(raw: string): readonly Column[] {
  const stripped = raw.split("\n").join(" ").replace(/\s+/gu, " ").trim();
  if (stripped === "") {
    return [];
  }
  const name = stripped.split(/\s+/u)[0] ?? "";
  if (name === "" || CONSTRAINT_KEYWORDS.has(name.toLowerCase())) {
    return [];
  }
  const lowered = stripped.toLowerCase();
  return [
    {
      name,
      notNull: lowered.includes(" not null"),
      hasDefault: lowered.includes(" default "),
    },
  ];
}

function camelToSnake(field: string): string {
  return field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** Columns a writer MUST supply: NOT NULL and no database default. */
function requiredColumns(table: string): readonly string[] {
  return columnsOf(table)
    .filter((column) => column.notNull && !column.hasDefault)
    .map((column) => column.name)
    .sort();
}

function columnNames(table: string): readonly string[] {
  return columnsOf(table).map((column) => column.name);
}

describe("the migration parses into the columns this suite reasons about", () => {
  it("reads pnl_snapshots without swallowing its constraints", () => {
    const names = columnNames("accounting.pnl_snapshots");
    expect(names).toContain("pnl_snapshot_id");
    expect(names).toContain("worst_case_resolution_pnl");
    expect(names).toContain("rebuilt_at");
    // A constraint body must never be read as a column.
    expect(names).not.toContain("constraint");
    expect(names).not.toContain("scope,");
    expect(names.length).toBe(new Set(names).size);
  });

  it("distinguishes a defaulted NOT NULL column from a required one", () => {
    const required = requiredColumns("accounting.pnl_snapshots");
    expect(required).toContain("as_of");
    expect(required).not.toContain("fees_paid"); // NOT NULL DEFAULT '0'
    expect(required).not.toContain("computed_at"); // DEFAULT now()
    expect(required).not.toContain("rebuilt_at"); // nullable
  });
});

// ---------------------------------------------------------------------------
// pnl_snapshots
// ---------------------------------------------------------------------------

const SNAPSHOT_ROW: PnlSnapshotRow = (() => {
  const folded = foldPnlRecords(
    {
      scope: "VIRTUAL_STRATEGY",
      environment: "PAPER",
      accountRef: "acct-paper-1",
      instanceId: "018f3a5c-2222-7000-8000-00000000000a",
      runId: "018f3a5c-3333-7000-8000-00000000000a",
      marketId: "018f3a5c-1111-7000-8000-000000000001",
    },
    [
      {
        kind: "TRADE",
        ref: "018f3a5c-6666-7000-8000-000000000001",
        owner: {
          scope: "VIRTUAL_STRATEGY",
          accountRef: "acct-paper-1",
          instanceId: "018f3a5c-2222-7000-8000-00000000000a",
        },
        marketId: "018f3a5c-1111-7000-8000-000000000001",
        tokenAssetId: "token-x",
        denominationAsset: "pUSD",
        side: "BUY",
        shares: "10",
        price: "0.4",
      },
    ],
  );
  if (!folded.ok) {
    throw new Error(`fold refused: ${JSON.stringify(folded.refusals)}`);
  }
  const rows = computePnlSnapshot(folded.value, {
    asOf: "2026-09-02T12:00:00.000Z",
    marks: { "token-x": { midpoint: "0.5" } },
  });
  if (!rows.ok) {
    throw new Error(`snapshot refused: ${JSON.stringify(rows.refusals)}`);
  }
  const row = rows.value[0];
  if (row === undefined) {
    throw new Error("no snapshot row");
  }
  return toPnlSnapshotRow(row);
})();

/** Kysely's `ColumnType`, extracted structurally so this file imports no kysely. */
type InsertOf<T> = T extends { readonly __insert__: infer I } ? I : T;
type InsertRow<T> = { [K in keyof T]: InsertOf<T[K]> };

/**
 * THE COMPILE-TIME BINDING. If `accounting.pnl_snapshots` gains a required
 * column, changes a column's type, or loses one this names, `pnpm typecheck`
 * fails here — before any composition root discovers it against a database.
 */
const PNL_SNAPSHOT_INSERT: Omit<
  InsertRow<AccountingPnlSnapshotsTable>,
  "pnl_snapshot_id" | "computed_at" | "rebuilt_at"
> = {
  scope: SNAPSHOT_ROW.scope as InsertRow<AccountingPnlSnapshotsTable>["scope"],
  environment: SNAPSHOT_ROW.environment as InsertRow<AccountingPnlSnapshotsTable>["environment"],
  account_ref: SNAPSHOT_ROW.accountRef,
  instance_id: SNAPSHOT_ROW.instanceId,
  run_id: SNAPSHOT_ROW.runId,
  market_id: SNAPSHOT_ROW.marketId,
  denomination_asset: SNAPSHOT_ROW.denominationAsset,
  gross_trading_pnl: SNAPSHOT_ROW.grossTradingPnl,
  core_net_pnl: SNAPSHOT_ROW.coreNetPnl,
  all_in_pnl: SNAPSHOT_ROW.allInPnl,
  realized_pnl: SNAPSHOT_ROW.realizedPnl,
  unrealized_pnl_midpoint: SNAPSHOT_ROW.unrealizedPnlMidpoint,
  unrealized_pnl_model: SNAPSHOT_ROW.unrealizedPnlModel,
  unrealized_pnl_liquidation: SNAPSHOT_ROW.unrealizedPnlLiquidation,
  worst_case_resolution_pnl: SNAPSHOT_ROW.worstCaseResolutionPnl,
  fees_paid: SNAPSHOT_ROW.feesPaid,
  reward_estimate_total: SNAPSHOT_ROW.rewardEstimateTotal,
  realized_rewards: SNAPSHOT_ROW.realizedRewards,
  capital_committed: SNAPSHOT_ROW.capitalCommitted,
  as_of: SNAPSHOT_ROW.asOf,
};

describe("a PnL snapshot binds to accounting.pnl_snapshots", () => {
  it("produces only columns the table has", () => {
    const columns = new Set(columnNames("accounting.pnl_snapshots"));
    const produced = Object.keys(SNAPSHOT_ROW).map(camelToSnake);
    expect(produced.filter((column) => !columns.has(column))).toEqual([]);
  });

  it("produces EVERY column a writer must supply", () => {
    const produced = new Set(Object.keys(SNAPSHOT_ROW).map(camelToSnake));
    expect(
      requiredColumns("accounting.pnl_snapshots").filter((column) => !produced.has(column)),
    ).toEqual([]);
  });

  it("states every value the identity columns need, with nothing invented", () => {
    // The three that could not be produced before this round.
    expect(SNAPSHOT_ROW.scope).toBe("VIRTUAL_STRATEGY");
    expect(SNAPSHOT_ROW.environment).toBe("PAPER");
    expect(SNAPSHOT_ROW.accountRef).toBe("acct-paper-1");
    // And the rest of the unique key.
    expect(SNAPSHOT_ROW.instanceId).toBe("018f3a5c-2222-7000-8000-00000000000a");
    expect(SNAPSHOT_ROW.marketId).toBe("018f3a5c-1111-7000-8000-000000000001");
    expect(SNAPSHOT_ROW.asOf).toBe("2026-09-02T12:00:00.000Z");
  });

  it("leaves the database's own columns to the database", () => {
    const produced = new Set(Object.keys(SNAPSHOT_ROW).map(camelToSnake));
    for (const column of ["pnl_snapshot_id", "computed_at", "rebuilt_at"]) {
      expect(produced.has(column)).toBe(false);
    }
    // The compile-time binding above omits exactly these three.
    expect(Object.keys(PNL_SNAPSHOT_INSERT).sort()).toEqual(
      columnNames("accounting.pnl_snapshots")
        .filter((column) => !["pnl_snapshot_id", "computed_at", "rebuilt_at"].includes(column))
        .sort(),
    );
  });

  it("passes every measure through as an exact decimal string", () => {
    for (const value of Object.values(SNAPSHOT_ROW)) {
      expect(typeof value === "string" || value === null).toBe(true);
    }
    // Bought 10 @ 0.4, marked 0.5: unrealized 1, capital committed 4.
    expect(SNAPSHOT_ROW.unrealizedPnlMidpoint).toBe("1");
    expect(SNAPSHOT_ROW.capitalCommitted).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// ledger_transactions / ledger_entries — confirmed, and pinned the same way
// ---------------------------------------------------------------------------

/**
 * Columns the ENTRY record cannot carry, with the reason each is the writer's
 * to supply. Named here so "the entry does not produce it" is a decision on
 * the record rather than a gap the test skipped past.
 */
const ENTRY_WRITER_SUPPLIED = [
  // The parent link: the transaction's own id, known to whoever writes both.
  "ledger_transaction_id",
  // The entry's position in the transaction's array, assigned on write.
  "entry_ordinal",
];

describe("a ledger transaction binds to accounting.ledger_transactions", () => {
  const fields = Object.keys(LedgerTransactionInputSchema.shape).filter(
    (field) => field !== "entries",
  );

  it("produces only columns the table has", () => {
    const columns = new Set(columnNames("accounting.ledger_transactions"));
    expect(fields.map(camelToSnake).filter((column) => !columns.has(column))).toEqual([]);
  });

  it("produces EVERY column a writer must supply", () => {
    const produced = new Set(fields.map(camelToSnake));
    expect(
      requiredColumns("accounting.ledger_transactions").filter(
        (column) => !produced.has(column),
      ),
    ).toEqual([]);
  });

  it("leaves recorded_at to the database and carries the id itself", () => {
    const produced = new Set(fields.map(camelToSnake));
    expect(produced.has("recorded_at")).toBe(false);
    expect(produced.has("ledger_transaction_id")).toBe(true);
  });

  it("binds an appended transaction at compile time", () => {
    const appended: AppendedLedgerTransaction = {
      sequence: 0,
      transaction: {
        ledgerTransactionId: "018f3a5c-4444-7000-8000-000000000001",
        eventType: "DEPOSIT_OBSERVED",
        environment: "PAPER",
        accountRef: "acct-paper-1",
        source: "internal",
        occurredAt: "2026-09-02T12:00:00.000Z",
        entries: [],
      },
    };
    const insert: Omit<
      InsertRow<AccountingLedgerTransactionsTable>,
      | "ledger_transaction_id"
      | "recorded_at"
      | "market_id"
      | "order_id"
      | "fill_id"
      | "wallet_operation_id"
      | "reconciliation_run_id"
      | "settlement_state"
      | "reverses_ledger_transaction_id"
      | "reference_hash"
      | "detail"
    > = {
      event_type: appended.transaction
        .eventType as InsertRow<AccountingLedgerTransactionsTable>["event_type"],
      environment: appended.transaction
        .environment as InsertRow<AccountingLedgerTransactionsTable>["environment"],
      account_ref: appended.transaction.accountRef,
      source: appended.transaction.source as InsertRow<AccountingLedgerTransactionsTable>["source"],
      occurred_at: appended.transaction.occurredAt,
    };
    expect(insert.account_ref).toBe("acct-paper-1");
  });
});

describe("a ledger entry binds to accounting.ledger_entries", () => {
  const fields = Object.keys(LedgerEntryInputSchema.shape);

  it("produces only columns the table has", () => {
    const columns = new Set(columnNames("accounting.ledger_entries"));
    expect(fields.map(camelToSnake).filter((column) => !columns.has(column))).toEqual([]);
  });

  it("produces every required column except the writer-supplied two", () => {
    const produced = new Set([...fields.map(camelToSnake), ...ENTRY_WRITER_SUPPLIED]);
    expect(
      requiredColumns("accounting.ledger_entries").filter((column) => !produced.has(column)),
    ).toEqual([]);
    // And those two really are absent from the record, not quietly present.
    for (const column of ENTRY_WRITER_SUPPLIED) {
      expect(fields.map(camelToSnake)).not.toContain(column);
    }
  });

  it("binds an entry at compile time", () => {
    const insert: Omit<
      InsertRow<AccountingLedgerEntriesTable>,
      | "ledger_entry_id"
      | "recorded_at"
      | "instance_id"
      | "run_id"
      | "market_id"
      | "detail"
    > = {
      ledger_transaction_id: "018f3a5c-4444-7000-8000-000000000001",
      entry_ordinal: 0,
      scope: "ACTUAL_ACCOUNT",
      account_ref: "acct-paper-1",
      asset_id: "pUSD",
      asset_kind: "COLLATERAL",
      amount: "100",
    };
    expect(insert.amount).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// The vocabularies the PnL package re-declares for settlement evidence
// ---------------------------------------------------------------------------

describe("the PnL evidence vocabulary matches the ledger's, token for token", () => {
  it("re-declares the same six scopes", () => {
    expect([...PNL_EVIDENCE_SCOPES]).toEqual([...LEDGER_SCOPES]);
  });

  it("re-declares the same asset kinds", () => {
    expect([...PNL_EVIDENCE_ASSET_KINDS]).toEqual([...ASSET_KINDS]);
  });

  it("names reward events the ledger vocabulary actually has", () => {
    for (const eventType of Object.values(PNL_REWARD_LEDGER_EVENTS)) {
      expect(LEDGER_EVENT_TYPES).toContain(eventType);
    }
    expect(Object.keys(PNL_REWARD_LEDGER_EVENTS).sort()).toEqual([
      "LIQUIDITY_REWARD",
      "MAKER_REBATE",
      "TAKER_REBATE",
    ]);
  });
});
