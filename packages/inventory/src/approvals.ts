/**
 * Allowances and trading approvals — handoff §9.14 "Track allowances and
 * trading approvals".
 *
 * The documented order (S-D48, verified-2026-09-30 §W.8/§W.9): approvals
 * first, then the CLOB allowance cache sync (`GET /balance-allowance/update`,
 * `asset_type=COLLATERAL`, or `asset_type=CONDITIONAL` with `token_id`), then
 * trading; and "Refresh the conditional-token allowance for each token before
 * its first sell order." So an approval CONFIRMED on chain is not readiness:
 * readiness needs a sync recorded AFTER the approval confirmed. Ordering is by
 * this tracker's own monotonic sequence; no clock is read.
 *
 * The sync itself is an L2-authenticated venue call, owned by the secure
 * adapter and out of reach in PAPER; this tracker only records that it
 * happened (as reported by its caller) and answers readiness questions.
 *
 * Which spenders an account must approve is NOT recorded in the verified
 * reports, so readiness takes the required spenders as caller input. The
 * tracker only accepts documented venue contracts as spenders
 * (`venue-facts.ts`).
 */

import { compositeKey } from "./guards.js";
import { ok, refuse, type InventoryResult } from "./refusals.js";
import { isDocumentedApprovalSpender } from "./venue-facts.js";

export type ApprovalStandard = "ERC20" | "ERC1155";

export interface ConfirmedApproval {
  readonly accountRef: string;
  readonly standard: ApprovalStandard;
  /** ERC20: the collateral asset id approved. ERC1155: `null` (operator approval over the account's outcome tokens). */
  readonly assetId: string | null;
  /** Lower-cased spender address. */
  readonly spender: string;
  readonly walletOperationId: string;
  readonly sequence: number;
}

export type ReadinessVerdict =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly missingApprovals: readonly string[];
      readonly clobSyncRequired: boolean;
    };

export class ApprovalTracker {
  readonly #approvals = new Map<string, ConfirmedApproval>();
  readonly #collateralSync = new Map<string, number>();
  readonly #conditionalSync = new Map<string, number>();
  #sequence = 0;

  /** Record an approval whose wallet operation reached CONFIRMED. */
  recordConfirmedApproval(input: {
    readonly accountRef: string;
    readonly standard: ApprovalStandard;
    readonly assetId: string | null;
    readonly spender: string;
    readonly walletOperationId: string;
  }): InventoryResult<ConfirmedApproval> {
    if (!isDocumentedApprovalSpender(input.spender)) {
      return refuse("WALLET_OP_SPENDER_NOT_DOCUMENTED", "approval spender is not a documented venue contract", {
        spender: input.spender,
      });
    }
    const spender = input.spender.toLowerCase();
    this.#sequence += 1;
    const approval = Object.freeze({
      accountRef: input.accountRef,
      standard: input.standard,
      assetId: input.standard === "ERC20" ? input.assetId : null,
      spender,
      walletOperationId: input.walletOperationId,
      sequence: this.#sequence,
    });
    this.#approvals.set(approvalKey(input.accountRef, input.standard, approval.assetId, spender), approval);
    return ok(approval);
  }

  /** Record a CLOB allowance-cache sync reported by the secure adapter. */
  recordClobAllowanceSync(
    input:
      | { readonly accountRef: string; readonly assetType: "COLLATERAL" }
      | { readonly accountRef: string; readonly assetType: "CONDITIONAL"; readonly tokenAssetId: string },
  ): void {
    this.#sequence += 1;
    if (input.assetType === "COLLATERAL") {
      this.#collateralSync.set(compositeKey(input.accountRef), this.#sequence);
    } else {
      this.#conditionalSync.set(compositeKey(input.accountRef, input.tokenAssetId), this.#sequence);
    }
  }

  /**
   * May this account BUY with `collateralAssetId`? Every required spender has
   * a confirmed ERC20 approval of that asset, and a COLLATERAL sync is recorded
   * after the latest of them.
   */
  collateralReadiness(
    accountRef: string,
    collateralAssetId: string,
    requiredSpenders: readonly string[],
  ): ReadinessVerdict {
    const sync = this.#collateralSync.get(compositeKey(accountRef));
    return this.#readiness(accountRef, "ERC20", collateralAssetId, requiredSpenders, sync);
  }

  /**
   * May this account SELL `tokenAssetId`? Every required spender has a
   * confirmed ERC1155 operator approval, and a CONDITIONAL sync for this token
   * is recorded after the latest of them.
   */
  conditionalSellReadiness(
    accountRef: string,
    tokenAssetId: string,
    requiredSpenders: readonly string[],
  ): ReadinessVerdict {
    const sync = this.#conditionalSync.get(compositeKey(accountRef, tokenAssetId));
    return this.#readiness(accountRef, "ERC1155", null, requiredSpenders, sync);
  }

  #readiness(
    accountRef: string,
    standard: ApprovalStandard,
    assetId: string | null,
    requiredSpenders: readonly string[],
    syncSequence: number | undefined,
  ): ReadinessVerdict {
    const missing: string[] = [];
    let latest = 0;
    for (const raw of requiredSpenders) {
      const spender = raw.toLowerCase();
      const approval = this.#approvals.get(approvalKey(accountRef, standard, assetId, spender));
      if (approval === undefined) missing.push(spender);
      else latest = Math.max(latest, approval.sequence);
    }
    // An empty requirement proves nothing: readiness needs at least one approval.
    if (requiredSpenders.length === 0) {
      return Object.freeze({ ready: false, missingApprovals: Object.freeze([]), clobSyncRequired: true });
    }
    const syncOk = syncSequence !== undefined && syncSequence > latest;
    if (missing.length === 0 && syncOk) return Object.freeze({ ready: true });
    return Object.freeze({
      ready: false,
      missingApprovals: Object.freeze(missing),
      clobSyncRequired: !syncOk,
    });
  }
}

function approvalKey(accountRef: string, standard: ApprovalStandard, assetId: string | null, spender: string): string {
  return compositeKey(accountRef, standard, assetId ?? "", spender);
}
