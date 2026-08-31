/**
 * Deterministic sample specs and observations.
 *
 * Exported as a subpath (`@polymarket-bot/settlement/testing`) so tests in this
 * package and in the composition roots build the same shapes, and so a sample
 * that drifts out of validity fails a test rather than being fixed by hand in
 * five places.
 *
 * NOTHING HERE IS A VENUE FACT. The strings describe plausible settlement rules
 * for test purposes; the resolution sources, symbols, and strikes are examples,
 * and every sample is `UNVERIFIED` unless a test explicitly verifies it.
 */

import type {
  ReferenceOpenUpDownObservation,
  TerminalSpotObservation,
  ThresholdByDateObservation,
  TwapObservation,
} from "../observation.js";
import type { SettlementSpec } from "../spec.js";

/** A fixed, valid UUIDv7 for a sample series. */
export const SAMPLE_SERIES_ID = "01936f00-0000-7000-8000-00000000a001";
/** A fixed, valid UUIDv7 for a sample market rules version. */
export const SAMPLE_RULES_VERSION_ID = "01936f00-0000-7000-8000-00000000b001";

/**
 * Placeholder policy values that must NEVER be accepted in a required rule
 * field — at construction OR at activation (round-2 review, M1 requires both
 * suites to pin the identical list, so it lives here rather than in either
 * test file).
 *
 * The first four are the round-2 reviewer probes, verbatim. The next block is
 * round 2's added attack cases, each annotated with the matcher rule that
 * catches it. The final block is the round-3 reviewer probes (verbatim) plus
 * that round's class-mates — every entry was REPRODUCED as a live bypass at
 * the round-3 candidate (59273bc) before being pinned here.
 */
export const PLACEHOLDER_POLICY_ATTACK_SAMPLES: readonly string[] = Object.freeze([
  "pending review", // reviewer probe: whole-field common phrase
  "fill me in", // reviewer probe: whole-field common phrase
  "ТВD - complete after review", // reviewer probe: Cyrillic Т/В + Latin D → mixed-script token
  "Use primary source; TBD - complete after review.", // reviewer probe: marker mid-sentence
  "Use primary source; T.B.D. - complete after review.", // dotted marker mid-sentence (joined runs)
  "ＴＢＤ - complete after review", // fullwidth (NFKC)
  "Т В D - complete after review", // spaced Cyrillic homoglyphs (confusable fold + joined runs)
  "tb\u00add - complete after review", // soft-hyphen-split marker (non-ASCII stripping)
  "T0D0: write the dispute policy", // digit-for-letter marker (0 → o)
  "f1xme before launch", // digit-for-letter marker (1 → i)
  "n0ne", // digit-for-letter whole-field placeholder
  "Halt and escalate. TODO revisit.", // marker at any token position
  "Escalate per clause XXX of the venue rules.", // xxx stands in for the unwritten clause
  "Lorem ipsum dolor sit amet.", // filler text
  "pending approval",
  "under review",
  "awaiting review",
  "draft",
  "work in progress",
  "fill in later",
  "insert policy here",
  "complete after review",
  // --- Round-3 reviewer probes, verbatim. ---
  "pending completion", // r3 probe 1: whole-field "pending X" form
  "to do", // r3 probe 1: whole-field form
  "TO.DO: confirm with ops", // r3 probe 2: multi-letter dotted segments (joined token spans)
  "FI.XME before launch", // r3 probe 2: multi-letter dotted segments (joined token spans)
  "τβϲ; use primary source.", // r3 probe 3: Greek, lunate sigma ϲ unmapped (post-fold non-Latin refusal)
  "ТВД; use primary source.", // r3 probe 3: Cyrillic, д unmapped (post-fold non-Latin refusal)
  "TB0", // r3 note 4: a digit stands in for any letter (marker wildcard)
  // --- Round-3 class-mates (each reproduced as a live bypass at the candidate). ---
  "to be done", // whole-field "to be X" form
  "pending definition", // whole-field "pending X" form
  "fix.me before launch", // dotted marker, lowercase multi-letter segments (joined token spans)
  "W.IP: finalize escalation matrix", // dotted marker, 1+2-letter segments (joined token spans)
  "F1X.ME later", // dotted AND digit-substituted marker (joined spans + wildcard/fold)
  "τβδ; use primary source.", // Greek δ unmapped (post-fold non-Latin refusal)
  // --- Round-4 reviewer probes, verbatim (each reproduced as a live bypass
  // --- at the round-4 candidate 5ef6c31 before being pinned here; `TO DO`
  // --- already refused there via the round-3 whole-field entry and is pinned
  // --- as a required round-4 fixture).
  "Policy TO DO later.", // r4 M-1: marker split across whitespace, mid-sentence
  "pending legal review", // r4 M-2: whole-field "pending <anything>" family
  "awaiting input", // r4 M-2: whole-field "awaiting <anything>" family
  "intentionally left blank", // r4 M-2: conventional unfinished-field entry
  // --- Round-4 required fixtures and class-mates. ---
  "TO DO", // whole-field split marker (whole-field entry + split-marker rule)
  "TO DO: confirm with ops", // field-start split marker with a non-grammatical tail
  "Policy is TO DO.", // split marker at field end
  "to do later", // field-start split marker, no grammatical continuation
  "to do so", // bare opener with nothing after the continuation word
  "fix me before launch", // split fixme — deliberately self-announcing (documented in spec.ts)
  "to d o later", // mixed-length whitespace split of a marker
  "place holder", // split marker pair
  "un known", // whole-field entry split by whitespace (condensed whole-field rule)
  "pending outside counsel signoff", // family: pending + 3 tail tokens
  "awaiting final numbers", // family: awaiting + 2 tail tokens
  "not yet drafted", // family: not yet + 1 tail token
  "to be agreed", // family: to be + 1 tail token
  "yet to be agreed", // family: yet to be + 1 tail token
  "left blank", // conventional unfinished-field entry
  "see attached", // conventional unfinished-field entry
]);

