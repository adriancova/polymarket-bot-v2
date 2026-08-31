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
 *
 * MATCHING (tightened in remediation round 1, finding M1; again in round 2:
 * round 1's normalization stripped non-ASCII characters and matched only whole
 * fields or prefixes, so `"pending review"`, `"fill me in"`, a
 * Cyrillic-lookalike `"ТВD - …"` and a mid-sentence `"…; TBD - …"` all passed;
 * and again in round 3: round 2 joined only SINGLE-letter dotted segments, so
 * `"TO.DO"`/`"FI.XME"` slipped through — now the alphanumeric segments of any
 * whitespace-delimited span are joined whatever their lengths
 * ({@link joinedTokenSpans}) — and its digit folds were enumerative, so
 * `"TB0"` slipped through — now a digit in a mixed letter+digit token stands
 * for ANY letter when testing marker equality ({@link tokenMatchesMarker})).
 * The value is first put through the Unicode gate of
 * {@link placeholderRuleTextReason} (NFKC, mixed-script refusal, confusable
 * folding, non-ASCII stripping — the exact rule is documented there), and each
 * resulting ASCII candidate is NORMALIZED — lowercased, every run of
 * non-alphanumeric characters collapsed to a single space, then trimmed — and
 * refused when:
 *
 * 1. the normalized form is EMPTY (the value was punctuation-only — `"???"`,
 *    `"-"`, `"..."` — or contained nothing this matcher can read as ASCII
 *    text); or
 * 2. the normalized form EQUALS one of {@link PLACEHOLDER_RULE_TEXTS} (so
 *    `"N / A"`, `"n/a"` and `"n.a."` all normalize to `"n a"` / `"n a"` forms
 *    listed below); or
 * 3. the normalized form STARTS WITH one of {@link PLACEHOLDER_RULE_PREFIXES}
 *    followed by more text (`"TBD - complete after review"` → `"tbd complete
 *    after review"`): a rule that opens by declaring itself undetermined is
 *    not a rule, whatever follows; or
 * 4. ANY whitespace-delimited token of the normalized form equals one of
 *    {@link PLACEHOLDER_MARKER_TOKENS} (round 2: `"Use primary source; TBD -
 *    complete after review."` is poisoned by the marker wherever it sits),
 *    including after folding digit-for-letter substitutions inside a token
 *    (`"T0D0"` → `"todo"`).
 *
 * The prefix list is deliberately narrower than the exact list: `"none"`,
 * `"unknown"`, `"nil"` and `"null"` legitimately BEGIN real policy sentences
 * ("None of the fallback sources may be used; halt."), so they refuse only as
 * the entire (normalized) value. The any-position marker list is narrower
 * still: only self-announcing "unfinished" tokens (`tbd`, `todo`, `fixme`, …)
 * poison a sentence at any position — ordinary words such as "review" never
 * do, so "Disputes are resolved by the review committee within 48 hours."
 * parses.
 */
