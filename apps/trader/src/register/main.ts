/**
 * The paper trader's REGISTRATION command (`REGISTER-1`, pre-H1).
 *
 * `BOOT-1` made the durable trader REFUSE to start unless the
 * `catalog.markets`, `strategy.instances` and `strategy.runs` rows its
 * configuration names exist and agree with it — and left the operator to
 * create them by hand through five `WP-040` repository calls. This is that act
 * as a command: it reads the trader's own configuration document as a
 * template, registers the rows through THE SAME repositories
 * (`registerMarket`, `createDefinition`, `createConfig`, `createInstance`,
 * `startRun` — never `createTradingChain`), in ONE transaction, and writes the
 * COMPLETED document the trader then starts from.
 *
 * Placement (orchestrator ruling): a SEPARATE entry point of the trader app,
 * bundled on its own (`build:register` → `dist/register.mjs`), because the app
 * already owns the durable store and the registration check; `apps/ops-cli` is
 * `WP-330`'s. `main.ts` is untouched, and this file imports nothing from it: its
 * bundle would otherwise carry the Redis transport and the trader's own
 * top-level entry guard.
 *
 * ## The order, and why nothing moves ahead of step 2
 *
 * ```text
 * 1. --help                              pure text; reads and opens nothing
 * 2. checkPaperTraderSafety(env)         the trader's own PAPER check, FIRST
 * 3. the flags, DATABASE_URL, --out      --out must not exist (never overwritten)
 * 4. the template                        identities absent; the trader's door;
 *                                        a dry assembly in memory (template.ts)
 * 5. ONE transaction                     duplicate check, then the five repository
 *                                        calls (registration.ts, one-transaction.ts)
 * 6. the completed document              the trader's door + dry assembly again,
 *                                        then written with O_EXCL, BEFORE commit
 * 7. COMMIT                              the only commit; a REFUSED commit removes
 *                                        the file, one whose outcome is unknown
 *                                        keeps it (commitFailed)
 * ```
 *
 * Step 2 runs on the environment record before a file is read or a connection
 * attempted — the trader's own rule (`main.ts` step 1). A registration the
 * trader could not then run under is not worth writing, and a process that had
 * connected to something would have moved before the check it is subject to.
 *
 * ## Outcomes: all or nothing
 *
 * Every refusal and every failure before COMMIT rolls the ONE transaction back,
 * so nothing was registered and the output file does not exist. After COMMIT
 * every row exists and the file names them. The one window between — a COMMIT
 * whose connection died, so the server's answer never arrived — is reported as
 * exactly that, with the minted ids already printed, the completed document
 * KEPT, and the check that tells: the trader's own registration check accepts
 * that document if the rows landed and refuses it if they did not.
 *
 * ## What it does not do
 *
 * It does NOT verify a `gammaMarketId` (`UNIV4-R1`): nothing in this repository
 * can, and the gateway's `lifecycle` block is not its input. It prints the
 * operator's reminder instead. It does not register a second run for an
 * existing instance, nor a second instance on a registered market; both are
 * refused as duplicates (the follow-ups are recorded in `REGISTER-1`'s
 * handoff).
 *
 * PAPER only: it registers `PAPER` rows and nothing else, holds no credential,
 * and contacts no venue.
 */

import { realpathSync } from "node:fs";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StoragePostgresError, mapPostgresError } from "@polymarket-bot/storage-postgres";
import { checkPaperTraderSafety, formatStrictUtc, normalizeToStrictUtc } from "@polymarket-bot/trading-core";

import { asksForHelp, parseRegisterArguments, REGISTRABLE_LIFECYCLE_STATES, type RegisterArguments } from "./arguments.js";
import { OneTransactionViolation, openOneTransaction, type OneTransaction } from "./one-transaction.js";
import {
  registerRows,
  STATIC_BRACKET_DEFINITION,
  type RegisteredIdentities,
  type RegistrationPlan,
} from "./registration.js";
import { completeDocument, dryAssemble, readTemplate, type Template, type TemplateRefusal } from "./template.js";

