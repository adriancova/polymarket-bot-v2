/**
 * Redaction for everything this package lets out: errors, outcomes, log
 * records (handoff §15: "Logs redact API keys, passphrases, signatures, signed
 * order payloads, and private wallet material"; ADR-007 §11; ADR-010 §6).
 *
 * THE RULE THIS PACKAGE FOLLOWS IS STRUCTURAL, NOT A FILTER. The typed errors
 * and outcomes this package returns are built from an allow-list of fields
 * (a kind, a status number, a documented code, a retry delay, a fixed
 * sentence). No venue or SDK free text, no `cause`, no headers and no request
 * object is ever copied into them, so there is nothing for a filter to miss.
 *
 * {@link redactForLog} is the SECOND line: a deep, cycle-safe copy that a
 * caller may use to log an arbitrary object that might carry a secret (for
 * example a configuration object). It replaces the value under every
 * sensitive-looking key and never reads a getter. It is a heuristic over key
 * NAMES; it does not claim to find a secret embedded in free text, which is
 * why the typed errors above carry no free text at all.
 */

/** The placeholder every redacted value becomes. */
export const REDACTED = "[REDACTED]" as const;

/**
 * Key-name fragments whose values are secret material or a signature, matched
 * case-insensitively after removing `-` and `_`.
 *
 * Sources: the L1/L2 header names and credential fields in
 * `docs/venue/verified-2026-09-30.md` §W.2 (`POLY_SIGNATURE`, `POLY_API_KEY`,
 * `POLY_PASSPHRASE`, `apiKey`, `secret`, `passphrase`), the secret-material
 * names of ADR-010 §3 (`*_PRIVATE_KEY`, `*_BUILDER_*`), and ADR-007 §11
 * (signed order payloads: `signature`, `signedOrder`).
 */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "secret",
  "passphrase",
  "apikey",
  "privatekey",
  "privkey",
  "mnemonic",
  "seed",
  "signature",
  "signedorder",
  "signedpayload",
  "authorization",
  "cookie",
  "credential",
  "polyaddress",
  "polytimestamp",
  "polynonce",
  "polybuilder",
  "password",
  "token", // bearer/session tokens; NOT `tokenId` — see SAFE_EXACT_KEYS
  "key",
]);

/**
 * Keys that contain a sensitive fragment but are public venue identifiers.
 * Compared after the same normalisation. Anything not listed here and
 * containing a fragment above is redacted: over-redaction is the safe side.
 */
const SAFE_EXACT_KEYS: ReadonlySet<string> = new Set(["tokenid", "assetid"]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/gu, "");
}

/** True when a value stored under `key` must be redacted. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SAFE_EXACT_KEYS.has(normalised)) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

const MAX_DEPTH = 16;

/**
 * A deep copy of `value` that is safe to log.
 *
 * - Values under a sensitive key (see {@link isSensitiveKey}) become
 *   {@link REDACTED}, whatever their type.
 * - Getters are never invoked: an accessor property becomes `"[accessor]"`,
 *   so a hostile getter cannot compute a secret at log time.
 * - An `Error` becomes `{ name }` only. Its message, stack and cause are
 *   dropped, because they are free text this function cannot vet.
 * - `Map` keys are treated like object keys; `Set`s become arrays.
 * - Cycles become `"[circular]"`; depth beyond 16 becomes `"[depth]"`.
 * - Functions and symbols become `"[function]"` / `"[symbol]"`; a `bigint`
 *   becomes its decimal string (exact, never a float).
 */
export function redactForLog(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString(10);
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(object);
  try {
    if (object instanceof Error) {
      return { name: safeErrorName(object) };
    }
    if (Array.isArray(object)) {
      return object.map((entry) => redactValue(entry, seen, depth + 1));
    }
    if (object instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of object) {
        const name = typeof key === "string" ? key : String(redactValue(key, seen, depth + 1));
        out[name] = isSensitiveKey(name) ? REDACTED : redactValue(entry, seen, depth + 1);
      }
      return out;
    }
    if (object instanceof Set) {
      return [...object].map((entry) => redactValue(entry, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) continue;
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (!("value" in descriptor)) {
        out[key] = "[accessor]";
      } else {
        out[key] = redactValue(descriptor.value, seen, depth + 1);
      }
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** An error's `name` when it is a plain own or prototype data string, else `"Error"`. */
function safeErrorName(error: Error): string {
  let target: object | null = error;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "name");
    if (descriptor !== undefined) {
      return "value" in descriptor && typeof descriptor.value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(descriptor.value)
        ? descriptor.value
        : "Error";
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return "Error";
}
