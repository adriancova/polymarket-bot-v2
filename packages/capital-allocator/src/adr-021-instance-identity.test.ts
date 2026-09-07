/**
 * ADR-021 — `strategyInstanceId` IS AN IDENTITY, AT THIS PACKAGE'S FOUR DOORS.
 *
 * THE DEFECT THIS FILE PINS, MEASURED AT BASE `2248711` BEFORE ANYTHING WAS
 * WRITTEN. ADR-021 (accepted 2026-09-06) ruled `strategyInstanceId` an identity
 * typed `Uuidv7Schema`, and `WP-180-FU3` executed that ruling in
 * `packages/risk`. Its review round then MEASURED a door the ADR's context had
 * missed: `packages/capital-allocator` typed the SAME value `CodeStringSchema`
 * at four sites — `reserve.ts:69` (`ReservationRequestSchema`), `state.ts:68`
 * (`PositionHoldingSchema`), `state.ts:81` (`OpenOrderCommitmentSchema`) and
 * `state.ts:92` (`LiveOwnerSchema`) — whose grammar
 * (`^[A-Za-z][A-Za-z0-9_.:-]*$`) requires a LEADING LETTER. A UUIDv7's first hex
 * digit is the top nibble of its 48-bit millisecond timestamp, and that nibble
 * is `0` for every instant before ~2527, so no honestly-minted UUIDv7 could pass
 * any of them. The ADR's 2026-09-06 amendment recorded the consequence: the
 * value passed FOUR merged doors, not three, and the risk door accepted
 * `0`-leading UUIDv7s that this package still refused.
 *
 * The transcript, measured at both ends, one row per spelling (every one of the
 * four doors answers identically, which is what the matrix test below asserts):
 *
 * ```text
 *                                        base 2248711                 tip
 *   018f4a7e-2222-7abc-8def-0123456789ab REFUSED CAPITAL_INPUT_INVALID ACCEPTED
 *   a1890000-0000-7000-8000-00000000000a ACCEPTED                      ACCEPTED
 *   sb-instance-1                        ACCEPTED                      REFUSED
 *   A1890000-0000-7000-8000-00000000000A ACCEPTED                      REFUSED
 *   a1890000-0000-4000-8000-00000000000a ACCEPTED                      REFUSED
 * ```
 *
 * Row 1 is the ruling's whole point: a WIDENING on the honest population — every
 * id `apps/trader` can mint. Rows 3-5 are its narrowing, on strings no other
 * merged door ever admitted. Row 2 is the compatibility row: the letter-leading
 * intersection shape `apps/trader`'s interim `UuidAndCodeString` grammar mints
 * today is green at BASE and at TIP, so the widening breaks no shipped
 * configuration.
 *
 * ROW 4 WAS MEASURED RATHER THAN ASSUMED, AND IT DIFFERS FROM THE RISK DOOR'S
 * ANSWER. In `packages/risk` the uppercase spelling was already refused at base
 * by the ADR-016 §2 identity pass. HERE IT WAS NOT: this package's ADR-016 pass
 * (`guards.ts` `uuidShapedNotCanonical`, applied in `nonCanonicalIdRefusals` and
 * at `reserve.ts`'s `reservationId` check) covers `reservationId`, `positionId`
 * and `orderId` — the three `NonEmptyString` ids with no format schema — and has
 * never covered `strategyInstanceId`. `CodeStringSchema` accepted
 * `A1890000-…` quite happily (it leads with a letter and hyphens are in its
 * alphabet), so a re-cased instance id reached the commitment tables verbatim at
 * base. At the tip the SCHEMA refuses it, one layer before any guard runs. The
 * guard's own territory is UNCHANGED, which the last test pins directly.
 *
 * THE SCOPE KEYS STAY `CodeStringSchema`. `state.ts:58-60`
 * (`seriesKey`/`underlyingKey`/`resolutionWindowKey`) are machine VOCABULARY —
 * exactly what `CodeStringSchema` documents itself for — not minted identities.
 * The last describe pins that they were not swept along.
 */

import { describe, expect, it } from "vitest";

