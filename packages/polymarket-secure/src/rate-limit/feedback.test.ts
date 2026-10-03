/**
 * WP-310 deliverable 2 and acceptance 4: each documented header changes the
 * budget as documented; an undocumented header is inert and flagged; a 429
 * with `Retry-After` waits exactly that long. Synthetic snapshot numbers.
 */

import { describe, expect, it } from "vitest";

import type { Grant, RateLimitBudget, RequestDecision } from "./budget.js";
import { SIGNER_A, T0, budgetOf, snapshot, warm } from "./fixtures.test-support.js";
import { feedbackFromObservation, parseRateLimitHeaders, signerBucketOfObservation, type RateLimitFeedback } from "./headers.js";
import { MAX_TOKEN_MAGNITUDE } from "./units.js";

function grantOf(decision: RequestDecision): Grant {
  if (decision.kind !== "GRANTED") throw new Error(`expected GRANTED, got ${decision.kind}`);
  return decision.grant;
}

function place(budget: RateLimitBudget, atMs: number): RequestDecision {
  return budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, atMs);
}

function orderTokens(budget: RateLimitBudget, atMs: number): string | undefined {
  return budget.view(atMs).signers[0]?.order.tokens;
}

function headers(httpStatus: number | null, map: Record<string, string>): RateLimitFeedback {
  return parseRateLimitHeaders({ httpStatus, headers: map });
}

