/**
 * Allocator caps — handoff §9.7.
 *
 * "Initial defaults should reflect user-defined caps rather than hardcoded
 * historical examples. The allocator must support a global account cap,
 * per-strategy cap, and live-micro cap." (§9.7)
 *
 * Consequences implemented here:
 *
 * - `globalAccountCap` and `perStrategyCap` are REQUIRED with no default —
 *   this package invents no example number for a user-defined cap.
 * - The live-micro caps are FENCED AT EXACTLY `"0"`. See "THE LIVE-MICRO
 *   FENCE" below.
 * - The per-scope caps (market, series, underlying, resolution window — the
 *   §9.7 commitment list) are optional; a configured scope cap combined with
 *   an unattributable request FAILS CLOSED (`CAPITAL_SCOPE_KEY_MISSING`).
 *
 * THE LIVE-MICRO FENCE (review round 1, HIGH). `AGENTS.md` declares
 * `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
 * NON-WEAKENABLE defaults. Defaulting them to `"0"` while accepting any
 * caller-supplied value is not enough: it makes this package a weakening
 * vector, because a caller argument could raise a floor it has no authority
 * over. So a live-micro cap other than the exact canonical `"0"` is REFUSED
 * outright (`CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED`) — at the schema, at
 * {@link parseAllocatorCaps}, and again at the reservation gate in
 * `reserve.ts`, so a hand-built caps object cannot slip past either.
 *
 * Enabling live-micro capacity is therefore a SEPARATE, EXPLICITLY AUTHORIZED,
 * FENCED later-phase work package with its own human approval — never an
 * argument to this one. Until such a package exists and owns the authority,
 * this package grants no real-order capacity at all.
 */

import { z } from "zod";

import { NonNegativeMoneyStringSchema } from "@polymarket-bot/domain";

import { withSchemaDefaults, type SchemaDefault } from "./plain-data.js";
import {
  capitalFailure,
  capitalOk,
  capitalRefusal,
  contained,
  readInputAsData,
  type CapitalRefusal,
  type CapitalResult,
} from "./refusals.js";

/**
 * The one permitted live-micro cap value: the exact canonical `AGENTS.md`
 * floor. Compared by exact spelling rather than numerically, so a
 * non-canonical or unparseable value refuses too (fail closed, and total — the
 * comparison cannot throw on a hand-built object).
 */
export const LIVE_MICRO_CAP_FLOOR = "0";

/** The two fenced fields. */
export const LIVE_MICRO_CAP_FIELDS = [
  "liveMicroMaxOrderNotional",
  "liveMicroMaxAccountExposure",
] as const;
export type LiveMicroCapField = (typeof LIVE_MICRO_CAP_FIELDS)[number];

const LIVE_MICRO_FENCE_MESSAGE =
  "a live-micro cap other than the exact \"0\" floor is not permitted; AGENTS.md declares LIVE_MICRO_MAX_ORDER_NOTIONAL=0 and LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0 non-weakenable, and enabling live-micro capacity is a separate authorized work package, not a caller argument";

/**
 * What the fence could establish about one field. See {@link readCapField}.
 *
 * `atFloor` is the only permissive answer, and it is granted for exactly two
 * readings: an OWN DATA property spelled exactly `"0"`, and a name that is not
 * reachable on the object at all (absent — the schema default supplies the
 * floor). Everything else, including everything unreadable, is `false`.
 */
interface CapFieldReading {
  readonly atFloor: boolean;
  /** The own data value, when there is one; otherwise `undefined`. */
  readonly supplied: unknown;
  /** Present when the value could not be read as data, saying why. */
  readonly notData: string | undefined;
}

const AT_FLOOR: CapFieldReading = { atFloor: true, supplied: undefined, notData: undefined };

function notAtFloor(notData: string): CapFieldReading {
  return { atFloor: false, supplied: undefined, notData };
}

/**
 * Whether `field` is reachable anywhere on `caps`'s prototype chain.
 *
 * Own descriptors, never `in`: `in` runs a `Proxy`'s `has` trap, and this
 * function is part of a fence that must be total. Any failure answers TRUE —
 * "it might be there" is the fail-closed direction, because the ENFORCEMENT
 * site (`reserve.ts`) reads `caps.liveMicroMaxOrderNotional` with a dotted read,
 * which WOULD find an inherited value.
 */
function reachableThroughPrototype(caps: object, field: string): boolean {
  let current: object | null = caps;
  for (let depth = 0; depth < 64 && current !== null; depth += 1) {
    try {
      if (Object.getOwnPropertyDescriptor(current, field) !== undefined) return true;
    } catch {
      return true;
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return true;
    }
  }
  return current !== null;
}

