/**
 * The argument grammar (design requirement 1): every command parses as
 * documented, and every malformed invocation is a usage error, never a guess.
 */

import { describe, expect, it } from "vitest";

import { scopeText } from "./confirmation.js";
import { COMMANDS, DESTRUCTIVE_COMMANDS, parseArguments, READ_ONLY_COMMANDS, type ParsedCommand } from "./grammar.js";

const CONDITION = `0x${"a".repeat(64)}`;
const BASE = ["--account", "acct-1", "--operator", "op-1"];

function parsed(argv: string[]): ParsedCommand {
  const result = parseArguments(argv);
  if (result.kind !== "COMMAND") throw new Error(`expected a command, got ${JSON.stringify(result)}`);
  return result.command;
}

function problem(argv: string[]): string {
  const result = parseArguments(argv);
  if (result.kind !== "USAGE_ERROR") throw new Error(`expected a usage error, got ${JSON.stringify(result)}`);
  return result.problem;
}

describe("the command set", () => {
  it("is exactly the six WP-330 deliverables, four destructive", () => {
    expect([...COMMANDS].sort()).toEqual(["account-snapshot", "cancel-all", "cancel-market", "cancel-order", "reconcile", "stop-heartbeat"]);
    expect([...DESTRUCTIVE_COMMANDS].sort()).toEqual(["cancel-all", "cancel-market", "cancel-order", "stop-heartbeat"]);
    expect([...READ_ONLY_COMMANDS].sort()).toEqual(["account-snapshot", "reconcile"]);
  });
});

describe("well-formed invocations", () => {
  it("cancel-order <id>", () => {
    expect(parsed(["cancel-order", "0xabc-1:2.3_4", ...BASE, "--reason", "why"])).toEqual({
      command: "cancel-order",
      target: "0xabc-1:2.3_4",
      assetId: null,
      accountRef: "acct-1",
      operator: "op-1",
      reason: "why",
      dryRun: false,
      confirm: null,
      auditLogPath: null,
    });
  });

  it("cancel-market <condition> --asset <token>, options in any order and in --name=value form", () => {
    const command = parsed(["--operator=op-1", "cancel-market", "--asset", "12345", CONDITION, "--account=acct-1", "--reason=x", "--dry-run", "--audit-log", "/var/log/a.jsonl"]);
    expect(command).toMatchObject({ command: "cancel-market", target: CONDITION, assetId: "12345", dryRun: true, auditLogPath: "/var/log/a.jsonl" });
    expect(scopeText(command)).toBe(`cancel-market:${CONDITION}:12345`);
  });

  it("cancel-all, stop-heartbeat, account-snapshot and reconcile take no operand", () => {
    expect(parsed(["cancel-all", ...BASE, "--reason", "r", "--confirm", "cancel-all:acct-1"])).toMatchObject({ command: "cancel-all", confirm: "cancel-all:acct-1" });
    expect(parsed(["stop-heartbeat", ...BASE, "--reason", "r"])).toMatchObject({ command: "stop-heartbeat" });
    expect(parsed(["account-snapshot", ...BASE])).toMatchObject({ command: "account-snapshot", reason: null });
    expect(parsed(["reconcile", ...BASE, "--reason", "daily check"])).toMatchObject({ command: "reconcile", reason: "daily check" });
  });

  it("--help, alone or after a command", () => {
    expect(parseArguments(["--help"])).toEqual({ kind: "HELP", topic: null });
    expect(parseArguments(["cancel-all", "--help"])).toEqual({ kind: "HELP", topic: "cancel-all" });
  });
});

