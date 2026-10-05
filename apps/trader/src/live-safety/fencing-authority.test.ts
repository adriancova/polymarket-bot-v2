/**
 * WP-320 deliverable 1, the process's half: the fencing authority's local
 * deadline, its latched loss, its takeover wait, and its refusal of every
 * simulated run mode and every context above its ceiling (work-plan
 * acceptance: "Paper mode cannot acquire live fencing"; "Two live writers
 * cannot both hold authority"). The database half is
 * `test/integration/postgres/fencing-race.test.ts`.
 */

import { FENCING_LEASE_MAX_TTL_MS, FENCING_LEASE_MIN_TTL_MS } from "@polymarket-bot/storage-postgres";
import { describe, expect, it } from "vitest";

import { LIVE_CONTEXT, ManualClock, MemoryFencingStore, REPOSITORY_DEFAULTS_LIVE_MICRO } from "./fakes.test-support.js";
import {
  evaluateLiveFencingContext,
  FencingAuthority,
  FencingAuthorityConfigurationError,
  LiveFencingRefusal,
  type FencingAuthorityOptions,
  type FencingLeasePort,
  type RunModeContext,
} from "./fencing-authority.js";

const TTL = 30_000;
const SAFETY = 2_000;
const TRANSMIT = 3_000;
/** The takeover wait: the code-level bound on EVERY lease plus the safety margin, on the successor's own clock (r2 X1). */
const WAIT = FENCING_LEASE_MAX_TTL_MS + SAFETY;

function context(runMode: string): RunModeContext {
  return { runMode, maximumRunMode: "LIVE", allowRealOrders: true };
}

function setup(overrides: Partial<FencingAuthorityOptions> = {}): { clock: ManualClock; store: MemoryFencingStore; authority: FencingAuthority } {
  const clock = new ManualClock();
  const store = new MemoryFencingStore(() => clock.now);
  const authority = FencingAuthority.create({
    runModeContext: LIVE_CONTEXT,
    accountRef: "acct-1",
    holderId: "trader-a",
    store,
    clock,
    ttlMs: TTL,
    safetyMarginMs: SAFETY,
    transmitMarginMs: TRANSMIT,
    ...overrides,
  });
  return { clock, store, authority };
}

