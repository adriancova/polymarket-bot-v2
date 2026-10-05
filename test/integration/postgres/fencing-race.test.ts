/**
 * WP-320: the fencing race, against a REAL PostgreSQL (Testcontainers; every
 * migration applied). Work-plan acceptance "Two live writers cannot both hold
 * authority" and "Paper mode cannot acquire live fencing"; handoff §9.18 and
 * §6 invariant 16; ADR-008 §1–§2.
 *
 * Exercised through `createFencingLeaseStore` (`packages/storage-postgres/src/fencing`):
 *
 * - many writers race for one account's fence, on separate connections: one
 *   wins, every other is HELD (or CONTENDED), and one ACTIVE lease exists;
 * - the database's own backstop when two writers bypass the advisory lock;
 * - a takeover only over an ENDED incumbent whose exact version the successor
 *   presents back (r1, I1), with a higher token; the stale holder can then
 *   never renew, record a heartbeat id, release, or submit (migration 0008's
 *   trigger refuses its attempt);
 * - r1 I1 end to end: the REAL `FencingAuthority` of two processes over this
 *   store, an operator's revocation, and both gates asked throughout: the
 *   successor is granted only a whole lease after its first sight;
 * - r1 I4: a renewal that waits on a lock-only holder (migration 0008's
 *   `FOR SHARE`) past the expiry finds the lease LOST, never revives it;
 * - r1 I12 (N6): a renewal or heartbeat-id write naming another holder;
 * - a release racing an acquisition never leaves two ACTIVE leases;
 * - an operator's revocation; a token that never regresses;
 * - expiry written by the database's clock, whatever the caller's clock says;
 * - a PAPER, BACKTEST or SHADOW acquisition, and (r1, I8) a real-order mode
 *   above the ceiling or without real orders allowed, refused before any SQL,
 *   and the database CHECK refusing a raw simulated-mode lease.
 *
 * Throwaway container credentials only (Testcontainers); no real credential.
 * The run-mode contexts here are live-SHAPED literals that reach only this
 * throwaway database.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain } from "@polymarket-bot/storage-postgres/testing";
import {
  ConstraintViolationError,
  createFencingLeaseStore,
  FencingReferenceInvalidError,
  FencingRunModeNotPermittedError,
  NonRealModeFencingLeaseError,
  uuidV7,
  type AcquireFencingLeaseInput,
  type FencingAcquireOutcome,
  type FencingGrant,
  type FencingIncumbent,
  type FencingLeaseStore,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { FencingAuthority } from "../../../apps/trader/src/live-safety/fencing-authority.js";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("fencing_race");

let context: TestContext;
let store: FencingLeaseStore;

beforeAll(() => {
  context = getContext();
  store = createFencingLeaseStore(context.db);
});

/** A request permitted by its (live-shaped) ceiling and real-order flag. */
function request(input: Omit<AcquireFencingLeaseInput, "maximumRunMode" | "allowRealOrders"> & { readonly maximumRunMode?: string; readonly allowRealOrders?: boolean }): AcquireFencingLeaseInput {
  return { maximumRunMode: "LIVE", allowRealOrders: true, ...input };
}

function acquire(input: Parameters<typeof request>[0]): Promise<FencingAcquireOutcome> {
  return store.acquire(request(input));
}

function grantOf(outcome: FencingAcquireOutcome): FencingGrant {
  if (outcome.kind !== "ACQUIRED") throw new Error(`expected ACQUIRED, got ${outcome.kind}`);
  return outcome.grant;
}

function lapsedOf(outcome: FencingAcquireOutcome): FencingIncumbent {
  if (outcome.kind !== "LAPSED") throw new Error(`expected LAPSED, got ${outcome.kind}`);
  return outcome.incumbent;
}

/** A takeover presenting the ended incumbent back (the store trusts the caller to have waited it out). */
async function takeOver(input: Parameters<typeof request>[0]): Promise<FencingGrant> {
  const incumbent = lapsedOf(await acquire(input));
  return grantOf(await acquire({ ...input, takeover: { fencingLeaseId: incumbent.fencingLeaseId, fencingToken: incumbent.fencingToken, version: incumbent.version } }));
}

function refOf(grant: FencingGrant): { fencingLeaseId: string; fencingToken: string; holderId: string } {
  return { fencingLeaseId: grant.fencingLeaseId, fencingToken: grant.fencingToken, holderId: grant.holderId };
}

