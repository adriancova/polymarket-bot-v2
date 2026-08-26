/**
 * `@polymarket-bot/domain` — frozen versioned contracts (WP-020).
 *
 * Contents: the §7.1 event envelope, §7.2 canonical identifiers, §7.3 decimal
 * boundary types, §7.4 normalized market events, §7.5 `DecisionResult`, §7.7
 * intent types, §11 run modes, and the schema-version registry.
 *
 * DEPENDENCY DIRECTION (handoff §5.2): this package depends only on `zod` and
 * `@polymarket-bot/decimal`. It must never import an adapter, PostgreSQL,
 * Redis, an SDK, a Node built-in, or a process global. Everything here is a
 * pure declaration; nothing performs I/O.
 *
 * OUT OF SCOPE for WP-020: `StrategyContext` and the view interfaces of §7.6
 * (owned by WP-170), storage, adapters, and any I/O.
 *
 * CONTRACT FREEZE: after WP-020 is accepted, changing a contract in this
 * package requires an ADR (see `docs/contracts/domain.md`).
 */

export * from "./decimals.js";
export * from "./decision.js";
export * from "./envelope.js";
export * from "./errors.js";
export * from "./events/index.js";
export * from "./identifiers.js";
export * from "./intents.js";
export * from "./primitives.js";
export * from "./registry.js";
export * from "./run-mode.js";
export * from "./schema-version.js";
