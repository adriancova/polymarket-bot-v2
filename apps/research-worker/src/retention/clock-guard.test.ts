/**
 * The clock guard (`STORAGE-1` round 1, J7): a forward step of the wall
 * clock is measured against the time since boot and subtracted, so it can
 * never shorten the 72-hour retention.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { manualClock } from "@polymarket-bot/storage-parquet/testing";

import { manualBootClock } from "../testing/storage-fixture.js";
import { CLOCK_STATE_FILE_NAME, assessClock, guardedClock } from "./clock-guard.js";

const T = Date.parse("2026-01-10T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const TOLERANCE = 60_000;

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "storage1-clock-"));
});

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("assessClock", () => {
  it("measures nothing without a state directory or a boot clock", async () => {
    expect(await assessClock({ stateDirectory: null, wallMs: T, bootClock: manualBootClock(), toleranceMs: TOLERANCE })).toStrictEqual({
      status: "unchecked",
      stepMs: 0,
      skewMs: 0,
    });
    expect(await assessClock({ stateDirectory, wallMs: T, bootClock: null, toleranceMs: TOLERANCE })).toMatchObject({ status: "unchecked" });
  });

  it("accumulates a forward step as skew, ignores drift within the tolerance, and gives a correction back", async () => {
    const boot = manualBootClock();
    expect(await assessClock({ stateDirectory, wallMs: T, bootClock: boot, toleranceMs: TOLERANCE })).toMatchObject({ status: "first-reading", skewMs: 0 });
    boot.advance(10 * 60_000);
    expect(await assessClock({ stateDirectory, wallMs: T + 10 * 60_000 + 30_000, bootClock: boot, toleranceMs: TOLERANCE })).toMatchObject({
      status: "steady",
      skewMs: 0,
    });
    boot.advance(60_000);
    // The wall clock moved 2 h while one minute passed.
    const step = await assessClock({ stateDirectory, wallMs: T + 10 * 60_000 + 30_000 + 2 * HOUR, bootClock: boot, toleranceMs: TOLERANCE });
    expect(step).toStrictEqual({ status: "forward-step", stepMs: 2 * HOUR - 60_000, skewMs: 2 * HOUR - 60_000 });
    // The skew persists across cycles while the clock stays where it is.
    boot.advance(60_000);
    expect(await assessClock({ stateDirectory, wallMs: T + 10 * 60_000 + 90_000 + 2 * HOUR, bootClock: boot, toleranceMs: TOLERANCE })).toMatchObject({
      status: "steady",
      skewMs: 2 * HOUR - 60_000,
    });
    // The clock is corrected back: the skew is given back, never below zero.
    boot.advance(60_000);
    expect(await assessClock({ stateDirectory, wallMs: T + 10 * 60_000 + 150_000 - HOUR, bootClock: boot, toleranceMs: TOLERANCE })).toMatchObject({
      status: "backward-step",
      skewMs: 0,
    });
  });

  it("carries the skew over a reboot, which it cannot measure across", async () => {
    const boot = manualBootClock();
    await assessClock({ stateDirectory, wallMs: T, bootClock: boot, toleranceMs: TOLERANCE });
    boot.advance(60_000);
    await assessClock({ stateDirectory, wallMs: T + HOUR, bootClock: boot, toleranceMs: TOLERANCE });
    boot.reboot("boot-2");
    expect(await assessClock({ stateDirectory, wallMs: T + 5 * HOUR, bootClock: boot, toleranceMs: TOLERANCE })).toMatchObject({
      status: "new-boot",
      skewMs: HOUR - 60_000,
    });
  });

  it("refuses a state file it does not read, rather than assuming no skew", async () => {
    await writeFile(join(stateDirectory, CLOCK_STATE_FILE_NAME), '{"clockStateVersion":1,"clockStateVersion":1}');
    await expect(assessClock({ stateDirectory, wallMs: T, bootClock: manualBootClock(), toleranceMs: TOLERANCE })).rejects.toThrow();
    await writeFile(join(stateDirectory, CLOCK_STATE_FILE_NAME), JSON.stringify({ clockStateVersion: 1, wallMs: T, sinceBootMs: 1, bootId: "b", skewMs: -5 }));
    await expect(assessClock({ stateDirectory, wallMs: T, bootClock: manualBootClock(), toleranceMs: TOLERANCE })).rejects.toThrow(/not one this build reads/u);
  });

  it("persists the reading durably for the next cycle", async () => {
    await assessClock({ stateDirectory, wallMs: T, bootClock: manualBootClock("b", 5_000), toleranceMs: TOLERANCE });
    expect(JSON.parse(await readFile(join(stateDirectory, CLOCK_STATE_FILE_NAME), "utf8"))).toStrictEqual({
      clockStateVersion: 1,
      wallMs: T,
      sinceBootMs: 5_000,
      bootId: "b",
      skewMs: 0,
    });
  });
});

describe("guardedClock", () => {
  it("subtracts the skew, and never runs ahead of the monotonic time since the cycle started", () => {
    const base = manualClock(T);
    const clock = guardedClock(base, HOUR, TOLERANCE);
    expect(clock.nowMs()).toBe(T - HOUR);
    base.advance(30_000);
    expect(clock.nowMs()).toBe(T - HOUR + 30_000);
    // A step during the cycle: the wall clock jumps 2 h, the monotonic clock does not.
    base.setNowMs(T + 30_000 + 2 * HOUR);
    expect(clock.nowMs()).toBe(T - HOUR + 30_000 + TOLERANCE);
  });
});
