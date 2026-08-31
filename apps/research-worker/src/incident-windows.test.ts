import { describe, expect, it } from "vitest";

import {
  IncidentWindowFileError,
  loadIncidentWindows,
  parseIncidentWindowDocument,
} from "./incident-windows.js";

const valid = [
  {
    incidentId: "inc-1",
    kind: "gap",
    gatewayEpoch: "epoch-a",
    fromIngestSeq: "10",
    toIngestSeq: "20",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:01:00.000Z",
    reason: "market channel gap during resubscribe",
  },
];

describe("parseIncidentWindowDocument", () => {
  it("accepts a well-formed document", () => {
    expect(parseIncidentWindowDocument(valid)).toHaveLength(1);
  });

  it("accepts an open incident, whose closedAt is null", () => {
    const open = [{ ...valid[0], closedAt: null }];
    expect(parseIncidentWindowDocument(open)[0]?.closedAt).toBeNull();
  });

  it("rejects a non-array document", () => {
    expect(() => parseIncidentWindowDocument({})).toThrow(IncidentWindowFileError);
  });

  it("rejects an unknown incident kind rather than mapping it to 'other'", () => {
    expect(() => parseIncidentWindowDocument([{ ...valid[0], kind: "mystery" }])).toThrow(
      /kind must be one of/u,
    );
  });

  it("rejects a missing field", () => {
    const withoutReason: Record<string, unknown> = { ...valid[0] };
    delete withoutReason["reason"];
    expect(() => parseIncidentWindowDocument([withoutReason])).toThrow(/reason/u);
  });

  it("rejects an inverted range, which would exclude nothing", () => {
    expect(() =>
      parseIncidentWindowDocument([{ ...valid[0], fromIngestSeq: "30", toIngestSeq: "20" }]),
    ).toThrow(/must not be greater than/u);
  });

  it("rejects a non-canonical ingest sequence", () => {
    expect(() => parseIncidentWindowDocument([{ ...valid[0], fromIngestSeq: "010" }])).toThrow(
      /canonical unsigned integer/u,
    );
  });

  it("rejects duplicate incident ids", () => {
    expect(() => parseIncidentWindowDocument([valid[0], valid[0]])).toThrow(/duplicate/u);
  });
});

describe("loadIncidentWindows", () => {
  it("returns no windows when none are configured", async () => {
    expect(await loadIncidentWindows(null)).toStrictEqual([]);
  });

  it("fails loudly when a configured file is missing", async () => {
    // A configured-but-unreadable exclusion list must not silently become "no
    // incidents": the resulting manifest would be indistinguishable from a
    // clean recording.
    await expect(loadIncidentWindows("/nonexistent/windows.json")).rejects.toBeInstanceOf(
      IncidentWindowFileError,
    );
  });
});
