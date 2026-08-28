/**
 * The `SettlementSpec` — handoff §9.3, ADR-009 §1.
 *
 * §9.3 lists the required fields; ADR-009 §1 makes the list mandatory and adds
 * the rule that gives the artifact its meaning: "`verified_by` / `verified_at`
 * are what make a spec usable. A spec without them blocks model-dependent
 * strategy activation."
 *
 * FIELD MAP — every §9.3 name, its schema field, and the WP-040 column it
 * persists to (`db/migrations/0002_catalog.up.sql`, `catalog.settlement_specs`):
 *
 * | §9.3 | here | column |
 * | --- | --- | --- |
 * | `settlement_spec_id` | `settlementSpecId` | `settlement_spec_id` |
 * | `series_id` | `seriesId` | `series_id` |
 * | `rules_version_id` | `rulesVersionId` | `rules_version_id` |
 * | `resolution_source` | `resolutionSource` | `resolution_source` |
 * | `reference_symbol` | `referenceSymbol` | `reference_symbol` |
 * | `observation_type` | `observationType` | `observation_type` |
 * | `window_seconds` | `windowSeconds` | `window_seconds` |
 * | `window_start_rule` | `windowStartRule` | `window_start_rule` |
 * | `window_end_rule` | `windowEndRule` | `window_end_rule` |
 * | `comparison` | `comparison` | `comparison` |
 * | `strike_source` | `strikeSource` | `strike_source` |
 * | `reference_open_source` | `referenceOpenSource` | `reference_open_source` |
 * | `timestamp_boundary` | `timestampBoundary` | `timestamp_boundary` |
 * | `rounding_rule` | `roundingRule` | `rounding_rule` |
 * | `fallback_source` | `fallbackSource` | `fallback_source` |
 * | `dispute_policy` | `disputePolicy` | `dispute_policy` |
 * | `clarification_policy` | `clarificationPolicy` | `clarification_policy` |
 * | `verified_by` / `verified_at` | `verification` (discriminated union) | `verification_status`, `verified_by`, `verified_at` |
 *
 * Two fields are carried beyond the §9.3 list, each cited:
 *
 * - `specVersion` — `catalog.settlement_specs.spec_version`; §6 invariant 9
 *   versions settlement specs, and ADR-009 §1 restates it. A change produces a
 *   new version rather than an edit.
 * - `payoffModel` — `catalog.settlement_specs.payoff_model`; ADR-009 §2 makes
 *   selection "a function of the settlement spec", and WP-040 already persists
 *   the selected model. It is OPTIONAL here: ADR-009 §2 says an observation type
 *   with no implementing model still yields a spec (one that cannot be
 *   activated), and such a spec has no model to name. See README §7 for the
 *   consequence for the current NOT NULL column.
 *
 * WHY `verification` IS A UNION rather than two nullable columns: the DB check
 * constraint `settlement_specs_verification_complete` says the same thing
 * (`VERIFIED` ⇔ both reviewer fields present). Encoding it as a union makes the
 * document that claims a review without a reviewer — or names a reviewer while
 * claiming to be unverified — unrepresentable rather than merely invalid.
 */

import {
  CodeStringSchema,
  IsoTimestampSchema,
  MAX_DETAIL_LENGTH,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import {
  SettlementSpecValidationError,
  settlementRefusal,
  type SettlementRefusal,
} from "./errors.js";
import { checkPayoffModelCompatibility } from "./models/compatibility.js";
import {
  ComparisonOperatorSchema,
  ObservationTypeSchema,
  PayoffModelIdSchema,
} from "./vocabulary.js";

/**
 * Values that look like a filled-in field but state no rule.
 *
 * ADR-009 §5.4: "'Halt and escalate' is a legitimate policy; 'unspecified' is
 * not." A spec whose dispute policy reads `TBD` is not a reviewed artifact, and
 * a `not null` column cannot tell the difference — so the refusal lives here.
 * Compared case-insensitively after trimming; punctuation-only values are
 * included because `-` and `?` are the two most common ways to fill a required
 * field with nothing.
 */
export const PLACEHOLDER_RULE_TEXTS: readonly string[] = Object.freeze([
  "-",
  "--",
  "?",
  "??",
  ".",
  "n/a",
  "na",
  "none",
  "nil",
  "null",
  "placeholder",
  "tba",
  "tbc",
  "tbd",
  "todo",
  "fixme",
  "unknown",
  "unspecified",
]);

const MINIMUM_RULE_TEXT_LENGTH = 3;

/**
 * A settlement rule stated in prose: a resolution source, a boundary rule, a
 * dispute policy.
 *
 * Bounded like every other free-text contract field (`MAX_DETAIL_LENGTH`),
 * whitespace-canonical (no leading or trailing whitespace, so one rule has one
 * representation in a hash or a uniqueness constraint), and refused when it
 * states a placeholder instead of a rule.
 */
export const SettlementRuleTextSchema = z
  .string()
  .min(MINIMUM_RULE_TEXT_LENGTH)
  .max(MAX_DETAIL_LENGTH)
  .superRefine((value, ctx) => {
    if (value.trim() !== value) {
      ctx.addIssue({
        code: "custom",
        message: "must not have leading or trailing whitespace",
      });
      return;
    }
    if (PLACEHOLDER_RULE_TEXTS.includes(value.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        message: `states a placeholder (${value}) rather than a rule; ADR-009 §5.4 requires a stated policy`,
      });
    }
  });

