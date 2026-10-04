/**
 * `OUTAGE-1` item 3 (`BOOT1-CONFIGPARAMS`): the registered config's
 * parameters are checked against the configuration document at startup.
 *
 * ## What was true before this round
 *
 * `verifyRegisteredRows` pinned WHICH config a run executes (`config_id`) but
 * never read what that config SAYS. `BRACKET-1c`'s implementer found it: a
 * config registered with `reentry.maximum_entries_per_market: 1` and a
 * document carrying `2` started without a word, so the durable record and
 * the running strategy disagreed. §9.6 and §10.7 make the registered config
 * the run's pinned, immutable parameters.
 *
 * ## What this file proves, against a real PostgreSQL
 *
 * 1. **The packet's case, through the real `startup()`.** Registered max
 *    entries 1, document 2. The process refuses with
 *    `TRADER_REGISTRATION_MISMATCH` and exit 78, naming the field by JSON
 *    Pointer and both values. It opens no subscription and writes nothing.
 * 2. **Canonical, not textual.** A document whose every object lists its keys
 *    in REVERSE order still passes. PostgreSQL's `jsonb` reorders keys on
 *    storage anyway, so the stored row never has the document's order, and
 *    every earlier registration in this suite already depends on this.
 * 3. **An extra key, a missing key and a changed decimal string are each
 *    refused**, named by their pointers.
 *
 * The comparison rules themselves (number vs its decimal string, arrays,
 * `null`, the depth bound, the truncated list) are pinned without a database
 * in `test/unit/trader/registered-parameters.test.ts`.
 *
 * ## Docker
 *
 * Testcontainers, as the other `-postgres` files: its own `beforeAll`, no
 * `globalSetup`, no skip when Docker is absent. Redis is started only because
 * the real `startup()` connects to it before the registration check. There
 * are throwaway credentials only; the environment is `PAPER`, with no venue,
 * no signer and no real order. `TC-LOCAL-FLAKE`: Redis is proved to answer
 * (a bounded retry) before any process under test connects to it.
 */

import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleDurableTrader, EXIT_CODES, startup, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { safeEnvironment, strategyParams } from "./support/fixture.js";
import { documentFor, registerThroughTheRepositories, withFreshDatabase, type Registered } from "./support/registration.js";
import { startReadyPostgresContainer, startReadyRedisContainer } from "./support/containers.js";

let postgres: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startReadyRedisContainer>>;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startReadyPostgresContainer(), startReadyRedisContainer()]);
  // `TC-LOCAL-FLAKE`: a fresh container's first connect has been seen to fail
  // locally. Prove it answers before anything under test depends on it.
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const probe = await RedisStreamsEventTransport.connect({
        connection: { url: redis.getConnectionUrl() },
        retention: { maxEvents: 100 },
      });
      await probe.close();
      return;
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError)) throw failure;
      lastFailure = failure;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(`the Redis container never accepted a connection: ${String(lastFailure)}`);
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

type Params = Record<string, unknown>;

/** A deep copy of the fixture's §13.2 document, changed by `edit`. */
function paramsWith(edit: (params: Params) => void): Params {
  const params = structuredClone(strategyParams());
  edit(params);
  return params;
}

