/**
 * BUNDLE-1 (M18): every runnable app's SHIPPED bundle loads and reaches its own
 * startup path.
 *
 * WHY. Until BUNDLE-1, `apps/trader`'s `build` wrote an ESM bundle that died at
 * load with `Dynamic require of "events" is not supported`. The cause was
 * `ioredis`, a CommonJS-only dependency reached through
 * `packages/event-bus`, whose `require()` of Node builtins esbuild cannot turn
 * into ESM imports. So `pnpm --filter @polymarket-bot/trader start`, the
 * command `infra/compose/trader/compose.yaml` documents, could not start. It
 * passed every gate: typecheck, lint and all tests read SOURCE, and nothing
 * ran the artefact. This file runs the artefact of every app that ships one.
 *
 * THE TRADER'S CHOICE (ADR-018 §2 disclosure). The trader stays ESM, the
 * ADR-018 default, and its `build` adds one esbuild banner:
 * `import { createRequire as __bundleCreateRequire } from 'node:module';
 * const require = __bundleCreateRequire(import.meta.url);`. esbuild's
 * `__require` shim then finds a real `require` for the builtins `ioredis`
 * (and `pg`) load. The forcing dependency is `ioredis`, as for
 * `apps/data-gateway`. CJS (option a) was measured and rejected, for three
 * reasons:
 * - `packages/storage-postgres/src/migrations/loader.ts:33` evaluates
 *   `new URL(..., import.meta.url)` at LOAD, and in CJS `import.meta` is
 *   empty, so the bundle crashed with `TypeError: Invalid URL`.
 * - The trader's entry guard (`import.meta.url.endsWith("/main.mjs")`) also
 *   reads `import.meta`. With a define shim it never fires, and the process
 *   exits 0 having done nothing.
 * - Only a variant that also edited that guard and renamed the file to
 *   `main.cjs` worked, and both edits fall outside BUNDLE-1's grant.
 *
 * HOW EACH APP IS BUILT. The app's OWN `build` script is read from its
 * `package.json` and run through `sh -c` in the app's directory, the way
 * `pnpm run build` runs it. It is changed in exactly one place: the single
 * `--outfile=dist/` becomes a temporary directory outside the repository, so
 * every other flag is honoured as written and the pin cannot drift from the
 * script. The file's BASENAME is kept, because the entry guards key on it:
 * - the trader checks `endsWith("/main.mjs")`;
 * - control-api checks `endsWith("main.mjs")`;
 * - backtest-cli checks `endsWith(".mjs")`.
 * A renamed control-api bundle exits 0 silently. That, and not a defect, is
 * why an earlier ad-hoc check saw control-api "exit 0 with an empty
 * environment": built as `main.mjs` it refuses with 78. The same silence is
 * why every case below asserts an exact exit code AND the app's own refusal
 * or usage line, rather than "no crash".
 *
 * HOW EACH BUNDLE IS RUN.
 * - `process.execPath`, with an EXPLICIT environment record. Nothing is
 *   inherited, so no ambient `MAX_RUN_MODE` or `NODE_OPTIONS` can change the
 *   answer.
 * - The working directory is the temporary directory. A bundle that still
 *   needed a package from the repository's `node_modules` at run time would
 *   fail here rather than resolve it by accident.
 * - Asynchronously, with a SIGKILL deadline (CI-1: a synchronous child holds
 *   the vitest worker past its 60 s RPC timeout). Builds are memoized per
 *   app, and the cases run concurrently.
 *
 * THE TRADER'S SAFETY CASE. An UNSAFE environment, all four `AGENTS.md`
 * defaults weakened, must be refused BY THE BUNDLE, with
 * `EXIT_CODES.unsafeEnvironment` and every violation code. It must also
 * print neither `safety: OK` nor `configuration: OK`, although a valid
 * configuration path is supplied. That proves the §6 invariant 17 check runs
 * first, from the shipped artefact. The exit code alone cannot prove it:
 * `unsafeEnvironment` and `configurationRefused` are both 78 (`EX_CONFIG`),
 * which is why the refusal line is asserted too.
 *
 * NOT CHECKED HERE.
 * - Anything past each app's first refusal. The trader's infrastructure path
 *   was exercised by hand for BUNDLE-1: a real Redis with an unreachable or
 *   unmigrated PostgreSQL gives `TRADER_REGISTRATION_UNREADABLE`, exit 69, and
 *   a migrated, unseeded one gives `TRADER_REGISTRATION_MISSING`, exit 78. The
 *   unit suite has no Docker, so that path is not pinned here.
 * - An unreachable REDIS is not a refusal today. `startup()` rejects with
 *   `EventBusUnavailableError`, and the process dies with exit 1 and a stack
 *   trace. That behaviour belongs to the trader's source, not its bundle, and
 *   is reported rather than pinned.
 * - `apps/ops-cli` ships no bundle (ADR-018 §4 exception). The first test
 *   below fails if any other app starts shipping one without being listed
 *   here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT_USAGE as BACKTEST_EXIT_USAGE } from "../../../apps/backtest-cli/src/main.js";
import { EXIT_CODES as CONTROL_API_EXIT_CODES } from "../../../apps/control-api/src/main.js";
import { EXIT_CODES as TRADER_EXIT_CODES } from "../../../apps/trader/src/main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every app that ships an ADR-018 esbuild bundle. */
const BUNDLED_APPS = ["trader", "data-gateway", "control-api", "backtest-cli", "research-worker"] as const;
type BundledApp = (typeof BUNDLED_APPS)[number];

