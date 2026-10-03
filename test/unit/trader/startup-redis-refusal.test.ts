/**
 * `OUTAGE-1` item 1 (`B1-R1-REDIS-UNCAUGHT`): Redis at startup is a
 * documented refusal, never an escape.
 *
 * Before this round, `startup()` awaited `RedisStreamsEventTransport.connect`
 * without a catch. An unreachable Redis escaped as an uncaught
 * `EventBusUnavailableError`, with a stack trace and exit 1, against the
 * function's own "Never throws" (`BUNDLE-1`, measured through the shipped
 * bundle). Here, the real `startup()` runs on the shipped example
 * configuration (`infra/compose/trader/trader.config.example.json`) with Redis
 * and PostgreSQL both at a loopback port nothing listens on. That needs no
 * container and no network.
 *
 * Also pinned: `TRADER_REDIS_RESPONSE_TIMEOUT_MS`, the door for the outage
 * bound (item 2). The mid-run outage itself is Testcontainers evidence:
 * `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  readRedisResponseTimeout,
  REDIS_RESPONSE_TIMEOUT_ENV,
  REDIS_RESPONSE_TIMEOUT_RANGE,
  startup,
} from "../../../apps/trader/src/main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXAMPLE_CONFIG = path.join(repoRoot, "infra", "compose", "trader", "trader.config.example.json");

/** A credential-shaped secret that must never reach a log line. */
const SECRET = "not-a-real-secret-4f1c";

/** Nothing listens on port 1 of the loopback: a connect is refused at once. */
const UNREACHABLE_REDIS = `redis://operator:${SECRET}@127.0.0.1:1`;
const UNREACHABLE_POSTGRES = `postgres://operator:${SECRET}@127.0.0.1:1/polymarket_bot`;

function safeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    TRADER_CONFIG_PATH: EXAMPLE_CONFIG,
    REDIS_URL: UNREACHABLE_REDIS,
    DATABASE_URL: UNREACHABLE_POSTGRES,
    ...overrides,
  };
}

/** The real `startup()`; what it returned and every line it logged. */
async function run(env: Record<string, string | undefined>): Promise<{ code: number; lines: string[]; text: string }> {
  const lines: string[] = [];
  const code = await startup({
    env,
    readConfig: async (file) => await readFile(file, "utf8"),
    log: (line) => {
      lines.push(line);
    },
  });
  return { code, lines, text: lines.join("\n") };
}

/** No line of a stack trace: the refusal is a sentence, not a crash. */
function expectNoStack(lines: readonly string[]): void {
  expect(lines.filter((line) => /^\s*at\s/u.test(line))).toStrictEqual([]);
}

describe("an unreachable Redis at startup is a documented refusal (OUTAGE-1, B1-R1-REDIS-UNCAUGHT)", () => {
  it("returns infrastructureUnavailable (69) — never throws — naming Redis and the endpoint, with no stack, no credential and no database touched", async () => {
    const outcome = await run(safeEnv());

    expect(outcome.code).toBe(EXIT_CODES.infrastructureUnavailable);
    expect(EXIT_CODES.infrastructureUnavailable).toBe(69);
    expect(outcome.text).toContain(
      "REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at " +
        "redis://127.0.0.1:1 could not be reached.",
    );
    expect(outcome.text).toContain("EventBusUnavailableError: could not connect to the event transport; caused by");
    expectNoStack(outcome.lines);
    expect(outcome.text).not.toContain(SECRET);
    expect(outcome.text).not.toContain("operator");
    // Refused before any database pool: the registration check never ran.
    expect(outcome.text).not.toContain("registration:");
    expect(outcome.text).not.toContain("TRADER_REGISTRATION_");
    // The steps before it still ran and said so.
    expect(outcome.text).toContain("safety: OK");
    expect(outcome.text).toContain("configuration: OK");
  });

  it("a REDIS_URL the transport refuses outright (a wrong scheme) is a configuration refusal (78), not an outage", async () => {
    const outcome = await run(safeEnv({ REDIS_URL: `http://operator:${SECRET}@127.0.0.1:1` }));

    expect(outcome.code).toBe(EXIT_CODES.configurationRefused);
    expect(outcome.text).toContain(
      "REFUSING TO START: TRADER_REDIS_URL_REFUSED: the event transport refused its settings " +
        "(REDIS_URL http://127.0.0.1:1,",
    );
    expect(outcome.text).toContain("EventBusConfigurationError: connection url must use the `redis:` or `rediss:` scheme");
    expect(outcome.text).not.toContain("TRADER_REDIS_UNAVAILABLE");
    expectNoStack(outcome.lines);
    expect(outcome.text).not.toContain(SECRET);
  });

  it("a REDIS_URL that is not a URL at all is a configuration refusal (78) and is not echoed", async () => {
    // No `scheme:` at all, so `new URL` throws. (`operator:secret…` would parse,
    // as a URL whose scheme is `operator:`, and be refused for that scheme.)
    const outcome = await run(safeEnv({ REDIS_URL: `${SECRET} at the usual place` }));

    expect(outcome.code).toBe(EXIT_CODES.configurationRefused);
    expect(outcome.text).toContain("REFUSING TO START: TRADER_REDIS_URL_REFUSED");
    expect(outcome.text).toContain("(REDIS_URL (a value that is not a URL),");
    expect(outcome.text).not.toContain(SECRET);
    expectNoStack(outcome.lines);
  });
});