function section(params: Params, key: string): Params {
  const value = params[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the fixture params lost their ${key} section`);
  }
  return value as Params;
}

/** The fixture document for `registered`, with its one instance running `params`. */
function documentRunning(registered: Registered, label: string, params: Params): Record<string, unknown> {
  const base = documentFor(registered, label);
  const [instance] = base["instances"] as Record<string, unknown>[];
  if (instance === undefined) throw new Error("the fixture configuration lost its instance");
  return {
    ...base,
    infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: uniqueStreamName(label) },
    instances: [{ ...instance, params }],
  };
}

/** Every object in `value` with its keys in reverse order; arrays keep theirs. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversedKeys(inner)]),
  );
}

/** Steps 3b and 4 of `startup()` (the same function), on a document; what it logged. */
async function assemble(document: Record<string, unknown>, postgresUrl: string) {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  const lines: string[] = [];
  const result = await assembleDurableTrader({
    env: safeEnvironment(),
    config: parsed.config,
    document,
    postgresUrl,
    clock: new SystemPaperClock(),
    log: (line) => {
      lines.push(line);
    },
  });
  if (result.ok) {
    // Nothing is pumped: only the registration verdict is under test.
    await result.healthServer?.close();
    await result.store.close();
  }
  return { result, log: lines.join("\n") };
}

describe("the registered config's parameters must be the ones the document runs (OUTAGE-1, BOOT1-CONFIGPARAMS)", () => {
  it("registered with maximum_entries_per_market 1, run with 2: the real startup() REFUSES — TRADER_REGISTRATION_MISMATCH, exit 78, naming the field", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "params-max-entries", async ({ connectionString, context }) => {
      const label = "params-max-entries";
      // The fixture registers `reentry.maximum_entries_per_market: 1`.
      expect(section(strategyParams(), "reentry")["maximum_entries_per_market"]).toBe(1);
      const registered = await registerThroughTheRepositories(context, label);
      const document = documentRunning(
        registered,
        label,
        paramsWith((params) => {
          section(params, "reentry")["maximum_entries_per_market"] = 2;
        }),
      );

      const lines: string[] = [];
      const exit = startup({
        env: {
          ...safeEnvironment(),
          TRADER_CONFIG_PATH: "/params-max-entries.json",
          REDIS_URL: redis.getConnectionUrl(),
          DATABASE_URL: connectionString,
        },
        readConfig: () => Promise.resolve(JSON.stringify(document)),
        log: (line) => {
          lines.push(line);
        },
      });
      // Before this round the process STARTED here and pumped forever; the
      // race turns that into a named failure instead of a test timeout.
      const started = new Promise<"STARTED">((resolve) => {
        const poll = setInterval(() => {
          if (lines.some((line) => line.startsWith("registration: OK"))) {
            clearInterval(poll);
            resolve("STARTED");
          }
        }, 25);
        const stop = (): void => {
          clearInterval(poll);
        };
        exit.then(stop, stop);
      });
      const verdict = await Promise.race([exit, started]);
      const text = lines.join("\n");
      expect(verdict, `the process STARTED on parameters its registered config does not hold:\n${text}`).toBe(
        EXIT_CODES.configurationRefused,
      );

      expect(text).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(text).toContain(
        `strategy.configs ${registered.configId}: the registered parameters disagree with instance ` +
          `${registered.instanceId}'s params in the configuration`,
      );
      expect(text).toContain(
        '/reentry/maximum_entries_per_market: the registered row holds "1" but the configuration states 2',
      );
      // Exactly one difference is named: nothing else in the documents differs.
      expect(text.match(/: the registered row holds /gu)).toHaveLength(1);
      expect(text).not.toContain("registration: OK");
      expect(text).not.toContain("pump stopped");
      // Fail CLOSED: nothing was written on the way to the refusal.
      expect(await context.db.selectFrom("strategy.decisions").selectAll().execute()).toHaveLength(0);
    });
  }, 120_000);

  it("the SAME parameters pass — including a document whose every object lists its keys in reverse (canonical, not textual)", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "params-same", async ({ connectionString, context }) => {
      const label = "params-same";
      const registered = await registerThroughTheRepositories(context, label);

      const asRegistered = await assemble(documentRunning(registered, label, strategyParams()), connectionString);
      expect(asRegistered.log).toContain("registration: OK");
      expect(asRegistered.result.ok).toBe(true);

      const reversed = reversedKeys(strategyParams()) as Params;
      expect(Object.keys(reversed)).toStrictEqual(Object.keys(strategyParams()).reverse());
      const reordered = await assemble(documentRunning(registered, label, reversed), connectionString);
      expect(reordered.log).toContain("registration: OK");
      expect(reordered.result.ok).toBe(true);
    });
  }, 120_000);

  it.each([
    {
      name: "a key the registered row holds and the document does not",
      label: "params-extra-key",
      register: paramsWith((params) => {
        section(params, "reentry")["note"] = "registered only";
      }),
      run: strategyParams(),
      named: '/reentry/note: the registered row holds "registered only" but the configuration has no such field',
    },
    {
      name: "a key the document holds and the registered row does not",
      label: "params-missing-key",
      register: paramsWith((params) => {
        delete section(params, "exit")["allow_resolution_hold"];
      }),
      run: strategyParams(),
      named: "/exit/allow_resolution_hold: the configuration states false but the registered row has no such field",
    },
    {
      name: 'a decimal string written differently ("0.50" registered, "0.5" run)',
      label: "params-decimal-text",
      register: strategyParams(),
      run: paramsWith((params) => {
        section(section(params, "exit"), "take_profit")["price"] = "0.5";
      }),
      named: '/exit/take_profit/price: the registered row holds "0.50" but the configuration states "0.5"',
    },
  ])("REFUSES $name, naming it", async ({ label, register, run, named }) => {
    await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, label, { params: register });
      const { result, log } = await assemble(documentRunning(registered, label, run), connectionString);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("mismatched parameters assembled");
      expect(result.code).toBe(EXIT_CODES.configurationRefused);
      expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(log).toContain(named);
      expect(log.match(/: the (registered row holds|configuration states) /gu)).toHaveLength(1);
    });
  }, 120_000);
});