describe("parseRateLimitHeaders: the five documented headers", () => {
  it("reads each documented header by its grammar, names compared case-insensitively", () => {
    expect(
      headers(429, {
        "poly-ratelimit-remaining": "-12",
        "POLY-RATELIMIT-RESET": "1782753362",
        "Poly-RateLimit-Tier": "standard",
        "Poly-RateLimit-Warning": "true",
        "retry-after": " 2 ",
      }),
    ).toEqual({ httpStatus: 429, remaining: -12, resetUnixSeconds: 1782753362, tier: "standard", warning: true, retryAfterSeconds: 2, flags: [] });
  });

  it("flags every undocumented header by NAME only and never reads its value", () => {
    const parsed = headers(429, {
      "X-RateLimit-Remaining": "999999",
      "RateLimit-Policy": "10;w=1",
      "Poly-RateLimit-Limit": "5000",
      "Retry-After-Ms": "1",
      "Content-Type": "application/json",
    });
    expect(parsed).toMatchObject({ remaining: null, resetUnixSeconds: null, tier: null, warning: false, retryAfterSeconds: null });
    expect(parsed.flags).toEqual([
      { kind: "UNDOCUMENTED_HEADER", header: "x-ratelimit-remaining" },
      { kind: "UNDOCUMENTED_HEADER", header: "ratelimit-policy" },
      { kind: "UNDOCUMENTED_HEADER", header: "poly-ratelimit-limit" },
      { kind: "UNDOCUMENTED_HEADER", header: "retry-after-ms" },
      { kind: "UNDOCUMENTED_HEADER", header: "content-type" },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/999999|5000|w=1|application/u);
  });

  it("a documented header outside its grammar is flagged MALFORMED and not interpreted", () => {
    const parsed = headers(429, {
      "Poly-RateLimit-Remaining": "1.5",
      "Poly-RateLimit-Reset": "-1",
      "Poly-RateLimit-Tier": "tier one; drop",
      "Poly-RateLimit-Warning": "yes",
      "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    expect(parsed).toMatchObject({ remaining: null, resetUnixSeconds: null, tier: null, warning: false, retryAfterSeconds: null });
    expect(parsed.flags.map((flag) => flag.kind)).toEqual(["MALFORMED_HEADER", "MALFORMED_HEADER", "MALFORMED_HEADER", "MALFORMED_HEADER", "MALFORMED_HEADER"]);
  });

  it("Retry-After is read only on the statuses the venue documents it for (429, 425, the post-only 503)", () => {
    for (const status of [429, 425, 503]) expect(headers(status, { "Retry-After": "7" }).retryAfterSeconds, String(status)).toBe(7);
    for (const status of [200, 400, 500, null]) {
      const parsed = headers(status, { "Retry-After": "7" });
      expect(parsed.retryAfterSeconds).toBeNull();
      expect(parsed.flags).toEqual([{ kind: "RETRY_AFTER_UNDOCUMENTED_FOR_STATUS", httpStatus: status }]);
    }
  });

  it("a Retry-After beyond WP-260's one-day bound is not interpreted", () => {
    expect(headers(429, { "Retry-After": "86401" })).toMatchObject({ retryAfterSeconds: null, flags: [{ kind: "MALFORMED_HEADER", header: "Retry-After" }] });
    expect(headers(429, { "Retry-After": "86400" }).retryAfterSeconds).toBe(86400);
  });

  it("a name given twice is ambiguous: flagged, neither value read", () => {
    expect(headers(429, { "Retry-After": "1", "retry-after": "60" })).toMatchObject({
      retryAfterSeconds: null,
      flags: [{ kind: "DUPLICATE_HEADER", header: "Retry-After" }],
    });
  });

  it("an unreadable header map is flagged, never thrown", () => {
    expect(headers(429, null as never).flags).toEqual([{ kind: "HEADERS_UNREADABLE" }]);
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(parseRateLimitHeaders({ httpStatus: 429, headers: hostile }).flags).toEqual([{ kind: "HEADERS_UNREADABLE" }]);
  });
});

describe("feedbackFromObservation: WP-260's onRateLimitUpdate observation", () => {
  it("carries the same documented fields, and a Retry-After only with a documented status", () => {
    const observation = { bucket: "order", remaining: 3, resetUnixSeconds: 1782753360, tier: "standard", warning: false };
    expect(feedbackFromObservation(observation)).toEqual({ httpStatus: null, remaining: 3, resetUnixSeconds: 1782753360, tier: "standard", warning: false, retryAfterSeconds: null, flags: [] });
    expect(feedbackFromObservation(observation, { httpStatus: 429, retryAfterSeconds: 2 }).retryAfterSeconds).toBe(2);
    expect(feedbackFromObservation(observation, { httpStatus: null, retryAfterSeconds: 2 })).toMatchObject({
      retryAfterSeconds: null,
      flags: [{ kind: "RETRY_AFTER_UNDOCUMENTED_FOR_STATUS", httpStatus: null }],
    });
    expect(signerBucketOfObservation(observation)).toBe("ORDER");
    expect(signerBucketOfObservation({ bucket: "cancel" })).toBe("CANCEL");
    expect(signerBucketOfObservation({ bucket: null })).toBeNull();
  });

  it("an observation with a getter is unreadable, never read", () => {
    const hostile = Object.defineProperty({ bucket: "order", resetUnixSeconds: null, tier: null, warning: false }, "remaining", { get: () => 5, enumerable: true });
    expect(feedbackFromObservation(hostile)).toMatchObject({ remaining: null, flags: [{ kind: "OBSERVATION_UNREADABLE" }] });
  });
});

describe("the budget applies each documented header as documented", () => {
  it("Poly-RateLimit-Remaining lowers the local estimate to the venue's balance, never raises it", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    expect(orderTokens(budget, T0)).toBe("3");
    expect(budget.complete(grant, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "1" }) }).ok).toBe(true);
    expect(orderTokens(budget, T0)).toBe("1");
    const second = grantOf(place(budget, T0));
    expect(budget.complete(second, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "50" }) }).ok).toBe(true);
    expect(orderTokens(budget, T0)).toBe("0");
  });

  it("a zero balance alone imposes no wait (the bucket refills as usual)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    budget.complete(grant, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "0", "Poly-RateLimit-Reset": String((T0 + 30_000) / 1000) }) });
    expect(budget.view(T0).signers[0]?.order.blockedUntilMs).toBeNull();
    expect(place(budget, T0 + 1000).kind).toBe("GRANTED");
  });

  it("a negative balance (cancel debt, D-21) with a later Reset waits until Reset, capped by maxHeaderWaitMs", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const sweep = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const resetSeconds = (T0 + 20_000) / 1000;
    const result = budget.complete(sweep, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "-4", "Poly-RateLimit-Reset": String(resetSeconds) }) });
    expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "WAIT_APPLIED", untilMs: T0 + 20_000, basis: "RESET" }));
    expect(budget.view(T0).signers[0]?.cancel).toMatchObject({ tokens: "-4", blockedUntilMs: T0 + 20_000 });
    // The bucket holds 1 token again after 2.5 s, but the venue said the wait lasts until Reset.
    expect(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0 + 19_999).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 20_000).filter((event) => event.kind === "GRANTED")).toHaveLength(1);

    const capped = budgetOf();
    warm(capped, SIGNER_A, T0 - 10_000);
    const other = grantOf(capped.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const far = capped.complete(other, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "-1", "Poly-RateLimit-Reset": String((T0 + 3_600_000) / 1000) }) });
    expect(far.ok && far.value).toContainEqual(expect.objectContaining({ kind: "RESET_WAIT_CAPPED" }));
    expect(capped.view(T0).signers[0]?.cancel.blockedUntilMs).toBe(T0 + 60_000);
  });

  it("Poly-RateLimit-Tier switches the signer's buckets to that tier (case-insensitively); an unknown tier falls back to the assumed tier, flagged", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    const switched = budget.complete(grant, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Tier": "big" }) });
    expect(switched.ok && switched.value).toContainEqual({ kind: "TIER_APPLIED", signer: SIGNER_A, tier: "Big" });
    expect(budget.view(T0 + 1000).signers[0]).toMatchObject({ tier: "Big", order: { tokens: "13", capacity: 40, tokensPerSecond: 10 } });
    const next = grantOf(place(budget, T0 + 1000));
    const unknown = budget.complete(next, { atMs: T0 + 1000, feedback: headers(200, { "Poly-RateLimit-Tier": "Mythril" }) });
    expect(unknown.ok && unknown.value).toContainEqual({ kind: "TIER_UNRECOGNISED", signer: SIGNER_A, fallbackTier: "Base" });
    // Back to Base: the level is capped at Base's burst of 4 at once.
    expect(budget.view(T0 + 1000).signers[0]).toMatchObject({ tier: "Base", order: { tokens: "4", capacity: 4, tokensPerSecond: 1 } });
  });

  it("Poly-RateLimit-Warning: true drops the estimate to at most zero and is counted", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    const result = budget.complete(grant, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Warning": "true", "Poly-RateLimit-Remaining": "2" }) });
    expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "WARNING_MODE" }));
    expect(budget.view(T0).signers[0]?.order).toMatchObject({ tokens: "0", warnings: 1 });
    const quiet = grantOf(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    budget.complete(quiet, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Warning": "false" }) });
    expect(budget.view(T0).signers[0]?.cancel).toMatchObject({ tokens: "5", warnings: 0 });
  });

  it("a 429 with Retry-After waits EXACTLY that long on the bucket the limiter charged", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    const result = budget.complete(grant, { atMs: T0 + 5, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 }, feedback: headers(429, { "Retry-After": "2" }) });
    expect(result.ok && result.value).toContainEqual({ kind: "WAIT_APPLIED", budget: { dimension: "SIGNER_ORDER_BUCKET", signer: SIGNER_A }, untilMs: T0 + 2005, basis: "RETRY_AFTER" });
    // Only the bucket the per-signer limiter charged waits: the cancel bucket and the shared IP class do not
    // (checked inside the wait: the budget's time never runs backwards).
    expect(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0 + 6).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0 + 6).kind).toBe("GRANTED");
    expect(budget.view(T0 + 6).operationWaits).toEqual([]);
    expect(place(budget, T0 + 2004).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 2004)).toEqual([]);
    expect(budget.poll(T0 + 2005).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("a 429 whose Retry-After came only in the headers is honoured the same way", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(place(budget, T0));
    budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null }, feedback: headers(429, { "Retry-After": "3" }) });
    expect(budget.view(T0).signers[0]?.order.blockedUntilMs).toBe(T0 + 3000);
  });

  it("a 429 without Retry-After waits until a later Reset; with neither, the snapshot's fallback, which does not escalate within a running wait", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(place(budget, T0));
    budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null }, feedback: headers(429, { "Poly-RateLimit-Reset": String((T0 + 4000) / 1000) }) });
    expect(budget.view(T0).signers[0]?.order.blockedUntilMs).toBe(T0 + 4000);

    const fallback = budgetOf();
    warm(fallback, SIGNER_A, T0 - 10_000);
    const a = grantOf(place(fallback, T0));
    const b = grantOf(place(fallback, T0));
    const waits: number[] = [];
    const wait = (grant: Grant, atMs: number): void => {
      const result = fallback.complete(grant, { atMs, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
      const effect = result.ok ? result.value.find((entry) => entry.kind === "WAIT_APPLIED") : undefined;
      waits.push(effect !== undefined && effect.kind === "WAIT_APPLIED" ? effect.untilMs - atMs : -1);
    };
    wait(a, T0);
    // A second 429 for a request sent before the wait began: no escalation.
    wait(b, T0 + 10);
    const c = grantOf(place(fallback, T0 + 1000));
    wait(c, T0 + 1000);
    const d = grantOf(place(fallback, T0 + 5000));
    wait(d, T0 + 5000);
    // initialMs 1000, multiplier 2, cap 8000.
    expect(waits).toEqual([1000, 990, 2000, 4000]);
  });

  it("a request with no signer bucket: a 429 holds back only that operation, for its class and below; header fields are flagged, not applied (OP-R1-01)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0));
    const result = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 1 }, feedback: headers(429, { "Poly-RateLimit-Remaining": "0" }) });
    expect(result.ok && result.value.filter((effect) => effect.kind === "WAIT_APPLIED" || effect.kind === "OPERATION_WAIT_APPLIED")).toEqual([
      {
        kind: "OPERATION_WAIT_APPLIED",
        operationId: "read",
        priorities: ["RECONCILIATION_READ", "RISK_REDUCING_ORDER", "STALE_QUOTE_CANCEL", "NEW_ORDER", "METADATA_ANALYTICS"],
        untilMs: T0 + 1000,
        basis: "RETRY_AFTER",
      },
    ]);
    expect(result.ok && result.value).toContainEqual({ kind: "FEEDBACK_WITHOUT_SIGNER_BUCKET" });
    // Every other operation, the classes above it and every IP class it drew on are untouched, inside the wait.
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "read_dual", priority: "RECONCILIATION_READ" }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0 + 1).kind).toBe("GRANTED");
    // The operation itself waits exactly Retry-After, for its own class and the classes below it.
    const same = budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0 + 1);
    const lower = budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 1);
    expect([same.kind, lower.kind]).toEqual(["QUEUED", "QUEUED"]);
    expect(budget.view(T0 + 1).operationWaits.map((entry) => [entry.priority, entry.untilMs - T0])).toEqual([
      ["RECONCILIATION_READ", 1000],
      ["RISK_REDUCING_ORDER", 1000],
      ["STALE_QUOTE_CANCEL", 1000],
      ["NEW_ORDER", 1000],
      ["METADATA_ANALYTICS", 1000],
    ]);
    expect(budget.nextWakeAtMs(T0 + 1)).toBe(T0 + 1000);
    expect(budget.poll(T0 + 999)).toEqual([]);
    expect(budget.poll(T0 + 1000).map((event) => event.kind)).toEqual(["GRANTED", "GRANTED"]);
  });

  it("a lower class's 429 on an operation never holds back a higher class of the same operation (OP-R1-01)", () => {
    const budget = budgetOf();
    const grant = grantOf(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0));
    const result = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
    expect(result.ok && result.value).toEqual([{ kind: "OPERATION_WAIT_APPLIED", operationId: "read", priorities: ["METADATA_ANALYTICS"], untilMs: T0 + 3_600_000, basis: "RETRY_AFTER" }]);
    expect(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 + 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 1).kind).toBe("QUEUED");
    // Without Retry-After or Reset: the fallback, on the operation only.
    const other = budgetOf();
    const read = grantOf(other.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0));
    other.complete(read, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
    expect(other.view(T0).operationWaits).toEqual([{ operationId: "read", priority: "METADATA_ANALYTICS", untilMs: T0 + 1000 }]);
    expect(other.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 + 500).kind).toBe("GRANTED");
  });

  it("an undocumented header changes nothing in the budget", () => {
    const control = budgetOf();
    const probe = budgetOf();
    for (const budget of [control, probe]) warm(budget, SIGNER_A, T0 - 10_000);
    const a = grantOf(place(control, T0));
    const b = grantOf(place(probe, T0));
    control.complete(a, { atMs: T0, feedback: headers(200, {}) });
    const result = probe.complete(b, { atMs: T0, feedback: headers(200, { "X-RateLimit-Remaining": "0", "Poly-RateLimit-Limit": "1", "RateLimit-Reset": "99999999999" }) });
    expect(result.ok && result.value.every((effect) => effect.kind === "FEEDBACK_FLAG")).toBe(true);
    expect(probe.view(T0)).toEqual(control.view(T0));
  });

  it("observeSignerFeedback applies an SDK observation to the named bucket, with a 429 Retry-After only when the status is given", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const observation = { bucket: "cancel", remaining: 1, resetUnixSeconds: null, tier: null, warning: false };
    const bucket = signerBucketOfObservation(observation);
    expect(bucket).toBe("CANCEL");
    expect(budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation(observation), T0).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("1");
    budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation(observation, { httpStatus: 429, retryAfterSeconds: 4 }), T0);
    expect(budget.view(T0).signers[0]?.cancel.blockedUntilMs).toBe(T0 + 4000);
    expect(budget.observeSignerFeedback({ signer: "nope", bucket: "CANCEL" }, feedbackFromObservation(observation), T0)).toMatchObject({ ok: false });
  });

  it("a successful answer ends the run of fallback waits", () => {
    const budget = budgetOf(snapshot());
    warm(budget, SIGNER_A, T0 - 10_000);
    budget.complete(grantOf(place(budget, T0)), { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
    budget.complete(grantOf(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0 + 1000)), { atMs: T0 + 1000, error: null });
    const result = budget.complete(grantOf(place(budget, T0 + 2000)), { atMs: T0 + 2000, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
    expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "WAIT_APPLIED", untilMs: T0 + 3000, basis: "FALLBACK" }));
  });
});

