/**
 * `@polymarket-bot/event-bus` — the bounded gateway-to-trader transport
 * (`WP-060`, handoff §9.1, ADR-003).
 *
 * Contents:
 *
 * - `./transport.ts` — the transport-neutral interface: publish, subscribe,
 *   consumer checkpoint, bounded retention. Carries normalized §7.1 envelopes.
 * - `./metrics.ts` — the §8.3 queue metric set as typed queryable values.
 * - `./redis/` — the v1 Redis Streams implementation behind that interface.
 *
 * DEPENDENCY DIRECTION (`docs/contracts/dependency-direction.md`): this package
 * is layer 2. It depends downward on `@polymarket-bot/domain` and on a Redis
 * client, and it is the **only** package permitted to import a Redis client for
 * market-event transport (F8, ADR-003 §1). Its consumers are the layer-3
 * composition roots — `apps/data-gateway` publishes and `apps/trader` consumes.
 *
 * SAFETY: this package carries public market data and requires no credential.
 * It reads no environment variable, holds no signer, and touches no run-mode
 * default (ADR-010).
 */

export * from "./envelope-codec.js";
export * from "./epoch-order.js";
export * from "./errors.js";
export * from "./metrics.js";
export * from "./resync.js";
export * from "./transport.js";
export * from "./redis/index.js";
