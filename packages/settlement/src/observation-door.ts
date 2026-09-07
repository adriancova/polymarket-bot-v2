/**
 * THE OBSERVATION DOOR: read a caller-supplied settlement observation into plain
 * OWN data, judge which reading it actually is, and settle from the read tree.
 *
 * ## Why this module exists
 *
 * `./spec-door.ts` closed the SPEC side of `docs/contracts/schema-boundary.md`
 * §3 (probe N). The layer below it was left open and is closed here. SETL-1's
 * review recorded it as claim 7, twice verified: `evaluateSettlement` dot-reads
 * `observation.model`, `observation.referenceSymbol` and every value it settles
 * on, `selectPayoffModel` → `checkPayoffModelCompatibility` destructures a
 * caller-supplied view, and `SettlementObservationSchema` had no door at all.
 *
 * MEASURED AT BASE `c2c0733`, end to end through `evaluateSettlement`, both
 * pollution variants (non-enumerable AND enumerable), 39 declared-key cells over
 * the four observation variants and five (spec, observation) pairings:
 *
 * - **All 36 present-key cells adopt.** Delete any declared key from an honest
 *   observation, let `Object.prototype` supply it, and the settlement completes
 *   with the SAME verdict the honest reading produced. No `strictObject` and no
 *   discriminated union ever ran: this path never parsed the observation at all.
 * - **The headline is a wrong VALUE on a payout surface.** A terminal-spot
 *   observation carrying NO `strike` of its own, under an inherited
 *   `strike: "0"`, settled `YES_WIN` — `comparison.right: "0"` — against a
 *   strike the reading never carried, with `payoutPerShare {yes:"1", no:"0"}`
 *   attached. An inherited `observedValue` moves the settled NUMBER the same
 *   way; an inherited `comparison` on the SPEC side flipped the same market to
 *   `NO_WIN`.
 * - **Both mismatch gates were answerable by the chain.** An observation of
 *   `eth.usd` whose own `referenceSymbol` was deleted settled a `btc.usd` spec
 *   (`SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH` bypassed), and a reading with no
 *   window at all settled a TWAP-settled up/down series under three inherited
 *   window fields.
 * - **The three optional cells fail the other way.** An inherited
 *   `windowSeconds`/`windowStartAt`/`windowEndAt` turned an HONEST up/down
 *   reading on a `TERMINAL_SPOT`-settled spec into
 *   `SETTLEMENT_OBSERVATION_WINDOW_MISMATCH`: the same class refusing a document
 *   the contract accepts.
 * - **A getter settled one number and reported another.** Each value is read
 *   TWICE on this path — once for the comparison, once for the audit record — so
 *   an accessor returning `"64000.25"` then `"1"` settled `YES_WIN` on the first
 *   read and recorded `comparison.left: "1"`. The stored evidence disagreed with
 *   the number that decided the payout.
 * - **A public function threw instead of refusing.** The compatibility matrix is
 *   an ordinary object literal, so `COMPATIBILITY[model][observationType]`
 *   answered `Object.prototype` for a non-declared observation type:
 *   `isCompatiblePayoffModel("toString", …)` returned `true`,
 *   `payoffModelRequirements` returned a FUNCTION, and
 *   `checkPayoffModelCompatibility` threw `TypeError: requirements.required is
 *   not iterable` — reachable with no cast at all, from one inherited
 *   `observationType`.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before judging.** {@link readOwnObservation}
 *   REUSES `./spec-door.ts`'s `readOwnSpec` verbatim (no near-parallel copy of a
 *   materializer, and `spec-door.ts` is byte-unchanged by this work): the tree
 *   handed on has no chain to read, and an accessor, a symbol key, a
 *   `__proto__` key, a foreign prototype or an over-deep tree is refused rather
 *   than copied. The double-read row above dies here.
 * - **D2 — NOT PERFORMED, and VACUOUS on this path.** A severed warmed arena is
 *   `packages/risk`'s mechanism, which this package may neither import
 *   (`docs/contracts/dependency-direction.md` permits no settlement → risk edge)
 *   nor paste (the repository-wide deletion guard). It has nothing to defend
 *   here: the evaluation path delegates NO decision to `zod` — it never parses
 *   the observation — so no inherited `skipChecks`, `optin`/`optout` or `when`
 *   can move a verdict on it. MEASURED at base and pinned at tip in
 *   `./observation-boundary.test.ts`: with `skipChecks` inherited, the honest
 *   evaluation and the polluted one are byte-identical to the clean ones.
 *   NO GRAMMAR IS RE-IMPLEMENTED HERE, deliberately: the door judges PRESENCE,
 *   OWNERSHIP and ROUTING, and leaves every value rule where the package already
 *   states it (`SETTLEMENT_TIMESTAMP_INVALID` for an unparseable instant, the
 *   window rules in `models/registry.ts`, the decimal contract in
 *   `@polymarket-bot/decimal`). A restated grammar here would be a second
 *   opinion that can drift from `SettlementObservationSchema` in either
 *   direction — SETL-1's B1 finding — for a path that has no library defeat to
 *   compensate for.
 * - **D3 — settle from the materialized tree.** {@link buildOwnObservation}
 *   projects the reading the caller actually handed over — declared keys only,
 *   frozen, null prototype — and the model evaluators receive THAT. Every later
 *   dot read inside them is therefore an own read by construction.
 * - **D4 — emit prototype-free.** The evaluation, its comparison record and the
 *   per-share payouts are built with `ownEmit` (`models/registry.ts`,
 *   `payout.ts`), so a consumer's `evaluation.payoutPerShare` on a `PENDING`
 *   market reads ABSENT rather than an inherited `{yes:"1", no:"1"}` — measured
 *   at base as exactly that.
 * - **Containment.** Every entry on this path returns a typed refusal or a
 *   verdict; none throws. The hostile-shape battery (`_zod`, `message`, `path`,
 *   `value`, `status`, `issues`, `code`, `details`, `required`, `forbidden`,
 *   `ok`, `refusals`, `length`, both variants) is run against all four entries
 *   in `./observation-boundary.test.ts` (ADR-020 amendment 2026-09-06).
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`. Every class above needs code
 * already executing in the process, so the row says "this check is not
 * load-bearing against an attacker already inside the process", not "a caller
 * can turn it off". It still matters because the failure mode measured above is
 * a market settled at a price nobody observed, and because the double-read row
 * needs no prototype access at all — a caller-supplied getter is enough.
 */