import { parseAllocatorCaps, type AllocatorCaps } from "./caps.js";
import { evaluateReservation } from "./reserve.js";
import { createAllocatorState } from "./state.js";

const MARKET = "01890000-0000-7000-8000-000000000001";

/** A UUIDv7 minted from a real millisecond timestamp: the leading nibble is `0`. */
const MINTED_UUIDV7 = "018f4a7e-2222-7abc-8def-0123456789ab";
/** The shape `apps/trader`'s interim `UuidAndCodeString` door mints. */
const LETTER_LEADING_UUIDV7 = "a1890000-0000-7000-8000-00000000000a";
/** What the previous typing was FOR, and what it now refuses. */
const CODE_STRING = "sb-instance-1";
/** ADR-016 §2: a UUID arrives canonical lowercase or it is refused. */
const UPPERCASE_UUIDV7 = "A1890000-0000-7000-8000-00000000000A";
/** UUID-shaped and lowercase, but version 4 — not the identity this field is. */
const UUID_V4 = "a1890000-0000-4000-8000-00000000000a";

const SPELLINGS = [
  MINTED_UUIDV7,
  LETTER_LEADING_UUIDV7,
  CODE_STRING,
  UPPERCASE_UUIDV7,
  UUID_V4,
] as const;

function allocatorCaps(): AllocatorCaps {
  const parsed = parseAllocatorCaps({ globalAccountCap: "1000", perStrategyCap: "1000" });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value;
}

/** `ACCEPTED`, or `REFUSED` with the refusal codes, for a `CapitalResult`. */
function answerOf(result: {
  readonly ok: boolean;
  readonly refusals?: readonly { readonly code: string }[];
}): string {
  if (result.ok) return "ACCEPTED";
  const codes = result.refusals ?? [];
  return `REFUSED ${codes.map((refusal) => refusal.code).join(",")}`;
}

/**
 * DOOR 1 — `ReservationRequestSchema` (`reserve.ts:69`).
 *
 * SHADOW accounting, on a state with no live owners: the live-ownership gate,
 * the collateral check and the inventory check are all skipped, so the ONLY
 * thing that can answer here is the request schema. Isolation is the point —
 * a refusal from this door names the field being measured and nothing else.
 */
function reservationDoor(instanceId: string): string {
  const built = createAllocatorState({
    accountEquity: "1000",
    availableCollateral: "1000",
    positions: [],
    openOrders: [],
    liveOwners: [],
  });
  if (!built.ok) throw new Error(JSON.stringify(built.refusals));
  const verdict = evaluateReservation(built.value, allocatorCaps(), {
    reservationId: "res-1",
    strategyInstanceId: instanceId,
    runMode: "PAPER",
    accountingMode: "SHADOW",
    marketId: MARKET,
    side: "YES",
    action: "BUY",
    price: "0.5",
    shares: "10",
  });
  if (verdict.permitted) return "ACCEPTED";
  return `REFUSED ${verdict.refusals.map((refusal) => refusal.code).join(",")}`;
}

/** DOOR 2 — `PositionHoldingSchema` (`state.ts:68`). */
function positionDoor(instanceId: string): string {
  return answerOf(
    createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "pos-1",
          marketId: MARKET,
          strategyInstanceId: instanceId,
          side: "YES",
          shares: "100",
          costBasis: "40",
        },
      ],
      openOrders: [],
      liveOwners: [],
    }),
  );
}

/** DOOR 3 — `OpenOrderCommitmentSchema` (`state.ts:81`). BUY: no oversell check. */
function openOrderDoor(instanceId: string): string {
  return answerOf(
    createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [
        {
          orderId: "ord-1",
          marketId: MARKET,
          strategyInstanceId: instanceId,
          side: "YES",
          action: "BUY",
          price: "0.3",
          shares: "200",
        },
      ],
      liveOwners: [],
    }),
  );
}

/** DOOR 4 — `LiveOwnerSchema` (`state.ts:92`). */
function liveOwnerDoor(instanceId: string): string {
  return answerOf(
    createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: instanceId }],
    }),
  );
}

