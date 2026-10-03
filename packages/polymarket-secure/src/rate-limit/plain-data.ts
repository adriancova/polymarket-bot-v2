/**
 * Contained readers for foreign input (configuration documents, header maps,
 * observations, completions). The same discipline as the rest of this
 * package (`venue-client.ts`): own DATA properties only, a getter is never
 * invoked, and a reflection that throws (a proxy trap, a revoked proxy) is
 * dropped unread. Package-internal.
 */

import { MAX_EPOCH_MS } from "./units.js";

export type OwnRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "DATA"; readonly value: unknown }
  /** Present but not own data (an accessor, an inherited key, a read that threw). Never "absent". */
  | { readonly kind: "OPAQUE" };

const ABSENT: OwnRead = Object.freeze({ kind: "ABSENT" });
const OPAQUE: OwnRead = Object.freeze({ kind: "OPAQUE" });

export function readOwn(source: unknown, key: string): OwnRead {
  if (source === null || typeof source !== "object") return ABSENT;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined) return "value" in descriptor ? Object.freeze({ kind: "DATA", value: descriptor.value }) : OPAQUE;
    return key in source ? OPAQUE : ABSENT;
  } catch {
    return OPAQUE;
  }
}

/** A plain object's own enumerable string keys, or `undefined` when it is not one (or reflection throws). */
export function ownKeys(source: unknown): readonly string[] | undefined {
  try {
    if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") return undefined;
      keys.push(key);
    }
    return Object.freeze(keys);
  } catch {
    return undefined;
  }
}

/** An array's entries, copied once from own data properties. `undefined` for anything else. */
export function readList(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = readOwn(value, "length");
    if (length.kind !== "DATA" || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0) {
      return undefined;
    }
    const out: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = readOwn(value, String(index));
      if (entry.kind !== "DATA") return undefined;
      out.push(entry.value);
    }
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

/** A safe integer at or above `minimum`. */
export function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/**
 * An instant on the budget's time base: a non-negative integer of Unix epoch milliseconds, at most
 * `MAX_EPOCH_MS` (so every deadline derived from it stays exact; `units.ts`).
 */
export function isEpochMs(value: unknown): value is number {
  return isIntegerAtLeast(value, 0) && value <= MAX_EPOCH_MS;
}

/** An integer in `[minimum, maximum]`. */
export function isIntegerWithin(value: unknown, minimum: number, maximum: number): value is number {
  return isIntegerAtLeast(value, minimum) && value <= maximum;
}

const ISO_INSTANT = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

/** The smallest value of each `Date.UTC` field after the year: month index, day, hour, minute, second. */
const FIELD_MINIMA = Object.freeze([0, 1, 0, 0, 0]);

function utc(fields: readonly number[]): number {
  const [year = 0, ...rest] = fields;
  return Date.UTC(year, ...rest);
}

/**
 * A strict ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.sss]Z`, year 1000 or
 * later) → epoch milliseconds, or `undefined`. Pure arithmetic over
 * `Date.UTC`; no clock is read and no `Date` object is built. A field out of
 * its calendar range (`2026-02-30`, `24:00:00`, `23:60:00`) is refused, never
 * rolled over: each field must land at or after its unit's first value and
 * strictly before the next unit of the field above it.
 */
export function parseIsoInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;
  const [, y = "", mo = "", d = "", h = "", mi = "", s = "", frac] = match;
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  for (let index = 1; index < fields.length; index += 1) {
    const parent = fields.slice(0, index);
    const lower = utc([...parent, FIELD_MINIMA[index - 1] ?? 0]);
    const actual = utc(fields.slice(0, index + 1));
    const nextParent = [...parent];
    nextParent[index - 1] = (nextParent[index - 1] ?? 0) + 1;
    const upper = utc(nextParent);
    if (!(actual >= lower && actual < upper)) return undefined;
  }
  const ms = utc(fields) + (frac === undefined ? 0 : Number(frac));
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
}
