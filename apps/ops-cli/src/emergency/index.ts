/**
 * WP-330: the independent emergency operations CLI (handoff §14.2; ADR-008 §6;
 * ADR-033 D1 item 4). See `run.ts` for the order of one invocation, `ports.ts`
 * for the injected surfaces (the emergency credential boundary, §15), and
 * `docs/runbooks/emergency.md` for the operator's guide.
 *
 * PAPER ONLY in this repository: every venue-touching command runs WP-260's
 * signer gate first, and the composition (`main.ts`) binds no credential and
 * no venue.
 */

export { AUDIT_SCHEMA, AuditTrail, AuditUnavailableError, createFileAuditLog, encodeAuditLine, type AuditMirror, type AuditRecord, type AuditSink } from "./audit-log.js";
export { createPostgresAuditMirror } from "./audit-mirror.js";
export { CANCEL_PRIORITY, EMERGENCY_OPERATIONS, EmergencyBudget, READ_PRIORITY } from "./budget.js";
export { confirmScope, scopeText } from "./confirmation.js";
export { OPS_CONFIGURATION_SCHEMA, parseOpsConfiguration, type OpsConfiguration } from "./configuration.js";
export { EXIT_CODES, type ExitCode, type ExitName } from "./exit-codes.js";
export { COMMANDS, DESTRUCTIVE_COMMANDS, parseArguments, READ_ONLY_COMMANDS, USAGE, type CommandName, type ParsedCommand } from "./grammar.js";
export type * from "./ports.js";
export { MIRROR_SETTLE_MS, runOpsCli, type OpsCliDependencies, type OpsCliOutcome } from "./run.js";
export { EMERGENCY_VENUE_FACTS, type EmergencyVenueFact } from "./venue-facts.js";
