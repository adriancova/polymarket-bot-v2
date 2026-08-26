/**
 * `@polymarket-bot/decimal` — exact decimal foundation (WP-020).
 *
 * This package is the lowest layer of the dependency graph (handoff §5.2). It
 * depends only on `decimal.js` and `node:crypto` (pure SHA-256 computation) and
 * must never import an adapter, a database client, an SDK, or a process global.
 *
 * See `docs/contracts/domain.md` for the canonicalization rules, the strict
 * boundary decision, and the contract-freeze policy.
 */

export {
  MAX_DECIMAL_STRING_LENGTH,
  assertCanonicalDecimalString,
  decimalPlaces,
  explainCanonicalDecimalString,
  explainHashableDecimalString,
  isCanonicalDecimalString,
  isHashableDecimalString,
  normalizeDecimalString,
  normalizeHashableDecimalString,
  significantDigits,
  tryNormalizeDecimalString,
} from "./canonical.js";
export type {
  DecimalRange,
  DecimalString,
  DecimalStringConstraints,
  NormalizationResult,
} from "./canonical.js";

export {
  DIVISION_PRECISION,
  DIVISION_ROUNDING,
  EXACT_DIVISION_PROBE_PRECISION,
  EXACT_PRECISION,
  absDecimal,
  addDecimal,
  compareDecimal,
  divDecimal,
  divDecimalExact,
  equalsDecimal,
  isNegativeDecimal,
  isZeroDecimal,
  mulDecimal,
  negateDecimal,
  subDecimal,
} from "./arithmetic.js";
export type { DivisionOptions } from "./arithmetic.js";

export {
  CANONICAL_DECIMAL_HASH_DOMAIN,
  canonicalDecimalHash,
  canonicalDecimalPreimage,
} from "./hash.js";

export { assertTickConformant, isTickConformant } from "./tick.js";

export {
  DecimalDivisionByZeroError,
  DecimalError,
  DecimalInexactError,
  DecimalRangeError,
  InvalidDecimalStringError,
  InvalidTickSizeError,
} from "./errors.js";
export type { DecimalErrorCode } from "./errors.js";
