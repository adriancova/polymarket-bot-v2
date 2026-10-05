/**
 * What every command receives, and the confirmation step every destructive
 * command shares (design requirement 2): dry run, then scoped confirmation,
 * then the `ACTING` audit record, durable BEFORE the first destructive call.
 */

import type { SignerGateContext } from "@polymarket-bot/polymarket-secure";

import type { AuditTrail, AuditValue } from "./audit-log.js";
import { confirmationRefusalText, confirmScope } from "./confirmation.js";
import type { ExitName } from "./exit-codes.js";
import type { ParsedCommand } from "./grammar.js";
import type { ConfirmationPrompt, OpsClock } from "./ports.js";
import { SECTIONS, type Printer } from "./printer.js";

export interface CommandContext {
  readonly parsed: ParsedCommand;
  readonly gate: SignerGateContext;
  readonly printer: Printer;
  readonly audit: AuditTrail;
  readonly prompt: ConfirmationPrompt;
  readonly clock: OpsClock;
  readonly newId: () => string;
}

export interface CommandResult {
  readonly exit: ExitName;
  /** The OUTCOME record's detail: counts, ids (bounded), verdicts. Never a credential. */
  readonly result: { readonly [key: string]: AuditValue };
}

/** At most this many ids go into one audit record; the count is always recorded. */
export const MAX_AUDITED_IDS = 200;
/** At most this many ids are printed on one line; the rest are counted. */
export const MAX_PRINTED_IDS = 50;

export function auditedIds(ids: readonly string[]): AuditValue {
  return { count: ids.length, ids: ids.slice(0, MAX_AUDITED_IDS), truncated: ids.length > MAX_AUDITED_IDS };
}

export function printedIds(ids: readonly string[]): string {
  if (ids.length === 0) return "(none)";
  const shown = ids.slice(0, MAX_PRINTED_IDS).join(", ");
  return ids.length > MAX_PRINTED_IDS ? `${shown}, … and ${String(ids.length - MAX_PRINTED_IDS)} more` : shown;
}

/**
 * Dry run, else confirmation, else the `ACTING` record. Answers `"GO"` only
 * after the `ACTING` record is durable; a failed audit write throws
 * (`AuditUnavailableError`), and the caller acts on nothing.
 */
export async function confirmThenRecord(
  context: CommandContext,
  scope: string,
  description: string,
  plan: { readonly [key: string]: AuditValue },
): Promise<"GO" | CommandResult> {
  const { parsed, printer } = context;
  if (parsed.dryRun) {
    const items = [`dry run: nothing is done. To act, type the scope when asked, or pass --confirm ${scope}`];
    if (parsed.confirm !== null) items.push(parsed.confirm === scope ? "the --confirm given names this scope: it would be accepted" : "the --confirm given does NOT name this scope: it would be refused");
    printer.section(SECTIONS.CONFIRMATION, items);
    return { exit: "DRY_RUN", result: { scope, dryRun: true } };
  }
  const verdict = await confirmScope(parsed, scope, description, context.prompt);
  if (!verdict.confirmed) {
    printer.section(SECTIONS.CONFIRMATION, [`REFUSED: ${confirmationRefusalText(verdict.why, scope)}`]);
    return { exit: "CONFIRMATION_REFUSED", result: { scope, confirmation: verdict.why } };
  }
  printer.section(SECTIONS.CONFIRMATION, [`scope ${scope} confirmed (${verdict.via === "FLAG" ? "--confirm" : "typed"})`]);
  await context.audit.write("ACTING", { scope, confirmedVia: verdict.via, ...plan });
  printer.raw(`  - ACTING record written and fsynced to ${context.audit.location} before acting`);
  return "GO";
}