/**
 * Reads one fenced field WITHOUT running caller code, and TOTALLY.
 *
 * Review round 6, BLOCKERs 1 and 3, at one site:
 *
 * - `caps[field]` was a `Get`, so a `Proxy` handler ran and
 *   `nonFloorLiveMicroCapFields(proxy)` THREW out of a public export;
 * - a dotted `Get` also walks the prototype chain, so an INHERITED
 *   `liveMicroMaxOrderNotional` read as "absent, therefore fine" HERE while the
 *   enforcement site in `reserve.ts` read the very same inherited value as the
 *   cap. That is a weakening of an `AGENTS.md` non-weakenable floor by prototype
 *   augmentation alone, and it is why "absent" now means UNREACHABLE rather than
 *   `undefined`.
 */
function readCapField(caps: unknown, field: LiveMicroCapField): CapFieldReading {
  if (caps === null || typeof caps !== "object") {
    return notAtFloor("the caps value is not an object, so no floor can be established");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(caps, field);
  } catch {
    return notAtFloor("its property descriptor could not be read");
  }
  if (descriptor === undefined) {
    return reachableThroughPrototype(caps, field)
      ? notAtFloor("an INHERITED value, which the enforcement site would read as the cap")
      : AT_FLOOR;
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return notAtFloor("an accessor property: a getter is code, not a cap");
  }
  const value: unknown = descriptor.value;
  if (value === LIVE_MICRO_CAP_FLOOR) return AT_FLOOR;
  return { atFloor: false, supplied: value, notData: undefined };
}

/**
 * The fenced fields that could NOT be shown to sit at the exact floor.
 *
 * TOTAL for any value, including a `Proxy` and a hostile descriptor (review
 * round 6, BLOCKER 3): whatever cannot be read is reported as non-floor, so the
 * fence's failure direction is REFUSAL.
 */
export function nonFloorLiveMicroCapFields(
  caps: Partial<Record<LiveMicroCapField, unknown>>,
): readonly LiveMicroCapField[] {
  return LIVE_MICRO_CAP_FIELDS.filter((field) => !readCapField(caps, field).atFloor);
}

/**
 * Typed refusals for every fenced field that is not at the floor.
 *
 * Exported so the reservation gate can apply the same fence to a caps object
 * that never went through {@link parseAllocatorCaps}. Total for the same reason
 * {@link nonFloorLiveMicroCapFields} is.
 */
export function liveMicroCapRefusals(
  caps: Partial<Record<LiveMicroCapField, unknown>>,
): readonly CapitalRefusal[] {
  const refusals: CapitalRefusal[] = [];
  for (const field of LIVE_MICRO_CAP_FIELDS) {
    const reading = readCapField(caps, field);
    if (reading.atFloor) continue;
    refusals.push(
      capitalRefusal(
        "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
        LIVE_MICRO_FENCE_MESSAGE,
        reading.notData === undefined
          ? { field, supplied: reading.supplied, permitted: LIVE_MICRO_CAP_FLOOR }
          : { field, suppliedNotData: reading.notData, permitted: LIVE_MICRO_CAP_FLOOR },
      ),
    );
  }
  return refusals;
}

/**
 * Grammar only. Internal: {@link AllocatorCapsSchema} adds the live-micro
 * fence on top, and {@link parseAllocatorCaps} applies the fence separately so
 * it can report the specific typed code rather than a generic schema failure.
 */
const AllocatorCapsShapeSchema = z.strictObject({
  /** Required, user-defined (§9.7). Committed exposure across the account. */
  globalAccountCap: NonNegativeMoneyStringSchema,
  /** Required, user-defined (§9.7). Committed exposure per strategy instance. */
  perStrategyCap: NonNegativeMoneyStringSchema,

  perMarketCap: NonNegativeMoneyStringSchema.optional(),
  perSeriesCap: NonNegativeMoneyStringSchema.optional(),
  perUnderlyingCap: NonNegativeMoneyStringSchema.optional(),
  perResolutionWindowCap: NonNegativeMoneyStringSchema.optional(),

  /**
   * FENCED at the exact decimal `"0"` (`AGENTS.md` non-weakenable safety
   * defaults). The default supplies the floor when the caller says nothing;
   * any other supplied value is REFUSED, not accepted. See the module header.
   */
  liveMicroMaxOrderNotional: NonNegativeMoneyStringSchema.default(LIVE_MICRO_CAP_FLOOR),
  liveMicroMaxAccountExposure: NonNegativeMoneyStringSchema.default(LIVE_MICRO_CAP_FLOOR),
});

/**
 * The caller-facing caps schema: grammar PLUS the live-micro fence, so a
 * caller who parses directly instead of calling {@link parseAllocatorCaps}
 * still cannot construct caps that weaken the `AGENTS.md` floors.
 */
export const AllocatorCapsSchema = AllocatorCapsShapeSchema.superRefine((caps, ctx) => {
  for (const field of nonFloorLiveMicroCapFields(caps)) {
    ctx.addIssue({ code: "custom", path: [field], message: LIVE_MICRO_FENCE_MESSAGE });
  }
});

export type AllocatorCaps = z.infer<typeof AllocatorCapsSchema>;

