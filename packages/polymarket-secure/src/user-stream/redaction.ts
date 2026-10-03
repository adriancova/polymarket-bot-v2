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
 * log a raw user-channel payload (a raw text frame, a parsed frame, or a
 * subscription frame it built). The user channel carries CLOB API keys in
 * fields WP-260's key-name heuristic does not match: `owner`, `trade_owner`,
 * `order_owner` and each maker order's `owner` (the order request's `owner` is
 * "CLOB API key", `verified-2026-08-24.md` §2.1), and the subscription
 * frame's `auth` object (`{"auth": {apiKey, secret, passphrase}, "type":
 * "user"}`, §W.4). So this function first applies WP-260's
 * {@link redactForLog} (every sensitive key, getters never invoked, cycles and
 * depth bounded, never throws), and then replaces the value under every key
 * whose normalised name contains `owner` or equals `auth`. Over-redaction is
 * the safe side.
 *
 * TEXT. A WebSocket payload is text, and WP-260's `redactForLog` passes a
 * string through unchanged, so a TEXT input is never returned as given. The
 * heartbeat frames `PING` and `PONG` are returned as they are (fixed venue
 * tokens). Any other text is parsed: a JSON object or array comes back as the
 * JSON text of its redacted copy; anything else (text that is not JSON, a
 * JSON scalar, an over-long frame) becomes {@link REDACTED}, because free
 * text cannot be vetted. Strings NESTED inside a payload are kept unless
 * their key is sensitive: this is a key-name rule, like WP-260's, and does
 * not vet free text in a public field.
 */

import { REDACTED, redactForLog } from "../redaction.js";

import { MAX_FRAME_CHARACTERS } from "./normalize.js";
import { PING_FRAME, PONG_FRAME } from "./venue-facts.js";

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

/** A text frame, redacted: see the module comment. */
function redactText(text: string): string {
  if (text === PING_FRAME || text === PONG_FRAME) return text;
  if (text.length > MAX_FRAME_CHARACTERS) return REDACTED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return REDACTED;
  }
  if (typeof parsed !== "object" || parsed === null) return REDACTED;
  const encoded: unknown = JSON.stringify(redactOwners(redactForLog(parsed), 0));
  return typeof encoded === "string" ? encoded : REDACTED;
}

/**
 * A redacted copy of a user-channel payload: a deep copy of an object, or the
 * redacted form of a text frame (see the module comment). Never throws.
 *
 * WHAT IT REMOVES IS DECIDED BY KEY NAME ONLY: the value under every key
 * WP-260's rule names sensitive, and under every key whose normalised name
 * contains `owner` or equals `auth`. Free text under any other key (an
 * `error` or `message` string, say) is kept exactly as given and is NOT
 * vetted, so a credential echoed into such a field survives. Only text that is
 * not a JSON object or array as a whole is replaced. Treat the result as
 * key-name-redacted, not as cleared for logging.
 */
export function redactUserStreamPayload(value: unknown): unknown {
  try {
    if (typeof value === "string") return redactText(value);
    return redactOwners(redactForLog(value), 0);
  } catch {
    return "[unreadable]";
  }
}