describe("one wait per response: a 429's Retry-After is never lengthened by the same response's Reset (CX310-R1-02)", () => {
  const cancel = (budget: RateLimitBudget, atMs: number): RequestDecision =>
    budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, atMs);
  const resetAt = (ms: number): string => String(ms / 1000);

  it("the completion path: Retry-After 2 with Remaining -1 and Reset +10 s waits exactly 2 s; the bucket's own refill then admits the cancel", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(cancel(budget, T0));
    const feedback = headers(429, { "Retry-After": "2", "Poly-RateLimit-Remaining": "-1", "Poly-RateLimit-Reset": resetAt(T0 + 10_000) });
    const result = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 }, feedback });
    expect(result.ok && result.value.filter((effect) => effect.kind === "WAIT_APPLIED")).toEqual([
      { kind: "WAIT_APPLIED", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, untilMs: T0 + 2000, basis: "RETRY_AFTER" },
    ]);
    const next = cancel(budget, T0);
    expect(next.kind).toBe("QUEUED");
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 2000);
    expect(budget.poll(T0 + 1999)).toEqual([]);
    expect(budget.view(T0 + 2000).signers[0]?.cancel).toMatchObject({ tokens: "3", blockedUntilMs: null });
    expect(budget.poll(T0 + 2000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("the observation path: the SDK reports the 429's headers before the call returns; the completion still waits exactly Retry-After", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(cancel(budget, T0));
    const observation = { bucket: "cancel", remaining: -1, resetUnixSeconds: (T0 + 10_000) / 1000, tier: null, warning: false };
    const observed = budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation(observation), T0);
    // Applied at once; its Reset wait is pending on the one grant it may answer.
    expect(observed.ok && observed.value).toEqual([
      { kind: "REMAINING_APPLIED", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, tokens: "-1" },
      { kind: "WAIT_PENDING", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, untilMs: T0 + 10_000, basis: "RESET", grantIds: [grant.grantId] },
    ]);
    const result = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 } });
    expect(result.ok && result.value).toEqual([
      { kind: "PENDING_WAIT_WITHDRAWN", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, untilMs: T0 + 10_000, basis: "RESET" },
      { kind: "WAIT_APPLIED", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, untilMs: T0 + 2000, basis: "RETRY_AFTER" },
    ]);
    expect(budget.view(T0).signers[0]?.cancel).toMatchObject({ tokens: "-1", blockedUntilMs: T0 + 2000 });
    expect(cancel(budget, T0).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 2000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("an observation applied on its own with the documented 429 status: Retry-After exactly, its Reset ignored", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const observation = { bucket: "cancel", remaining: -1, resetUnixSeconds: (T0 + 10_000) / 1000, tier: null, warning: false };
    const result = budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation(observation, { httpStatus: 429, retryAfterSeconds: 2 }), T0);
    expect(result.ok && result.value.filter((effect) => effect.kind === "WAIT_APPLIED")).toEqual([
      { kind: "WAIT_APPLIED", budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER_A }, untilMs: T0 + 2000, basis: "RETRY_AFTER" },
    ]);
    // Without Retry-After, the 429's later Reset is the wait (bounded), even with a balance of zero.
    const other = budgetOf();
    warm(other, SIGNER_A, T0 - 10_000);
    const zero = { bucket: "order", remaining: 0, resetUnixSeconds: (T0 + 5000) / 1000, tier: null, warning: false };
    other.observeSignerFeedback({ signer: SIGNER_A, bucket: "ORDER" }, feedbackFromObservation(zero, { httpStatus: 429, retryAfterSeconds: null }), T0);
    expect(other.view(T0).signers[0]?.order.blockedUntilMs).toBe(T0 + 5000);
  });
});