/**
 * Legitimate policy texts that must KEEP parsing (round-2 review, M1
 * boundary): substantive sentences that merely mention review, begin with
 * `None`/`Unknown`/`Pending`/`In progress`/`draft`-adjacent words, carry
 * accented Latin, or contain letter+digit tokens. A matcher change that
 * refuses any of these is over-broad.
 *
 * Round-3 additions pin the boundaries of that round's structural rules:
 * accented Latin survives the post-fold non-Latin refusal (Latin script is
 * never "leftover"); ordinary words CONTAINING a marker substring survive the
 * token-boundary rule; dotted clause numbers and `e.g.` survive the joined
 * token spans; and `T+1` / `24h` survive the digit-wildcard marker matching.
 */
export const LEGITIMATE_POLICY_SAMPLES: readonly string[] = Object.freeze([
  "Halt and escalate to the operator; no substitute source is used.",
  "None. Disputes are not accepted.",
  "Unknown outcomes resolve per §4.",
  "Disputes are resolved by the review committee within 48 hours.",
  "Pending disputes are held open and settle nothing until resolved.",
  "Fill prices from the primary feed are authoritative for settlement.",
  "Résolution follows the venue's published procedure; halt on any doubt.",
  "Reviews complete within 24h; disputes escalate to the operator.",
  "In progress disputes halt settlement until the venue publishes an outcome.",
  "The draft resolution proposed by UMA is not final until the vote completes.",
  // --- Round-3 boundary additions. ---
  "A naïve reading of the rules is escalated to the operator for human review.",
  "Mastodon announcements by the venue are not authoritative for settlement.",
  "Autodial escalation is disabled; a human operator confirms every halt.",
  "Escalate per §4.2.1 of the venue procedure; halt on any doubt.",
  "Ambiguous prints (e.g. crossed quotes) are excluded from the observation.",
  "The T+1 settlement convention applies; disputes escalate within 24h.",
  "Pending completion of the dispute review, no position is settled.",
  // --- Round-4 boundary additions: the grammatical "To do so/this/that, …"
  // --- opener survives the whitespace-split marker rule, and long
  // --- head-opened SENTENCES survive the whole-field family bound.
  "To do so, the operator must first halt the series.",
  "To do this correctly, the operator halts the series before any settlement.",
  "To do that, escalate to the operator and halt the series first.",
  "Awaiting venue confirmation, the operator holds settlement open and escalates within 24h.",
  "Not yet resolved markets are held open and escalated to the operator after 48 hours.",
]);

const baseSpec = {
  seriesId: SAMPLE_SERIES_ID,
  specVersion: 1,
  rulesVersionId: SAMPLE_RULES_VERSION_ID,
  referenceSymbol: "btc.usd",
  timestampBoundary: "Inclusive of the close instant, venue clock in UTC.",
  roundingRule: "No rounding: the exact decimal observation is compared as published.",
  fallbackSource: "Halt and escalate to the operator; no substitute source is used.",
  disputePolicy: "Halt trading and escalate; no position is settled while a dispute is open.",
  clarificationPolicy:
    "Halt entries and require a fresh human review of this spec before the series resumes.",
  verification: { status: "UNVERIFIED" },
} as const;

