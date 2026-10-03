/**
 * WP-310 deliverable 2 and acceptance 4: each documented header changes the
 * budget as documented; an undocumented header is inert and flagged; a 429
 * with `Retry-After` waits exactly that long. Synthetic snapshot numbers.
 */

import { describe, expect, it } from "vitest";

import type { Grant, RateLimitBudget, RequestDecision } from "./budget.js";
import { SIGNER_A, T0, budgetOf, snapshot, warm } from "./fixtures.test-support.js";
import { feedbackFromObservation, parseRateLimitHeaders, signerBucketOfObservation, type RateLimitFeedback } from "./headers.js";

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
    expect(budget.view(T0 + 6).ipEndpointClasses.every((entry) => entry.blockedUntilMs === null)).toBe(true);
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

  it("a request with no signer bucket: a 429 waits on its IP classes; header fields are flagged, not applied", () => {
    const budget = budgetOf();
    const grant = grantOf(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0));
    const result = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 1 }, feedback: headers(429, { "Poly-RateLimit-Remaining": "0" }) });
    expect(result.ok && result.value.filter((effect) => effect.kind === "WAIT_APPLIED").map((effect) => (effect.kind === "WAIT_APPLIED" ? effect.budget : null))).toEqual([
      { dimension: "IP_ENDPOINT_CLASS", classId: "shared" },
      { dimension: "IP_ENDPOINT_CLASS", classId: "reads" },
    ]);
    expect(result.ok && result.value).toContainEqual({ kind: "FEEDBACK_WITHOUT_SIGNER_BUCKET" });
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 + 999).kind).toBe("QUEUED");
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