export const PLACEHOLDER_RULE_TEXTS: readonly string[] = Object.freeze([
  "n a",
  "na",
  "none",
  "nil",
  "null",
  "placeholder",
  "pending",
  "later",
  "missing",
  "tba",
  "tbc",
  "tbd",
  "todo",
  "fixme",
  "wip",
  "xxx",
  "unknown",
  "unspecified",
  "undecided",
  "undetermined",
  "not specified",
  "not applicable",
  "not available",
  "not defined",
  "not determined",
  "no policy",
  "to be determined",
  "to be decided",
  "to be announced",
  "to be confirmed",
  "to be specified",
  "to be defined",
  "see above",
  "see below",
  "same as above",
  // Round-2 additions (review finding M1a): common whole-field placeholder
  // phrases. Whole-field ONLY — several of these words appear mid-sentence in
  // real policies ("held pending review of the dispute" names a process), so
  // they refuse only as the entire normalized value.
  "pending review",
  "pending approval",
  "under review",
  "in review",
  "awaiting review",
  "awaiting approval",
  "needs review",
  "review pending",
  "review needed",
  "review required",
  "fill me in",
  "fill in",
  "fill this in",
  "fill in later",
  "fill me in later",
  "draft",
  "first draft",
  "rough draft",
  "work in progress",
  "in progress",
  "incomplete",
  "unfinished",
  "coming soon",
  "insert here",
  "insert text here",
  "insert policy here",
  "insert rule here",
  "add later",
  "write later",
  "write me",
  "complete later",
  "complete after review",
  "finish later",
  "finalize later",
  "define later",
  "decide later",
  "determine later",
  "specify later",
  "revisit",
  "revisit later",
  "needs definition",
  "needs content",
  "empty",
  "blank",
  "do not use",
  "delete me",
  "replace me",
  "replace this",
  "change me",
  "edit me",
  "update me",
  "update later",
  "temp",
  "temporary",
  "tmp",
  "test",
  "testing",
  "dummy",
  "dummy text",
  "filler",
  "filler text",
  "sample text",
  "example text",
  "your text here",
  "text here",
  "policy here",
  "content here",
  // Round-3 additions (review finding M1, class (a)): whole-field forms of the
  // "to do" / "to be done" / "pending X" / "not yet X" families. Whole-field
  // ONLY, deliberately: "Pending completion of the review, halt all entries."
  // and "To do so, the operator must halt." open real policy sentences, so
  // none of these joins the prefix or marker lists.
  "to do",
  "to be done",
  "to be written",
  "to be added",
  "to be filled",
  "to be filled in",
  "to be completed",
  "to be reviewed",
  "to be provided",
  "to be supplied",
  "to be finalized",
  "to be finalised",
  "yet to be determined",
  "yet to be defined",
  "yet to be decided",
  "not yet determined",
  "not yet defined",
  "not yet decided",
  "not yet specified",
  "not yet written",
  "not yet known",
  "not yet available",
  "not yet final",
  "pending completion",
  "pending definition",
  "pending decision",
  "pending determination",
  "pending specification",
  "pending confirmation",
  "pending verification",
  "pending finalization",
  "pending input",
  "pending content",
  "pending update",
  "details to follow",
  "to follow",
  "to come",
  "more to come",
  "details later",
]);

/**
 * Placeholder markers that poison a rule even as a PREFIX of a longer value.
 *
 * These are the self-announcing "unfinished" markers; unlike `"none"` or
 * `"unknown"`, no legitimate policy sentence begins with them.
 */
export const PLACEHOLDER_RULE_PREFIXES: readonly string[] = Object.freeze([
  "tbd",
  "tba",
  "tbc",
  "todo",
  "fixme",
  "wip",
  "xxx",
  "placeholder",
  "n a",
  "not specified",
  "not applicable",
  "not defined",
  "not determined",
  "to be determined",
  "to be decided",
  "to be announced",
  "to be confirmed",
  "to be specified",
  "to be defined",
  "unspecified",
  "undecided",
  "undetermined",
]);

/**
 * Self-announcing "unfinished" markers that poison a rule at ANY token
 * position (round-2 review, M1b).
 *
 * `"Use primary source; TBD - complete after review."` is not a policy: the
 * marker announces that part of the rule is unwritten, wherever it sits. The
 * list is STRICTLY the marker class — acronyms and editor conventions with no
 * legitimate reading inside a settlement policy sentence. Ordinary words that
 * merely relate to reviewing (`review`, `pending`, `draft` as a verb, …) are
 * deliberately absent: "Disputes are resolved by the review committee within
 * 48 hours." is a real policy and must parse. (`lorem`/`ipsum` are the
 * standard filler-text tokens; `xxx` mid-sentence is a fill-in-the-blank for
 * whatever it stands in for, e.g. "per clause XXX".)
 */
export const PLACEHOLDER_MARKER_TOKENS: readonly string[] = Object.freeze([
  "tbd",
  "tba",
  "tbc",
  "todo",
  "fixme",
  "wip",
  "xxx",
  "placeholder",
  "lorem",
  "ipsum",
]);

/**
 * Digit-for-letter substitutions folded inside a token, so `"n0ne"` cannot
 * dodge the WHOLE-FIELD list and `"t0 d0"` folds to `"to do"`. Two maps
 * because `1` reads as both `i` and `l`. Applied ONLY to tokens that mix
 * letters and digits: a pure number ("within 48 hours") is never touched.
 *
 * Since round 3 these folds carry the whole-field and prefix rules only;
 * MARKER-token matching no longer depends on them, because
 * {@link tokenMatchesMarker} treats any digit in a mixed token as a stand-in
 * for any letter (the fold maps were enumerative — `"TB0"` dodged `0 → o`).
 * The folds still run over every form for defense in depth.
 */