/** A terminal-spot binary spec (`TERMINAL_SPOT` + `TerminalSpotBinaryModel`). */
export function terminalSpotSpecSample(): SettlementSpec {
  return {
    ...baseSpec,
    settlementSpecId: "01936f00-0000-7000-8000-00000000c001",
    resolutionSource: "Example reference exchange terminal print at the close instant.",
    observationType: "TERMINAL_SPOT",
    comparison: "GTE",
    strikeSource: "The strike stated in the market rules text.",
    payoffModel: "TerminalSpotBinaryModel",
  };
}

/** A TWAP binary spec (`TWAP` + `TwapBinaryModel`), 30-second window. */
export function twapSpecSample(): SettlementSpec {
  return {
    ...baseSpec,
    settlementSpecId: "01936f00-0000-7000-8000-00000000c002",
    resolutionSource: "Chainlink TWAP over the venue real-time data service.",
    observationType: "TWAP",
    windowSeconds: 30,
    windowStartRule: "Thirty seconds before the market close instant.",
    windowEndRule: "The market close instant, inclusive.",
    comparison: "GT",
    strikeSource: "The strike stated in the market rules text.",
    payoffModel: "TwapBinaryModel",
  };
}

/** An up/down spec (`TERMINAL_SPOT` + `ReferenceOpenUpDownModel`). */
export function referenceOpenUpDownSpecSample(): SettlementSpec {
  return {
    ...baseSpec,
    settlementSpecId: "01936f00-0000-7000-8000-00000000c003",
    resolutionSource: "Example reference exchange print at open and at close.",
    observationType: "TERMINAL_SPOT",
    comparison: "GT",
    referenceOpenSource: "The reference price published at the market open instant.",
    payoffModel: "ReferenceOpenUpDownModel",
  };
}

/** A threshold-by-date spec (`TERMINAL_SPOT` + `ThresholdByDateModel`). */
export function thresholdByDateSpecSample(): SettlementSpec {
  return {
    ...baseSpec,
    settlementSpecId: "01936f00-0000-7000-8000-00000000c004",
    resolutionSource: "Example reference exchange prints throughout the question period.",
    observationType: "TERMINAL_SPOT",
    windowStartRule: "The market open instant.",
    windowEndRule: "The stated deadline instant, inclusive.",
    comparison: "GTE",
    strikeSource: "The threshold stated in the market rules text.",
    payoffModel: "ThresholdByDateModel",
  };
}

/** Marks a sample spec reviewed. Tests use it to exercise the permitted branch. */
export function verifiedSpec(spec: SettlementSpec, verifiedAt = "2026-08-28T00:00:00Z"): SettlementSpec {
  return {
    ...spec,
    verification: { status: "VERIFIED", verifiedBy: "test-reviewer", verifiedAt },
  };
}

/** A terminal-spot observation matching {@link terminalSpotSpecSample}. */
export function terminalSpotObservationSample(): TerminalSpotObservation {
  return {
    model: "TerminalSpotBinaryModel",
    referenceSymbol: "btc.usd",
    observedValue: "64000.25",
    observedAt: "2026-08-28T12:00:00Z",
    strike: "64000",
  };
}

/** A TWAP observation matching {@link twapSpecSample}. */
export function twapObservationSample(): TwapObservation {
  return {
    model: "TwapBinaryModel",
    referenceSymbol: "btc.usd",
    twapValue: "64000.25",
    windowSeconds: 30,
    windowStartAt: "2026-08-28T11:59:30Z",
    windowEndAt: "2026-08-28T12:00:00Z",
    strike: "64000",
  };
}

/** An up/down observation matching {@link referenceOpenUpDownSpecSample}. */
export function referenceOpenUpDownObservationSample(): ReferenceOpenUpDownObservation {
  return {
    model: "ReferenceOpenUpDownModel",
    referenceSymbol: "btc.usd",
    referenceOpen: "64000",
    referenceOpenAt: "2026-08-28T11:45:00Z",
    observedValue: "64010",
    observedAt: "2026-08-28T12:00:00Z",
  };
}

/** A threshold-by-date observation matching {@link thresholdByDateSpecSample}. */
export function thresholdByDateObservationSample(): ThresholdByDateObservation {
  return {
    model: "ThresholdByDateModel",
    referenceSymbol: "btc.usd",
    threshold: "150000",
    extremeKind: "MAX",
    extremeValue: "149000",
    extremeObservedAt: "2026-08-28T12:00:00Z",
    periodStartAt: "2026-08-01T00:00:00Z",
    deadlineAt: "2026-12-31T23:59:59Z",
    asOf: "2026-08-28T12:00:00Z",
  };
}
