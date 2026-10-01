/**
 * WP-300: approval tracking and the documented readiness order (S-D48,
 * verified-2026-09-30 §W.8/§W.9): approvals, then the CLOB allowance sync,
 * then trading; the conditional-token allowance is refreshed per token before
 * its first sell.
 */

import { describe, expect, it } from "vitest";

import { ApprovalTracker } from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NO, PUSD, YES } from "./helpers.js";

const approve = (tracker: ApprovalTracker, spender: string, standard: "ERC20" | "ERC1155" = "ERC20") =>
  tracker.recordConfirmedApproval({
    accountRef: ACCOUNT,
    standard,
    assetId: standard === "ERC20" ? PUSD : null,
    spender,
    walletOperationId: `op-${spender}-${standard}`,
  });

describe("approval readiness", () => {
  it("a sync recorded BEFORE the approval confirmed does not count", () => {
    const tracker = new ApprovalTracker();
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(approve(tracker, CTF_EXCHANGE).ok).toBe(true);
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE])).toMatchObject({ ready: false, clobSyncRequired: true });
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE])).toEqual({ ready: true });
  });

  it("every required spender must be approved; a later approval needs a later sync", () => {
    const tracker = new ApprovalTracker();
    approve(tracker, CTF_EXCHANGE);
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    const both = [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE];
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, both)).toMatchObject({
      ready: false,
      missingApprovals: [NEG_RISK_CTF_EXCHANGE.toLowerCase()],
    });
    approve(tracker, NEG_RISK_CTF_EXCHANGE);
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, both)).toMatchObject({ ready: false, clobSyncRequired: true });
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, both)).toEqual({ ready: true });
  });

  it("an empty requirement is never readiness", () => {
    const tracker = new ApprovalTracker();
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, []).ready).toBe(false);
  });

  it("conditional sells need an ERC1155 approval and a per-token sync", () => {
    const tracker = new ApprovalTracker();
    approve(tracker, CTF_EXCHANGE, "ERC1155");
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
    expect(tracker.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE])).toEqual({ ready: true });
    expect(tracker.conditionalSellReadiness(ACCOUNT, NO, [CTF_EXCHANGE])).toMatchObject({ ready: false, clobSyncRequired: true });
    // An ERC20 approval is not an ERC1155 operator approval.
    const other = new ApprovalTracker();
    approve(other, CTF_EXCHANGE, "ERC20");
    other.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
    expect(other.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready).toBe(false);
  });

  it("refuses an undocumented spender and matches documented ones case-insensitively", () => {
    const tracker = new ApprovalTracker();
    expect(approve(tracker, "0x1111111111111111111111111111111111111111").ok).toBe(false);
    expect(approve(tracker, CTF_EXCHANGE.toLowerCase()).ok).toBe(true);
    tracker.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(tracker.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE.toUpperCase().replace("0X", "0x")]).ready).toBe(true);
  });
});
