/**
 * One invocation of the emergency CLI, from argument list to exit code.
 *
 * ORDER, and why:
 *
 * 1. Parse the arguments (pure). `--help` prints the usage and exits 0.
 * 2. Evaluate WP-260's signer gate (`assertSignerGate`, pure) on the run-mode
 *    flags the composition supplies. Every venue-touching command passes it
 *    before anything else is read. A process it refuses (PAPER, BACKTEST,
 *    SHADOW, REPLAY, above its maximum, real orders not allowed) reads no
 *    configuration, credential, venue or lease store, and sends nothing; it
 *    writes only its audit records: the local log and, when the composition
 *    configured a database (`OPS_CLI_DATABASE_URL`), their best-effort copies
 *    in `ops.config_change_audit`, which do connect to that database
 *    (WP-330 r1, WP330-V1-03).
 * 3. Write the `INVOKED` audit record, durable, with the gate's verdict. A
 *    log that cannot be written stops the command (`AUDIT_UNAVAILABLE`).
 * 4. Refused by the gate: print why (stop-heartbeat first prints its
 *    guidance), write `OUTCOME`, exit `RUN_MODE_REFUSED`.
 * 5. Otherwise run the command; destructive commands write `ACTING` before
 *    they act (`context.ts`). Write `OUTCOME`, durable; print the exit. An
 *    OUTCOME that cannot be written exits `OUTCOME_UNRECORDED` (18), never
 *    the command's own exit: the output says whether the command may already
 *    have acted (WP330-V1-01).
 * 6. Only then release what the command opened (the venue client, the lease
 *    store), each bounded (CX330-R1-02): cleanup never gates the OUTCOME
 *    record or the process's end.
 * 7. Wait a bounded time for the database mirror copies; print which landed.
 *
 * Nothing in this file, or in any command, reads the trader's state, asks the
 * trader process, or needs the trader database: cancel-all needs only the
 * emergency credential and venue truth (§14.2).
 */

import { assertSignerGate, SignerBoundaryRefusal, signerGateContextFromSafetyFlags, type SignerGateContext } from "@polymarket-bot/polymarket-secure";

import { AuditTrail, AuditUnavailableError, MAX_AUDIT_LINE_BYTES, type AuditMirror, type AuditSink } from "./audit-log.js";
import { runAccountSnapshot } from "./commands/account-snapshot.js";
import { runCancelAll, runCancelMarket, runCancelOrder } from "./commands/cancel.js";
import { runReconcile } from "./commands/reconcile.js";
import { printStopHeartbeatGuidance, runStopHeartbeat } from "./commands/stop-heartbeat.js";
import type { CommandContext, CommandResult, DeferredRelease } from "./context.js";
import { EXIT_CODES, type ExitCode, type ExitName } from "./exit-codes.js";
import { parseArguments, USAGE, type ParsedCommand } from "./grammar.js";
import type {
  ConfigurationSource,
  ConfirmationPrompt,
  EmergencyCredentialPort,
  EmergencyVenueFactory,
  FencingLeaseAccessFactory,
  OpsClock,
  OutputPort,
  ProjectionSource,
} from "./ports.js";
import { Printer, SECTIONS } from "./printer.js";
import { openVenueSession } from "./session.js";

/** How long the CLI waits, at the end, for the database mirror copies of its audit records. A CLI policy, not a venue fact. */
export const MIRROR_SETTLE_MS = 3_000;

export interface OpsCliDependencies {
  /** The arguments, without the program name. */
  readonly argv: readonly string[];
  /** The run-mode flags record (`RUN_MODE`, `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`): read by WP-260's `signerGateContextFromSafetyFlags` only. */
  readonly runModeFlags: Readonly<Record<string, string | undefined>>;
  /** The audit log path when `--audit-log` is not given (`OPS_CLI_AUDIT_LOG`), or `null`. */
  readonly defaultAuditLogPath: string | null;
  readonly out: OutputPort;
  readonly prompt: ConfirmationPrompt;
  readonly clock: OpsClock;
  /** UUIDv7 ids: audit records, the invocation, reconcile's runs and breaks. */
  readonly newId: () => string;
  readonly openAuditLog: (path: string) => AuditSink;
  /** The audit records' database copy, or `null` when no database is configured. */
  readonly auditMirror: AuditMirror | null;
  readonly configuration: ConfigurationSource;
  readonly credentials: EmergencyCredentialPort;
  readonly venues: EmergencyVenueFactory;
  /** stop-heartbeat only: the fencing lease store. */
  readonly leases: FencingLeaseAccessFactory;
  /** reconcile only: the durable ledger projection, or `null`. */
  readonly projection: ProjectionSource | null;
}