/** What the command exits with (`sysexits` values), so an operator can script against it. */
export const REGISTER_EXIT_CODES = Object.freeze({
  /** Every row landed in one transaction and the completed document was written. */
  registered: 0,
  /** The command line was wrong (`EX_USAGE`). Nothing was read or opened. */
  usage: 64,
  /**
   * The database could not be reached or stopped answering (`EX_UNAVAILABLE`).
   * Nothing was registered — unless the connection died DURING the COMMIT
   * (`REGISTER_COMMIT_OUTCOME_UNKNOWN`): the outcome is then the database's to
   * tell, and the completed document is kept.
   */
  databaseUnavailable: 69,
  /** A defect in this command (`EX_SOFTWARE`). Nothing was registered. */
  internalFailure: 70,
  /** `--out` exists or cannot be created (`EX_CANTCREAT`). Nothing was registered. */
  outputNotCreatable: 73,
  /** The environment is not a safe PAPER environment (`EX_CONFIG`, as the trader). Nothing was read. */
  unsafeEnvironment: 78,
  /**
   * The template, a duplicate registration, or rows the database refused
   * (`EX_CONFIG`, as the trader). Nothing was registered.
   */
  refused: 78,
});

/** The environment variable naming the migrated `WP-040` database — the trader's own. */
export const DATABASE_URL = "DATABASE_URL";

/** Reported to `pg_stat_activity`. */
const APPLICATION_NAME = "polymarket-bot-register";

