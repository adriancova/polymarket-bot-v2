/**
 * ADR-021 — `strategyInstanceId` IS AN IDENTITY (`WP-180-FU3`).
 *
 * THE DEFECT THIS FILE PINS, MEASURED AT BASE `88e3a5b` BEFORE ANYTHING WAS
 * WRITTEN. `packages/risk` typed `context.strategyInstanceId` as
 * `CodeStringSchema`, whose grammar is `^[A-Za-z][A-Za-z0-9_.:-]*$` — a LEADING
 * LETTER. A UUIDv7's first hex digit is the top nibble of its 48-bit
 * millisecond timestamp, and that nibble is `0` for every instant before ~2527.
 * So no honestly-minted UUIDv7 could pass this door, while `packages/ledger`'s
 * `AllocationClaim.instanceId` and `packages/pnl`'s `PnlOwner.instanceId` — the
 * same value, one layer down — required exactly one. Transcript, taken through
 * `validateEvaluationInput` on the fully-passing entry fixture:
 *
 * ```text
 *                                        base 88e3a5b                 tip
 *   018f4a7e-2222-7abc-8def-0123456789ab REFUSED RISK_INPUT_INVALID   ACCEPTED
 *   a1890000-0000-7000-8000-00000000000a ACCEPTED                     ACCEPTED
 *   sb-instance-1                        ACCEPTED                     REFUSED
 *   A1890000-0000-7000-8000-00000000000A REFUSED RISK_UUID_NOT_CANON… REFUSED
 *   a1890000-0000-4000-8000-00000000000a ACCEPTED                     REFUSED
 * ```
 *
 * Row 1 is the ruling's whole point (a widening on the honest population); rows
 * 3 and 5 are its narrowing, on strings no other door ever admitted. Row 4 was
 * MEASURED rather than assumed and corrected a first draft of this comment: at
 * base the uppercase spelling was refused by the ADR-016 §2 IDENTITY pass, not
 * by the code grammar — `CodeStringSchema` accepts `A1890000-…` quite happily,
 * because it leads with a letter and hyphens are in its alphabet. At the tip
 * the SCHEMA refuses it one layer earlier, so the code moves from
 * `RISK_UUID_NOT_CANONICAL` to `RISK_INPUT_INVALID` (the ordering is pinned in
 * `engine.test.ts`'s ADR-016 §2 block, which this round split by layer).
 *
 * WHY THE ARENA MATTERS HERE. `Uuidv7Schema` carries its format as a zod CHECK,
 * and a check is exactly what an inherited `skipChecks` on the parse context
 * turns off (`schema-arena.ts`'s header; the round-8 fail-open where a market
 * id of `"not-a-uuid"` VALIDATED). The door parses through the warmed arena
 * copy, so the new format survives that pollution — asserted below, with the
 * raw schema's failure under the same pollution as the non-vacuity half.
 */
import { describe, expect, it } from "vitest";

import { evaluateIntent, validateEvaluationInput } from "../../../packages/risk/src/index.js";
import { RiskEvaluationInputSchema } from "../../../packages/risk/src/inputs.js";
import { readPlainData } from "../../../packages/risk/src/plain-data.js";
import { INSTANCE, codesOf, entryInput, riskPolicy } from "./fixtures.js";

/** A UUIDv7 minted from a real millisecond timestamp: the leading nibble is `0`. */
const MINTED_UUIDV7 = "018f4a7e-2222-7abc-8def-0123456789ab";
/** The shape `apps/trader`'s interim `UuidAndCodeString` door mints. */
const LETTER_LEADING_UUIDV7 = INSTANCE;
/** What the previous typing was FOR, and what it now refuses. */
const CODE_STRING = "sb-instance-1";
/** ADR-016 §2: a UUID arrives canonical lowercase or it is refused. */
const UPPERCASE_UUIDV7 = "A1890000-0000-7000-8000-00000000000A";
/** UUID-shaped and lowercase, but version 4 — not the identity this field is. */
const UUID_V4 = "a1890000-0000-4000-8000-00000000000a";

function doorAnswer(instanceId: string): string {
  const input = entryInput();
  input.context.strategyInstanceId = instanceId;
  const validation = validateEvaluationInput(input);
  if (validation.ok) return "ACCEPTED";
  return `REFUSED ${validation.refusals.map((refusal) => refusal.code).join(",")}`;
}