const CANCEL_A = Object.freeze({ dimension: "SIGNER_CANCEL_BUCKET" as const, signer: SIGNER_A });

/** An SDK observation of SIGNER_A's cancel bucket (WP-260's shape), with the given fields set. */
function observeCancel(
  budget: RateLimitBudget,
  fields: { readonly remaining?: number | null; readonly resetUnixSeconds?: number | null; readonly warning?: boolean },
  atMs: number,
  response?: { readonly httpStatus: number | null; readonly retryAfterSeconds: number | null },
) {
  const observation = { bucket: "cancel", remaining: null, resetUnixSeconds: null, tier: null, warning: false, ...fields };
  return budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation(observation, response), atMs);
}

describe("one response is counted once: an SDK observation and its grant's completion (OP-R1-03)", () => {
  const cancelAll = (budget: RateLimitBudget, atMs: number): RequestDecision =>
    budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, atMs);
  const observe = (budget: RateLimitBudget, remaining: number) => observeCancel(budget, { remaining }, T0);

  it("the cancel-all's own observation (its Remaining already includes the per-canceled debit) is not debited twice", () => {
    const control = budgetOf();
    warm(control, SIGNER_A, T0 - 10_000);
    control.complete(grantOf(cancelAll(control, T0)), { atMs: T0, canceledCount: 8, feedback: headers(200, { "Poly-RateLimit-Remaining": "-3" }) });
    expect(control.view(T0).signers[0]?.cancel.tokens).toBe("-3");

    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(cancelAll(budget, T0));
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("5");
    // Applied at once, held apart from the debit of the cancel-all it may answer.
    expect(observe(budget, -3)).toEqual({
      ok: true,
      value: [
        { kind: "REMAINING_APPLIED", budget: CANCEL_A, tokens: "-3" },
        { kind: "BALANCE_MAY_INCLUDE_DEBIT", budget: CANCEL_A, grantIds: [grant.grantId] },
      ],
    });
    const result = budget.complete(grant, { atMs: T0, canceledCount: 8 });
    expect(result.ok && result.value).toEqual([{ kind: "CANCELED_DEBITED", budget: CANCEL_A, tokens: 8 }]);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-3");
    expect(budget.view(T0)).toEqual(control.view(T0));
  });

  it("a completion that also carries the response's own headers counts its balance once (no double count either way)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(cancelAll(budget, T0));
    observe(budget, -3);
    const result = budget.complete(grant, { atMs: T0, canceledCount: 8, feedback: headers(200, { "Poly-RateLimit-Remaining": "-3", "Poly-RateLimit-Warning": "true" }) });
    expect(result.ok && result.value.map((effect) => effect.kind)).toEqual(["CANCELED_DEBITED", "REMAINING_APPLIED", "WARNING_MODE"]);
    expect(budget.view(T0).signers[0]?.cancel).toMatchObject({ tokens: "-3", warnings: 1 });
  });

  it("an observation is applied at once, whatever is outstanding; its balance is held apart only from the debits of cancel-alls outstanding when it arrives", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    // No grant outstanding: it lowers the estimate itself.
    expect(observe(budget, 4)).toEqual({ ok: true, value: [{ kind: "REMAINING_APPLIED", budget: CANCEL_A, tokens: "4" }] });
    // A single cancel outstanding (no post-hoc debit): nothing to hold it apart from.
    const single = grantOf(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    expect(observe(budget, 1)).toEqual({ ok: true, value: [{ kind: "REMAINING_APPLIED", budget: CANCEL_A, tokens: "1" }] });
    budget.complete(single, { atMs: T0 });
    // A cancel-all outstanding: held apart from its debit.
    const sweep = grantOf(cancelAll(budget, T0));
    expect(observe(budget, -2)).toEqual({
      ok: true,
      value: [
        { kind: "REMAINING_APPLIED", budget: CANCEL_A, tokens: "-2" },
        { kind: "BALANCE_MAY_INCLUDE_DEBIT", budget: CANCEL_A, grantIds: [sweep.grantId] },
      ],
    });
    // An order-bucket observation is never held apart from a cancel-bucket debit.
    expect(budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "ORDER" }, feedbackFromObservation({ bucket: "order", remaining: 2, resetUnixSeconds: null, tier: null, warning: false }), T0)).toEqual({
      ok: true,
      value: [{ kind: "REMAINING_APPLIED", budget: { dimension: "SIGNER_ORDER_BUCKET", signer: SIGNER_A }, tokens: "2" }],
    });
  });
});

