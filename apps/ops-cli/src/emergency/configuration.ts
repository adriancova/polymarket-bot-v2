/**
 * The ops configuration: operator policy, never venue fact (WP-310: "Limits
 * are configuration snapshots, not constants"; WP-290: the reconciliation
 * policy "has no default").
 *
 * ```json
 * {
 *   "schema": "polymarket-bot/ops-cli-configuration@1",
 *   "rateLimitSnapshots": [ { "schema": "polymarket-bot/rate-limit-configuration@1", ... } ],
 *   "maxBudgetWaitMs": 30000,
 *   "venueAnswerBoundMs": 30000,
 *   "reconciliation": {
 *     "collateralAssetId": "...",
 *     "quiescenceHorizonMs": 5000,
 *     "maxReadSpanMs": 2000,
 *     "holdingConfirmationMs": 1000,
 *     "requiredApprovalSpenders": ["0x..."]
 *   }
 * }
 * ```
 *
 * - `rateLimitSnapshots`: WP-310's dated snapshots, validated by
 *   `RateLimitBudget.create`. Every venue request the CLI makes is granted by
 *   that budget first; a request the snapshot has no operation for is not
 *   sent.
 * - `maxBudgetWaitMs`: the longest the CLI waits for one grant (for example
 *   the cancel debt after a large cancel-all, D-21). Past it the request is
 *   not sent, and the output says so. A policy number: WP-310 follow_up 2
 *   leaves the budget's numbers to an operator or ADR ruling.
 * - `venueAnswerBoundMs`: the longest the CLI waits for one answer from the
 *   venue, the credential source or the venue binding (`bounded.ts`). Past it
 *   the call is UNANSWERED: a cancel is UNKNOWN, a read is missing. A policy
 *   number, with no default.
 * - `reconciliation`: WP-290's `ReconciliationPolicy` without the account
 *   (the `--account` supplies it). Required by `reconcile` only.
 *
 * Read only after the signer gate permitted the process: a PAPER process
 * never reads it.
 */

import { RateLimitBudget } from "@polymarket-bot/polymarket-secure";

export const OPS_CONFIGURATION_SCHEMA = "polymarket-bot/ops-cli-configuration@1" as const;

/** The bound on `maxBudgetWaitMs` (ten minutes): a guard on configuration, not a venue fact. */
export const MAX_BUDGET_WAIT_MS = 600_000;
/** The bound on `venueAnswerBoundMs` (ten minutes): a guard on configuration, not a venue fact. */
export const MAX_VENUE_ANSWER_BOUND_MS = 600_000;
/** The bound on the reconciliation policy's durations (WP-290's `MAX_POLICY_MS`, one day). */
export const MAX_RECONCILIATION_POLICY_MS = 86_400_000;

export interface ReconciliationPolicyInput {
  readonly collateralAssetId: string;
  readonly quiescenceHorizonMs: number;
  readonly maxReadSpanMs: number;
  readonly holdingConfirmationMs: number;
  readonly requiredApprovalSpenders: readonly string[];
}

export interface OpsConfiguration {
  readonly rateLimitSnapshots: readonly unknown[];
  readonly maxBudgetWaitMs: number;
  readonly venueAnswerBoundMs: number;
  readonly reconciliation: ReconciliationPolicyInput | null;
}

export type ConfigurationParse = { readonly ok: true; readonly value: OpsConfiguration } | { readonly ok: false; readonly problem: string };

function own(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownList(value: unknown, max: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = own(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > max) return undefined;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      out.push(descriptor.value);
    }
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

function wholeMs(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/u;

function parseReconciliation(raw: unknown): ReconciliationPolicyInput | string {
  const collateralAssetId = own(raw, "collateralAssetId");
  const quiescenceHorizonMs = own(raw, "quiescenceHorizonMs");
  const maxReadSpanMs = own(raw, "maxReadSpanMs");
  const holdingConfirmationMs = own(raw, "holdingConfirmationMs");
  const spenders = ownList(own(raw, "requiredApprovalSpenders"), 1000);
  if (typeof collateralAssetId !== "string" || !IDENTIFIER.test(collateralAssetId)) return "reconciliation.collateralAssetId must be an id";
  for (const [name, value] of [
    ["quiescenceHorizonMs", quiescenceHorizonMs],
    ["maxReadSpanMs", maxReadSpanMs],
    ["holdingConfirmationMs", holdingConfirmationMs],
  ] as const) {
    if (!wholeMs(value, MAX_RECONCILIATION_POLICY_MS)) {
      return `reconciliation.${name} must be a whole number of milliseconds in (0, ${String(MAX_RECONCILIATION_POLICY_MS)}]; it has no default`;
    }
  }
  if (spenders === undefined || !spenders.every((spender): spender is string => typeof spender === "string" && IDENTIFIER.test(spender))) {
    return "reconciliation.requiredApprovalSpenders must be a list of ids";
  }
  return Object.freeze({
    collateralAssetId,
    quiescenceHorizonMs: quiescenceHorizonMs as number,
    maxReadSpanMs: maxReadSpanMs as number,
    holdingConfirmationMs: holdingConfirmationMs as number,
    requiredApprovalSpenders: spenders as readonly string[],
  });
}

/** Parse the configuration document. The rate-limit snapshots are checked by building a budget from them. */
export function parseOpsConfiguration(document: unknown): ConfigurationParse {
  if (own(document, "schema") !== OPS_CONFIGURATION_SCHEMA) {
    return { ok: false, problem: `the configuration's schema must be ${OPS_CONFIGURATION_SCHEMA}` };
  }
  const snapshots = ownList(own(document, "rateLimitSnapshots"), 100);
  if (snapshots === undefined || snapshots.length === 0) return { ok: false, problem: "rateLimitSnapshots must be a non-empty list of WP-310 snapshots" };
  const budget = RateLimitBudget.create(snapshots);
  if (!budget.ok) return { ok: false, problem: `rateLimitSnapshots refused by WP-310's budget: ${budget.refusal.message}` };
  const maxBudgetWaitMs = own(document, "maxBudgetWaitMs");
  if (!wholeMs(maxBudgetWaitMs, MAX_BUDGET_WAIT_MS)) {
    return { ok: false, problem: `maxBudgetWaitMs must be a whole number of milliseconds in (0, ${String(MAX_BUDGET_WAIT_MS)}]; it has no default` };
  }
  const venueAnswerBoundMs = own(document, "venueAnswerBoundMs");
  if (!wholeMs(venueAnswerBoundMs, MAX_VENUE_ANSWER_BOUND_MS)) {
    return { ok: false, problem: `venueAnswerBoundMs must be a whole number of milliseconds in (0, ${String(MAX_VENUE_ANSWER_BOUND_MS)}]; it has no default` };
  }
  const reconciliationRaw = own(document, "reconciliation");
  let reconciliation: ReconciliationPolicyInput | null = null;
  if (reconciliationRaw !== undefined && reconciliationRaw !== null) {
    const parsed = parseReconciliation(reconciliationRaw);
    if (typeof parsed === "string") return { ok: false, problem: parsed };
    reconciliation = parsed;
  }
  return { ok: true, value: Object.freeze({ rateLimitSnapshots: snapshots, maxBudgetWaitMs, venueAnswerBoundMs, reconciliation }) };
}
