/**
 * `THROUGHPUT-1a` — the paced publisher, a SEPARATE Node process (bundled by
 * `tools/bench/trader-throughput/run.sh` beside `bench-main.ts`, which spawns
 * it). The gateway is its own process, so the publication work must not share
 * the trader's event loop in a benchmark of whether the trader keeps pace.
 *
 * It reads the already-remapped envelopes (JSONL), connects its own
 * `RedisStreamsEventTransport` and publishes them with `publisher.ts` in
 * `paced` mode, then writes the publish log (every publication instant, host
 * epoch milliseconds) as JSON for the parent to measure lag against.
 */

import { writeFile } from "node:fs/promises";

import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";

import { readEnvelopes } from "./fixture.js";
import { publishEnvelopes } from "./publisher.js";

function valueOf(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function main(argv: readonly string[]): Promise<number> {
  const envelopes = await readEnvelopes(valueOf(argv, "--fixture"));
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: valueOf(argv, "--redis-url") },
    retention: { maxEvents: Number(valueOf(argv, "--retention")) },
  });
  try {
    const log = await publishEnvelopes({
      transport,
      stream: valueOf(argv, "--stream"),
      envelopes,
      mode: "paced",
      paceFrom: Number(valueOf(argv, "--pace-from")),
    });
    await writeFile(valueOf(argv, "--out"), JSON.stringify(log));
    process.stderr.write(
      `[publisher] ${String(envelopes.length)} envelopes in ${((log.finishedAtMs - log.startedAtMs) / 1000).toFixed(2)} s, ` +
        `max schedule slip ${log.maxScheduleSlipMs.toFixed(1)} ms\n`,
    );
    return 0;
  } finally {
    await transport.close();
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((cause: unknown) => {
  process.stderr.write(`publisher failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  return 2;
});
