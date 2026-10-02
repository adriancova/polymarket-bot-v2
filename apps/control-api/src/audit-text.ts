/**
 * AUDIT TEXT — the one place a control-plane audit record's strings are made
 * safe to store and to read (`CONTROL-1b`, closing `CONTROL-1` follow-up 3c and
 * the joint INFO `CONTROL1-R2-J-I2`).
 *
 * ## The problem
 *
 * An audit record carries text a caller chose: the operator's stated reason,
 * a kill switch's `scopeRef`, the keys of an over-full request body (a door
 * refusal's issues), a request path. Some code points in that text break the
 * durable home, and some make the record read as something it is not:
 *
 * - **NUL** (`U+0000`). PostgreSQL `text` cannot hold it, and `jsonb` refuses
 *   the `\u0000` escape the encoder writes for it. A record carrying one is an
 *   append the `ops` tables refuse — so, because the control plane audits
 *   before it applies, a refusal that cannot be recorded, or a kill-switch
 *   engage refused `503`.
 * - **A lone surrogate** (`U+D800`–`U+DFFF` outside a pair). The own-data
 *   encoder writes it as a `\udXXX` escape (the ES2019 well-formed rule), which
 *   `jsonb` refuses; in a `text` column the driver's UTF-8 encoding silently
 *   replaces it with `U+FFFD`, so the database would hold different text from
 *   the in-memory log.
 * - **Other controls and format characters** (`\p{Cc}`, `\p{Cf}`, `U+2028`,
 *   `U+2029`): `ESC` sequences that drive a terminal an auditor reads the log
 *   in, `U+202E` that visually reverses what follows it, zero-width characters
 *   that make two different ids look equal. None of them breaks PostgreSQL; all
 *   of them make a record read untruthfully.
 *
 * ## The rule: escape, once, at one chokepoint
 *
 * {@link auditSafeRecord} rewrites EVERY string in a record — each field and
 * every string and key of both state documents — with {@link escapeAuditText},
 * and `ControlPlane` passes every record it writes through it, after building
 * the record and before any sink sees it. So the in-memory log and the
 * PostgreSQL tables receive the SAME record object, and no record this process
 * writes can hold a code point above. Nothing is dropped and nothing is
 * replaced by a look-alike: each such code point becomes the visible escape
 * `\u{HEX}` (upper-case hex, no padding) — `NUL` is `\u{0}`, `U+202E` is
 * `\u{202E}`, a lone `U+D800` is `\u{D800}`.
 *
 * The escape is INJECTIVE, so a record can always be read back exactly: a
 * backslash that the caller wrote immediately before `u{` is itself escaped,
 * as `\u{5C}`. Without that, a caller typing the six characters `\u{0}` would
 * produce the same record as a caller sending a NUL. Every other backslash —
 * and every other character — is left as it is, so ordinary text is
 * byte-identical before and after (`audit-text.test.ts` decodes it back).
 *
 * The STATE the control plane holds is not rewritten: a kill switch engaged
 * with a reason holding `U+202E` keeps that reason, and the record shows it
 * escaped. The record presents; the state is what it presents.
 *
 * ## Bounds are measured on what is stored, and never split a code point
 *
 * Two kinds of bound use it. A refusal's caller-chosen text (its issues, its
 * detail, a mode-raise attempt's keys) is cut to `REFUSAL_AUDIT_MAX_TEXT` by
 * the control plane. And {@link auditSafeRecord} cuts the three fields that
 * land in a BOUNDED column of the §10.6 tables — `actor`, `scopeRef`,
 * `reason` — to that column's domain, because escaping lengthens text and must
 * never be what makes a durable append fail.
 *
 * {@link boundAuditText} cuts a caller's text so that its ESCAPED form is at
 * most `max` UTF-16 code units, `…` included, and it cuts only between code
 * points — never inside a surrogate pair, so a bound can never MAKE a lone
 * surrogate, and never inside an escape. It returns the RAW prefix; the
 * chokepoint escapes it with everything else, exactly once.
 */

import type { AuditStateDocument, ControlAuditRecord } from "@polymarket-bot/observability";

/** One code point an audit record never carries raw (module header). */
const ESCAPED_CODE_POINT = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]$/u;

