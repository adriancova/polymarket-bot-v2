/**
 * WP-340: the matching engine's restricted modes and the per-signer rate
 * limit, against the mock CLOB, with WP-260's REAL classification of the
 * pinned SDK's own errors, WP-310's REAL `VenueModeDetector` in front of
 * WP-270's REAL OMS (`withModeDetection`, `venueModeSource`; the dated
 * venue-valued snapshot `restricted-modes-2026-09-30`), WP-310's REAL
 * `RateLimitBudget` (the dated `rate-limits-2026-09-30` snapshot) in front
 * of the venue as the composition must place it (WP-310 follow_up 1), and
 * WP-290's coordinator reconciling what each refusal left unknown.
 *
 * Documented behaviour the mock serves (`verified-2026-09-30.md` §9, E-05 …
 * E-07; §8): HTTP 425 on order-related requests while the engine restarts,
 * then post-only for two minutes (cancels allowed; a non-post-only order is
 * refused `503 post_only_mode`); cancel-only answered with the
 * indistinguishable `503 {"error": "trading is disabled"}`, cancels still
 * working; per-signer buckets with `Poly-RateLimit-*` feedback and `429`
 * with `Retry-After`.
 *
 * What each case holds: no duplicate exposure (the mock's oracle), a refused
 * or unknown placement never followed by a second salt while it may still
 * exist, "Do not retry the same non-post-only order unchanged" (E-07: no
 * non-post-only order ever reaches the venue inside the post-only window),
 * "Retry only restart rejections", and every resume consistent (R1).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OmsVenuePort, OrderManager, PlacementOutcome } from "../../../packages/oms/src/index.js";
import { feedbackFromObservation, RateLimitBudget, type RateLimitObservation } from "../../../packages/polymarket-secure/src/index.js";
import { installNetworkTripwire, MOCK_SIGNER_ADDRESS, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { POST_ONLY_AFTER_RESTART_MS } from "./support/mock-clob.js";
import { bootNode, liveWorld, NO, reconcileUntilResumed, YES, type LiveNode, type LiveWorld } from "./support/live-node.js";
import { recoveryProblems } from "./support/oracle.js";
import { RATE_LIMIT_SNAPSHOT } from "./support/safety-node.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** WP-310's dated, venue-valued restricted-mode snapshot: the documented two-minute post-only window. */
const MODES_SNAPSHOT: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, "test/contract/rate-limits/fixtures/restricted-modes-2026-09-30.snapshot.json"), "utf8"));

const G_TAKER = group(34701, { tokenId: YES, plannedShares: "5" });
const G_POST = group(34702, { tokenId: NO, plannedShares: "5", postOnly: true });

interface Ready {
  readonly world: LiveWorld;
  readonly node: LiveNode;
  readonly oms: OrderManager;
}

async function ready(options: { readonly wrapVenue?: (venue: OmsVenuePort) => OmsVenuePort; readonly onRateLimitUpdate?: (observation: RateLimitObservation) => void } = {}): Promise<Ready> {
  const world = await liveWorld();
  for (const spec of [G_TAKER, G_POST]) world.clob.plannedShares.set(`${spec.tokenId}|${spec.side}`, spec.plannedShares);
  const node = await bootNode(world, {
    modeDetection: MODES_SNAPSHOT,
    ...(options.wrapVenue === undefined ? {} : { wrapVenue: options.wrapVenue }),
    ...(options.onRateLimitUpdate === undefined ? {} : { onRateLimitUpdate: options.onRateLimitUpdate }),
  });
  expect(await reconcileUntilResumed(world, node)).toBe(true);
  const oms = node.oms as OrderManager;
  for (const spec of [G_TAKER, G_POST]) expect((await oms.registerGroup(spec)).ok).toBe(true);
  return { world, node, oms };
}

