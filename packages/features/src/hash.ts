/**
 * SHA-256 over UTF-8 text, for content addressing.
 *
 * `node:crypto` is used the same way — and with the same justification — as
 * in `@polymarket-bot/decimal`'s canonical decimal hashing: a pure,
 * synchronous computation with no I/O, no clock, no entropy consumption, and
 * no connection surface. `packages/features` is a layer-1 package with no
 * import allowlist row binding it (dependency-direction §3: F15 binds only
 * `packages/decimal`; F14 binds only the purity-restricted packages), and the
 * package's no-wall-clock acceptance scan allowlists exactly this one
 * built-in specifier.
 */

import { createHash } from "node:crypto";

/** Lowercase-hex SHA-256 of `text` encoded as UTF-8. Pure. */
export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
