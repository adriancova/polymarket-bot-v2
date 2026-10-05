/**
 * TEST SUPPORT (imported only by `*.test.ts` files in this directory).
 *
 * A SYNTHETIC snapshot: small, round numbers chosen so every behaviour is
 * visible in a few requests. None of them is a venue value; the documented
 * snapshot is exercised by `test/contract/rate-limits/**`. The numbers live
 * here, not in the budget: `no-hardcoded-limits.test.ts` exempts only
 * `*.test.ts` and `*.test-support.ts` files.
 */

import { RateLimitBudget } from "./budget.js";
import { RATE_LIMIT_CONFIGURATION_SCHEMA } from "./configuration.js";
import type { PriorityClass } from "./priority.js";

export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
export const SIGNER_A = `0x${"a".repeat(40)}`;
export const SIGNER_B = `0x${"b".repeat(40)}`;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type SnapshotDoc = { [key: string]: Json };

export const ZERO_HEADROOM: Readonly<Record<PriorityClass, number>> = Object.freeze({
  ORDER_HEARTBEAT: 0,
  EMERGENCY_CANCEL: 0,
  RECONCILIATION_READ: 0,
  RISK_REDUCING_ORDER: 0,
  STALE_QUOTE_CANCEL: 0,
  NEW_ORDER: 0,
  METADATA_ANALYTICS: 0,
});

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** The synthetic snapshot, with optional top-level and policy overrides. */
export function snapshot(
  overrides: { readonly [key: string]: Json } = {},
  policy: { readonly [key: string]: Json } = {},
): SnapshotDoc {
  return {
    schema: RATE_LIMIT_CONFIGURATION_SCHEMA,
    snapshotId: "synthetic-a",
    effectiveFrom: iso(T0 - 60_000),
    source: {
      documents: [{ url: "https://example.invalid/synthetic", retrievedAt: iso(T0 - 120_000) }],
      report: "synthetic test snapshot (no venue values)",
      policyAuthority: "WP-310 unit tests",
    },
    ipEndpointClasses: [
      { classId: "shared", windows: [{ limit: 10, windowMs: 1000 }] },
      { classId: "orders", windows: [{ limit: 100, windowMs: 1000 }] },
      { classId: "cancels", windows: [{ limit: 100, windowMs: 1000 }] },
      { classId: "reads", windows: [{ limit: 100, windowMs: 1000 }] },
      { classId: "dual", windows: [{ limit: 3, windowMs: 1000 }, { limit: 4, windowMs: 10_000 }] },
    ],
    relayer: { windows: [{ limit: 2, windowMs: 60_000 }] },
    signerTiers: [
      { tier: "Base", orderTokensPerSecond: 1, orderBurst: 4, cancelTokensPerSecond: 2, cancelBurst: 6, negativeCancelBalance: true },
      { tier: "Floor", orderTokensPerSecond: 1, orderBurst: 4, cancelTokensPerSecond: 2, cancelBurst: 6, negativeCancelBalance: false },
      { tier: "Big", orderTokensPerSecond: 10, orderBurst: 40, cancelTokensPerSecond: 20, cancelBurst: 60, negativeCancelBalance: true },
    ],
    operations: [
      { operationId: "heartbeat", kind: "HEARTBEAT", ipEndpointClasses: ["shared"], signerBucket: null, relayer: false, tokenCost: null },
      { operationId: "place", kind: "PLACEMENT", ipEndpointClasses: ["shared", "orders"], signerBucket: "ORDER", relayer: false, tokenCost: { base: 1, perEntry: 0, perCanceled: 0 } },
      { operationId: "place_batch", kind: "PLACEMENT", ipEndpointClasses: ["shared", "orders"], signerBucket: "ORDER", relayer: false, tokenCost: { base: 0, perEntry: 1, perCanceled: 0 } },
      { operationId: "cancel", kind: "CANCEL", ipEndpointClasses: ["shared", "cancels"], signerBucket: "CANCEL", relayer: false, tokenCost: { base: 1, perEntry: 0, perCanceled: 0 } },
      { operationId: "cancel_batch", kind: "CANCEL", ipEndpointClasses: ["shared", "cancels"], signerBucket: "CANCEL", relayer: false, tokenCost: { base: 0, perEntry: 1, perCanceled: 0 } },
      { operationId: "cancel_all", kind: "CANCEL", ipEndpointClasses: ["shared", "cancels"], signerBucket: "CANCEL", relayer: false, tokenCost: { base: 1, perEntry: 0, perCanceled: 1 } },
      { operationId: "read", kind: "READ", ipEndpointClasses: ["shared", "reads"], signerBucket: null, relayer: false, tokenCost: null },
      { operationId: "read_dual", kind: "READ", ipEndpointClasses: ["dual"], signerBucket: null, relayer: false, tokenCost: null },
      { operationId: "relayer_submit", kind: "RELAYER", ipEndpointClasses: ["reads"], signerBucket: null, relayer: true, tokenCost: null },
    ],
    policy: {
      assumedSignerTier: "Base",
      headroomPermille: { ...ZERO_HEADROOM },
      rateLimitedFallback: { initialMs: 1000, multiplier: 2, capMs: 8000 },
      maxHeaderWaitMs: 60_000,
      maxQueuedRequests: 100,
      ...policy,
    },
    ...overrides,
  };
}

export function budgetOf(...documents: SnapshotDoc[]): RateLimitBudget {
  const created = RateLimitBudget.create(documents.length === 0 ? [snapshot()] : documents);
  if (!created.ok) throw new Error(created.refusal.message);
  return created.value;
}

/**
 * Create `signer`'s buckets at `atMs` (a signer first seen starts EMPTY) by
 * queuing and withdrawing one request; they then refill from `atMs`.
 */
export function warm(budget: RateLimitBudget, signer: string, atMs: number): void {
  for (const operationId of ["place", "cancel"]) {
    const decision = budget.request({ operationId, priority: operationId === "place" ? "NEW_ORDER" : "STALE_QUOTE_CANCEL", signer }, atMs);
    if (decision.kind === "QUEUED") budget.withdraw(decision.ticketId);
    else throw new Error(`warm-up expected a queued request, got ${decision.kind}`);
  }
}
