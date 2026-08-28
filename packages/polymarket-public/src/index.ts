/**
 * `@polymarket-bot/polymarket-public` — the public Polymarket market-data
 * adapter (`WP-070`, handoff §9.1/§9.4, ADR-001, ADR-002).
 *
 * Contents:
 *
 * - `./venue/` — the raw wire schemas and frame shapes of the public market
 *   WebSocket channel and the public CLOB book REST reads, transcribed from the
 *   official SDK at the pinned reference commit and behaviourally anchored to it
 *   by the contract suite (register item R-2).
 * - `./normalize/` — the venue edge: `""`/`null`/absence collapse to *absent*,
 *   venue decimal spellings become canonical decimal strings, epoch-like
 *   timestamps become ISO instants, and every result is validated against the
 *   frozen domain contract before it is emitted.
 * - `./feed/` — connection lifecycle, heartbeat, staleness, reconnect,
 *   subscription generations, and the `Feed*` health events.
 * - `./snapshot/` — authoritative REST book snapshots, the capability the
 *   gateway uses to recover from a gap.
 * - `./testing` (subpath) — deterministic doubles for every port.
 *
 * ## Dependency direction
 *
 * Layer 2 (`docs/contracts/dependency-direction.md` §2). It depends downward on
 * `@polymarket-bot/domain` and `@polymarket-bot/decimal` and on nothing else in
 * the workspace.
 *
 * **It does not import `@polymarket/client`.** F6 grants the unified SDK
 * exclusively to `packages/polymarket-secure` (handoff §9.12, ADR-010 §4), and
 * the archived CLOB/relayer/builder clients are forbidden outright (F7). The
 * WebSocket and REST surfaces here are implemented directly on Node 24's own
 * `WebSocket` and `fetch`, which is why this package declares no venue
 * dependency at all.
 *
 * ## What this package does not do
 *
 * - It does not assign `eventId`, `gatewayEpoch`, `ingestSeq`, or receipt
 *   metadata: those are the gateway's (ADR-002 §1), and an adapter that minted
 *   them would be inventing an ordering position.
 * - It does not invent a venue sequence number (§9.4).
 * - It does not mint an `InternalMarketId` or a parameter version: those are
 *   the Universe Service's, and they arrive through the
 *   `PublicMarketDirectory` port.
 * - It does not maintain a local order book. It reports absolute level changes
 *   exactly as the venue publishes them; reconstruction is `WP-150`'s.
 *
 * ## Safety
 *
 * This package carries PUBLIC market data and requires no credential. It reads
 * no environment variable, holds no signer, sends no authenticated header,
 * places no order, and touches no run-mode default (ADR-010). There is no code
 * path here that could.
 */

export * from "./config.js";
export * from "./errors.js";
export * from "./ports.js";
export * from "./runtime.js";

export * from "./venue/primitives.js";
export * from "./venue/market-events.js";
export * from "./venue/order-book.js";
export * from "./venue/frames.js";

export * from "./normalize/values.js";
export * from "./normalize/fields.js";
export * from "./normalize/result.js";
export * from "./normalize/market-events.js";
export * from "./normalize/snapshot.js";

export * from "./feed/signals.js";
export * from "./feed/subscriptions.js";
export * from "./feed/connection.js";

export * from "./snapshot/fetcher.js";
