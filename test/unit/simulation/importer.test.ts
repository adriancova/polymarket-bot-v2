/**
 * The manifest-reading `data.raw_segments` / `data.dataset_manifests` importer
 * (the operator decision recorded in the work plan's `WP-210` comment).
 *
 * NO POSTGRESQL WAS REACHED. `docker compose config` fails in this environment
 * ("the command 'docker' could not be found in this WSL 2 distro"), so this
 * suite drives the repository against an in-memory fake and pins the parts a
 * fake CANNOT fabricate against the real DDL:
 *
 * - the fake enforces the two natural keys the migration declares
 *   (`raw_segments(gateway_epoch, segment_seq)` unique, `dataset_manifests(manifest_key)`
 *   unique) and append-only-ness, because those are what the idempotency
 *   argument rests on;
 * - every column the MIGRATION declares `not null` with no default is asserted
 *   to be supplied by the insert, parsed from `db/migrations/0003_data.up.sql`
 *   at runtime — the `WP-200` `wp040-persistence-shape.test.ts` precedent — so a
 *   column added upstream fails here rather than at first deployment;
 * - the idempotency probe is "run twice, the recorded state is byte-identical",
 *   compared as canonical JSON of the whole fake store.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createDatasetCatalogRepository,
  type ImportDatasetManifestInput,
} from "../../../packages/storage-postgres/src/repositories/dataset-catalog.js";
import type { PolymarketBotDatabase } from "../../../packages/storage-postgres/src/database.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---------------------------------------------------------------------------
// The DDL, parsed (WP-200 precedent)
// ---------------------------------------------------------------------------

const DATA_MIGRATION = readFileSync(join(REPO_ROOT, "db", "migrations", "0003_data.up.sql"), "utf8")
  .split("\n")
  .map((line) => {
    const comment = line.indexOf("--");
    return comment < 0 ? line : line.slice(0, comment);
  })
  .join("\n");

const CONSTRAINT_KEYWORDS = new Set([
  "constraint",
  "check",
  "unique",
  "primary",
  "foreign",
  "exclude",
  "call",
]);

interface Column {
  readonly name: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

/** Columns of one `create table` block, tracking parenthesis depth. */
function columnsOf(table: string): readonly Column[] {
  const start = DATA_MIGRATION.indexOf(`create table ${table} (`);
  if (start < 0) throw new Error(`migration has no create table ${table}`);
  const body = DATA_MIGRATION.slice(start);
  const columns: Column[] = [];
  let depth = 0;
  let current = "";
  for (let index = body.indexOf("("); index < body.length; index += 1) {
    const character = body.charAt(index);
    if (character === "(") {
      depth += 1;
      if (depth === 1) continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        pushColumn(columns, current);
        break;
      }
    }
    if (character === "," && depth === 1) {
      pushColumn(columns, current);
      current = "";
      continue;
    }
    current += character;
  }
  return columns;
}

function pushColumn(columns: Column[], text: string): void {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (trimmed === "") return;
  const first = trimmed.split(" ")[0]?.toLowerCase() ?? "";
  if (CONSTRAINT_KEYWORDS.has(first)) return;
  const name = trimmed.split(" ")[0] ?? "";
  columns.push({
    name,
    notNull: /\bnot null\b/iu.test(trimmed),
    hasDefault: /\bdefault\b/iu.test(trimmed),
  });
}

function requiredColumns(table: string): readonly string[] {
  return columnsOf(table)
    .filter((column) => column.notNull && !column.hasDefault)
    .map((column) => column.name)
    .sort();
}

// ---------------------------------------------------------------------------
// The in-memory fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Store {
  readonly tables: Map<string, Row[]>;
  readonly inserts: { table: string; row: Row }[];
}

const UNIQUE_KEYS: Readonly<Record<string, readonly string[]>> = {
  "data.raw_segments": ["gateway_epoch", "segment_seq"],
  "data.dataset_manifests": ["manifest_key"],
  "data.dataset_manifest_segments": ["dataset_manifest_id", "ordinal"],
  "data.dataset_manifest_exclusions": ["dataset_manifest_id", "ordinal"],
};

