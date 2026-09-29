/**
 * `REGISTER-1` — the registration command's pieces that need no database:
 * the flags, the `--help` text's honesty, the canonical parameter rendering,
 * the savepoint rewrite rule, and the refusals that happen before a
 * connection. The database half is proved against a real PostgreSQL in
 * `test/integration/paper-trader/register-command-postgres.test.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { asksForHelp, parseRegisterArguments, REGISTRABLE_LIFECYCLE_STATES } from "./arguments.js";
import { isProcessEntry, REGISTER_EXIT_CODES, runRegisterCommand, USAGE, writeExclusive } from "./main.js";
import { mapStatement, REPOSITORY_SAVEPOINT } from "./one-transaction.js";
import { canonicalParameters, readTemplate } from "./template.js";

const SAFE_ENV = {
  MAX_RUN_MODE: "PAPER",
  RUN_MODE: "PAPER",
  ALLOW_REAL_ORDERS: "false",
  LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
} as const;

const FLAGS: readonly string[] = [
  "--template",
  "t.json",
  "--out",
  "o.json",
  "--instance-name",
  "static-bracket-unit",
  "--question-title",
  "Will BTC be up?",
  "--neg-risk",
  "false",
  "--trading-delay-seconds",
  "0",
  "--lifecycle-state",
  "OPEN",
  "--yes-label",
  "Up",
  "--no-label",
  "Down",
  "--code-commit",
  "abc123",
  "--created-by",
  "unit",
];

/** `FLAGS` with one flag's value replaced. */
function withFlag(flag: string, value: string): string[] {
  const argv = [...FLAGS];
  const index = argv.indexOf(flag);
  if (index < 0) throw new Error(`no ${flag}`);
  argv[index + 1] = value;
  return argv;
}

async function run(argv: readonly string[], env: Readonly<Record<string, string | undefined>>) {
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
    nowMs: () => Date.UTC(2026, 8, 28, 12, 0, 0),
  });
  return { code, log: lines.join("\n"), printed };
}

