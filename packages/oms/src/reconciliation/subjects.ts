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
 * | `READ_REGRESSION`, `STATUS_UNRECOGNISED`, `READ_INCOMPLETE` | `[class, "trade", id]` | venue trade `id` |
 * | `ORDER_UNRESOLVED` | `[class, "venue-order", id]` | venue order `id` |
 *
 * Every other subject names no venue object here (`ORDER_UNRESOLVED` by
 * attempt or by OMS order names this system's ids, not the venue's).
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
  if (breakClass === "ORDER_UNRESOLVED" && parts.length === 3 && parts[1] === "venue-order") {
    const id = parts[2];
    if (id !== undefined && id.length > 0) return { kind: "order", id };
  }
  return null;
}
