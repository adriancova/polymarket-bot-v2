/**
 * `APPROX-REPLAY-1` acceptance 4 — every output of `approx-run` is labelled
 * approximate, from the manifest — driven IN-PROCESS through the executable's
 * own entry point (`main`), argv in, lines and artifact file out.
 *
 * The output kinds, each pinned below:
 *
 * 1. the report a completed run prints (stdout), including the run
 *    serialization;
 * 2. the artifact (the run record) it writes;
 * 3. the report of a run the core HALTED part-way (stderr, exit 75);
 * 4. the report of a run the translation STOPPED part-way (stderr, exit 3);
 * 5. a refusal after a manifest verified (stderr, exit 3);
 * 6. the cross-epoch stop that ASKS (stderr, exit 4);
 * 7. a refusal before any manifest verified — which has no manifest to take
 *    a label from, and says so.
 *
 * The label is the manifest's own: a manifest re-sealed with another
 * admissibility statement prints that statement, verbatim.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. Every file written is
 * under a fresh temporary directory.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_ASK, EXIT_HALTED, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../main.js";
import { APPROXIMATE_ARTIFACT_FORMAT_ID, APPROXIMATE_RUN_SERIALIZATION_VERSION } from "./serialize.js";
import { APPROXIMATE_TRANSLATION_VERSION } from "./translate.js";
import {
  EPOCH,
  OTHER_EPOCH,
  bar,
  depth,
  gammaPoll,
  resealManifest,
  top,
  writeResearchDataset,
  type FixtureSample,
} from "./test-support.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "test", "replay-golden", "backtest", "static-bracket");
const CONFIG = JSON.parse(readFileSync(join(FIXTURE, "trader-config.json"), "utf8")) as Record<string, unknown>;
const MARKET_ID = "019b1e00-0000-7000-8000-000000000001";
const C = "0xbacktest1condition";
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

const scratch = mkdtempSync(join(tmpdir(), "approx-replay-cli-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;
function fresh(name: string): string {
  counter += 1;
  return join(scratch, `${name}-${String(counter)}`);
}

const PINS_PATH = join(scratch, "approx-run-pins.json");
writeFileSync(
  PINS_PATH,
  JSON.stringify({
    ...(JSON.parse(readFileSync(join(FIXTURE, "run-pins.json"), "utf8")) as Record<string, unknown>),
    normalizerVersion: APPROXIMATE_TRANSLATION_VERSION,
  }),
);
const EXACT_PINS_PATH = join(FIXTURE, "run-pins.json");
const CONFIG_PATH = join(FIXTURE, "trader-config.json");

const r = (ordinal: number, seq: string, atMs: number, epoch?: string) => ({ ordinal, seq, atMs, ...(epoch === undefined ? {} : { epoch, segment: `${epoch}-000000` }) });

function opening(): FixtureSample[] {
  return [
    bar(r(0, "1", T0), { spanStartMs: T0 - 1_000, close: "64000" }),
    gammaPoll(r(1, "1", T0), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true }),
    depth(r(2, "2", T0 + 1_000), { spanStartMs: T0, conditionId: C, tokenId: "9101", bids: [["0.32", "200"]], asks: [["0.34", "30"], ["0.35", "40"]] }),
    depth(r(3, "2", T0 + 1_000), { spanStartMs: T0, conditionId: C, tokenId: "9102", bids: [["0.65", "200"]], asks: [["0.66", "200"]] }),
    bar(r(4, "2", T0 + 1_000), { spanStartMs: T0, close: "64100" }),
  ];
}

async function cli(argv: readonly string[], environment: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({ argv, environment, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

function approxArgv(store: string, manifests: string, artifact: string, overrides: { readonly pins?: string; readonly config?: string; readonly gamma?: string } = {}): string[] {
  return [
    "approx-run",
    "--store",
    store,
    "--manifests",
    manifests,
    "--gamma-markets",
    overrides.gamma ?? `${MARKET_ID}=777`,
    "--pins",
    overrides.pins ?? PINS_PATH,
    "--config",
    overrides.config ?? CONFIG_PATH,
    "--artifact",
    artifact,
  ];
}

/** Every non-empty line carries the label, except the named format-id lines. */
function everyLineLabelled(lines: readonly string[], exempt: readonly string[] = []): void {
  // A sink call may carry several lines (the run serialization is one call).
  const physical = lines.flatMap((line) => line.split("\n"));
  expect(physical.length).toBeGreaterThan(0);
  const unlabelled = physical.filter((line) => line !== "" && !exempt.includes(line) && !line.startsWith("approximate "));
  expect(unlabelled).toEqual([]);
}