const DIGIT_FOLDS: readonly Readonly<Record<string, string>>[] = [
  Object.freeze({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g" }),
  Object.freeze({ "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g" }),
];

/**
 * Known single-character Unicode homoglyphs of ASCII letters (Cyrillic and
 * Greek), keyed by their LOWERCASE form. Deliberately a fixed, reviewable
 * table rather than a library: folding is used only to MATCH — a fold can
 * cause a refusal, never an acceptance — and the table's completeness is NOT
 * load-bearing, because any letter still non-Latin AFTER the fold refuses the
 * whole value ({@link unmappedNonLatinLetter}; round-3 review, M1c — the
 * round-2 claim that the mixed-script and stripped-form rules covered
 * unmapped lookalikes was wrong: stripping DELETED an unmapped marker while
 * ASCII prose kept the field alive).
 */
const CONFUSABLE_TO_ASCII: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic.
  "а": "a",
  "в": "b",
  "е": "e",
  "ѐ": "e",
  "ё": "e",
  "і": "i",
  "ї": "i",
  "ј": "j",
  "к": "k",
  "м": "m",
  "н": "h",
  "о": "o",
  "р": "p",
  "с": "c",
  "т": "t",
  "у": "y",
  "х": "x",
  "ѕ": "s",
  "ѵ": "v",
  "ԁ": "d",
  "һ": "h",
  "ӏ": "l",
  // Greek.
  "α": "a",
  "β": "b",
  "γ": "y",
  "ε": "e",
  "ζ": "z",
  "η": "n",
  "ι": "i",
  "κ": "k",
  "ν": "v",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "υ": "y",
  "χ": "x",
  "ω": "w",
});

/** Printable-ASCII test used by the stripping rule (everything else is "non-ASCII" here). */
const NON_ASCII_PRINTABLE = /[^\x20-\x7e]/gu;

/**
 * Lowercases and collapses every non-alphanumeric run to one space, trimmed.
 *
 * `"TBD - complete after review"` → `"tbd complete after review"`;
 * `"N / A"` → `"n a"`; `"???"` → `""`.
 */
function normalizedRuleText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Joins runs of single-letter tokens, so dotted abbreviations match their
 * plain forms: `"t b d fill in later"` → `"tbd fill in later"` (from
 * `"T.B.D. fill in later"`), `"n a"` → `"na"`.
 */
function joinedSingleLetterRuns(normalized: string): string {
  const output: string[] = [];
  let run: string[] = [];
  for (const token of normalized.split(" ")) {
    if (token.length === 1) {
      run.push(token);
      continue;
    }
    if (run.length > 0) {
      output.push(run.join(""));
      run = [];
    }
    output.push(token);
  }
  if (run.length > 0) {
    output.push(run.join(""));
  }
  return output.join(" ");
}

/**
 * Joins the alphanumeric segments of every WHITESPACE-DELIMITED span, so a
 * marker split by punctuation inside one span matches its plain form whatever
 * the segment lengths: `"TO.DO: confirm"` → `"todo confirm"`, `"FI.XME"` →
 * `"fixme"`, `"fix.me"` → `"fixme"`, `"T.B.D."` → `"tbd"`.
 *
 * Round-3 review, M1 class (b): {@link joinedSingleLetterRuns} joined only
 * runs of SINGLE-letter segments (`T.B.D.`), so a marker whose dotted
 * segments were longer (`TO.DO`, `FI.XME`) slipped through. This form
 * operates on the RAW candidate rather than the normalized form because
 * normalization erases the span boundaries (a dot and a space both become
 * one space): the dots in `"TO.DO"` mark ONE visual token, and its segments
 * are joined; `"to do"` (two spans) is a separate, whole-field concern.
 * Punctuation-only spans vanish, exactly as under normalization.
 *
 * Only printable-ASCII punctuation joins segments. A NON-ASCII separator
 * (`"tb­d"`) is treated as a span boundary here, because reassembling
 * text split by invisible characters is the stripped candidate's single
 * responsibility in {@link placeholderRuleTextReason} — that candidate
 * re-runs this joiner over the ASCII-only text and reassembles the marker
 * there, keeping each layer's reason honest.
 */
function joinedTokenSpans(candidate: string): string {
  return candidate
    .toLowerCase()
    .replace(NON_ASCII_PRINTABLE, " ")
    .split(/\s+/u)
    .map((span) => span.replace(/[^a-z0-9]+/gu, ""))
    .filter((segment) => segment !== "")
    .join(" ");
}

/** Folds digit-for-letter substitutions in every mixed letter+digit token of `form`. */
function digitFoldedForm(form: string, fold: Readonly<Record<string, string>>): string {
  return form
    .split(" ")
    .map((token) =>
      /[0-9]/u.test(token) && /[a-z]/u.test(token)
        ? token.replace(/[0-9]/gu, (digit) => fold[digit] ?? digit)
        : token,
    )
    .join(" ");
}

