/**
 * The asset registry: which asset id is pUSD, which is USDC.e, and which ids
 * are the YES/NO outcome tokens of which condition.
 *
 * ADR-006 §7 rules 1-2 (C-2): there is no implicit "cash" asset, and USDC and
 * pUSD are never interchangeable. The registry therefore requires the pUSD id
 * and the USDC.e id (when one is registered) to DIFFER, and every inventory
 * operation names its asset id explicitly. Trading collateral is pUSD ("the
 * collateral token used for all trading on Polymarket", S-D35, verified-
 * 2026-09-16 D-15); USDC.e is only the onramp's wrap input ("`_asset` Must be
 * USDC.e", same source). The venue's three names ("USDC", "USDC (native)",
 * "USDC.e") are NOT folded: native USDC has no role here.
 *
 * Asset kinds use the ledger's vocabulary (`COLLATERAL`, `OUTCOME_TOKEN`;
 * `packages/ledger/src/vocabulary.ts`, WP-040 `internal.asset_kind`), re-spelled
 * rather than imported because a same-layer edge to `packages/ledger` is not in
 * `docs/contracts/dependency-direction.md` §2.1.
 */

import { compositeKey } from "./guards.js";
import { ok, refuse, type InventoryResult } from "./refusals.js";

export type AssetRole = "PUSD" | "USDC_E" | "OUTCOME_TOKEN";
export type AssetKind = "COLLATERAL" | "OUTCOME_TOKEN";
export type OutcomeTokenSide = "YES" | "NO";

export interface AssetRegistration {
  readonly assetId: string;
  readonly role: AssetRole;
  readonly assetKind: AssetKind;
  /** Outcome tokens only. */
  readonly conditionId: string | null;
  readonly side: OutcomeTokenSide | null;
}

export interface OutcomePair {
  readonly conditionId: string;
  readonly yesAssetId: string;
  readonly noAssetId: string;
}

export class AssetRegistry {
  readonly #byId = new Map<string, AssetRegistration>();
  readonly #pairs = new Map<string, OutcomePair>();
  readonly #pusdAssetId: string;
  readonly #usdcEAssetId: string | null;

  private constructor(pusdAssetId: string, usdcEAssetId: string | null) {
    this.#pusdAssetId = pusdAssetId;
    this.#usdcEAssetId = usdcEAssetId;
    this.#byId.set(
      pusdAssetId,
      Object.freeze({ assetId: pusdAssetId, role: "PUSD", assetKind: "COLLATERAL", conditionId: null, side: null }),
    );
    if (usdcEAssetId !== null) {
      this.#byId.set(
        usdcEAssetId,
        Object.freeze({ assetId: usdcEAssetId, role: "USDC_E", assetKind: "COLLATERAL", conditionId: null, side: null }),
      );
    }
  }

  /**
   * A registry with the pUSD asset id and, optionally, the USDC.e asset id.
   * The two must differ (ADR-006 §7 rule 2).
   */
  static create(input: { readonly pusdAssetId: string; readonly usdcEAssetId?: string }): InventoryResult<AssetRegistry> {
    const pusd = typeof input.pusdAssetId === "string" && input.pusdAssetId.length > 0 ? input.pusdAssetId : undefined;
    if (pusd === undefined) return refuse("INVENTORY_INVALID_INPUT", "pusdAssetId must be a non-empty string");
    const usdcE = input.usdcEAssetId;
    if (usdcE !== undefined && (typeof usdcE !== "string" || usdcE.length === 0)) {
      return refuse("INVENTORY_INVALID_INPUT", "usdcEAssetId, when given, must be a non-empty string");
    }
    if (usdcE === pusd) {
      return refuse(
        "INVENTORY_ASSET_CONFLICT",
        "pUSD and USDC.e must be distinct asset ids (ADR-006 §7 rule 2: never interchangeable)",
        { assetId: pusd },
      );
    }
    return ok(new AssetRegistry(pusd, usdcE ?? null));
  }

  get pusdAssetId(): string {
    return this.#pusdAssetId;
  }

  get usdcEAssetId(): string | null {
    return this.#usdcEAssetId;
  }

  /**
   * Register a condition's YES and NO outcome tokens. Idempotent for an
   * identical pair; any conflicting reuse of an id or a condition is refused.
   */
  registerOutcomePair(pair: OutcomePair): InventoryResult<OutcomePair> {
    const { conditionId, yesAssetId, noAssetId } = pair;
    for (const [name, value] of [
      ["conditionId", conditionId],
      ["yesAssetId", yesAssetId],
      ["noAssetId", noAssetId],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        return refuse("INVENTORY_INVALID_INPUT", `${name} must be a non-empty string`);
      }
    }
    if (yesAssetId === noAssetId) {
      return refuse("INVENTORY_ASSET_CONFLICT", "YES and NO must be distinct asset ids", { assetId: yesAssetId });
    }
    const existing = this.#pairs.get(compositeKey(conditionId));
    if (existing !== undefined) {
      if (existing.yesAssetId === yesAssetId && existing.noAssetId === noAssetId) return ok(existing);
      return refuse("INVENTORY_ASSET_CONFLICT", "condition already registered with different outcome tokens", {
        conditionId,
      });
    }
    for (const id of [yesAssetId, noAssetId]) {
      if (this.#byId.has(id)) {
        return refuse("INVENTORY_ASSET_CONFLICT", "asset id is already registered in another role", { assetId: id });
      }
    }
    const frozen = Object.freeze({ conditionId, yesAssetId, noAssetId });
    this.#pairs.set(compositeKey(conditionId), frozen);
    this.#byId.set(
      yesAssetId,
      Object.freeze({ assetId: yesAssetId, role: "OUTCOME_TOKEN", assetKind: "OUTCOME_TOKEN", conditionId, side: "YES" }),
    );
    this.#byId.set(
      noAssetId,
      Object.freeze({ assetId: noAssetId, role: "OUTCOME_TOKEN", assetKind: "OUTCOME_TOKEN", conditionId, side: "NO" }),
    );
    return ok(frozen);
  }

  lookup(assetId: string): AssetRegistration | undefined {
    return this.#byId.get(assetId);
  }

  pairOf(conditionId: string): OutcomePair | undefined {
    return this.#pairs.get(compositeKey(conditionId));
  }
}