/** Installs one inherited data property for the duration of `body`. */
function withData<T>(name: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
  try {
    return body();
  } finally {
    delete (Object.prototype as Record<string, unknown>)[name];
  }
}

interface Parseable {
  safeParse: (value: unknown) => { success: boolean };
}

/** The materialized tree the door hands the schema — the raw schema's fair input. */
function materialized(value: unknown): unknown {
  const read = readPlainData(value, "input");
  if (!read.ok) throw new Error(`fixture is not plain data: ${JSON.stringify(read.problems)}`);
  return read.value;
}

describe("ADR-021: the door admits minted UUIDv7s and refuses code strings", () => {
  it("ACCEPTS a minted, `0`-LEADING UUIDv7 — the population the old typing refused", () => {
    expect(doorAnswer(MINTED_UUIDV7)).toBe("ACCEPTED");
  });

  it("still accepts the letter-leading UUIDv7 the trader mints today", () => {
    // The compatibility half of the ruling: `apps/trader`'s shipped
    // `UuidAndCodeString` values must not become refusals in the round that
    // widens the door. (`apps/trader`'s own suites are the other half.)
    expect(doorAnswer(LETTER_LEADING_UUIDV7)).toBe("ACCEPTED");
  });

  it("REFUSES a non-UUID code string, naming the field", () => {
    const input = entryInput();
    input.context.strategyInstanceId = CODE_STRING;
    const validation = validateEvaluationInput(input);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.refusals.map((refusal) => refusal.code)).toEqual(["RISK_INPUT_INVALID"]);
    const issues = (validation.refusals[0]?.details["issues"] ?? []) as readonly string[];
    expect(issues.join(" | ")).toContain(
      "context.strategyInstanceId: must be a lowercase canonical UUIDv7",
    );
  });

  it("REFUSES an uppercase spelling — canonical lowercase, never a case-fold", () => {
    expect(doorAnswer(UPPERCASE_UUIDV7)).toBe("REFUSED RISK_INPUT_INVALID");
    // Refuse-not-fold (ADR-016 §2): no lowercased form of the raw value is
    // produced anywhere in the answer.
    const input = entryInput();
    input.context.strategyInstanceId = UPPERCASE_UUIDV7;
    const rendered = JSON.stringify(validateEvaluationInput(input));
    expect(rendered).not.toContain(UPPERCASE_UUIDV7.toLowerCase());
  });

  it("REFUSES a lowercase canonical UUID that is not version 7", () => {
    // `Uuidv7Schema`, not `UuidSchema`: the version nibble is part of the
    // identity contract the ledger and pnl doors already enforce.
    expect(doorAnswer(UUID_V4)).toBe("REFUSED RISK_INPUT_INVALID");
  });

  it("the whole engine agrees, and copies the minted id into the record VERBATIM", () => {
    const input = entryInput();
    input.context.strategyInstanceId = MINTED_UUIDV7;
    const result = evaluateIntent(riskPolicy(), input);
    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.strategyInstanceId).toBe(MINTED_UUIDV7);
  });
});

describe("ADR-021: the new format is a CHECK, so it goes through the arena", () => {
  it("the refusal survives an inherited `skipChecks`", () => {
    expect(withData("skipChecks", true, () => doorAnswer(CODE_STRING))).toBe(
      "REFUSED RISK_INPUT_INVALID",
    );
    expect(withData("skipChecks", true, () => doorAnswer(UPPERCASE_UUIDV7))).toBe(
      "REFUSED RISK_INPUT_INVALID",
    );
    // …and the acceptance is not collateral damage of the pollution either.
    expect(withData("skipChecks", true, () => doorAnswer(MINTED_UUIDV7))).toBe("ACCEPTED");
  });

  it("NON-VACUITY: the RAW schema IS fooled by the same pollution", () => {
    // The measurement that makes the assertion above about the ARENA rather
    // than about zod: the public, un-copied schema — the one a caller could
    // reach for — accepts the code string under an inherited `skipChecks`.
    const input = entryInput();
    input.context.strategyInstanceId = CODE_STRING;
    const tree = materialized(input);
    const raw = RiskEvaluationInputSchema as unknown as Parseable;
    expect(raw.safeParse(tree).success).toBe(false);
    expect(withData("skipChecks", true, () => raw.safeParse(tree).success)).toBe(true);
  });
});