function makeFake(): { readonly db: PolymarketBotDatabase; readonly store: Store } {
  const store: Store = { tables: new Map(), inserts: [] };

  const handle = {
    selectFrom(table: string) {
      const filters: { column: string; value: unknown }[] = [];
      const builder = {
        select() {
          return builder;
        },
        where(column: string, _operator: string, value: unknown) {
          filters.push({ column: column.replace(/^[a-z]+\./u, ""), value });
          return builder;
        },
        async executeTakeFirst() {
          const rows = store.tables.get(table) ?? [];
          return await Promise.resolve(
            rows.find((row) => filters.every((filter) => row[filter.column] === filter.value)),
          );
        },
      };
      return builder;
    },
    insertInto(table: string) {
      return {
        values(row: Row) {
          return {
            async execute() {
              const rows = store.tables.get(table) ?? [];
              const key = UNIQUE_KEYS[table] ?? [];
              const clash = rows.find((existing) =>
                key.every((column) => existing[column] === row[column]),
              );
              if (key.length > 0 && clash !== undefined) {
                throw new Error(`unique violation on ${table} (${key.join(", ")})`);
              }
              rows.push({ ...row });
              store.tables.set(table, rows);
              store.inserts.push({ table, row: { ...row } });
              return await Promise.resolve(undefined);
            },
          };
        },
      };
    },
    transaction() {
      return {
        async execute<T>(work: (trx: unknown) => Promise<T>): Promise<T> {
          return await work(handle);
        },
      };
    },
  };

  return { db: handle as unknown as PolymarketBotDatabase, store };
}

function canonicalState(store: Store): string {
  const tables = [...store.tables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    tables.map(([table, rows]) => [
      table,
      rows.map((row) =>
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key]]),
      ),
    ]),
  );
}

// ---------------------------------------------------------------------------

const GATEWAY_EPOCH = "0190a3e0-0000-7000-8000-000000000001";

function importInput(overrides: Partial<ImportDatasetManifestInput> = {}): ImportDatasetManifestInput {
  return {
    manifestKey: "2026-06-29T17-00Z",
    gatewayEpoch: GATEWAY_EPOCH,
    manifestSha256: "a".repeat(64),
    normalizerVersion: "polymarket-public/market-channel/v1",
    runSeed: "42",
    startEventIdentity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: "1" },
    endEventIdentity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: "9" },
    pinnedVersions: { feeSnapshotVersion: "fees/2026-08-24" },
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    segmentFormat: "JSONL",
    segments: [
      {
        walSegmentId: "0190a3e0-0000-7000-8000-000000000001-000000",
        segmentIndex: 0,
        segmentSha256: "b".repeat(64),
        recordCount: 3,
        byteSize: 1600,
        firstIngestSeq: "1",
        lastIngestSeq: "9",
        firstReceivedAt: "2026-06-29T17:15:57.300Z",
        lastReceivedAt: "2026-06-29T17:15:57.500Z",
        fileUri: "0190a3e0-0000-7000-8000-000000000001-000000.wal.jsonl",
      },
    ],
    exclusions: [],
    ...overrides,
  };
}

