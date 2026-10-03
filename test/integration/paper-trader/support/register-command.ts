/**
 * Support for `register-command-postgres.test.ts` (`REGISTER-1`): the
 * registration command's code path driven in-process, its template built from
 * the fixture configuration, and the durable trader's own assembly for the
 * document it completes.
 *
 * Nothing here seeds a row. Every row the tests read was written by the
 * command (or, in the one comparison that says so, by `BOOT-1`'s hand
 * registration in `support/registration.ts`); `createTradingChain` is not used.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";
import { parseTraderConfig } from "@polymarket-bot/trader";

import { assembleDurableTrader } from "../../../../apps/trader/src/main.js";
import { runRegisterCommand } from "../../../../apps/trader/src/register/main.js";
import { NO_TOKEN, YES_TOKEN, safeEnvironment, traderConfig } from "./fixture.js";
import { FIXTURE_FIRST_EVENT_AT, RebasedSystemPaperClock } from "./host-clock.js";

/** The condition id a scenario's template states. */
export function conditionFor(label: string): string {
  return `0xcondition-${label}`;
}

/**
 * The fixture configuration as a registration TEMPLATE: the five minted
 * identities removed (`markets[0].marketId`; `instances[0].instanceId`,
 * `.runId`, `.configId`, `.marketId`), the condition id made the scenario's
 * own. `market`/`instance` overrides are merged into the one market/instance.
 */