/**
 * Review outcome.
 *
 * `UNVERIFIED` is "nobody has reviewed this"; `REJECTED` is "somebody reviewed
 * it and said no". Both block model-dependent activation; keeping them distinct
 * is what lets an operator tell an unfinished spec from a refused one.
 *
 * `REJECTED` deliberately carries no reviewer fields: WP-040's
 * `settlement_specs_verification_complete` constraint permits `verified_by` /
 * `verified_at` only on a `VERIFIED` row, and a shape that could not be
 * persisted would be a contract that lies about the system.
 */
export const SettlementVerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("UNVERIFIED") }),
  z.strictObject({ status: z.literal("REJECTED") }),
  z.strictObject({
    status: z.literal("VERIFIED"),
    /** §9.3 `verified_by` — the human or process accountable for the review. */
    verifiedBy: NonEmptyStringSchema,
    /** §9.3 `verified_at`. */
    verifiedAt: IsoTimestampSchema,
  }),
]);
export type SettlementVerification = z.infer<typeof SettlementVerificationSchema>;

const settlementSpecShape = {
  settlementSpecId: Uuidv7Schema,
  seriesId: Uuidv7Schema,
  /** §6 invariant 9: a change creates a new version, never an edit. */
  specVersion: PositiveIntegerSchema,
  /**
   * The market rules version this spec was reviewed against.
   *
   * Optional on an unreviewed draft and REQUIRED to be verified (see
   * {@link settlementSpecReviewBlockers}): a review that does not name the rules
   * it reviewed cannot be checked against the rules a market is actually
   * trading under.
   */
  rulesVersionId: Uuidv7Schema.optional(),
  resolutionSource: SettlementRuleTextSchema,
  /** The reference instrument symbol, e.g. `btc/usd` (catalog vocabulary, not a venue fact). */
  referenceSymbol: CodeStringSchema,
  observationType: ObservationTypeSchema,
  /** Averaging window length. Required for a windowed observation; see the refinement. */
  windowSeconds: PositiveIntegerSchema.optional(),
  windowStartRule: SettlementRuleTextSchema.optional(),
  windowEndRule: SettlementRuleTextSchema.optional(),
  comparison: ComparisonOperatorSchema.optional(),
  strikeSource: SettlementRuleTextSchema.optional(),
  referenceOpenSource: SettlementRuleTextSchema.optional(),
  timestampBoundary: SettlementRuleTextSchema,
  roundingRule: SettlementRuleTextSchema,
  fallbackSource: SettlementRuleTextSchema,
  disputePolicy: SettlementRuleTextSchema,
  clarificationPolicy: SettlementRuleTextSchema,
  payoffModel: PayoffModelIdSchema.optional(),
  verification: SettlementVerificationSchema,
} as const;

/**
 * The §9.3 settlement spec.
 *
 * STRICT: an unknown key is an error, matching the frozen contracts
 * (`docs/contracts/domain.md` §7). A spec is a reviewed artifact; a field
 * nobody reviewed must not ride along inside it.
 */
export const SettlementSpecSchema = z
  .strictObject(settlementSpecShape)
  .superRefine((spec, ctx) => {
    // A windowed observation without a window has nothing to average over.
    // Mirrors WP-040's `settlement_specs_window_required`.
    if (
      (spec.observationType === "TWAP" || spec.observationType === "VWAP") &&
      spec.windowSeconds === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["windowSeconds"],
        message: `a ${spec.observationType} observation requires window_seconds (§9.3)`,
      });
    }

    // A window whose boundaries are unstated is not reproducible: two
    // implementations would average two different sets of ticks.
    if (spec.windowSeconds !== undefined) {
      for (const field of ["windowStartRule", "windowEndRule"] as const) {
        if (spec[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "a spec that declares window_seconds must state its window boundary rules",
          });
        }
      }
    }

    // §9.3 / acceptance 1: the model and the observation must fit, and the spec
    // must carry what the model needs. Reported through the same refusal codes
    // the runtime selection path uses, so the schema and `selectPayoffModel`
    // can never disagree about which specs are legal.
    for (const refusal of checkPayoffModelCompatibility(spec)) {
      // A spec whose observation type has no model at all is legal but
      // unusable (ADR-009 §2) — it is refused at ACTIVATION, not at
      // construction. Everything else is a malformed spec.
      if (refusal.code === "SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL") {
        continue;
      }
      if (
        refusal.code === "SETTLEMENT_SPEC_FIELD_REQUIRED" &&
        refusal.details["field"] === "payoffModel"
      ) {
        continue;
      }
      ctx.addIssue({
        code: "custom",
        path: typeof refusal.details["field"] === "string" ? [refusal.details["field"]] : [],
        message: `${refusal.code}: ${refusal.message}`,
      });
    }
  });

