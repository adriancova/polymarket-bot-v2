/**
 * `WP-250` DELIVERABLE 2: **deterministic golden output.**
 *
 * Three claims, each with its own test:
 *
 * 1. two fresh runs of the same scenario, assembled and driven independently
 *    inside one process, produce BYTE-IDENTICAL artefacts;
 * 2. a run produces bytes identical to the COMMITTED golden;
 * 3. the comparison is falsifiable — a one-character change to the artefact
 *    changes the bytes, so the byte identity above is a fact about the run and
 *    not about a serialiser that discards detail.
 *
 * §12.4's replay gate (`pnpm test:replay`, `WP-090` + `WP-210`) is a DIFFERENT
 * gate over different subjects and is untouched by this package. This golden
 * freezes the paper-core end-to-end surface `WP-230` and `WP-240` assembled.
 *
 * ## Determinism hygiene in this tree
 *
 * No wall clock (`ManualClock`, positioned only by the scenario's literal
 * instants), no `Math.random`, no `crypto.randomUUID` (the trader mints ids
 * from `idNamespace` through `DeterministicIdFactory`), no host entropy, no
 * network, no ambient environment read. The one machine-dependent value the
 * run produces — `DecisionTelemetry.evaluationDurationUs`, which
 * `packages/strategy-runtime` documents as excluded from `DecisionRecord` for
 * exactly this reason — is not in the artefact, and `artifact.ts` says so.
 */

import { describe, expect, it } from "vitest";

import { captureArtifact, serializeArtifact } from "./support/artifact.js";
import {
  firstDifference,
  goldenBytes,
  regenerationRequested,
  writeGoldenBytes,
  WRITE_GOLDEN_ENV,
} from "./support/golden.js";
import { driveScenario } from "./support/harness.js";

async function runBytes(): Promise<string> {
  return serializeArtifact(captureArtifact(await driveScenario()));
}

describe("deterministic golden output", () => {
  it("two fresh in-suite runs produce byte-identical artefacts", async () => {
    const first = await runBytes();
    const second = await runBytes();
    expect(second.length).toBe(first.length);
    expect(firstDifference(second, first)).toBe("the two byte strings are identical");
    expect(second).toBe(first);
  });

  it("a run is byte-identical to the committed golden", async () => {
    const produced = await runBytes();

    if (regenerationRequested(process.env)) {
      writeGoldenBytes(produced);
      throw new Error(
        `${WRITE_GOLDEN_ENV} was set, so the committed golden has been REWRITTEN from this ` +
          "run. That is not evidence of anything: read the diff, decide whether the change is " +
          "intended, and re-run the suite WITHOUT the variable. This failure is deliberate.",
      );
    }

    const golden = goldenBytes();
    expect(firstDifference(produced, golden)).toBe("the two byte strings are identical");
    expect(produced).toBe(golden);
  });

  it("the golden ends in exactly one newline and uses LF endings only", () => {
    const golden = goldenBytes();
    expect(golden.endsWith("\n")).toBe(true);
    expect(golden.endsWith("\n\n")).toBe(false);
    expect(golden.includes("\r")).toBe(false);
  });

  it("the comparison is falsifiable: one changed character changes the bytes", async () => {
    const run = await driveScenario();
    const artifact = captureArtifact(run);
    const honest = serializeArtifact(artifact);
    const tampered = serializeArtifact({
      ...artifact,
      scenario: { ...artifact.scenario, startingCash: "1001" },
    });
    expect(tampered).not.toBe(honest);
    expect(firstDifference(tampered, honest)).not.toBe("the two byte strings are identical");
    // …and the tampered bytes do not match the committed golden either, which
    // is the property the golden comparison actually rests on.
    expect(tampered).not.toBe(goldenBytes());
  });

  it("the golden parses back into the document the chain walk reads", async () => {
    const golden = goldenBytes();
    const parsed = JSON.parse(golden) as Record<string, unknown>;
    const produced = captureArtifact(await driveScenario());
    expect(parsed["goldenFormatVersion"]).toBe(produced.goldenFormatVersion);
    // A round trip through the committed BYTES, not through the live objects:
    // whatever the walk asserts, it asserts about what is on disk.
    expect(serializeArtifact(parsed as unknown as typeof produced)).toBe(golden);
  });
});