describe("the flags", () => {
  it("parses every flag into its typed value", () => {
    const argv = withFlag("--neg-risk", "true");
    argv[argv.indexOf("--trading-delay-seconds") + 1] = "7";
    const parsed = parseRegisterArguments(argv);
    expect(parsed.ok ? parsed.arguments : parsed.problems).toEqual({
      template: "t.json",
      out: "o.json",
      instanceName: "static-bracket-unit",
      questionTitle: "Will BTC be up?",
      negRisk: true,
      tradingDelaySeconds: 7,
      lifecycleState: "OPEN",
      yesLabel: "Up",
      noLabel: "Down",
      codeCommit: "abc123",
      createdBy: "unit",
    });
  });

  it("requires every flag, and reports every missing one at once", () => {
    const parsed = parseRegisterArguments([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems).toEqual([
      "--template is required",
      "--out is required",
      "--instance-name is required",
      "--question-title is required",
      "--neg-risk is required",
      "--trading-delay-seconds is required",
      "--lifecycle-state is required",
      "--yes-label is required",
      "--no-label is required",
      "--code-commit is required",
      "--created-by is required",
    ]);
  });

  it.each([
    ["--neg-risk", "yes", "--neg-risk must be exactly true or false"],
    ["--neg-risk", "TRUE", "--neg-risk must be exactly true or false"],
    // `parseArgs` itself refuses a value that looks like a flag.
    ["--trading-delay-seconds", "-1", "argument is ambiguous"],
    ["--trading-delay-seconds", "1.5", "--trading-delay-seconds must be a whole number"],
    ["--trading-delay-seconds", "007", "--trading-delay-seconds must be a whole number"],
    ["--trading-delay-seconds", "2147483648", "--trading-delay-seconds must be a whole number"],
    ["--lifecycle-state", "RESOLVED", "--lifecycle-state must be one of DISCOVERED, OPEN, CLOSING, CLOSED"],
    ["--lifecycle-state", "open", "--lifecycle-state must be one of"],
    ["--instance-name", "   ", "--instance-name must not be empty"],
    ["--code-commit", "", "--code-commit must not be empty"],
  ])("refuses %s %j", (flag, value, problem) => {
    const parsed = parseRegisterArguments(withFlag(flag, value));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join("\n")).toContain(problem);
  });

  it("refuses a negative delay given in the --flag=value form too", () => {
    const argv = withFlag("--trading-delay-seconds", "0").filter((token) => token !== "--trading-delay-seconds");
    argv.splice(argv.indexOf("0"), 1, "--trading-delay-seconds=-1");
    const parsed = parseRegisterArguments(argv);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems).toEqual([
      '--trading-delay-seconds must be a whole number of seconds from 0 to 2147483647, not "-1"',
    ]);
  });

  it("refuses a flag given twice rather than taking the last one", () => {
    const parsed = parseRegisterArguments([...FLAGS, "--out", "other.json"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems).toEqual(["--out is given more than once"]);
  });

  it("ignores ONE leading -- (pnpm run register -- … passes it through), and no other", () => {
    const parsed = parseRegisterArguments(["--", ...FLAGS]);
    expect(parsed.ok ? parsed.arguments.template : parsed.problems).toBe("t.json");
    expect(parseRegisterArguments(["--", "--", ...FLAGS]).ok).toBe(false);
    expect(parseRegisterArguments([...FLAGS.slice(0, 2), "--", ...FLAGS.slice(2)]).ok).toBe(false);
  });

  it("refuses an unknown flag and a positional (strict parsing)", () => {
    for (const extra of [["--force"], ["extra.json"]]) {
      const parsed = parseRegisterArguments([...FLAGS, ...extra]);
      expect(parsed.ok, extra.join(" ")).toBe(false);
    }
  });

  it("offers every catalog lifecycle state but RESOLVED", () => {
    expect([...REGISTRABLE_LIFECYCLE_STATES]).toEqual(["DISCOVERED", "OPEN", "CLOSING", "CLOSED"]);
  });

  it("recognises --help and -h anywhere, and nothing else", () => {
    expect(asksForHelp(["--help"])).toBe(true);
    expect(asksForHelp([...FLAGS, "-h"])).toBe(true);
    expect(asksForHelp(FLAGS)).toBe(false);
    expect(asksForHelp(["--helpful"])).toBe(false);
  });
});

describe("the --help text says what the command does", () => {
  it("documents every flag the parser takes, and nothing it does not", () => {
    // `--filter` is pnpm's own, in the line showing the pnpm invocation.
    const documented = [...USAGE.matchAll(/--([a-z-]+)/gu)]
      .map((match) => match[1])
      .filter((flag) => flag !== "filter");
    const taken = FLAGS.filter((token) => token.startsWith("--")).map((token) => token.slice(2));
    for (const flag of taken) expect(documented, flag).toContain(flag);
    expect([...new Set(documented)].sort()).toEqual([...taken, "help"].sort());
  });

  it("lists every exit code the command can return", () => {
    for (const code of new Set(Object.values(REGISTER_EXIT_CODES))) {
      expect(USAGE, String(code)).toMatch(new RegExp(`^  ${String(code)} `, "mu"));
    }
  });

  it("says it does NOT verify a gammaMarketId, and that a re-run is refused", () => {
    expect(USAGE).toContain("It does NOT verify a gammaMarketId (UNIV4-R1)");
    expect(USAGE).toContain("Running it again is REFUSED");
    expect(USAGE).toContain("in ONE database transaction");
  });

  it("says relative paths resolve against apps/trader under pnpm (measured), and asks for absolute ones", () => {
    expect(USAGE).toContain("(pnpm --filter @polymarket-bot/trader run register) is apps/trader");
    expect(USAGE).toContain("pass absolute paths");
  });
});

