/**
 * `SER-2`: every byte the WAL persists is a function of the record's OWN
 * data — header line, frame line, footer line, sidecar manifest.
 *
 * THE CLASS. `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE
 * CHAIN (ECMA-262 25.5.2), so a `toJSON` inherited from `Object.prototype` or
 * `Array.prototype` replaces the bytes of ANY object, and one on
 * `BigInt.prototype` turns a bigint's `TypeError` into accepted bytes. Six
 * contexts (`SER-0`): three prototypes × {enumerable assignment,
 * non-enumerable `defineProperty`}.
 *
 * THE SITE (`docs/handoffs/SER-0-sweep.md`, area `wal`). `segment-format.ts`
 * `encodeLine` is the ONE encoder for the three line kinds, and it was
 * `JSON.stringify(value)`. Under an inherited `Object.prototype.toJSON` the
 * frame line the writer persisted was `"INJECTED"\n` — fed to the running
 * SHA-256, attested by the footer and the manifest, reported durable and
 * cleared from `pendingFrames()`; the evidence existed nowhere else
 * (CRITICAL). Header and footer lines by the same route (HIGH), the manifest
 * (fail-closed at every reader; routed for uniformity), and the
 * `maxTotalBytes` reserve measured from `encodeLine` output (MEDIUM, closes
 * with it).
 *
 * THE PINS. (1) The FORMAT guard: the bytes equal a clean `JSON.stringify` of
 * the same literal in `wal-format.md`'s key order — passes at base too, it is
 * what keeps the on-disk format byte-identical. (2) Six-context invariance of
 * the four encoders, with the injected `toJSON` counted at zero. (3) A record
 * the encoder refuses is `WalSegmentIntegrityError("record is not
 * JSON-serializable")` in every context — where base threw an untyped
 * `TypeError` for a bigint in a clean process and accepted bytes under
 * `BigInt.prototype`, and silently omitted or substituted a function, a
 * `Date` or a `Map`. (4) END TO END: a real `WalWriter` over the in-memory
 * filesystem, driven through `enqueue` → `drain` → `close` INSIDE each
 * context, persists the same segment and manifest bytes a clean run persists,
 * and a clean reader verifies them.
 *
 * THE PROTOCOL: `test/unit/ledger/inherited-tojson.ts` for the synchronous
 * encoders; `test/unit/storage-postgres/support/inherited-tojson-async.ts`
 * for the writer, whose `drain`/`close` await the in-memory filesystem.
 * Install → call → capture a STRING → restore in a `finally` → assert.
 */

import { describe, expect, it } from "vitest";

import { WAL_FORMAT_ID, WAL_MANIFEST_VERSION, WAL_SCHEMA_VERSION } from "../../../packages/storage-wal/src/constants.js";
import { WalSegmentIntegrityError } from "../../../packages/storage-wal/src/errors.js";
import {
  encodeSegmentManifest,
  manifestFileName,
  segmentFileName,
} from "../../../packages/storage-wal/src/manifest.js";
import type { WalSegmentManifest } from "../../../packages/storage-wal/src/manifest.js";
import type { RawFrameRecord } from "../../../packages/storage-wal/src/raw-frame.js";
import { readSegmentRecords, validateSegment } from "../../../packages/storage-wal/src/reader.js";
import {
  buildSegmentHeader,
  encodeFooterLine,
  encodeFrameLine,
  encodeHeaderLine,
} from "../../../packages/storage-wal/src/segment-format.js";
import type { WalSegmentFooter } from "../../../packages/storage-wal/src/segment-format.js";
import { createTestFrame, createTestFrames, TEST_GATEWAY_EPOCH } from "../../../packages/storage-wal/src/testing/frames.js";
import { createManualClock } from "../../../packages/storage-wal/src/testing/manual-clock.js";
import { createMemoryFileSystem } from "../../../packages/storage-wal/src/testing/memory-file-system.js";
import type { MemoryFileSystem } from "../../../packages/storage-wal/src/testing/memory-file-system.js";
import { openWalWriter } from "../../../packages/storage-wal/src/writer.js";
import {
  renderDivergences,
  sweepInheritedToJson,
  TOJSON_CONTEXTS,
  withInheritedToJson,
} from "../ledger/inherited-tojson.js";
import { withInheritedToJsonAsync } from "../storage-postgres/support/inherited-tojson-async.js";

