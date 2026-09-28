/**
 * Startup safety validation for the PAPER trader (§0.2, §6 invariant 17, §11,
 * §15, ADR-010).
 *
 * This module is the process's first act and its only veto. It runs BEFORE any
 * configuration is parsed, any book is built, any strategy is loaded and any
 * port is opened, because a process that has already read a credential has
 * already failed §6 invariant 17 — the check exists to stop the read, not to
 * report it afterwards.
 *
 * Two of `WP-230`'s four acceptance criteria are here:
 *
 * 1. **`MAX_RUN_MODE=PAPER` is enforced.** The repository ceiling is `PAPER`
 *    (`AGENTS.md`, ADR-010 §1). A configured maximum ABOVE it refuses startup;
 *    it is never clamped, because clamping turns an operator's attempt to raise
 *    the ceiling into a silent no-op and the next attempt is made with more
 *    confidence. A configured RUN MODE above the process maximum refuses on the
 *    same ground (§11: "A process has a maximum allowed mode. It cannot be
 *    raised through the control API above the startup maximum"), and a run mode
 *    that places real orders or requires a live signer is refused BY NAME even
 *    if some future ceiling admitted it — this process has no signer and no
 *    venue connection, so it may not claim a mode that needs one.
 * 2. **Production secret names are rejected.** §15: "A paper environment cannot
 *    reference production secret names." Not *hold the secret* — reference the
 *    NAME, so a misconfiguration cannot silently pick up a real value. The
 *    names are not guessed: ADR-010 §3 enumerates them from the venue report
 *    (`docs/venue/verified-2026-08-24.md` §16), split into secret material
 *    (§16.1), account-identifying (§16.2) and public builder attribution
 *    (§16.3). ADR-010 §3 rule 1 builds the deny-list from §16.1 **plus** §16.2
 *    ("an account-identifying value is not a secret, but a paper process
 *    referencing a real one identifies a real account"), and rule 2 forbids
 *    describing `POLYMARKET_BUILDER_CODE` as a credential while still refusing
 *    it — so it is refused under its own code, `PAPER_BUILDER_ATTRIBUTION_PRESENT`.
 *
 * WHAT "REFERENCE" MEANS HERE, precisely. A name is referenced when it is
 * PRESENT in the environment, whatever its value — including the empty string.
 * §15 is about the name, and an exported-but-empty `POLYMARKET_PRIVATE_KEY` is
 * a deployment that is one edit away from exporting the real one. This is
 * deliberately stricter than `apps/backtest-cli`'s scanner, which skips empty
 * values; that scanner answers a different question (does a VALUE look like a
 * credential) and both are kept.
 *
 * The generic pattern scan is kept beside the enumerated list and is
 * value-triggered, because it is a heuristic: it catches a deployment-specific
 * spelling nobody enumerated (`PROD_SIGNER_KEY`) without refusing every
 * environment that happens to export an empty `KEYSTORE_PATH`.
 *
 * PURITY. Every function here reads the record it is GIVEN. Nothing in this
 * module touches `process.env`, so the rule is testable without mutating the
 * ambient environment and a test cannot accidentally prove the check by
 * arranging the very thing it is meant to detect.
 *
 * NOTHING HERE PRINTS A VALUE. Refusals name the variable and never its
 * contents (§15: "Logs redact API keys, passphrases, signatures, signed order
 * payloads, and private wallet material").
 */

import {
  RUN_MODES,
  RUN_MODE_PLACES_REAL_ORDERS,
  RUN_MODE_REQUIRES_LIVE_SIGNER,
  runModeExceeds,
  type RunMode,
} from "@polymarket-bot/domain";

/** The repository ceiling. `AGENTS.md` / ADR-010 §1: this may not be weakened. */
export const REPOSITORY_MAXIMUM_RUN_MODE = "PAPER" as const;

/** The only mode this process serves. §11: live data, simulated execution, public credentials only. */
export const TRADER_RUN_MODE = "PAPER" as const;

/**
 * ADR-010 §3, venue report §16.1 — secret material. Exact names, matched
 * case-sensitively as whole variable names AND case-insensitively as a
 * containment test, so `PROD_POLYMARKET_PRIVATE_KEY` cannot slip past by
 * carrying a deployment prefix.
 */
export const PRODUCTION_SECRET_NAMES: readonly string[] = Object.freeze([
  "POLYMARKET_PRIVATE_KEY",
  "SIGNER_PRIVATE_KEY",
  "POLYMARKET_BUILDER_API_KEY",
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
  "POLY_API_KEY",
  "POLY_PASSPHRASE",
  "POLY_SIGNATURE",
  "POLY_BUILDER_API_KEY",
  "POLY_BUILDER_PASSPHRASE",
  "POLY_BUILDER_SIGNATURE",
  "POLY_BUILDER_TIMESTAMP",
]);

/**
 * ADR-010 §3, venue report §16.2 — account-identifying, NOT secret.
 *
 * Refused all the same, and under rule 1's stated reason: a paper process that
 * references a real one identifies a real account.
 */
