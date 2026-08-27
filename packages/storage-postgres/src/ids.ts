/**
 * Sortable internal identifiers (handoff §7.2, §10.7).
 *
 * §10.7 requires "UUIDv7 or equivalent sortable IDs for internal records" and
 * every primary key in `db/migrations` is declared with the `internal.uuid_v7`
 * domain, which rejects any other version. PostgreSQL 16 has no built-in
 * `uuidv7()`, so the database carries `internal.uuid_generate_v7()` for
 * server-side defaults and this module generates the same shape client-side —
 * which is what lets a caller know an id before the insert (needed to write a
 * parent and its children in one statement batch).
 *
 * Layout (RFC 9562 §5.7):
 *
 *   bytes 0-5   big-endian Unix milliseconds
 *   byte  6     version nibble 0111 + 4 random bits
 *   byte  8     variant bits 10 + 6 random bits
 *   remainder   random
 */

import { randomFillSync } from "node:crypto";

/** A lowercase canonical UUIDv7 string. */
export type UuidV7 = string;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Largest instant representable in the 48-bit millisecond field. */
export const MAX_UUID_V7_TIMESTAMP_MS = 0xffff_ffff_ffff;

/**
 * Generates a UUIDv7.
 *
 * @param timestampMs - Unix milliseconds to encode. Defaults to the wall clock.
 *   It is a parameter so that deterministic replay (§12.4) can supply its own
 *   clock instead of reaching for a global one.
 */
export function uuidV7(timestampMs: number = Date.now()): UuidV7 {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_UUID_V7_TIMESTAMP_MS) {
    throw new RangeError(
      `UUIDv7 timestamp must be an integer in [0, ${MAX_UUID_V7_TIMESTAMP_MS}], received ${String(timestampMs)}`,
    );
  }

  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  // Big-endian 48-bit millisecond timestamp. `Number` holds 2^48 exactly, so
  // the arithmetic below is exact.
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/** Whether `value` is a lowercase canonical UUIDv7. */
export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/** Reads the embedded Unix-millisecond timestamp of a UUIDv7. */
export function uuidV7TimestampMs(value: UuidV7): number {
  if (!isUuidV7(value)) {
    throw new TypeError(`Not a canonical UUIDv7: ${JSON.stringify(value)}`);
  }
  const hex = value.slice(0, 8) + value.slice(9, 13);
  return Number.parseInt(hex, 16);
}

function formatUuid(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
