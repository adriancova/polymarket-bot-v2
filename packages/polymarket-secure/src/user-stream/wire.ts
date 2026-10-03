/**
 * Readers for the raw user-channel wire values (WP-280). Every reader is
 * total: it returns the value, or `undefined` for anything it does not accept.
 * Nothing here throws, coerces, rounds or uses a binary float for an economic
 * value (handoff §6 invariant 1; ADR-001).
 *
 * WHAT IS ACCEPTED, and why:
 *
 * - DECIMALS. The SDK's `DecimalStringSchema` accepts any string; this adapter
 *   is stricter (exact decimals are an invariant here): a plain numeral of
 *   digits with an optional fraction (`/^[0-9]+(\.[0-9]+)?$/`, bounded), no
 *   sign, exponent or whitespace. It is canonicalised exactly (redundant
 *   leading and trailing zeros dropped; `domain.md` and
 *   `@polymarket-bot/decimal` require the adapter that owns a wire format to do
 *   this), and the canonical text is then checked by `@polymarket-bot/domain`'s
 *   own schemas, so the canonical form is decided by the decimal package.
 * - OPTIONAL DECIMALS (`fee_rate_bps`): the wire empty string means absent
 *   (SDK `OptionalDecimalStringSchema`: "The websocket serializes absent
 *   optional decimals as an empty string"; `verified-2026-08-24.md` §4).
 * - TIMESTAMPS. `timestamp` is epoch milliseconds and `match_time`,
 *   `matchtime`, `last_update`, `created_at`, `expiration` are epoch seconds,
 *   all as digit strings (`/^\d+$/`, `verified-2026-08-24.md` §4). The exact
 *   wire text is kept beside the derived ISO-8601 instant. An instant outside
 *   a plausible window (a client choice, {@link MIN_PLAUSIBLE_EPOCH_MS}) is
 *   refused.
 * - IDENTIFIERS are carried exactly as received when they are safe tokens
 *   (`[A-Za-z0-9_\-:.]`, at most 200 characters: the OMS's venue-id grammar);
 *   anything else is refused, never altered.
 * - The market is a hex condition id of 31 or 32 bytes (SDK
 *   `ConditionIdSchema`: hex, total length 64 or 66). The fixture validator's
 *   32-byte narrowing is NOT inherited (`IMPLEMENTATION_STATUS.md`, WP-000
 *   line: runtime parsers must not inherit the fixture-only narrowings).
 */

import {
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  type DecimalString,
} from "@polymarket-bot/domain";

