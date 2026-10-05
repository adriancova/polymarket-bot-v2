/**
 * Scoped confirmation (WP-330 acceptance: "Destructive actions require
 * confirmation or explicit noninteractive flag"; design requirement 2).
 *
 * A destructive command acts only when the operator has NAMED ITS SCOPE:
 *
 * - interactively, by typing the scope text when asked; or
 * - non-interactively, with `--confirm <scope>` equal to that text exactly.
 *
 * The scope text names what the command will touch, so a confirmation for one
 * order, one market, one account or one lease can never be replayed onto
 * another. A bare `--yes` is refused by the grammar (`grammar.ts`). With no
 * `--confirm` and no terminal, the command is REFUSED; it never waits.
 *
 * | Command | Scope text |
 * | --- | --- |
 * | cancel-order | `cancel-order:<venue-order-id>` |
 * | cancel-market | `cancel-market:<condition-id>` or `cancel-market:<condition-id>:<asset-id>` |
 * | cancel-all | `cancel-all:<account>` |
 * | stop-heartbeat | `stop-heartbeat:<account>:<fencing-lease-id>` (the lease read now: a confirmation for a lease that has since changed never matches) |
 */

import type { ParsedCommand } from "./grammar.js";
import type { ConfirmationPrompt } from "./ports.js";

export type ConfirmationVerdict =
  | { readonly confirmed: true; readonly via: "TYPED" | "FLAG" }
  | { readonly confirmed: false; readonly why: "FLAG_MISMATCH" | "TYPED_MISMATCH" | "NOT_INTERACTIVE" | "NO_ANSWER" };

/** The scope text of a destructive command. `leaseId` is required for stop-heartbeat. */
export function scopeText(command: ParsedCommand, leaseId: string | null = null): string {
  switch (command.command) {
    case "cancel-order":
      return `cancel-order:${command.target ?? ""}`;
    case "cancel-market":
      return command.assetId === null ? `cancel-market:${command.target ?? ""}` : `cancel-market:${command.target ?? ""}:${command.assetId}`;
    case "cancel-all":
      return `cancel-all:${command.accountRef}`;
    case "stop-heartbeat":
      return `stop-heartbeat:${command.accountRef}:${leaseId ?? ""}`;
    default:
      throw new TypeError(`${command.command} is not destructive and has no scope`);
  }
}

/** What the scope text covers, in words, for the prompt. */
export function scopeDescription(command: ParsedCommand, leaseId: string | null = null): string {
  switch (command.command) {
    case "cancel-order":
      return `cancel venue order ${command.target ?? ""}`;
    case "cancel-market":
      return command.assetId === null
        ? `cancel every open order of market ${command.target ?? ""}`
        : `cancel every open order of market ${command.target ?? ""} in asset ${command.assetId}`;
    case "cancel-all":
      return `cancel EVERY open order owned by the credentials of account ${command.accountRef}`;
    case "stop-heartbeat":
      return `revoke fencing lease ${leaseId ?? ""} of account ${command.accountRef}, so its holder stops the order heartbeat`;
    default:
      return command.command;
  }
}

/**
 * Decide the confirmation. `--confirm` is checked first and alone: when it is
 * given, the operator is never asked, and a mismatch refuses.
 */
export async function confirmScope(command: ParsedCommand, scope: string, description: string, prompt: ConfirmationPrompt): Promise<ConfirmationVerdict> {
  if (command.confirm !== null) {
    return command.confirm === scope ? { confirmed: true, via: "FLAG" } : { confirmed: false, why: "FLAG_MISMATCH" };
  }
  if (!prompt.interactive) return { confirmed: false, why: "NOT_INTERACTIVE" };
  let answer: string | null;
  try {
    answer = await prompt.ask(`To ${description}, type exactly: ${scope}\n(anything else stops) > `);
  } catch {
    answer = null;
  }
  if (answer === null) return { confirmed: false, why: "NO_ANSWER" };
  return answer.trim() === scope ? { confirmed: true, via: "TYPED" } : { confirmed: false, why: "TYPED_MISMATCH" };
}

export function confirmationRefusalText(why: Extract<ConfirmationVerdict, { confirmed: false }>["why"], scope: string): string {
  switch (why) {
    case "FLAG_MISMATCH":
      return `--confirm does not name this command's scope; it must be exactly ${scope}`;
    case "TYPED_MISMATCH":
      return `the typed text does not name this command's scope (${scope}); nothing was done`;
    case "NOT_INTERACTIVE":
      return `no terminal to ask and no --confirm: pass --confirm ${scope} to act non-interactively`;
    case "NO_ANSWER":
      return "no answer could be read; nothing was done";
  }
}
