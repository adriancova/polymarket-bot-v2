import { describe, expect, it } from "vitest";

import { validateIngestMeta } from "./ingest.js";

const EPOCH = "018f0000-0000-7000-8000-00000000000a";

describe("validateIngestMeta", () => {
  it("accepts a full meta and derives comparison values", () => {
    const result = validateIngestMeta({
      gatewayEpoch: EPOCH,
      ingestSeq: "42",
      subscriptionGeneration: 3,
      venueTimestamp: "2026-09-02T11:59:59.000Z",
      receivedAt: "2026-09-02T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.ingestSeqValue).toBe(42n);
      expect(result.meta.receivedAtEpochMs).toBe(Date.parse("2026-09-02T12:00:00.000Z"));
    }
  });

  it("accepts a minimal meta (generation and timestamps optional at this layer)", () => {
    const result = validateIngestMeta({ gatewayEpoch: EPOCH, ingestSeq: "0" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.subscriptionGeneration).toBeUndefined();
      expect(result.meta.receivedAtEpochMs).toBeUndefined();
    }
  });

  it("refuses a UUID-shaped but non-canonical gatewayEpoch with the raw value (ADR-016: refuse, never case-fold)", () => {
    const raw = EPOCH.toUpperCase();
    const result = validateIngestMeta({ gatewayEpoch: raw, ingestSeq: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ORDER_BOOK_UUID_NOT_CANONICAL");
      expect(result.refusal.evidence).toEqual({ gatewayEpoch: raw });
    }
  });

  it("refuses a gatewayEpoch that is not UUID-shaped at all", () => {
    const result = validateIngestMeta({ gatewayEpoch: "epoch-1", ingestSeq: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ORDER_BOOK_INGEST_META_INVALID");
    }
  });

  it.each(["", "-1", "1.5", "01", "1e3", "seq"])(
    "refuses a non-canonical ingestSeq %j",
    (ingestSeq) => {
      const result = validateIngestMeta({ gatewayEpoch: EPOCH, ingestSeq });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("ORDER_BOOK_INGEST_META_INVALID");
      }
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses subscriptionGeneration %j (WP-070 generations start at 1)",
    (subscriptionGeneration) => {
      const result = validateIngestMeta({
        gatewayEpoch: EPOCH,
        ingestSeq: "1",
        subscriptionGeneration,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("ORDER_BOOK_INGEST_META_INVALID");
      }
    },
  );

  it("refuses non-ISO timestamps", () => {
    for (const field of ["venueTimestamp", "receivedAt"] as const) {
      const result = validateIngestMeta({
        gatewayEpoch: EPOCH,
        ingestSeq: "1",
        [field]: "1782753357257",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("ORDER_BOOK_INGEST_META_INVALID");
      }
    }
  });
});