async function activeCount(accountRef: string): Promise<number> {
  const result = await context.pool.query<{ count: string }>(`select count(*)::text as count from ops.fencing_leases where account_ref = $1 and status = 'ACTIVE'`, [accountRef]);
  return Number(result.rows[0]?.count ?? "0");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("two live writers cannot both hold authority (real PostgreSQL)", () => {
  it("twelve writers race for one account's fence on separate connections: exactly one acquires, one ACTIVE lease exists", async () => {
    const account = "race-account-1";
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        acquire({ accountRef: account, environment: index % 3 === 0 ? "LIVE" : index % 3 === 1 ? "LIVE_MICRO" : "EXECUTION_PROBE", holderId: `writer-${String(index)}`, ttlMs: 60_000 }),
      ),
    );
    const winners = outcomes.filter((outcome) => outcome.kind === "ACQUIRED");
    expect(winners).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.kind === "ACQUIRED" || outcome.kind === "HELD" || outcome.kind === "CONTENDED")).toBe(true);
    expect(grantOf(winners[0] as FencingAcquireOutcome).fencingToken).toBe("1");
    expect(await activeCount(account)).toBe(1);
    // Every loser that saw the incumbent names the winner.
    const winner = grantOf(winners[0] as FencingAcquireOutcome).holderId;
    for (const outcome of outcomes) if (outcome.kind === "HELD") expect(outcome.holderId).toBe(winner);
  });

  it("this store and WP-040's repository race too: they share the advisory lock, and one wins", async () => {
    const account = "race-account-2";
    const [mine, theirs] = await Promise.allSettled([
      acquire({ accountRef: account, environment: "LIVE", holderId: "store-writer", ttlMs: 60_000 }),
      context.repositories.fencing.acquireLease({ accountRef: account, environment: "LIVE", holderId: "repo-writer", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ]);
    const mineWon = mine.status === "fulfilled" && mine.value.kind === "ACQUIRED";
    const theirsWon = theirs.status === "fulfilled";
    expect(mineWon !== theirsWon).toBe(true);
    expect(await activeCount(account)).toBe(1);
  });

  it("two writers that bypass the advisory lock entirely still cannot both hold it: the database's constraints refuse the second", async () => {
    const account = "race-account-3";
    const first = await context.pool.connect();
    const second = await context.pool.connect();
    try {
      await first.query("begin");
      await second.query("begin");
      const insert = `insert into ops.fencing_leases (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
                      values ($1, $2, 'LIVE', 1, $3, clock_timestamp() + interval '1 minute')`;
      await first.query(insert, [uuidV7(), account, "raw-a"]);
      const blocked = second.query(insert, [uuidV7(), account, "raw-b"]).then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(200);
      await first.query("commit");
      const error = (await blocked) as { code?: string } | null;
      expect(error).not.toBeNull();
      expect(["PMB07", "23505"]).toContain(error?.code);
      await second.query("rollback");
    } finally {
      first.release();
      second.release();
    }
    expect(await activeCount(account)).toBe(1);
  });
});