describe("the refusals before any connection", () => {
  it("--help prints the usage and nothing else, whatever the environment", async () => {
    const result = await run(["--help"], { MAX_RUN_MODE: "LIVE" });
    expect(result.code).toBe(REGISTER_EXIT_CODES.registered);
    expect(result.printed).toBe(USAGE);
    expect(result.log).toBe("");
  });

  it("an unsafe environment is refused FIRST — before the flags are even read", async () => {
    const result = await run([], { ...SAFE_ENV, ALLOW_REAL_ORDERS: "true", DATABASE_URL: "postgres://x@127.0.0.1:1/x" });
    expect(result.code).toBe(REGISTER_EXIT_CODES.unsafeEnvironment);
    expect(result.log).toContain("REGISTER_UNSAFE_ENVIRONMENT");
    expect(result.log).toContain("PAPER_REAL_ORDERS_ENABLED");
    expect(result.log).not.toContain("safety: OK");
    expect(result.log).not.toContain("REGISTER_USAGE");
  });

  it("a usage error exits 64 after the safety check", async () => {
    const result = await run(["--template"], SAFE_ENV);
    expect(result.code).toBe(REGISTER_EXIT_CODES.usage);
    expect(result.log).toContain("safety: OK");
    expect(result.log).toContain("REGISTER_USAGE");
  });

  it("DATABASE_URL has no default", async () => {
    const result = await run(FLAGS, SAFE_ENV);
    expect(result.code).toBe(REGISTER_EXIT_CODES.refused);
    expect(result.log).toContain("REGISTER_NO_DATABASE");
  });
});

describe("the entry guard is keyed on the file Node runs, not on its name", () => {
  it("fires for the module's own path (as given, and through a symlink or a renamed copy's own URL), and for nothing else", async () => {
    const self = fileURLToPath(import.meta.url);
    expect(isProcessEntry(import.meta.url, self)).toBe(true);
    // An importer is never the entry: the runner's own script, another file,
    // nothing, a path that does not exist.
    expect(isProcessEntry(import.meta.url, process.argv[1])).toBe(false);
    expect(isProcessEntry(import.meta.url, path.join(path.dirname(self), "main.ts"))).toBe(false);
    expect(isProcessEntry(import.meta.url, undefined)).toBe(false);
    expect(isProcessEntry(import.meta.url, "")).toBe(false);
    expect(isProcessEntry(import.meta.url, path.join(path.dirname(self), "no-such-file.mjs"))).toBe(false);

    const directory = await mkdtemp(path.join(tmpdir(), "pmb-register-entry "));
    try {
      // Node names its main module by the REALPATH: a symlink to this file,
      // run as the entry, is this file.
      const link = path.join(directory, "linked register.mjs");
      await symlink(self, link);
      expect(isProcessEntry(import.meta.url, link)).toBe(true);
      // A renamed copy in a directory with a space is its own entry — a
      // file-name guard would miss it; the URL comparison does not.
      const copy = path.join(directory, "renamed.mjs");
      await writeFile(copy, "");
      expect(isProcessEntry(pathToFileURL(copy).href, copy)).toBe(true);
      expect(pathToFileURL(copy).href).toContain("%20");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the completed document is written exclusively", () => {
  it("creates a new file, and refuses — leaving it byte-identical — a file that exists at write time (O_EXCL, not only the pre-check)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pmb-register-unit-"));
    try {
      const fresh = path.join(directory, "fresh.json");
      expect(await writeExclusive(fresh, "{}\n")).toBeUndefined();
      expect(await readFile(fresh, "utf8")).toBe("{}\n");

      const existing = path.join(directory, "existing.json");
      await writeFile(existing, "an operator's file\n");
      const problem = await writeExclusive(existing, "{}\n");
      expect(problem).toContain("appeared while registering, and this command never overwrites a file");
      expect(await readFile(existing, "utf8")).toBe("an operator's file\n");

      const unwritable = path.join(directory, "no-such-directory", "out.json");
      expect(await writeExclusive(unwritable, "{}\n")).toContain("cannot be created");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the canonical parameters", () => {
  it("keeps the document's keys and order, renders every number as its decimal string, and hashes the exact text", () => {
    const rendered = canonicalParameters({ b: 1, a: { z: [2, "x", true, null], y: -3 }, c: "0.35" });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.text).toBe('{"b":"1","a":{"z":["2","x",true,null],"y":"-3"},"c":"0.35"}');
    expect(rendered.hash).toBe(createHash("sha256").update(rendered.text, "utf8").digest("hex"));
  });

  it("refuses a number that is not a safe integer, naming its path", () => {
    const rendered = canonicalParameters({ risk: { share: 0.5 }, big: 2 ** 53 });
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.problems).toHaveLength(2);
    expect(rendered.problems[0]).toContain("instances[0].params.risk.share: the number 0.5 is not a safe integer");
    expect(rendered.problems[1]).toContain("instances[0].params.big: the number 9007199254740992");
  });

  it("keeps a key spelled __proto__ as a key", () => {
    const params = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as unknown;
    const rendered = canonicalParameters(params);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.text).toBe('{"__proto__":{"x":"1"},"a":"2"}');
  });

  it("refuses params that are not an object", () => {
    for (const params of [null, [], "x", 1]) {
      expect(canonicalParameters(params).ok, JSON.stringify(params)).toBe(false);
    }
  });
});

