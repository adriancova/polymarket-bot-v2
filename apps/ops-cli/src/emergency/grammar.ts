/**
 * The emergency commands' argument grammar (WP-330 design requirement 1).
 * Pure: it reads only the argument list it is given.
 *
 * ```text
 * ops-cli cancel-order <venue-order-id>          --account <ref> --operator <ref> --reason <text> [--dry-run] [--confirm <scope>]
 * ops-cli cancel-market <condition-id> [--asset <token-id>]   (same options)
 * ops-cli cancel-all                             (same options)
 * ops-cli account-snapshot                       --account <ref> --operator <ref> [--reason <text>]
 * ops-cli reconcile                              --account <ref> --operator <ref> [--reason <text>]
 * ops-cli stop-heartbeat                         --account <ref> --operator <ref> --reason <text> [--dry-run] [--confirm <scope>]
 *
 * every command: [--audit-log <path>]  (else OPS_CLI_AUDIT_LOG; one is required)
 * ops-cli --help | ops-cli <command> --help
 * ```
 *
 * Rules, each a usage error (exit 2, nothing done):
 * - an unknown command, an unknown option, a repeated option, a missing or
 *   extra operand, a value that does not match its grammar;
 * - `--yes`, `-y`, `--force`, `--non-interactive`: a bare yes names no scope.
 *   A destructive command is confirmed only by typing its scope, or by
 *   `--confirm <scope>` naming it exactly (`confirmation.ts`);
 * - `--dry-run` or `--confirm` on a read-only command, `--asset` anywhere but
 *   cancel-market;
 * - a destructive command without `--reason`.
 */

export const DESTRUCTIVE_COMMANDS = ["cancel-order", "cancel-market", "cancel-all", "stop-heartbeat"] as const;
export const READ_ONLY_COMMANDS = ["account-snapshot", "reconcile"] as const;
export const COMMANDS = [...DESTRUCTIVE_COMMANDS, ...READ_ONLY_COMMANDS] as const;

export type DestructiveCommand = (typeof DESTRUCTIVE_COMMANDS)[number];
export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];
export type CommandName = (typeof COMMANDS)[number];