describe("a takeover happens only over an ENDED incumbent whose exact version is presented back; the stale holder is fenced out", () => {
  it("A holds; B is refused; A expires; B is answered LAPSED, then takes over with a higher token presenting A's version; A can never renew, record, release or submit again", async () => {
    const account = "live-account-takeover";
    const chain = await createTradingChain(context, { label: "takeover", environment: "LIVE", accountRef: account });
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 1_500 }));
    expect(await store.recordHeartbeatId(refOf(a), "sanitized-heartbeat-id-0001")).toBe(true);
    const held = await acquire({ accountRef: account, environment: "LIVE_MICRO", holderId: "trader-b", ttlMs: 60_000 });
    expect(held).toMatchObject({ kind: "HELD", holderId: "trader-a", fencingToken: a.fencingToken });

    // A's attempt is accepted while its lease is valid (migration 0008).
    await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: chain.executionGroupId,
      planId: chain.planId,
      attemptOrdinal: 1,
      signedPayload: { price: "0.42", size: "1" },
      salt: "takeover-salt-1",
      fencing: { fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken },
    });

    await sleep(1_700);
    // Expired by the database's clock: LAPSED (status still ACTIVE), never granted without the version presented.
    const lapsed = lapsedOf(await acquire({ accountRef: account, environment: "LIVE_MICRO", holderId: "trader-b", ttlMs: 60_000 }));
    expect(lapsed).toMatchObject({ fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken, holderId: "trader-a", status: "ACTIVE" });
    const b = await takeOver({ accountRef: account, environment: "LIVE_MICRO", holderId: "trader-b", ttlMs: 60_000 });
    expect(BigInt(b.fencingToken)).toBeGreaterThan(BigInt(a.fencingToken));
    // ADR-008 §4: the new holder may resume the id chain the previous lease recorded.
    expect(b.inheritedHeartbeatId).toBe("sanitized-heartbeat-id-0001");
    const old = await context.pool.query<{ status: string; revoked_reason: string }>(`select status, revoked_reason from ops.fencing_leases where fencing_lease_id = $1`, [a.fencingLeaseId]);
    expect(old.rows[0]?.status).toBe("EXPIRED");
    expect(old.rows[0]?.revoked_reason).toMatch(/expired before a new acquisition/u);

    // The stale holder: every holder write matches no row.
    expect(await store.renew(refOf(a), 60_000)).toEqual({ kind: "LOST" });
    expect(await store.recordHeartbeatId(refOf(a), "sanitized-heartbeat-id-0002")).toBe(false);
    expect(await store.release(refOf(a), "late release")).toBe(false);
    expect(await store.isValid(refOf(a))).toBe(false);
    const refused = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: chain.executionGroupId,
        planId: chain.planId,
        attemptOrdinal: 2,
        signedPayload: { price: "0.42", size: "1" },
        salt: "takeover-salt-2",
        fencing: { fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken },
      }),
    );
    expect(refused).toBeInstanceOf(FencingReferenceInvalidError);
    expect((refused as FencingReferenceInvalidError).sqlState).toBe("PMB06");

    // B's attempt is accepted; B is the only valid holder.
    expect(await store.isValid(refOf(b))).toBe(true);
    expect((await store.current(account, "LIVE"))?.holderId).toBe("trader-b");
    expect(await activeCount(account)).toBe(1);
  });

  it("an expired-but-unlabelled lease can never be renewed, even by its own holder before anyone takes over", async () => {
    const account = "live-account-lapse";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 1_000 }));
    await sleep(1_200);
    expect(await store.renew(refOf(a), 60_000)).toEqual({ kind: "LOST" });
    expect(await store.isValid(refOf(a))).toBe(false);
  });

  it("an operator's revocation ends the lease at once, with its reason; the holder cannot renew; the next grant (over the presented REVOKED version) has a higher token", async () => {
    const account = "live-account-revoke";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 60_000 }));
    expect(await store.revoke({ fencingLeaseId: a.fencingLeaseId, reason: "operator: suspected second writer" })).toBe(true);
    expect(await store.revoke({ fencingLeaseId: a.fencingLeaseId, reason: "again" })).toBe(false);
    expect(await store.renew(refOf(a), 60_000)).toEqual({ kind: "LOST" });
    const row = await context.pool.query<{ status: string; revoked_reason: string }>(`select status, revoked_reason from ops.fencing_leases where fencing_lease_id = $1`, [a.fencingLeaseId]);
    expect(row.rows[0]).toEqual({ status: "REVOKED", revoked_reason: "operator: suspected second writer" });
    const again = await takeOver({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 60_000 });
    expect(BigInt(again.fencingToken)).toBe(BigInt(a.fencingToken) + 1n);
  });

  it("r1 I1: a REVOKED lease is never granted over at once: the answer is LAPSED; a stale or forged version is refused; only the exact version is granted", async () => {
    const account = "live-account-revoke-takeover";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 60_000 }));
    expect(await store.revoke({ fencingLeaseId: a.fencingLeaseId, reason: "operator revocation" })).toBe(true);
    // On the candidate this acquisition was granted at once (step 3 looked only at ACTIVE rows).
    const incumbent = lapsedOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000 }));
    expect(incumbent).toMatchObject({ fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken, holderId: "trader-a", status: "REVOKED" });
    for (const forged of [
      { fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken, version: `${incumbent.version}x` },
      { fencingLeaseId: a.fencingLeaseId, fencingToken: "999", version: incumbent.version },
      { fencingLeaseId: uuidV7(), fencingToken: a.fencingToken, version: incumbent.version },
    ]) {
      expect((await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000, takeover: forged })).kind).toBe("LAPSED");
    }
    expect(await activeCount(account)).toBe(0);
    const b = grantOf(
      await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000, takeover: { fencingLeaseId: incumbent.fencingLeaseId, fencingToken: incumbent.fencingToken, version: incumbent.version } }),
    );
    expect(BigInt(b.fencingToken)).toBe(BigInt(a.fencingToken) + 1n);
  });

  it("r1 I1: a version that changes while the successor waits (the housekeeping relabel of an expired lease) is not granted over: the wait restarts on the new version", async () => {
    const account = "live-account-relabel";
    grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 1_000 }));
    await sleep(1_200);
    const first = lapsedOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000 }));
    expect(first.status).toBe("ACTIVE");
    await context.pool.query(`select ops.expire_stale_fencing_leases($1)`, [account]);
    const stale = await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000, takeover: { fencingLeaseId: first.fencingLeaseId, fencingToken: first.fencingToken, version: first.version } });
    expect(stale.kind).toBe("LAPSED");
    expect(lapsedOf(stale)).toMatchObject({ fencingLeaseId: first.fencingLeaseId, status: "EXPIRED" });
    expect(lapsedOf(stale).version).not.toBe(first.version);
  });
});