/** A plain venue numeral: digits, optionally a point and more digits. Bounded. */
const VENUE_NUMERAL = /^([0-9]{1,40})(?:\.([0-9]{1,40}))?$/u;
const SAFE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/u;
const CONDITION_ID = /^0x(?:[0-9a-fA-F]{62}|[0-9a-fA-F]{64})$/u;
/** A CTF token id (decimal) or a Polymarket V2 position id (hex); the same grammar as `venue-client.ts`. */
const ASSET_ID = /^(?:[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/u;
const DIGITS = /^[0-9]{1,16}$/u;
/**
 * CLIENT CHOICE, not a venue fact: the plausible window for a venue instant,
 * 2020-01-01T00:00:00Z (inclusive) to 2100-01-01T00:00:00Z (exclusive). The
 * units follow the verified report (milliseconds for `timestamp`, seconds for
 * the rest), so an instant outside the window is a unit slip (seconds read as
 * milliseconds land in January 1970; milliseconds read as seconds land tens
 * of thousands of years ahead) or garbage, and it is refused, never carried.
 *
 * THE WIRE VALUE "0" IS REFUSED TOO. The pinned SDK accepts `"0"` in every
 * instant field (`/^\d+$/`: `EpochMillisecondsStringSchema`,
 * `EpochSecondsStringToIsoDateTimeStringSchema`), and only `expiration` gives
 * it a meaning (`ExpirationToIsoDateTimeStringSchema` maps it to undefined;
 * `normalize.ts` likewise reads an `expiration` of `"0"` as "no
 * expiration"). No venue fact says what
 * `"0"` means in `timestamp`, `created_at`, `last_update`, `match_time` or
 * `matchtime`, so it is not read as "absent" either: such an event is
 * malformed as a whole, surfaces as an UNRECOGNIZED message and requests
 * reconciliation (fail closed).
 */
export const MIN_PLAUSIBLE_EPOCH_MS = 1_577_836_800_000;
export const MAX_PLAUSIBLE_EPOCH_MS = 4_102_444_800_000;

export type DecimalRange = "NON_NEGATIVE" | "POSITIVE" | "UNIT_INTERVAL";

/** Exact canonicalisation of a plain venue numeral; `undefined` when it is not one or is out of `range`. */
export function readVenueDecimal(value: unknown, range: DecimalRange): DecimalString | undefined {
  if (typeof value !== "string") return undefined;
  const match = VENUE_NUMERAL.exec(value);
  if (match === null) return undefined;
  const integer = (match[1] ?? "").replace(/^0+(?=[0-9])/u, "");
  const fraction = (match[2] ?? "").replace(/0+$/u, "");
  const canonical = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  const schema =
    range === "POSITIVE" ? PositiveDecimalStringSchema : range === "UNIT_INTERVAL" ? PriceStringSchema : NonNegativeDecimalStringSchema;
  return schema.safeParse(canonical).success ? canonical : undefined;
}

/**
 * An optional venue decimal: `null` for an absent key, `null`, or the wire
 * empty string; the canonical value for a plain numeral; `undefined` (refused)
 * for anything else.
 */
export function readOptionalVenueDecimal(value: unknown, range: DecimalRange): DecimalString | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return readVenueDecimal(value, range);
}

export function readSafeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

export function readConditionId(value: unknown): string | undefined {
  return typeof value === "string" && CONDITION_ID.test(value) ? value : undefined;
}

export function readAssetId(value: unknown): string | undefined {
  return typeof value === "string" && ASSET_ID.test(value) ? value : undefined;
}

/** The exact wire digits of a venue instant and the ISO-8601 instant they name. */
export interface VenueInstant {
  readonly wire: string;
  readonly iso: string;
}

function instant(value: unknown, unitMs: number): VenueInstant | undefined {
  if (typeof value !== "string" || !DIGITS.test(value)) return undefined;
  const ms = Number(value) * unitMs;
  if (!Number.isSafeInteger(ms) || ms < MIN_PLAUSIBLE_EPOCH_MS || ms >= MAX_PLAUSIBLE_EPOCH_MS) return undefined;
  return Object.freeze({ wire: value, iso: new Date(ms).toISOString() });
}

/** Epoch milliseconds as a digit string (the event `timestamp`). */
export function readEpochMillis(value: unknown): VenueInstant | undefined {
  return instant(value, 1);
}

/** Epoch seconds as a digit string (`match_time`, `matchtime`, `last_update`, `created_at`, `expiration`). */
export function readEpochSeconds(value: unknown): VenueInstant | undefined {
  return instant(value, 1_000);
}

/** BUY or SELL. The SDK upper-cases the side before validating it (`NormalizedOrderSideSchema`), so this does too. */
export function readSide(value: unknown): "BUY" | "SELL" | undefined {
  if (typeof value !== "string" || value.length > 4) return undefined;
  const upper = value.toUpperCase();
  return upper === "BUY" || upper === "SELL" ? upper : undefined;
}

/**
 * An enumerated wire value this adapter does not recognise is never carried
 * as free text. Its lexeme is kept only when it is an upper-case token
 * (`/^[A-Z][A-Z0-9_]{0,63}$/`: the shape of every documented status), which
 * cannot hold a UUID-shaped owner key or a base64 secret; otherwise `null`.
 */
const TOKEN_LEXEME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function tokenLexeme(value: unknown): string | null {
  return typeof value === "string" && TOKEN_LEXEME.test(value) ? value : null;
}

/** A safe, non-negative integer (`z.number().int()` on the wire), or `undefined`. */
export function readWireInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Exact arithmetic over canonical non-negative decimals (BigInt; no float).

interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

function scaled(value: DecimalString): Scaled {
  const [integer = "0", fraction = ""] = value.split(".");
  return { units: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function align(a: Scaled, b: Scaled): readonly [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale];
}

/** `a` compared with `b`: -1, 0 or 1. Both must be canonical non-negative decimals. */
export function compareDecimals(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const [x, y] = align(scaled(a), scaled(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The exact sum of canonical non-negative decimals, canonical. */
export function sumDecimals(values: readonly DecimalString[]): DecimalString {
  let total: Scaled = { units: 0n, scale: 0 };
  for (const value of values) {
    const [x, y, scale] = align(total, scaled(value));
    total = { units: x + y, scale };
  }
  const digits = total.units.toString().padStart(total.scale + 1, "0");
  const integer = digits.slice(0, digits.length - total.scale);
  const fraction = total.scale === 0 ? "" : digits.slice(digits.length - total.scale).replace(/0+$/u, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}