export const USAGE = `usage: register --template <file> --out <file>
                --instance-name <name> --question-title <text>
                --neg-risk <true|false> --trading-delay-seconds <seconds>
                --lifecycle-state <${REGISTRABLE_LIFECYCLE_STATES.join("|")}>
                --yes-label <label> --no-label <label>
                --code-commit <commit> --created-by <who>
       register --help
       (pnpm --filter @polymarket-bot/trader run register -- <flags>; one
       leading "--" is ignored)

Registers ONE PAPER market, strategy instance and run for the paper trader
(apps/trader), and writes the COMPLETED trader configuration document that the
trader's startup registration check (BOOT-1) accepts. The rows are written
through the WP-040 repositories (registerMarket, createDefinition,
createConfig, createInstance, startRun) in ONE database transaction: either
every row lands and the document is written, or nothing is registered.

Environment:
  ${DATABASE_URL}  the migrated WP-040 database, the same variable the trader
                reads. Required; its value is never printed.
  MAX_RUN_MODE=PAPER ALLOW_REAL_ORDERS=false LIVE_MICRO_MAX_ORDER_NOTIONAL=0
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
                the trader's own PAPER safety check runs FIRST, on the
                environment, before any file is read or any connection is
                attempted. Anything but a safe PAPER environment exits 78.

Input:
  --template <file>
      The trader configuration document (the schema the trader reads from
      TRADER_CONFIG_PATH) with exactly one market and one instance, and the
      minted identities ABSENT: markets[0].marketId and instances[0].instanceId,
      .runId, .configId and .marketId. markets[0].parametersVersion must be 1.
      Before any connection it must pass the trader's configuration door and
      the trader's own composition root, in memory (risk policy, allocator
      caps, the strategy's parameter validator).
  --out <file>
      Where the completed document is written. Must not exist: it is never
      overwritten. Its directory must exist.
      Both paths resolve against the working directory, which under pnpm
      (pnpm --filter @polymarket-bot/trader run register) is apps/trader, not
      the directory pnpm was started in: pass absolute paths.
  --instance-name <name>
      strategy.instances.instance_name; unique among PAPER instances. A letter,
      then letters, digits, _ . : or -; at most 64 characters.
  --question-title <text>
      catalog.markets.question_title: the market's question, as the venue
      states it.
  --neg-risk <true|false>
      The market's negRisk flag, as the venue states it.
  --trading-delay-seconds <seconds>
      The market's order delay in whole seconds (0 or more), as the venue
      states it.
  --lifecycle-state <${REGISTRABLE_LIFECYCLE_STATES.join("|")}>
      catalog.markets.lifecycle_state at registration.
  --yes-label <label>, --no-label <label>
      The outcome labels of the YES token (yesTokenId) and the NO token
      (noTokenId), as the venue lists them.
  --code-commit <commit>
      strategy.runs.code_commit: the commit the trader is built from
      (git rev-parse HEAD).
  --created-by <who>
      strategy.configs.created_by: who is registering.

What it registers:
  catalog.markets        NEW: the document's conditionId, tickSize,
                         minimumOrderSize, openTime and closeTime, the flags'
                         venue facts, parameter history version 1, and the two
                         catalog.market_tokens (yesTokenId YES, noTokenId NO).
  strategy.definitions   ${STATIC_BRACKET_DEFINITION.strategyName} ${STATIC_BRACKET_DEFINITION.codeVersion} (state schema ${String(STATIC_BRACKET_DEFINITION.stateSchemaVersion)}, decision contract ${String(STATIC_BRACKET_DEFINITION.decisionContractVersion)}),
                         the one strategy the trader runs. REUSED when it is
                         already registered with the same versions.
  strategy.configs       the instance's params exactly as the document states
                         them, each number as its decimal string; sha256 of that
                         text as parameters_hash. REUSED when the same
                         parameters are already registered for the definition.
  strategy.instances     NEW: PAPER, accounting.accountRef, ownership
                         (OWNER -> LIVE_OWNER, SHADOW -> SHADOW),
                         evaluationPriority.
  strategy.runs          NEW: PAPER, RUNNING, the document's runSeed, the
                         code commit.

Running it again is REFUSED: a registered conditionId, token id or PAPER
instance name is a duplicate, and nothing is written (exit 78). A new run for
an existing instance is not this command's (BOOT-1: startRun, then point the
document's runId at it).

Output:
  Progress and refusals on stderr. On success, ONE JSON line on stdout with the
  minted ids and the path written. Then start the trader with
  TRADER_CONFIG_PATH=<the --out file>.

It does NOT verify a gammaMarketId (UNIV4-R1). Nothing in this repository can:
before the run, verify BY HAND that the data gateway's lifecycle block names
the market whose conditionId the document states, against
GET https://gamma-api.polymarket.com/markets/{id}.

Exit codes:
  0   registered, and the completed document written
  64  usage error; nothing was read or opened
  69  the database could not be reached or stopped answering; nothing
      registered, UNLESS the connection died during the COMMIT itself
      (REGISTER_COMMIT_OUTCOME_UNKNOWN): then the completed document is KEPT
      and the command says how to tell whether its rows landed
  70  a defect in this command; nothing registered
  73  --out exists or cannot be created; nothing registered
  78  unsafe environment, refused template, duplicate registration, or rows
      the database refused; nothing registered
`;

export interface RegisterPorts {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Progress and refusals. The process writes them to stderr. */
  readonly log: (line: string) => void;
  /** The result: the usage text, or the one JSON line of ids. The process writes it to stdout. */
  readonly print: (text: string) => void;
  /** Epoch milliseconds. The process passes `Date.now`. */
  readonly nowMs: () => number;
}

/**
 * Runs the registration command and reports an exit code. Never throws: an
 * unexpected failure is `internalFailure` (70) after everything opened was
 * rolled back and closed.
 */
export async function runRegisterCommand(ports: RegisterPorts): Promise<number> {
  try {
    return await run(ports);
  } catch (cause) {
    ports.log(
      `REGISTER_FAILED_UNEXPECTEDLY: ${describe(cause)}. Nothing was committed: every write ` +
        "happens inside one transaction, which was rolled back or died with its connection",
    );
    return REGISTER_EXIT_CODES.internalFailure;
  }
}