describe(`${REDIS_RESPONSE_TIMEOUT_ENV}: the stated outage bound (OUTAGE-1, BOOT1-R7)`, () => {
  it("a bound it cannot accept is refused (78) before any connection is attempted", async () => {
    const outcome = await run(safeEnv({ [REDIS_RESPONSE_TIMEOUT_ENV]: "5s" }));

    expect(outcome.code).toBe(EXIT_CODES.configurationRefused);
    expect(outcome.text).toContain(
      `REFUSING TO START: TRADER_REDIS_RESPONSE_TIMEOUT_REFUSED: ${REDIS_RESPONSE_TIMEOUT_ENV}="5s" is not an ` +
        "integer number of milliseconds in [100, 60000]",
    );
    expect(outcome.text).not.toContain("TRADER_REDIS_UNAVAILABLE");
    expect(outcome.text).not.toContain("event transport bound:");
  });

  it("the bound in force is stated, with the exit bound derived from it", async () => {
    const stated = await run(safeEnv({ [REDIS_RESPONSE_TIMEOUT_ENV]: "250" }));
    expect(stated.text).toContain(
      `event transport bound: every Redis command must answer within 250 ms (${REDIS_RESPONSE_TIMEOUT_ENV}); ` +
        "a Redis outage latches a GLOBAL TRANSPORT_UNAVAILABLE halt within that bound of the first command " +
        "it leaves unanswered, and the process exits 75 at most 500 ms after the halt (one bound for each " +
        "connection's courtesy QUIT) plus the durable halt record (at most 5000 ms) and the PostgreSQL close (§4.2)",
    );

    const defaulted = await run(safeEnv());
    expect(defaulted.text).toContain(
      `event transport bound: every Redis command must answer within 5000 ms (${REDIS_RESPONSE_TIMEOUT_ENV} ` +
        "unset; the default)",
    );
  });

  it("unset or empty is the transport's default; the range is seconds, not minutes", () => {
    expect(REDIS_RESPONSE_TIMEOUT_RANGE).toStrictEqual({ minimumMs: 100, maximumMs: 60_000 });
    expect(readRedisResponseTimeout({})).toStrictEqual({ ok: true, responseTimeoutMs: 5_000, defaulted: true });
    expect(readRedisResponseTimeout({ [REDIS_RESPONSE_TIMEOUT_ENV]: "" })).toStrictEqual({
      ok: true,
      responseTimeoutMs: 5_000,
      defaulted: true,
    });
  });

  it.each(["100", "1000", "5000", "60000"])("accepts %s", (raw) => {
    expect(readRedisResponseTimeout({ [REDIS_RESPONSE_TIMEOUT_ENV]: raw })).toStrictEqual({
      ok: true,
      responseTimeoutMs: Number(raw),
      defaulted: false,
    });
  });

  it.each(["99", "60001", "0", "-5", "1e3", "01000", "1000.0", " 1000", "1000 ", "0x3e8", "abc", "1000000"])(
    "refuses %j rather than clamping or guessing",
    (raw) => {
      const result = readRedisResponseTimeout({ [REDIS_RESPONSE_TIMEOUT_ENV]: raw });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("accepted");
      expect(result.refusal.code).toBe("TRADER_REDIS_RESPONSE_TIMEOUT_REFUSED");
      expect(result.refusal.detail).toContain(JSON.stringify(raw));
    },
  );

  it("reads an OWN property only: a value inherited through the environment's prototype is not a statement", () => {
    const inherited = Object.create({ [REDIS_RESPONSE_TIMEOUT_ENV]: "100" }) as Record<string, string | undefined>;
    expect(readRedisResponseTimeout(inherited)).toStrictEqual({ ok: true, responseTimeoutMs: 5_000, defaulted: true });
  });
});
