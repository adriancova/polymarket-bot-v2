import { describe, expect, it } from "vitest";

import { loadResearchWorkerConfig, ResearchWorkerConfigurationError } from "./config.js";

const minimal = {
  RESEARCH_WORKER_WAL_DIR: "/var/lib/wal",
  RESEARCH_WORKER_OBJECT_STORE_ROOT: "/var/lib/objects",
} satisfies NodeJS.ProcessEnv;

describe("loadResearchWorkerConfig", () => {
  it("requires the two paths that have no safe default", () => {
    expect(() => loadResearchWorkerConfig({})).toThrow(ResearchWorkerConfigurationError);
    expect(() =>
      loadResearchWorkerConfig({ RESEARCH_WORKER_WAL_DIR: "/var/lib/wal" }),
    ).toThrow(/RESEARCH_WORKER_OBJECT_STORE_ROOT/u);
  });

  it("retains every WAL segment by default", () => {
    // ADR-004's Consequences: filling the disk is the intended failure
    // direction, so deletion is opt-in and never a default.
    expect(loadResearchWorkerConfig(minimal).retention).toBe("retain");
  });

  it("accepts the explicit delete-after-verified-upload policy", () => {
    const config = loadResearchWorkerConfig({
      ...minimal,
      RESEARCH_WORKER_RETENTION: "delete-after-verified-upload",
    });
    expect(config.retention).toBe("delete-after-verified-upload");
  });

  it("rejects an unknown retention policy rather than falling back to a default", () => {
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_RETENTION: "delete-everything" }),
    ).toThrow(/must be one of retain/u);
  });

  it("defaults the codec to UNCOMPRESSED and rejects an unknown one", () => {
    expect(loadResearchWorkerConfig(minimal).codec).toBe("UNCOMPRESSED");
    expect(loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_CODEC: "SNAPPY" }).codec).toBe(
      "SNAPPY",
    );
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_CODEC: "GZIP" }),
    ).toThrow(/must be one of UNCOMPRESSED/u);
  });

  it("enforces a minimum interval so a misconfiguration cannot spin", () => {
    expect(loadResearchWorkerConfig(minimal).intervalMs).toBe(60_000);
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_INTERVAL_MS: "10" }),
    ).toThrow(/at least 1000/u);
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_INTERVAL_MS: "-5" }),
    ).toThrow(/positive integer/u);
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_INTERVAL_MS: "1e5" }),
    ).toThrow(/positive integer/u);
  });

  it("parses the boolean flag strictly", () => {
    expect(loadResearchWorkerConfig(minimal).runOnce).toBe(false);
    expect(
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_RUN_ONCE: "true" }).runOnce,
    ).toBe(true);
    expect(loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_RUN_ONCE: "0" }).runOnce).toBe(
      false,
    );
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_RUN_ONCE: "yes" }),
    ).toThrow(/must be one of true/u);
  });

  it("leaves the normalizer version null unless one is supplied", () => {
    expect(loadResearchWorkerConfig(minimal).normalizerVersion).toBeNull();
    expect(
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_NORMALIZER_VERSION: "norm-4" })
        .normalizerVersion,
    ).toBe("norm-4");
  });

  it("treats whitespace-only values as absent", () => {
    expect(() =>
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_WAL_DIR: "   " }),
    ).toThrow(/RESEARCH_WORKER_WAL_DIR/u);
    expect(
      loadResearchWorkerConfig({ ...minimal, RESEARCH_WORKER_INCIDENT_WINDOWS: "  " })
        .incidentWindowsPath,
    ).toBeNull();
  });

  it("reads no run-mode variable at all", () => {
    // This process places no order, so it must not be in a position to observe
    // or influence the §0.2 ladder. The config object has no such field.
    const config = loadResearchWorkerConfig({
      ...minimal,
      MAX_RUN_MODE: "LIVE",
      ALLOW_REAL_ORDERS: "true",
    });
    expect(Object.keys(config)).not.toContain("maxRunMode");
    expect(JSON.stringify(config)).not.toMatch(/LIVE|ALLOW_REAL_ORDERS/u);
  });
});