describe("usage errors (nothing is done)", () => {
  const cases: readonly (readonly [string, string[], RegExp])[] = [
    ["no command", [...BASE], /no command given/u],
    ["an unknown command", ["cancel-everything", ...BASE], /unknown command cancel-everything/u],
    ["an unknown option", ["cancel-all", ...BASE, "--reason", "r", "--all-markets"], /unknown option --all-markets/u],
    ["a repeated option", ["cancel-all", ...BASE, "--account", "acct-2", "--reason", "r"], /--account is given twice/u],
    ["a repeated flag", ["cancel-all", ...BASE, "--reason", "r", "--dry-run", "--dry-run"], /--dry-run is given twice/u],
    ["a flag with a value", ["cancel-all", ...BASE, "--reason", "r", "--dry-run=yes"], /--dry-run takes no value/u],
    ["an option missing its value at the end", ["cancel-all", ...BASE, "--reason"], /--reason needs a value/u],
    ["an option followed by another option", ["cancel-all", ...BASE, "--reason", "--dry-run"], /--reason needs a value \(found the option --dry-run instead\)/u],
    ["cancel-order without an id", ["cancel-order", ...BASE, "--reason", "r"], /exactly one venue order id/u],
    ["cancel-order with two ids", ["cancel-order", "a", "b", ...BASE, "--reason", "r"], /exactly one venue order id/u],
    ["cancel-order with a malformed id", ["cancel-order", "a b", ...BASE, "--reason", "r"], /not an order id/u],
    ["cancel-market with a malformed condition", ["cancel-market", "0x12", ...BASE, "--reason", "r"], /0x followed by 64 hex digits/u],
    ["cancel-all with an operand", ["cancel-all", "everything", ...BASE, "--reason", "r"], /takes no operand/u],
    ["--asset on cancel-all", ["cancel-all", ...BASE, "--reason", "r", "--asset", "1"], /--asset applies to cancel-market only/u],
    ["a malformed --asset", ["cancel-market", CONDITION, ...BASE, "--reason", "r", "--asset", "01"], /--asset must be a token id/u],
    ["a destructive command without --reason", ["cancel-all", ...BASE], /--reason is required/u],
    ["an empty --reason", ["cancel-all", ...BASE, "--reason", "   "], /--reason must be/u],
    ["a --reason with a control character", ["cancel-all", ...BASE, "--reason", "a\nb"], /--reason must be/u],
    ["no --account", ["cancel-all", "--operator", "op", "--reason", "r"], /--account is required/u],
    ["no --operator", ["cancel-all", "--account", "a", "--reason", "r"], /--operator is required/u],
    ["a malformed --account", ["cancel-all", "--account", "a b", "--operator", "op", "--reason", "r"], /--account must be/u],
    ["--dry-run on a read-only command", ["account-snapshot", ...BASE, "--dry-run"], /read-only: --dry-run/u],
    ["--confirm on a read-only command", ["reconcile", ...BASE, "--confirm", "x"], /read-only: --confirm/u],
    ["a bare --yes", ["cancel-all", ...BASE, "--reason", "r", "--yes"], /--yes is not accepted: a bare yes names no scope/u],
    ["-y", ["cancel-all", ...BASE, "--reason", "r", "-y"], /-y is not accepted/u],
    ["--force", ["cancel-all", ...BASE, "--reason", "r", "--force"], /--force is not accepted/u],
    ["--non-interactive", ["cancel-all", ...BASE, "--reason", "r", "--non-interactive"], /--non-interactive is not accepted/u],
    ["--assume-yes=1", ["cancel-all", ...BASE, "--reason", "r", "--assume-yes=1"], /--assume-yes is not accepted/u],
  ];
  for (const [label, argv, expected] of cases) {
    it(label, () => {
      expect(problem(argv)).toMatch(expected);
    });
  }

  it("a usage error still carries the audit path, operator and account it could read, so it is audited", () => {
    const result = parseArguments(["cancel-all", ...BASE, "--yes", "--audit-log", "/tmp/a.jsonl"]);
    expect(result).toMatchObject({ kind: "USAGE_ERROR", command: "cancel-all", auditLogPath: "/tmp/a.jsonl", operator: "op-1", accountRef: "acct-1" });
  });
});