const ANY_LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * The first token that mixes Latin with non-Latin letters, or `undefined`.
 *
 * Round-2 review, M1c: a token such as `"ТВD"` (Cyrillic Т and В, Latin D) is
 * a confusable by construction — no natural-language word mixes scripts inside
 * one token — and the old normalization LAUNDERED it by silently discarding
 * the non-ASCII letters. Such a value is refused outright rather than
 * normalized. Tokens are maximal letter runs; combining marks are ignored
 * (they are stripped by normalization anyway).
 */
function mixedScriptToken(value: string): string | undefined {
  for (const match of value.matchAll(/[\p{L}\p{M}]+/gu)) {
    const token = match[0];
    let hasLatin = false;
    let hasNonLatin = false;
    for (const char of token) {
      if (!ANY_LETTER.test(char)) {
        continue;
      }
      if (LATIN_LETTER.test(char)) {
        hasLatin = true;
      } else {
        hasNonLatin = true;
      }
    }
    if (hasLatin && hasNonLatin) {
      return token;
    }
  }
  return undefined;
}

/** Folds every mapped Unicode homoglyph in an (already lowercased) string to its ASCII form. */
function confusablesFolded(lower: string): string {
  let output = "";
  for (const char of lower) {
    output += CONFUSABLE_TO_ASCII[char] ?? char;
  }
  return output;
}

/**
 * The first letter that is still non-Latin AFTER homoglyph folding, or
 * `undefined`.
 *
 * Round-3 review, M1 class (c) — the STRUCTURAL rule that makes the fold
 * table's completeness non-load-bearing. The round-2 pipeline ran the
 * mixed-script check only BEFORE folding, so an originally single-script
 * token (`"τβϲ"`) whose letters were only PARTIALLY mapped folded into a
 * mixed token (`"tbϲ"`) that no rule ever re-examined; the stripping
 * candidate then deleted the unmapped letters and the marker evaporated
 * while the substantive ASCII suffix kept the field alive. After folding,
 * a remaining non-Latin letter means one of exactly two things — an
 * UNMAPPED confusable, or genuinely non-Latin content (which the matcher
 * already treats as refusable when it is the whole value) — and BOTH refuse.
 * Accented Latin (`é`, `ï`, `résolution`, `naïve`) is Latin script and is
 * never touched by this rule.
 */
function unmappedNonLatinLetter(folded: string): string | undefined {
  for (const char of folded) {
    if (ANY_LETTER.test(char) && !LATIN_LETTER.test(char)) {
      return char;
    }
  }
  return undefined;
}

/**
 * Whether `token` equals `marker`, treating each DIGIT in a mixed
 * letter+digit token as a stand-in for any letter.
 *
 * Round-3 hardening (review note on class 4): the two fixed digit-fold maps
 * were enumerative — `"TB0"` dodged them because `0` mapped only to `o` —
 * and enumerating which letter each digit "looks like" re-fights the same
 * losing battle as the homoglyph table. Structurally, a digit inside an
 * otherwise-alphabetic token of marker length is a substitution by
 * construction, so it may stand for ANY letter when testing marker
 * equality. A pure-number token (`"48"`) never matches (no letter), every
 * LETTER must still match exactly, and lengths must agree, so `"24h"`
 * cannot match `"tbd"` and ordinary words are untouched.
 */
function tokenMatchesMarker(token: string, marker: string): boolean {
  if (token === marker) {
    return true;
  }
  if (token.length !== marker.length) {
    return false;
  }
  if (!/[0-9]/u.test(token) || !/[a-z]/u.test(token)) {
    return false;
  }
  for (let index = 0; index < token.length; index += 1) {
    const char = token.charAt(index);
    if (char !== marker.charAt(index) && !(char >= "0" && char <= "9")) {
      return false;
    }
  }
  return true;
}

/**
 * Runs the ASCII placeholder rules (whole-field, prefix, any-position marker,
 * digit folds) over one candidate string. `undefined` when nothing matched.
 */