import { hasOwnField, isOwnRecord, ownEmit, ownField, readOwnSpec, type OwnRecord } from "./spec-door.js";

/** The outcome of reading a candidate observation as plain own data. Never a throw. */
export type OwnObservationRead =
  | { readonly ok: true; readonly value: OwnRecord }
  | { readonly ok: false; readonly detail: string };

/**
 * D1. Reads a candidate observation into a fresh prototype-free tree of plain
 * data, or says why it is not one. TOTAL: never throws.
 *
 * The materializer is `spec-door.ts`'s, unchanged and unwrapped: one reader for
 * this package's two documents rather than a second near-parallel copy of the
 * same twelve rules (SETL-1 already carries five near-parallel doors as a noted
 * residual). A candidate that is not a record at all — `null`, a number, an
 * array — is refused HERE rather than passed on, because unlike a spec there is
 * no schema downstream that would compose that refusal.
 */
export function readOwnObservation(value: unknown): OwnObservationRead {
  const read = readOwnSpec(value);
  if (!read.ok) {
    return { ok: false, detail: read.detail };
  }
  if (!isOwnRecord(read.value)) {
    return { ok: false, detail: "a settlement observation is a measured reading with fields" };
  }
  return { ok: true, value: read.value };
}

/**
 * Every key each observation variant DECLARES, in schema order.
 *
 * A `Map`, not an object literal: a lookup on a plain object is answered by
 * `Object.prototype` when the key is absent, and this table decides which fields
 * a reading may carry — the same reasoning `spec.ts` states for
 * `VERIFICATION_VARIANT_KEYS`, and the same defect this door closes one level up
 * (the compatibility matrix was an object literal, and answered `toString`).
 *
 * WRITTEN OUT rather than derived at module load, for `spec.ts`'s stated reason:
 * deriving it would run `zod` while this module initializes, which is the one
 * moment ADR-020 §1 class 7 (cold-lazy poisoning) and class 5 (the required-key
 * waiver on a COLD parse) are at their most dangerous. `./observation-boundary.test.ts`
 * derives both tables FROM the schemas and fails if they disagree, so a field
 * added to an observation without a row here fails the suite.
 */