/** The four sites ADR-021's 2026-09-06 amendment enumerates, and only those. */
const DOORS = [
  { name: "reservation", ask: reservationDoor },
  { name: "position", ask: positionDoor },
  { name: "openOrder", ask: openOrderDoor },
  { name: "liveOwner", ask: liveOwnerDoor },
] as const;

/** Every door × every spelling, rendered so a failure IS the transcript. */
function transcript(): readonly string[] {
  const rows: string[] = [];
  for (const door of DOORS) {
    for (const spelling of SPELLINGS) {
      rows.push(`${door.name} ${spelling} -> ${door.ask(spelling)}`);
    }
  }
  return rows;
}

const REFUSED = "REFUSED CAPITAL_INPUT_INVALID";

describe("ADR-021: all four allocator doors admit minted UUIDv7s, and only UUIDv7s", () => {
  it("ACCEPTS a minted, `0`-LEADING UUIDv7 at every one of the four doors", () => {
    // The population the old typing refused — the ruling's whole point.
    for (const door of DOORS) {
      expect(door.ask(MINTED_UUIDV7), door.name).toBe("ACCEPTED");
    }
  });

  it("still accepts the letter-leading UUIDv7 the trader mints today, at every door", () => {
    // The compatibility half: `apps/trader`'s shipped `UuidAndCodeString` values
    // must not become refusals in the round that widens the door. Green at BASE
    // as well as at the tip.
    for (const door of DOORS) {
      expect(door.ask(LETTER_LEADING_UUIDV7), door.name).toBe("ACCEPTED");
    }
  });

  it("REFUSES a non-UUID code string at every door", () => {
    for (const door of DOORS) {
      expect(door.ask(CODE_STRING), door.name).toBe(REFUSED);
    }
  });

  it("REFUSES an uppercase spelling at every door — canonical lowercase, never a case-fold", () => {
    for (const door of DOORS) {
      expect(door.ask(UPPERCASE_UUIDV7), door.name).toBe(REFUSED);
    }
  });

  it("REFUSES a lowercase canonical UUID that is not version 7, at every door", () => {
    // `Uuidv7Schema`, not `UuidSchema`: the version nibble is part of the
    // identity contract `packages/ledger` and `packages/pnl` already enforce on
    // the same value one layer down.
    for (const door of DOORS) {
      expect(door.ask(UUID_V4), door.name).toBe(REFUSED);
    }
  });

  it("THE TRANSCRIPT: twenty measured answers, four doors by five spellings", () => {
    expect(transcript()).toEqual([
      `reservation ${MINTED_UUIDV7} -> ACCEPTED`,
      `reservation ${LETTER_LEADING_UUIDV7} -> ACCEPTED`,
      `reservation ${CODE_STRING} -> ${REFUSED}`,
      `reservation ${UPPERCASE_UUIDV7} -> ${REFUSED}`,
      `reservation ${UUID_V4} -> ${REFUSED}`,
      `position ${MINTED_UUIDV7} -> ACCEPTED`,
      `position ${LETTER_LEADING_UUIDV7} -> ACCEPTED`,
      `position ${CODE_STRING} -> ${REFUSED}`,
      `position ${UPPERCASE_UUIDV7} -> ${REFUSED}`,
      `position ${UUID_V4} -> ${REFUSED}`,
      `openOrder ${MINTED_UUIDV7} -> ACCEPTED`,
      `openOrder ${LETTER_LEADING_UUIDV7} -> ACCEPTED`,
      `openOrder ${CODE_STRING} -> ${REFUSED}`,
      `openOrder ${UPPERCASE_UUIDV7} -> ${REFUSED}`,
      `openOrder ${UUID_V4} -> ${REFUSED}`,
      `liveOwner ${MINTED_UUIDV7} -> ACCEPTED`,
      `liveOwner ${LETTER_LEADING_UUIDV7} -> ACCEPTED`,
      `liveOwner ${CODE_STRING} -> ${REFUSED}`,
      `liveOwner ${UPPERCASE_UUIDV7} -> ${REFUSED}`,
      `liveOwner ${UUID_V4} -> ${REFUSED}`,
    ]);
  });
});