function asciiPlaceholderReason(candidate: string): string | undefined {
  const normalized = normalizedRuleText(candidate);
  if (normalized === "") {
    return "contains no ASCII letters or digits (nothing that states a rule)";
  }
  const forms = new Set<string>();
  const bases = [normalized, joinedSingleLetterRuns(normalized), joinedTokenSpans(candidate)];
  for (const base of bases) {
    if (base === "") {
      continue;
    }
    forms.add(base);
    for (const fold of DIGIT_FOLDS) {
      forms.add(digitFoldedForm(base, fold));
    }
  }
  for (const form of forms) {
    if (PLACEHOLDER_RULE_TEXTS.includes(form)) {
      return `normalizes to the placeholder "${form}"`;
    }
    for (const prefix of PLACEHOLDER_RULE_PREFIXES) {
      if (form === prefix || form.startsWith(`${prefix} `)) {
        return `begins with the placeholder marker "${prefix}"`;
      }
    }
    for (const token of form.split(" ")) {
      for (const marker of PLACEHOLDER_MARKER_TOKENS) {
        if (tokenMatchesMarker(token, marker)) {
          return `contains the self-announcing placeholder marker "${marker}"`;
        }
      }
    }
  }
  return undefined;
}

/**
 * The reason `value` states no rule, or `undefined` when it plausibly does.
 *
 * Exported so activation tests and future loaders can probe the matcher
 * directly; the schema refusal below routes through it.
 *
 * THE UNICODE RULE (round-2 review, M1c — stated exactly, because round 1's
 * normalization could LAUNDER a lookalike into acceptance by discarding its
 * non-ASCII letters):
 *
 * 1. The value is NFKC-normalized first, so fullwidth/stylized forms
 *    (`"ＴＢＤ"`, `"𝐓𝐁𝐃"`) reach the matcher as their ASCII equivalents.
 * 2. Any token that mixes Latin with non-Latin letters is REFUSED outright
 *    (`"ТВD"`): mixed script inside a token is confusable by construction,
 *    and refusal — never silent normalization — is the only safe response.
 * 3. Every known Cyrillic/Greek homoglyph is folded to its ASCII form
 *    ({@link CONFUSABLE_TO_ASCII}), and any letter that is STILL non-Latin
 *    after the fold refuses the value outright (round-3 review, M1c
 *    structural rule — see {@link unmappedNonLatinLetter}): a leftover
 *    letter is either an unmapped confusable (`"τβϲ"` folding to `"tbϲ"`)
 *    or genuinely non-Latin content, and both fail closed rather than being
 *    stripped into acceptance. The fold table's completeness is therefore
 *    not load-bearing: an unmapped lookalike is refused, never laundered.
 * 4. The ASCII rules then run over THREE candidates, refusing on any hit:
 *    the value itself; the homoglyph-folded value (so an all-Cyrillic
 *    `"ТВ…"` lookalike is read as what it visually spells); and the value
 *    with every non-printable-ASCII character REMOVED (so a marker split by
 *    zero-width or soft-hyphen characters — `"tb­d"` — reassembles into
 *    the form it was hiding; after rule 3, stripping can only remove
 *    NON-LETTER characters, so it can no longer delete an unmapped marker).
 * 5. A value with NO readable ASCII content at all is refused by the
 *    empty-normalization rule. When in doubt this matcher REFUSES: a false
 *    refusal of legitimate policy text is recoverable at review time; a
 *    placeholder reaching `REVIEWED_MODEL_BACKED` is not.
 */
export function placeholderRuleTextReason(value: string): string | undefined {
  const canonical = value.normalize("NFKC");

  const mixed = mixedScriptToken(canonical);
  if (mixed !== undefined) {
    return `mixes Unicode scripts inside the token "${mixed}" (confusable by construction; refused rather than normalized)`;
  }

  const lower = canonical.toLowerCase();
  const folded = confusablesFolded(lower);
  const leftover = unmappedNonLatinLetter(folded);
  if (leftover !== undefined) {
    return `contains the non-Latin letter "${leftover}" after folding known homoglyphs to ASCII (an unmapped confusable or non-Latin content; refused rather than stripped)`;
  }

  const candidates: readonly (readonly [string, string])[] = [
    [lower, ""],
    [folded, " after folding Unicode homoglyphs to ASCII"],
    [lower.replace(NON_ASCII_PRINTABLE, ""), " after stripping non-ASCII characters"],
  ];
  for (const [candidate, how] of candidates) {
    const reason = asciiPlaceholderReason(candidate);
    if (reason !== undefined) {
      return `${reason}${how}`;
    }
  }
  return undefined;
}

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
    const placeholderReason = placeholderRuleTextReason(value);
    if (placeholderReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `states a placeholder rather than a rule (${placeholderReason}); ADR-009 §5.4 requires a stated policy`,
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