async function run(ports: RegisterPorts): Promise<number> {
  const { log } = ports;

  // --- 1. --help: text only --------------------------------------------------
  if (asksForHelp(ports.argv)) {
    ports.print(USAGE);
    return REGISTER_EXIT_CODES.registered;
  }

  // --- 2. SAFETY, before anything is read, opened or connected ---------------
  const safety = checkPaperTraderSafety(ports.env);
  if (!safety.ok) {
    log(
      "REFUSING TO REGISTER: REGISTER_UNSAFE_ENVIRONMENT: the environment is not safe for a " +
        "PAPER trader (§6 invariant 17, §15, ADR-010 §1), and this command registers only what " +
        "that trader may run. No file was read and no connection was attempted.",
    );
    for (const violation of safety.violations) log(`  ${violation.code}: ${violation.detail}`);
    return REGISTER_EXIT_CODES.unsafeEnvironment;
  }
  log(`safety: OK — run mode ${safety.runMode}, ceiling PAPER, real orders disabled`);

  // --- 3. the flags, the database variable, the output path ------------------
  const parsed = parseRegisterArguments(ports.argv);
  if (!parsed.ok) {
    log("REFUSING TO REGISTER: REGISTER_USAGE: the command line is not usable; nothing was read");
    for (const problem of parsed.problems) log(`  ${problem}`);
    log("  (register --help prints every flag)");
    return REGISTER_EXIT_CODES.usage;
  }
  const args = parsed.arguments;
  const databaseUrl = ports.env[DATABASE_URL];
  if (databaseUrl === undefined || databaseUrl === "") {
    log(
      `REFUSING TO REGISTER: REGISTER_NO_DATABASE: ${DATABASE_URL} names the migrated WP-040 ` +
        "database (the trader's own variable) and has no default — a guessed database is a " +
        "registration in the wrong place",
    );
    return REGISTER_EXIT_CODES.refused;
  }
  const out = path.resolve(args.out);
  const outProblem = await outputProblem(out);
  if (outProblem !== undefined) {
    log(`REFUSING TO REGISTER: REGISTER_OUTPUT_NOT_CREATABLE: ${outProblem}; nothing was registered`);
    return REGISTER_EXIT_CODES.outputNotCreatable;
  }

  // --- 4. the template, through the trader's own doors, in memory ------------
  let text: string;
  try {
    text = await readFile(args.template, "utf8");
  } catch (cause) {
    log(
      `REFUSING TO REGISTER: REGISTER_TEMPLATE_UNREADABLE: ${args.template} could not be read ` +
        `(${describe(cause)}); nothing was registered`,
    );
    return REGISTER_EXIT_CODES.refused;
  }
  const read = readTemplate(text, ports.env, ports.nowMs);
  if (!read.ok) return refusedTemplate(log, read.refusal);
  const template = read.template;
  const plan = planFor(template, args, formatStrictUtc(ports.nowMs()));
  if (!plan.ok) return refusedTemplate(log, plan.refusal);
  log(
    `template: OK — ${args.template}: condition ${JSON.stringify(plan.plan.market.conditionId)}, ` +
      `run seed ${plan.plan.run.runSeed}, account ${JSON.stringify(plan.plan.instance.accountRef)}; ` +
      "the trader's configuration door and its composition root accepted it in memory",
  );

  // --- 5. ONE transaction ------------------------------------------------------
  let transaction: OneTransaction;
  try {
    transaction = await openOneTransaction({ connectionString: databaseUrl, applicationName: APPLICATION_NAME });
  } catch (cause) {
    log(
      `REFUSING TO REGISTER: REGISTER_DATABASE_UNAVAILABLE: the database named by ${DATABASE_URL} ` +
        `could not be reached (${describe(cause)}); nothing was registered`,
    );
    return REGISTER_EXIT_CODES.databaseUnavailable;
  }
  log(`database: connected (${DATABASE_URL}; credentials not printed); one transaction open`);

  let committed = false;
  let written = false;
  /** A COMMIT whose outcome is unknown keeps the document: it may name committed rows. */
  let keepOutput = false;
  try {
    const outcome = await registerRows(transaction.db, plan.plan, log);
    if (!outcome.ok) {
      log(`REFUSING TO REGISTER: ${outcome.refusal.code}: ${outcome.refusal.detail}`);
      for (const issue of outcome.refusal.issues) log(`  ${issue}`);
      return REGISTER_EXIT_CODES.refused;
    }
    const ids = outcome.registered;

    // --- 6. the completed document -------------------------------------------
    const completed = completeDocument(template.document, template.market, template.instance, {
      marketId: ids.marketId,
      instanceId: ids.instanceId,
      runId: ids.runId,
      configId: ids.configId,
    });
    const recheck = dryAssemble(completed, ports.env, ports.nowMs);
    if (!recheck.ok) {
      log(
        `REGISTER_FAILED_UNEXPECTEDLY: the completed document was refused by the trader's own ` +
          `doors (${recheck.refusal.code}: ${recheck.refusal.detail}) although its template ` +
          "passed them; nothing was committed",
      );
      for (const issue of recheck.refusal.issues) log(`  ${issue}`);
      return REGISTER_EXIT_CODES.internalFailure;
    }
    const writeProblem = await writeExclusive(out, `${JSON.stringify(completed, null, 2)}\n`);
    if (writeProblem !== undefined) {
      log(`REFUSING TO REGISTER: REGISTER_OUTPUT_NOT_CREATABLE: ${writeProblem}; nothing was committed`);
      return REGISTER_EXIT_CODES.outputNotCreatable;
    }
    written = true;

    // --- 7. COMMIT --------------------------------------------------------------
    try {
      await transaction.commit();
    } catch (cause) {
      const failure = commitFailed(log, cause, plan.plan, ids.runId, out);
      keepOutput = failure.outcomeUnknown;
      return failure.code;
    }
    committed = true;
    return reportRegistered(ports, ids, out, plan.plan.market.conditionId);
  } catch (cause) {
    // A failure BEFORE the COMMIT. The COMMIT's own failure is `commitFailed`'s,
    // and `reportRegistered` (after it) never throws.
    return writeFailed(log, cause);
  } finally {
    // Nothing in this block may throw: an escaped error would reach
    // `runRegisterCommand`'s catch-all and report "nothing was committed" for a
    // registration that DID commit.
    if (!committed) {
      try {
        await transaction.rollback();
      } catch (cause) {
        log(
          `  (the rollback itself failed: ${describe(cause)}; PostgreSQL discards an uncommitted ` +
            "transaction when its connection ends, which happens next)",
        );
      }
      if (written && !keepOutput) {
        try {
          await rm(out, { force: true });
        } catch (cause) {
          log(
            `  (${out} could not be removed: ${describe(cause)}. Delete it: the rows it names ` +
              "were not committed, and the trader refuses such a document as " +
              "TRADER_REGISTRATION_MISSING)",
          );
        }
      }
    }
    try {
      await transaction.close();
    } catch (cause) {
      log(`  (closing the database connection failed: ${describe(cause)})`);
    }
  }
}