export function templateFor(
  label: string,
  overrides: {
    readonly market?: Record<string, unknown>;
    readonly instance?: Record<string, unknown>;
    readonly document?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const base = traderConfig();
  const market = (base["markets"] as Record<string, unknown>[])[0];
  const instance = (base["instances"] as Record<string, unknown>[])[0];
  if (market === undefined || instance === undefined) {
    throw new Error("the fixture configuration lost its market or its instance");
  }
  const templateMarket = without(market, ["marketId"]);
  const templateInstance = without(instance, ["instanceId", "runId", "configId", "marketId"]);
  return {
    ...base,
    markets: [{ ...templateMarket, conditionId: conditionFor(label), ...overrides.market }],
    instances: [{ ...templateInstance, ...overrides.instance }],
    ...overrides.document,
  };
}

/** `record` without `keys`, every other key in its place. */
function without(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/** The flags every scenario passes, unless it overrides one. */
export interface RegisterFlags {
  readonly template: string;
  readonly out: string;
  readonly instanceName: string;
  readonly questionTitle?: string;
  readonly negRisk?: string;
  readonly tradingDelaySeconds?: string;
  readonly lifecycleState?: string;
  readonly yesLabel?: string;
  readonly noLabel?: string;
  readonly codeCommit?: string;
  readonly createdBy?: string;
}

export const QUESTION_TITLE = "Will BTC be up at 12:15?";
export const YES_LABEL = "Up";
export const NO_LABEL = "Down";
export const CODE_COMMIT = "register-1-acceptance";
export const CREATED_BY = "register-1-acceptance";

export function registerArgv(flags: RegisterFlags): string[] {
  return [
    "--template",
    flags.template,
    "--out",
    flags.out,
    "--instance-name",
    flags.instanceName,
    "--question-title",
    flags.questionTitle ?? QUESTION_TITLE,
    "--neg-risk",
    flags.negRisk ?? "false",
    "--trading-delay-seconds",
    flags.tradingDelaySeconds ?? "0",
    "--lifecycle-state",
    flags.lifecycleState ?? "OPEN",
    "--yes-label",
    flags.yesLabel ?? YES_LABEL,
    "--no-label",
    flags.noLabel ?? NO_LABEL,
    "--code-commit",
    flags.codeCommit ?? CODE_COMMIT,
    "--created-by",
    flags.createdBy ?? CREATED_BY,
  ];
}

/** What one in-process run of the command answered. */
export interface CommandRun {
  readonly code: number;
  /** Everything it logged (stderr in the process), one line each. */
  readonly log: string;
  /** Everything it printed (stdout in the process). */
  readonly printed: string;
}

/** Runs the command's code path, exactly as the bundle's process shell calls it. */
export async function runRegister(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<CommandRun> {
  const lines: string[] = [];
  let printed = "";
  const code = await runRegisterCommand({
    argv,
    env,
    log: (line) => {
      lines.push(line);
    },
    print: (text) => {
      printed += text;
    },
    nowMs: () => Date.now(),
  });
  return { code, log: lines.join("\n"), printed };
}

/** The safe PAPER environment plus a database. */
export function registerEnvironment(databaseUrl: string): Record<string, string | undefined> {
  return { ...safeEnvironment(), DATABASE_URL: databaseUrl };
}

/** The unsafe environment the trader's own tests use: every default weakened. */
export function unsafeEnvironment(databaseUrl: string): Record<string, string | undefined> {
  return {
    ...safeEnvironment(),
    MAX_RUN_MODE: "LIVE",
    RUN_MODE: "LIVE",
    ALLOW_REAL_ORDERS: "true",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "5",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "5",
    DATABASE_URL: databaseUrl,
  };
}

/** A scratch directory for templates and completed documents. */
export class Scratch {
  readonly #root: Promise<string>;

  constructor(label: string) {
    this.#root = mkdtemp(path.join(tmpdir(), `pmb-register-${label}-`));
  }

  /** A fresh directory under the scratch root. */
  async directory(name: string): Promise<string> {
    const directory = path.join(await this.#root, name);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** Writes `document` as JSON into `directory/name` and returns the path. */
  async write(directory: string, name: string, document: unknown): Promise<string> {
    const file = path.join(directory, name);
    await writeFile(file, typeof document === "string" ? document : `${JSON.stringify(document, null, 2)}\n`);
    return file;
  }

  async remove(): Promise<void> {
    await rm(await this.#root, { recursive: true, force: true });
  }
}

/** The one JSON line the command prints on success. */
export interface PrintedIdentities {
  readonly registered: true;
  readonly marketId: string;
  readonly definitionId: string;
  readonly definitionReused: boolean;
  readonly configId: string;
  readonly configVersion: number;
  readonly configReused: boolean;
  readonly instanceId: string;
  readonly runId: string;
  readonly completedDocument: string;
}

export function printedIdentities(run: CommandRun): PrintedIdentities {
  const lines = run.printed.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error(`expected ONE printed line, got ${String(lines.length)}:\n${run.printed}\n${run.log}`);
  }
  return JSON.parse(lines[0]) as PrintedIdentities;
}

/** Every table the registration writes, in dependency order. */
export const REGISTRATION_TABLES = [
  "catalog.markets",
  "catalog.market_tokens",
  "catalog.market_parameter_history",
  "strategy.definitions",
  "strategy.configs",
  "strategy.instances",
  "strategy.runs",
] as const;

/** Row counts of {@link REGISTRATION_TABLES}, by name. */
export async function registrationRowCounts(
  db: PolymarketBotDatabase,
): Promise<Record<(typeof REGISTRATION_TABLES)[number], number>> {
  return {
    "catalog.markets": (await db.selectFrom("catalog.markets").select("market_id").execute()).length,
    "catalog.market_tokens": (await db.selectFrom("catalog.market_tokens").select("market_token_id").execute())
      .length,
    "catalog.market_parameter_history": (
      await db.selectFrom("catalog.market_parameter_history").select("parameter_version_id").execute()
    ).length,
    "strategy.definitions": (await db.selectFrom("strategy.definitions").select("definition_id").execute()).length,
    "strategy.configs": (await db.selectFrom("strategy.configs").select("config_id").execute()).length,
    "strategy.instances": (await db.selectFrom("strategy.instances").select("instance_id").execute()).length,
    "strategy.runs": (await db.selectFrom("strategy.runs").select("run_id").execute()).length,
  };
}

export const ZERO_ROWS: Record<(typeof REGISTRATION_TABLES)[number], number> = {
  "catalog.markets": 0,
  "catalog.market_tokens": 0,
  "catalog.market_parameter_history": 0,
  "strategy.definitions": 0,
  "strategy.configs": 0,
  "strategy.instances": 0,
  "strategy.runs": 0,
};

/**
 * Runs the durable trader's own assembly on a document, capturing what it logged.
 *
 * `CO2-N1` (ADR-031): the clock is the host's, re-based to the fixture's first
 * recorded event (`host-clock.ts`). The round trip feeds the fixture's
 * `2026-03-04` events, and the host clock as-is would have the entry guard
 * refuse their entry; re-based, the lag is the real processing delay, and the
 * run decides and fills as it did before ADR-031.
 */
export async function assemble(document: unknown, postgresUrl: string) {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) {
    throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  }
  const lines: string[] = [];
  const result = await assembleDurableTrader({
    env: safeEnvironment(),
    config: parsed.config,
    document,
    postgresUrl,
    clock: new RebasedSystemPaperClock(FIXTURE_FIRST_EVENT_AT),
    log: (line) => {
      lines.push(line);
    },
  });
  return { result, log: lines.join("\n") };
}

/**
 * A TCP listener that COUNTS connection attempts and hangs up on each — a
 * `DATABASE_URL` pointed at it proves whether a code path opened a
 * connection at all, which an unreachable port cannot (it refuses before
 * anything is counted).
 */
export async function withConnectionCounter<T>(
  run: (databaseUrl: string, connections: () => number) => Promise<T>,
): Promise<T> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the counter did not bind a port");
  try {
    return await run(`postgres://nobody:nothing@127.0.0.1:${String(address.port)}/nowhere`, () => connections);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

/** How {@link withCuttingProxy} cuts the command's database connection at the matched message. */
export type Cut =
  /** Forward the message, wait for the server's ANSWER, then cut the client without relaying it. */
  | "AFTER_THE_SERVER_ANSWERS"
  /** Cut both sides INSTEAD of forwarding the message: the server never sees it. */
  | "INSTEAD_OF_FORWARDING";

/**
 * The wire bytes of the outer transaction's `client.query("commit")`: a
 * simple-query message (`Q`, int32 length 11, `commit\0`). The repositories'
 * own `commit`s reach the wire as `release savepoint …`, and no other
 * statement is exactly this message.
 */
export const OUTER_COMMIT_MESSAGE = Buffer.concat([
  Buffer.from([0x51, 0x00, 0x00, 0x00, 0x0b]),
  Buffer.from("commit\u0000", "utf8"),
]);

/** Text in the extended-protocol `Parse` message of `startRun`'s insert — the LAST repository write. */
export const START_RUN_INSERT = Buffer.from('insert into "strategy"."runs"', "utf8");

/**
 * A TCP proxy in front of PostgreSQL that relays byte for byte until a
 * client→server chunk holds `match`, then cuts the connection there, as
 * {@link Cut} says — the "database stopped answering mid-registration" and
 * "connection died during COMMIT" windows, reproduced deterministically.
 * `cuts()` counts the cuts, so a scenario can prove its window was reached.
 */
export async function withCuttingProxy<T>(
  databaseUrl: string,
  options: { readonly match: Buffer; readonly cut: Cut },
  run: (proxiedUrl: string, cuts: () => number) => Promise<T>,
): Promise<T> {
  const target = new URL(databaseUrl);
  let cuts = 0;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    let cutting = false;
    const closeBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("data", (chunk: Buffer) => {
      if (!cutting) client.write(chunk);
    });
    client.on("data", (chunk: Buffer) => {
      if (cutting) return;
      if (!chunk.includes(options.match)) {
        upstream.write(chunk);
        return;
      }
      cutting = true;
      cuts += 1;
      if (options.cut === "INSTEAD_OF_FORWARDING") {
        closeBoth();
        return;
      }
      upstream.once("data", closeBoth);
      upstream.write(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the proxy did not bind a port");
  const proxied =
    `${target.protocol}//${target.username}:${target.password}@127.0.0.1:${String(address.port)}` +
    `${target.pathname}${target.search}`;
  try {
    return await run(proxied, () => cuts);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

export { NO_TOKEN, YES_TOKEN };
