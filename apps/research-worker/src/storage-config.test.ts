/**
 * The storage command's configuration: deletion is never the default
 * (`STORAGE-1` safety; ADR-028 Decision 2.1).
 */

import { describe, expect, it } from "vitest";

import { RAW_RETENTION_MS } from "./retention/plan.js";
import { loadStorageConfig } from "./storage-config.js";

const BASE = { RESEARCH_WORKER_WAL_ROOT: "/wal", RESEARCH_WORKER_OBJECT_STORE_ROOT: "/objects", RESEARCH_WORKER_STATE_DIR: "/state" };
const NO_STATE = { RESEARCH_WORKER_WAL_ROOT: "/wal", RESEARCH_WORKER_OBJECT_STORE_ROOT: "/objects" };

describe("loadStorageConfig", () => {
  it("is a dry run unless execute is spelled out", () => {
    const config = loadStorageConfig(BASE);
    expect(config.mode).toBe("dry-run");
    expect(config.retentionMs).toBe(RAW_RETENTION_MS);
    expect(RAW_RETENTION_MS).toBe(72 * 60 * 60 * 1000);
    expect(config.traderDatabaseUrl).toBeNull();
    expect(() => loadStorageConfig({ ...BASE, RESEARCH_WORKER_EXPIRY_MODE: "yes" })).toThrow(/dry-run or execute/u);
  });

  it("refuses execute without a state directory for the durable plan", () => {
    expect(() => loadStorageConfig({ ...NO_STATE, RESEARCH_WORKER_EXPIRY_MODE: "execute" })).toThrow(
      /RESEARCH_WORKER_STATE_DIR: is required in execute mode/u,
    );
    expect(loadStorageConfig({ ...BASE, RESEARCH_WORKER_EXPIRY_MODE: "execute" }).mode).toBe("execute");
  });

  it("(round 5, N2) refuses a dry run without a state directory too: what it reads is made durable there", () => {
    expect(() => loadStorageConfig(NO_STATE)).toThrow(/RESEARCH_WORKER_STATE_DIR: is required in dry-run mode too/u);
    expect(() => loadStorageConfig({ ...NO_STATE, RESEARCH_WORKER_EXPIRY_MODE: "dry-run" })).toThrow(/RESEARCH_WORKER_STATE_DIR/u);
    expect(loadStorageConfig(BASE).stateDirectory).toBe("/state");
  });

  it("refuses a raw retention shorter than 72 hours", () => {
    expect(() =>
      loadStorageConfig({ ...BASE, RESEARCH_WORKER_RAW_RETENTION_MS: String(RAW_RETENTION_MS - 1) }),
    ).toThrow(/at least 259200000/u);
    expect(loadStorageConfig({ ...BASE, RESEARCH_WORKER_RAW_RETENTION_MS: String(RAW_RETENTION_MS * 2) }).retentionMs).toBe(
      RAW_RETENTION_MS * 2,
    );
  });

  it("requires the WAL root and the object store", () => {
    expect(() => loadStorageConfig({})).toThrow(/RESEARCH_WORKER_WAL_ROOT/u);
    expect(() => loadStorageConfig({ RESEARCH_WORKER_WAL_ROOT: "/wal" })).toThrow(/RESEARCH_WORKER_OBJECT_STORE_ROOT/u);
  });

  it("bounds the clock guard's tolerance, so a real step is never absorbed as drift", () => {
    expect(loadStorageConfig(BASE).clockStepToleranceMs).toBe(60_000);
    expect(loadStorageConfig({ ...BASE, RESEARCH_WORKER_CLOCK_STEP_TOLERANCE_MS: String(60 * 60 * 1000) }).clockStepToleranceMs).toBe(10 * 60 * 1000);
    expect(() => loadStorageConfig({ ...BASE, RESEARCH_WORKER_CLOCK_STEP_TOLERANCE_MS: "10" })).toThrow(/at least 1000/u);
  });

  it("bounds the extraction batching far below the retention", () => {
    expect(loadStorageConfig({ ...BASE, RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS: String(100 * 60 * 60 * 1000) }).extractionBatchDelayMs).toBe(
      12 * 60 * 60 * 1000,
    );
  });
});
