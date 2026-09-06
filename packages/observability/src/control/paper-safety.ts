/**
 * The PAPER deployment's operational safety vocabulary — ADR-010 §3, handoff
 * §15 — as pure data, so every operator surface in the platform can be scanned
 * against ONE table.
 *
 * ## Why this table lives in `packages/observability`
 *
 * `apps/trader/src/safety.ts` (`WP-230`) carries the same three enumerations
 * and the same heuristic pattern list. Apps are layer-3 composition roots and
 * **nothing may depend on an app** (`docs/contracts/dependency-direction.md`
 * §2, F10), so a second app cannot import the trader's copy, and this package
 * is the lowest layer `WP-240` owns. Putting the data here means:
 *
 * - `apps/control-api` scans its environment against the same names the trader
 *   refuses, over a legal downward edge (layer 3 → layer 1);
 * - the Grafana dashboards and their READMEs are scanned against the same
 *   names, in `packages/observability`'s own test tree, with no app import;
 * - the two copies that now exist repo-wide (`apps/trader`'s and this one) are
 *   pinned equal by `test/integration/control-api/paper-safety-drift.test.ts`,
 *   which is the only place in the repository that may alias both trees.
 *
 * **Collapsing `apps/trader`'s copy onto this table is a follow-up**, not
 * something `WP-240` may do: `apps/trader/**` is outside this package's grant
 * and its safety module is load-bearing for two of `WP-230`'s accepted
 * criteria. The drift guard is the interim mechanism, and it fails loudly.
 *
 * ## Purity
 *
 * `packages/observability` is layer 1 and F17 forbids **any** Node built-in in
 * its production source. Nothing here reads an environment, a clock, a file or
 * a process global: every function takes the record it is given. That is also
 * what makes the scanner testable without mutating the ambient environment.
 *
 * ## Nothing here prints a value
 *
 * §15: "Logs redact API keys, passphrases, signatures, signed order payloads,
 * and private wallet material." Every finding names the VARIABLE and the rule
 * that refused it; no finding carries the contents of a scanned name.
 */

/**
 * ADR-010 §3 / venue report §16.1 — secret material.
 *
 * Verbatim from `apps/trader/src/safety.ts`'s `PRODUCTION_SECRET_NAMES`; the
 * drift guard pins the two equal.
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
 * ADR-010 §3 / venue report §16.2 — account-identifying, NOT secret.
 *
 * Refused all the same and under rule 1's stated reason: a paper process that
 * references a real one identifies a real account.
 */
export const PRODUCTION_ACCOUNT_NAMES: readonly string[] = Object.freeze([
  "POLYMARKET_WALLET_ADDRESS",
  "POLY_ADDRESS",
  "POLY_TIMESTAMP",
]);

/**
 * ADR-010 §3 / venue report §16.3 — PUBLIC builder attribution.
 *
 * Not a credential (rule 2, and the venue report is emphatic). Refused under a
 * code that says what it is, so no paper deployment carries a real builder's
 * attribution value.
 */
export const BUILDER_ATTRIBUTION_NAMES: readonly string[] = Object.freeze([
  "POLYMARKET_BUILDER_CODE",
]);

/**
 * Heuristic substrings for a credential-shaped name nobody enumerated.
 *
 * Value-triggered where it is applied to an environment (an empty value does
 * not fire), because the list is broad by design. On a static artifact — a
 * dashboard, a README — the NAME alone is the finding, because an artifact
 * checked into the repository has no "unset" state.
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

/** Every enumerated production name, in one list, for an artifact scan. */
export const ALL_PRODUCTION_NAMES: readonly string[] = Object.freeze([
  ...PRODUCTION_SECRET_NAMES,
  ...PRODUCTION_ACCOUNT_NAMES,
  ...BUILDER_ATTRIBUTION_NAMES,
]);

/**
 * Tokens that would make an operator surface imply a live-execution control.
 *
 * `WP-240`'s acceptance 1 is that the control API cannot raise the run mode
 * above the process maximum, and its design answer is that such a control is
 * **unrepresentable**. A dashboard is an operator surface too: a panel titled
 * "Enable live orders" would be a control an operator looks for and a
 * reviewer's reasonable question. So the artifacts are scanned for the
 * vocabulary as well, and the scan is data rather than prose.
 *
 * Matched case-insensitively as substrings of an artifact's own control-bearing
 * text (a panel title, a link, a template variable), never of ordinary prose:
 * a dashboard description that SAYS "this dashboard exposes no live-mode
 * toggle" must remain writable.
 */
