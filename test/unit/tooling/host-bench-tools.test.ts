/**
 * HOST-BENCH-PREP — the laptop measurement tools under `tools/bench/host/`
 * stay runnable and stay on public endpoints.
 *
 * The tools are Python 3 (standard library; `websockets` only inside the live
 * connection loop) and shell, so ESLint's typed program never sees them
 * (`lint-typed-program.test.ts`). Their offline checks are Python `unittest`
 * suites next to them (`tools/bench/host/tests/`). This file runs those suites
 * from the unit suite, so CI runs them too, and pins two things a reader of the
 * guide relies on:
 * - every network address the tools name is one of the documented public
 *   endpoints (Gamma, the public market WebSocket), the documentation site, or
 *   Docker's apt repository (the operator's setup script) — no user channel,
 *   no order or account endpoint;
 * - no credential-shaped name appears in them.
 *
 * Needs `python3` (3.10 or later) on PATH, as CI's ubuntu runner has. Every
 * child process is awaited asynchronously (`no-synchronous-spawn.test.ts`).
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const toolsDir = path.join(repoRoot, "tools", "bench", "host");

const ALLOWED_URL_PREFIXES = [
  "https://docs.polymarket.com/",
  "https://gamma-api.polymarket.com",
  "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  "https://download.docker.com/linux/ubuntu",
] as const;

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`)<>\]]+/gu;
const CREDENTIAL_PATTERN = /\b(?:api[_-]?key|api[_-]?secret|passphrase|private[_-]?key|POLY_[A-Z_]+|Authorization|signer|mnemonic)\b/iu;

async function toolSources(): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(toolsDir);
  const files = entries.filter((name) => name.endsWith(".py") || name.endsWith(".sh")).sort();
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(path.join(toolsDir, file), "utf8") })));
}

describe("tools/bench/host", () => {
  it("passes its offline Python checks", async () => {
    const { stderr } = await execFileAsync("python3", ["-m", "unittest", "discover", "-s", path.join(toolsDir, "tests")], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    const ran = /Ran (\d+) tests?/u.exec(stderr);
    expect(ran, stderr).not.toBeNull();
    expect(Number(ran?.[1])).toBeGreaterThanOrEqual(40);
    expect(stderr.trimEnd().endsWith("OK"), stderr).toBe(true);
  }, 90_000);

  it("names only documented public endpoints", async () => {
    const sources = await toolSources();
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "recorder_core.py",
        "record_markets.py",
        "host_sampler.py",
        "bench_table.py",
        "report_tables.py",
        "setup-wsl-root.sh",
        "trader-bench.sh",
      ]),
    );
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(URL_PATTERN)) {
        if (!ALLOWED_URL_PREFIXES.some((prefix) => match[0].startsWith(prefix))) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no credential", async () => {
    const offenders = (await toolSources()).flatMap(({ file, text }) =>
      text
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => CREDENTIAL_PATTERN.test(line))
        .map(({ line, index }) => `${file}:${String(index + 1)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the shell scripts syntactically valid", async () => {
    for (const script of ["setup-wsl-root.sh", "trader-bench.sh"]) {
      await expect(execFileAsync("bash", ["-n", path.join(toolsDir, script)])).resolves.toBeDefined();
    }
  });
});
