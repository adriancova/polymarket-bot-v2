/**
 * The control API's configuration door — ADR-020 §5, the same shape as
 * `apps/trader/src/config.ts`.
 *
 * Operator configuration is caller-supplied by definition, so this door
 * performs all four D1-D4 steps (see `doors.ts`). Every field is REQUIRED:
 * a `.default()` is exactly the class `docs/contracts/schema-boundary.md` §2
 * records as "Defaults defeated" — a get-only inherited accessor on a defaulted
 * key makes the parse succeed while the default never lands as an own property,
 * so any check gated on it silently skips. `apps/data-gateway`'s
 * `parseGatewayConfig` is recorded LIVE ×2 in that document for precisely this.
 *
 * ## §15: loopback only, and it is refused rather than warned about
 *
 * > "No public network exposure for PostgreSQL, Redis, or internal metrics
 * > endpoints."
 *
 * This process serves an internal metrics endpoint and an operator control
 * surface. {@link LOOPBACK_HOSTS} is the closed set of bind hosts it accepts;
 * `0.0.0.0`, `::` and any routable address are refused BY NAME. A deployment
 * that needs off-host access owes it a terminator in front, which is a
 * deployment decision — and one that must be made explicitly rather than by
 * typing a different string into a config file.
 *
 * ## Tokens in the configuration document
 *
 * Operator tokens arrive here as strings and leave immediately as digests
 * (`auth.ts`). This door checks them for WEAKNESS — empty, short, duplicated,
 * or absent altogether — and every refusal names the operator id and the rule,
 * never the token. `config.test.ts` asserts that against a token value that
 * must not appear in any refusal.
 */

import { z } from "zod";

import { auditBudgetProblem } from "./audit-budget.js";
import { buildDoor, ownNumber, ownString, type DoorResult } from "./doors.js";
import { OPERATOR_GRANTS, type OperatorGrant } from "./auth.js";
import { TRADER_HALT_READ_TIMEOUT_MAX_MS } from "./adapters/postgres-trader-halts.js";

/**
 * The only hosts this process will bind.
 *
 * A closed set rather than a pattern: "does this address route off-host" is a
 * question with a surprising number of wrong answers (`0x7f000001`,
 * `127.1`, `::ffff:127.0.0.1`), and an allowlist of three literals has none of
 * them.
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  "127.0.0.1",
  "::1",
  "localhost",
]);

const OperatorSchema = z.strictObject({
  operatorId: z.string().min(1).max(128),
  token: z.string().min(1).max(512),
  grants: z.array(z.enum(OPERATOR_GRANTS)).min(1),
});

const ControlApiConfigSchema = z.strictObject({
  /** Bind host. Checked against {@link LOOPBACK_HOSTS} after the parse. */
  bindHost: z.string().min(1).max(128),
  bindPort: z.number().int().min(0).max(65_535),
  /** Maximum request body bytes. A bound, not a suggestion. */
  maxRequestBodyBytes: z.number().int().positive().max(1_048_576),
  /** Audit log capacity. Reaching it stops the control plane from mutating. */
  auditCapacity: z.number().int().positive().max(10_000_000),
  /**
   * `CONTROL-1` (closing `WP-240` r1 M-3): the audit budget's safety reserve
   * `R`. The last `R` records of `auditCapacity` are admitted only for an
   * applied kill-switch engage, and the `R` before them only for an applied
   * safety-direction action (`audit-budget.ts`). REQUIRED and at least 1, so a
   * deployment cannot run without it; `2R < auditCapacity` is checked after
   * the parse.
   */
  auditSafetyReserve: z.number().int().positive().max(5_000_000),
  /**
   * Where the trader health report comes from.
   *
   * `"none"` is an explicit, truthful choice: no trader is reporting, and
   * `control_trader_health_available` reads 0. It is spelled out rather than
   * being the absence of a field, so a deployment cannot omit the wiring by
   * accident and then read blank dashboards as calm markets.
   */
  traderHealth: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("http"),
      url: z.string().min(1).max(2048),
      timeoutMs: z.number().int().positive().max(60_000),
    }),
  ]),
  /**
   * `CONTROL-2` r1: where the open trader halts come from (`trader-halts.ts`).
   *
   * `"none"` reads nothing, and the state is `NOT_CONFIGURED` — said on
   * `/v1/health` and `/v1/metrics`, never "no halts". `"postgres"` reads the
   * open `TRADER_HALT:*` rows of `ops.incidents` on every authorized health
   * and metrics read, each read bounded by `timeoutMs`. The database URL is
   * NOT a field here: it carries a credential, so it comes from the
   * environment variable `main.ts` names (`TRADER_HALTS_DATABASE_URL_ENV`),
   * read once at startup and never logged. REQUIRED, like `traderHealth`, so
   * a deployment cannot omit the choice by accident.
   */
  traderHalts: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("postgres"),
      timeoutMs: z.number().int().min(1).max(TRADER_HALT_READ_TIMEOUT_MAX_MS),
    }),
  ]),
  operators: z.array(OperatorSchema).min(1),
});