// ---------------------------------------------------------------------------
// Fixtures: one of each record kind, in the key order `wal-format.md` fixes
// ---------------------------------------------------------------------------

const SEGMENT_ID = `${TEST_GATEWAY_EPOCH}-000000`;

const HEADER = buildSegmentHeader({
  segmentId: SEGMENT_ID,
  gatewayEpoch: TEST_GATEWAY_EPOCH,
  segmentIndex: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const FRAME: RawFrameRecord = createTestFrame({
  ingestSeq: 7,
  payloadUtf8: '{"event_type":"book","asset_id":"1","bids":[["0.4","10"]],"note":"tab\\tquote\\"lf\\n"}',
});

const FOOTER: WalSegmentFooter = {
  record: "footer",
  formatId: WAL_FORMAT_ID,
  walSchemaVersion: WAL_SCHEMA_VERSION,
  segmentId: SEGMENT_ID,
  gatewayEpoch: TEST_GATEWAY_EPOCH,
  recordCount: 2,
  checksummedByteLength: 512,
  segmentSha256: "a".repeat(64),
  closedAt: "2026-01-01T00:01:00.000Z",
  closeReason: "shutdown",
};

const MANIFEST: WalSegmentManifest = {
  manifestVersion: WAL_MANIFEST_VERSION,
  formatId: WAL_FORMAT_ID,
  walSchemaVersion: WAL_SCHEMA_VERSION,
  segmentId: SEGMENT_ID,
  gatewayEpoch: TEST_GATEWAY_EPOCH,
  segmentIndex: 0,
  segmentFileName: segmentFileName(SEGMENT_ID),
  segmentIdKind: "default",
  recordCount: 2,
  firstIngestSeq: "1",
  lastIngestSeq: "2",
  firstReceivedAt: "2026-01-01T00:00:00.000Z",
  lastReceivedAt: "2026-01-01T00:00:01.000Z",
  byteSize: 700,
  checksummedByteLength: 512,
  segmentSha256: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: "2026-01-01T00:01:00.000Z",
  closeReason: "shutdown",
  footerPresent: true,
  truncatedTailBytes: 0,
};

/** The frame's ten keys in the §9.1 order, as a literal a clean `JSON.stringify` renders. */
function frameLiteral(record: RawFrameRecord): Record<string, unknown> {
  return {
    gatewayEpoch: record.gatewayEpoch,
    ingestSeq: record.ingestSeq,
    source: record.source,
    endpoint: record.endpoint,
    connectionId: record.connectionId,
    subscriptionGeneration: record.subscriptionGeneration,
    receivedAt: record.receivedAt,
    receivedMonotonicNs: record.receivedMonotonicNs,
    payloadUtf8: record.payloadUtf8,
    payloadSha256: record.payloadSha256,
  };
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** A throw-safe rendering of a thrown value, by its own `name`, `code` and details. */
function refusalOf(run: () => Uint8Array): string {
  try {
    return `ok:${text(run())}`;
  } catch (error) {
    if (error instanceof WalSegmentIntegrityError) {
      const kind = Object.getOwnPropertyDescriptor(error.details, "kind")?.value;
      return `threw:${error.name}:${error.code}:${error.message}:${String(kind)}`;
    }
    return `threw:${error instanceof Error ? `${error.name}:-:${error.message}` : "non-error"}`;
  }
}

// ---------------------------------------------------------------------------

describe("the on-disk format is byte-identical to a clean JSON.stringify (format guard; passes at base)", () => {
  it("header line", () => {
    expect(text(encodeHeaderLine(HEADER))).toBe(`${JSON.stringify(HEADER)}\n`);
  });

  it("frame line, in the §9.1 key order", () => {
    expect(text(encodeFrameLine(FRAME))).toBe(`${JSON.stringify(frameLiteral(FRAME))}\n`);
  });

  it("footer line", () => {
    expect(text(encodeFooterLine(FOOTER))).toBe(`${JSON.stringify(FOOTER)}\n`);
  });

  it("sidecar manifest, two-space indented", () => {
    expect(text(encodeSegmentManifest(MANIFEST))).toBe(`${JSON.stringify(MANIFEST, null, 2)}\n`);
  });
});

describe("the four encoders are invariant under the six inherited-toJSON contexts", () => {
  it("emit the clean bytes in every context, and the injected toJSON never runs", () => {
    const sweep = sweepInheritedToJson([
      { name: "header line", render: () => text(encodeHeaderLine(HEADER)) },
      { name: "frame line", render: () => text(encodeFrameLine(FRAME)) },
      { name: "footer line", render: () => text(encodeFooterLine(FOOTER)) },
      { name: "manifest", render: () => text(encodeSegmentManifest(MANIFEST)) },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("frame line")).toBe(`ok:${JSON.stringify(frameLiteral(FRAME))}\n`);
    expect(sweep.clean.get("manifest")).toBe(`ok:${JSON.stringify(MANIFEST, null, 2)}\n`);
  });

  it("JSON.stringify itself IS hijacked in these contexts (the control that keeps the pin honest)", () => {
    const control = sweepInheritedToJson([
      { name: "control", render: () => JSON.stringify(frameLiteral(FRAME)) },
    ]);
    // Object.prototype (2 contexts) replaces the object; Array.prototype and
    // BigInt.prototype leave a flat object of primitives alone.
    expect(control.divergences.map((entry) => entry.context)).toEqual([
      "Object.prototype/enumerable",
      "Object.prototype/non-enumerable",
    ]);
    expect(control.divergences.every((entry) => entry.polluted === 'ok:"INJECTED"')).toBe(true);
  });
});

describe("a record the encoder refuses is a typed WalSegmentIntegrityError in every context", () => {
  const cases: readonly { readonly name: string; readonly record: RawFrameRecord; readonly kind: string }[] = [
    {
      name: "a bigint member",
      record: { ...FRAME, subscriptionGeneration: 1n as unknown as number },
      kind: "BIGINT",
    },
    {
      name: "a function member",
      record: { ...FRAME, payloadUtf8: (() => "x") as unknown as string },
      kind: "EXECUTABLE",
    },
    {
      name: "a Date member (non-plain container)",
      record: { ...FRAME, receivedAt: new Date(0) as unknown as string },
      kind: "NON_PLAIN",
    },
    {
      name: "a Map member (non-plain container)",
      record: { ...FRAME, payloadUtf8: new Map() as unknown as string },
      kind: "NON_PLAIN",
    },
  ];

  for (const entry of cases) {
    it(`${entry.name}: refused as WAL_SEGMENT_INTEGRITY / ${entry.kind}, identically in all six contexts`, () => {
      const answers = new Set<string>();
      const clean = refusalOf(() => encodeFrameLine(entry.record));
      answers.add(clean);
      for (const context of TOJSON_CONTEXTS) {
        const run = withInheritedToJson(context, () => refusalOf(() => encodeFrameLine(entry.record)));
        answers.add(run.result);
        answers.add(`calls=${String(run.calls)}`);
      }
      expect([...answers].filter((answer) => answer.startsWith("calls="))).toEqual(["calls=0"]);
      expect([...answers].filter((answer) => !answer.startsWith("calls="))).toEqual([clean]);
      expect(clean).toBe(
        `threw:WalSegmentIntegrityError:WAL_SEGMENT_INTEGRITY:record is not JSON-serializable:${entry.kind}`,
      );
    });
  }

  it("names the refused path and problem in the error's details", () => {
    let thrown: unknown;
    try {
      encodeFrameLine({ ...FRAME, subscriptionGeneration: 1n as unknown as number });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalSegmentIntegrityError);
    const refusal = thrown as WalSegmentIntegrityError;
    expect(refusal.details).toEqual({
      kind: "BIGINT",
      path: "value.subscriptionGeneration",
      problem: "a bigint has no JSON representation",
    });
  });
});

// ---------------------------------------------------------------------------
// End to end: the writer persists the same bytes under every context
// ---------------------------------------------------------------------------

const DIRECTORY = "/wal";

/**
 * One full writer lifecycle — open (clean), then `enqueue` × 3, `drain`,
 * `close` inside `run` — returning the segment and manifest bytes as text and
 * the writer's own accounting. `run` is the caller's window.
 */
async function writeSegment(
  run: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<{
  readonly files: Readonly<Record<string, string>>;
  readonly durable: string;
  readonly fileSystem: MemoryFileSystem;
}> {
  const fileSystem = createMemoryFileSystem();
  const clock = createManualClock();
  const writer = await openWalWriter({
    directoryPath: DIRECTORY,
    gatewayEpoch: TEST_GATEWAY_EPOCH,
    fileSystem,
    clock,
  });
  const frames = createTestFrames(3, {
    payloadUtf8: '{"event_type":"book","asset_id":"1","bids":[["0.4","10"]]}',
  });
  const durable = await run(async () => {
    const accepted = frames.map((frame) => writer.enqueue(frame).accepted);
    const drained = await writer.drain();
    const manifest = await writer.close();
    return (
      `accepted=${accepted.join(",")} written=${String(drained.framesWritten)} ` +
      `pending=${String(writer.pendingFrames().length)} ` +
      `manifest=${manifest === null ? "null" : `${String(manifest.recordCount)}:${manifest.segmentSha256}`}`
    );
  });
  return { files: fileSystem.snapshot(), durable, fileSystem };
}

describe("a real WalWriter persists the clean bytes under every context (the CRITICAL reach, closed)", () => {
  it("segment and manifest bytes, the durable report and a clean reader's verdict all match the clean run", async () => {
    const clean = await writeSegment(async (work) => await work());
    const cleanSegment = clean.files[`${DIRECTORY}/${segmentFileName(SEGMENT_ID)}`];
    const cleanManifest = clean.files[`${DIRECTORY}/${manifestFileName(SEGMENT_ID)}`];
    expect(cleanSegment).toBeDefined();
    expect(cleanManifest).toBeDefined();
    // Three frame lines between a header and a footer, none of them "INJECTED".
    expect(cleanSegment?.split("\n")).toHaveLength(6);
    expect(cleanSegment?.includes("INJECTED")).toBe(false);
    expect(clean.durable).toMatch(/^accepted=true,true,true written=3 pending=0 manifest=3:[0-9a-f]{64}$/u);

    for (const context of TOJSON_CONTEXTS) {
      const polluted = await withInheritedToJsonAsync(context, async () =>
        await writeSegment(async (work) => await work()),
      );
      expect(polluted.calls, context.name).toBe(0);
      expect(polluted.result.durable, context.name).toBe(clean.durable);
      expect(polluted.result.files, context.name).toEqual(clean.files);

      const verdict = await validateSegment(polluted.result.fileSystem, DIRECTORY, SEGMENT_ID);
      expect(verdict.valid, context.name).toBe(true);
      expect(verdict.issues, context.name).toEqual([]);
      const read = await readSegmentRecords(
        polluted.result.fileSystem,
        `${DIRECTORY}/${segmentFileName(SEGMENT_ID)}`,
      );
      expect(read.records.map((record) => record.ingestSeq), context.name).toEqual(["1", "2", "3"]);
    }
  });
});