/** The registration plan: the template's facts, the flags' facts, and the clock's instant. */
function planFor(
  template: Template,
  args: RegisterArguments,
  now: string,
):
  | { readonly ok: true; readonly plan: RegistrationPlan }
  | { readonly ok: false; readonly refusal: TemplateRefusal } {
  const market = template.config.markets[0];
  const instance = template.config.instances[0];
  if (market === undefined || instance === undefined) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_TEMPLATE_UNREADABLE",
        detail: "the parsed configuration lost its market or instance",
        issues: [],
      },
    };
  }
  const open = normalizeToStrictUtc(market.openTime);
  const close = normalizeToStrictUtc(market.closeTime);
  if (!open.ok || !close.ok) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_TEMPLATE_NOT_REGISTRABLE",
        detail: "a lifecycle instant cannot be normalised to strict UTC",
        issues: [open.ok ? "" : `openTime: ${open.problem}`, close.ok ? "" : `closeTime: ${close.problem}`].filter(
          (issue) => issue.length > 0,
        ),
      },
    };
  }
  return {
    ok: true,
    plan: {
      market: {
        conditionId: market.conditionId,
        questionTitle: args.questionTitle,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesLabel: args.yesLabel,
        noLabel: args.noLabel,
        tickSize: market.tickSize,
        minimumOrderSize: market.minimumOrderSize,
        tradingDelaySeconds: args.tradingDelaySeconds,
        negRisk: args.negRisk,
        lifecycleState: args.lifecycleState,
        openTime: open.instant,
        closeTime: close.instant,
        observedAt: now,
      },
      config: {
        parametersText: template.parametersText,
        parametersHash: template.parametersHash,
        validatedAt: now,
        createdBy: args.createdBy,
      },
      instance: {
        instanceName: args.instanceName,
        accountRef: template.config.accounting.accountRef,
        defaultOwnershipMode: instance.ownership === "OWNER" ? "LIVE_OWNER" : "SHADOW",
        evaluationPriority: instance.evaluationPriority,
      },
      run: { codeCommit: args.codeCommit, runSeed: instance.runSeed },
    },
  };
}

