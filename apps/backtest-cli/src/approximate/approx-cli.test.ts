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
 * r1 (APPROX-R1-H1): "every line" means every PHYSICAL line. Every check below
 * splits on every character a common reader ends a line at (LF, CR, CRLF,
 * VT, FF, FS, GS, RS, NEL, LS, PS), and the r1 block drives text holding each
 * of them through every sink — a manifest's admissibility and dataset id, a
 * refusal's detail, a translation stop's detail — and requires every one to
 * come out as one escaped, labelled line, never a line of its own.
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
    // `CADENCE-1` (ADR-026 D1.5): an approximate replay is never a reproduction.
    evaluationIntervalMs: 1000,
    evaluationHeartbeatMs: 5000,
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

/** Every character a common reader ends a line at: LF, CR (and CRLF), VT, FF, FS, GS, RS, NEL, LS, PS. */
const LINE_BREAKS: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/** The physical lines of what a sink received (a sink call may carry several: the run serialization is one call). */
function physicalLines(lines: readonly string[]): string[] {
  const physical: string[] = [];
  for (const text of lines) {
    let current = "";
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (LINE_BREAKS.has(code)) {
        physical.push(current);
        current = "";
        if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
      } else {
        current += text.charAt(index);
      }
    }
    physical.push(current);
  }
  return physical;
}