describe("acceptance 4: every output is labelled approximate, from the manifest", () => {
  it("1-2. a completed run: every report line and every artifact line carries the manifest's fidelity", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "labels", samples: opening() });
    const artifact = join(scratch, `labels-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.err.filter((line) => !line.startsWith("approximate "))).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
    everyLineLabelled(result.out, [APPROXIMATE_RUN_SERIALIZATION_VERSION]);
    expect(result.out).toContain("approximate fidelity=approximate evidence=APPROXIMATE_NOT_EVIDENCE rank=BELOW_EVERY_ADR012_TIER");
    expect(result.out).toContain(`approximate admissibility=${written.manifest.admissibility}`);
    expect(result.out).toContain("approximate run_mode=BACKTEST");
    expect(result.out).toContain("approximate core_run_mode=PAPER");

    const lines = readFileSync(artifact, "utf8").split("\n");
    expect(lines[0]).toBe(APPROXIMATE_ARTIFACT_FORMAT_ID);
    everyLineLabelled(lines.slice(1));
    expect(lines).toContain("approximate label fidelity=approximate evidence=APPROXIMATE_NOT_EVIDENCE rank=BELOW_EVERY_ADR012_TIER");
    expect(lines).toContain(`approximate admissibility ${written.manifest.admissibility}`);
    expect(lines.some((line) => line.startsWith("approximate decision "))).toBe(true);
    // No line could pass for an exact artifact's or an exact run's.
    expect(lines.some((line) => line.includes("polymarket-bot/simulation-run/") || line.includes("backtest-static-bracket-replay"))).toBe(false);
  });

  it("the label is the manifest's own: a re-sealed admissibility statement is printed verbatim", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "admissibility", samples: opening() });
    const statement = "approximate: FIXTURE STATEMENT read from this manifest, nowhere else";
    resealManifest(store, written.manifestObjectKey, (manifest) => {
      manifest["admissibility"] = statement;
    });
    const artifact = join(scratch, `admissibility-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain(`approximate admissibility=${statement}`);
    expect(readFileSync(artifact, "utf8").split("\n")).toContain(`approximate admissibility ${statement}`);
  });

  it("3. a run the core halts part-way: every stderr line is labelled, exit 75, no artifact", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "halted", samples: opening() });
    const config = join(scratch, `tiny-queue-${String(counter)}.json`);
    writeFileSync(config, JSON.stringify({ ...CONFIG, queues: { ingestMaximumDepth: 1, outboxMaximumDepth: 8192 } }));
    const artifact = join(scratch, `halted-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact, { config }));
    expect(result.code).toBe(EXIT_HALTED);
    expect(result.err.length).toBeGreaterThan(2);
    everyLineLabelled(result.err);
    expect(result.err.some((line) => line.startsWith("approximate HALTED: the core latched QUEUE_BACKPRESSURE@GLOBAL"))).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });

  it("4. a run the translation stops part-way: labelled STOPPED, exit 3, no artifact", async () => {
    const store = fresh("store");
    const samples: FixtureSample[] = [
      ...opening(),
      top(r(5, "3", T0 + 2_000), { spanStartMs: T0 + 1_000, conditionId: C, tokenId: "9101", bid: ["0.32", "200"], ask: ["0.34", "30"] }),
    ];
    const written = await writeResearchDataset({ root: store, datasetId: "stopped", samples });
    const artifact = join(scratch, `stopped-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_REFUSED);
    everyLineLabelled(result.err);
    expect(result.err.some((line) => line.startsWith("approximate STOPPED: APPROX_TRANSLATION_REFUSED"))).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });

  it("5. a refusal after a manifest verified is labelled", async () => {
    const store = fresh("store");
    const one = await writeResearchDataset({ root: store, datasetId: "chain-a", samples: opening() });
    const two = await writeResearchDataset({
      root: store,
      datasetId: "chain-b",
      segmentIndex: 1,
      samples: [bar({ ...r(0, "9", T0 + 9_000), segment: `${EPOCH}-000001` }, { spanStartMs: T0 + 8_000, close: "1" })],
    });
    const result = await cli(approxArgv(store, `${one.manifestObjectKey},${two.manifestObjectKey}`, join(scratch, "never.txt")));
    expect(result.code).toBe(EXIT_REFUSED);
    everyLineLabelled(result.err);
    expect(result.err[0]?.startsWith("approximate REFUSED: APPROX_REPLAY_CHAIN_BROKEN")).toBe(true);
  });

  it("6. a replay across two gateway epochs STOPS AND ASKS: labelled, exit 4, nothing replayed", async () => {
    const store = fresh("store");
    const one = await writeResearchDataset({ root: store, datasetId: "epoch-a", samples: opening() });
    const two = await writeResearchDataset({
      root: store,
      epoch: OTHER_EPOCH,
      datasetId: "epoch-b",
      samples: [bar(r(0, "1", T0 + 9_000, OTHER_EPOCH), { spanStartMs: T0 + 8_000, close: "1" })],
    });
    const artifact = join(scratch, `ask-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, `${one.manifestObjectKey},${two.manifestObjectKey}`, artifact));
    expect(result.code).toBe(EXIT_ASK);
    everyLineLabelled(result.err);
    expect(result.err[0]?.startsWith("approximate ASK: APPROX_REPLAY_CROSS_EPOCH")).toBe(true);
    expect(result.err.some((line) => line.startsWith("approximate QUESTION: replay each gateway epoch separately"))).toBe(true);
    expect(result.out).toEqual([]);
    expect(existsSync(artifact)).toBe(false);
  });

  it("7. a refusal before any manifest verified says it has no manifest to take a label from", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "unverified", samples: opening() });
    writeFileSync(join(store, written.manifestObjectKey.replace(/manifest\.json$/u, "manifest.sha256")), `${"0".repeat(64)}\n`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, join(scratch, "never-2.txt")));
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err[0]).toMatch(/^REFUSED: APPROX_REPLAY_DATASET_UNVERIFIED: .*carries no fidelity label\)$/u);
    expect(result.out).toEqual([]);
  });
});

describe("approx-run: the command's own boundaries", () => {
  it("refuses an unsafe environment before anything is read", async () => {
    const result = await cli(approxArgv(join(scratch, "does-not-exist"), "x/manifest.json", join(scratch, "never-3.txt")), {
      ALLOW_REAL_ORDERS: "true",
    });
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err[0]).toContain("startup safety validation failed");
  });

  it("usage: every required option, no unknown option, a well-formed --gamma-markets", async () => {
    expect((await cli(["approx-run", "--store", "x"])).code).toBe(EXIT_USAGE);
    expect((await cli([...approxArgv("s", "m", "a"), "--dataset", "d"])).code).toBe(EXIT_USAGE);
    expect((await cli(approxArgv("s", "m", "a", { gamma: "no-equals-sign" }))).code).toBe(EXIT_USAGE);
    expect((await cli(approxArgv("s", "m", "a", { gamma: `${MARKET_ID}=1,${MARKET_ID}=2` }))).code).toBe(EXIT_USAGE);
  });

  it("refuses run pins that do not name the translation, and a market with no Gamma id", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "pins", samples: opening() });
    const exact = await cli(approxArgv(store, written.manifestObjectKey, join(scratch, "never-4.txt"), { pins: EXACT_PINS_PATH }));
    expect(exact.code).toBe(EXIT_REFUSED);
    expect(exact.err[0]).toContain("APPROX_RUN_PINS_REFUSED");
    const unattributed = await cli(
      approxArgv(store, written.manifestObjectKey, join(scratch, "never-5.txt"), { gamma: "019b1e00-0000-7000-8000-0000000000ff=1" }),
    );
    expect(unattributed.code).toBe(EXIT_REFUSED);
    expect(unattributed.err[0]).toContain("APPROX_RUN_LIFECYCLE_UNATTRIBUTED");
  });

  it("never overwrites an existing artifact", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "overwrite", samples: opening() });
    const artifact = join(scratch, `existing-${String(counter)}.txt`);
    writeFileSync(artifact, "keep me\n");
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_REFUSED);
    expect(readFileSync(artifact, "utf8")).toBe("keep me\n");
    everyLineLabelled(result.err);
  });
});
