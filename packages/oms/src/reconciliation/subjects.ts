/**
 * Break SUBJECTS that name one venue object (WP-290, r3: D-A2, D-O1).
 *
 * A break's subject key is a `compositeKey` (`guards.ts`): each part
 * length-prefixed, so the key decodes to exactly the parts it was built from.
 * The journal keeps the key durably; it carries no venue order or trade id of
 * its own. Two rules need that id back, after a restart too:
 *
 * - every venue order an unresolved hold names is READ BY ID in every run
 *   (E-14: an order absent from the open-orders list is not proof of
 *   cancellation; resolve missing orders by id), so an id seen once is never
 *   forgotten while a break still names it;
 * - such a break is cleared only by a run that actually READ that order (or,
 *   for a trade, whose trades read showed that trade): a run that did not
 *   look did not judge it.
 *
 * The subjects that name one venue object (built in `coordinator.ts`):
 *
 * | Classes | Subject parts | Names |
 * | --- | --- | --- |
 * | `READ_CONFLICT`, `READ_REGRESSION`, `STATUS_UNRECOGNISED`, `READ_INCOMPLETE` | `[class, "order", id]` | venue order `id` |
 * | the same, and `READ_MISSING`, `READ_MALFORMED`, `READ_WRONG_ROUTE` | `[class, compositeKey("order", id)]` (a by-id read's problem) | venue order `id` |
 * | `READ_CONFLICT`, `READ_REGRESSION`, `STATUS_UNRECOGNISED`, `READ_INCOMPLETE` | `[class, "trade", id]` | venue trade `id` (r7: a durable contradiction of its economics, or a shown trade a complete read omits, included) |
 * | `ORDER_UNRESOLVED` | `[class, "venue-order", id]` or `[class, "venue-order-named", id]` (r4) | venue order `id` |
 * | `ORDER_NOT_FOUND_BY_ID` (r4; r6 occurrences) | `[class, id]`, or `[class, id, n]` for the occurrence after `n` released ones | venue order `id` |
 * | `SETTLEMENT_REVERSAL_OWED` (r4) | `[class, trade, order]` | venue trade `trade` |
 *
 * Every other subject names no venue object here (`ORDER_UNRESOLVED` by
 * attempt or by OMS order names this system's ids, not the venue's).
 *
 * PROVENANCE (r4, WP290-CX-R4-01, WP290-V4-GHOST-ID-PERMANENT-HOLD): a subject
 * that names a venue order says whether a read SHOWED that order in full (a
 * conflict, a regression or an unrecognised status keyed by the order; an
 * `ORDER_UNRESOLVED` keyed by `venue-order`) or only NAMED it (a by-id read's
 * problem; an `ORDER_UNRESOLVED` keyed by `venue-order-named`; an
 * `ORDER_NOT_FOUND_BY_ID`). See {@link namesOrderOnly}.
 *
 * Pure. No I/O, no clock, no randomness, no float coercion.
 */

import { compositeKey } from "../guards.js";

import type { BreakClass } from "./ports.js";

/** The read-problem classes whose subject may name one venue order or trade. */
const READ_SUBJECT_CLASSES: readonly BreakClass[] = [
  "READ_MISSING",
  "READ_MALFORMED",
  "READ_INCOMPLETE",
  "READ_WRONG_ROUTE",
  "READ_CONFLICT",
  "READ_REGRESSION",
  "STATUS_UNRECOGNISED",
];

/** The longest length prefix accepted (a part is a short id; nothing near this is ever built). */
const MAX_LENGTH_DIGITS = 6;

/**
 * The parts a `compositeKey` was built from, or `undefined` when the text is not one (strictly: the parts must
 * re-encode to exactly the same text, so a padded length or trailing text is refused).
 */
export function decodeCompositeKey(key: string): readonly string[] | undefined {
  const parts: string[] = [];
  let at = 0;
  while (at < key.length) {
    let length = 0;
    let digits = 0;
    while (at < key.length) {
      const code = key.charCodeAt(at);
      if (code < 48 || code > 57) break;
      length = length * 10 + (code - 48);
      digits += 1;
      at += 1;
      if (digits > MAX_LENGTH_DIGITS) return undefined;
    }
    if (digits === 0 || key[at] !== ":") return undefined;
    at += 1;
    if (at + length >= key.length || key[at + length] !== ";") return undefined;
    parts.push(key.slice(at, at + length));
    at += length + 1;
  }
  if (parts.length === 0 || compositeKey(...parts) !== key) return undefined;
  return parts;
}

/** The one venue object a break's subject names. */
export interface VenueSubject {
  readonly kind: "order" | "trade";
  readonly id: string;
}

/** The venue order or trade a break of this class names through its subject key, or `null` (see the header). */
export function venueSubjectOf(breakClass: BreakClass, subjectKey: string): VenueSubject | null {
  const parts = decodeCompositeKey(subjectKey);
  if (parts === undefined || parts[0] !== breakClass) return null;
  if (READ_SUBJECT_CLASSES.includes(breakClass)) {
    const [, kind, id] = parts;
    if (parts.length === 3 && (kind === "order" || kind === "trade") && id !== undefined && id.length > 0) return { kind, id };
    if (parts.length === 2 && kind !== undefined) {
      const inner = decodeCompositeKey(kind);
      const innerId = inner?.[1];
      if (inner !== undefined && inner.length === 2 && inner[0] === "order" && innerId !== undefined && innerId.length > 0) return { kind: "order", id: innerId };
    }
    return null;
  }
  if (breakClass === "ORDER_UNRESOLVED" && parts.length === 3 && (parts[1] === "venue-order" || parts[1] === "venue-order-named")) {
    const id = parts[2];
    if (id !== undefined && id.length > 0) return { kind: "order", id };
  }
  if (breakClass === "ORDER_NOT_FOUND_BY_ID" && (parts.length === 2 || (parts.length === 3 && /^[1-9][0-9]{0,8}$/u.test(parts[2] ?? "")))) {
    const id = parts[1];
    if (id !== undefined && id.length > 0) return { kind: "order", id };
  }
  if (breakClass === "SETTLEMENT_REVERSAL_OWED" && parts.length === 3) {
    const id = parts[1];
    if (id !== undefined && id.length > 0) return { kind: "trade", id };
  }
  return null;
}

/**
 * Whether a subject that names a venue order only NAMED it (see the header's provenance): no read showed that
 * order in full, so a by-id read that does not find it is not a contradiction of an earlier read. `false` for a
 * subject that names a venue order a read showed, and for one that names no venue order.
 */
export function namesOrderOnly(breakClass: BreakClass, subjectKey: string): boolean {
  const named = venueSubjectOf(breakClass, subjectKey);
  if (named === null || named.kind !== "order") return false;
  if (breakClass === "ORDER_NOT_FOUND_BY_ID") return true;
  const parts = decodeCompositeKey(subjectKey) as readonly string[];
  if (breakClass === "ORDER_UNRESOLVED") return parts[1] === "venue-order-named";
  // A read problem keyed `[class, compositeKey("order", id)]` is a by-id read's: it did not show the order.
  return READ_SUBJECT_CLASSES.includes(breakClass) && parts.length === 2;
}