const ControlApiConfigDoor = buildDoor(
  ControlApiConfigSchema,
  "control API configuration",
  (materialized): ControlApiConfig => {
    const operatorsNode = materialized as { operators: readonly unknown[] };
    const traderHealthNode = (materialized as { traderHealth: unknown }).traderHealth;
    const kind = ownString(traderHealthNode, "kind") ?? "";
    const traderHealth: ControlApiConfig["traderHealth"] =
      kind === "http"
        ? Object.assign(Object.create(null) as object, {
            kind: "http" as const,
            url: ownString(traderHealthNode, "url") ?? "",
            timeoutMs: ownNumber(traderHealthNode, "timeoutMs") ?? 0,
          })
        : Object.assign(Object.create(null) as object, { kind: "none" as const });
    const traderHaltsNode = (materialized as { traderHalts: unknown }).traderHalts;
    const traderHalts: ControlApiConfig["traderHalts"] =
      ownString(traderHaltsNode, "kind") === "postgres"
        ? Object.assign(Object.create(null) as object, {
            kind: "postgres" as const,
            timeoutMs: ownNumber(traderHaltsNode, "timeoutMs") ?? 0,
          })
        : Object.assign(Object.create(null) as object, { kind: "none" as const });

    return Object.assign(Object.create(null) as object, {
      bindHost: ownString(materialized, "bindHost") ?? "",
      bindPort: ownNumber(materialized, "bindPort") ?? -1,
      maxRequestBodyBytes: ownNumber(materialized, "maxRequestBodyBytes") ?? -1,
      auditCapacity: ownNumber(materialized, "auditCapacity") ?? -1,
      auditSafetyReserve: ownNumber(materialized, "auditSafetyReserve") ?? -1,
      traderHealth,
      traderHalts,
      operators: operatorsNode.operators.map((entry) =>
        Object.assign(Object.create(null) as object, {
          operatorId: ownString(entry, "operatorId") ?? "",
          token: ownString(entry, "token") ?? "",
          grants: readGrants(entry),
        }),
      ),
    }) as ControlApiConfig;
  },
);