export interface OpsCliOutcome {
  readonly exitName: ExitName;
  readonly exitCode: ExitCode;
}

function outcome(name: ExitName): OpsCliOutcome {
  return Object.freeze({ exitName: name, exitCode: EXIT_CODES[name] });
}

type GateVerdict = { readonly permitted: true; readonly context: SignerGateContext } | { readonly permitted: false; readonly reasons: readonly string[] };

function evaluateGate(flags: Readonly<Record<string, string | undefined>>): GateVerdict {
  try {
    return { permitted: true, context: assertSignerGate(signerGateContextFromSafetyFlags(flags)) };
  } catch (error) {
    return { permitted: false, reasons: error instanceof SignerBoundaryRefusal ? error.reasons : ["CONTEXT_UNREADABLE"] };
  }
}

type OutcomeRecording = { readonly kind: "RECORDED" } | { readonly kind: "RECORDED_WITHOUT_DETAIL" } | { readonly kind: "FAILED"; readonly code: string };

function auditCodeOf(error: unknown): string {
  return error instanceof AuditUnavailableError ? error.code : "WRITE_FAILED";
}

/**
 * Write the OUTCOME record. Its detail is bounded by construction
 * (`MAX_AUDIT_LINE_BYTES`); should it still be refused as too large, the
 * record is written again with the exit alone and `detailOmitted`, so the
 * outcome is never lost to its own size.
 */
async function recordOutcome(audit: AuditTrail, name: ExitName, result: CommandResult["result"]): Promise<OutcomeRecording> {
  const exit = { exit: name, exitCode: EXIT_CODES[name] };
  try {
    await audit.write("OUTCOME", { ...exit, ...result });
    return { kind: "RECORDED" };
  } catch (error) {
    if (!(error instanceof AuditUnavailableError && error.code === "RECORD_TOO_LARGE")) return { kind: "FAILED", code: auditCodeOf(error) };
  }
  try {
    await audit.write("OUTCOME", { ...exit, detailOmitted: "RECORD_TOO_LARGE" });
    return { kind: "RECORDED_WITHOUT_DETAIL" };
  } catch (error) {
    return { kind: "FAILED", code: auditCodeOf(error) };
  }
}

/** Release what the command opened, each bounded by construction; report any that did not finish. Never throws. */
async function releaseAll(printer: Printer, releases: readonly DeferredRelease[]): Promise<void> {
  const unfinished: string[] = [];
  for (const entry of releases) {
    let result;
    try {
      result = await entry.release();
    } catch {
      result = "FAILED" as const;
    }
    if (result === "UNANSWERED") unfinished.push(`${entry.what} did not finish releasing within ${String(entry.boundMs)} ms`);
    else if (result === "FAILED") unfinished.push(`${entry.what} failed to release`);
  }
  for (const line of unfinished) {
    printer.raw(`release: ${line}; the CLI ends anyway. Releasing a client changes no order and no lease, and the OUTCOME above was decided before it`);
  }
}

/**
 * The end of every invocation that has an audit trail, in this order: the
 * OUTCOME record, durable; the AUDIT and OUTCOME sections; the bounded
 * release of what the command opened; the bounded wait for the database
 * copies. Nothing after the OUTCOME record can change the exit.
 */
