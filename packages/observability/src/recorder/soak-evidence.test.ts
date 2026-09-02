import { describe, expect, it } from "vitest";

import {
  SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS,
  SOAK_EVIDENCE_KIND,
  SOAK_EVIDENCE_SCHEMA_VERSION,
  disqualifyingReason,
  evaluateSoakEvidence,
  parseSoakWindowEvidence,
  type SoakWindowEvidence,
} from "./soak-evidence.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/** A valid, qualifying evidence window ending `elapsedMs` before NOW. */
function window(elapsedMs: number, overrides: Partial<SoakWindowEvidence> = {}): SoakWindowEvidence {
  const endedAtMs = NOW - 60_000;
  return {
    schemaVersion: SOAK_EVIDENCE_SCHEMA_VERSION,
    kind: SOAK_EVIDENCE_KIND,
    harness: "test/soak/recorder/run-soak.mjs",
    startedAt: new Date(endedAtMs - elapsedMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs,
    exit: { code: 0, signal: null, cleanShutdown: true, forcedKill: false },
    observed: {
      runningBannerSeen: true,
      recordingOnly: true,
      shutdownLogSeen: true,
      cleanupDeadlineExpired: false,
      disposalFailures: 0,
      incidents: 1,
      halts: 1,
      walRecordingFailures: 0,
    },
    wal: { epochs: 1, segments: 2, records: 100, bytes: 50_000, unexplainedGapSignals: 0 },
    ...overrides,
  };
}

describe("the threshold", () => {
  it("is 24 hours — the documented conservative assumption", () => {
    expect(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS).toBe(86_400_000);
  });
});

describe("parseSoakWindowEvidence", () => {
  it("accepts a well-formed record", () => {
    const parsed = parseSoakWindowEvidence(JSON.parse(JSON.stringify(window(5_000))));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["not an object", "nope"],
    ["wrong schemaVersion", { ...window(5_000), schemaVersion: 2 }],
    ["wrong kind", { ...window(5_000), kind: "recorder-soak" }],
    ["empty harness", { ...window(5_000), harness: "" }],
    ["unparseable startedAt", { ...window(5_000), startedAt: "yesterday" }],
    ["unparseable endedAt", { ...window(5_000), endedAt: "later" }],
    ["negative elapsedMs", { ...window(5_000), elapsedMs: -1 }],
    ["fractional elapsedMs", { ...window(5_000), elapsedMs: 1.5 }],
    ["missing exit", { ...window(5_000), exit: undefined }],
    ["malformed exit", { ...window(5_000), exit: { code: "0" } }],
    ["malformed observed", { ...window(5_000), observed: { runningBannerSeen: "yes" } }],
    ["malformed wal", { ...window(5_000), wal: { segments: -1 } }],
    ["non-string notes", { ...window(5_000), notes: 7 }],
  ])("refuses %s", (_label, record) => {
    expect(parseSoakWindowEvidence(record).ok).toBe(false);
  });
});

describe("evaluateSoakEvidence — the fail-closed gate", () => {
  it("no records: PENDING, explicitly", () => {
    const evaluation = evaluateSoakEvidence([], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.validWindows).toBe(0);
    expect(evaluation.reasons.at(-1)).toContain("no evidence windows exist yet");
  });

  it("a short smoke window: PENDING, with the honest arithmetic in the reasons", () => {
    const evaluation = evaluateSoakEvidence([window(4_000)], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.longestQualifyingWindowMs).toBe(4_000);
    expect(evaluation.thresholdMs).toBe(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    expect(evaluation.reasons.at(-1)).toContain("4000 ms of the required 86400000 ms");
  });

  it("a qualifying window at the threshold: SATISFIED", () => {
    const evaluation = evaluateSoakEvidence(
      [window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS)],
      NOW,
    );
    expect(evaluation.status).toBe("SATISFIED");
  });

  it("two shorter windows do NOT sum to satisfaction — sustained means one window", () => {
    const half = SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS / 2 + 1_000;
    const evaluation = evaluateSoakEvidence([window(half), window(half)], NOW);
    expect(evaluation.status).toBe("PENDING");
  });

  it("a long window with unexplained gap signals cannot satisfy", () => {
    const gappy = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      wal: { epochs: 1, segments: 5, records: 900, bytes: 1_000, unexplainedGapSignals: 2 },
    });
    const evaluation = evaluateSoakEvidence([gappy], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.longestWindowMs).toBe(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    expect(evaluation.longestQualifyingWindowMs).toBe(0);
    expect(evaluation.reasons.join("\n")).toContain("unexplained-gap signal");
  });

  it("a long window without a clean shutdown cannot satisfy", () => {
    const dirty = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      exit: { code: 1, signal: null, cleanShutdown: false, forcedKill: false },
    });
    expect(evaluateSoakEvidence([dirty], NOW).status).toBe("PENDING");
  });

  it("a long window that never showed the running banner cannot satisfy", () => {
    const bannerless = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    const record = {
      ...bannerless,
      observed: { ...bannerless.observed, runningBannerSeen: false },
    };
    expect(evaluateSoakEvidence([record], NOW).status).toBe("PENDING");
  });

  it("a record claiming elapsed that its timestamps contradict: INVALID", () => {
    const lying = { ...window(10_000), elapsedMs: SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS };
    const evaluation = evaluateSoakEvidence([lying], NOW);
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.reasons.join("\n")).toContain("disagrees with the timestamps");
  });

  it("timestamps stretched to the threshold but a contradicting claim: INVALID (no side wins)", () => {
    const lying = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, { elapsedMs: 10_000 });
    expect(evaluateSoakEvidence([lying], NOW).status).toBe("INVALID");
  });

  it("evidence ending in the future: INVALID — that time has not elapsed", () => {
    const future = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    const record = {
      ...future,
      startedAt: new Date(NOW).toISOString(),
      endedAt: new Date(NOW + SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS).toISOString(),
    };
    const evaluation = evaluateSoakEvidence([record], NOW);
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.reasons.join("\n")).toContain("future");
  });

  it("endedAt before startedAt: INVALID", () => {
    const backwards = window(5_000);
    const record = { ...backwards, startedAt: backwards.endedAt, endedAt: backwards.startedAt };
    expect(evaluateSoakEvidence([record], NOW).status).toBe("INVALID");
  });

  it("one bad record poisons the set: INVALID even next to a satisfying window", () => {
    const evaluation = evaluateSoakEvidence(
      [window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS), { tampered: true }],
      NOW,
    );
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.invalidRecords).toBe(1);
    expect(evaluation.reasons.join("\n")).toContain("does not skip bad evidence");
  });

  it("a window that recorded nothing cannot satisfy", () => {
    const empty = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      wal: { epochs: 1, segments: 0, records: 0, bytes: 0, unexplainedGapSignals: 0 },
    });
    const evaluation = evaluateSoakEvidence([empty], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.reasons.join("\n")).toContain("must demonstrate recording");
  });
});

describe("disqualifyingReason", () => {
  it("returns null for a qualifying window", () => {
    expect(disqualifyingReason(window(1_000))).toBeNull();
  });

  it("names the cleanup-deadline forced exit", () => {
    const forced = window(1_000);
    expect(
      disqualifyingReason({
        ...forced,
        observed: { ...forced.observed, cleanupDeadlineExpired: true },
      }),
    ).toContain("cleanup deadline");
  });

  it("names a forced kill", () => {
    const forced = window(1_000);
    expect(
      disqualifyingReason({
        ...forced,
        exit: { ...forced.exit, forcedKill: true },
      }),
    ).toContain("force-kill");
  });
});
