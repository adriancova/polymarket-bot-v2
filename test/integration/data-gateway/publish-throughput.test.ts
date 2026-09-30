/**
 * `THROUGHPUT-1b` — the gateway's publish path against a REAL Redis.
 *
 * The only file in this suite that needs Docker: it starts its own throwaway
 * Redis (Testcontainers, the pinned `redis:7.4.2-alpine`) in `beforeAll`, as
 * four of the trader suite's files do. Everything else here runs the REAL
 * `GatewayPublisher` over the REAL `RedisStreamsEventTransport` with the
 * publisher's DEFAULT admission bounds.
 *
 * 1. The benchmark path cannot rot: the harness (`./bench/publish-bench.ts`)
 *    replays the committed sample (`./fixtures/burst-sample-2026-09-29T2100.jsonl`,
 *    2,800 envelopes around the busiest second of H1 run 1's window open) at
 *    TWICE its recorded pace — a mean of about 6,300 events/s, 4× the
 *    package's 1,500/s target — and every envelope is published, in order,
 *    with no overflow. Measured before this package (base `051d058`), the
 *    same replay overflowed the admission queue in every run; the candidate
 *    peaked at about 60 of 1,024 (`tools/bench/gateway/README.md`).
 * 2. Byte identity: the stream entries the batched path writes are, field for
 *    field, the ones per-envelope publication writes.
 * 3. The runner script (`tools/bench/gateway/run.sh`) runs end to end.
 * 4. Fail-closed is intact: a transport that stops answering (a frozen TCP
 *    hop — the `docker pause` shape, see `startFreezableRedisProxy`) still
 *    fills the admission queue and halts `GATEWAY_PUBLISH_ADMISSION_OVERFLOW`
 *    at 1024/1024, and the stream holds a prefix that ends before the halt.
 * 5. An envelope refused INSIDE a batch halts `GATEWAY_PUBLISH_REJECTED`, the
 *    envelopes before it are in the stream, and nothing after it is.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublicationHalt } from "@polymarket-bot/data-gateway";
import { GatewayPublisher } from "@polymarket-bot/data-gateway";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import {
  readRawStreamEntries,
  startFreezableRedisProxy,
  startRedisContainer,
  uniqueStreamName,
} from "@polymarket-bot/event-bus/testing";
import type { FreezableRedisProxy, RawStreamEntry } from "@polymarket-bot/event-bus/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  benchClock,
  parseEnvelopeLines,
  restampEnvelopes,
  runPublishBench,
} from "./bench/publish-bench.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const SAMPLE = resolve(here, "fixtures/burst-sample-2026-09-29T2100.jsonl");
const RUNNER = resolve(repoRoot, "tools/bench/gateway/run.sh");
const EPOCH = "0190aaaa-0000-7000-8000-0000000000b1";
/** The gateway's default retention (`GATEWAY_RETENTION_EVENTS`). */
const RETENTION = { maxEvents: 100_000 };

let redisUrl: string;
let stopRedis: (() => Promise<void>) | undefined;
let recorded: EventEnvelope<unknown>[];
const opened: RedisStreamsEventTransport[] = [];
const proxies: FreezableRedisProxy[] = [];

beforeAll(async () => {
  const container = await startRedisContainer();
  redisUrl = container.getConnectionUrl();
  stopRedis = async () => {
    await container.stop();
  };
  recorded = parseEnvelopeLines(await readFile(SAMPLE, "utf8"));
}, 180_000);

afterEach(async () => {
  for (const transport of opened.splice(0, opened.length)) await transport.close();
  for (const proxy of proxies.splice(0, proxies.length)) await proxy.close();
});

afterAll(async () => {
  await stopRedis?.();
}, 120_000);

async function connect(url: string = redisUrl): Promise<RedisStreamsEventTransport> {
  const transport = await RedisStreamsEventTransport.connect({ connection: { url }, retention: RETENTION });
  opened.push(transport);
  return transport;
}

async function frozenHop(): Promise<FreezableRedisProxy> {
  const proxy = await startFreezableRedisProxy(redisUrl);
  proxies.push(proxy);
  return proxy;
}

function ingestSeqsOf(entries: readonly RawStreamEntry[]): readonly string[] {
  return entries.map((entry) => (JSON.parse(entry.fields[3] ?? "{}") as { ingestSeq: string }).ingestSeq);
}

/** The sample's own mean rate: the envelopes over the span of their receipt instants. */
function recordedMeanRate(envelopes: readonly EventEnvelope<unknown>[]): number {
  const first = envelopes[0];
  const last = envelopes[envelopes.length - 1];
  if (first === undefined || last === undefined) return 0;
  const spanMs = Number(BigInt(last.receivedMonotonicNs) - BigInt(first.receivedMonotonicNs)) / 1e6;
  return ((envelopes.length - 1) / spanMs) * 1000;
}