async function finish(printer: Printer, audit: AuditTrail | null, name: ExitName, result: CommandResult["result"], releases: readonly DeferredRelease[] = []): Promise<OpsCliOutcome> {
  let exit: ExitName = name;
  if (audit !== null) {
    const recorded = await recordOutcome(audit, name, result);
    const written = `${String(audit.records().length)} record(s) written and fsynced to ${audit.location}`;
    if (recorded.kind === "RECORDED") {
      printer.section(SECTIONS.AUDIT, [written]);
    } else if (recorded.kind === "RECORDED_WITHOUT_DETAIL") {
      printer.section(SECTIONS.AUDIT, [
        `${written}; the OUTCOME record's detail exceeded ${String(MAX_AUDIT_LINE_BYTES)} bytes, so it records the exit alone (detailOmitted): this output holds the rest; copy it into the incident record`,
      ]);
    } else {
      // The record of what happened is missing: never let the exit claim otherwise (WP330-V1-01).
      exit = "OUTCOME_UNRECORDED";
      const acted = audit.records().some((record) => record.phase === "ACTING");
      printer.section(SECTIONS.AUDIT, [
        acted
          ? `the OUTCOME record could NOT be written to ${audit.location} (${recorded.code}). The command MAY ALREADY HAVE ACTED: its ACTING record is in the log, and what happened is recorded only in this output. Copy this output into the incident record, and read the account (account-snapshot) before acting again`
          : `the OUTCOME record could NOT be written to ${audit.location} (${recorded.code}). No ACTING record was written, so this invocation sent no cancel and revoked no lease; its outcome is recorded only in this output: copy it into the incident record`,
      ]);
    }
  }
  printer.section(SECTIONS.OUTCOME, [
    exit === name
      ? `${name} (exit ${String(EXIT_CODES[name])})`
      : `${exit} (exit ${String(EXIT_CODES[exit])}): the command's own outcome, ${name} (exit ${String(EXIT_CODES[name])}), is NOT in the audit log`,
  ]);
  await releaseAll(printer, releases);
  if (audit !== null) {
    const mirror = await audit.settleMirrors(MIRROR_SETTLE_MS);
    if (mirror.configured) {
      printer.raw(`database copy (ops.config_change_audit): ${String(mirror.landed)} landed, ${String(mirror.failed)} failed, ${String(mirror.pending)} still pending; the local log is the record of truth`);
    }
  }
  return outcome(exit);
}