describe("r1 I1 end to end: two REAL fencing authorities over this store, an operator's revocation, both gates asked throughout", () => {
  it("the successor asking at once is not granted; the revoked holder stops at its next renewal; the successor is granted only a whole lease after its first sight; never both held", async () => {
    const account = "live-account-authorities";
    const clock = { monotonicMs: (): number => performance.now() };
    const options = { runModeContext: { runMode: "LIVE", maximumRunMode: "LIVE", allowRealOrders: true }, accountRef: account, store, clock, ttlMs: 1_500, safetyMarginMs: 200, transmitMarginMs: 300 };
    const a = FencingAuthority.create({ ...options, holderId: "trader-a" });
    const b = FencingAuthority.create({ ...options, holderId: "trader-b" });
    const first = await a.acquire();
    if (first.kind !== "ACQUIRED") throw new Error(`A not acquired: ${first.kind}`);
    expect(await store.revoke({ fencingLeaseId: first.fence.fencingLeaseId, reason: "operator: suspected second writer" })).toBe(true);
    const asked = await b.acquire();
    const firstSight = clock.monotonicMs();
    expect(asked).toMatchObject({ kind: "LAPSED_WAITING", status: "REVOKED" });
    expect(a.check().held).toBe(true);
    expect(b.check().held).toBe(false);
    let bothHeld = 0;
    let grantedAt: number | null = null;
    for (let round = 0; round < 80 && grantedAt === null; round += 1) {
      await sleep(50);
      if (round % 4 === 0) await a.renew();
      if ((await b.acquire()).kind === "ACQUIRED") grantedAt = clock.monotonicMs();
      if (a.check().held && b.check().held) bothHeld += 1;
    }
    expect(bothHeld).toBe(0);
    expect(grantedAt).not.toBeNull();
    expect((grantedAt ?? 0) - firstSight).toBeGreaterThanOrEqual(b.takeoverWaitMs - 50);
    expect(a.lossReason()).toBe("RENEW_LOST");
    expect(await activeCount(account)).toBe(1);
  });
});