describe("the savepoint rewrite rule", () => {
  it("maps a repository's begin/commit/rollback onto the one savepoint", () => {
    expect(mapStatement("begin")).toEqual({ kind: "SAVEPOINT", statement: `savepoint ${REPOSITORY_SAVEPOINT}` });
    expect(mapStatement(" COMMIT ")).toEqual({
      kind: "SAVEPOINT",
      statement: `release savepoint ${REPOSITORY_SAVEPOINT}`,
    });
    expect(mapStatement("rollback")).toEqual({
      kind: "SAVEPOINT",
      statement: `rollback to savepoint ${REPOSITORY_SAVEPOINT}`,
    });
  });

  it("REFUSES every other transaction-control statement (fail closed)", () => {
    for (const text of [
      "start transaction isolation level serializable",
      "begin isolation level serializable",
      "END",
      "abort",
      "commit and chain",
      "rollback to savepoint x",
      "savepoint x",
      "release savepoint x",
      "prepare transaction 'x'",
    ]) {
      expect(mapStatement(text).kind, text).toBe("REFUSE");
    }
  });

  it("forwards everything else unchanged", () => {
    for (const text of ['select "market_id" from "catalog"."markets"', 'insert into "strategy"."runs" values ($1)']) {
      expect(mapStatement(text), text).toEqual({ kind: "FORWARD" });
    }
  });
});

describe("the shipped example configuration is a usable template", () => {
  it("with its identities removed, passes the trader's door and composition root in memory", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const example = JSON.parse(
      readFileSync(path.join(repoRoot, "infra/compose/trader/trader.config.example.json"), "utf8"),
    ) as { markets: Record<string, unknown>[]; instances: Record<string, unknown>[] };
    const strip = (record: Record<string, unknown> | undefined, keys: readonly string[]) =>
      Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !keys.includes(key)));
    const template = {
      ...example,
      markets: [strip(example.markets[0], ["marketId"])],
      instances: [strip(example.instances[0], ["instanceId", "runId", "configId", "marketId"])],
    };
    const read = readTemplate(JSON.stringify(template), SAFE_ENV, () => Date.UTC(2026, 8, 28));
    expect(read.ok ? "ok" : read.refusal).toBe("ok");
    // And the example itself, which names identities, is refused as a template.
    const refused = readTemplate(JSON.stringify(example), SAFE_ENV, () => Date.UTC(2026, 8, 28));
    expect(refused.ok ? "accepted" : refused.refusal.code).toBe("REGISTER_TEMPLATE_HAS_IDENTITIES");
  });
});