export async function runOpsCli(deps: OpsCliDependencies): Promise<OpsCliOutcome> {
  const printer = new Printer(deps.out);
  const parsed = parseArguments(deps.argv);
  if (parsed.kind === "HELP") {
    printer.raw(USAGE);
    return outcome("COMPLETED");
  }

  const invocationId = deps.newId();
  const auditPath = (parsed.kind === "COMMAND" ? parsed.command.auditLogPath : parsed.auditLogPath) ?? deps.defaultAuditLogPath;
  const header =
    parsed.kind === "COMMAND"
      ? { command: parsed.command.command, operator: parsed.command.operator, accountRef: parsed.command.accountRef, reason: parsed.command.reason }
      : { command: parsed.command, operator: parsed.operator, accountRef: parsed.accountRef, reason: null };
  printer.raw(`ops-cli ${header.command ?? "(no command)"} — account ${header.accountRef ?? "(none)"} — invocation ${invocationId}`);

  // A malformed invocation: nothing is evaluated or done; it is audited when a log is named.
  if (parsed.kind === "USAGE_ERROR") {
    printer.raw(`usage error: ${parsed.problem}`);
    printer.raw(USAGE);
    let audit: AuditTrail | null = null;
    if (auditPath !== null) {
      audit = new AuditTrail({ sink: deps.openAuditLog(auditPath), mirror: deps.auditMirror, clock: deps.clock, newId: deps.newId, invocationId }, header);
      try {
        await audit.write("INVOKED", { usageError: parsed.problem });
      } catch {
        audit = null;
      }
    }
    return finish(printer, audit, "USAGE", { usageError: parsed.problem });
  }

  const command: ParsedCommand = parsed.command;
  // The gate first: pure, before anything is read.
  const gate = evaluateGate(deps.runModeFlags);

  // The INVOKED record, durable, before anything is touched.
  if (auditPath === null) {
    printer.section(SECTIONS.AUDIT, ["REFUSED: no audit log: pass --audit-log <path> or set OPS_CLI_AUDIT_LOG. Nothing is done unaudited"]);
    printer.section(SECTIONS.OUTCOME, [`AUDIT_UNAVAILABLE (exit ${String(EXIT_CODES.AUDIT_UNAVAILABLE)})`]);
    return outcome("AUDIT_UNAVAILABLE");
  }
  const audit = new AuditTrail({ sink: deps.openAuditLog(auditPath), mirror: deps.auditMirror, clock: deps.clock, newId: deps.newId, invocationId }, header);
  try {
    await audit.write("INVOKED", {
      target: command.target,
      asset: command.assetId,
      dryRun: command.dryRun,
      confirmGiven: command.confirm !== null,
      gate: gate.permitted ? { permitted: true, runMode: gate.context.runMode, maximumRunMode: gate.context.maximumRunMode } : { permitted: false, reasons: [...gate.reasons] },
    });
  } catch (error) {
    const code = error instanceof AuditUnavailableError ? error.code : "WRITE_FAILED";
    printer.section(SECTIONS.AUDIT, [`REFUSED: the audit log ${auditPath} could not record this invocation (${code}). Nothing was done`]);
    printer.section(SECTIONS.OUTCOME, [`AUDIT_UNAVAILABLE (exit ${String(EXIT_CODES.AUDIT_UNAVAILABLE)})`]);
    return outcome("AUDIT_UNAVAILABLE");
  }
  printer.section(SECTIONS.AUDIT, [`INVOKED record written and fsynced to ${auditPath}`]);

  if (command.command === "stop-heartbeat") printStopHeartbeatGuidance(printer);

  if (!gate.permitted) {
    printer.section(SECTIONS.RUN_MODE, [
      `REFUSED by WP-260's signer gate (${gate.reasons.join(", ")})`,
      command.command === "stop-heartbeat"
        ? "a PAPER, BACKTEST, SHADOW or REPLAY process holds no live fencing lease (WP-320 refuses to acquire one; the database CHECK refuses one) and sends no order heartbeat: there is nothing to revoke"
        : "this command reaches the venue with real credentials; it runs only in EXECUTION_PROBE, LIVE_MICRO or LIVE, within the process maximum, with real orders allowed (ADR-010)",
      "nothing was read, sent or written but this audit record",
    ]);
    return finish(printer, audit, "RUN_MODE_REFUSED", { gateReasons: [...gate.reasons] });
  }
  audit.runMode = gate.context.runMode;
  printer.section(SECTIONS.RUN_MODE, [`${gate.context.runMode} (maximum ${gate.context.maximumRunMode}, real orders allowed): permitted by WP-260's signer gate`]);

  // What the command opens is released only after its OUTCOME record (CX330-R1-02).
  const releases: DeferredRelease[] = [];
  const context: CommandContext = {
    parsed: command,
    gate: gate.context,
    printer,
    audit,
    prompt: deps.prompt,
    clock: deps.clock,
    newId: deps.newId,
    deferRelease: (release) => void releases.push(release),
  };
  let result: CommandResult;
  try {
    result = await dispatch(context, deps);
  } catch (error) {
    if (error instanceof AuditUnavailableError) {
      printer.section(SECTIONS.AUDIT, [`REFUSED: the ACTING record could not be written (${error.code}); nothing was sent`]);
      return finish(printer, audit, "AUDIT_UNAVAILABLE", { auditCode: error.code }, releases);
    }
    printer.section(SECTIONS.UNKNOWN, ["an unexpected failure stopped the command: treat the account as UNKNOWN and run account-snapshot or reconcile"]);
    return finish(printer, audit, "INTERNAL_ERROR", { internalError: error instanceof Error ? error.name : "unknown" }, releases);
  }
  return finish(printer, audit, result.exit, result.result, releases);
}

async function dispatch(context: CommandContext, deps: OpsCliDependencies): Promise<CommandResult> {
  const { parsed, printer } = context;
  if (parsed.command === "stop-heartbeat") return runStopHeartbeat(context, deps.leases);
  const opened = await openVenueSession(parsed, context.gate, deps);
  if (opened.kind !== "OPEN") {
    printer.section(SECTIONS.PLAN, [`${parsed.command} for account ${parsed.accountRef}`]);
    printer.section(SECTIONS.RESULT, [`nothing was sent: ${opened.problem}`]);
    printer.section(SECTIONS.UNKNOWN, ["the account's venue truth: nothing was read"]);
    return { exit: opened.exit, result: { stopped: opened.problem } };
  }
  const session = opened.session;
  // Released after the OUTCOME record, bounded by venueAnswerBoundMs (session.ts): never before it, never unbounded.
  context.deferRelease({ what: "the venue client", boundMs: session.configuration.venueAnswerBoundMs, release: () => session.close() });
  switch (parsed.command) {
    case "cancel-all":
      return runCancelAll(context, session);
    case "cancel-order":
      return runCancelOrder(context, session);
    case "cancel-market":
      return runCancelMarket(context, session);
    case "account-snapshot":
      return runAccountSnapshot(context, session);
    case "reconcile":
      return runReconcile(context, session, deps.projection);
  }
}
