/**
 * Startup safety validation for the PAPER control API (§0.2, §6 invariant 17,
 * §11, §15, ADR-010) — and `WP-240` acceptance 1's *startup* half.
 *
 * This module is the process's first act and its only veto. It runs BEFORE any
 * configuration is parsed, any credential is read and any socket is bound,
 * because a process that has already read a credential has already failed §6
 * invariant 17.
 *
 * ## Acceptance 1 has two halves and this is the first
 *
 * > "Control API cannot raise mode above process maximum."
 *
 * The **request** half is structural: no route, no body field and no query
 * parameter of this API names a run mode, so there is nothing to refuse (see
 * `vocabulary.ts` and `control-plane.ts`). What remains is the STARTUP half —
 * a deployment that tries to give this process a ceiling above the repository
 * maximum, or a run mode above its own ceiling. That is refused here, and it is
 * **never clamped**: a clamp turns an operator's attempt to raise the ceiling
 * into a silent no-op, and the next attempt is made with more confidence.
 *
 * `apps/trader/src/safety.ts` makes the identical argument for the identical
 * reason. The two are separate implementations because
 * `docs/contracts/dependency-direction.md` §2 forbids one app depending on
 * another (F10); the **name tables** they scan are now shared through
 * `@polymarket-bot/observability` (a legal downward edge), and
 * `test/integration/control-api/paper-safety-drift.test.ts` pins the two
 * enumerations equal so they cannot drift apart silently.
 *
 * ## §15's "no public network exposure" is checked here too
 *
 * > "No public network exposure for PostgreSQL, Redis, or internal metrics
 * > endpoints."
 *
 * This process serves an internal metrics endpoint. A bind host outside the
 * loopback range refuses startup by name rather than being quietly accepted —
 * the check is in `config.ts`, at the door that reads the host, and this
 * module's job is the environment.
 *
 * PURITY. Every function reads the record it is GIVEN. Nothing here touches
 * `process.env`, so the rule is testable without mutating the ambient
 * environment and a test cannot prove the check by arranging the very thing it
 * detects.
 *
 * NOTHING HERE PRINTS A VALUE — not a scanned environment value, and above all
 * not an operator token.
 */

import {
  RUN_MODES,
  RUN_MODE_PLACES_REAL_ORDERS,
  RUN_MODE_REQUIRES_LIVE_SIGNER,
  runModeExceeds,
  type RunMode,
} from "@polymarket-bot/domain";
import { scanEnvironmentForProductionNames } from "@polymarket-bot/observability";

/** The repository ceiling. `AGENTS.md` / ADR-010 §1: this may not be weakened. */
export const REPOSITORY_MAXIMUM_RUN_MODE = "PAPER" as const;

/**
 * The only mode this process serves.
 *
 * The control API places no order in ANY mode — it has no venue connection and
 * no signer — so a mode above `PAPER` would be a claim about a capability it
 * does not have.
 */
export const CONTROL_API_RUN_MODE = "PAPER" as const;

export type ControlSafetyViolationCode =
  /** §15 / ADR-010 §3: an enumerated production secret name is present. */
  | "PAPER_PRODUCTION_SECRET_NAME_PRESENT"
  /** ADR-010 §3 rule 1: an account-identifying production name is present. */
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

export interface ControlSafetyViolation {
  readonly code: ControlSafetyViolationCode;
  /** Names the variable and the rule. NEVER carries a value of a scanned name. */
  readonly detail: string;
}

export type ControlSafetyOutcome =
  | { readonly ok: true; readonly runMode: typeof CONTROL_API_RUN_MODE }
  | { readonly ok: false; readonly violations: readonly ControlSafetyViolation[] };

export type Environment = Readonly<Record<string, string | undefined>>;

function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Validates the environment a PAPER control API is about to start in.
 *
 * TOTAL: every failure is data, and every violation is reported rather than the
 * first, so an operator repairing a deployment sees the whole list.
 */
export function checkControlApiSafety(env: Environment): ControlSafetyOutcome {
  const violations: ControlSafetyViolation[] = [
    // The ADR-010 §3 name scan, from the shared table.
    ...scanEnvironmentForProductionNames(env).map((finding) => ({
      code: finding.code satisfies ControlSafetyViolationCode as ControlSafetyViolationCode,
      detail: finding.detail,
    })),
  ];

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
          `${REPOSITORY_MAXIMUM_RUN_MODE} (AGENTS.md, ADR-010 §1); the ceiling is a floor this ` +
          "process refuses to raise — it is never clamped, because a clamp turns an attempt to " +
          "raise the ceiling into a silent no-op",
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
    } else {
      // NOT an else-if chain, deliberately. `apps/trader/src/safety.ts` reports
      // the FIRST reason a mode is impermissible; this module reports EVERY
      // reason, because the reasons are independent facts about the deployment
      // and an operator who fixes only the one they were shown will raise the
      // ceiling and then meet the signer refusal. Saying both at once is the
      // difference between one repair and two.
      if (runModeExceeds(configuredMode, ceiling)) {
        violations.push({
          code: "PAPER_RUN_MODE_NOT_PERMITTED",
          detail:
            `RUN_MODE=${configuredMode} exceeds the process maximum ${ceiling} ` +
            "(§11: a process's maximum mode cannot be raised above the startup maximum, and the " +
            "control API is the surface §11 names as unable to raise it)",
        });
      }
      if (
        RUN_MODE_PLACES_REAL_ORDERS[configuredMode] ||
        RUN_MODE_REQUIRES_LIVE_SIGNER[configuredMode]
      ) {
        violations.push({
          code: "PAPER_RUN_MODE_NOT_PERMITTED",
          detail:
            `RUN_MODE=${configuredMode} places real orders or requires a live signer (§11); the ` +
            "control API never has the signing key (§4.1) and has no venue connection, so it " +
            "refuses the mode by name",
        });
      }
      if (
        configuredMode !== CONTROL_API_RUN_MODE &&
        !runModeExceeds(configuredMode, ceiling) &&
        !RUN_MODE_PLACES_REAL_ORDERS[configuredMode] &&
        !RUN_MODE_REQUIRES_LIVE_SIGNER[configuredMode]
      ) {
        violations.push({
          code: "PAPER_RUN_MODE_NOT_PERMITTED",
          detail:
            `RUN_MODE=${configuredMode} is not ${CONTROL_API_RUN_MODE}; this process serves exactly ` +
            "one mode and refuses to pretend otherwise",
        });
      }
    }
  }

  const allowRealOrders = env["ALLOW_REAL_ORDERS"];
  if (allowRealOrders !== undefined && allowRealOrders !== "" && allowRealOrders !== "false") {
    violations.push({
      code: "PAPER_REAL_ORDERS_ENABLED",
      detail:
        `ALLOW_REAL_ORDERS=${allowRealOrders} is not false (AGENTS.md, ADR-010 §1); this process ` +
        "has no order path at all and refuses a configuration that says otherwise",
    });
  }

  for (const cap of ["LIVE_MICRO_MAX_ORDER_NOTIONAL", "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE"] as const) {
    const value = env[cap];
    if (value !== undefined && value !== "" && value !== "0") {
      violations.push({
        code: "PAPER_LIVE_MICRO_CAP_NONZERO",
        detail:
          `${cap}=${value} is not 0 (AGENTS.md, ADR-010 §1); the live-micro caps are zero and ` +
          "this process refuses to run under a raised one",
      });
    }
  }

  return violations.length === 0
    ? { ok: true, runMode: CONTROL_API_RUN_MODE }
    : { ok: false, violations: Object.freeze(violations) };
}
