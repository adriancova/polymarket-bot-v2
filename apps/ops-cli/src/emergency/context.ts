/**
 * What every command receives, and the confirmation step every destructive
 * command shares (design requirement 2): dry run, then scoped confirmation,
 * then the `ACTING` audit record, durable BEFORE the first destructive call.
 *
 * Also the bounded forms audit records hold ids and free text in (WP-330 r1,
 * WP330-V1-01): every record is bounded by construction below
 * `MAX_AUDIT_LINE_BYTES`, whatever the venue answers.
 */

import type { SignerGateContext } from "@polymarket-bot/polymarket-secure";

import type { AuditTrail, AuditValue } from "./audit-log.js";
import type { ReleaseResult } from "./bounded.js";
import { confirmationRefusalText, confirmScope } from "./confirmation.js";
import type { ExitName } from "./exit-codes.js";
import type { ParsedCommand } from "./grammar.js";
import type { ConfirmationPrompt, OpsClock } from "./ports.js";
import { SECTIONS, type Printer } from "./printer.js";

/**
 * A resource a command opened (the venue client, the lease store). `run.ts`
 * releases it only AFTER the OUTCOME record is written and printed, never
 * before (WP-330 r1, CX330-R1-02): cleanup never gates the record of what
 * happened, nor the process's end.
 */
export interface DeferredRelease {
  /** What is released, as the output names it ("the venue client"). */
  readonly what: string;
  /** The bound `release` honours, for the output. */
  readonly boundMs: number;
  /** Bounded by construction (`releaseWithin`); never throws. */
  readonly release: () => Promise<ReleaseResult>;
}

export interface CommandContext {
  readonly parsed: ParsedCommand;
  readonly gate: SignerGateContext;
  readonly printer: Printer;
  readonly audit: AuditTrail;
  readonly prompt: ConfirmationPrompt;
  readonly clock: OpsClock;
  readonly newId: () => string;
  /** Register a release, run after the OUTCOME record (see {@link DeferredRelease}). */
  readonly deferRelease: (release: DeferredRelease) => void;
}

export interface CommandResult {
  readonly exit: ExitName;
  /** The OUTCOME record's detail: counts, ids (bounded), verdicts. Never a credential. */
  readonly result: { readonly [key: string]: AuditValue };
}

/** At most this many ids (or not-canceled entries) go into one audit list; the count is always recorded. */
export const MAX_AUDITED_IDS = 200;
/** At most this many ids are printed on one line; the rest are counted. */
export const MAX_PRINTED_IDS = 50;
/** An audited id is at most this long: a venue order id's own bound (`VENUE_ORDER_ID`; WP-260's `SAFE_ID`). */
export const MAX_AUDITED_ID_LENGTH = 200;

const ID_CHARACTER = /^[A-Za-z0-9_\-:.]$/u;
const ELLIPSIS = "...";

/**
 * An id as an audit record holds it: the venue order id's alphabet only (any
 * other character becomes `?`), at most {@link MAX_AUDITED_ID_LENGTH}
 * characters. A venue order id the CLI accepted is unchanged. JSON escapes no
 * character of that alphabet, so an audited id costs at most its length in
 * bytes.
 */
export function auditId(id: string): string {
  const text = typeof id === "string" ? id : "?";
  const clipped = text.length > MAX_AUDITED_ID_LENGTH ? `${text.slice(0, MAX_AUDITED_ID_LENGTH - ELLIPSIS.length)}${ELLIPSIS}` : text;
  let out = "";
  for (const character of clipped) out += ID_CHARACTER.test(character) ? character : "?";
  return out;
}

/**
 * Free text (a venue reason, a budget refusal, an error kind) as an audit
 * record holds it: printable ASCII only (any other character becomes `?`),
 * at most `maxLength` characters. JSON escapes at most `"` and `\` in it, so
 * it costs at most twice its length in bytes.
 */
export function auditText(text: string, maxLength: number): string {
  const value = typeof text === "string" ? text : "?";
  const clipped = value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - ELLIPSIS.length))}${ELLIPSIS}` : value;
  let out = "";
  for (const character of clipped) {
    const code = character.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? character : "?";
  }
  return out;
}

export function auditedIds(ids: readonly string[]): AuditValue {
  return { count: ids.length, ids: ids.slice(0, MAX_AUDITED_IDS).map(auditId), truncated: ids.length > MAX_AUDITED_IDS };
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
