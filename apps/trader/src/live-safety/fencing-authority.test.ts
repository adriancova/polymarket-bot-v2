/**
 * WP-320 deliverable 1, the process's half: the fencing authority's local
 * deadline, its latched loss, and its refusal of every simulated run mode
 * (work-plan acceptance: "Paper mode cannot acquire live fencing"; "Two live
 * writers cannot both hold authority"). The database half is
 * `test/integration/postgres/fencing-race.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { ManualClock, MemoryFencingStore } from "./fakes.test-support.js";
import { FencingAuthority, FencingAuthorityConfigurationError, LiveFencingRefusal, type FencingAuthorityOptions } from "./fencing-authority.js";

const TTL = 30_000;
const SAFETY = 2_000;
const TRANSMIT = 3_000;

function setup(overrides: Partial<FencingAuthorityOptions> = {}): { clock: ManualClock; store: MemoryFencingStore; authority: FencingAuthority } {
  const clock = new ManualClock();
  const store = new MemoryFencingStore(() => clock.now);
  const authority = FencingAuthority.create({
    runMode: "LIVE_MICRO",
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
          runMode: runMode as string,
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
    it(`builds in ${runMode}`, () => {
      expect(() => setup({ runMode })).not.toThrow();
    });
  }

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

  it("the local deadline never falls after the database's expiry", async () => {
    const { clock, store, authority } = setup();
    const acquired = await authority.acquire();
    if (acquired.kind !== "ACQUIRED") throw new Error("not acquired");
    for (let step = 0; step < 60; step += 1) {
      await clock.advance(500);
      if (authority.check().held) expect(store.attemptAccepted(acquired.fence)).toBe(true);
    }
  });

  it("a monotonic reading that goes backwards loses the grant (CLOCK_FAULT)", async () => {
    const { clock, authority } = setup();
    await authority.acquire();
    clock.injectReading(clock.now - 1_000);
    expect(authority.check()).toMatchObject({ held: false, reason: "CLOCK_FAULT" });
    expect(authority.check()).toMatchObject({ held: false, reason: "CLOCK_FAULT" });
  });

  it("re-acquiring after a loss takes a NEW grant with a higher token; the old one is released", async () => {
    const { clock, store, authority } = setup();
    const first = await authority.acquire();
    await clock.advance(TTL);
    const second = await authority.acquire();
    expect(first.kind === "ACQUIRED" && second.kind === "ACQUIRED" && BigInt(second.fence.fencingToken) > BigInt(first.fence.fencingToken)).toBe(true);
    expect(store.rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
  });
});

describe("work-plan acceptance: two live writers cannot both hold authority", () => {
  it("a second process is refused while the first's lease is unexpired, and takes over only after it expires (database clock)", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    const options = { runMode: "LIVE_MICRO", accountRef: "acct-1", store, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT };
    const a = FencingAuthority.create({ ...options, holderId: "trader-a" });
    const b = FencingAuthority.create({ ...options, holderId: "trader-b" });
    expect((await a.acquire()).kind).toBe("ACQUIRED");
    expect((await b.acquire()).kind).toBe("HELD_ELSEWHERE");
    for (let step = 0; step < 80; step += 1) {
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
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    const options = { runMode: "LIVE", accountRef: "acct-1", store, clock, ttlMs: TTL, safetyMarginMs: SAFETY, transmitMarginMs: TRANSMIT };
    const a = FencingAuthority.create({ ...options, holderId: "trader-a" });
    const b = FencingAuthority.create({ ...options, holderId: "trader-b" });
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error("not acquired");
    await clock.advance(TTL);
    expect((await b.acquire()).kind).toBe("ACQUIRED");
    expect(store.attemptAccepted(first.fence)).toBe(false);
    expect(store.attemptAccepted(b.currentFence())).toBe(true);
  });
});