describe("overlapping and late answers: each balance and each debit counted once (CX310-R2-01)", () => {
  const cancelAll = (budget: RateLimitBudget, atMs: number): Grant =>
    grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, atMs));
  const cancelOne = (budget: RateLimitBudget, atMs: number): Grant =>
    grantOf(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, atMs));
  /** The cancel bucket after the script, and when the next emergency cancel could go. */
  const outcome = (budget: RateLimitBudget): { readonly tokens: string | undefined; readonly nextEmergencyCancelAtMs: number | null } => {
    const tokens = budget.view(T0).signers[0]?.cancel.tokens;
    const next = budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0);
    return { tokens, nextEmergencyCancelAtMs: next.kind === "GRANTED" ? T0 : budget.nextWakeAtMs(T0) };
  };

  it("a cancel-all and another cancel in flight: the cancel-all's observation, then its completion, leave exactly what the completion alone leaves", () => {
    const run = (withObservation: boolean) => {
      const budget = budgetOf();
      warm(budget, SIGNER_A, T0 - 10_000);
      const sweep = cancelAll(budget, T0);
      cancelOne(budget, T0);
      expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("4");
      if (withObservation) {
        const observed = observeCancel(budget, { remaining: -4 }, T0);
        expect(observed.ok && observed.value).toContainEqual({ kind: "BALANCE_MAY_INCLUDE_DEBIT", budget: CANCEL_A, grantIds: [sweep.grantId] });
      }
      expect(budget.complete(sweep, { atMs: T0, canceledCount: 8 }).ok).toBe(true);
      return outcome(budget);
    };
    // 6 - 1 - 1 - 8 = -4; one token back at 2 per second: 2,500 ms.
    expect(run(false)).toEqual({ tokens: "-4", nextEmergencyCancelAtMs: T0 + 2500 });
    expect(run(true)).toEqual(run(false));
  });

  it.each([
    ["the other cancel first", 5, -4],
    ["the cancel-all first", -3, -4],
  ] as const)("whatever order the venue processed them in (%s) and their answers arrive in, the level ends at the venue's: -4", (_label, otherRemaining, sweepRemaining) => {
    // Every arrival order in which each answer's observation precedes its completion (the pinned SDK's order).
    const orders: readonly (readonly ("observeSweep" | "observeOther" | "completeSweep" | "completeOther")[])[] = [
      ["observeSweep", "completeSweep", "observeOther", "completeOther"],
      ["observeSweep", "observeOther", "completeSweep", "completeOther"],
      ["observeSweep", "observeOther", "completeOther", "completeSweep"],
      ["observeOther", "completeOther", "observeSweep", "completeSweep"],
      ["observeOther", "observeSweep", "completeOther", "completeSweep"],
      ["observeOther", "observeSweep", "completeSweep", "completeOther"],
    ];
    for (const order of orders) {
      const budget = budgetOf();
      warm(budget, SIGNER_A, T0 - 10_000);
      const sweep = cancelAll(budget, T0);
      const other = cancelOne(budget, T0);
      for (const step of order) {
        if (step === "observeSweep") observeCancel(budget, { remaining: sweepRemaining }, T0);
        if (step === "observeOther") observeCancel(budget, { remaining: otherRemaining }, T0);
        if (step === "completeSweep") budget.complete(sweep, { atMs: T0, canceledCount: 8 });
        if (step === "completeOther") budget.complete(other, { atMs: T0 });
      }
      expect(outcome(budget), order.join(" > ")).toEqual({ tokens: "-4", nextEmergencyCancelAtMs: T0 + 2500 });
    }
  });

  it("a late answer (its grant already completed) never stands in for the next cancel-all's own: the debit still counts once", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const lost = cancelOne(budget, T0);
    // The composition gave up on it; its answer (balance 5) arrives later, while a cancel-all is in flight.
    budget.complete(lost, { atMs: T0, error: { kind: "TRANSPORT_FAILURE", retryAfterSeconds: null } });
    const sweep = cancelAll(budget, T0);
    observeCancel(budget, { remaining: 5 }, T0);
    // The cancel-all's own answer: 6 - 1 - 1 - 8.
    observeCancel(budget, { remaining: -4 }, T0);
    budget.complete(sweep, { atMs: T0, canceledCount: 8 });
    expect(outcome(budget)).toEqual({ tokens: "-4", nextEmergencyCancelAtMs: T0 + 2500 });
  });

  it("a completion's own headers may include the debit of another cancel-all still in flight: it is not charged to them again", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = cancelAll(budget, T0);
    const second = cancelAll(budget, T0);
    // The venue processed `second` first (6 - 1 - 3 = 2), then `first` (2 - 1 - 2 = -1): `first`'s answer reports -1.
    budget.complete(first, { atMs: T0, canceledCount: 2, feedback: headers(200, { "Poly-RateLimit-Remaining": "-1" }) });
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-1");
    budget.complete(second, { atMs: T0, canceledCount: 3 });
    expect(outcome(budget)).toEqual({ tokens: "-1", nextEmergencyCancelAtMs: T0 + 1000 });
  });

  it("a cancel-all completed without its count (flagged, OP-R1-09) keeps the debt its own answer reported, with another cancel in flight", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const sweep = cancelAll(budget, T0);
    cancelOne(budget, T0);
    observeCancel(budget, { remaining: -4 }, T0);
    const result = budget.complete(sweep, { atMs: T0 });
    expect(result.ok && result.value).toEqual([{ kind: "CANCELED_COUNT_UNKNOWN", budget: CANCEL_A }]);
    expect(outcome(budget)).toEqual({ tokens: "-4", nextEmergencyCancelAtMs: T0 + 2500 });
  });

  it("a balance that arrived BEFORE a cancel-all was granted is charged its debit (it cannot include it)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const held = cancelOne(budget, T0);
    const first = cancelAll(budget, T0);
    // Arrives while `first` is outstanding: held apart from `first`'s debit only.
    observeCancel(budget, { remaining: 3 }, T0);
    const second = cancelAll(budget, T0);
    // The estimate: 6 - 1 - 1 - 1 = 3. The held balance 3 is charged `second`'s cost: 2.
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("2");
    // `second` completes first: its debit (4) applies to the held balance too, which arrived before it was granted.
    budget.complete(second, { atMs: T0, canceledCount: 4 });
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-2");
    budget.complete(first, { atMs: T0, canceledCount: 1 });
    budget.complete(held, { atMs: T0 });
    // The estimate takes both debits (3 - 4 - 1 = -2); the held balance took only `second`'s (2 - 4 = -2).
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-2");
  });
});