/**
 * Reports a COMMITTED registration. TOTAL: by now every row is committed and
 * the completed document written, so nothing that fails here may be reported
 * as the "nothing was registered" of a failure before COMMIT — the caller's
 * catch says exactly that. A failure to report is said as what it is, and the
 * exit code stays `registered` (0), which is what happened.
 */
function reportRegistered(
  ports: RegisterPorts,
  ids: RegisteredIdentities,
  out: string,
  conditionId: string,
): number {
  try {
    ports.log(
      `committed: catalog.markets ${ids.marketId}, strategy.definitions ${ids.definitionId}` +
        `${ids.definitionReused ? " (reused)" : ""}, strategy.configs ${ids.configId} v` +
        `${String(ids.configVersion)}${ids.configReused ? " (reused)" : ""}, strategy.instances ` +
        `${ids.instanceId}, strategy.runs ${ids.runId} — in one transaction`,
    );
    ports.log(`completed trader configuration written to ${out} (start the trader with TRADER_CONFIG_PATH=${out})`);
    ports.log(
      "REMINDER (UNIV4-R1): this command did NOT verify any gammaMarketId — nothing in this " +
        "repository can. Before the run, verify BY HAND that the data gateway's lifecycle block " +
        `names the market whose conditionId is ${JSON.stringify(conditionId)}, ` +
        "against GET https://gamma-api.polymarket.com/markets/{id}; a mis-pointed id opens this " +
        "market on another market's readiness, silently.",
    );
    ports.print(
      `${JSON.stringify({
        registered: true,
        marketId: ids.marketId,
        definitionId: ids.definitionId,
        definitionReused: ids.definitionReused,
        configId: ids.configId,
        configVersion: ids.configVersion,
        configReused: ids.configReused,
        instanceId: ids.instanceId,
        runId: ids.runId,
        completedDocument: out,
      })}\n`,
    );
  } catch (cause) {
    try {
      ports.log(
        `REGISTER_REPORT_FAILED: the registration COMMITTED and ${out} was written, but ` +
          `reporting it failed (${describe(cause)}); that document names every minted id ` +
          `(run ${ids.runId}), and running this command again is refused as a duplicate`,
      );
    } catch {
      // Nothing is left to report through; the exit code still says what happened.
    }
  }
  return REGISTER_EXIT_CODES.registered;
}

function refusedTemplate(log: (line: string) => void, refusal: TemplateRefusal): number {
  log(`REFUSING TO REGISTER: ${refusal.code}: ${refusal.detail}; nothing was registered`);
  for (const issue of refusal.issues) log(`  ${issue}`);
  return REGISTER_EXIT_CODES.refused;
}

