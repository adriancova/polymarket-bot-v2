/**
 * WP-270 deliverable 1: the §9.11 order and trade-settlement state machines
 * and the submission-attempt machine (migration 0001's enums), every
 * transition explicit.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_STATES,
  ATTEMPT_TRANSITIONS,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  SETTLEMENT_STATES,
  SETTLEMENT_TRANSITIONS,
  TERMINAL_ORDER_STATES,
} from "../../../packages/oms/src/index.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const foundation = readFileSync(resolve(repoRoot, "db/migrations/0001_foundation.up.sql"), "utf8");

function enumValues(name: string): string[] {
  const match = new RegExp(`create type internal\\.${name} as enum \\(([^)]*)\\)`, "u").exec(foundation);
  return [...(match?.[1] ?? "").matchAll(/'([A-Z_]+)'/gu)].map((value) => value[1] as string);
}

describe("the state vocabularies match handoff §9.11 and the database enums", () => {
  it("order states: §9.11's fourteen, exactly the `internal.order_state` enum", () => {
    expect([...ORDER_STATES]).toEqual([
      "PLANNED", "SIGNED", "SENDING", "ACKNOWLEDGED", "LIVE", "DELAYED", "PARTIALLY_FILLED",
      "FILLED", "CANCEL_PENDING", "CANCELED", "REJECTED", "SUBMISSION_UNKNOWN", "RECONCILING", "EXPIRED",
    ]);
    expect([...ORDER_STATES]).toEqual(enumValues("order_state"));
  });

  it("attempt states: exactly the `internal.submission_state` enum", () => {
    expect([...ATTEMPT_STATES]).toEqual(enumValues("submission_state"));
  });

  it("settlement states: §9.11's five, all in `internal.trade_settlement_state`", () => {
    expect([...SETTLEMENT_STATES]).toEqual(["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"]);
    for (const state of SETTLEMENT_STATES) expect(enumValues("trade_settlement_state")).toContain(state);
  });
});

describe("transition tables", () => {
  it("every state has an explicit row, and every target is a state", () => {
    for (const state of ORDER_STATES) {
      expect(ORDER_TRANSITIONS[state], state).toBeDefined();
      for (const target of ORDER_TRANSITIONS[state]) expect(ORDER_STATES).toContain(target);
    }
    for (const state of ATTEMPT_STATES) for (const target of ATTEMPT_TRANSITIONS[state]) expect(ATTEMPT_STATES).toContain(target);
    for (const state of SETTLEMENT_STATES) for (const target of SETTLEMENT_TRANSITIONS[state]) expect(SETTLEMENT_STATES).toContain(target);
  });

  it("a terminal order reopens only to RECONCILING (contradicting evidence), never straight to a live state", () => {
    for (const state of TERMINAL_ORDER_STATES) expect(ORDER_TRANSITIONS[state]).toEqual(["RECONCILING"]);
  });

  it("SUBMISSION_UNKNOWN leads only to RECONCILING: an unknown placement is never rejected, filled or resent directly", () => {
    expect(ORDER_TRANSITIONS.SUBMISSION_UNKNOWN).toEqual(["RECONCILING"]);
    expect(ATTEMPT_TRANSITIONS.SUBMISSION_UNKNOWN).not.toContain("ABANDONED");
    expect(ATTEMPT_TRANSITIONS.SUBMISSION_UNKNOWN).not.toContain("SENDING");
  });

  it("SENDING is reached only from SIGNED (step 5) and from RECONCILING (step 9's same signed order)", () => {
    const into = ORDER_STATES.filter((state) => ORDER_TRANSITIONS[state].includes("SENDING"));
    expect(into).toEqual(["SIGNED", "RECONCILING"]);
    const attemptsInto = ATTEMPT_STATES.filter((state) => ATTEMPT_TRANSITIONS[state].includes("SENDING"));
    expect(attemptsInto).toEqual(["SIGNED", "RECONCILING"]);
  });

  it("SIGNED is reached only from PLANNED (step 4), and a resolved attempt never moves again", () => {
    expect(ORDER_STATES.filter((state) => ORDER_TRANSITIONS[state].includes("SIGNED"))).toEqual(["PLANNED"]);
    expect(ATTEMPT_TRANSITIONS.RESPONDED).toEqual([]);
    expect(ATTEMPT_TRANSITIONS.ABANDONED).toEqual([]);
  });

  it("CONFIRMED and FAILED are terminal settlement states", () => {
    expect(SETTLEMENT_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(SETTLEMENT_TRANSITIONS.FAILED).toEqual([]);
  });
});
