/**
 * WP-290 r3: break SUBJECTS that name one venue object (`subjects.ts`; D-A2, D-O1).
 *
 * The journal keeps a break's subject key durably and nothing else that names a venue order or trade, so the
 * coordinator decodes the key to read every order an unresolved hold names by id (after a restart too), and to
 * clear such a break only by a run that read that order or trade. These pin the decoder: a composite key decodes
 * to exactly its parts and nothing else does, and each subject shape the coordinator builds names its venue
 * object, while every other subject names none.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import { decodeCompositeKey, venueSubjectOf } from "../../../packages/oms/src/reconciliation/subjects.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

describe("break subjects that name one venue object (subjects.ts; r3, D-A2 and D-O1)", () => {
  it("a composite key decodes to exactly its parts, separators and digits inside a part included; anything else is refused", () => {
    for (const parts of [["READ_MISSING", "trades"], ["a"], ["x:1;", "2:y;", ""], ["ORDER_UNRESOLVED", "venue-order", "0xabc"]]) {
      expect(decodeCompositeKey(compositeKey(...parts))).toEqual(parts);
    }
    for (const text of ["", "trades", "5:trades", "6:trades;x", "06:trades;", "6;trades;", "7:trades;", "a:b;", "1234567:x;"]) {
      expect(decodeCompositeKey(text), text).toBeUndefined();
    }
  });

  it("names the venue order or trade of each subject shape the coordinator builds, and nothing else", () => {
    expect(venueSubjectOf("READ_CONFLICT", compositeKey("READ_CONFLICT", "order", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    expect(venueSubjectOf("READ_REGRESSION", compositeKey("READ_REGRESSION", "order", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    expect(venueSubjectOf("STATUS_UNRECOGNISED", compositeKey("STATUS_UNRECOGNISED", "order", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    expect(venueSubjectOf("READ_REGRESSION", compositeKey("READ_REGRESSION", "trade", "trade-1"))).toEqual({ kind: "trade", id: "trade-1" });
    expect(venueSubjectOf("STATUS_UNRECOGNISED", compositeKey("STATUS_UNRECOGNISED", "trade", "trade-1"))).toEqual({ kind: "trade", id: "trade-1" });
    expect(venueSubjectOf("READ_INCOMPLETE", compositeKey("READ_INCOMPLETE", "trade", "trade-1"))).toEqual({ kind: "trade", id: "trade-1" });
    // A by-id read's problem: the order is a nested key.
    for (const breakClass of ["READ_MISSING", "READ_MALFORMED", "READ_INCOMPLETE", "READ_WRONG_ROUTE"] as const) {
      expect(venueSubjectOf(breakClass, compositeKey(breakClass, compositeKey("order", "venue-1")))).toEqual({ kind: "order", id: "venue-1" });
    }
    expect(venueSubjectOf("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", "venue-order", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    // Not a venue object: a whole read, an attempt, an OMS order, another class's subject, a class mismatch.
    expect(venueSubjectOf("READ_MISSING", compositeKey("READ_MISSING", "trades"))).toBeNull();
    expect(venueSubjectOf("READ_MISSING", compositeKey("READ_MISSING", "open-orders"))).toBeNull();
    expect(venueSubjectOf("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", uuid7(0x9, 1)))).toBeNull();
    expect(venueSubjectOf("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", "order", uuid7(0xf, 1)))).toBeNull();
    expect(venueSubjectOf("ORDER_UNATTRIBUTED", compositeKey("ORDER_UNATTRIBUTED", "venue-1"))).toBeNull();
    expect(venueSubjectOf("FILL_MISMATCH", compositeKey("FILL_MISMATCH", uuid7(0xf, 1)))).toBeNull();
    expect(venueSubjectOf("READ_CONFLICT", compositeKey("READ_REGRESSION", "order", "venue-1"))).toBeNull();
    expect(venueSubjectOf("READ_CONFLICT", compositeKey("READ_CONFLICT", "order", ""))).toBeNull();
    expect(venueSubjectOf("READ_CONFLICT", "not a key")).toBeNull();
  });
});
