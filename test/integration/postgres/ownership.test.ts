/**
 * WP-040 acceptance 4: "One active live owner per market is constrained."
 *
 * §6 invariant 11 / ADR-011 §1: at most one strategy instance holds live
 * ownership of a market; others may observe or run in shadow.
 *
 * The realm split matters and is tested both ways: all three real-order modes
 * share one realm (so LIVE and LIVE_MICRO collide), while each simulated mode
 * has its own (so a PAPER or SHADOW owner never blocks the live one — §10.8).
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain } from "@polymarket-bot/storage-postgres/testing";
import { UniqueViolationError } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("ownership");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
let secondInstanceId: string;
let liveInstanceId: string;
let liveMicroInstanceId: string;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "ownership" });

  secondInstanceId = await context.repositories.strategy.createInstance({
    instanceName: "second-paper-instance",
    definitionId: chain.definitionId,
    configId: chain.configId,
    environment: "PAPER",
    seriesId: chain.seriesId,
    accountRef: "test-account",
    defaultOwnershipMode: "LIVE_OWNER",
  });

  liveInstanceId = await context.repositories.strategy.createInstance({
    instanceName: "live-instance",
    definitionId: chain.definitionId,
    configId: chain.configId,
    environment: "LIVE",
    seriesId: chain.seriesId,
    accountRef: "live-account",
    defaultOwnershipMode: "LIVE_OWNER",
  });

  liveMicroInstanceId = await context.repositories.strategy.createInstance({
    instanceName: "live-micro-instance",
    definitionId: chain.definitionId,
    configId: chain.configId,
    environment: "LIVE_MICRO",
    seriesId: chain.seriesId,
    accountRef: "live-account",
    defaultOwnershipMode: "LIVE_OWNER",
  });
});

describe("one active live owner per market", () => {
  it("lets the first instance claim live ownership", async () => {
    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: chain.instanceId,
      ownershipMode: "LIVE_OWNER",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);

    const owner = await context.repositories.ownership.findActiveLiveOwner(chain.marketId, "PAPER");
    expect(owner?.instance_id).toBe(chain.instanceId);
  });

  it("REJECTS a second active live owner of the same market", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ownership.acquireOwnership({
        marketId: chain.marketId,
        instanceId: secondInstanceId,
        ownershipMode: "LIVE_OWNER",
      }),
    );

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraintName).toBe(
      "market_ownership_one_active_live_owner",
    );
  });

  it("REJECTS the same instance claiming the market twice", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ownership.acquireOwnership({
        marketId: chain.marketId,
        instanceId: chain.instanceId,
        ownershipMode: "LIVE_OWNER",
      }),
    );
    expect(error).toBeInstanceOf(UniqueViolationError);
  });

  it("allows a SHADOW owner beside the live owner (§6 invariant 11)", async () => {
    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: secondInstanceId,
      ownershipMode: "SHADOW",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);
  });

  it("allows an OBSERVER beside the live owner", async () => {
    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: secondInstanceId,
      ownershipMode: "OBSERVER",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);
  });

  it("lets a live owner claim the market in a different simulated realm (§10.8)", async () => {
    const shadowInstance = await context.repositories.strategy.createInstance({
      instanceName: "shadow-realm-instance",
      definitionId: chain.definitionId,
      configId: chain.configId,
      environment: "SHADOW",
      seriesId: chain.seriesId,
      accountRef: "test-account",
      defaultOwnershipMode: "LIVE_OWNER",
    });

    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: shadowInstance,
      ownershipMode: "LIVE_OWNER",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);
  });

  it("treats LIVE and LIVE_MICRO as ONE realm, so they collide (ADR-011 §1)", async () => {
    await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: liveInstanceId,
      ownershipMode: "LIVE_OWNER",
    });

    const error = await captureRejection(async () =>
      context.repositories.ownership.acquireOwnership({
        marketId: chain.marketId,
        instanceId: liveMicroInstanceId,
        ownershipMode: "LIVE_OWNER",
      }),
    );

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraintName).toBe(
      "market_ownership_one_active_live_owner",
    );
  });

  it("frees the market once ownership is released", async () => {
    const owner = await context.repositories.ownership.findActiveLiveOwner(chain.marketId, "PAPER");
    expect(owner).toBeDefined();

    const released = await context.repositories.ownership.releaseOwnership(
      owner?.market_ownership_id ?? "",
      "test handover",
    );
    expect(released).toBe(true);

    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: chain.marketId,
      instanceId: secondInstanceId,
      ownershipMode: "LIVE_OWNER",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);

    const newOwner = await context.repositories.ownership.findActiveLiveOwner(
      chain.marketId,
      "PAPER",
    );
    expect(newOwner?.instance_id).toBe(secondInstanceId);
  });

  it("keeps the released ownership record, so the handover is auditable", async () => {
    const history = await context.db
      .selectFrom("strategy.market_ownership")
      .selectAll()
      .where("market_id", "=", chain.marketId)
      .where("status", "=", "RELEASED")
      .execute();

    expect(history).toHaveLength(1);
    expect(history[0]?.released_reason).toBe("test handover");
    expect(history[0]?.released_at).not.toBeNull();
  });

  it("refuses to re-scope an ownership record instead of releasing it", async () => {
    const owner = await context.repositories.ownership.findActiveLiveOwner(chain.marketId, "PAPER");
    const error = await captureRejection(async () =>
      context.pool.query(
        `update strategy.market_ownership set instance_id = $1 where market_ownership_id = $2`,
        [chain.instanceId, owner?.market_ownership_id],
      ),
    );
    expect((error as { code?: string }).code).toBe("PMB02");
  });
});
