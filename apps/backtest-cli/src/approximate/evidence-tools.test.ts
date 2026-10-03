/**
 * `APPROX-REPLAY-1` acceptance 5 — every evidence tool refuses an approximate
 * input (ADR-029 Decision 4.3: "A tool that builds evidence for §2's uses
 * refuses an approximate input"), and the exact door still refuses an
 * approximate manifest with `REPLAY_MANIFEST_APPROXIMATE`.
 *
 * The evidence tools of this repository that take a dataset are the exact
 * replay door (`packages/simulation`'s `readDatasetManifestBytes`, read
 * here, not changed) and this app's four consumers of it: the `verify`
 * command (the §12.4 canonical serialization a determinism claim is made
 * about), the `run` command (the backtest artifact the replay golden pins),
 * and their library entry points `runBacktest` and `runBacktestCore`. The
 * artifact renderer behind `run` is the fifth: it refuses an approximate
 * result even when handed one directly. Calibration (`WP-360`) and promotion
 * (`WP-370`) tools do not exist yet; soak tools read soak artifacts, not
 * datasets.
 *
 * Each input below is a REAL research-tier manifest, written by the
 * published writer: the refusal is by the manifest's own `fidelity`, never by
 * a file name (ADR-029 Decision 4.2).
 *
 * r1 (APPROX-R1-H2): the package's PUBLIC surface (`index.ts`) has no renderer
 * that prints an approximate core unlabelled. Its renderers are pinned by
 * name; the exact one refuses an approximate core even beside a real exact
 * result, and the approximate one labels every line.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readDatasetManifestBytes, readRunPins, type ReplayRunPins } from "@polymarket-bot/simulation";
import { fileSystemObjectStore } from "@polymarket-bot/storage-parquet";
import { afterAll, describe, expect, it } from "vitest";

import * as publicSurface from "../index.js";
import { sha256Hex } from "../archive.js";
import { renderBacktestArtifact } from "../artifact.js";
import { runBacktestCore } from "../assembly.js";
import { EXIT_REFUSED, main } from "../main.js";
import { normalizedEnvelopeNormalizer } from "../normalizer.js";
import { runBacktest, type BacktestOutcome } from "../run.js";
import { runApproximateBacktest } from "./run.js";
import { APPROXIMATE_TRANSLATION_VERSION } from "./translate.js";
import { bar, depth, gammaPoll, writeResearchDataset, type WrittenDataset } from "./test-support.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "test", "replay-golden", "backtest", "static-bracket");
const CONFIG = JSON.parse(readFileSync(join(FIXTURE, "trader-config.json"), "utf8")) as Record<string, unknown>;
const EXACT_PINS_PATH = join(FIXTURE, "run-pins.json");
const EXACT_PINS_DOCUMENT = JSON.parse(readFileSync(EXACT_PINS_PATH, "utf8")) as Record<string, unknown>;
const C = "0xbacktest1condition";
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

const scratch = mkdtempSync(join(tmpdir(), "approx-replay-evidence-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function exactPins(): ReplayRunPins {
  const pins = readRunPins(EXACT_PINS_DOCUMENT);
  if (!pins.ok) throw new Error(pins.refusal.message);
  return pins.value;
}

let counter = 0;
async function researchDataset(): Promise<{ readonly root: string; readonly written: WrittenDataset; readonly directory: string }> {
  counter += 1;
  const root = join(scratch, `store-${String(counter)}`);
  const r = (ordinal: number, seq: string, atMs: number) => ({ ordinal, seq, atMs });
  const written = await writeResearchDataset({
    root,
    datasetId: `evidence-${String(counter)}`,
    samples: [
      bar(r(0, "1", T0), { spanStartMs: T0 - 1_000, close: "64000" }),
      gammaPoll(r(1, "1", T0), { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true }),
      depth(r(2, "2", T0 + 1_000), { spanStartMs: T0, conditionId: C, tokenId: "9101", bids: [["0.32", "200"]], asks: [["0.34", "30"], ["0.35", "40"]] }),
    ],
  });
  return { root, written, directory: join(root, dirname(written.manifestObjectKey)) };
}

/** The research-tier manifest, placed under the name the exact tools read. */
function asExactManifestName(directory: string): void {
  copyFileSync(join(directory, "manifest.json"), join(directory, "dataset-manifest.json"));
}