/** Every placement the venue saw, with how it answered, in order. */
function placements(world: LiveWorld): { readonly salt: string; readonly answer: string; readonly atMs: number; readonly postOnly: boolean }[] {
  return world.clob.log
    .filter((entry) => entry.kind === "PLACE")
    .map((entry) => {
      const [salt = "", answer = ""] = entry.detail.split(":");
      return { salt, answer, atMs: entry.atMs, postOnly: G_POST.tokenId === world.clob.signed.get(salt)?.tokenId };
    });
}

describe("WP-340: restricted modes and rate limits against the mock CLOB, through WP-260, WP-310 and WP-270", () => {
  it("a 425 restart, then the documented two-minute post-only window: no placement while restarting, no non-post-only order ever reaches the venue in the window, the 425'd order is never duplicated, cancels pass, and the mode returns to normal", async () => {
    const r = await ready();
    r.world.clob.restart(3_000);
    const first = await r.oms.submit(ticket(G_TAKER, { n: 1, shares: "1" }));
    expect(first.ok && first.value.attemptState).toBe("RECONCILING");
    // WP-260 classified the pinned SDK's 425 (UNKNOWN, ENGINE_RESTARTING); WP-310 now holds placements.
    expect(r.node.detector?.snapshot(r.world.time.epochMs()).mode).toBe("RESTARTING");
    const blocked = await r.oms.submit(ticket(G_POST, { n: 2, shares: "1" }));
    expect(blocked.ok).toBe(false);
    expect(placements(r.world)).toHaveLength(1);
    // The restart ends at the venue; WP-310 holds post-only until an answer shows the engine back (OP-R2-05).
    await r.world.time.advance(3_500);
    expect(r.world.clob.mode()).toBe("POST_ONLY");
    expect(r.oms.attempt(first.ok ? first.value.submissionAttemptId : "")?.state).toBe("RECONCILING");
    // The 425'd order is reconciled ABSENT after the quiescence horizon (it never reached the book).
    await reconcileUntilResumed(r.world, r.node);
    const held = r.oms.attempt(first.ok ? first.value.submissionAttemptId : "");
    expect(held?.absentConfirmed).toBe(true);
    // Its SAME signed order is NOT post-only: WP-310's retransmission gate refuses it inside the post-only window (E-07).
    const resend = await r.oms.retransmitSameSignedOrder(held?.submissionAttemptId ?? "");
    expect(resend.ok).toBe(false);
    // So the composition abandons it (accepted only for an authoritatively absent, quiescent attempt), and the OMS resumes.
    expect((await r.oms.abandonAttempt(held?.submissionAttemptId ?? "")).ok).toBe(true);
    expect(r.world.clob.orders.has(held?.salt ?? "")).toBe(false);
    expect(await reconcileUntilResumed(r.world, r.node)).toBe(true);
    // A post-only order is placed; its answer shows the engine back, which anchors the two-minute window.
    const post = await r.oms.submit(ticket(G_POST, { n: 3, shares: "1" }));
    expect(post.ok && post.value.orderState).toBe("LIVE");
    expect(r.node.detector?.snapshot(r.world.time.epochMs()).mode).toBe("POST_ONLY");
    // A new non-post-only order is refused by the OMS in the window: it never reaches the venue.
    const taker = await r.oms.submit(ticket(G_TAKER, { n: 4, shares: "1" }));
    expect(taker.ok).toBe(false);
    // Cancels are allowed in post-only mode (§9): the post-only order is cancelled at the venue (after its PLACEMENT
    // frame arrived: a cancel answered before that frame is WP340-F1's third route, pinned in `findings.test.ts`).
    await r.world.time.advance(0);
    expect((await r.oms.requestCancel(post.ok ? post.value.orderId : "")).ok).toBe(true);
    expect(r.world.clob.openOrderIds()).toEqual([]);
    // After the window the mode is normal again; the abandoned 425'd order's group trades with a NEW salt, and its old one is never sent again.
    await r.world.time.advance(POST_ONLY_AFTER_RESTART_MS + 1_000);
    expect(r.node.detector?.snapshot(r.world.time.epochMs()).mode).toBe("NORMAL");
    expect(await reconcileUntilResumed(r.world, r.node)).toBe(true);
    const fresh = await r.oms.submit(ticket(G_TAKER, { n: 5, shares: "1" }));
    expect(fresh.ok && fresh.value.orderState, JSON.stringify(fresh)).toBe("LIVE");
    // E-07 and S2, from the venue's record: nothing non-post-only inside the window, no answer was ever a post-only refusal.
    const inWindow = placements(r.world).filter((entry) => entry.answer !== "425" && entry.atMs < r.world.time.now - 1_000);
    expect(inWindow.filter((entry) => !entry.postOnly)).toEqual([]);
    expect(placements(r.world).filter((entry) => entry.answer === "503-post-only")).toEqual([]);
    expect(r.world.clob.receipts.filter((salt) => salt === held?.salt).length).toBe(1);
    expect(r.world.clob.violations).toEqual([]);
    expect(recoveryProblems(r.world, r.node, await reconcileUntilResumed(r.world, r.node))).toEqual([]);
  });

  it("cancel-only (the indistinguishable 503 \"trading is disabled\", E-05): the placement is UNKNOWN, placements pause, it reconciles ABSENT; cancels still work at the venue and the resting order is removed", async () => {
    const r = await ready();
    const resting = await r.oms.submit(ticket(G_POST, { n: 10, shares: "1" }));
    expect(resting.ok && resting.value.orderState).toBe("LIVE");
    await r.world.time.advance(0);
    r.world.clob.disableTrading();
    const refused = await r.oms.submit(ticket(G_TAKER, { n: 11, shares: "1" }));
    expect(refused.ok && refused.value.attemptState).toBe("RECONCILING");
    expect(r.node.detector?.snapshot(r.world.time.epochMs()).mode).toBe("TRADING_UNAVAILABLE");
    // "Pause new submissions": a second placement is refused before it is sent.
    const before = placements(r.world).length;
    expect((await r.oms.submit(ticket(G_POST, { n: 12, shares: "1" }))).ok).toBe(false);
    expect(placements(r.world)).toHaveLength(before);
    // "Works even in cancel-only mode": the resting order is cancelled.
    expect((await r.oms.requestCancel(resting.ok ? resting.value.orderId : "")).ok).toBe(true);
    expect(r.world.clob.openOrderIds()).toEqual([]);
    await reconcileUntilResumed(r.world, r.node);
    // Read ABSENT after the quiescence horizon, the unknown placement is closed: nothing was placed, nothing is reserved.
    expect(r.oms.order(refused.ok ? refused.value.orderId : "")).toMatchObject({ state: "REJECTED", filledShares: "0" });
    expect(r.world.clob.violations).toEqual([]);
    r.world.clob.clearTradingDisabled();
    expect(recoveryProblems(r.world, r.node, await reconcileUntilResumed(r.world, r.node))).toEqual([]);
  });

  it("a per-signer 429 (the bucket drained by another tool): the pinned SDK's RateLimitError is UNKNOWN, never a rejection; it reconciles ABSENT; the venue's documented headers reach WP-310's budget, which holds the next order for Retry-After", async () => {
    const budget = RateLimitBudget.create([RATE_LIMIT_SNAPSHOT]);
    if (!budget.ok) throw new Error("the rate-limit snapshot did not load");
    const observations: RateLimitObservation[] = [];
    const granted: string[] = [];
    let world: LiveWorld | null = null;
    // The composition WP-310 follow_up 1 asks for: request before every placement, complete after, with the answer's error and headers.
    const budgeted = (venue: OmsVenuePort): OmsVenuePort => ({
      createLimitOrder: (request) => venue.createLimitOrder(request),
      cancelOrder: (orderId) => venue.cancelOrder(orderId),
      postOrders: (orders) => venue.postOrders(orders),
      postOrder: async (order) => {
        const now = world?.time.epochMs() ?? 0;
        const decision = budget.value.request({ operationId: "clob.post_order", priority: "NEW_ORDER", signer: MOCK_SIGNER_ADDRESS }, now);
        if (decision.kind !== "GRANTED") {
          if (decision.kind === "QUEUED") budget.value.withdraw(decision.ticketId);
          const notSent: PlacementOutcome = { kind: "NOT_SENT", error: { kind: "BUDGET_WAIT", effect: "NOT_SENT", retryAfterSeconds: null } };
          return notSent;
        }
        granted.push(decision.grant.grantId);
        const outcome = await venue.postOrder(order);
        const error = outcome.kind === "NOT_SENT" || outcome.kind === "REFUSED" || outcome.kind === "UNKNOWN" ? outcome.error : null;
        const latest = observations.at(-1);
        budget.value.complete(decision.grant, {
          atMs: world?.time.epochMs() ?? now,
          error: error === null ? null : { kind: error.kind, retryAfterSeconds: error.retryAfterSeconds },
          feedback: latest === undefined ? null : feedbackFromObservation(latest, { httpStatus: error?.kind === "RATE_LIMITED" ? 429 : 200, retryAfterSeconds: error?.retryAfterSeconds ?? null }),
        });
        return outcome;
      },
    });
    const r = await ready({ wrapVenue: budgeted, onRateLimitUpdate: (observation) => void observations.push(observation) });
    world = r.world;
    // WP-310's cold start: a signer seen for the first time starts with empty buckets, which refill from that instant.
    const warm = budget.value.request({ operationId: "clob.post_order", priority: "NEW_ORDER", signer: MOCK_SIGNER_ADDRESS }, r.world.time.epochMs());
    if (warm.kind === "QUEUED") budget.value.withdraw(warm.ticketId);
    await r.world.time.advance(2_000);
    expect(r.node.client.identity.signerAddress).toBe(MOCK_SIGNER_ADDRESS);
    const accepted = await r.oms.submit(ticket(G_POST, { n: 20, shares: "1" }));
    expect(accepted.ok && accepted.value.orderState).toBe("LIVE");
    // The venue's documented headers, sanitized by WP-260's client: the order bucket, its Remaining, the tier, no warning.
    expect(observations.at(-1)).toMatchObject({ bucket: "order", remaining: 59, tier: "Standard", warning: false });
    r.world.clob.drainOrderBucket("trader");
    const limited = await r.oms.submit(ticket(G_TAKER, { n: 21, shares: "1" }));
    // WP-260 CX-R2-02: every 429 is UNKNOWN (the SDK throws before reading the body): SUBMISSION_UNKNOWN, reconciled.
    expect(limited.ok && limited.value.attemptState).toBe("RECONCILING");
    // The venue's headers on the 429 said the order bucket is empty, and WP-260 carried them through.
    expect(observations.at(-1)).toMatchObject({ bucket: "order", remaining: 0, tier: "Standard" });
    // WP-310's budget took the 429's Retry-After (2 s) on the bucket that was charged: asked directly, it grants no
    // NEW_ORDER for this signer inside the window, and grants one once the window has passed.
    const order = { operationId: "clob.post_order", priority: "NEW_ORDER", signer: MOCK_SIGNER_ADDRESS } as const;
    const within = budget.value.request(order, r.world.time.epochMs());
    expect(within.kind).not.toBe("GRANTED");
    if (within.kind === "QUEUED") budget.value.withdraw(within.ticketId);
    await r.world.time.advance(2_500);
    const after = budget.value.request(order, r.world.time.epochMs());
    expect(after.kind).toBe("GRANTED");
    if (after.kind === "GRANTED") budget.value.complete(after.grant, { atMs: r.world.time.epochMs(), error: null, feedback: null });
    await reconcileUntilResumed(r.world, r.node);
    expect(r.oms.order(limited.ok ? limited.value.orderId : "")).toMatchObject({ state: "REJECTED", filledShares: "0" });
    expect(placements(r.world).find((entry) => entry.answer === "429")).toBeDefined();
    expect(r.world.clob.violations).toEqual([]);
    expect(recoveryProblems(r.world, r.node, await reconcileUntilResumed(r.world, r.node))).toEqual([]);
    expect(granted.length).toBeGreaterThanOrEqual(2);
  });
});
