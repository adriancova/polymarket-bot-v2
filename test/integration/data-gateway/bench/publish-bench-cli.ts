/**
 * The gateway publish benchmark (`THROUGHPUT-1b` item 1): the command-line half.
 *
 * Run it through `tools/bench/gateway/run.sh`, which bundles this file with
 * esbuild (the gateway's own runtime build convention), gives it a Redis, and
 * optionally CPU-profiles it. Directly, after bundling:
 *
 *   node publish-bench.cjs --redis-url redis://127.0.0.1:6379 \
 *     --fixture burst.jsonl --rate 1500 [--pacing uniform|recorded] \
 *     [--limit N] [--retention N] [--prefill N] [--epoch UUID] [--stream NAME]
 *
 * `--rate` is events per second, or `saturate` for the closed-loop ceiling;
 * `--pacing` spreads a numeric rate uniformly (the default) or along the
 * recording's own receipt instants, scaled to that mean rate (see
 * `./publish-bench.ts`). One JSON document describing the run is printed on
 * stdout; progress goes to stderr.
 *
 * `--prefill N` first publishes N envelopes under a SEPARATE epoch, so the
 * measured run meets a stream already at its retention bound and every
 * publish trims, as it does in a gateway that has been up for a while. The
 * prefill is setup: it is not timed and not reported as a rate.
 *
 * `--epoch` fixes the measured run's epoch, so two runs (base and candidate)
 * stamp byte-identical envelopes and their streams can be compared entry by
 * entry. The default is a fresh random epoch per run.
 *
 * SAFETY: public, recorded market data only; the only connection this opens is
 * the Redis URL it is given. No credential, signer, wallet, or order path.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";

import type { OfferedRate, Pacing } from "./publish-bench.js";
import { parseEnvelopeLines, restampEnvelopes, runPublishBench } from "./publish-bench.js";

interface CliOptions {
  readonly redisUrl: string;
  readonly fixture: string;
  readonly rate: OfferedRate;
  readonly pacing: Pacing;
  readonly limit: number | undefined;
  readonly retention: number;
  readonly prefill: number;
  readonly epoch: string;
  readonly stream: string;
}

/** The gateway's default retention (`GATEWAY_RETENTION_EVENTS`, `main.ts`). */
const DEFAULT_RETENTION_EVENTS = 100_000;

/** Concurrent epochs the prefill publishes through; setup speed only. */
const PREFILL_EPOCHS = 64;

function parseCount(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} needs a whole number, received ${String(value)}`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value pairs, received ${JSON.stringify(argv.slice(index))}`);
    }
    values.set(flag, value);
  }
  const known = new Set([
    "--redis-url",
    "--fixture",
    "--rate",
    "--pacing",
    "--limit",
    "--retention",
    "--prefill",
    "--epoch",
    "--stream",
  ]);
  for (const flag of values.keys()) {
    if (!known.has(flag)) throw new Error(`unknown flag ${flag}`);
  }
  const redisUrl = values.get("--redis-url");
  const fixture = values.get("--fixture");
  const rateText = values.get("--rate");
  if (redisUrl === undefined || fixture === undefined || rateText === undefined) {
    throw new Error("--redis-url, --fixture and --rate are required");
  }
  const rate: OfferedRate = rateText === "saturate" ? "saturate" : Number(rateText);
  if (rate !== "saturate" && (!Number.isFinite(rate) || rate <= 0)) {
    throw new Error(`--rate needs events per second or "saturate", received ${rateText}`);
  }
  const pacingText = values.get("--pacing") ?? "uniform";
  if (pacingText !== "uniform" && pacingText !== "recorded") {
    throw new Error(`--pacing needs "uniform" or "recorded", received ${pacingText}`);
  }
  const limitText = values.get("--limit");
  return {
    redisUrl,
    fixture,
    rate,
    pacing: pacingText,
    limit: limitText === undefined ? undefined : parseCount("--limit", limitText),
    retention: parseCount("--retention", values.get("--retention") ?? String(DEFAULT_RETENTION_EVENTS)),
    prefill: parseCount("--prefill", values.get("--prefill") ?? "0"),
    epoch: values.get("--epoch") ?? randomUUID(),
    stream: values.get("--stream") ?? `bench-${randomUUID().slice(0, 8)}`,
  };
}

/**
 * Publishes `count` envelopes under throwaway epochs, many epochs at once.
 *
 * The transport serializes publication per epoch, so one epoch would take as
 * long as the thing being measured; several epochs publish concurrently on the
 * one connection. The measured run then starts on a stream at its bound.
 */
async function prefill(
  transport: MarketEventTransport,
  stream: string,
  source: readonly EventEnvelope<unknown>[],
  count: number,
): Promise<void> {
  if (count === 0 || source.length === 0) return;
  const perEpoch = Math.ceil(count / PREFILL_EPOCHS);
  const chains: Promise<void>[] = [];
  for (let chain = 0; chain < PREFILL_EPOCHS; chain += 1) {
    const epoch = randomUUID();
    const first = chain * perEpoch;
    const last = Math.min(count, first + perEpoch);
    chains.push(
      (async () => {
        for (let index = first; index < last; index += 1) {
          const envelope = source[index % source.length];
          if (envelope === undefined) continue;
          await transport.publish(stream, { ...envelope, gatewayEpoch: epoch, ingestSeq: String(index + 1) });
        }
      })(),
    );
  }
  await Promise.all(chains);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const recorded = parseEnvelopeLines(await readFile(options.fixture, "utf8"));
  const selected = options.limit === undefined ? recorded : recorded.slice(0, options.limit);
  const envelopes = restampEnvelopes(selected, options.epoch);

  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: options.redisUrl },
    retention: { maxEvents: options.retention },
  });
  try {
    if (options.prefill > 0) {
      process.stderr.write(`[bench] prefilling ${String(options.prefill)} envelopes\n`);
      await prefill(transport, options.stream, recorded, options.prefill);
    }
    process.stderr.write(
      `[bench] offering ${String(envelopes.length)} envelopes at ${String(options.rate)} ` +
        `(${options.pacing} pacing, stream ${options.stream})\n`,
    );
    const result = await runPublishBench({
      transport,
      stream: options.stream,
      envelopes,
      offeredRate: options.rate,
      pacing: options.pacing,
    });
    const report = {
      fixture: options.fixture,
      stream: options.stream,
      epoch: options.epoch,
      retention: options.retention,
      prefill: options.prefill,
      offeredRate: result.offeredRate,
      pacing: result.offeredRate === "saturate" ? "closed-loop" : result.pacing,
      envelopes: result.envelopes,
      offered: result.offered,
      published: result.published,
      notPublished: result.notPublished,
      overflowed: result.overflowed,
      haltCause: result.halt?.cause,
      haltedAtIngestSeq: result.halt?.haltedAtIngestSeq,
      elapsedMs: Number(result.elapsedMs.toFixed(1)),
      offerElapsedMs: Number(result.offerElapsedMs.toFixed(1)),
      achievedOfferRate: Number(result.achievedOfferRate.toFixed(1)),
      sustainedPublishRate: Number(result.sustainedPublishRate.toFixed(1)),
      queueMaxDepthObserved: result.queueMaxDepthObserved,
      queueMaxDepth: result.queueMaxDepth,
      queueMaxBytesObserved: result.queueMaxBytesObserved,
      queueMaxBytes: result.queueMaxBytes,
      submissions: result.submissions,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await transport.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[bench] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
