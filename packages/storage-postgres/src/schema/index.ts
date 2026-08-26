/**
 * The one logical database (handoff §10, §10.8).
 *
 * §10: "Use PostgreSQL schemas to separate concerns while preserving one
 * logical model." §10.8: "Use one semantic schema and generated types, but
 * separate live operational storage from large backtest output." So there is
 * exactly one `Database` type; separation between live and research storage is a
 * deployment decision (a different connection), never a different model, and
 * every environment-scoped row carries its own `environment` discriminator.
 */

import type { AccountingSchema } from "./accounting.js";
import type { CatalogSchema } from "./catalog.js";
import type { DataSchema } from "./data.js";
import type { ExecutionSchema } from "./execution.js";
import type { InternalSchema } from "./internal.js";
import type { OpsSchema } from "./ops.js";
import type { StrategySchema } from "./strategy.js";

export * from "./columns.js";
export * from "./enums.js";
export type * from "./accounting.js";
export type * from "./catalog.js";
export type * from "./data.js";
export type * from "./execution.js";
export type * from "./internal.js";
export type * from "./ops.js";
export type * from "./strategy.js";

/** Every table in the six semantic schemas plus migration bookkeeping. */
export type Database = CatalogSchema &
  DataSchema &
  StrategySchema &
  ExecutionSchema &
  AccountingSchema &
  OpsSchema &
  InternalSchema;