export type SettlementSpec = z.infer<typeof SettlementSpecSchema>;

/** Formats Zod issues the way the domain registry does. */
function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

/**
 * Parses a settlement spec.
 *
 * @throws {SettlementSpecValidationError} when the value is not a valid spec.
 */
export function parseSettlementSpec(value: unknown): SettlementSpec {
  const result = SettlementSpecSchema.safeParse(value);
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new SettlementSpecValidationError(
      `settlement spec is invalid: ${issues.join("; ")}`,
      issues,
    );
  }
  return result.data;
}

/** Non-throwing {@link parseSettlementSpec}. */
export function safeParseSettlementSpec(
  value: unknown,
): { readonly ok: true; readonly spec: SettlementSpec } | {
  readonly ok: false;
  readonly refusal: SettlementRefusal;
} {
  const result = SettlementSpecSchema.safeParse(value);
  if (result.success) {
    return { ok: true, spec: result.data };
  }
  const issues = formatIssues(result.error);
  return {
    ok: false,
    refusal: settlementRefusal(
      "SETTLEMENT_SPEC_INVALID",
      `settlement spec is invalid: ${issues.join("; ")}`,
      { issues },
    ),
  };
}

/** Whether the spec has been reviewed and may back model-dependent activation. */
export function isReviewedSettlementSpec(spec: SettlementSpec): boolean {
  return spec.verification.status === "VERIFIED";
}

/**
 * Reasons this spec must not be marked `VERIFIED` — evaluated against a stated
 * feed context, because one of them is a venue-availability question.
 *
 * ADR-009 §6 rule 1: a spec "whose `resolution_source` is the RTDS TWAP feed may
 * only declare a `window_seconds` the feed publishes … A spec naming any other
 * window cannot be marked verified, because nothing would produce the
 * observation it depends on."
 *
 * The published windows are NOT hardcoded here. They are a volatile venue fact
 * (handoff §1.2) that the composition root reads from the current venue snapshot
 * and passes in; see {@link RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24} for
 * the dated value and its provenance. A caller that supplies no list for a
 * windowed spec gets a refusal rather than a pass: "we do not know" must not
 * read as "it is fine".
 */
export interface SettlementReviewContext {
  /**
   * Window lengths, in seconds, that the spec's resolution feed actually
   * publishes. Required to verify a spec that declares `windowSeconds`.
   */
  readonly publishedWindowSeconds?: readonly number[] | undefined;
}

/**
 * The Chainlink TWAP windows the venue published as of the frozen venue report.
 *
 * Source: `docs/venue/verified-2026-08-24.md` §10.3 (topics
 * `crypto_prices_twap_thirty` and `crypto_prices_twap_sixty`), ADR-009 §6.
 * DATED, not permanent: handoff §1.2 requires re-verification each phase, and a
 * caller must pass the value from the CURRENT snapshot rather than assume this
 * one still holds.
 */
export const RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24: readonly number[] = Object.freeze([
  30, 60,
]);

/** Every reason `spec` must not carry a `VERIFIED` verification, in a stable order. */
export function settlementSpecReviewBlockers(
  spec: SettlementSpec,
  context: SettlementReviewContext = {},
): readonly SettlementRefusal[] {
  const blockers: SettlementRefusal[] = [];

  if (spec.rulesVersionId === undefined) {
    blockers.push(
      settlementRefusal(
        "SETTLEMENT_RULES_VERSION_REQUIRED",
        "a verified spec must name the market rules version it was reviewed against (§6 invariant 9)",
        { settlementSpecId: spec.settlementSpecId },
      ),
    );
  }

  for (const refusal of checkPayoffModelCompatibility(spec)) {
    blockers.push(refusal);
  }

  if (spec.windowSeconds !== undefined) {
    const published = context.publishedWindowSeconds;
    if (published === undefined) {
      blockers.push(
        settlementRefusal(
          "SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN",
          `spec declares a ${String(spec.windowSeconds)}s window but the caller stated no published windows for ${spec.resolutionSource}; ADR-009 §6 requires the window to be one the feed publishes`,
          { windowSeconds: spec.windowSeconds, resolutionSource: spec.resolutionSource },
        ),
      );
    } else if (!published.includes(spec.windowSeconds)) {
      blockers.push(
        settlementRefusal(
          "SETTLEMENT_WINDOW_NOT_PUBLISHED",
          `spec declares a ${String(spec.windowSeconds)}s window; the resolution feed publishes ${published.join(", ")}s, so nothing would produce the observation (ADR-009 §6)`,
          { windowSeconds: spec.windowSeconds, publishedWindowSeconds: [...published] },
        ),
      );
    }
  }

  return Object.freeze(blockers);
}
