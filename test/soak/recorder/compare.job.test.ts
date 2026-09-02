/**
 * The book snapshot-comparison JOB (`WP-140`) — run via
 * `pnpm --dir test/soak/recorder run soak:compare-books`.
 *
 * "Book reconstruction is checked against snapshots" (Wave 1 closeout;
 * Phase-1 operational gate). The pure comparator lives in
 * `packages/observability/src/recorder/book-comparison.ts` (unit-tested
 * there); this job is its I/O driver over a real recorded WAL:
 *
 *   - With `SOAK_WAL_DIR` set: reads every epoch's Polymarket frames from
 *     the WAL root, compares reconstruction against every recorded
 *     authoritative snapshot, writes `book-comparison.json` (a per-epoch
 *     report plus finding metrics text) into the evidence directory, and
 *     FAILS if any epoch diverges — a divergence is a defect in the
 *     recording or the venue's delta contract, and must not pass silently.
 *
 *   - Without it (the automated posture): drives the same reader + comparator
 *     over a synthetic WAL written to a temp directory — segment lines in the
 *     real WAL line shapes, digests computed for internal consistency, and
 *     CLEARLY a fixture (loopback provenance strings). This proves the JOB
 *     works before anyone points it at soak output; it claims nothing about
 *     any real recording.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  compareRecordedBooks,
  renderExposition,
  validationMetricSamples,
  type BookComparisonReport,
} from "../../../packages/observability/src/recorder/index.js";
import { readRecordedFrames } from "./src/wal-frames.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = process.env["SOAK_EVIDENCE_DIR"] ?? resolve(here, "evidence");
const realWalDir = process.env["SOAK_WAL_DIR"];

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Write one synthetic-but-well-formed WAL segment (FIXTURE, labeled so). */
function writeFixtureWal(): string {
  const root = mkdtempSync(join(tmpdir(), "compare-fixture-wal-"));
  scratchDirs.push(root);
  const epoch = "fixture-epoch-0001";
  const asset = "1111"; // fixture token id
  mkdirSync(join(root, epoch), { recursive: true });
  const events: unknown[] = [
    { event_type: "book", asset_id: asset, bids: [{ price: "0.40", size: "100" }], asks: [{ price: "0.60", size: "50" }] },
    { event_type: "price_change", price_changes: [{ asset_id: asset, price: "0.41", size: "25", side: "BUY" }] },
    { event_type: "book", asset_id: asset, bids: [{ price: "0.40", size: "100" }, { price: "0.41", size: "25" }], asks: [{ price: "0.60", size: "50" }] },
  ];
  const lines: string[] = [
    JSON.stringify({
      record: "header",
      formatId: "fixture",
      walSchemaVersion: 1,
      segmentId: "seg-000001",
      gatewayEpoch: epoch,
      segmentIndex: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
    }),
  ];
  events.forEach((event, index) => {
    const payloadUtf8 = JSON.stringify(event);
    lines.push(
      JSON.stringify({
        gatewayEpoch: epoch,
        ingestSeq: String(index + 1),
        source: "polymarket",
        endpoint: "wss://127.0.0.1:1/fixture",
        connectionId: "fixture-conn-1",
        subscriptionGeneration: 1,
        receivedAt: "2026-09-01T00:00:01.000Z",
        receivedMonotonicNs: String(1_000_000 * (index + 1)),
        payloadUtf8,
        payloadSha256: sha256Hex(payloadUtf8),
      }),
    );
  });
  // Plus one non-polymarket frame the reader must filter out.
  const binancePayload = JSON.stringify({ e: "trade", s: "BTCUSDT" });
  lines.push(
    JSON.stringify({
      gatewayEpoch: epoch,
      ingestSeq: "4",
      source: "binance",
      endpoint: "wss://127.0.0.1:1/fixture",
      connectionId: "fixture-conn-2",
      subscriptionGeneration: 1,
      receivedAt: "2026-09-01T00:00:02.000Z",
      receivedMonotonicNs: "5000000",
      payloadUtf8: binancePayload,
      payloadSha256: sha256Hex(binancePayload),
    }),
  );
  writeFileSync(join(root, epoch, "seg-000001.wal.jsonl"), `${lines.join("\n")}\n`);
  return root;
}

interface EpochReportEntry {
  readonly gatewayEpoch: string;
  readonly report: BookComparisonReport;
}

function runJob(walRoot: string): {
  readonly epochs: EpochReportEntry[];
  readonly linesRefused: number;
} {
  const { epochs, linesRefused } = readRecordedFrames(walRoot, "polymarket");
  return {
    epochs: epochs.map((epoch) => ({
      gatewayEpoch: epoch.gatewayEpoch,
      report: compareRecordedBooks(epoch.frames),
    })),
    linesRefused,
  };
}