export const LIVE_MODE_CONTROL_TOKENS: readonly string[] = Object.freeze([
  "enable live",
  "go live",
  "live_micro",
  "live-micro",
  "allow_real_orders",
  "allow-real-orders",
  "raise mode",
  "set run mode",
  "set_run_mode",
  "max_run_mode",
  "signer",
  "private key",
]);

/** One reason an environment or artifact failed the paper scan. */
export interface PaperSafetyFinding {
  readonly code: PaperSafetyFindingCode;
  /** Names the variable/field and the rule. NEVER carries a scanned value. */
  readonly detail: string;
}

export type PaperSafetyFindingCode =
  /** §15 / ADR-010 §3: an enumerated production secret name is present. */
  | "PAPER_PRODUCTION_SECRET_NAME_PRESENT"
  /** ADR-010 §3 rule 1: an account-identifying production name is present. */
  | "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT"
  /** ADR-010 §3 rule 2: public builder attribution — refused, not called a credential. */
  | "PAPER_BUILDER_ATTRIBUTION_PRESENT"
  /** A credential-shaped name the enumerations do not carry, with a value. */
  | "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT";

/**
 * Scans an environment record for the ADR-010 §3 names.
 *
 * TOTAL: every failure is data, and every violation is reported rather than
 * the first — an operator repairing a deployment sees the whole list instead
 * of discovering the next one on the next start.
 *
 * "Referenced" means PRESENT, whatever the value, including the empty string,
 * for the enumerated lists: §15 is about the NAME, and an exported-but-empty
 * `POLYMARKET_PRIVATE_KEY` is a deployment one edit away from exporting the
 * real one. The heuristic list is value-triggered for the reason its own
 * comment gives.
 */
export function scanEnvironmentForProductionNames(
  env: Readonly<Record<string, string | undefined>>,
): readonly PaperSafetyFinding[] {
  const findings: PaperSafetyFinding[] = [];
  const flagged = new Set<string>();

  const scan = (
    enumerated: readonly string[],
    code: PaperSafetyFindingCode,
    because: string,
  ): void => {
    for (const name of Object.keys(env)) {
      const upper = name.toUpperCase();
      for (const forbidden of enumerated) {
        if (upper === forbidden || upper.includes(forbidden)) {
          flagged.add(name);
          findings.push({
            code,
            detail:
              `${name} references the production name ${forbidden}; ${because} ` +
              "(§15: a paper environment cannot reference production secret names; ADR-010 §3)",
          });
          break;
        }
      }
    }
  };

  scan(
    PRODUCTION_SECRET_NAMES,
    "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    "§11 gives PAPER public credentials only and §6 invariant 17 rejects a " +
      "process that could load a real key",
  );
  scan(
    PRODUCTION_ACCOUNT_NAMES,
    "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT",
    "an account-identifying value is not a secret, but a paper process " +
      "referencing a real one identifies a real account (ADR-010 §3 rule 1)",
  );
  scan(
    BUILDER_ATTRIBUTION_NAMES,
    "PAPER_BUILDER_ATTRIBUTION_PRESENT",
    "this is PUBLIC builder attribution and not a credential (ADR-010 §3 rule 2), " +
      "and it is refused so no paper deployment carries a real builder's value",
  );

  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (flagged.has(name)) continue;
    const upper = name.toUpperCase();
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      if (upper.includes(pattern)) {
        findings.push({
          code: "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
          detail:
            `${name} is a credential-shaped name carrying a value (matches ${pattern}); ` +
            "a PAPER process holds no credential (§11) and refuses rather than ignore it",
        });
        break;
      }
    }
  }

  return Object.freeze(findings);
}

/**
 * Scans a static artifact's text for an enumerated production name.
 *
 * Used by the dashboard suite. Case-insensitive because a YAML/JSON artifact
 * may spell an environment reference in either case, and there is no
 * legitimate reason for one of these names to appear in a paper dashboard at
 * all — not even in a comment saying it must not.
 */
export function productionNamesInText(text: string): readonly string[] {
  const upper = text.toUpperCase();
  return Object.freeze(ALL_PRODUCTION_NAMES.filter((name) => upper.includes(name)));
}