async function cli(argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({ argv, environment: {}, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("acceptance 5: every evidence tool refuses an approximate input", () => {
  it("the exact replay door refuses a real research-tier manifest with REPLAY_MANIFEST_APPROXIMATE", async () => {
    const { directory } = await researchDataset();
    const read = readDatasetManifestBytes(new Uint8Array(readFileSync(join(directory, "manifest.json"))));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("REPLAY_MANIFEST_APPROXIMATE");
  });

  it("runBacktest (the verify path) refuses it with REPLAY_MANIFEST_APPROXIMATE", async () => {
    const { directory } = await researchDataset();
    const outcome = await runBacktest({
      datasetDirectory: directory,
      manifestFileName: "manifest.json",
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: exactPins(),
      environment: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && "refusal" in outcome) expect(outcome.refusal.code).toBe("REPLAY_MANIFEST_APPROXIMATE");
  });

  it("runBacktestCore (the run path) refuses it before a core is built", async () => {
    const { directory } = await researchDataset();
    const started = await runBacktestCore({
      environment: {},
      traderConfig: CONFIG,
      runPins: exactPins(),
      datasetDirectory: directory,
      manifestFileName: "manifest.json",
    });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.refusal.code).toBe("BACKTEST_DATASET_REFUSED");
      expect(started.refusal.detail).toContain("REPLAY_MANIFEST_APPROXIMATE");
    }
  });

  it("the verify command refuses it (exit 3, REPLAY_MANIFEST_APPROXIMATE), and a research-tier directory as it is refuses rather than throws", async () => {
    const { directory } = await researchDataset();
    const asIs = await cli(["verify", "--dataset", directory, "--pins", EXACT_PINS_PATH]);
    expect(asIs.code).toBe(EXIT_REFUSED);
    expect(asIs.err).toContain("REPLAY_ARCHIVE_UNREADABLE");
    asExactManifestName(directory);
    const renamed = await cli(["verify", "--dataset", directory, "--pins", EXACT_PINS_PATH]);
    expect(renamed.code).toBe(EXIT_REFUSED);
    expect(renamed.err).toContain("REFUSED: REPLAY_MANIFEST_APPROXIMATE");
    expect(renamed.out).toBe("");
  });

  it("the run command refuses it (exit 3, REPLAY_MANIFEST_APPROXIMATE) and writes no artifact", async () => {
    const { directory } = await researchDataset();
    asExactManifestName(directory);
    const artifact = join(scratch, `run-artifact-${String(counter)}.txt`);
    const result = await cli([
      "run",
      "--dataset",
      directory,
      "--pins",
      EXACT_PINS_PATH,
      "--config",
      join(FIXTURE, "trader-config.json"),
      "--artifact",
      artifact,
    ]);
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain("REPLAY_MANIFEST_APPROXIMATE");
    expect(existsSync(artifact)).toBe(false);
  });

  it("the exact artifact renderer refuses an approximate result handed to it directly", async () => {
    const { root, written } = await researchDataset();
    const started = await runApproximateBacktest({
      environment: {},
      traderConfig: CONFIG,
      runPins: { ...EXACT_PINS_DOCUMENT, normalizerVersion: APPROXIMATE_TRANSLATION_VERSION },
      objectStore: fileSystemObjectStore(root),
      manifestObjectKeys: [written.manifestObjectKey],
      gammaMarketIds: new Map([["019b1e00-0000-7000-8000-000000000001", "777"]]),
    });
    if (!started.ok || !started.run.outcome.ok) throw new Error("the approximate run did not complete");
    const run = started.run;
    const forged = {
      ok: true,
      runMode: "BACKTEST",
      result: run.outcome.ok ? run.outcome.result : undefined,
    } as unknown as Extract<BacktestOutcome, { readonly ok: true }>;
    const artifact = renderBacktestArtifact({ outcome: forged, trader: run.core.trader, store: run.core.store, driver: run.driver });
    expect(artifact.ok).toBe(false);
    if (!artifact.ok) expect(artifact.problem).toContain("REPLAY_MANIFEST_APPROXIMATE");
    await run.core.store.close();
  });

  it("the exact run refuses run pins that name the approximate translation", async () => {
    const started = await runBacktestCore({
      environment: {},
      traderConfig: CONFIG,
      runPins: { ...exactPins(), normalizerVersion: APPROXIMATE_TRANSLATION_VERSION },
      datasetDirectory: FIXTURE,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.refusal.code).toBe("BACKTEST_NORMALIZER_NOT_SUPPORTED");
  });
});

/** A completed approximate run over a real research-tier dataset (the caller closes its store). */
async function completedApproximateRun() {
  const { root, written } = await researchDataset();
  const started = await runApproximateBacktest({
    environment: {},
    traderConfig: CONFIG,
    runPins: { ...EXACT_PINS_DOCUMENT, normalizerVersion: APPROXIMATE_TRANSLATION_VERSION },
    objectStore: fileSystemObjectStore(root),
    manifestObjectKeys: [written.manifestObjectKey],
    gammaMarketIds: new Map([["019b1e00-0000-7000-8000-000000000001", "777"]]),
  });
  if (!started.ok || !started.run.outcome.ok) throw new Error("the approximate run did not complete");
  return { run: started.run, result: started.run.outcome.result };
}

/** A completed EXACT run over the committed static-bracket fixture (the caller closes its store). */
async function completedExactRun() {
  const started = await runBacktestCore({ environment: {}, traderConfig: CONFIG, runPins: exactPins(), datasetDirectory: FIXTURE });
  if (!started.ok || !started.run.outcome.ok) throw new Error("the exact run did not complete");
  return { run: started.run, outcome: started.run.outcome };
}

describe("r1, APPROX-R1-H2: no public renderer prints an approximate core without its label", () => {
  it("the public surface exports no core-section renderer; its renderers are exactly these four", () => {
    const exported = publicSurface as Readonly<Record<string, unknown>>;
    expect(exported["renderCoreSections"]).toBeUndefined();
    expect(Object.keys(exported).filter((name) => /core.?sections/iu.test(name))).toEqual([]);
    expect(Object.keys(exported).filter((name) => /^(render|serialize)/u.test(name)).sort()).toEqual([
      "renderApproximateArtifact",
      "renderBacktestArtifact",
      "renderBacktestOutcome",
      "serializeApproximateRun",
    ]);
  });

  it("the public exact renderer refuses an approximate run's core even beside a REAL exact result", async () => {
    const approximate = await completedApproximateRun();
    const exact = await completedExactRun();
    try {
      // The control: the exact run's own core renders.
      expect(publicSurface.renderBacktestArtifact({ outcome: exact.outcome, trader: exact.run.core.trader, store: exact.run.core.store, driver: exact.run.driver }).ok).toBe(true);
      // The approximate core, the approximate store, either alone, or a shallow copy of the approximate
      // trader (no cast: its loop is the approximate run's): refused, nothing rendered.
      for (const input of [
        { outcome: exact.outcome, trader: approximate.run.core.trader, store: approximate.run.core.store, driver: approximate.run.driver },
        { outcome: exact.outcome, trader: approximate.run.core.trader, store: exact.run.core.store, driver: exact.run.driver },
        { outcome: exact.outcome, trader: exact.run.core.trader, store: approximate.run.core.store, driver: exact.run.driver },
        { outcome: exact.outcome, trader: { ...approximate.run.core.trader }, store: exact.run.core.store, driver: exact.run.driver },
      ]) {
        const artifact = publicSurface.renderBacktestArtifact(input);
        expect(artifact.ok).toBe(false);
        if (!artifact.ok) expect(artifact.problem).toContain("REPLAY_MANIFEST_APPROXIMATE");
        if (!artifact.ok) expect(artifact.problem).toContain("built and driven by an approximate replay");
      }
    } finally {
      await approximate.run.core.store.close();
      await exact.run.core.store.close();
    }
  });

  it("the public approximate renderer labels every line of what the approximate core produced", async () => {
    const approximate = await completedApproximateRun();
    try {
      const artifact = publicSurface.renderApproximateArtifact({
        result: approximate.result,
        trader: approximate.run.core.trader,
        store: approximate.run.core.store,
        driver: approximate.run.driver,
      });
      expect(artifact.ok).toBe(true);
      if (!artifact.ok) return;
      const lines = artifact.text.split("\n").filter((line) => line !== "");
      expect(lines[0]).toBe(publicSurface.APPROXIMATE_ARTIFACT_FORMAT_ID);
      expect(lines.slice(1).filter((line) => !line.startsWith("approximate "))).toEqual([]);
      expect(lines.some((line) => line.startsWith("approximate decision seq=0 "))).toBe(true);
      expect(lines.some((line) => line.startsWith("approximate ledger transactions="))).toBe(true);
      expect(lines.some((line) => line.startsWith("approximate health "))).toBe(true);
    } finally {
      await approximate.run.core.store.close();
    }
  });

  it("the exact renderer still refuses an approximate RESULT beside an exact run's core (the fidelity guard, alone)", async () => {
    const approximate = await completedApproximateRun();
    const exact = await completedExactRun();
    try {
      const forged = { ok: true, runMode: "BACKTEST", result: approximate.result } as unknown as Extract<BacktestOutcome, { readonly ok: true }>;
      const artifact = renderBacktestArtifact({ outcome: forged, trader: exact.run.core.trader, store: exact.run.core.store, driver: exact.run.driver });
      expect(artifact.ok).toBe(false);
      if (!artifact.ok) expect(artifact.problem).toContain('REPLAY_MANIFEST_APPROXIMATE: this artifact is evidence of an exact replay, and the result offered is not one (fidelity "approximate")');
    } finally {
      await approximate.run.core.store.close();
      await exact.run.core.store.close();
    }
  });
});
