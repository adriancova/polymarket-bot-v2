/**
 * `@polymarket-bot/control-api` — the §4.1 process that owns authenticated
 * operational controls and read APIs, and **never has the signing key**.
 *
 * PAPER only. There is no venue connection, no order path, no wallet
 * operation, and no request that names a run mode: §11's ceiling is a startup
 * value read by `safety.ts` and exposed read-only.
 *
 * The composition root is `main.ts`; the Postgres audit binding is under
 * `adapters/` and is imported only there, so nothing in this entry point loads
 * a database client.
 */

export {
  CONTROL_API_RUN_MODE,
  REPOSITORY_MAXIMUM_RUN_MODE,
  checkControlApiSafety,
} from "./safety.js";
export type {
  ControlSafetyOutcome,
  ControlSafetyViolation,
  ControlSafetyViolationCode,
  Environment,
} from "./safety.js";

export {
  LOOPBACK_HOSTS,
  MINIMUM_TOKEN_LENGTH,
  parseControlApiConfig,
} from "./config.js";
export type {
  ConfigRefusal,
  ConfigRefusalCode,
  ControlApiConfig,
  ControlApiOperatorConfig,
  ParseConfigResult,
} from "./config.js";

export { OPERATOR_GRANTS, OperatorRegistry, hasGrant } from "./auth.js";
export type {
  AuthenticationFailureReason,
  AuthenticationResult,
  OperatorCredential,
  OperatorGrant,
} from "./auth.js";

export {
  CONTROL_ACTOR_KIND,
  CONTROL_KILL_SWITCH_ACTIONS,
  CONTROL_KILL_SWITCH_SCOPES,
  FORBIDDEN_CONTROL_KEYS,
  STRONGEST_KILL_SWITCH_ACTION,
  forbiddenControlKeysIn,
} from "./vocabulary.js";
export type { ControlKillSwitchAction, ControlKillSwitchScope } from "./vocabulary.js";

export { buildDoor, deepFreeze, ownBoolean, ownNumber, ownRecord, ownString } from "./doors.js";
export type { DoorRefusal, DoorRefusalCode, DoorResult } from "./doors.js";

export {
  AUDIT_APPEND_TIMEOUT_MAX_MS,
  AUDIT_APPEND_TIMEOUT_MS,
  CONTROL_PLANE_VOID_ACTOR,
  ControlPlane,
  LATE_APPEND_OUTCOMES,
  REFUSAL_AUDIT_MAX_ISSUES,
  REFUSAL_AUDIT_MAX_TEXT,
  auditAppendTimeoutProblem,
} from "./control-plane.js";
export type {
  AuditRecordSource,
  ControlPlaneOptions,
  KillSwitchRelease,
  KillSwitchState,
  ModeRaiseAuditOutcome,
  MutatingAuditAction,
  MutationContext,
  MutationRefusalCode,
  MutationResult,
  RefusalAuditOutcome,
  RequestRefusal,
  RequestRefusalStage,
  RunStateView,
  StrategyInstanceState,
  StrategyRunState,
} from "./control-plane.js";

export { readTraderHealthReport } from "./health-door.js";

export {
  AbsentTraderHealthSource,
  HttpTraderHealthSource,
  InMemoryTraderHealthSource,
  TraderHealthCache,
} from "./health-source.js";
export type {
  HealthReadOutcome,
  HealthReadResult,
  HttpTraderHealthSourceOptions,
  TraderHealthSource,
} from "./health-source.js";

export {
  AbsentTraderHaltSource,
  InMemoryTraderHaltSource,
  TRADER_HALT_DETAIL_MAX,
  TRADER_HALT_INCIDENT_KEYS,
  TRADER_HALT_INCIDENT_KEY_PREFIX,
  TRADER_HALT_LIST_LIMIT,
  TRADER_HALT_METRIC_FAMILIES,
  TRADER_HALT_READ_OUTCOMES,
  TRADER_HALT_SCOPES,
  TRADER_HALT_STATES,
  TraderHaltCache,
  inTraderHaltNamespace,
  readTraderHaltFetch,
  traderHaltSamples,
  traderHaltScopeOf,
  traderHaltsDocument,
} from "./trader-halts.js";
export type {
  OpenTraderHaltRow,
  OpenTraderHalts,
  TraderHaltFetch,
  TraderHaltReadOutcome,
  TraderHaltReadResult,
  TraderHaltScope,
  TraderHaltSource,
  TraderHaltState,
  TraderHaltView,
} from "./trader-halts.js";

export {
  CONTROL_API_METRIC_FAMILIES,
  CONTROL_API_ROUTE_TABLE,
  CONTROL_API_ROUTES,
  ControlApi,
  MODE_RAISE_REASON_MAX_METHOD,
  MODE_RAISE_REASON_MAX_PATH,
  MUTATION_GRANTS,
  holdsMutationAuthority,
} from "./api.js";

export {
  AUDIT_IDENTIFIER_MAX_TEXT,
  AUDIT_REASON_MAX_TEXT,
  AUDIT_TEXT_ELLIPSIS,
  auditSafeDocument,
  auditSafeRecord,
  boundAuditText,
  escapeAuditText,
} from "./audit-text.js";
export type {
  ApiEnvironment,
  ApiRequest,
  ApiResponse,
  ControlApiOptions,
  ControlApiRoute,
  TransportRefusal,
  TransportRefusalCode,
} from "./api.js";

export {
  AUDIT_BUDGET_TIERS,
  SafetyReservedAuditSink,
  auditBudgetProblem,
  auditBudgetTier,
  createBudgetedAuditLog,
} from "./audit-budget.js";
export type { AuditBudgetOptions, AuditBudgetTier, AuditBudgetTierInput } from "./audit-budget.js";

export { MAX_INSTANCE_ID_LENGTH, instanceIdProblem, readInstanceIdParameter } from "./instance-id.js";
export type { InstanceIdParameter } from "./instance-id.js";

export { CONTROL_HTTP_TIMEOUTS, isJsonContentType, startControlHttpServer } from "./http.js";
export type {
  ControlHttpServerOptions,
  ControlHttpTimeouts,
  RunningControlHttpServer,
} from "./http.js";