/**
 * Why `out` cannot be the output, or `undefined`. The file must NOT exist (it
 * is never overwritten) and its directory must. Checked before any connection;
 * the write itself uses `O_EXCL`, so a file created in between still refuses.
 */
async function outputProblem(out: string): Promise<string | undefined> {
  try {
    await lstat(out);
    return `${out} already exists, and this command never overwrites a file`;
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") return `${out} cannot be inspected (${describe(cause)})`;
  }
  try {
    const directory = await stat(path.dirname(out));
    if (!directory.isDirectory()) return `${path.dirname(out)} is not a directory`;
  } catch (cause) {
    return `the directory of ${out} cannot be used (${describe(cause)})`;
  }
  return undefined;
}

/**
 * Creates `out` exclusively (`wx`: `O_CREAT | O_EXCL`) and writes `text`. TOTAL:
 * answers why it could not, having removed a file it created but could not
 * finish.
 */
export async function writeExclusive(out: string, text: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(out, "wx");
  } catch (cause) {
    return errorCode(cause) === "EEXIST"
      ? `${out} appeared while registering, and this command never overwrites a file`
      : `${out} cannot be created (${describe(cause)})`;
  }
  let problem: string | undefined;
  try {
    await handle.writeFile(text, "utf8");
  } catch (cause) {
    problem = `${out} could not be written (${describe(cause)})`;
  }
  try {
    await handle.close();
  } catch (cause) {
    problem ??= `${out} could not be closed (${describe(cause)})`;
  }
  if (problem !== undefined) {
    try {
      await rm(out, { force: true });
    } catch (cause) {
      problem += `; the partial file could not be removed either (${describe(cause)}) — delete it`;
    }
  }
  return problem;
}

/**
 * A database error inside the transaction: rolled back by the caller. A typed
 * storage error or a SQLSTATE outside the connection classes is the database
 * REFUSING a row (78); anything else is the database becoming unavailable (69);
 * a statement the pinned handle refused is this command's defect (70).
 */
function writeFailed(log: (line: string) => void, cause: unknown): number {
  if (cause instanceof OneTransactionViolation) {
    log(`REGISTER_FAILED_UNEXPECTEDLY: ${cause.message}; nothing was committed (rolled back)`);
    return REGISTER_EXIT_CODES.internalFailure;
  }
  const mapped = mapPostgresError(cause);
  const sqlState = serverSqlState(cause, mapped);
  if (refusedByDatabase(sqlState)) {
    log(
      `REFUSING TO REGISTER: REGISTER_REFUSED_BY_DATABASE: the database refused a row ` +
        `(${describe(mapped)}${sqlState === undefined ? "" : `; SQLSTATE ${sqlState}`}); the one ` +
        "transaction was rolled back, so nothing was registered",
    );
    return REGISTER_EXIT_CODES.refused;
  }
  log(
    `REFUSING TO REGISTER: REGISTER_DATABASE_UNAVAILABLE: the database stopped answering ` +
      `(${describe(mapped)}); the one transaction was rolled back or died with its connection, ` +
      "so nothing was registered",
  );
  return REGISTER_EXIT_CODES.databaseUnavailable;
}

/**
 * The COMMIT itself failed. A SERVER answer (a SQLSTATE) is a refused COMMIT:
 * PostgreSQL ended the transaction without it, nothing landed, and the caller
 * removes the document. No answer — the connection died — leaves the outcome
 * to the database, and the document is KEPT (`outcomeUnknown`): it names
 * exactly the rows the COMMIT would have landed, so if they did it is the one
 * to start from (a re-run is refused as a duplicate, and nothing else records
 * the minted ids but the progress lines above), and if they did not, the
 * trader's own registration check refuses it as `TRADER_REGISTRATION_MISSING`.
 */