describe("r1 I4: a renewal that waits on a row lock never revives an expired lease", () => {
  for (const lock of ["FOR SHARE", "FOR UPDATE"] as const) {
    it(`a lock-only holder (${lock === "FOR SHARE" ? "FOR SHARE, as migration 0008's attempt-insert trigger takes" : lock}) outlives the lease: the waiting renewal finds it LOST`, async () => {
      const account = `live-account-lockwait-${lock === "FOR SHARE" ? "share" : "update"}`;
      const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 1_000 }));
      const locker = await context.pool.connect();
      try {
        await locker.query("begin");
        await locker.query(`select 1 from ops.fencing_leases where fencing_lease_id = $1 ${lock}`, [a.fencingLeaseId]);
        // Started while the lease is still valid; it waits on the row lock.
        const renewing = store.renew(refOf(a), 30_000);
        await sleep(1_400);
        expect(await store.isValid(refOf(a))).toBe(false);
        await locker.query("commit");
        // On the candidate: RENEWED, and the lease valid again.
        expect(await renewing).toEqual({ kind: "LOST" });
        expect(await store.isValid(refOf(a))).toBe(false);
      } finally {
        locker.release();
      }
    });
  }

  it("the same wait on a VALID lease still renews it (the lock serializes; it does not refuse)", async () => {
    const account = "live-account-lockwait-valid";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 30_000 }));
    const locker = await context.pool.connect();
    try {
      await locker.query("begin");
      await locker.query(`select 1 from ops.fencing_leases where fencing_lease_id = $1 for share`, [a.fencingLeaseId]);
      const renewing = store.renew(refOf(a), 30_000);
      await sleep(200);
      await locker.query("commit");
      expect((await renewing).kind).toBe("RENEWED");
    } finally {
      locker.release();
    }
  });

  it("a heartbeat-id write that waits past the expiry records nothing", async () => {
    const account = "live-account-lockwait-heartbeat";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 1_000 }));
    const locker = await context.pool.connect();
    try {
      await locker.query("begin");
      await locker.query(`select 1 from ops.fencing_leases where fencing_lease_id = $1 for share`, [a.fencingLeaseId]);
      const recording = store.recordHeartbeatId(refOf(a), "sanitized-heartbeat-id-late");
      await sleep(1_400);
      await locker.query("commit");
      expect(await recording).toBe(false);
      const row = await context.pool.query<{ heartbeat_id: string | null }>(`select heartbeat_id from ops.fencing_leases where fencing_lease_id = $1`, [a.fencingLeaseId]);
      expect(row.rows[0]?.heartbeat_id).toBeNull();
    } finally {
      locker.release();
    }
  });
});

describe("r1 I12 (N6): every holder write names the holder", () => {
  it("a renewal and a heartbeat-id write naming the right lease and token but ANOTHER holder match nothing; the lease is untouched", async () => {
    const account = "live-account-intruder";
    const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 30_000 }));
    const before = await context.pool.query<{ expires_at: string; heartbeat_id: string | null }>(`select expires_at::text, heartbeat_id from ops.fencing_leases where fencing_lease_id = $1`, [a.fencingLeaseId]);
    const intruder = { fencingLeaseId: a.fencingLeaseId, fencingToken: a.fencingToken, holderId: "trader-intruder" };
    expect(await store.renew(intruder, 60_000)).toEqual({ kind: "LOST" });
    expect(await store.recordHeartbeatId(intruder, "sanitized-heartbeat-id-intruder")).toBe(false);
    expect(await store.release(intruder, "not mine")).toBe(false);
    const after = await context.pool.query<{ expires_at: string; heartbeat_id: string | null }>(`select expires_at::text, heartbeat_id from ops.fencing_leases where fencing_lease_id = $1`, [a.fencingLeaseId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await store.isValid(refOf(a))).toBe(true);
  });
});