/**
 * EVERY value this schema supplies when the caller omits the field — and both
 * of them are `AGENTS.md` safety floors.
 *
 * WHY A TABLE AND NOT THE PARSE OUTPUT (review round 7). `zod` assembles its
 * output by assignment, and with a get-only `Object.prototype
 * .liveMicroMaxOrderNotional` the assignment of its OWN default fails: the key
 * is not own in the output, and reading it walks the chain to the attacker's
 * value. Round 6 caught that as a missing field and refused (the check below is
 * still there); round 7 removes the exposure — the floor now comes from this
 * table, which `test/unit/risk/schema-output.test.ts` binds to the schema's
 * `.default()` values and to {@link LIVE_MICRO_CAP_FIELDS}, so a fenced field
 * cannot be defaulted to anything but the floor and cannot be dropped from
 * either list without failing.
 */
export const ALLOCATOR_CAPS_DEFAULTS: readonly SchemaDefault[] = Object.freeze(
  LIVE_MICRO_CAP_FIELDS.map((field) => ({
    path: Object.freeze([field]),
    value: LIVE_MICRO_CAP_FLOOR,
  })),
);

/**
 * Validates caller-supplied caps; refuses rather than repairing.
 *
 * The grammar is checked first so a malformed decimal reports
 * `CAPITAL_INPUT_INVALID`, then the live-micro fence is applied separately so
 * a raised safety floor reports its own `CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED`
 * rather than hiding inside a generic schema failure.
 *
 * READ AS DATA BEFORE IT IS PARSED (review round 5, BLOCKER 3). This was the
 * reported site: a valid-SHAPED object whose `globalAccountCap` was a throwing
 * getter made this function THROW instead of refusing, because `zod` reads the
 * property. THE FENCE ORDER IS UNCHANGED, and deliberately so — the read is a
 * well-formedness check that runs before the grammar, and the live-micro fence
 * still runs after the grammar and still reports its own code.
 */
export function parseAllocatorCaps(input: unknown): CapitalResult<AllocatorCaps> {
  return contained(
    () => {
      const read = readInputAsData(input, "caps", "allocator caps");
      if (!read.ok) return capitalFailure<AllocatorCaps>(read.refusal);
      const parsed = AllocatorCapsShapeSchema.safeParse(read.value);
      if (!parsed.success) {
        return capitalFailure<AllocatorCaps>(
          capitalRefusal("CAPITAL_INPUT_INVALID", "allocator caps failed validation", {
            issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          }),
        );
      }
      // THE VALIDATED CAPS ARE THE MATERIALIZED TREE (review round 7). `zod`
      // answered the QUESTION; its output object is not read. That closes both
      // round-6 findings at once: an ABSENT OPTIONAL CAP (`perMarketCap`, …)
      // stays absent because `read.value` has no prototype, and a cap the caller
      // DID configure can no longer vanish in an output assembly that an
      // inherited get-only accessor defeats. THE FENCE ORDER IS UNCHANGED:
      // grammar, then the schema's own defaults, then the live-micro fence with
      // its own code.
      //
      // The two fenced fields are the reason this door needs a default table at
      // all: their floor is the schema's `.default()`, not the caller's, and
      // taking it from `zod`'s output is exactly what proposition 5 in
      // `plain-data.ts` forbids — measured, that output can lack the key and
      // answer the later read from `Object.prototype` instead.
      const defaulted = withSchemaDefaults(read.value, ALLOCATOR_CAPS_DEFAULTS);
      if (!defaulted.ok) {
        return capitalFailure<AllocatorCaps>(
          capitalRefusal(
            "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
            LIVE_MICRO_FENCE_MESSAGE,
            { unfilled: [...defaulted.unfilled], permitted: LIVE_MICRO_CAP_FLOOR },
          ),
        );
      }
      const data = defaulted.value as AllocatorCaps;
      // THE FENCED FIELDS MUST BE PRESENT (review round 6, kept as the second of
      // the three fence layers). `withSchemaDefaults` above now guarantees it
      // from a table this package declares rather than from the library's
      // output, so this is defence in depth — and it stays, because "the caps
      // this function blesses carry no live-micro floor at all" is the one
      // outcome the `AGENTS.md` floors may never have.
      const missing = LIVE_MICRO_CAP_FIELDS.filter((field) => !Object.hasOwn(data, field));
      if (missing.length > 0) {
        return capitalFailure<AllocatorCaps>(
          capitalRefusal(
            "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
            LIVE_MICRO_FENCE_MESSAGE,
            { missingAfterValidation: [...missing], permitted: LIVE_MICRO_CAP_FLOOR },
          ),
        );
      }
      const fence = liveMicroCapRefusals(data);
      if (fence.length > 0) {
        return capitalFailure<AllocatorCaps>(...fence);
      }
      return capitalOk(Object.freeze(data));
    },
    (thrown) =>
      capitalFailure(
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "validating the allocator caps failed unexpectedly; caps that cannot be validated cannot be shown to respect the AGENTS.md live-micro floors (fail closed)",
          { thrown },
        ),
      ),
  );
}