function commitFailed(
  log: (line: string) => void,
  cause: unknown,
  plan: RegistrationPlan,
  runId: string,
  out: string,
): { readonly code: number; readonly outcomeUnknown: boolean } {
  const mapped = mapPostgresError(cause);
  const sqlState = serverSqlState(cause, mapped);
  if (sqlState !== undefined) {
    log(
      `REFUSING TO REGISTER: REGISTER_COMMIT_REFUSED: the database refused the COMMIT ` +
        `(${describe(mapped)}; SQLSTATE ${sqlState}), so PostgreSQL rolled the transaction back ` +
        "and nothing was registered; the output file was removed",
    );
    return {
      code: refusedByDatabase(sqlState) ? REGISTER_EXIT_CODES.refused : REGISTER_EXIT_CODES.databaseUnavailable,
      outcomeUnknown: false,
    };
  }
  log(
    `REGISTER_COMMIT_OUTCOME_UNKNOWN: the connection failed during COMMIT (${describe(mapped)}), ` +
      "so whether the rows landed is known only to the database. The completed document was " +
      `KEPT at ${out}: it names exactly the rows this COMMIT would have landed. To tell which, ` +
      "start the trader on it (its registration check answers 'registration: OK' if they " +
      "landed, and refuses with TRADER_REGISTRATION_MISSING if not), or check whether " +
      `strategy.runs holds run_id ${runId} (and catalog.markets condition_id ` +
      `${JSON.stringify(plan.market.conditionId)}). If they landed, start from that document ` +
      "and do NOT run this command again (it is refused as a duplicate); if not, nothing was " +
      "registered: delete that document and run the command again",
  );
  return { code: REGISTER_EXIT_CODES.databaseUnavailable, outcomeUnknown: true };
}

/**
 * The SQLSTATE the SERVER answered with, or `undefined` when no server answer
 * arrived (a socket error, a timeout). A typed storage error carries the one
 * it was mapped from; a raw `pg` server error carries `severity` and a
 * five-character `code` as own properties. A Node system error's `code`
 * (`EPIPE`, `ECONNRESET`) is not a SQLSTATE and carries no `severity`.
 */
function serverSqlState(cause: unknown, mapped: unknown): string | undefined {
  if (mapped instanceof StoragePostgresError) return mapped.sqlState;
  const code = errorCode(cause);
  const severity = ownString(cause, "severity");
  return code !== undefined && severity !== undefined && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

/**
 * Whether a server SQLSTATE is the database refusing data rather than failing
 * to serve: every class except connection (08), resources (53), operator
 * intervention (57), system (58) and internal (XX).
 */
function refusedByDatabase(sqlState: string | undefined): boolean {
  if (sqlState === undefined) return false;
  return !["08", "53", "57", "58", "XX"].includes(sqlState.slice(0, 2));
}

/** An own string `code` property (a Node system error's, or a `pg` SQLSTATE). */
function errorCode(cause: unknown): string | undefined {
  return ownString(cause, "code");
}

/** An own string data property of `value`, read by descriptor; else `undefined`. */
function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  const found: unknown = descriptor.value;
  return typeof found === "string" ? found : undefined;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/**
 * Whether the module at `moduleUrl` is the file Node was asked to run
 * (`argv1` is `process.argv[1]`). Compared by URL with that path — resolved
 * through symlinks, as Node names its main module, and as given, for
 * `--preserve-symlinks-main` — and NOT by file name: a guard keyed on the
 * name (`endsWith("/register.mjs")`, the trader's `"/main.mjs"`) exits 0
 * having done nothing when the bundle is renamed or copied (ADR-018's
 * renamed-bundle residual), which for a registration command is a false
 * success code. An importer — a test, another module — is never the entry.
 * TOTAL.
 */
export function isProcessEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    if (pathToFileURL(argv1).href === moduleUrl) return true;
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

/* c8 ignore start — the process shell, exercised by running the bundle. */
if (isProcessEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await runRegisterCommand({
    argv: process.argv.slice(2),
    env: process.env,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    print: (text) => {
      process.stdout.write(text);
    },
    nowMs: () => Date.now(),
  });
}
/* c8 ignore stop */
