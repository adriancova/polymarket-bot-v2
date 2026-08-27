/**
 * Typed repositories for the shared records (work plan `WP-040` deliverable).
 *
 * Every economic value in these APIs is a `DecimalString` — a canonical decimal
 * string — and never a JavaScript `number` (§6 invariant 1). The repositories
 * perform no economic arithmetic: sums and comparisons are done by PostgreSQL in
 * `numeric`, which is exact.
 */

export * from "./balances.js";
export * from "./catalog.js";
export * from "./fencing.js";
export * from "./fills.js";
export * from "./ledger.js";
export * from "./orders.js";
export * from "./ownership.js";
export * from "./strategy.js";

import type { PolymarketBotDatabase } from "../database.js";
import { createBalanceRepository } from "./balances.js";
import { createCatalogRepository } from "./catalog.js";
import { createFencingRepository } from "./fencing.js";
import { createFillRepository } from "./fills.js";
import { createLedgerRepository } from "./ledger.js";
import { createOrderRepository } from "./orders.js";
import { createMarketOwnershipRepository } from "./ownership.js";
import { createStrategyRepository } from "./strategy.js";

/** Every repository, bound to one database handle. */
export type Repositories = {
  readonly balances: ReturnType<typeof createBalanceRepository>;
  readonly catalog: ReturnType<typeof createCatalogRepository>;
  readonly fencing: ReturnType<typeof createFencingRepository>;
  readonly fills: ReturnType<typeof createFillRepository>;
  readonly ledger: ReturnType<typeof createLedgerRepository>;
  readonly orders: ReturnType<typeof createOrderRepository>;
  readonly ownership: ReturnType<typeof createMarketOwnershipRepository>;
  readonly strategy: ReturnType<typeof createStrategyRepository>;
};

export function createRepositories(db: PolymarketBotDatabase): Repositories {
  return {
    balances: createBalanceRepository(db),
    catalog: createCatalogRepository(db),
    fencing: createFencingRepository(db),
    fills: createFillRepository(db),
    ledger: createLedgerRepository(db),
    orders: createOrderRepository(db),
    ownership: createMarketOwnershipRepository(db),
    strategy: createStrategyRepository(db),
  };
}
