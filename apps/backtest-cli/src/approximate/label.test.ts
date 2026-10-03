/**
 * `APPROX-REPLAY-1` r1 — one logical line, one physical line, labelled
 * (APPROX-R1-H1), and the approximate core sections never unlabelled
 * (APPROX-R1-H2).
 *
 * `escapeLineText` is checked over EVERY UTF-16 code unit, not a sample: no
 * output holds a line break or a control, every rewritten unit starts its
 * escape with a backslash, and ordinary text keeps its bytes.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRunPins } from "@polymarket-bot/simulation";
import { fileSystemObjectStore } from "@polymarket-bot/storage-parquet";
import { afterAll, describe, expect, it } from "vitest";

import { renderApproximateCoreSections } from "../artifact.js";
import { runBacktestCore } from "../assembly.js";
import { escapeLineText, labelLine, labelledLog } from "./label.js";
import { runApproximateBacktest } from "./run.js";
import { APPROXIMATE_TRANSLATION_VERSION } from "./translate.js";
import { bar, depth, gammaPoll, writeResearchDataset } from "./test-support.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "test", "replay-golden", "backtest", "static-bracket");
const CONFIG = JSON.parse(readFileSync(join(FIXTURE, "trader-config.json"), "utf8")) as Record<string, unknown>;
const EXACT_PINS_DOCUMENT = JSON.parse(readFileSync(join(FIXTURE, "run-pins.json"), "utf8")) as Record<string, unknown>;
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

const scratch = mkdtempSync(join(tmpdir(), "approx-replay-label-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Every character a common reader ends a line at. */
const LINE_BREAKS: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

describe("escapeLineText: one logical line is one physical line", () => {
  it("leaves text with no control, separator or backslash byte-identical", () => {
    for (const text of ["", "plain", "decision seq=0 reasons=SB.ARMED", "ünïcødé — ‘quotes’ 𝔘 €", "a/b:c=d,e"]) {
      expect(escapeLineText(text)).toBe(text);
    }
  });

  it("escapes every separator a reader honours, every control and the backslash, by the stated rule", () => {
    expect(escapeLineText("a\nb")).toBe("a\\nb");
    expect(escapeLineText("a\rb")).toBe("a\\rb");
    expect(escapeLineText("a\r\nb")).toBe("a\\r\\nb");
    expect(escapeLineText("a\tb")).toBe("a\\tb");
    expect(escapeLineText("a\\nb")).toBe("a\\\\nb");
    expect(escapeLineText("\u000b\u000c\u001c\u001d\u001e\u0085  \u001b\u0000\u007f\u009f")).toBe(
      "\\u000b\\u000c\\u001c\\u001d\\u001e\\u0085\\u2028\\u2029\\u001b\\u0000\\u007f\\u009f",
    );
  });

  it("over every UTF-16 code unit: no output holds a line break or a control, and only the stated units change", () => {
    const changed: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const text = `x${String.fromCharCode(code)}y`;
      const escaped = escapeLineText(text);
      for (let index = 0; index < escaped.length; index += 1) {
        const unit = escaped.charCodeAt(index);
        if (LINE_BREAKS.has(unit) || isControl(unit)) throw new Error(`U+${code.toString(16)} left a control in ${JSON.stringify(escaped)}`);
      }
      if (escaped !== text) {
        changed.push(code);
        expect(escaped.startsWith("x\\")).toBe(true);
      }
    }
    const expected: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) if (code === 0x5c || isControl(code)) expected.push(code);
    expect(changed).toEqual(expected);
  });

  it("is injective on the cases a forger would try: an escaped break never equals a literal one", () => {
    const inputs = ["a\nb", "a\\nb", "a\\\nb", "a\\\\nb", "a b", "a\\u2028b"];
    const outputs = new Set(inputs.map(escapeLineText));
    expect(outputs.size).toBe(inputs.length);
  });
});

describe("labelLine and labelledLog", () => {
  it("labelLine prefixes the fidelity and escapes the text", () => {
    expect(labelLine("approximate", "decisions_persisted=1\nrisk_refusals=0")).toBe("approximate decisions_persisted=1\\nrisk_refusals=0");
  });

  it("labelledLog labels and escapes every line it passes on", () => {
    const lines: string[] = [];
    const log = labelledLog("approximate", (line) => lines.push(line));
    log("SUBMISSION REFUSED: planned\norder");
    log("plain");
    expect(lines).toEqual(["approximate SUBMISSION REFUSED: planned\\norder", "approximate plain"]);
  });
});

describe("renderApproximateCoreSections: what an approximate core produced is never rendered unlabelled", () => {
  it("labels every line of an approximate core's sections, and refuses a fidelity other than approximate", async () => {
    const root = join(scratch, "store");
    const written = await writeResearchDataset({
      root,
      datasetId: "core-sections",
      samples: [
        bar({ ordinal: 0, seq: "1", atMs: T0 }, { spanStartMs: T0 - 1_000, close: "64000" }),
        gammaPoll({ ordinal: 1, seq: "1", atMs: T0 }, { gammaMarketId: "777", active: true, closed: false, acceptingOrders: true }),
        depth({ ordinal: 2, seq: "2", atMs: T0 + 1_000 }, { spanStartMs: T0, conditionId: "0xbacktest1condition", tokenId: "9101", bids: [["0.32", "200"]], asks: [["0.34", "30"]] }),
      ],
    });
    const started = await runApproximateBacktest({
      environment: {},
      traderConfig: CONFIG,
      runPins: { ...EXACT_PINS_DOCUMENT, normalizerVersion: APPROXIMATE_TRANSLATION_VERSION },
      objectStore: fileSystemObjectStore(root),
      manifestObjectKeys: [written.manifestObjectKey],
      gammaMarketIds: new Map([["019b1e00-0000-7000-8000-000000000001", "777"]]),
    });
    if (!started.ok) throw new Error(started.refusal.detail);
    const run = started.run;
    try {
      const input = { trader: run.core.trader, store: run.core.store, driver: run.driver };
      const sections = renderApproximateCoreSections(input, run.fidelity);
      expect(sections.ok).toBe(true);
      if (!sections.ok) return;
      expect(sections.lines.length).toBeGreaterThan(5);
      expect(sections.lines.filter((line) => !line.startsWith("approximate "))).toEqual([]);
      expect(sections.lines).toContain("approximate --- decisions ---");
      expect(sections.lines.at(-1)).toBe("approximate end");
      for (const fidelity of ["exact", "", "approximate\nx", undefined]) {
        const refused = renderApproximateCoreSections(input, fidelity as unknown as "approximate");
        expect(refused.ok, String(fidelity)).toBe(false);
      }
    } finally {
      await run.core.store.close();
    }
  });

  it("labels an exact core's sections too: it never returns an unlabelled line, whatever core it is handed", async () => {
    const pins = readRunPins(EXACT_PINS_DOCUMENT);
    if (!pins.ok) throw new Error(pins.refusal.message);
    const started = await runBacktestCore({ environment: {}, traderConfig: CONFIG, runPins: pins.value, datasetDirectory: FIXTURE });
    if (!started.ok) throw new Error(started.refusal.detail);
    try {
      const sections = renderApproximateCoreSections(
        { trader: started.run.core.trader, store: started.run.core.store, driver: started.run.driver },
        "approximate",
      );
      expect(sections.ok).toBe(true);
      if (sections.ok) expect(sections.lines.filter((line) => !line.startsWith("approximate "))).toEqual([]);
    } finally {
      await started.run.core.store.close();
    }
  });
});