export const PRODUCTION_ACCOUNT_NAMES: readonly string[] = Object.freeze([
  "POLYMARKET_WALLET_ADDRESS",
  "POLY_ADDRESS",
  "POLY_TIMESTAMP",
]);

/**
 * ADR-010 §3, venue report §16.3 — public builder attribution.
 *
 * NOT a credential (rule 2, and the venue report is emphatic). Refused so no
 * paper deployment carries a real builder's attribution value, under a code
 * that says what it is.
 */
export const BUILDER_ATTRIBUTION_NAMES: readonly string[] = Object.freeze([
  "POLYMARKET_BUILDER_CODE",
]);

/**
 * Heuristic substrings for a credential-shaped name nobody enumerated.
 *
 * Value-triggered (an empty value does not fire) because this list is broad by
 * design and a false refusal on an unset variable would be noise. The
 * enumerated lists above do not use this rule — for a name ADR-010 names, the
 * presence IS the violation.
 */
export const CREDENTIAL_NAME_PATTERNS: readonly string[] = Object.freeze([
  "PRIVATE_KEY",
  "PRIVKEY",
  "SIGNER_KEY",
  "SIGNING_KEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "API_SECRET",
  "SECRET_KEY",
  "CLOB_SECRET",
  "CLOB_PASSPHRASE",
  "PASSPHRASE",
  "WALLET_KEY",
  "KEYSTORE",
]);

export type SafetyViolationCode =
  /** §15 / ADR-010 §3: an enumerated production secret name is present. */
  | "PAPER_PRODUCTION_SECRET_NAME_PRESENT"
  /** §15 / ADR-010 §3 rule 1: an account-identifying production name is present. */
  | "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT"
  /** ADR-010 §3 rule 2: public builder attribution — refused, not called a credential. */
  | "PAPER_BUILDER_ATTRIBUTION_PRESENT"
  /** A credential-shaped name the enumerations do not carry, with a value. */
  | "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT"
  /** `MAX_RUN_MODE` is above the repository ceiling. */
  | "PAPER_RUN_MODE_CEILING_RAISED"
  /** `MAX_RUN_MODE` is not a §11 run mode at all. */
  | "PAPER_RUN_MODE_CEILING_UNREADABLE"
  /** `RUN_MODE` exceeds the process maximum, or names a real-order mode. */
  | "PAPER_RUN_MODE_NOT_PERMITTED"
  /** `ALLOW_REAL_ORDERS` is anything but `false`. */
  | "PAPER_REAL_ORDERS_ENABLED"
  /** A live-micro cap is anything but `0`. */
  | "PAPER_LIVE_MICRO_CAP_NONZERO";

export interface SafetyViolation {
  readonly code: SafetyViolationCode;
  /** Names the variable and the rule. NEVER carries a value of a scanned name. */
  readonly detail: string;
}

export type SafetyOutcome =
  | { readonly ok: true; readonly runMode: typeof TRADER_RUN_MODE }
  | { readonly ok: false; readonly violations: readonly SafetyViolation[] };

export type Environment = Readonly<Record<string, string | undefined>>;

function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Every own environment name, read once each. `Object.keys` rather than
 * `for…in`: an inherited name is not a name this deployment exported, and
 * refusing on one would make an unrelated `Object.prototype` write refuse
 * every start.
 */
function names(env: Environment): readonly string[] {
  return Object.keys(env);
}

function scanNames(
  env: Environment,
  enumerated: readonly string[],
  code: SafetyViolationCode,
  because: string,
  violations: SafetyViolation[],
  flagged: Set<string>,
): void {
  for (const name of names(env)) {
    const upper = name.toUpperCase();
    for (const forbidden of enumerated) {
      if (upper === forbidden || upper.includes(forbidden)) {
        flagged.add(name);
        violations.push({
          code,
          detail:
            `${name} references the production name ${forbidden}; ${because} ` +
            "(§15: a paper environment cannot reference production secret names; ADR-010 §3)",
        });
        break;
      }
    }
  }
}

/**
 * Validates the environment a PAPER trader is about to start in.
 *
 * TOTAL: every failure is data. It reports EVERY violation rather than the
 * first, so an operator repairing a deployment sees the whole list instead of
 * discovering the next one on the next start.
 */