describe("the importer supplies every column the DDL requires", () => {
  it("inserts every NOT NULL column of data.raw_segments that has no default", async () => {
    const { db, store } = makeFake();
    const outcome = await createDatasetCatalogRepository(db).importDatasetManifest(importInput());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    const inserted = store.inserts.find((entry) => entry.table === "data.raw_segments");
    expect(inserted).toBeDefined();
    for (const column of requiredColumns("data.raw_segments")) {
      expect(Object.keys(inserted?.row ?? {}), column).toContain(column);
      expect(inserted?.row[column], column).not.toBeNull();
      expect(inserted?.row[column], column).not.toBeUndefined();
    }
  });

  it("inserts every NOT NULL column of data.dataset_manifests that has no default", async () => {
    const { db, store } = makeFake();
    await createDatasetCatalogRepository(db).importDatasetManifest(importInput());
    const inserted = store.inserts.find((entry) => entry.table === "data.dataset_manifests");
    expect(inserted).toBeDefined();
    for (const column of requiredColumns("data.dataset_manifests")) {
      expect(Object.keys(inserted?.row ?? {}), column).toContain(column);
      expect(inserted?.row[column], column).not.toBeNull();
    }
  });

  it("inserts every NOT NULL column of the manifest child tables", async () => {
    const { db, store } = makeFake();
    await createDatasetCatalogRepository(db).importDatasetManifest(
      importInput({
        exclusions: [
          {
            incidentId: "inc-1",
            reason: "a recorded gap",
            windowStart: "2026-06-29T17:00:00.000Z",
            windowEnd: "2026-06-29T17:00:10.000Z",
          },
        ],
      }),
    );
    for (const table of ["data.dataset_manifest_segments", "data.dataset_manifest_exclusions"]) {
      const inserted = store.inserts.find((entry) => entry.table === table);
      expect(inserted, table).toBeDefined();
      for (const column of requiredColumns(table)) {
        expect(Object.keys(inserted?.row ?? {}), `${table}.${column}`).toContain(column);
      }
    }
  });
});

describe("the importer is idempotent", () => {
  it("running twice leaves byte-identical state and inserts nothing the second time", async () => {
    const { db, store } = makeFake();
    const repository = createDatasetCatalogRepository(db);

    const first = await repository.importDatasetManifest(importInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.created).toBe(true);
    expect(first.value.segmentsInserted).toBe(1);
    const afterFirst = canonicalState(store);
    const insertsAfterFirst = store.inserts.length;

    const second = await repository.importDatasetManifest(importInput());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toBe(false);
    expect(second.value.segmentsInserted).toBe(0);
    expect(second.value.segmentsAlreadyPresent).toBe(1);
    expect(second.value.datasetManifestId).toBe(first.value.datasetManifestId);

    expect(canonicalState(store)).toBe(afterFirst);
    expect(store.inserts.length).toBe(insertsAfterFirst);
  });

  it("a third run is still a no-op", async () => {
    const { db, store } = makeFake();
    const repository = createDatasetCatalogRepository(db);
    await repository.importDatasetManifest(importInput());
    await repository.importDatasetManifest(importInput());
    const stable = canonicalState(store);
    await repository.importDatasetManifest(importInput());
    expect(canonicalState(store)).toBe(stable);
  });
});

describe("the importer refuses rather than reconciling", () => {
  it("refuses a segment ordinal already registered with different bytes", async () => {
    const { db } = makeFake();
    const repository = createDatasetCatalogRepository(db);
    await repository.importDatasetManifest(importInput());
    const outcome = await repository.importDatasetManifest(
      importInput({
        manifestKey: "different-dataset",
        segments: [
          {
            ...importInput().segments[0]!,
            segmentSha256: "c".repeat(64),
          },
        ],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("DATASET_IMPORT_SEGMENT_CONFLICT");
  });

  it("refuses a manifest key already registered with a different manifest hash", async () => {
    const { db } = makeFake();
    const repository = createDatasetCatalogRepository(db);
    await repository.importDatasetManifest(importInput());
    const outcome = await repository.importDatasetManifest(
      importInput({ manifestSha256: "d".repeat(64) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("DATASET_IMPORT_MANIFEST_CONFLICT");
  });

  it("refuses an OPEN incident window rather than inventing a close time", async () => {
    const { db } = makeFake();
    const outcome = await createDatasetCatalogRepository(db).importDatasetManifest(
      importInput({
        exclusions: [
          {
            incidentId: "inc-open",
            reason: "still open",
            windowStart: "2026-06-29T17:00:00.000Z",
            windowEnd: null,
          },
        ],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("DATASET_IMPORT_OPEN_INCIDENT_WINDOW");
  });

  it("refuses a segment with no recorded first receivedAt", async () => {
    const { db } = makeFake();
    const outcome = await createDatasetCatalogRepository(db).importDatasetManifest(
      importInput({
        segments: [{ ...importInput().segments[0]!, firstReceivedAt: null }],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("DATASET_IMPORT_EMPTY_SEGMENT_WINDOW");
  });
});
