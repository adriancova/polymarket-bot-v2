/**
 * A capturing stand-in for the typed Kysely handle: records every row a
 * repository BINDS (`insertInto(...).values(row)`, `updateTable(...).set(row)`)
 * and answers reads from a small table of canned rows.
 *
 * NO POSTGRESQL AND NO `pg` IS REACHED, on purpose: the property under test
 * is what the repository hands the query layer — the parameter's TYPE and its
 * BYTES — before any driver sees it. The measurement `SER-0` recorded
 * (`docs/handoffs/SER-0-sweep.md`, area `postgres`) was taken one step later,
 * at `pg@8.23.0`'s `prepareValue`; the pins built on this fake reproduce that
 * step with the driver's real `prepareValue` applied to the captured value
 * INSIDE the pollution window (`test/unit/storage-postgres/jsonb-text-binding.test.ts`),
 * so an object bound at base shows the bytes the driver would have sent.
 *
 * The builder is a `Proxy`: any method not named below returns the same
 * builder (`where`, `orderBy`, `limit`, `forUpdate`, `select`, …), so a
 * repository's query shape can change without this fake growing a method per
 * clause. The terminal methods are the only ones with behaviour.
 * `test/unit/simulation/importer.test.ts` is the hand-written precedent.
 */

import type { PolymarketBotDatabase } from "../../../../packages/storage-postgres/src/database.js";

/** One bound write: the table, the statement kind, and the row as bound. */
export interface BoundWrite {
  readonly table: string;
  readonly kind: "insert" | "update";
  readonly row: Readonly<Record<string, unknown>>;
}

export interface CapturingDatabase {
  readonly db: PolymarketBotDatabase;
  /** Every write, in the order the repository issued it. */
  readonly writes: readonly BoundWrite[];
  /** The bound value of `column` in the first write to `table`, or `undefined`. */
  bound(table: string, column: string): unknown;
}

type Row = Readonly<Record<string, unknown>>;

/**
 * @param reads - Canned rows per table, answered in order by `executeTakeFirst`
 *   / `executeTakeFirstOrThrow` / `execute` on a `selectFrom(table)`.
 */
export function createCapturingDatabase(
  reads: Readonly<Record<string, readonly Row[]>> = {},
): CapturingDatabase {
  const writes: BoundWrite[] = [];

  function selectBuilder(table: string): unknown {
    const rows = reads[table] ?? [];
    const terminal: Record<string, () => Promise<unknown>> = {
      execute: async () => await Promise.resolve([...rows]),
      executeTakeFirst: async () => await Promise.resolve(rows[0]),
      executeTakeFirstOrThrow: async () => {
        const first = rows[0];
        if (first === undefined) throw new Error(`capturing db: no canned row for ${table}`);
        return await Promise.resolve(first);
      },
    };
    const builder: unknown = new Proxy(terminal, {
      get(target, property) {
        if (typeof property === "string" && Object.hasOwn(target, property)) {
          return target[property];
        }
        if (property === "then") return undefined;
        return () => builder;
      },
    });
    return builder;
  }

  function writeBuilder(table: string, kind: BoundWrite["kind"]): unknown {
    const record = (row: unknown): void => {
      const rows: unknown[] = Array.isArray(row) ? row : [row];
      for (const one of rows) {
        writes.push({ table, kind, row: one as Row });
      }
    };
    const terminal: Record<string, (...args: unknown[]) => unknown> = {
      values: (row: unknown) => {
        record(row);
        return builder;
      },
      set: (row: unknown) => {
        record(row);
        return builder;
      },
      execute: async () => await Promise.resolve([]),
      executeTakeFirst: async () => await Promise.resolve(undefined),
      executeTakeFirstOrThrow: async () => await Promise.resolve({}),
    };
    const builder: unknown = new Proxy(terminal, {
      get(target, property) {
        if (typeof property === "string" && Object.hasOwn(target, property)) {
          return target[property];
        }
        if (property === "then") return undefined;
        return () => builder;
      },
    });
    return builder;
  }

  const handle = {
    selectFrom: (table: string) => selectBuilder(table),
    insertInto: (table: string) => writeBuilder(table, "insert"),
    updateTable: (table: string) => writeBuilder(table, "update"),
    transaction: () => ({
      execute: async <T>(work: (trx: unknown) => Promise<T>): Promise<T> => await work(handle),
    }),
    destroy: async () => await Promise.resolve(undefined),
  };

  return {
    db: handle as unknown as PolymarketBotDatabase,
    writes,
    bound(table, column) {
      const write = writes.find((entry) => entry.table === table);
      if (write === undefined) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(write.row, column);
      return descriptor === undefined ? undefined : descriptor.value;
    },
  };
}
