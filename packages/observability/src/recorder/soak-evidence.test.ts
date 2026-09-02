import { describe, expect, it } from "vitest";

import {
  SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS,
  SOAK_EVIDENCE_KIND,
  SOAK_EVIDENCE_SCHEMA_VERSION,
  consistencyViolation,
  derivedCleanShutdown,
  derivedUnexplainedGapSignals,
  disqualifyingReason,
  evaluateSoakEvidence,
  parseSoakWindowEvidence,
  type SoakStatus,
  type SoakWindowEvidence,
} from "./soak-evidence.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/** A valid, structurally qualifying evidence window ending before NOW. */
function window(elapsedMs: number, overrides: Partial<SoakWindowEvidence> = {}): SoakWindowEvidence {
  const endedAtMs = NOW - 60_000;
  return {
    schemaVersion: SOAK_EVIDENCE_SCHEMA_VERSION,
    kind: SOAK_EVIDENCE_KIND,
    harness: "test/soak/recorder/run-soak.mjs",
    startedAt: new Date(endedAtMs - elapsedMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs,
    exit: { code: 0, signal: null, shutdownRequested: true, forcedKill: false },
    observed: {
      runningBannerSeen: true,
      recordingOnly: true,
      shutdownLogSeen: true,
      cleanupDeadlineExpired: false,
      disposalFailures: 0,
      incidents: 1,
      gapIncidents: 0,
      halts: 1,
      walRecordingFailures: 0,
    },
    wal: { epochs: 1, segments: 2, records: 100, bytes: 50_000 },
    ...overrides,
  };
}

describe("the threshold", () => {
  it("is 24 hours — the documented conservative assumption", () => {
    expect(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS).toBe(86_400_000);
  });
});

describe("the verdict lattice", () => {
  it("has no state named or presentable as final external-evidence satisfaction", () => {
    // The terminal BEST state is a candidate. This pins the whole domain: if
    // anyone reintroduces a completion-shaped status, this test names it.
    const domain: readonly SoakStatus[] = ["PENDING", "QUALIFYING_WINDOW_FOUND", "INVALID"];
    for (const status of domain) {
      expect(status).not.toContain("SATISFIED");
      expect(status.toUpperCase()).not.toContain("COMPLETE");
      expect(status.toUpperCase()).not.toContain("PASSED");
      expect(status.toUpperCase()).not.toContain("VERIFIED");
    }
  });
});

describe("parseSoakWindowEvidence", () => {
  it("accepts a well-formed record", () => {
    const parsed = parseSoakWindowEvidence(JSON.parse(JSON.stringify(window(5_000))));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["not an object", "nope"],
    ["wrong schemaVersion", { ...window(5_000), schemaVersion: 3 }],
    ["v1 schemaVersion (derived-field era)", { ...window(5_000), schemaVersion: 1 }],
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

  describe("exact-key rejection (round-1 BLOCKER, part b)", () => {
    it("refuses a smuggled top-level status key, naming it", () => {
      const parsed = parseSoakWindowEvidence({ ...window(5_000), status: "SATISFIED" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain('"status"');
        expect(parsed.reason).toContain("unknown key");
      }
    });

    it.each([
      ["arbitrary top-level key", { ...window(5_000), reviewed: true }],
      ["legacy exit.cleanShutdown (derived, removed)", (() => {
        const base = window(5_000);
        return { ...base, exit: { ...base.exit, cleanShutdown: true } };
      })()],
      ["nested exit.status", (() => {
        const base = window(5_000);
        return { ...base, exit: { ...base.exit, status: "ok" } };
      })()],
      ["nested observed extra key", (() => {
        const base = window(5_000);
        return { ...base, observed: { ...base.observed, satisfied: true } };
      })()],
      ["legacy wal.unexplainedGapSignals (derived, removed)", (() => {
        const base = window(5_000);
        return { ...base, wal: { ...base.wal, unexplainedGapSignals: 0 } };
      })()],
    ])("refuses %s", (_label, record) => {
      const parsed = parseSoakWindowEvidence(record);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain("unknown key");
      }
    });
  });

  describe("consistency relations (round-1 BLOCKER, part c)", () => {
    it.each([
      ["code and signal both non-null (the reviewer's contradictory exit)", (() => {
        const base = window(5_000);
        return { ...base, exit: { ...base.exit, code: 2, signal: "SIGKILL" } };
      })()],
      ["code and signal both null", (() => {
        const base = window(5_000);
        return { ...base, exit: { ...base.exit, code: null, signal: null } };
      })()],
      ["forcedKill without shutdownRequested", (() => {
        const base = window(5_000);
        return {
          ...base,
          exit: { code: null, signal: "SIGKILL", shutdownRequested: false, forcedKill: true },
        };
      })()],
      ["recordingOnly without the running banner", (() => {
        const base = window(5_000);
        return {
          ...base,
          observed: { ...base.observed, runningBannerSeen: false, recordingOnly: true },
        };
      })()],
      ["gapIncidents exceeding incidents", (() => {
        const base = window(5_000);
        return { ...base, observed: { ...base.observed, incidents: 1, gapIncidents: 2 } };
      })()],
      ["cleanupDeadlineExpired with exit code 0", (() => {
        const base = window(5_000);
        return { ...base, observed: { ...base.observed, cleanupDeadlineExpired: true } };
      })()],
      ["wal records without segments", (() => {
        const base = window(5_000);
        return { ...base, wal: { epochs: 1, segments: 0, records: 100, bytes: 0 } };
      })()],
      ["wal bytes without segments", (() => {
        const base = window(5_000);
        return { ...base, wal: { epochs: 1, segments: 0, records: 0, bytes: 10 } };
      })()],
      ["wal segments without epochs", (() => {
        const base = window(5_000);
        return { ...base, wal: { epochs: 0, segments: 2, records: 100, bytes: 10 } };
      })()],
    ])("poisons %s", (_label, record) => {
      const parsed = parseSoakWindowEvidence(record);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain("contradict");
      }
      // And through the evaluator, the whole set goes INVALID.
      expect(evaluateSoakEvidence([record], NOW).status).toBe("INVALID");
    });

    it("consistencyViolation is null for a coherent record", () => {
      expect(consistencyViolation(window(5_000))).toBeNull();
    });
  });
});

describe("the derived facts (never recorded, always computed)", () => {
  it("derives a clean shutdown only from the full primitive conjunction", () => {
    expect(derivedCleanShutdown(window(1_000))).toBe(true);
    const base = window(1_000);
    expect(
      derivedCleanShutdown({ ...base, exit: { ...base.exit, shutdownRequested: false } }),
    ).toBe(false);
    expect(derivedCleanShutdown({ ...base, exit: { ...base.exit, code: 1 } })).toBe(false);
    expect(
      derivedCleanShutdown({
        ...base,
        observed: { ...base.observed, shutdownLogSeen: false },
      }),
    ).toBe(false);
  });

  it("derives gap signals from WAL failures plus GAP incidents", () => {
    const base = window(1_000);
    expect(derivedUnexplainedGapSignals(base)).toBe(0);
    expect(
      derivedUnexplainedGapSignals({
        ...base,
        observed: { ...base.observed, incidents: 3, gapIncidents: 2, walRecordingFailures: 1 },
      }),
    ).toBe(3);
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

  it("a qualifying window at the threshold: QUALIFYING_WINDOW_FOUND — a candidate, not completion", () => {
    const evaluation = evaluateSoakEvidence(
      [window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS)],
      NOW,
    );
    expect(evaluation.status).toBe("QUALIFYING_WINDOW_FOUND");
    // The reason states what the state is — and what it is NOT.
    const reasons = evaluation.reasons.join("\n");
    expect(reasons).toContain("CANDIDATE");
    expect(reasons).toContain("not completion");
    expect(reasons).toContain("IMPLEMENTATION_STATUS.md");
    // Nothing in the whole evaluation is presentable as satisfaction.
    expect(JSON.stringify(evaluation)).not.toContain("SATISFIED");
  });

  it("PERMANENT (reviewer probe): a forged-but-consistent 25h record yields the candidate state, nothing more", () => {
    // The harness and evaluator share a filesystem trust domain: this record
    // was "hand-written" here, is internally consistent, and the evaluator
    // CANNOT tell it from a real one. The design answer is that its best
    // verdict is a candidate requiring out-of-band provenance review.
    const forged = {
      schemaVersion: 2,
      kind: "recorder-soak-window",
      harness: "test/soak/recorder/run-soak.mjs",
      startedAt: "2026-08-31T10:59:00.000Z",
      endedAt: "2026-09-01T11:59:00.000Z",
      elapsedMs: 90_000_000,
      exit: { code: 0, signal: null, shutdownRequested: true, forcedKill: false },
      observed: {
        runningBannerSeen: true,
        recordingOnly: false,
        shutdownLogSeen: true,
        cleanupDeadlineExpired: false,
        disposalFailures: 0,
        incidents: 0,
        gapIncidents: 0,
        halts: 0,
        walRecordingFailures: 0,
      },
      wal: { epochs: 1, segments: 12, records: 500_000, bytes: 123_456_789 },
      notes: "forged by hand for the permanent review-probe test",
    };
    const evaluation = evaluateSoakEvidence([forged], NOW);
    expect(evaluation.status).toBe("QUALIFYING_WINDOW_FOUND");
    expect(JSON.stringify(evaluation)).not.toContain("SATISFIED");
    expect(evaluation.reasons.join("\n")).toContain("provenance");
  });

  it("PERMANENT (reviewer probe): the contradictory-exit forgery poisons to INVALID", () => {
    const base = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS + 3_600_000);
    const forged = {
      ...base,
      exit: { code: 2, signal: "SIGKILL", shutdownRequested: true, forcedKill: false },
      observed: { ...base.observed, shutdownLogSeen: false },
    };
    const evaluation = evaluateSoakEvidence([forged], NOW);
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.reasons.join("\n")).toContain("contradict");
  });

  it("PERMANENT (reviewer probe): a smuggled status key poisons to INVALID", () => {
    const forged = { ...window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS), status: "SATISFIED" };
    const evaluation = evaluateSoakEvidence([forged], NOW);
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.reasons.join("\n")).toContain('"status"');
  });

  it("two shorter windows do NOT sum to qualification — sustained means one window", () => {
    const half = SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS / 2 + 1_000;
    const evaluation = evaluateSoakEvidence([window(half), window(half)], NOW);
    expect(evaluation.status).toBe("PENDING");
  });

  it("a long window with unexplained gap signals cannot qualify", () => {
    const base = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    const gappy = {
      ...base,
      observed: { ...base.observed, incidents: 2, gapIncidents: 2 },
    };
    const evaluation = evaluateSoakEvidence([gappy], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.longestWindowMs).toBe(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    expect(evaluation.longestQualifyingWindowMs).toBe(0);
    expect(evaluation.reasons.join("\n")).toContain("unexplained-gap signal");
  });

  it("a long window without a clean requested shutdown cannot qualify", () => {
    const dirty = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      exit: { code: 1, signal: null, shutdownRequested: true, forcedKill: false },
    });
    expect(evaluateSoakEvidence([dirty], NOW).status).toBe("PENDING");
  });

  it("a long window that exited 0 with no requested shutdown cannot qualify", () => {
    // An exit nobody requested is an incident even at code 0; cleanliness is
    // derived from the primitives, and shutdownRequested=false fails it.
    const unrequested = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      exit: { code: 0, signal: null, shutdownRequested: false, forcedKill: false },
    });
    const evaluation = evaluateSoakEvidence([unrequested], NOW);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.longestQualifyingWindowMs).toBe(0);
  });

  it("a long window that never showed the running banner cannot qualify", () => {
    const bannerless = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS);
    const record = {
      ...bannerless,
      observed: { ...bannerless.observed, runningBannerSeen: false, recordingOnly: false },
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

  it("one bad record poisons the set: INVALID even next to a qualifying window", () => {
    const evaluation = evaluateSoakEvidence(
      [window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS), { tampered: true }],
      NOW,
    );
    expect(evaluation.status).toBe("INVALID");
    expect(evaluation.invalidRecords).toBe(1);
    expect(evaluation.reasons.join("\n")).toContain("does not skip bad evidence");
  });

  it("a window that recorded nothing cannot qualify", () => {
    const empty = window(SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS, {
      wal: { epochs: 1, segments: 0, records: 0, bytes: 0 },
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
        exit: { ...forced.exit, code: 1 },
        observed: { ...forced.observed, cleanupDeadlineExpired: true },
      }),
    ).toContain("cleanup deadline");
  });

  it("names a forced kill", () => {
    const forced = window(1_000);
    expect(
      disqualifyingReason({
        ...forced,
        exit: { ...forced.exit, code: null, signal: "SIGKILL", forcedKill: true },
      }),
    ).toContain("force-kill");
  });
});
