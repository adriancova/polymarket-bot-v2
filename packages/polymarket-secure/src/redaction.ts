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
 * - Getters are never invoked: an accessor property (an object key or an
 *   array index) becomes `"[accessor]"`, so a hostile getter cannot compute
 *   a secret at log time. Arrays are read index by index from own data
 *   properties (a hole becomes `undefined`); no iterator is called.
 * - An `Error` becomes `{ name }` only, and the name only when it is one of
 *   the fixed names in {@link LOGGABLE_ERROR_NAMES} (anything else becomes
 *   `"Error"`). Its message, stack and cause are dropped, because they are
 *   free text this function cannot vet.
 * - `Map` keys are treated like object keys; `Set`s become arrays. Both are
 *   read through the built-in `Map`/`Set` iterators, never an own override.
 * - Cycles become `"[circular]"`; depth beyond 16 becomes `"[depth]"`;
 *   collections longer than 10,000 entries become `"[too large]"`.
 * - Functions and symbols become `"[function]"` / `"[symbol]"`; a `bigint`
 *   becomes its decimal string (exact, never a float).
 * - Never throws. An object whose reflection throws (a revoked proxy, a
 *   throwing trap) becomes `"[unreadable]"`; the thrown value is dropped.
 */
export function redactForLog(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}

/**
 * The error names {@link redactForLog} keeps: the standard ECMAScript error
 * classes, this package's own, and the pinned SDK's. A name is free text an
 * error's creator chooses, so only these fixed values are carried.
 */
export const LOGGABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "SecureVenueError",
  "SignerBoundaryRefusal",
  "PolymarketError",
  "UserInputError",
  "UnexpectedResponseError",
  "TransportError",
  "ConnectionLostError",
  "RequestRejectedError",
  "RateLimitError",
  "TimeoutError",
  "TransactionFailedError",
  "CancelledSigningError",
  "InsufficientLiquidityError",
  "AutoCancelDailyLimitError",
  "SigningError",
]);

const MAX_ENTRIES = 10_000;

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
    return redactObject(object, seen, depth);
  } catch {
    // A revoked proxy or a throwing trap: nothing it threw is carried.
    return "[unreadable]";
  } finally {
    seen.delete(object);
  }
}

function redactObject(object: object, seen: WeakSet<object>, depth: number): unknown {
  if (object instanceof Error) {
    return { name: safeErrorName(object) };
  }
  if (Array.isArray(object)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return "[unreadable]";
    if (length > MAX_ENTRIES) return "[too large]";
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
      if (descriptor === undefined) {
        out.push(undefined);
      } else if (!("value" in descriptor)) {
        out.push("[accessor]");
      } else {
        out.push(redactValue(descriptor.value, seen, depth + 1));
      }
    }
    return out;
  }
  if (object instanceof Map) {
    const size = Reflect.apply(sizeOf(Map.prototype), object, []) as number;
    if (size > MAX_ENTRIES) return "[too large]";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Reflect.apply(Map.prototype.entries, object, []) as IterableIterator<[unknown, unknown]>) {
      const name = typeof key === "string" ? key : String(redactValue(key, seen, depth + 1));
      out[name] = isSensitiveKey(name) ? REDACTED : redactValue(entry, seen, depth + 1);
    }
    return out;
  }
  if (object instanceof Set) {
    const size = Reflect.apply(sizeOf(Set.prototype), object, []) as number;
    if (size > MAX_ENTRIES) return "[too large]";
    const out: unknown[] = [];
    for (const entry of Reflect.apply(Set.prototype.values, object, []) as IterableIterator<unknown>) {
      out.push(redactValue(entry, seen, depth + 1));
    }
    return out;
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
}

/** The built-in `size` getter of `Map.prototype` / `Set.prototype`. */
function sizeOf(prototype: object): () => number {
  const getter = Object.getOwnPropertyDescriptor(prototype, "size")?.get;
  if (getter === undefined) throw new TypeError("size");
  return getter as () => number;
}

/**
 * An error's `name` when it is a plain own or prototype DATA string AND one of
 * {@link LOGGABLE_ERROR_NAMES}; otherwise `"Error"`.
 */
function safeErrorName(error: Error): string {
  let target: object | null = error;
  for (let hops = 0; target !== null && hops < MAX_DEPTH; hops += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "name");
    if (descriptor !== undefined) {
      return "value" in descriptor && typeof descriptor.value === "string" && LOGGABLE_ERROR_NAMES.has(descriptor.value)
        ? descriptor.value
        : "Error";
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return "Error";
}
