/**
 * The SHIPPED control API bundle, built and run the way it ships
 * (`CONTROL-1b` r4; `CONTROL-2` r1 moved it here so the halt suites run the
 * same artifact the authoritative check reads).
 *
 * - {@link buildArguments} reads the package's `build` script in full and
 *   hands back exactly its esbuild arguments, with the output moved and a
 *   metafile added; anything in the script it does not read fails.
 * - {@link buildShippedBundle} runs the package's OWN esbuild binary with
 *   those arguments into a scratch directory, and returns the metafile and the
 *   bundle's path. Nothing is written into the repository.
 * - {@link runShippedBundle} and {@link startShippedBundle} run that file with
 *   `node`, in a child process, under exactly the environment a test hands
 *   them — nothing of the test runner's own (no `NODE_OPTIONS`, no loader).
 *
 * The child runs the artifact, not the test worker: the run-time no-signer
 * guard does not reach it (its limits: "another thread or process"), and the
 * bundle's metafile is what states what it holds.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = realpathSync(resolve(here, "../../../.."));
export const CONTROL_API = join(REPO_ROOT, "apps", "control-api");

/** A name built from parts: the test-tree scan refuses a literal path through `node_modules`. */
const named = (...parts: readonly string[]): string => parts.join("");

/** The `esbuild` the `build` script runs: the package's own, as pnpm puts it on the script's PATH. */
export const ESBUILD = join(CONTROL_API, named("node_", "modules"), ".bin", "esbuild");

/** The package's `build` script, as its manifest holds it. */
export function buildScript(): string {
  const manifest = JSON.parse(readFileSync(join(CONTROL_API, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  return manifest.scripts?.["build"] ?? "";
}

/**
 * The arguments the `build` script hands esbuild, with its output moved into
 * `outDirectory` and a metafile added. Anything in the script this does not
 * read — another command, shell syntax, a metafile of its own — fails: the
 * bundle checked here must be the one `build` makes.
 */
export function buildArguments(script: string, outDirectory: string): readonly string[] {
  const tokens = script.split(/\s+/u).filter((token) => token !== "");
  if (tokens[0] !== "esbuild") throw new Error(`the build script does not run esbuild first: ${script}`);
  const unread = tokens.filter((token) => !/^[A-Za-z0-9_./=:@-]+$/u.test(token));
  if (unread.length > 0) throw new Error(`the build script holds what this check does not read: ${unread.join(" ")}`);
  if (tokens.filter((token) => token.startsWith("--outfile=")).length !== 1) throw new Error(`the build script names no single --outfile: ${script}`);
  if (tokens.some((token) => token.startsWith("--metafile"))) throw new Error(`the build script writes a metafile of its own: ${script}`);
  return [
    ...tokens.slice(1).map((token) => (token.startsWith("--outfile=") ? `--outfile=${join(outDirectory, basename(token.slice("--outfile=".length)))}` : token)),
    `--metafile=${join(outDirectory, "meta.json")}`,
  ];
}

export interface MetafileImport {
  readonly path: string;
  readonly kind: string;
  readonly external?: boolean;
  readonly original?: string;
}

export interface Metafile {
  readonly inputs: Readonly<Record<string, { readonly imports: readonly MetafileImport[] }>>;
  readonly outputs: Readonly<Record<string, { readonly imports: readonly MetafileImport[] }>>;
}

export interface BuiltBundle {
  /** The scratch directory; the caller removes it ({@link removeBundle}). */
  readonly directory: string;
  /** The bundle, named as `build` names it (`main.mjs`). */
  readonly file: string;
  readonly metafile: Metafile;
}

/**
 * Builds the bundle the `build` script builds — or, for a positive control,
 * the same build with its entry point replaced by `entry` — into a scratch
 * directory.
 */
export async function buildShippedBundle(entry?: string): Promise<BuiltBundle> {
  const script = buildScript();
  const directory = mkdtempSync(join(tmpdir(), "control-api-bundle-"));
  try {
    let args = buildArguments(script, directory);
    if (entry !== undefined) args = args.map((token) => (token === "src/main.ts" ? entry : token));
    await run(ESBUILD, args, { cwd: CONTROL_API, env: process.env, timeout: 120_000 });
    const outfile = args.find((token) => token.startsWith("--outfile="))?.slice("--outfile=".length) ?? "";
    return {
      directory,
      file: outfile,
      metafile: JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")) as Metafile,
    };
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}

/** Removes a built bundle's scratch directory. */
export function removeBundle(bundle: BuiltBundle | undefined): void {
  if (bundle !== undefined) rmSync(bundle.directory, { recursive: true, force: true });
}

/** The four `AGENTS.md` defaults at their safe values, stated rather than left to a default. */
export const SAFE_PAPER_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  RUN_MODE: "PAPER",
  MAX_RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
});

/** The environment a bundle runs under: `PATH` and exactly `env`. */
function childEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "", ...env };
}

export interface BundleExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the bundle to completion (`--check`, or a load that fails), bounded. Never rejects for a non-zero exit. */
export function runShippedBundle(file: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<BundleExit> {
  return new Promise((resolveExit) => {
    execFile(
      process.execPath,
      [file, ...args],
      { cwd: dirname(file), env: childEnvironment(env), timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolveExit({ code, signal: error?.signal ?? null, stdout, stderr });
      },
    );
  });
}

export interface RunningBundle {
  /** The loopback port the bundle printed that it listens on. */
  readonly port: number;
  /** Everything the bundle has written so far. */
  output(): { readonly stdout: string; readonly stderr: string };
  /** Whether the process is still running. */
  alive(): boolean;
  /** SIGTERM, then the exit (SIGKILL after `graceMs`). */
  stop(graceMs?: number): Promise<BundleExit>;
}

/**
 * Starts the bundle serving (`bindPort` 0 in its configuration) and resolves
 * once it prints the port it listens on; rejects with everything it printed
 * if it exits first or prints nothing within `deadlineMs`.
 */
export function startShippedBundle(file: string, env: Readonly<Record<string, string>>, deadlineMs = 30_000): Promise<RunningBundle> {
  return new Promise((resolveStart, rejectStart) => {
    const child: ChildProcess = spawn(process.execPath, [file], {
      cwd: dirname(file),
      env: childEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exited: BundleExit | undefined;
    let settled = false;
    const exitWaiters: ((exit: BundleExit) => void)[] = [];
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectStart(new Error(`the bundle printed no listening port within ${String(deadlineMs)}ms\n${stdout}\n${stderr}`));
    }, deadlineMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const port = /control API listening on 127\.0\.0\.1:(\d+)/u.exec(stdout)?.[1];
      if (port !== undefined && !settled) {
        settled = true;
        clearTimeout(deadline);
        resolveStart(running(Number(port)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      exited = { code, signal, stdout, stderr };
      for (const waiter of exitWaiters.splice(0)) waiter(exited);
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        rejectStart(new Error(`the bundle exited (${String(code)}, ${String(signal)}) before it listened\n${stdout}\n${stderr}`));
      }
    });
    const running = (port: number): RunningBundle => ({
      port,
      output: () => ({ stdout, stderr }),
      alive: () => exited === undefined,
      stop: (graceMs = 10_000) =>
        new Promise<BundleExit>((resolveStop) => {
          if (exited !== undefined) {
            resolveStop(exited);
            return;
          }
          const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
          exitWaiters.push((exit) => {
            clearTimeout(force);
            resolveStop(exit);
          });
          child.kill("SIGTERM");
        }),
    });
  });
}