describe("one wait per response with several grants in flight (CX310-R2-02)", () => {
  const emergencyCancel = (budget: RateLimitBudget, atMs: number): RequestDecision =>
    budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, atMs);
  const resetAt = (ms: number): number => ms / 1000;

  it("two cancels in flight, an observation (Remaining -1, Reset +10 s), then a 429 with Retry-After 2: the bucket waits exactly 2 s", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(emergencyCancel(budget, T0));
    const second = grantOf(emergencyCancel(budget, T0));
    const observed = observeCancel(budget, { remaining: -1, resetUnixSeconds: resetAt(T0 + 10_000) }, T0);
    expect(observed.ok && observed.value).toContainEqual({ kind: "WAIT_PENDING", budget: CANCEL_A, untilMs: T0 + 10_000, basis: "RESET", grantIds: [first.grantId, second.grantId] });
    // While pending, it holds the bucket back.
    expect(emergencyCancel(budget, T0).kind).toBe("QUEUED");
    const result = budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 } });
    expect(result.ok && result.value).toEqual([
      { kind: "PENDING_WAIT_WITHDRAWN", budget: CANCEL_A, untilMs: T0 + 10_000, basis: "RESET" },
      { kind: "WAIT_APPLIED", budget: CANCEL_A, untilMs: T0 + 2000, basis: "RETRY_AFTER" },
    ]);
    expect(budget.nextWakeAtMs(T0 + 1)).toBe(T0 + 2000);
    expect(budget.poll(T0 + 1999)).toEqual([]);
    expect(budget.view(T0 + 2000).signers[0]?.cancel).toMatchObject({ tokens: "3", blockedUntilMs: null });
    expect(budget.poll(T0 + 2000).map((event) => event.kind)).toEqual(["GRANTED"]);
    expect(emergencyCancel(budget, T0 + 2000).kind).toBe("GRANTED");
  });

  it("while pending, an observation's wait holds the bucket back like any wait (here a 429's Retry-After reported with its status)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    grantOf(emergencyCancel(budget, T0));
    grantOf(emergencyCancel(budget, T0));
    observeCancel(budget, { remaining: 3 }, T0, { httpStatus: 429, retryAfterSeconds: 5 });
    expect(budget.view(T0).signers[0]?.cancel).toMatchObject({ tokens: "3", blockedUntilMs: T0 + 5000 });
    expect(emergencyCancel(budget, T0 + 4999).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 5000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("a pending wait whose grants complete without a 429 stays, and becomes an ordinary wait", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(emergencyCancel(budget, T0));
    const second = grantOf(emergencyCancel(budget, T0));
    observeCancel(budget, { remaining: -1, resetUnixSeconds: resetAt(T0 + 10_000) }, T0);
    expect(budget.complete(first, { atMs: T0 }).ok).toBe(true);
    expect(budget.complete(second, { atMs: T0, error: { kind: "TRANSPORT_FAILURE", retryAfterSeconds: null } }).ok).toBe(true);
    expect(budget.view(T0 + 2000).signers[0]?.cancel).toMatchObject({ tokens: "3", blockedUntilMs: T0 + 10_000 });
    expect(emergencyCancel(budget, T0 + 9999).kind).toBe("QUEUED");
    expect(budget.poll(T0 + 10_000).map((event) => event.kind)).toEqual(["GRANTED"]);
  });

  it("another response's wait stays: a completion's own Reset in a wait period is not withdrawn by a later 429 with a shorter Retry-After", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(emergencyCancel(budget, T0));
    const second = grantOf(emergencyCancel(budget, T0));
    budget.complete(first, { atMs: T0, feedback: headers(200, { "Poly-RateLimit-Remaining": "-1", "Poly-RateLimit-Reset": String(resetAt(T0 + 10_000)) }) });
    const result = budget.complete(second, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 } });
    expect(result.ok && result.value).toEqual([{ kind: "WAIT_APPLIED", budget: CANCEL_A, untilMs: T0 + 10_000, basis: "RETRY_AFTER" }]);
    expect(emergencyCancel(budget, T0 + 2000).kind).toBe("QUEUED");
  });

  it("an observation that arrives with no grant outstanding (a late answer) is an ordinary wait", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const observed = observeCancel(budget, { remaining: -1, resetUnixSeconds: resetAt(T0 + 10_000) }, T0);
    expect(observed.ok && observed.value).toContainEqual({ kind: "WAIT_APPLIED", budget: CANCEL_A, untilMs: T0 + 10_000, basis: "RESET" });
  });

  it("a 429 with neither Retry-After nor its own headers reads the Reset of the latest observation made while it was in flight", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(emergencyCancel(budget, T0));
    grantOf(emergencyCancel(budget, T0));
    observeCancel(budget, { remaining: 0, resetUnixSeconds: resetAt(T0 + 30_000) }, T0);
    // Its own answer, just before the call settles: the 429's Reset.
    observeCancel(budget, { remaining: 0, resetUnixSeconds: resetAt(T0 + 5000) }, T0);
    const result = budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
    expect(result.ok && result.value).toContainEqual({ kind: "WAIT_APPLIED", budget: CANCEL_A, untilMs: T0 + 5000, basis: "RESET" });
  });
});

