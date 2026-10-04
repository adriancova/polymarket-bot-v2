/**
 * Container start-up that waits until the container really answers
 * (`FLAKES-1`, `TC-LOCAL-FLAKE`). TEST SETUP ONLY.
 *
 * Two infrastructure failures hit local integration runs under host load, each
 * in a different file each time (`BACKTEST-2`, `OUTAGE-2`, `CKPT-1`):
 *
 * 1. A fresh Redis container refused its first connections: "Connection is
 *    closed" at `RedisStreamsEventTransport.connect`, or "a fresh Redis
 *    container never accepted a connection" after a file's own five tries in
 *    2 s. Testcontainers starts Redis by waiting for its "Ready to accept
 *    connections" LOG LINE only; it never checks the mapped host port. Docker
 *    Desktop forwards that port through a proxy that can accept a TCP
 *    connection before it can reach the container, and then closes it.
 * 2. "Failed to connect to Reaper": testcontainers' own connection to its Ryuk
 *    container, which it tries for only 4 s, over the same kind of forwarded
 *    port. The start throws before the file's container is even created.
 *
 * So a container is handed to a test only once a real protocol exchange has
 * crossed the mapped port: a Redis `PING` answered `+PONG`, or a PostgreSQL
 * `SSLRequest` answered with its one-byte reply. Both need no credential. A
 * start that fails ONLY on the reaper connection is tried again. Both waits
 * are bounded and fail loudly with what they saw.
 *
 * Nothing here is product code, and nothing here retries a test's claim: no
 * assertion runs until setup has finished.
 */

import { Socket } from "node:net";

import { startRedisContainer } from "@polymarket-bot/event-bus/testing";

/** How long a fresh container may take to answer through its mapped port. */
export const CONTAINER_READY_WITHIN_MS = 30_000;
/** Pause between two readiness probes. */
const PROBE_INTERVAL_MS = 250;
/** One probe's own bound: connect, send, and read the reply. */
const PROBE_TIMEOUT_MS = 2_000;
/** Attempts at a start whose only failure is testcontainers' reaper connection. */
export const REAPER_START_ATTEMPTS = 3;
/** Pause before another start attempt after a reaper failure. */
const REAPER_RETRY_PAUSE_MS = 1_000;
/** The exact message testcontainers throws when its reaper never answers. */
const REAPER_CONNECT_FAILURE = "Failed to connect to Reaper";

type StartedRedis = Awaited<ReturnType<typeof startRedisContainer>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `true` for testcontainers' reaper-connection failure, and only for it. */
export function isReaperConnectFailure(failure: unknown): boolean {
  return failure instanceof Error && failure.message === REAPER_CONNECT_FAILURE;
}

/**
 * Runs `start`, and runs it again (at most {@link REAPER_START_ATTEMPTS} times
 * in all) only when it failed on testcontainers' reaper connection. Any other
 * failure is thrown at once.
 *
 * A failed reaper connection leaves testcontainers with no reaper, so the next
 * start looks for one again: it reuses a running Ryuk if it can reach one, and
 * otherwise starts its own.
 */
export async function startRetryingReaperConnect<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (failure) {
      if (!isReaperConnectFailure(failure) || attempt >= REAPER_START_ATTEMPTS) throw failure;
      await sleep(REAPER_RETRY_PAUSE_MS);
    }
  }
}

/**
 * Connects to `host:port`, writes `request`, and settles with the first bytes
 * the server sends back. Rejects on a refused or closed connection, and after
 * {@link PROBE_TIMEOUT_MS}.
 */
function exchange(host: string, port: number, request: Buffer, enough: (received: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(received);
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`no reply within ${String(PROBE_TIMEOUT_MS)} ms`));
    }, PROBE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (enough(received)) finish(undefined);
    });
    socket.on("error", (error: Error) => {
      finish(error);
    });
    socket.on("close", () => {
      finish(new Error(`the connection closed after ${String(received.length)} byte(s)`));
    });
    socket.connect(port, host, () => {
      socket.write(request);
    });
  });
}

/** A RESP `PING`, answered `+PONG` by a Redis that is really serving. */
export async function redisAnswersPing(host: string, port: number): Promise<void> {
  const reply = await exchange(host, port, Buffer.from("*1\r\n$4\r\nPING\r\n", "latin1"), (received) =>
    received.includes("\r\n"),
  );
  const text = reply.toString("latin1");
  if (!text.startsWith("+PONG\r\n")) throw new Error(`PING answered ${JSON.stringify(text)}`);
}

/**
 * A PostgreSQL `SSLRequest` (length 8, code 80877103), answered by a server
 * that is really serving with ONE byte: `N` (no TLS) or `S`. It needs no
 * credential and starts no session.
 */
export async function postgresAnswersSslRequest(host: string, port: number): Promise<void> {
  const request = Buffer.alloc(8);
  request.writeInt32BE(8, 0);
  request.writeInt32BE(80_877_103, 4);
  const reply = await exchange(host, port, request, (received) => received.length >= 1);
  const answer = String.fromCharCode(reply[0] ?? 0);
  if (answer !== "N" && answer !== "S") throw new Error(`SSLRequest answered ${JSON.stringify(answer)}`);
}

/**
 * Probes until `probe` succeeds once, at most for `withinMs`. Throws, naming
 * `what`, the attempts made and the last failure, if it never does.
 */
export async function waitUntilAnswering(
  what: string,
  probe: () => Promise<void>,
  withinMs: number = CONTAINER_READY_WITHIN_MS,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  let lastFailure: unknown;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await probe();
      return;
    } catch (failure) {
      lastFailure = failure;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${what} did not answer within ${String(withinMs)} ms (${String(attempt)} probes); last: ${String(lastFailure)}`,
      );
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

/**
 * A throwaway Redis container (`startRedisContainer`, the pinned image) that
 * has answered a `PING` through its mapped port. A container that never
 * answers is stopped before the failure is thrown.
 */
export async function startReadyRedisContainer(): Promise<StartedRedis> {
  const container = await startRetryingReaperConnect(startRedisContainer);
  const host = container.getHost();
  const port = container.getPort();
  try {
    await waitUntilAnswering(`the fresh Redis container at ${host}:${String(port)}`, () =>
      redisAnswersPing(host, port),
    );
  } catch (failure) {
    await container.stop().catch(() => undefined);
    throw failure;
  }
  return container;
}