/** A build that has not finished in this long is killed; normal is well under 2 s each. */
const BUILD_DEADLINE_MS = 60_000;
/** A bundle that has not refused within this long is killed; normal is well under 1 s. */
const RUN_DEADLINE_MS = 30_000;
/** Above both deadlines together, so a deadline always fires before the test times out (CI-1). */
const CASE_TIMEOUT_MS = BUILD_DEADLINE_MS + RUN_DEADLINE_MS + 30_000;
/** Per-stream output ceiling; a runaway child is killed rather than filling memory. */
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

/**
 * What a module-load crash prints, by signature. Any one of these in a run's
 * output fails the case, whatever the exit code. The last one is Node's
 * footer after ANY uncaught exception, so it also catches a load crash with a
 * message not listed here.
 */
const LOAD_CRASH_SIGNATURES: readonly RegExp[] = [
  /Dynamic require of "/u,
  /ERR_MODULE_NOT_FOUND/u,
  /Cannot find (?:module|package)/u,
  /ERR_REQUIRE_(?:ESM|ASYNC_MODULE)/u,
  /ERR_UNKNOWN_FILE_EXTENSION/u,
  /\bSyntaxError\b/u,
  /\bReferenceError\b/u,
  /^Node\.js v\d+/mu,
];

/** The signatures of `output` that indicate a load crash, as their sources. */
function loadCrashSignatures(output: string): string[] {
  return LOAD_CRASH_SIGNATURES.filter((signature) => signature.test(output)).map((signature) => signature.source);
}

// ---------------------------------------------------------------------------
// the scripts, read from each app's own package.json
// ---------------------------------------------------------------------------

interface BundleScripts {
  /** The `build` script, exactly as `package.json` holds it. */
  readonly build: string;
  /** The `start` script, exactly as `package.json` holds it. */
  readonly start: string;
  /** The bundle's file name, from `--outfile=dist/<name>`. */
  readonly outfileName: string;
}

const OUTFILE_FLAG = "--outfile=dist/";
const OUTFILE = /--outfile=dist\/([A-Za-z0-9_.-]+)(?=\s|$)/gu;