describe("the gateway publish path on a real Redis (THROUGHPUT-1b)", () => {
  it("the committed sample at TWICE its recorded pace: every envelope published, in order, default bounds, no overflow", async () => {
    expect(recorded).toHaveLength(2_800);
    const envelopes = restampEnvelopes(recorded, EPOCH);
    const rate = 2 * recordedMeanRate(recorded);
    expect(rate).toBeGreaterThan(6_000);
    const transport = await connect();
    const stream = uniqueStreamName("tp1b-sample");

    const result = await runPublishBench({ transport, stream, envelopes, offeredRate: rate, pacing: "recorded" });

    expect(result.halt).toBeUndefined();
    expect(result.overflowed).toBe(false);
    expect(result.published).toBe(2_800);
    expect(result.notPublished).toBe(0);
    // The DEFAULT bounds, untouched.
    expect(result.queueMaxDepth).toBe(1_024);
    expect(result.queueMaxBytes).toBe(8 * 1024 * 1024);
    expect(result.queueMaxDepthObserved).toBeLessThan(1_024);
    // Batching really happened: fewer round trips than envelopes.
    expect(result.submissions).toBeLessThan(2_800);

    const entries = await readRawStreamEntries({ url: redisUrl, stream });
    expect(entries).toHaveLength(2_800);
    expect(entries.map((entry) => entry.fields[1])).toStrictEqual(envelopes.map((_, index) => String(index + 1)));
    expect(ingestSeqsOf(entries)).toStrictEqual(envelopes.map((envelope) => envelope.ingestSeq));
  }, 60_000);

  it("the batched path writes, field for field, the entries per-envelope publication writes", async () => {
    const envelopes = restampEnvelopes(recorded, EPOCH);
    const transport = await connect();
    const single = uniqueStreamName("tp1b-identity-single");
    const batched = uniqueStreamName("tp1b-identity-batched");
    for (const envelope of envelopes) await transport.publish(single, envelope);
    const result = await runPublishBench({ transport, stream: batched, envelopes, offeredRate: "saturate" });
    expect(result.published).toBe(2_800);
    expect(result.submissions).toBeLessThan(2_800);

    const singleEntries = await readRawStreamEntries({ url: redisUrl, stream: single });
    const batchedEntries = await readRawStreamEntries({ url: redisUrl, stream: batched });
    expect(batchedEntries.map((entry) => entry.fields)).toStrictEqual(singleEntries.map((entry) => entry.fields));
  }, 60_000);

  it("the runner script builds the benchmark and prints one JSON report per rate", async () => {
    const out = await mkdtemp(join(tmpdir(), "tp1b-bench-"));
    try {
      const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolveRun, rejectRun) => {
          const child = spawn(
            "bash",
            [RUNNER, "--redis-url", redisUrl, "--fixture", SAMPLE, "--rates", "1500 saturate", "--limit", "600"],
            { cwd: repoRoot, env: { ...process.env, PMB_BENCH_OUT: out }, stdio: ["ignore", "pipe", "pipe"] },
          );
          let collected = "";
          let errors = "";
          child.stdout.on("data", (chunk: Buffer) => {
            collected += String(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            errors += String(chunk);
          });
          child.on("error", rejectRun);
          child.on("exit", (exitCode) => {
            resolveRun({ code: exitCode, stdout: collected, stderr: errors });
          });
        },
      );
      expect(code, stderr).toBe(0);
      const reports = stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(reports.map((report) => report["offeredRate"])).toStrictEqual([1500, "saturate"]);
      for (const report of reports) {
        expect(report).toMatchObject({ envelopes: 600, published: 600, overflowed: false, queueMaxDepth: 1_024 });
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("fail-closed on the real transport is intact (THROUGHPUT-1b)", () => {
  it("a transport that stops answering (the docker-pause shape) still overflows the admission bound and halts; the stream ends before the halt", async () => {
    const hop = await frozenHop();
    const transport = await connect(hop.url);
    const stream = uniqueStreamName("tp1b-stall");
    const envelopes = restampEnvelopes(recorded, EPOCH);
    let thawTimer: ReturnType<typeof setTimeout> | undefined;

    const result = await runPublishBench({
      transport,
      stream,
      envelopes,
      offeredRate: 1_500,
      afterAdmit: (index) => {
        if (index !== 300) return;
        hop.freeze();
        // Released well after the queue has filled (1,024 at 1,500/s is about
        // 0.7 s) and well inside the 5 s response deadline, so what was in
        // flight lands and the halt boundary is observable in the stream.
        thawTimer = setTimeout(() => {
          hop.thaw();
        }, 2_000);
      },
    });
    if (thawTimer !== undefined) clearTimeout(thawTimer);

    const halt = result.halt as PublicationHalt;
    expect(halt.cause).toBe("GATEWAY_PUBLISH_ADMISSION_OVERFLOW");
    expect(halt.detail).toContain("depth 1024/1024");
    expect(result.overflowed).toBe(true);
    expect(result.queueMaxDepthObserved).toBe(1_024);
    // The refused envelope is the last one offered: offering stops at the halt.
    expect(halt.haltedAtIngestSeq).toBe(String(result.offered));
    expect(result.offered).toBeLessThan(2_800);
    expect(result.published + result.notPublished).toBe(result.offered);

    // The stream holds exactly what the publisher counted as published: a
    // prefix of the input, in order, ending before the halt.
    const entries = await readRawStreamEntries({ url: redisUrl, stream });
    expect(entries).toHaveLength(result.published);
    expect(ingestSeqsOf(entries)).toStrictEqual(
      envelopes.slice(0, result.published).map((envelope) => envelope.ingestSeq),
    );
    // Publication was really flowing until the hop froze, and nothing
    // admitted AFTER the freeze was published: once frozen, the one run in
    // flight cannot complete until the thaw, and by then publication has
    // halted, so the published prefix is at most envelopes 0..300 (index 300
    // is the admission that froze the hop, which may itself have been the
    // run in flight). Exactly where in that range it ends is timing.
    //
    // `THROUGHPUT-2` (ADR-024, frame-atomic runs): a run is never cut inside a
    // raw frame, so the run in flight may carry index 300's WHOLE frame —
    // here indices 300 and 301 share one `causationId` (the recorded
    // two-token `price_change`). The bound is therefore the end of that frame
    // (302 envelopes, 0..301), still before anything admitted after it.
    let frameEnd = 301;
    while (envelopes[frameEnd]?.causationId !== undefined && envelopes[frameEnd]?.causationId === envelopes[300]?.causationId) {
      frameEnd += 1;
    }
    expect(frameEnd).toBe(302);
    expect(result.published).toBeGreaterThan(200);
    expect(result.published).toBeLessThanOrEqual(frameEnd);
    expect(BigInt(ingestSeqsOf(entries).at(-1) ?? "0") < BigInt(halt.haltedAtIngestSeq)).toBe(true);
  }, 60_000);

  it("an envelope refused INSIDE a batch halts GATEWAY_PUBLISH_REJECTED; the prefix is in the stream and nothing after it", async () => {
    const transport = await connect();
    const stream = uniqueStreamName("tp1b-in-batch-refusal");
    const envelopes = restampEnvelopes(recorded.slice(0, 8), EPOCH);
    // The admission encoder accepts it (it is plain JSON); the transport's
    // envelope door refuses it (not an ISO timestamp).
    envelopes[4] = { ...(envelopes[4] as EventEnvelope<unknown>), receivedAt: "not-a-timestamp" };
    const halts: PublicationHalt[] = [];
    const publisher = new GatewayPublisher({
      transport,
      stream,
      clock: benchClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });

    // Admitted in one synchronous turn, as the dispatcher admits a frame's
    // events. `THROUGHPUT-1b`: the first started the pump and went out alone,
    // and the other seven went as ONE batch behind it. `THROUGHPUT-2`
    // (ADR-024, frame-atomic runs): the first envelope names a raw frame, so
    // the pump waits one microtask before cutting its first run, and all
    // eight — everything admitted in the turn — go as ONE batch. The refusal
    // inside it behaves exactly as before.
    const outcomes = envelopes.map((envelope) => publisher.enqueue(envelope));
    const settled = await Promise.all(outcomes);
    await publisher.settle();

    expect(publisher.metrics().largestSubmission).toBe(8);
    expect(settled.map((outcome) => (outcome.published ? "published" : outcome.reason))).toStrictEqual([
      "published",
      "published",
      "published",
      "published",
      "transport-rejected",
      "publication-halted",
      "publication-halted",
      "publication-halted",
    ]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ cause: "GATEWAY_PUBLISH_REJECTED", haltedAtIngestSeq: "5" });
    const entries = await readRawStreamEntries({ url: redisUrl, stream });
    expect(ingestSeqsOf(entries)).toStrictEqual(["1", "2", "3", "4"]);
    expect(entries.map((entry) => entry.fields[1])).toStrictEqual(["1", "2", "3", "4"]);
  }, 60_000);
});