describe("a release racing an acquisition", () => {
  it("never leaves two ACTIVE leases, over many interleavings; the acquirer either waits (HELD) or follows the release with a higher token", async () => {
    for (let round = 0; round < 15; round += 1) {
      const account = `release-race-${String(round)}`;
      const a = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 60_000 }));
      const [released, acquired] = await Promise.all([
        store.release(refOf(a), "shutdown"),
        acquire({ accountRef: account, environment: "LIVE", holderId: "trader-b", ttlMs: 60_000 }),
      ]);
      expect(released).toBe(true);
      // Never granted over the releasing holder without its version presented back: HELD, or LAPSED (RELEASED).
      expect(["HELD", "LAPSED"]).toContain(acquired.kind);
      if (acquired.kind === "LAPSED") expect(acquired.incumbent.status).toBe("RELEASED");
      expect(await activeCount(account)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the token is monotonic, and expiry is the database's clock", () => {
  it("ten successive grants for one account carry strictly increasing tokens, across run modes of the real realm", async () => {
    const account = "monotonic-account";
    let previous = 0n;
    for (let index = 0; index < 10; index += 1) {
      const input = { accountRef: account, environment: index % 2 === 0 ? "LIVE" : "EXECUTION_PROBE", holderId: `trader-${String(index)}`, ttlMs: 60_000 };
      const grant = index === 0 ? grantOf(await acquire(input)) : await takeOver(input);
      expect(BigInt(grant.fencingToken)).toBe(previous + 1n);
      previous = BigInt(grant.fencingToken);
      expect(await store.release(refOf(grant), "rotation")).toBe(true);
    }
    const highWater = await context.pool.query<{ highest_token: string }>(`select highest_token::text from ops.fencing_token_high_water where account_ref = $1`, [account]);
    expect(highWater.rows[0]?.highest_token).toBe("10");
  });

  it("the expiry is acquisition + ttl by the database's clock, and a renewal moves it by the database's clock", async () => {
    const account = "clock-account";
    const grant = grantOf(await acquire({ accountRef: account, environment: "LIVE", holderId: "trader-a", ttlMs: 45_000 }));
    const lifetime = Date.parse(grant.expiresAt) - Date.parse(grant.acquiredAt);
    expect(lifetime).toBeGreaterThanOrEqual(45_000);
    expect(lifetime).toBeLessThan(46_000);
    const renewed = await store.renew(refOf(grant), 20_000);
    expect(renewed.kind).toBe("RENEWED");
    const now = await context.pool.query<{ now: string }>(`select clock_timestamp()::text as now`);
    const dbNow = Date.parse((now.rows[0]?.now ?? "").replace(" ", "T").replace(/\+00$/u, "Z"));
    const renewedExpiry = renewed.kind === "RENEWED" ? Date.parse(renewed.expiresAt) : 0;
    expect(renewedExpiry - dbNow).toBeLessThanOrEqual(20_000);
    expect(renewedExpiry - dbNow).toBeGreaterThan(18_000);
  });
});

describe("paper mode cannot acquire live fencing (real PostgreSQL)", () => {
  for (const environment of ["PAPER", "BACKTEST", "SHADOW"]) {
    it(`${environment}: the store refuses before any SQL, and no row is written`, async () => {
      const account = `paper-account-${environment}`;
      const error = await captureRejection(async () => acquire({ accountRef: account, environment, holderId: "paper-trader", ttlMs: 60_000 }));
      expect(error).toBeInstanceOf(NonRealModeFencingLeaseError);
      expect(await activeCount(account)).toBe(0);
    });

    it(`${environment}: the database CHECK refuses a raw lease in that mode`, async () => {
      const error = await captureRejection(async () =>
        context.pool.query(
          `insert into ops.fencing_leases (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
           values ($1, $2, $3::internal.run_mode, 1, 'paper-trader', clock_timestamp() + interval '1 minute')`,
          [uuidV7(), `paper-raw-${environment}`, environment],
        ),
      );
      expect((error as { code?: string; constraint?: string }).code).toBe("23514");
      expect((error as { constraint?: string }).constraint).toBe("fencing_leases_real_modes_only");
    });
  }

  it("a simulated mode never reaches the store even through the typed path's CHECK mapping", async () => {
    const error = await captureRejection(async () => acquire({ accountRef: "x", environment: "REPLAY", holderId: "p", ttlMs: 60_000 }));
    expect(error).toBeInstanceOf(NonRealModeFencingLeaseError);
    expect(error).not.toBeInstanceOf(ConstraintViolationError);
  });

  for (const [name, ceiling] of [
    ["the repository's defaults (MAX_RUN_MODE=PAPER, ALLOW_REAL_ORDERS=false)", { maximumRunMode: "PAPER", allowRealOrders: false }],
    ["a LIVE request above a LIVE_MICRO ceiling", { maximumRunMode: "LIVE_MICRO", allowRealOrders: true }],
    ["real orders not allowed", { maximumRunMode: "LIVE", allowRealOrders: false }],
  ] as const) {
    it(`r1 I8: ${name} — a real-order mode is refused before any SQL, and no row is written`, async () => {
      const account = `ceiling-account-${name.length.toString()}`;
      const error = await captureRejection(async () => acquire({ accountRef: account, environment: "LIVE", holderId: "t", ttlMs: 60_000, ...ceiling }));
      expect(error).toBeInstanceOf(FencingRunModeNotPermittedError);
      const rows = await context.pool.query<{ count: string }>(`select count(*)::text as count from ops.fencing_leases where account_ref = $1`, [account]);
      expect(rows.rows[0]?.count).toBe("0");
    });
  }
});
