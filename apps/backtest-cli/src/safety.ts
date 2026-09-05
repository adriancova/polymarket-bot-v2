/**
 * Startup safety validation for a BACKTEST process (§6 invariant 17, §11, ADR-010).
 *
 * §11: `BACKTEST` is "Historical replay / Simulated / **None**" — no credentials
 * at all. §6 invariant 17: "A real key cannot be loaded by paper or backtest
 * processes. **Startup validation rejects this configuration.**"
 *
 * So this module is the rejection. It runs before anything else and refuses the
 * process rather than warning, because a process that has already read a key has
 * already failed the invariant.
 *
 * `AGENTS.md`'s untouchable defaults — `MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`,
 * `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` — are checked here as a FLOOR: this app
 * never raises them, never defaults them upward, and refuses to start if the
 * environment tries to.
 */

/** The only run mode this process serves. §11: simulated execution, no credentials. */
export const BACKTEST_RUN_MODE = "BACKTEST" as const;

/**
 * Environment names that indicate a real key or credential.
 *
 * Matched case-insensitively as SUFFIXES/substrings of the variable name, so a
 * deployment-specific prefix (`PROD_`, `POLYMARKET_`) does not evade the check.
 * The list is deliberately broad: a false refusal costs a rename, and a false
 * acceptance costs invariant 17.
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

/** One reason the process may not start. */
export interface SafetyViolation {
  readonly code:
    | "BACKTEST_CREDENTIAL_PRESENT"
    | "BACKTEST_RUN_MODE_CEILING_RAISED"
    | "BACKTEST_REAL_ORDERS_ENABLED"
    | "BACKTEST_LIVE_MICRO_CAP_NONZERO";
  readonly detail: string;
}

export type SafetyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly SafetyViolation[] };

/**
 * Validates the environment a backtest process is about to run in.
 *
 * Pure: it reads the record it is given, never `process.env` directly, so the
 * rule is testable without mutating the ambient environment.
 */
export function checkBacktestSafety(env: Readonly<Record<string, string | undefined>>): SafetyOutcome {
  const violations: SafetyViolation[] = [];

  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    const upper = name.toUpperCase();
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      if (upper.includes(pattern)) {
        violations.push({
          code: "BACKTEST_CREDENTIAL_PRESENT",
          // The NAME is reported and the VALUE never is.
          detail: `${name} looks like a credential (matches ${pattern}); §11 gives BACKTEST no credentials and §6 invariant 17 rejects a process that could load a real key`,
        });
        break;
      }
    }
  }

  const maxRunMode = env["MAX_RUN_MODE"];
  if (maxRunMode !== undefined && maxRunMode !== "" && maxRunMode !== "PAPER" && maxRunMode !== "BACKTEST") {
    violations.push({
      code: "BACKTEST_RUN_MODE_CEILING_RAISED",
      detail: `MAX_RUN_MODE=${maxRunMode} is above the repository maximum PAPER (AGENTS.md); this process refuses to start under a raised ceiling`,
    });
  }

  const allowRealOrders = env["ALLOW_REAL_ORDERS"];
  if (allowRealOrders !== undefined && allowRealOrders !== "" && allowRealOrders !== "false") {
    violations.push({
      code: "BACKTEST_REAL_ORDERS_ENABLED",
      detail: `ALLOW_REAL_ORDERS=${allowRealOrders} is not false (AGENTS.md); a simulated venue places no order and this process refuses to run under a configuration that says otherwise`,
    });
  }

  for (const cap of ["LIVE_MICRO_MAX_ORDER_NOTIONAL", "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE"]) {
    const value = env[cap];
    if (value !== undefined && value !== "" && value !== "0") {
      violations.push({
        code: "BACKTEST_LIVE_MICRO_CAP_NONZERO",
        detail: `${cap}=${value} is not 0 (AGENTS.md); the live-micro caps are zero and this process refuses to run under a raised one`,
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