describe("book snapshot comparison job", () => {
  it("drives the reader and comparator over a WAL and reports per epoch", () => {
    // Machinery proof on the labeled fixture; nothing here claims anything
    // about a real recording.
    const outcome = runJob(writeFixtureWal());
    expect(outcome.linesRefused).toBe(0);
    expect(outcome.epochs).toHaveLength(1);
    const report = outcome.epochs[0]?.report;
    expect(report?.ok).toBe(true);
    expect(report?.snapshotsVerified).toBe(1);
    expect(report?.baselinesEstablished).toBe(1);
    expect(report?.deltasApplied).toBe(1);
    // The binance frame was filtered by source, not misread as a book frame.
    expect(report?.framesSeen).toBe(3);
  });

  it("a diverging recording is reported, not passed", () => {
    const root = mkdtempSync(join(tmpdir(), "compare-diverge-wal-"));
    scratchDirs.push(root);
    const epoch = "fixture-epoch-0002";
    mkdirSync(join(root, epoch), { recursive: true });
    const asset = "2222";
    const events = [
      { event_type: "book", asset_id: asset, bids: [{ price: "0.40", size: "100" }], asks: [] },
      // A missing delta in the record: the next snapshot disagrees.
      { event_type: "book", asset_id: asset, bids: [{ price: "0.40", size: "90" }], asks: [] },
    ];
    const lines = [
      JSON.stringify({ record: "header", gatewayEpoch: epoch, segmentId: "seg-000001" }),
      ...events.map((event, index) => {
        const payloadUtf8 = JSON.stringify(event);
        return JSON.stringify({
          gatewayEpoch: epoch,
          ingestSeq: String(index + 1),
          source: "polymarket",
          endpoint: "wss://127.0.0.1:1/fixture",
          connectionId: "fixture-conn-1",
          subscriptionGeneration: 1,
          receivedAt: "2026-09-01T00:00:01.000Z",
          receivedMonotonicNs: String(index + 1),
          payloadUtf8,
          payloadSha256: sha256Hex(payloadUtf8),
        });
      }),
    ];
    writeFileSync(join(root, epoch, "seg-000001.wal.jsonl"), `${lines.join("\n")}\n`);
    const outcome = runJob(root);
    const report = outcome.epochs[0]?.report;
    expect(report?.ok).toBe(false);
    expect(report?.snapshotsDiverged).toBe(1);
    expect(report?.findings[0]?.check).toBe("book-divergence");
  });

  it("with SOAK_WAL_DIR set: compares the real recording and writes the report", () => {
    if (realWalDir === undefined || realWalDir === "") {
      // The automated posture ran above; the real-WAL posture needs a real
      // recording, which only an operator-run soak provides.
      console.error(
        "soak:compare-books — SOAK_WAL_DIR not set; fixture-machinery checks ran, real-WAL comparison skipped (set SOAK_WAL_DIR to a recorded WAL root)",
      );
      return;
    }
    const outcome = runJob(realWalDir);
    mkdirSync(evidenceDir, { recursive: true });
    const reportPath = join(evidenceDir, "book-comparison.json");
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          walRoot: realWalDir,
          linesRefused: outcome.linesRefused,
          epochs: outcome.epochs,
        },
        null,
        2,
      )}\n`,
    );
    const findings = outcome.epochs.flatMap((epoch) => epoch.report.findings);
    const ok = outcome.epochs.every((epoch) => epoch.report.ok) && outcome.linesRefused === 0;
    writeFileSync(
      join(evidenceDir, "book-comparison.prom"),
      renderExposition(
        validationMetricSamples({
          job: "book-comparison",
          ok,
          findings,
        }),
      ),
    );
    console.error(
      `soak:compare-books — ${String(outcome.epochs.length)} epoch(s); report ${reportPath}`,
    );
    for (const epoch of outcome.epochs) {
      const r = epoch.report;
      console.error(
        `  ${epoch.gatewayEpoch}: verified ${String(r.snapshotsVerified)}, diverged ${String(r.snapshotsDiverged)}, deltas ${String(r.deltasApplied)}, findings ${String(r.findings.length)}`,
      );
    }
    // A real divergence or an unreadable line MUST fail the job.
    expect(outcome.linesRefused).toBe(0);
    for (const epoch of outcome.epochs) {
      expect(
        epoch.report.ok,
        `epoch ${epoch.gatewayEpoch} diverged — see ${reportPath}`,
      ).toBe(true);
    }
  });
});