/** A venue order id: WP-260's accepted shape (`venue-client.ts` `ORDER_ID`). */
export const VENUE_ORDER_ID = /^[A-Za-z0-9_\-:.]{1,200}$/u;
/** A condition id: WP-260's accepted shape for `cancelMarketOrders` (`CONDITION_ID`). */
export const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/u;
/** A CTF token id or position id: WP-260's accepted shape (`ASSET_ID`). */
export const ASSET_ID = /^(?:[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/u;
/** An account or operator reference: printable, no spaces, within the database's `internal.identifier` (200). */
export const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/u;
/** The database's `internal.detail` bound. */
export const MAX_REASON_LENGTH = 2000;
/** A path is bounded so a record can always hold it. */
export const MAX_PATH_LENGTH = 1024;
/** The longest `--confirm` value read; a scope is far shorter. */
export const MAX_CONFIRM_LENGTH = 300;

const BARE_YES_FLAGS = ["--yes", "-y", "--force", "--non-interactive", "--assume-yes"];

export interface ParsedCommand {
  readonly command: CommandName;
  /** cancel-order's venue order id, or cancel-market's condition id. */
  readonly target: string | null;
  /** cancel-market's optional asset id. */
  readonly assetId: string | null;
  readonly accountRef: string;
  readonly operator: string;
  readonly reason: string | null;
  readonly dryRun: boolean;
  readonly confirm: string | null;
  readonly auditLogPath: string | null;
}

export type ParseResult =
  | { readonly kind: "COMMAND"; readonly command: ParsedCommand }
  | { readonly kind: "HELP"; readonly topic: CommandName | null }
  | {
      readonly kind: "USAGE_ERROR";
      readonly problem: string;
      /** Best-effort, so a malformed invocation is still audited when a log is named. */
      readonly command: CommandName | null;
      readonly auditLogPath: string | null;
      readonly operator: string | null;
      readonly accountRef: string | null;
    };

export function isDestructive(command: CommandName): command is DestructiveCommand {
  return (DESTRUCTIVE_COMMANDS as readonly string[]).includes(command);
}

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

/** ASCII control characters and DEL. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const VALUE_OPTIONS = ["--account", "--operator", "--reason", "--confirm", "--asset", "--audit-log"] as const;
const FLAG_OPTIONS = ["--dry-run", "--help"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];
type FlagOption = (typeof FLAG_OPTIONS)[number];

export const USAGE = [
  "usage: ops-cli <command> [operand] --account <ref> --operator <ref> [options]",
  "",
  "destructive commands (typed scope or --confirm <scope> required; --dry-run shows the plan):",
  "  cancel-order <venue-order-id>                 cancel one order (DELETE /order)",
  "  cancel-market <condition-id> [--asset <id>]   cancel every open order of one market (DELETE /cancel-market-orders)",
  "  cancel-all                                    cancel every open order of the account (DELETE /cancel-all), then",
  "                                                re-read and cancel by id whatever is still listed (DELETE /orders)",
  "  stop-heartbeat                                revoke the fencing lease so the trader's heartbeat stops (WP-320)",
  "read-only commands:",
  "  account-snapshot                              venue truth: open orders, /v2 positions, collateral, /v2 approvals",
  "  reconcile                                     WP-290's coordinator over venue truth; never resumes, never releases",
  "",
  "options:",
  "  --account <ref>      the account; must match the emergency credential (required)",
  "  --operator <ref>     who is acting; audited (required)",
  "  --reason <text>      why; audited (required for destructive commands)",
  "  --dry-run            print the plan and the exact --confirm value; do nothing",
  "  --confirm <scope>    non-interactive confirmation; must name the scope exactly (a bare --yes is refused)",
  "  --asset <token-id>   cancel-market only: narrow to one outcome token",
  "  --audit-log <path>   the append-only local audit log (else OPS_CLI_AUDIT_LOG)",
  "",
  "PAPER only in this repository: every venue command runs WP-260's signer gate first and refuses in PAPER,",
  "BACKTEST, SHADOW and REPLAY. Exit codes: see docs/runbooks/emergency.md.",
].join("\n");

/** Parse an argument list (without the program name). Never throws. */
export function parseArguments(argv: readonly string[]): ParseResult {
  const values = new Map<ValueOption, string>();
  const flags = new Set<FlagOption>();
  const operands: string[] = [];
  let problem: string | null = null;

  const fail = (text: string): void => {
    if (problem === null) problem = text;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (typeof raw !== "string") {
      fail("an argument is not text");
      continue;
    }
    if (BARE_YES_FLAGS.includes(raw) || BARE_YES_FLAGS.some((flag) => raw.startsWith(`${flag}=`))) {
      fail(`${raw.split("=")[0] ?? raw} is not accepted: a bare yes names no scope. Type the scope when asked, or pass --confirm <scope> (run with --dry-run to see it)`);
      continue;
    }
    if (raw.startsWith("-")) {
      const equals = raw.indexOf("=");
      const name = equals === -1 ? raw : raw.slice(0, equals);
      if ((FLAG_OPTIONS as readonly string[]).includes(name)) {
        const flag = name as FlagOption;
        if (equals !== -1) fail(`${flag} takes no value`);
        else if (flags.has(flag)) fail(`${flag} is given twice`);
        else flags.add(flag);
        continue;
      }
      if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
        const option = name as ValueOption;
        let value: string | undefined;
        if (equals !== -1) {
          value = raw.slice(equals + 1);
        } else {
          value = argv[index + 1];
          index += 1;
          // `--reason --dry-run` almost certainly forgot the value: an option is never taken as one.
          if (typeof value === "string" && value.startsWith("--")) {
            fail(`${option} needs a value (found the option ${value.split("=")[0] ?? value} instead)`);
            continue;
          }
        }
        if (typeof value !== "string") fail(`${option} needs a value`);
        else if (values.has(option)) fail(`${option} is given twice`);
        else values.set(option, value);
        continue;
      }
      fail(`unknown option ${name.length > 40 ? `${name.slice(0, 40)}…` : name}`);
      continue;
    }
    operands.push(raw);
  }

  const commandText = operands.shift();
  const command = commandText !== undefined && isCommand(commandText) ? commandText : null;
  const auditLogPath = values.get("--audit-log") ?? null;
  const operatorRaw = values.get("--operator");
  const accountRaw = values.get("--account");
  const usage = (text: string): ParseResult =>
    Object.freeze({
      kind: "USAGE_ERROR" as const,
      problem: text,
      command,
      auditLogPath: auditLogPath !== null && auditLogPath.length > 0 && auditLogPath.length <= MAX_PATH_LENGTH && !hasControl(auditLogPath) ? auditLogPath : null,
      operator: operatorRaw !== undefined && REFERENCE.test(operatorRaw) ? operatorRaw : null,
      accountRef: accountRaw !== undefined && REFERENCE.test(accountRaw) ? accountRaw : null,
    });

  if (flags.has("--help") && problem === null) {
    return Object.freeze({ kind: "HELP" as const, topic: command });
  }
  if (problem !== null) return usage(problem);
  if (commandText === undefined) return flags.has("--help") ? Object.freeze({ kind: "HELP" as const, topic: null }) : usage("no command given");
  if (command === null) return usage(`unknown command ${commandText.length > 40 ? `${commandText.slice(0, 40)}…` : commandText}`);

  // Operands.
  let target: string | null = null;
  if (command === "cancel-order" || command === "cancel-market") {
    if (operands.length !== 1) return usage(`${command} takes exactly one ${command === "cancel-order" ? "venue order id" : "condition id"}`);
    const operand = operands[0] as string;
    if (command === "cancel-order" && !VENUE_ORDER_ID.test(operand)) return usage("the venue order id is not an order id (1–200 of A-Z a-z 0-9 _ - : .)");
    if (command === "cancel-market" && !CONDITION_ID.test(operand)) return usage("the condition id must be 0x followed by 64 hex digits");
    target = operand;
  } else if (operands.length > 0) {
    return usage(`${command} takes no operand`);
  }

  // Options.
  const accountRef = values.get("--account");
  if (accountRef === undefined) return usage("--account is required: it names the account whose credentials act, and the scope you confirm");
  if (!REFERENCE.test(accountRef)) return usage("--account must be 1–200 of A-Z a-z 0-9 _ . : @ -, starting with a letter or digit");
  const operator = values.get("--operator");
  if (operator === undefined) return usage("--operator is required: every invocation is audited with who acted");
  if (!REFERENCE.test(operator)) return usage("--operator must be 1–200 of A-Z a-z 0-9 _ . : @ -, starting with a letter or digit");
  const reason = values.get("--reason") ?? null;
  if (reason !== null && (reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH || hasControl(reason))) {
    return usage(`--reason must be 1–${String(MAX_REASON_LENGTH)} characters with no control characters`);
  }
  if (isDestructive(command) && reason === null) return usage(`${command} is destructive: --reason is required, and audited`);
  const dryRun = flags.has("--dry-run");
  const confirm = values.get("--confirm") ?? null;
  if (!isDestructive(command)) {
    if (dryRun) return usage(`${command} is read-only: --dry-run applies to destructive commands only`);
    if (confirm !== null) return usage(`${command} is read-only: --confirm applies to destructive commands only`);
  }
  if (confirm !== null && (confirm.length === 0 || confirm.length > MAX_CONFIRM_LENGTH || hasControl(confirm))) {
    return usage("--confirm must be the scope text, as --dry-run prints it");
  }
  const asset = values.get("--asset") ?? null;
  if (asset !== null) {
    if (command !== "cancel-market") return usage("--asset applies to cancel-market only");
    if (!ASSET_ID.test(asset)) return usage("--asset must be a token id (decimal) or a 0x position id");
  }
  if (auditLogPath !== null && (auditLogPath.length === 0 || auditLogPath.length > MAX_PATH_LENGTH || hasControl(auditLogPath))) {
    return usage(`--audit-log must be a path of 1–${String(MAX_PATH_LENGTH)} characters`);
  }

  return Object.freeze({
    kind: "COMMAND" as const,
    command: Object.freeze({ command, target, assetId: asset, accountRef, operator, reason, dryRun, confirm, auditLogPath }),
  });
}