describe("work-plan acceptance: paper mode cannot acquire live fencing", () => {
  for (const runMode of ["PAPER", "BACKTEST", "SHADOW", "REPLAY", "paper", "", undefined]) {
    it(`refuses run mode ${JSON.stringify(runMode)} before touching the store`, () => {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      expect(() =>
        FencingAuthority.create({
          runModeContext: context(runMode as string),
          accountRef: "acct-1",
          holderId: "trader-a",
          store,
          clock,
          ttlMs: TTL,
          safetyMarginMs: SAFETY,
          transmitMarginMs: TRANSMIT,
        }),
      ).toThrow(LiveFencingRefusal);
      expect(store.calls).toEqual([]);
      expect(store.rows).toEqual([]);
    });
  }

  for (const runMode of ["EXECUTION_PROBE", "LIVE_MICRO", "LIVE"]) {
    it(`builds in ${runMode} when the ceiling and the real-order flag permit it`, () => {
      expect(() => setup({ runModeContext: context(runMode) })).not.toThrow();
    });
  }

  // r1, I8: the run-mode STRING alone never suffices; the ceiling and the real-order flag are read too.
  for (const [name, runModeContext, reason] of [
    ["the repository's defaults (MAX_RUN_MODE=PAPER, ALLOW_REAL_ORDERS=false)", REPOSITORY_DEFAULTS_LIVE_MICRO, "RUN_MODE_ABOVE_MAXIMUM"],
    ["a run mode above its ceiling", { runMode: "LIVE", maximumRunMode: "LIVE_MICRO", allowRealOrders: true }, "RUN_MODE_ABOVE_MAXIMUM"],
    ["real orders not allowed", { runMode: "LIVE_MICRO", maximumRunMode: "LIVE", allowRealOrders: false }, "REAL_ORDERS_NOT_ALLOWED"],
    ['the string "true" for the real-order flag', { runMode: "LIVE_MICRO", maximumRunMode: "LIVE", allowRealOrders: "true" }, "REAL_ORDERS_NOT_ALLOWED"],
    ["an unknown ceiling", { runMode: "LIVE_MICRO", maximumRunMode: "live", allowRealOrders: true }, "MAXIMUM_RUN_MODE_UNKNOWN"],
    ["a context with an extra field", { ...LIVE_CONTEXT, signer: "x" }, "CONTEXT_UNREADABLE"],
    ["a context whose flag is a getter", Object.defineProperty({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO" }, "allowRealOrders", { get: () => true, enumerable: true }), "CONTEXT_UNREADABLE"],
    ["a run-mode string with no context", "LIVE_MICRO", "CONTEXT_UNREADABLE"],
  ] as const) {
    it(`refuses ${name} before touching the store (r1 I8)`, () => {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      let refusal: unknown;
      try {
        FencingAuthority.create({ runModeContext: runModeContext as unknown as RunModeContext, accountRef: "acct-1", holderId: "trader-a", store, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(LiveFencingRefusal);
      expect((refusal as LiveFencingRefusal).reasons).toContain(reason);
      expect(store.calls).toEqual([]);
    });
  }

  it("evaluateLiveFencingContext permits exactly a live mode within its ceiling with real orders allowed", () => {
    expect(evaluateLiveFencingContext(LIVE_CONTEXT)).toEqual({ permitted: true, context: { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true } });
    expect(evaluateLiveFencingContext({ runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false })).toMatchObject({
      permitted: false,
      reasons: ["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"],
    });
  });

  it("the store is handed the ceiling and the flag with every acquisition (a second layer, before any SQL)", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    const seen: unknown[] = [];
    const recording: FencingLeasePort = {
      acquire: async (input) => {
        seen.push({ environment: input.environment, maximumRunMode: input.maximumRunMode, allowRealOrders: input.allowRealOrders });
        return store.acquire(input);
      },
      renew: async (ref, ttl) => store.renew(ref, ttl),
      release: async (ref, reason) => store.release(ref, reason),
      recordHeartbeatId: async (ref, id) => store.recordHeartbeatId(ref, id),
    };
    const authority = FencingAuthority.create({ runModeContext: LIVE_CONTEXT, accountRef: "acct-1", holderId: "trader-a", store: recording, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT });
    expect((await authority.acquire()).kind).toBe("ACQUIRED");
    expect(seen).toEqual([{ environment: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true }]);
    await expect(store.acquire({ accountRef: "acct-2", environment: "LIVE_MICRO", maximumRunMode: "PAPER", allowRealOrders: false, holderId: "x", ttlMs: TTL })).rejects.toThrow(/not permitted/u);
  });

  it("refuses margins that leave no usable lease", () => {
    expect(() => setup({ safetyMarginMs: 20_000, transmitMarginMs: 10_000 })).toThrow(FencingAuthorityConfigurationError);
    expect(() => setup({ ttlMs: 0 })).toThrow(FencingAuthorityConfigurationError);
  });
});

describe("the local deadline (monotonic, from the instant before the call)", () => {
  it("is held after acquiring, until ttl − safety − transmit margins have passed", async () => {
    const { clock, authority } = setup();
    expect(authority.check()).toMatchObject({ held: false, reason: "NOT_ACQUIRED" });
    const acquired = await authority.acquire();
    expect(acquired.kind).toBe("ACQUIRED");
    expect(authority.check().held).toBe(true);
    // Held while at least the transmit margin is left.
    await clock.advance(TTL - SAFETY - TRANSMIT);
    expect(authority.check().held).toBe(true);
    await clock.advance(1);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRING" });
    await clock.advance(TRANSMIT - 1);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRED" });
  });

  it("an expired grant is LOST for good: a later renewal is refused without asking the database (a stale holder never renews)", async () => {
    const { clock, store, authority } = setup();
    await authority.acquire();
    await clock.advance(TTL);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRED" });
    const before = store.calls.length;
    expect(await authority.renew()).toBe("NOT_HELD");
    expect(store.calls.length).toBe(before);
    expect(authority.check().held).toBe(false);
  });

  it("a renewal extends the deadline from the instant before the renewal call", async () => {
    const { clock, authority } = setup();
    await authority.acquire();
    await clock.advance(10_000);
    expect(await authority.renew()).toBe("RENEWED");
    await clock.advance(TTL - SAFETY - TRANSMIT - 1);
    expect(authority.check().held).toBe(true);
  });

  it("a renewal the database refuses (another holder, revocation) latches LOST", async () => {
    const { store, authority } = setup();
    const acquired = await authority.acquire();
    if (acquired.kind !== "ACQUIRED") throw new Error("not acquired");
    expect(store.revoke(acquired.fence.fencingLeaseId, "operator revocation")).toBe(true);
    expect(await authority.renew()).toBe("LOST");
    expect(authority.check()).toMatchObject({ held: false, reason: "RENEW_LOST" });
    expect(authority.lossReason()).toBe("RENEW_LOST");
  });

  it("a renewal whose outcome is unknown (the database is down) keeps the old deadline, then loses the grant when it passes", async () => {
    const { clock, store, authority } = setup();
    await authority.acquire();
    store.down = true;
    await clock.advance(10_000);
    expect(await authority.renew()).toBe("UNKNOWN");
    expect(authority.check().held).toBe(true);
    await clock.advance(TTL - SAFETY - 10_000);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRED" });
    // The database comes back: the stale grant is still never renewed.
    store.down = false;
    expect(await authority.renew()).toBe("NOT_HELD");
  });

  it("a renewal the database APPLIED but whose answer was lost: the local deadline stands, the grant lapses, and it is never renewed again although the database would still accept it", async () => {
    const { clock, store, authority } = setup();
    const acquired = await authority.acquire();
    if (acquired.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(20_000);
    store.loseNextRenewAnswer = true;
    expect(await authority.renew()).toBe("UNKNOWN");
    // The database extended the lease to +50 s; the process still believes +28 s.
    await clock.advance(8_000);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRED" });
    expect(store.attemptAccepted(acquired.fence)).toBe(true);
    const asked = store.calls.length;
    expect(await authority.renew()).toBe("NOT_HELD");
    expect(store.calls.length).toBe(asked);
    expect(authority.check().held).toBe(false);
  });

  it("the local deadline never falls after the database's expiry", async () => {
    const { clock, store, authority } = setup();
    const acquired = await authority.acquire();
    if (acquired.kind !== "ACQUIRED") throw new Error("not acquired");
    for (let step = 0; step < 60; step += 1) {
      await clock.advance(500);
      if (authority.check().held) expect(store.attemptAccepted(acquired.fence)).toBe(true);
    }
  });

  it("renewals are serialized: a renewal asked while another is outstanding asks nothing (IN_PROGRESS)", async () => {
    const { store, authority } = setup();
    await authority.acquire();
    const first = authority.renew();
    expect(await authority.renew()).toBe("IN_PROGRESS");
    expect(await first).toBe("RENEWED");
    expect(store.calls.filter((call) => call === "renew")).toHaveLength(1);
  });

  it("a monotonic reading that goes backwards loses the grant (CLOCK_FAULT)", async () => {
    const { clock, authority } = setup();
    await authority.acquire();
    clock.injectReading(clock.now - 1_000);
    expect(authority.check()).toMatchObject({ held: false, reason: "CLOCK_FAULT" });
    expect(authority.check()).toMatchObject({ held: false, reason: "CLOCK_FAULT" });
  });

  it("re-acquiring after a loss waits out its OWN ended lease, then takes a NEW grant with a higher token", async () => {
    const { clock, store, authority } = setup();
    const first = await authority.acquire();
    await clock.advance(TTL);
    expect(await authority.acquire()).toMatchObject({ kind: "LAPSED_WAITING", remainingMs: WAIT });
    await clock.advance(WAIT);
    const second = await authority.acquire();
    expect(first.kind === "ACQUIRED" && second.kind === "ACQUIRED" && BigInt(second.fence.fencingToken) > BigInt(first.fence.fencingToken)).toBe(true);
    expect(store.rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
  });

  it("r1 I12 (N5): a renewal answer that lands after the grant was REPLACED changes nothing; the new grant stays held", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    let releaseRenewal: () => void = () => undefined;
    let hold = false;
    const slow: FencingLeasePort = {
      acquire: async (input) => store.acquire(input),
      renew: async (ref, ttl) => {
        if (hold) {
          await new Promise<void>((resolve) => {
            releaseRenewal = resolve;
          });
        }
        return store.renew(ref, ttl);
      },
      release: async (ref, reason) => store.release(ref, reason),
      recordHeartbeatId: async (ref, id) => store.recordHeartbeatId(ref, id),
    };
    const authority = FencingAuthority.create({ runModeContext: LIVE_CONTEXT, accountRef: "acct-1", holderId: "trader-a", store: slow, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT });
    const first = await authority.acquire();
    hold = true;
    const late = authority.renew();
    // The outstanding renewal never answers in time: the grant lapses, is waited out, and is REPLACED.
    await clock.advance(TTL);
    expect(authority.check()).toMatchObject({ held: false, reason: "EXPIRED" });
    expect((await authority.acquire()).kind).toBe("LAPSED_WAITING");
    await clock.advance(WAIT);
    const second = await authority.acquire();
    expect(second.kind).toBe("ACQUIRED");
    expect(first.kind === "ACQUIRED" && second.kind === "ACQUIRED" && second.fence.fencingToken !== first.fence.fencingToken).toBe(true);
    // The first grant's renewal answers now (LOST: that lease ended): it must not touch the new grant.
    hold = false;
    releaseRenewal();
    expect(await late).toBe("NOT_HELD");
    expect(authority.check().held).toBe(true);
    expect(authority.lossReason()).toBeNull();
  });
});

describe("work-plan acceptance: two live writers cannot both hold authority", () => {
  function pair(dbSkew: () => number = () => 0): { clock: ManualClock; store: MemoryFencingStore; a: FencingAuthority; b: FencingAuthority } {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now + dbSkew());
    const options = { runModeContext: LIVE_CONTEXT, accountRef: "acct-1", store, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT };
    return { clock, store, a: FencingAuthority.create({ ...options, holderId: "trader-a" }), b: FencingAuthority.create({ ...options, holderId: "trader-b" }) };
  }

  it("a second process is refused while the first's lease is unexpired, and takes over only after waiting out its whole lease; never both", async () => {
    const { clock, store, a, b } = pair();
    expect((await a.acquire()).kind).toBe("ACQUIRED");
    expect((await b.acquire()).kind).toBe("HELD_ELSEWHERE");
    for (let step = 0; step < 240; step += 1) {
      await clock.advance(500);
      if (step % 7 === 0) await b.acquire();
      expect(a.check().held && b.check().held).toBe(false);
      // At no instant do two processes believe they hold authority, and the database names at most one holder.
      expect(store.activeHolders("acct-1").length).toBeLessThanOrEqual(1);
    }
    expect(b.check().held).toBe(true);
    expect(a.check().held).toBe(false);
  });

  it("a stale holder's submission is refused by the database (migration 0008) after a takeover", async () => {
    const { clock, store, a, b } = pair();
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(TTL);
    expect((await b.acquire()).kind).toBe("LAPSED_WAITING");
    await clock.advance(WAIT);
    expect((await b.acquire()).kind).toBe("ACQUIRED");
    expect(store.attemptAccepted(first.fence)).toBe(false);
    expect(store.attemptAccepted(b.currentFence())).toBe(true);
  });

  /**
   * r1, I1 (CRITICAL). Both gates are exercised at every step: A's `check()` (which its heartbeat gate and every
   * transmission ask) and B's. On the candidate, B was granted at once after the revocation while A's local deadline
   * still held: both `held`.
   */
  it("r1 I1: an operator's REVOCATION does not hand the fence to a successor at once; the successor waits a whole lease from its first sight, and never both hold", async () => {
    const { clock, store, a, b } = pair();
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(10_000);
    expect(await a.renew()).toBe("RENEWED");
    expect(store.revoke(first.fence.fencingLeaseId, "operator: suspected second writer")).toBe(true);
    // Immediately after the revocation: A does not know yet (its local deadline stands); B is NOT granted.
    const immediate = await b.acquire();
    expect(immediate).toMatchObject({ kind: "LAPSED_WAITING", status: "REVOKED", remainingMs: WAIT });
    expect(a.check().held).toBe(true);
    expect(b.check().held).toBe(false);
    let bothHeld = 0;
    let acquiredAt: number | null = null;
    const firstSight = clock.now;
    for (let step = 0; step < 160 && acquiredAt === null; step += 1) {
      await clock.advance(500);
      if (step % 10 === 0) await a.renew();
      const result = await b.acquire();
      if (result.kind === "ACQUIRED") acquiredAt = clock.now;
      if (a.check().held && b.check().held) bothHeld += 1;
    }
    expect(bothHeld).toBe(0);
    expect(acquiredAt).not.toBeNull();
    expect((acquiredAt ?? 0) - firstSight).toBeGreaterThanOrEqual(WAIT);
    expect(a.lossReason()).toBe("RENEW_LOST");
    expect(store.attemptAccepted(first.fence)).toBe(false);
  });

  it("r1 I1: a DATABASE clock that steps forward past the margin does not let a successor take over while the old holder's local deadline holds; never both", async () => {
    let skew = 0;
    const { clock, store, a, b } = pair(() => skew);
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(1_000);
    // The database's clock jumps 40 s ahead: by ITS clock A's lease has ended; A has not renewed since.
    skew = 40_000;
    expect(store.attemptAccepted(first.fence)).toBe(false);
    // B asks BEFORE A's next renewal: on the candidate it was granted here, with A still held.
    const immediate = await b.acquire();
    expect(immediate.kind).toBe("LAPSED_WAITING");
    expect(a.check().held).toBe(true);
    expect(b.check().held).toBe(false);
    let bothHeld = 0;
    let acquired = false;
    for (let step = 0; step < 160 && !acquired; step += 1) {
      await clock.advance(500);
      if (step % 10 === 0) await a.renew();
      acquired = (await b.acquire()).kind === "ACQUIRED";
      if (a.check().held && b.check().held) bothHeld += 1;
    }
    expect(acquired).toBe(true);
    expect(bothHeld).toBe(0);
    expect(a.lossReason()).toBe("RENEW_LOST");
  });

  it("a version that changes while the successor waits restarts its wait (a renewal the database accepted again)", async () => {
    let skew = 0;
    const { clock, a, b } = pair(() => skew);
    expect((await a.acquire()).kind).toBe("ACQUIRED");
    skew = 40_000;
    expect((await b.acquire()).kind).toBe("LAPSED_WAITING");
    await clock.advance(10_000);
    // The database's clock steps back: A's lease is unexpired again, and A renews it (a new version).
    skew = 0;
    expect(await a.renew()).toBe("RENEWED");
    expect((await b.acquire()).kind).toBe("HELD_ELSEWHERE");
    skew = 60_000;
    const again = await b.acquire();
    expect(again).toMatchObject({ kind: "LAPSED_WAITING", remainingMs: WAIT });
  });

  it("a takeover is presented only once the wait has passed: one millisecond early is still waiting", async () => {
    const { clock, a, b } = pair();
    expect((await a.acquire()).kind).toBe("ACQUIRED");
    await clock.advance(TTL);
    expect((await b.acquire()).kind).toBe("LAPSED_WAITING");
    await clock.advance(WAIT - 1);
    expect(await b.acquire()).toMatchObject({ kind: "LAPSED_WAITING", remainingMs: 1 });
    await clock.advance(1);
    expect((await b.acquire()).kind).toBe("ACQUIRED");
  });
});

/**
 * r2, X1 (CRITICAL). At round 1 the successor waited its OWN `ttl + safetyMargin`: a successor configured with a
 * shorter TTL than its incumbent presented its takeover while the incumbent's local deadline still held, and both
 * fenced ports sent (reproduced on real PostgreSQL by both verifiers). The wait is now the code-level bound on every
 * lease, which the store enforces on every grant and renewal, plus the successor's margin; and the store grants over
 * an incumbent only once its own expiry has passed by the database's clock.
 */
describe("r2 X1: the takeover wait is the code-level bound on EVERY lease, never the successor's own ttl", () => {
  it("the bound is one minute; takeoverWaitMs is the bound plus this process's margin, whatever its own ttl", () => {
    expect(FENCING_LEASE_MAX_TTL_MS).toBe(60_000);
    for (const ttlMs of [1_000, 5_000, 30_000, 60_000]) {
      const { authority } = setup({ ttlMs, safetyMarginMs: 300, transmitMarginMs: 300 });
      expect(authority.takeoverWaitMs).toBe(60_300);
    }
  });

  it("a ttl above the bound (or below the minimum) is refused at create, before the store is touched; the store refuses it on renewal too", async () => {
    for (const ttlMs of [60_001, 3_600_000, 999]) {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      expect(() => FencingAuthority.create({ runModeContext: LIVE_CONTEXT, accountRef: "acct-1", holderId: "a", store, clock, ttlMs, safetyMarginMs: 100, transmitMarginMs: 100 })).toThrow(FencingAuthorityConfigurationError);
      expect(store.calls).toEqual([]);
    }
    expect(FENCING_LEASE_MIN_TTL_MS).toBe(1_000);
  });

  it("a successor configured with a SHORTER ttl than its incumbent never holds while the incumbent does: A (ttl 60 s) is revoked right after renewing and does not renew again; B (ttl 1 s) asks at once and keeps asking; never both held", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    const common = { runModeContext: LIVE_CONTEXT, accountRef: "acct-1", store, clock };
    const a = FencingAuthority.create({ ...common, holderId: "trader-a", ttlMs: 60_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 });
    const b = FencingAuthority.create({ ...common, holderId: "trader-b", ttlMs: 1_000, safetyMarginMs: 100, transmitMarginMs: 100 });
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(5_000);
    expect(await a.renew()).toBe("RENEWED");
    expect(store.revoke(first.fence.fencingLeaseId, "operator: suspected second writer")).toBe(true);
    // A is partitioned from here (or simply between renewals): its local deadline (+5 s + 60 s − 2 s) stands.
    expect((await b.acquire()).kind).toBe("LAPSED_WAITING");
    const firstSight = clock.now;
    let bothHeld = 0;
    let acquiredAt: number | null = null;
    for (let step = 0; step < 400 && acquiredAt === null; step += 1) {
      await clock.advance(250);
      if ((await b.acquire()).kind === "ACQUIRED") acquiredAt = clock.now;
      if (a.check().held && b.check().held) bothHeld += 1;
    }
    // On 21aee56, B was granted 1.1 s after its first sight while A held for another ~57 s.
    expect(bothHeld).toBe(0);
    expect(acquiredAt).not.toBeNull();
    expect((acquiredAt ?? 0) - firstSight).toBeGreaterThanOrEqual(60_100);
    expect(a.check()).toMatchObject({ held: false, reason: "EXPIRED" });
  });

  it("the durable bound: a grant made OUTSIDE the TTL bound (a WP-040-style caller-supplied expiry 10 min ahead), revoked, is waited out to the expiry it wrote, however long the successor has waited locally", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    const foreign = store.insertForeignGrant({ accountRef: "acct-1", holderId: "legacy-writer", expiresInMs: 600_000 });
    expect(store.revoke(foreign, "operator revocation")).toBe(true);
    const b = FencingAuthority.create({ runModeContext: LIVE_CONTEXT, accountRef: "acct-1", holderId: "trader-b", store, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT });
    expect(await b.acquire()).toMatchObject({ kind: "LAPSED_WAITING", status: "REVOKED", remainingMs: 600_000 });
    await clock.advance(WAIT);
    // Waited out locally, presented, and still refused: the revoked grant's own expiry lies ahead.
    expect(await b.acquire()).toMatchObject({ kind: "LAPSED_WAITING", remainingMs: 600_000 - WAIT });
    expect(b.check().held).toBe(false);
    await clock.advance(600_000 - WAIT - 1);
    expect(await b.acquire()).toMatchObject({ kind: "LAPSED_WAITING", remainingMs: 1 });
    await clock.advance(1);
    expect((await b.acquire()).kind).toBe("ACQUIRED");
  });

  /**
   * r2 O1 (Opus R2-L1): the wait is timed from first sight AFTER the call that returned the version, never from the
   * instant before it. A slow call (a pool or row-lock wait) can START before the incumbent's last renewal and
   * return after a revocation; timed from its start, the successor would hand over early. The database clock steps
   * forward after the sighting, so the store's own expiry check (the durable bound) does not mask the anchor.
   */
  it("r2 O1: the wait is anchored at the END of the call that first returned the version: a call that started before the incumbent's last renewal never hands over early", async () => {
    const clock = new ManualClock();
    let skew = 0;
    const store = new MemoryFencingStore(() => clock.now + skew);
    let open: () => void = () => undefined;
    let gated = false;
    const slowForB: FencingLeasePort = {
      acquire: async (input) => {
        if (gated && input.holderId === "trader-b") {
          await new Promise<void>((resolve) => {
            open = resolve;
          });
          gated = false;
        }
        return store.acquire(input);
      },
      renew: async (ref, ttl) => store.renew(ref, ttl),
      release: async (ref, reason) => store.release(ref, reason),
      recordHeartbeatId: async (ref, id) => store.recordHeartbeatId(ref, id),
    };
    const common = { runModeContext: LIVE_CONTEXT, accountRef: "acct-1", store: slowForB, clock, ttlMs: 60_000 };
    const a = FencingAuthority.create({ ...common, holderId: "trader-a", safetyMarginMs: 2_000, transmitMarginMs: 3_000 });
    const b = FencingAuthority.create({ ...common, holderId: "trader-b", safetyMarginMs: 100, transmitMarginMs: 100 });
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    // B's call starts now and waits (a pool or lock wait) …
    gated = true;
    const slow = b.acquire();
    await clock.advance(8_000);
    // … while A renews (its deadline: +8 s + 60 s − 2 s) and is then revoked …
    expect(await a.renew()).toBe("RENEWED");
    await clock.advance(500);
    expect(store.revoke(first.fence.fencingLeaseId, "operator revocation")).toBe(true);
    await clock.advance(1_500);
    // … and B's read lands only now, 10 s after its call started.
    open();
    expect(await slow).toMatchObject({ kind: "LAPSED_WAITING", status: "REVOKED" });
    const firstSight = clock.now;
    // The database's clock steps 40 s ahead: by it, A's lease has long expired.
    skew = 40_000;
    let bothHeld = 0;
    let acquiredAt: number | null = null;
    for (let step = 0; step < 400 && acquiredAt === null; step += 1) {
      await clock.advance(250);
      if ((await b.acquire()).kind === "ACQUIRED") acquiredAt = clock.now;
      if (a.check().held && b.check().held) bothHeld += 1;
    }
    expect(bothHeld).toBe(0);
    expect((acquiredAt ?? 0) - firstSight).toBeGreaterThanOrEqual(b.takeoverWaitMs);
  });
});