async function readScripts(app: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "apps", app, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

/**
 * The app's `build` and `start` scripts, checked for the ADR-018 shape this
 * pin relies on. It fails loudly rather than guess when the shape moves.
 */
async function bundleScripts(app: BundledApp): Promise<BundleScripts> {
  const scripts = await readScripts(app);
  const build = scripts["build"];
  const start = scripts["start"];
  if (build === undefined || start === undefined) {
    throw new Error(`apps/${app}/package.json has no build or no start script`);
  }
  if (!build.startsWith("esbuild src/main.ts ") || !/\s--bundle(?=\s)/u.test(build) || !/\s--platform=node(?=\s)/u.test(build)) {
    throw new Error(`apps/${app}'s build is not an ADR-018 esbuild bundle of src/main.ts: ${build}`);
  }
  const outfiles = [...build.matchAll(OUTFILE)];
  if (outfiles.length !== 1 || build.split(OUTFILE_FLAG).length !== 2) {
    throw new Error(`apps/${app}'s build must name exactly one ${OUTFILE_FLAG}<file>: ${build}`);
  }
  const outfileName = outfiles[0]?.[1];
  if (outfileName === undefined) throw new Error(`apps/${app}'s build names no outfile: ${build}`);
  return { build, start, outfileName };
}

describe("the bundles the runnable apps ship (ADR-018)", () => {
  it("every app whose build is an esbuild bundle is covered here, and ops-cli still is not one", async () => {
    const entries = await readdir(path.join(repoRoot, "apps"), { withFileTypes: true });
    const bundled: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const scripts = await readScripts(entry.name);
      if ((scripts["build"] ?? "").startsWith("esbuild ")) bundled.push(entry.name);
    }
    // Non-vacuity: the listing found the apps directory's real contents.
    expect(entries.map((entry) => entry.name)).toContain("ops-cli");
    expect(bundled.sort()).toEqual([...BUNDLED_APPS].sort());
  });

  for (const app of BUNDLED_APPS) {
    it(`${app}: build writes exactly one dist/ file, and start runs that same file`, async () => {
      const { build, start, outfileName } = await bundleScripts(app);
      expect(build).toMatch(/\s--target=node24(?=\s)/u);
      expect(outfileName).toMatch(/^main\.(?:mjs|cjs)$/u);
      // The format and the extension agree, so Node loads the file as what it is.
      expect(build).toContain(outfileName.endsWith(".mjs") ? "--format=esm" : "--format=cjs");
      expect(start.endsWith(`&& node ./dist/${outfileName}`), start).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// asynchronous child processes (CI-1)
// ---------------------------------------------------------------------------

interface ChildOutcome {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child could not start, overflowed its output ceiling, or missed its deadline. */
  readonly error: Error | undefined;
}

const liveChildren = new Set<ChildProcess>();

/**
 * Runs `command args` and resolves once it has exited and both output pipes
 * have closed. It never rejects: a non-zero exit is data here. Past
 * `deadlineMs` the child is killed with SIGKILL and the promise settles at
 * once with `error` set.
 */
function runChild(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly deadlineMs: number },
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    liveChildren.add(child);
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    let error: Error | undefined;
    let settled = false;
    const text = (stream: "stdout" | "stderr"): string => Buffer.concat(chunks[stream]).toString("utf8");
    const settle = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ status, signal, stdout: text("stdout"), stderr: text("stderr"), error });
    };
    const collect =
      (stream: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        if (bytes[stream] + chunk.length > MAX_CHILD_OUTPUT_BYTES) {
          if (error === undefined) {
            error = new Error(`child ${stream} exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes (${command} ${args.join(" ")})`);
            child.kill("SIGKILL");
          }
          return;
        }
        bytes[stream] += chunk.length;
        chunks[stream].push(chunk);
      };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const deadline = setTimeout(() => {
      error ??= new Error(`child did not finish within ${options.deadlineMs} ms and was killed (${command} ${args.join(" ")})`);
      child.kill("SIGKILL");
      settle(null, "SIGKILL");
    }, options.deadlineMs);
    child.on("error", (cause) => {
      liveChildren.delete(child);
      error ??= cause;
      settle(null, null);
    });
    child.on("close", (code, signal) => {
      liveChildren.delete(child);
      settle(code, signal);
    });
  });
}