export const OBSERVATION_DECLARED_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["TerminalSpotBinaryModel", ["referenceSymbol", "model", "observedValue", "observedAt", "strike"]],
  [
    "TwapBinaryModel",
    ["referenceSymbol", "model", "twapValue", "windowSeconds", "windowStartAt", "windowEndAt", "strike"],
  ],
  [
    "ReferenceOpenUpDownModel",
    [
      "referenceSymbol",
      "model",
      "referenceOpen",
      "referenceOpenAt",
      "observedValue",
      "observedAt",
      "windowSeconds",
      "windowStartAt",
      "windowEndAt",
    ],
  ],
  [
    "ThresholdByDateModel",
    [
      "referenceSymbol",
      "model",
      "threshold",
      "extremeKind",
      "extremeValue",
      "extremeObservedAt",
      "periodStartAt",
      "deadlineAt",
      "asOf",
    ],
  ],
]);

/**
 * The keys a reading MUST carry as its OWN — the door's presence check, and the
 * whole of what closes the 36 measured adoption cells.
 *
 * The three window fields of `ReferenceOpenUpDownModel` are the only optional
 * ones: the SPEC decides whether that series settles on a spot reading or on a
 * TWAP, and `models/registry.ts` already refuses both mismatches. They are
 * absent here for that reason and for no other — an optional key is still read
 * from the materialized tree, so it can no longer be supplied by the chain.
 */
export const OBSERVATION_REQUIRED_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["TerminalSpotBinaryModel", ["referenceSymbol", "model", "observedValue", "observedAt", "strike"]],
  [
    "TwapBinaryModel",
    ["referenceSymbol", "model", "twapValue", "windowSeconds", "windowStartAt", "windowEndAt", "strike"],
  ],
  [
    "ReferenceOpenUpDownModel",
    ["referenceSymbol", "model", "referenceOpen", "referenceOpenAt", "observedValue", "observedAt"],
  ],
  [
    "ThresholdByDateModel",
    [
      "referenceSymbol",
      "model",
      "threshold",
      "extremeKind",
      "extremeValue",
      "extremeObservedAt",
      "periodStartAt",
      "deadlineAt",
      "asOf",
    ],
  ],
]);

/**
 * Every reason the materialized tree is not the reading the selected model
 * settles, judged entirely on the door's own reads.
 *
 * PRESENCE, OWNERSHIP AND ROUTING ONLY (see the module header): an unrecognized
 * key is refused the way `z.strictObject` refuses one, a declared key the
 * reading does not state ITSELF is refused because no other document may state
 * it for it, and the VALUE rules stay where the package already states them.
 * Fails closed on a model with no table rather than admitting the reading on the
 * library's word.
 */
export function observationOwnIssues(model: string, tree: OwnRecord): readonly string[] {
  const declared = OBSERVATION_DECLARED_KEYS.get(model);
  const required = OBSERVATION_REQUIRED_KEYS.get(model);
  if (declared === undefined || required === undefined) {
    return [
      `model: this door states no field table for ${JSON.stringify(model)}, so it cannot admit the reading`,
    ];
  }
  const issues: string[] = [];
  for (const key of Object.keys(tree)) {
    if (!declared.includes(key)) {
      issues.push(`(root): Unrecognized key: "${key}"`);
    }
  }
  for (const key of required) {
    if (!hasOwnField(tree, key)) {
      issues.push(`${key}: the observation does not state it, and no other document may state it for it`);
    }
  }
  return issues;
}

/**
 * D3 + D4. Projects the reading the CALLER handed over out of the materialized
 * tree, in schema order, frozen, with a null prototype.
 *
 * The model evaluators keep their ordinary field reads and are prototype-safe
 * anyway, because the record they read has no prototype to consult. That is the
 * whole D3 property of this door, and `./observation-boundary.test.ts` kills the
 * mutant that hands the caller's original object over instead.
 */
export function buildOwnObservation<T>(model: string, tree: OwnRecord): T {
  const declared = OBSERVATION_DECLARED_KEYS.get(model) ?? [];
  const fields: (readonly [string, unknown])[] = [];
  for (const key of declared) {
    if (hasOwnField(tree, key)) {
      fields.push([key, ownField(tree, key)]);
    }
  }
  return ownEmit<T>(fields);
}
