/**
 * Redaction for user-stream payloads (WP-280; handoff §15 "Logs redact API
 * keys, passphrases, signatures, signed order payloads, and private wallet
 * material").
 *
 * THE PRIMARY RULE IS STRUCTURAL, as in WP-260 (`../redaction.ts`): nothing
 * this adapter emits carries a raw payload. Normalized events are built from
 * an allow-list of fields that excludes every owner, and an unrecognized
 * message carries a fixed reason code, never its text.
 *
 * {@link redactUserStreamPayload} is the SECOND line, for a caller that must
 * log a raw user-channel payload (a parsed frame, or a subscription frame it
 * built). The user channel carries CLOB API keys in fields WP-260's key-name
 * heuristic does not match: `owner`, `trade_owner`, `order_owner` and each
 * maker order's `owner` (the order request's `owner` is "CLOB API key",
 * `verified-2026-08-24.md` §2.1), and the subscription frame's `auth` object
 * (`{"auth": {apiKey, secret, passphrase}, "type": "user"}`, §W.4). So this
 * function first applies WP-260's {@link redactForLog} (every sensitive key,
 * getters never invoked, cycles and depth bounded, never throws), and then
 * replaces the value under every key whose normalised name contains `owner`
 * or equals `auth`. Over-redaction is the safe side.
 */

import { REDACTED, redactForLog } from "../redaction.js";

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/gu, "");
}

/** True when a value stored under `key` in a user-channel payload must be redacted (beyond WP-260's rule). */
export function isUserStreamSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return normalised.includes("owner") || normalised === "auth";
}

const MAX_DEPTH = 32;

/** Walks the plain copy `redactForLog` returned (plain objects, arrays and primitives only). */
function redactOwners(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.map((entry: unknown) => redactOwners(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // defineProperty, not assignment: a key named `__proto__` stays an own data property.
    Object.defineProperty(out, key, {
      value: isUserStreamSensitiveKey(key) ? REDACTED : redactOwners(entry, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** A deep copy of a user-channel payload that is safe to log. Never throws. */
export function redactUserStreamPayload(value: unknown): unknown {
  try {
    return redactOwners(redactForLog(value), 0);
  } catch {
    return "[unreadable]";
  }
}