function readGrants(entry: unknown): readonly OperatorGrant[] {
  if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "grants")) return [];
  const grants = (entry as { grants: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  return grants.filter((grant): grant is OperatorGrant =>
    (OPERATOR_GRANTS as readonly string[]).includes(grant as string),
  );
}

export interface ControlApiOperatorConfig {
  readonly operatorId: string;
  readonly token: string;
  readonly grants: readonly OperatorGrant[];
}

export interface ControlApiConfig {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly maxRequestBodyBytes: number;
  readonly auditCapacity: number;
  /** The audit budget's safety reserve `R` (`audit-budget.ts`). */
  readonly auditSafetyReserve: number;
  readonly traderHealth:
    | { readonly kind: "none" }
    | { readonly kind: "http"; readonly url: string; readonly timeoutMs: number };
  /** `CONTROL-2` r1: the open trader halt source (`trader-halts.ts`); its database URL is the environment's. */
  readonly traderHalts: { readonly kind: "none" } | { readonly kind: "postgres"; readonly timeoutMs: number };
  readonly operators: readonly ControlApiOperatorConfig[];
}

export type ConfigRefusalCode =
  /** D1: the document is not plain own data. */
  | "CONTROL_CONFIG_NOT_DATA"
  /** D2: the document failed its schema. */
  | "CONTROL_CONFIG_INVALID"
  /** §15: the bind host is not loopback. */
  | "CONTROL_CONFIG_NOT_LOOPBACK"
  /** An operator credential is weak, duplicated, or unusable. */
  | "CONTROL_CONFIG_WEAK_OPERATOR"
  /** The trader health URL is not a loopback HTTP URL. */
  | "CONTROL_CONFIG_HEALTH_SOURCE_NOT_LOOPBACK"
  /** The audit safety reserve leaves no ordinary tier (`2R ≥ auditCapacity`). */
  | "CONTROL_CONFIG_AUDIT_BUDGET";

export interface ConfigRefusal {
  readonly code: ConfigRefusalCode;
  readonly detail: string;
  readonly issues: readonly string[];
}

export type ParseConfigResult =
  | { readonly ok: true; readonly config: ControlApiConfig }
  | { readonly ok: false; readonly refusals: readonly ConfigRefusal[] };

/** The shortest token this process accepts. See {@link MINIMUM_TOKEN_LENGTH}. */
export const MINIMUM_TOKEN_LENGTH = 32;

/**
 * Parses an operator-supplied configuration document.
 *
 * TOTAL, and it reports EVERY refusal rather than the first: a deployment being
 * repaired should see the whole list.
 */
export function parseControlApiConfig(document: unknown): ParseConfigResult {
  const parsed: DoorResult<ControlApiConfig> = ControlApiConfigDoor(document);
  if (!parsed.ok) {
    return {
      ok: false,
      refusals: [
        {
          code:
            parsed.refusal.code === "REQUEST_NOT_DATA"
              ? "CONTROL_CONFIG_NOT_DATA"
              : "CONTROL_CONFIG_INVALID",
          detail: parsed.refusal.detail,
          issues: parsed.refusal.issues,
        },
      ],
    };
  }

  const config = parsed.value;
  const refusals: ConfigRefusal[] = [];

  if (!LOOPBACK_HOSTS.includes(config.bindHost)) {
    refusals.push({
      code: "CONTROL_CONFIG_NOT_LOOPBACK",
      detail:
        `bindHost=${config.bindHost} is not one of ${LOOPBACK_HOSTS.join(", ")}; §15 forbids ` +
        "public network exposure for an internal control or metrics endpoint, and a deployment " +
        "that needs off-host access owes it a terminator in front rather than a different string " +
        "in this field",
      issues: [],
    });
  }

  const budgetProblem = auditBudgetProblem({
    capacity: config.auditCapacity,
    safetyReserve: config.auditSafetyReserve,
  });
  if (budgetProblem !== undefined) {
    refusals.push({
      code: "CONTROL_CONFIG_AUDIT_BUDGET",
      detail:
        `${budgetProblem}. The audit budget reserves auditSafetyReserve records for kill-switch ` +
        "engages and as many again for safety-direction actions, and every other record shares " +
        "what is left; a budget with nothing left for refusals, resumes and releases is not a " +
        "budget this process will run with (README, 'The audit budget')",
      issues: [],
    });
  }

  if (config.traderHealth.kind === "http") {
    const url = config.traderHealth.url;
    const loopbackUrl = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/u.test(
      url,
    );
    if (!loopbackUrl) {
      refusals.push({
        code: "CONTROL_CONFIG_HEALTH_SOURCE_NOT_LOOPBACK",
        detail:
          `traderHealth.url=${url} is not a loopback http:// URL; this process reads a health ` +
          "document from a co-located trader and must not be pointed at an arbitrary endpoint " +
          "(§15, and a health source is an input this process trusts to shape its dashboards)",
        issues: [],
      });
    }
  }

  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  for (const operator of config.operators) {
    if (seenIds.has(operator.operatorId)) {
      refusals.push({
        code: "CONTROL_CONFIG_WEAK_OPERATOR",
        detail:
          `operator ${operator.operatorId} is configured twice; an audit record names the ` +
          "operator, and two operators sharing one id makes the audit log unable to say who acted",
        issues: [],
      });
    }
    seenIds.add(operator.operatorId);

    if (operator.token.length < MINIMUM_TOKEN_LENGTH) {
      refusals.push({
        code: "CONTROL_CONFIG_WEAK_OPERATOR",
        detail:
          `operator ${operator.operatorId} has a token shorter than ${String(MINIMUM_TOKEN_LENGTH)} ` +
          "characters; the value is not printed, and a guessable operator credential is a control " +
          "surface anyone can reach",
        issues: [],
      });
    }
    if (seenTokens.has(operator.token)) {
      refusals.push({
        code: "CONTROL_CONFIG_WEAK_OPERATOR",
        detail:
          `operator ${operator.operatorId} shares a token with another operator; the value is not ` +
          "printed, and a shared credential makes the audit log's actor field a guess",
        issues: [],
      });
    }
    seenTokens.add(operator.token);
  }

  return refusals.length === 0
    ? { ok: true, config }
    : { ok: false, refusals: Object.freeze(refusals) };
}