export function checkPaperTraderSafety(env: Environment): SafetyOutcome {
  const violations: SafetyViolation[] = [];
  const flagged = new Set<string>();

  // --- §15 / ADR-010 §3: the enumerated production names --------------------
  scanNames(
    env,
    PRODUCTION_SECRET_NAMES,
    "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    "§11 gives PAPER public credentials only and §6 invariant 17 rejects a " +
      "process that could load a real key",
    violations,
    flagged,
  );
  scanNames(
    env,
    PRODUCTION_ACCOUNT_NAMES,
    "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT",
    "an account-identifying value is not a secret, but a paper process " +
      "referencing a real one identifies a real account (ADR-010 §3 rule 1)",
    violations,
    flagged,
  );
  scanNames(
    env,
    BUILDER_ATTRIBUTION_NAMES,
    "PAPER_BUILDER_ATTRIBUTION_PRESENT",
    "this is PUBLIC builder attribution and not a credential (ADR-010 §3 rule 2), " +
      "and it is refused so no paper deployment carries a real builder's value",
    violations,
    flagged,
  );

  // --- the heuristic, value-triggered ---------------------------------------
  for (const name of names(env)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (flagged.has(name)) continue;
    const upper = name.toUpperCase();
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      if (upper.includes(pattern)) {
        violations.push({
          code: "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
          detail:
            `${name} is a credential-shaped name carrying a value (matches ${pattern}); ` +
            "a PAPER process holds no credential (§11) and refuses rather than ignore it",
        });
        break;
      }
    }
  }

  // --- the four untouchable defaults, checked as FLOORS ---------------------
  const configuredCeiling = env["MAX_RUN_MODE"];
  let ceiling: RunMode = REPOSITORY_MAXIMUM_RUN_MODE;
  if (configuredCeiling !== undefined && configuredCeiling !== "") {
    if (!isRunMode(configuredCeiling)) {
      violations.push({
        code: "PAPER_RUN_MODE_CEILING_UNREADABLE",
        detail:
          `MAX_RUN_MODE=${configuredCeiling} is not one of the §11 run modes ` +
          `(${RUN_MODES.join(", ")}); an unreadable ceiling is refused, never defaulted`,
      });
    } else if (runModeExceeds(configuredCeiling, REPOSITORY_MAXIMUM_RUN_MODE)) {
      violations.push({
        code: "PAPER_RUN_MODE_CEILING_RAISED",
        detail:
          `MAX_RUN_MODE=${configuredCeiling} is above the repository maximum ` +
          `${REPOSITORY_MAXIMUM_RUN_MODE} (AGENTS.md, ADR-010 §1); the ceiling is a floor ` +
          "this process refuses to raise — it is never clamped, because a clamp turns an " +
          "attempt to raise the ceiling into a silent no-op",
      });
    } else {
      ceiling = configuredCeiling;
    }
  }

  const configuredMode = env["RUN_MODE"];
  if (configuredMode !== undefined && configuredMode !== "") {
    if (!isRunMode(configuredMode)) {
      violations.push({
        code: "PAPER_RUN_MODE_NOT_PERMITTED",
        detail:
          `RUN_MODE=${configuredMode} is not one of the §11 run modes ` +
          `(${RUN_MODES.join(", ")})`,
      });
    } else if (runModeExceeds(configuredMode, ceiling)) {
      violations.push({
        code: "PAPER_RUN_MODE_NOT_PERMITTED",
        detail:
          `RUN_MODE=${configuredMode} exceeds the process maximum ${ceiling} ` +
          "(§11: a process's maximum mode cannot be raised above the startup maximum)",
      });
    } else if (
      RUN_MODE_PLACES_REAL_ORDERS[configuredMode] ||
      RUN_MODE_REQUIRES_LIVE_SIGNER[configuredMode]
    ) {
      violations.push({
        code: "PAPER_RUN_MODE_NOT_PERMITTED",
        detail:
          `RUN_MODE=${configuredMode} places real orders or requires a live signer (§11); ` +
          "this process has neither a signer nor a venue connection and refuses the mode by name",
      });
    } else if (configuredMode !== TRADER_RUN_MODE) {
      violations.push({
        code: "PAPER_RUN_MODE_NOT_PERMITTED",
        detail:
          `RUN_MODE=${configuredMode} is not ${TRADER_RUN_MODE}; the paper trader serves ` +
          "exactly one mode and refuses to pretend otherwise",
      });
    }
  }

  const allowRealOrders = env["ALLOW_REAL_ORDERS"];
  if (allowRealOrders !== undefined && allowRealOrders !== "" && allowRealOrders !== "false") {
    violations.push({
      code: "PAPER_REAL_ORDERS_ENABLED",
      detail:
        `ALLOW_REAL_ORDERS=${allowRealOrders} is not false (AGENTS.md, ADR-010 §1); a ` +
        "simulated venue places no order and this process refuses a configuration that says otherwise",
    });
  }

  for (const cap of ["LIVE_MICRO_MAX_ORDER_NOTIONAL", "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE"] as const) {
    const value = env[cap];
    if (value !== undefined && value !== "" && value !== "0") {
      violations.push({
        code: "PAPER_LIVE_MICRO_CAP_NONZERO",
        detail:
          `${cap}=${value} is not 0 (AGENTS.md, ADR-010 §1); the live-micro caps are zero ` +
          "and this process refuses to run under a raised one",
      });
    }
  }

  return violations.length === 0
    ? { ok: true, runMode: TRADER_RUN_MODE }
    : { ok: false, violations: Object.freeze(violations) };
}