/** Whether `text` holds anything {@link escapeAuditText} rewrites. */
const NEEDS_ESCAPE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|\\u\{/u;

/** The marker a cut text ends with. One UTF-16 code unit, and never escaped. */
export const AUDIT_TEXT_ELLIPSIS = "…";

/**
 * The §10.6 `internal.identifier` bound (`db/migrations/0001_foundation.up.sql`,
 * `identifier_bounded`: 1 to 200 characters) — the domain of the `actor`,
 * `scope_ref` and `target_id` columns a record's `actor` and `scopeRef` land in.
 */
export const AUDIT_IDENTIFIER_MAX_TEXT = 200;

/**
 * The §10.6 `internal.detail` bound (`detail_bounded`: at most 2000
 * characters) — the domain of the `reason` column.
 */
export const AUDIT_REASON_MAX_TEXT = 2_000;

function escapeOf(point: string): string {
  return `\\u{${(point.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
}

/** True when the backslash at `index` begins `\u{` and must be escaped itself. */
function backslashOpensEscape(text: string, index: number): boolean {
  return text.startsWith("u{", index + 1);
}

/**
 * `text` with every control, format, separator and lone-surrogate code point
 * written as `\u{HEX}`, and every `\` that begins `\u{` written as `\u{5C}`.
 * Ordinary text is returned unchanged. TOTAL and injective.
 */
export function escapeAuditText(text: string): string {
  if (!NEEDS_ESCAPE.test(text)) return text;
  let out = "";
  let index = 0;
  for (const point of text) {
    if (ESCAPED_CODE_POINT.test(point)) out += escapeOf(point);
    else if (point === "\\" && backslashOpensEscape(text, index)) out += "\\u{5C}";
    else out += point;
    index += point.length;
  }
  return out;
}

/**
 * The longest RAW prefix of `text` — cut between code points — whose escaped
 * form, with {@link AUDIT_TEXT_ELLIPSIS} appended, is at most `max` UTF-16
 * code units; or `text` itself when its escaped form already fits.
 *
 * Linear, and it stops reading at the cut, so a megabyte of input costs no
 * more than the bound. A backslash that opens `\u{` in the full text is
 * charged its escaped length even when the cut separates it from the `u{`, so
 * the bound can only be met early, never exceeded.
 */
export function boundAuditText(text: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`an audit text bound must be a positive safe integer; received ${String(max)}`);
  }
  let cost = 0;
  let cut = 0;
  let index = 0;
  for (const point of text) {
    const charge = ESCAPED_CODE_POINT.test(point)
      ? escapeOf(point).length
      : point === "\\" && backslashOpensEscape(text, index)
        ? "\\u{5C}".length
        : point.length;
    const next = cost + charge;
    if (next > max) return `${text.slice(0, cut)}${AUDIT_TEXT_ELLIPSIS}`;
    index += point.length;
    if (next <= max - AUDIT_TEXT_ELLIPSIS.length) cut = index;
    cost = next;
  }
  return text;
}

/**
 * A copy of `document` whose every string and every key went through
 * {@link escapeAuditText}, built from ORDINARY containers whatever species it
 * was handed (an index walk into an array literal, own enumerable keys into an
 * object literal by `defineProperty`, so no key — `__proto__` included — is
 * read as anything but data).
 */
export function auditSafeDocument(document: AuditStateDocument): AuditStateDocument {
  if (typeof document === "string") return escapeAuditText(document);
  if (typeof document !== "object" || document === null) return document;
  if (Array.isArray(document)) {
    const items = document as readonly AuditStateDocument[];
    const out: AuditStateDocument[] = [];
    for (let index = 0; index < items.length; index += 1) {
      out.push(auditSafeDocument(items[index] as AuditStateDocument));
    }
    return out;
  }
  const source = document as { readonly [key: string]: AuditStateDocument };
  const out: Record<string, AuditStateDocument> = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(out, escapeAuditText(key), {
      value: auditSafeDocument(source[key] as AuditStateDocument),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** `text` cut to `max` stored code units, then escaped — once. */
function storedWithin(text: string, max: number): string {
  return escapeAuditText(boundAuditText(text, max));
}

/**
 * The record every sink receives: `record` with every string escaped exactly
 * once (module header). `action`, `outcome` and `actorKind` are closed
 * vocabularies and pass through as they are.
 *
 * The three fields that land in BOUNDED text columns are also cut to their
 * column's domain, measured on the escaped text: `actor` and `scopeRef` to
 * {@link AUDIT_IDENTIFIER_MAX_TEXT}, `reason` to {@link AUDIT_REASON_MAX_TEXT}.
 * Escaping lengthens text — a reason of 1024 NULs, which the API accepts, is
 * 5120 characters escaped — so without the cut the escape would itself make a
 * durable append fail. Nothing the API accepts in an ordinary request is
 * cut: a reason is at most 1024 characters and a market or instance reference
 * far shorter than 200. A cut column is marked `…`, and the state documents —
 * `jsonb`, which no domain bounds — keep the whole escaped value, so a cut
 * `scope_ref` never loses which switch or instance a record is about.
 */
export function auditSafeRecord(record: ControlAuditRecord): ControlAuditRecord {
  return {
    recordId: escapeAuditText(record.recordId),
    action: record.action,
    outcome: record.outcome,
    actor: storedWithin(record.actor, AUDIT_IDENTIFIER_MAX_TEXT),
    actorKind: record.actorKind,
    scope: escapeAuditText(record.scope),
    scopeRef: record.scopeRef === null ? null : storedWithin(record.scopeRef, AUDIT_IDENTIFIER_MAX_TEXT),
    reason: storedWithin(record.reason, AUDIT_REASON_MAX_TEXT),
    priorState: auditSafeDocument(record.priorState),
    resultingState: auditSafeDocument(record.resultingState),
    at: escapeAuditText(record.at),
  };
}