/** A C0 or C1 control, DEL, LS or PS: none may survive into an approximate output line. */
function holdsControl(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Every non-empty PHYSICAL line carries the label, except the named format-id lines; none holds a control. */
function everyLineLabelled(lines: readonly string[], exempt: readonly string[] = []): void {
  const physical = physicalLines(lines);
  expect(physical.length).toBeGreaterThan(0);
  const unlabelled = physical.filter((line) => line !== "" && !exempt.includes(line) && !line.startsWith("approximate "));
  expect(unlabelled).toEqual([]);
  expect(physical.filter(holdsControl)).toEqual([]);
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

/**
 * r1 (APPROX-R1-H1): text a manifest, a row or an argument carries can hold a
 * line break, and the published parser admits it (`admissibility` and
 * `datasetId` are any non-empty string). Each sink must print it as ONE
 * escaped, labelled line: never a physical line the label does not cover, and
 * never a line of its own that reads like one of the run's counters.
 *
 * Every line separator a common reader honours, in one statement.
 */
const FORGED = [
  "approximate: research only",
  "decisions_persisted=987654321\rrisk_refusals=0\r\nfills=5",
  "VT\u000bFF\u000cFS\u001cGS\u001dRS\u001eNEL\u0085LS PS ESC\u001b[2KTAB\tDEL\u007f\\n-is-literal",
].join("\n");
/** The same statement escaped by hand (backslash doubled; LF, CR, TAB by name; every other control as \uXXXX). */
const FORGED_ESCAPED =
  "approximate: research only\\ndecisions_persisted=987654321\\rrisk_refusals=0\\r\\nfills=5\\n" +
  "VT\\u000bFF\\u000cFS\\u001cGS\\u001dRS\\u001eNEL\\u0085LS\\u2028PS\\u2029ESC\\u001b[2KTAB\\tDEL\\u007f\\\\n-is-literal";

/** No physical line that starts as a counter, other than the one real counter line of each name. */
function noForgedCounter(physical: readonly string[]): void {
  for (const name of ["decisions_persisted", "risk_refusals", "fills"]) {
    const counters = physical.filter((line) => line.startsWith(`${name}=`) || line.startsWith(`approximate ${name}=`));
    expect(counters.length, name).toBeLessThanOrEqual(1);
  }
}

describe("r1, APPROX-R1-H1: text holding a line break never prints an unlabelled or forged line", () => {
  it("a re-sealed multiline admissibility statement: report, run serialization and artifact each print it as one escaped, labelled line", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "multiline", samples: opening() });
    resealManifest(store, written.manifestObjectKey, (manifest) => {
      manifest["admissibility"] = FORGED;
    });
    const artifact = join(scratch, `multiline-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_OK);

    everyLineLabelled(result.out, [APPROXIMATE_RUN_SERIALIZATION_VERSION]);
    expect(result.err.filter((line) => !line.startsWith("approximate "))).toEqual([]);
    const out = physicalLines(result.out);
    noForgedCounter(out);
    // The forged value appears only inside the escaped admissibility lines.
    expect(out.filter((line) => line.includes("987654321") && !line.includes("admissibility"))).toEqual([]);
    expect(out).toContain(`approximate admissibility=${FORGED_ESCAPED}`);
    // The run serialization (one sink call) carries it once, escaped too.
    expect(out).toContain(`approximate admissibility ${FORGED_ESCAPED}`);
    expect(out.filter((line) => line.startsWith("approximate decisions_persisted="))).toHaveLength(1);
    expect(out).not.toContain("approximate decisions_persisted=987654321");

    const lines = physicalLines([readFileSync(artifact, "utf8")]);
    expect(lines[0]).toBe(APPROXIMATE_ARTIFACT_FORMAT_ID);
    everyLineLabelled(lines.slice(1));
    noForgedCounter(lines);
    expect(lines.filter((line) => line.includes("987654321") && !line.includes("admissibility"))).toEqual([]);
    expect(lines).toContain(`approximate admissibility ${FORGED_ESCAPED}`);
  });

  it("a re-sealed multiline dataset id: the run serialization's and the artifact's dataset line stay one labelled line", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "dataset-id", samples: opening() });
    resealManifest(store, written.manifestObjectKey, (manifest) => {
      manifest["datasetId"] = "dataset-id\nrisk_refusals=0";
    });
    const artifact = join(scratch, `dataset-id-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_OK);
    everyLineLabelled(result.out, [APPROXIMATE_RUN_SERIALIZATION_VERSION]);
    noForgedCounter(physicalLines(result.out));
    expect(physicalLines(result.out).some((line) => line.startsWith("approximate dataset id=dataset-id\\nrisk_refusals=0 fidelity=approximate "))).toBe(true);
    const lines = physicalLines([readFileSync(artifact, "utf8")]);
    everyLineLabelled(lines.slice(1));
    noForgedCounter(lines);
    expect(lines.some((line) => line.startsWith("approximate dataset id=dataset-id\\nrisk_refusals=0 fidelity=approximate "))).toBe(true);
  });

  it("a refusal after a manifest verified, whose detail carries a manifest's line break, prints one labelled line per issue", async () => {
    const store = fresh("store");
    const one = await writeResearchDataset({ root: store, datasetId: "chain-a", samples: opening() });
    const two = await writeResearchDataset({
      root: store,
      datasetId: "chain-b",
      segmentIndex: 1,
      samples: [bar({ ...r(0, "9", T0 + 9_000), segment: `${EPOCH}-000001` }, { spanStartMs: T0 + 8_000, close: "1" })],
    });
    resealManifest(store, two.manifestObjectKey, (manifest) => {
      manifest["datasetId"] = "chain-b\nrisk_refusals=0";
    });
    const result = await cli(approxArgv(store, `${one.manifestObjectKey},${two.manifestObjectKey}`, join(scratch, "never-r1.txt")));
    expect(result.code).toBe(EXIT_REFUSED);
    everyLineLabelled(result.err);
    expect(physicalLines(result.err)).toHaveLength(result.err.length);
    noForgedCounter(physicalLines(result.err));
    expect(result.err).toContain("approximate   datasetId=chain-b\\nrisk_refusals=0");
  });

  it("a translation stop whose detail carries a row's line break prints one labelled line per detail", async () => {
    const store = fresh("store");
    const samples: FixtureSample[] = [
      ...opening(),
      depth(r(5, "3", T0 + 2_000), {
        spanStartMs: T0 + 1_000,
        conditionId: "0xother\nrisk_refusals=0",
        tokenId: "9101",
        bids: [["0.32", "200"]],
        asks: [["0.34", "30"]],
      }),
    ];
    const written = await writeResearchDataset({ root: store, datasetId: "row-detail", samples });
    const artifact = join(scratch, `row-detail-${String(counter)}.txt`);
    const result = await cli(approxArgv(store, written.manifestObjectKey, artifact));
    expect(result.code).toBe(EXIT_REFUSED);
    everyLineLabelled(result.err);
    expect(physicalLines(result.err)).toHaveLength(result.err.length);
    noForgedCounter(physicalLines(result.err));
    expect(result.err).toContain("approximate   sampleConditionId=0xother\\nrisk_refusals=0");
    expect(existsSync(artifact)).toBe(false);
  });

  it("a refusal before any manifest verified carries no label, and still prints one physical line per line", async () => {
    const store = fresh("store");
    const result = await cli(approxArgv(store, "missing\nrisk_refusals=0/manifest.json", join(scratch, "never-r1-2.txt")));
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err[0]).toMatch(/^REFUSED: APPROX_REPLAY_DATASET_UNVERIFIED: .*carries no fidelity label\)$/u);
    expect(physicalLines(result.err)).toHaveLength(result.err.length);
    expect(physicalLines(result.err).filter(holdsControl)).toEqual([]);
    noForgedCounter(physicalLines(result.err));
    expect(result.err.some((line) => line.includes("missing\\nrisk_refusals=0/manifest.json"))).toBe(true);
  });

  it("the command's own refusals before anything is read (an argument, a file error) are one physical line each", async () => {
    const store = fresh("store");
    const written = await writeResearchDataset({ root: store, datasetId: "pre-read", samples: opening() });
    const pins = join(scratch, "missing\ndecisions_persisted=987654321\npins.json");
    const missingPins = await cli(approxArgv(store, written.manifestObjectKey, join(scratch, "never-r1-3.txt"), { pins }));
    expect(missingPins.code).toBe(EXIT_REFUSED);
    const config = join(scratch, "missing\rrisk_refusals=0\u2028config.json");
    const missingConfig = await cli(approxArgv(store, written.manifestObjectKey, join(scratch, "never-r1-4.txt"), { config }));
    expect(missingConfig.code).toBe(EXIT_REFUSED);
    const badOption = await cli([...approxArgv(store, written.manifestObjectKey, join(scratch, "never-r1-5.txt")), "--x\nfills=5", "y"]);
    expect(badOption.code).toBe(EXIT_USAGE);
    for (const result of [missingPins, missingConfig, badOption]) {
      expect(result.err.length).toBeGreaterThan(0);
      expect(physicalLines(result.err)).toHaveLength(result.err.length);
      expect(physicalLines(result.err).filter(holdsControl)).toEqual([]);
      noForgedCounter(physicalLines(result.err));
      expect(result.out).toEqual([]);
    }
    expect(missingPins.err[0]).toContain("missing\\ndecisions_persisted=987654321\\npins.json");
  });
});