describe("ADR-021: the refusal EVIDENCE names the field and the new grammar", () => {
  it("the state door reports the failing path and the UUIDv7 message", () => {
    const refused = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: CODE_STRING }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The evidence SHAPE is unchanged by this round: `CAPITAL_INPUT_INVALID`
    // carrying `details.issues` as `"<path>: <message>"`, exactly as every other
    // schema refusal from this door already did. Only the message text moved,
    // from `must be an alphanumeric code without whitespace` to the line below.
    expect(JSON.stringify(refused.refusals)).toContain(
      "liveOwners.0.strategyInstanceId: must be a lowercase canonical UUIDv7",
    );
  });

  it("REFUSE, NEVER FOLD: no lowercased form of an uppercase id appears in the answer", () => {
    // ADR-016 §2. The schema now refuses the uppercase spelling one layer before
    // `uuidShapedNotCanonical` would have seen it, and the answer must still not
    // contain a normalized form of the caller's value.
    const refused = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: UPPERCASE_UUIDV7 }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(JSON.stringify(refused.refusals)).not.toContain(UPPERCASE_UUIDV7.toLowerCase());
  });
});

describe("the scope keys are VOCABULARY, and this round did not sweep them along", () => {
  it("accepts a code-shaped scope attribution beside a minted instance id", () => {
    const built = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "pos-1",
          marketId: MARKET,
          strategyInstanceId: MINTED_UUIDV7,
          side: "YES",
          shares: "100",
          costBasis: "40",
          scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
        },
      ],
      openOrders: [],
      liveOwners: [],
    });
    expect(answerOf(built)).toBe("ACCEPTED");
  });

  it("still applies the CODE grammar to a scope key — a `0`-leading value is refused", () => {
    // `CodeStringSchema` at `state.ts:58-60` is untouched, so the leading-letter
    // rule that this round removed from the IDENTITY still governs the
    // VOCABULARY. If a future round swept the scope keys along, this passes and
    // the assertion below is what says so.
    const refused = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "pos-1",
          marketId: MARKET,
          strategyInstanceId: MINTED_UUIDV7,
          side: "YES",
          shares: "100",
          costBasis: "40",
          scope: { seriesKey: MINTED_UUIDV7 },
        },
      ],
      openOrders: [],
      liveOwners: [],
    });
    expect(answerOf(refused)).toBe(REFUSED);
    expect(JSON.stringify(refused.ok ? [] : refused.refusals)).toContain(
      "must be an alphanumeric code without whitespace",
    );
  });
});

describe("the ADR-016 §2 identity pass keeps exactly the territory it had", () => {
  /**
   * `uuidShapedNotCanonical` governs the three `NonEmptyString` ids that carry
   * no format schema — `reservationId`, `positionId`, `orderId`. It never
   * covered `strategyInstanceId`, and this round did not give it that field:
   * the SCHEMA does. Both rows below are green at base AND at the tip, on the
   * letter-leading instance id both grammars accept, so they measure the guard
   * rather than the re-typing.
   */
  it("an uppercase `reservationId` is still CAPITAL_UUID_NOT_CANONICAL", () => {
    const built = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [],
    });
    if (!built.ok) throw new Error(JSON.stringify(built.refusals));
    const verdict = evaluateReservation(built.value, allocatorCaps(), {
      reservationId: UPPERCASE_UUIDV7,
      strategyInstanceId: LETTER_LEADING_UUIDV7,
      runMode: "PAPER",
      accountingMode: "SHADOW",
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.refusals.map((refusal) => refusal.code)).toEqual([
      "CAPITAL_UUID_NOT_CANONICAL",
    ]);
  });

  it("an uppercase `positionId` is still CAPITAL_UUID_NOT_CANONICAL", () => {
    const refused = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: UPPERCASE_UUIDV7,
          marketId: MARKET,
          strategyInstanceId: LETTER_LEADING_UUIDV7,
          side: "YES",
          shares: "100",
          costBasis: "40",
        },
      ],
      openOrders: [],
      liveOwners: [],
    });
    expect(answerOf(refused)).toBe("REFUSED CAPITAL_UUID_NOT_CANONICAL");
  });
});
