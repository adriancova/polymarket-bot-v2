/**
 * The TypeScript enum mirrors and the PostgreSQL enums are one vocabulary.
 *
 * This test parses `db/migrations/0001_foundation.up.sql` and compares each
 * `create type internal.<name> as enum (...)` against the corresponding
 * `as const` array. Without it, a value added to one side and not the other
 * would fail only at runtime, in whichever component happened to write that
 * value first — which for `order_state` or `ledger_scope` means during trading.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_MIGRATIONS_DIRECTORY } from "../migrations/loader.js";
import {
  ACTOR_KINDS,
  ASSET_KINDS,
  BOOK_SIDES,
  BREAK_STATUSES,
  COMPARISON_OPERATORS,
  DATA_QUALITY_INCIDENT_TYPES,
  DECISION_TYPES,
  EVENT_SOURCES,
  EXECUTION_GROUP_KINDS,
  INCIDENT_ACTIONS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INSTANCE_STATUSES,
  INTENT_TYPES,
  KILL_SWITCH_ACTIONS,
  KILL_SWITCH_SCOPES,
  LEASE_STATUSES,
  LEDGER_EVENT_TYPES,
  LEDGER_SCOPES,
  LIQUIDITY_PREFERENCES,
  LIQUIDITY_ROLES,
  MARKET_LIFECYCLE_STATES,
  MARKET_OUTCOME_STATES,
  OBSERVATION_TYPES,
  ORDER_SIDES,
  ORDER_STATES,
  OUTCOME_SIDES,
  OWNERSHIP_MODES,
  OWNERSHIP_STATUSES,
  PARTIAL_FILL_POLICIES,
  PAYOFF_MODELS,
  RATE_LIMIT_BUCKET_KINDS,
  RECONCILIATION_STATUSES,
  RECONCILIATION_TRIGGERS,
  RESERVATION_STATUSES,
  REWARD_PROGRAM_TYPES,
  RISK_OUTCOMES,
  RUN_MODES,
  RUN_STATUSES,
  SEGMENT_FORMATS,
  STRATEGY_CALLBACKS,
  SUBMISSION_STATES,
  TRADE_SETTLEMENT_STATES,
  TRADING_PARAMETER_KINDS,
  VERIFICATION_STATUSES,
  WALLET_OPERATION_STATES,
  WALLET_OPERATION_TYPES,
  executionRealm,
  isRealOrderRunMode,
} from "./enums.js";

const MIRRORS: Readonly<Record<string, readonly string[]>> = {
  run_mode: RUN_MODES,
  event_source: EVENT_SOURCES,
  market_outcome_state: MARKET_OUTCOME_STATES,
  market_lifecycle_state: MARKET_LIFECYCLE_STATES,
  outcome_side: OUTCOME_SIDES,
  book_side: BOOK_SIDES,
  order_side: ORDER_SIDES,
  observation_type: OBSERVATION_TYPES,
  comparison_operator: COMPARISON_OPERATORS,
  payoff_model: PAYOFF_MODELS,
  verification_status: VERIFICATION_STATUSES,
  trading_parameter_kind: TRADING_PARAMETER_KINDS,
  reward_program_type: REWARD_PROGRAM_TYPES,
  data_quality_incident_type: DATA_QUALITY_INCIDENT_TYPES,
  incident_severity: INCIDENT_SEVERITIES,
  incident_status: INCIDENT_STATUSES,
  incident_action: INCIDENT_ACTIONS,
  order_state: ORDER_STATES,
  trade_settlement_state: TRADE_SETTLEMENT_STATES,
  liquidity_role: LIQUIDITY_ROLES,
  submission_state: SUBMISSION_STATES,
  intent_type: INTENT_TYPES,
  decision_type: DECISION_TYPES,
  strategy_callback: STRATEGY_CALLBACKS,
  ownership_mode: OWNERSHIP_MODES,
  ownership_status: OWNERSHIP_STATUSES,
  instance_status: INSTANCE_STATUSES,
  run_status: RUN_STATUSES,
  lease_status: LEASE_STATUSES,
  reservation_status: RESERVATION_STATUSES,
  ledger_scope: LEDGER_SCOPES,
  ledger_event_type: LEDGER_EVENT_TYPES,
  asset_kind: ASSET_KINDS,
  wallet_operation_type: WALLET_OPERATION_TYPES,
  wallet_operation_state: WALLET_OPERATION_STATES,
  kill_switch_scope: KILL_SWITCH_SCOPES,
  kill_switch_action: KILL_SWITCH_ACTIONS,
  actor_kind: ACTOR_KINDS,
  risk_outcome: RISK_OUTCOMES,
  reconciliation_trigger: RECONCILIATION_TRIGGERS,
  reconciliation_status: RECONCILIATION_STATUSES,
  break_status: BREAK_STATUSES,
  segment_format: SEGMENT_FORMATS,
  rate_limit_bucket_kind: RATE_LIMIT_BUCKET_KINDS,
  execution_group_kind: EXECUTION_GROUP_KINDS,
  partial_fill_policy: PARTIAL_FILL_POLICIES,
  liquidity_preference: LIQUIDITY_PREFERENCES,
};

async function readSqlEnums(): Promise<Map<string, readonly string[]>> {
  const sql = await readFile(join(DEFAULT_MIGRATIONS_DIRECTORY, "0001_foundation.up.sql"), "utf8");
  const pattern = /create type internal\.(\w+) as enum \(([\s\S]*?)\);/gu;
  const enums = new Map<string, readonly string[]>();

  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) {
      continue;
    }
    const values = [...body.matchAll(/'([^']*)'/gu)].map((value) => value[1] ?? "");
    enums.set(name, values);
  }

  return enums;
}

describe("PostgreSQL enums and their TypeScript mirrors", () => {
  it("declares every mirrored enum in the foundation migration", async () => {
    const sqlEnums = await readSqlEnums();
    for (const name of Object.keys(MIRRORS)) {
      expect(sqlEnums.has(name), `internal.${name} is missing from 0001_foundation.up.sql`).toBe(
        true,
      );
    }
  });

  it("mirrors every value, in the same order", async () => {
    const sqlEnums = await readSqlEnums();
    for (const [name, mirrored] of Object.entries(MIRRORS)) {
      expect([name, sqlEnums.get(name)]).toEqual([name, [...mirrored]]);
    }
  });

  it("mirrors every SQL enum (no database enum is left unmirrored)", async () => {
    const sqlEnums = await readSqlEnums();
    const unmirrored = [...sqlEnums.keys()].filter((name) => !(name in MIRRORS));
    expect(unmirrored).toEqual([]);
  });
});

describe("executionRealm", () => {
  it("puts every real-order mode in one realm (ADR-011 §1)", () => {
    expect(executionRealm("EXECUTION_PROBE")).toBe("REAL");
    expect(executionRealm("LIVE_MICRO")).toBe("REAL");
    expect(executionRealm("LIVE")).toBe("REAL");
  });

  it("gives each simulated mode its own realm, so shadow never blocks live", () => {
    expect(executionRealm("BACKTEST")).toBe("SIMULATED:BACKTEST");
    expect(executionRealm("PAPER")).toBe("SIMULATED:PAPER");
    expect(executionRealm("SHADOW")).toBe("SIMULATED:SHADOW");
  });

  it("agrees with isRealOrderRunMode", () => {
    for (const mode of RUN_MODES) {
      expect(isRealOrderRunMode(mode)).toBe(executionRealm(mode) === "REAL");
    }
  });

  it("matches the SQL definition of internal.execution_realm", async () => {
    const sql = await readFile(
      join(DEFAULT_MIGRATIONS_DIRECTORY, "0001_foundation.up.sql"),
      "utf8",
    );
    for (const mode of RUN_MODES) {
      if (executionRealm(mode) === "REAL") {
        continue;
      }
      expect(sql).toContain(`when '${mode}' then '${executionRealm(mode)}'`);
    }
  });
});