describe("Poly-RateLimit-Remaining is bounded so token levels stay exact (OP-R1-05)", () => {
  it("a magnitude above MAX_TOKEN_MAGNITUDE is MALFORMED and never interpreted, from headers or from the SDK observation", () => {
    expect(MAX_TOKEN_MAGNITUDE).toBe(9_007_199_254);
    expect(headers(200, { "Poly-RateLimit-Remaining": "-9007199254" }).remaining).toBe(-9_007_199_254);
    for (const value of ["-9007199255", "-123456789012345", "9007199254740991"]) {
      expect(headers(200, { "Poly-RateLimit-Remaining": value }), value).toMatchObject({ remaining: null, flags: [{ kind: "MALFORMED_HEADER", header: "Poly-RateLimit-Remaining" }] });
    }
    expect(feedbackFromObservation({ bucket: "cancel", remaining: -123_456_789_012_345, resetUnixSeconds: null, tier: null, warning: false })).toMatchObject({
      remaining: null,
      flags: [{ kind: "MALFORMED_HEADER", header: "Poly-RateLimit-Remaining" }],
    });
  });

  it("the budget's level stays an exact integer of thousandths, and a hand-built feedback outside the bound is refused", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const absurd = headers(200, { "Poly-RateLimit-Remaining": "-123456789012345" });
    const result = budget.complete(grant, { atMs: T0, feedback: absurd });
    expect(result.ok && result.value).toEqual([{ kind: "FEEDBACK_FLAG", flag: { kind: "MALFORMED_HEADER", header: "Poly-RateLimit-Remaining" } }]);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("5");
    const forged: RateLimitFeedback = { httpStatus: 200, remaining: -123_456_789_012_345, resetUnixSeconds: null, tier: null, warning: false, retryAfterSeconds: null, flags: [] };
    expect(budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, forged, T0)).toMatchObject({ ok: false, refusal: { code: "INVALID_REQUEST" } });
    const sweep = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.complete(sweep, { atMs: T0, canceledCount: 123_456_789_012_345 })).toMatchObject({ ok: false, refusal: { code: "INVALID_COMPLETION" } });
    expect(budget.complete(sweep, { atMs: T0, canceledCount: 2 }).ok).toBe(true);
    // 6 (full) - 1 (the cancel) - 1 (the cancel-all) - 2 (canceled): exact.
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("2");
  });
});