function describeOutcome(label: string, outcome: ChildOutcome): string {
  return [
    `${label}: status ${String(outcome.status)}, signal ${String(outcome.signal)}`,
    ...(outcome.error === undefined ? [] : [`error: ${outcome.error.message}`]),
    "--- stdout ---",
    outcome.stdout,
    "--- stderr ---",
    outcome.stderr,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// building each bundle once, outside the repository
// ---------------------------------------------------------------------------

/** Characters a path may carry to be substituted into a `sh -c` script unquoted. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./-]+$/u;

let scratchRoot: Promise<string> | undefined;

/** One temporary directory for the whole file, resolved through symlinks so `import.meta.url` matches `argv[1]`. */
function scratch(): Promise<string> {
  scratchRoot ??= mkdtemp(path.join(tmpdir(), "pmb-app-bundles-")).then(async (created) => await realpath(created));
  return scratchRoot;
}

interface BuiltBundle {
  readonly directory: string;
  readonly file: string;
}

const builds = new Map<BundledApp, Promise<BuiltBundle>>();

function bundleFor(app: BundledApp): Promise<BuiltBundle> {
  let build = builds.get(app);
  if (build === undefined) {
    build = buildBundle(app);
    builds.set(app, build);
  }
  return build;
}

async function buildBundle(app: BundledApp): Promise<BuiltBundle> {
  const scripts = await bundleScripts(app);
  const directory = path.join(await scratch(), app);
  if (!SHELL_SAFE_PATH.test(directory) || directory.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`the bundle directory ${directory} is not a shell-safe path outside the repository`);
  }
  await mkdir(directory, { recursive: true });
  const script = scripts.build.replace(OUTFILE_FLAG, `--outfile=${directory}/`);
  if (script.includes("dist/")) {
    throw new Error(`apps/${app}'s build writes into dist/ other than through --outfile: ${scripts.build}`);
  }
  const appDirectory = path.join(repoRoot, "apps", app);
  const outcome = await runChild("sh", ["-c", script], {
    cwd: appDirectory,
    env: {
      ...process.env,
      // What `pnpm run` puts first: the app's own binaries (its esbuild), then the root's, then this Node.
      PATH: [
        path.join(appDirectory, "node_modules", ".bin"),
        path.join(repoRoot, "node_modules", ".bin"),
        path.dirname(process.execPath),
        process.env["PATH"] ?? "",
      ].join(path.delimiter),
    },
    deadlineMs: BUILD_DEADLINE_MS,
  });
  if (outcome.error !== undefined || outcome.status !== 0) {
    throw new Error(describeOutcome(`building apps/${app} (${script})`, outcome));
  }
  const file = path.join(directory, scripts.outfileName);
  const written = await stat(file);
  if (!written.isFile() || written.size === 0) throw new Error(`building apps/${app} wrote no ${file}`);
  return { directory, file };
}

afterAll(async () => {
  for (const child of liveChildren) child.kill("SIGKILL");
  if (scratchRoot !== undefined) await rm(await scratchRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const TRADER_EXAMPLE_CONFIG = path.join(repoRoot, "infra", "compose", "trader", "trader.config.example.json");

/** The four `AGENTS.md` defaults, at their safe values, stated rather than left to a default. */
const SAFE_PAPER_DEFAULTS = {
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;

interface BundleCase {
  readonly app: BundledApp;
  readonly name: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly exitCode: number;
  /** Every line the app's own startup code must have printed. */
  readonly printed: readonly string[];
  /** Lines that must NOT appear. */
  readonly notPrinted: readonly string[];
}

const CASES: readonly BundleCase[] = [
  {
    app: "trader",
    name: "an UNSAFE environment is refused by the bundle's safety check, before any configuration is read",
    argv: [],
    env: {
      MAX_RUN_MODE: "LIVE",
      RUN_MODE: "LIVE",
      ALLOW_REAL_ORDERS: "true",
      LIVE_MICRO_MAX_ORDER_NOTIONAL: "5",
      LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "5",
      // Everything the process would need to get further, so a skipped check would show.
      TRADER_CONFIG_PATH: TRADER_EXAMPLE_CONFIG,
      REDIS_URL: "redis://127.0.0.1:1",
      DATABASE_URL: "postgres://bundle:bundle@127.0.0.1:1/bundle",
    },
    exitCode: TRADER_EXIT_CODES.unsafeEnvironment,
    printed: [
      "REFUSING TO START: the environment is not safe for a PAPER trader",
      "No configuration was read and no connection was attempted.",
      "PAPER_RUN_MODE_CEILING_RAISED: MAX_RUN_MODE=LIVE",
      "PAPER_RUN_MODE_NOT_PERMITTED: RUN_MODE=LIVE",
      "PAPER_REAL_ORDERS_ENABLED: ALLOW_REAL_ORDERS=true",
      "PAPER_LIVE_MICRO_CAP_NONZERO: LIVE_MICRO_MAX_ORDER_NOTIONAL=5",
      "PAPER_LIVE_MICRO_CAP_NONZERO: LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=5",
    ],
    notPrinted: ["safety: OK", "configuration: OK"],
  },
  {
    app: "trader",
    name: "a safe PAPER environment passes safety and the configuration door, then is refused for its missing infrastructure URLs",
    argv: [],
    env: { ...SAFE_PAPER_DEFAULTS, TRADER_CONFIG_PATH: TRADER_EXAMPLE_CONFIG },
    exitCode: TRADER_EXIT_CODES.configurationRefused,
    printed: [
      "safety: OK — run mode PAPER, ceiling PAPER, real orders disabled",
      "configuration: OK — 1 market(s), 1 instance(s), environment PAPER",
      "REFUSING TO START: REDIS_URL and DATABASE_URL are both required and neither is defaulted.",
    ],
    notPrinted: ["REFUSING TO START: the environment is not safe"],
  },
  {
    app: "data-gateway",
    name: "an empty environment is refused for its missing configuration path",
    argv: [],
    env: {},
    // `main.ts` sets `process.exitCode = 1` for this refusal; the app exports no constant for it.
    exitCode: 1,
    printed: ["GATEWAY_CONFIG_PATH is required (a JSON file matching GatewayConfigSchema)"],
    notPrinted: ["data-gateway: fatal"],
  },
  {
    app: "control-api",
    name: "an empty environment passes safety and is refused for its missing configuration",
    argv: [],
    env: {},
    exitCode: CONTROL_API_EXIT_CODES.configurationRefused,
    printed: ["REFUSING TO START — CONTROL_API_CONFIG names no configuration file."],
    notPrinted: ["REFUSING TO START — the environment is not a safe PAPER environment"],
  },
  {
    app: "backtest-cli",
    name: "no command prints its usage",
    argv: [],
    env: {},
    exitCode: BACKTEST_EXIT_USAGE,
    printed: [
      "backtest-cli: a command is required: verify",
      "usage: backtest-cli verify --dataset <dir> --pins <run-pins.json>",
    ],
    notPrinted: [],
  },
  {
    app: "research-worker",
    name: "an empty environment is refused for its missing WAL directory",
    argv: [],
    env: {},
    // `main.ts` maps a startup failure to exit 1; the app exports no constant for it.
    exitCode: 1,
    printed: [
      '{"event":"research-worker-fatal","reason":"RESEARCH_WORKER_WAL_DIR: is required and must not be empty"}',
    ],
    notPrinted: [],
  },
];

describe.concurrent("each app's bundle, built by its own build script, loads and reaches its own startup path", () => {
  it("every bundled app has at least one case", ({ expect: localExpect }) => {
    localExpect([...new Set(CASES.map((entry) => entry.app))].sort()).toEqual([...BUNDLED_APPS].sort());
  });

  for (const entry of CASES) {
    it(
      `${entry.app}: ${entry.name}`,
      async ({ expect: localExpect }) => {
        const bundle = await bundleFor(entry.app);
        const outcome = await runChild(process.execPath, [bundle.file, ...entry.argv], {
          cwd: bundle.directory,
          env: { ...entry.env },
          deadlineMs: RUN_DEADLINE_MS,
        });
        const report = describeOutcome(`node ${bundle.file} ${entry.argv.join(" ")}`, outcome);
        const output = `${outcome.stdout}${outcome.stderr}`;
        localExpect(outcome.error, report).toBeUndefined();
        localExpect(loadCrashSignatures(output), report).toEqual([]);
        localExpect(outcome.status, report).toBe(entry.exitCode);
        for (const line of entry.printed) localExpect(output, report).toContain(line);
        for (const line of entry.notPrinted) localExpect(output, report).not.toContain(line);
      },
      CASE_TIMEOUT_MS,
    );
  }
});

describe("the load-crash signatures recognise the crashes this pin exists for", () => {
  it("flags the trader's pre-BUNDLE-1 crash, a CJS import.meta crash and a missing module", () => {
    const dynamicRequire = [
      'file:///tmp/x/main.mjs:11',
      "  throw Error('Dynamic require of \"' + x + '\" is not supported');",
      "",
      'Error: Dynamic require of "events" is not supported',
      "    at ../../node_modules/.pnpm/ioredis@6.0.0/node_modules/ioredis/built/Redis.js (file:///tmp/x/main.mjs:13249:20)",
      "",
      "Node.js v24.13.0",
    ].join("\n");
    expect(loadCrashSignatures(dynamicRequire)).toEqual(['Dynamic require of "', "^Node\\.js v\\d+"]);

    const invalidUrl = ["TypeError: Invalid URL", "    at new URL (node:internal/url:828:25)", "", "Node.js v24.13.0"].join("\n");
    expect(loadCrashSignatures(invalidUrl)).toEqual(["^Node\\.js v\\d+"]);

    expect(loadCrashSignatures("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg'")).toEqual([
      "ERR_MODULE_NOT_FOUND",
      "Cannot find (?:module|package)",
    ]);
  });

  it("does not flag any case's expected output", () => {
    for (const entry of CASES) {
      expect(loadCrashSignatures(entry.printed.join("\n")), `${entry.app}: ${entry.name}`).toEqual([]);
    }
  });
});
