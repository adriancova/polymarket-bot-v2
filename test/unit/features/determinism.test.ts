/**
 * WP-160 acceptance 1: feature calculation is DETERMINISTIC.
 *
 * The oracles here use DIFFERENT PRIMITIVES than the implementation:
 *
 * - feature values are recomputed with exact BigInt rational arithmetic and
 *   an independent HALF_EVEN long-division renderer (`fixtures.ts`), sharing
 *   no code with `decimal.js`;
 * - the content address is recomputed with a pure-JS FIPS 180-4 SHA-256,
 *   sharing no code with `node:crypto`;
 * - the canonical serialization is cross-checked by an independent
 *   re-canonicalization (JSON.parse, rebuild with sorted key insertion,
 *   plain JSON.stringify).
 *
 * Proving "the product equals itself twice" with the product's own
 * enumeration would prove nothing; each check below binds an output to an
 * independent derivation.
 */

import { describe, expect, it } from "vitest";

// Entry-module-only relative import (WP-150 replay-golden precedent): the
// root test tree declares no dependency on workspace packages.
import { computeFeatureSnapshot } from "../../../packages/features/src/index.js";
import type { FeatureSnapshot } from "../../../packages/features/src/index.js";
import { oracleDivide34, sha256HexOracle, validInput } from "./fixtures.js";

function computeOk(input: unknown): { snapshot: FeatureSnapshot; serialization: string } {
  const result = computeFeatureSnapshot(input);
  if (!result.ok) throw new Error(`expected success, got ${result.refusal.code}`);
  return { snapshot: result.snapshot, serialization: result.serialization };
}

function featureValue(snapshot: FeatureSnapshot, id: string): unknown {
  const entry = snapshot.features.find((feature) => feature.id === id);
  if (entry === undefined || entry.status !== "OK") throw new Error(`no OK entry for ${id}`);
  return entry.value;
}

/** Deep-rebuilds a parsed JSON value inserting object keys in sorted order. */
function rebuildSorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebuildSorted);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = rebuildSorted((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The same input VALUE assembled through different construction orders. */
function scrambledInput(): Record<string, unknown> {
  const straight = validInput();
  // Rebuild every record with reversed key insertion order; arrays keep
  // their element order (element order is meaning).
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        out[key] = reverseKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }
  return reverseKeys(straight) as Record<string, unknown>;
}

describe("acceptance 1: determinism", () => {
  it("is byte-identical across runs and across input construction orders", () => {
    const first = computeOk(validInput());
    const second = computeOk(validInput());
    const scrambled = computeOk(scrambledInput());
    expect(second.serialization).toBe(first.serialization);
    expect(scrambled.serialization).toBe(first.serialization);
    expect(second.snapshot.contentAddress).toBe(first.snapshot.contentAddress);
    expect(scrambled.snapshot.contentAddress).toBe(first.snapshot.contentAddress);
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("computes the VWAP and ratio features the BigInt rational oracle predicts", () => {
    const { snapshot } = computeOk(validInput());

    // Executable BUY 150: cost = 80×0.52 + 70×0.53 = 78.7; vwap = 78.7/150.
    const buy = featureValue(snapshot, "polymarket.executable_buy_price") as {
      requestedShares: string;
      volumeWeightedAveragePrice?: string;
    }[];
    expect(buy[1]?.volumeWeightedAveragePrice).toBe(oracleDivide34("78.7", "150"));
    // Executable SELL 150: cost = 100×0.48 + 50×0.47 = 71.5; vwap = 71.5/150.
    const sell = featureValue(snapshot, "polymarket.executable_sell_price") as {
      volumeWeightedAveragePrice?: string;
    }[];
    expect(sell[1]?.volumeWeightedAveragePrice).toBe(oracleDivide34("71.5", "150"));

    // Imbalance = 350 / (350 + 200).
    expect(featureValue(snapshot, "polymarket.order_book_imbalance")).toBe(oracleDivide34("350", "550"));

    // Microprice = (0.48×80 + 0.52×100) / (100 + 80) = 90.4 / 180.
    expect(featureValue(snapshot, "polymarket.microprice")).toBe(oracleDivide34("90.4", "180"));

    // Midpoint = (0.48 + 0.52) / 2 = 1/2, exactly.
    expect(featureValue(snapshot, "polymarket.midpoint")).toBe("0.5");

    // Binance 250ms return: (100750 - 100250) / 100250.
    expect(featureValue(snapshot, "reference.binance.return_250ms")).toBe(oracleDivide34("500", "100250"));
    // Binance 30s return: (100750 - 100500) / 100500.
    expect(featureValue(snapshot, "reference.binance.return_30s")).toBe(oracleDivide34("250", "100500"));
    // Coinbase 5s return: (100600 - 100100) / 100100.
    expect(featureValue(snapshot, "reference.coinbase.return_5s")).toBe(oracleDivide34("500", "100100"));
  });

  it("content-addresses to the pure-JS SHA-256 oracle's digest", () => {
    const { snapshot, serialization } = computeOk(validInput());
    expect(snapshot.contentAddress).toBe(sha256HexOracle(`polymarket-bot/feature-snapshot/v1:${serialization}`));
    // The oracle itself is bound to the FIPS 180-4 test vector for "abc".
    expect(sha256HexOracle("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("serializes canonically: an independent re-canonicalization reproduces the bytes", () => {
    const { serialization } = computeOk(validInput());
    const reserialized = JSON.stringify(rebuildSorted(JSON.parse(serialization)));
    expect(reserialized).toBe(serialization);
  });

  it("kills value drift: any input value change changes the content address", () => {
    const base = computeOk(validInput());
    const edits: [string, (input: Record<string, unknown>) => void][] = [
      [
        "one trade size",
        (input) => {
          const trades = input["trades"] as { window: Record<string, unknown>[] };
          const trade = trades.window[1];
          if (trade !== undefined) trade["size"] = "11";
        },
      ],
      [
        "one book level (with consistent summaries)",
        (input) => {
          (input["book"] as Record<string, unknown>)["serializedBook"] = (
            (input["book"] as Record<string, unknown>)["serializedBook"] as string
          )
            .replace("0.47 50", "0.47 51")
            .replace("depth bids 3 350", "depth bids 3 351");
        },
      ],
      [
        "the book feed stamp by one millisecond",
        (input) => {
          (input["book"] as Record<string, unknown>)["lastEventAt"] = "2026-09-03T11:59:59.501Z";
        },
      ],
      [
        "the EWMA lambda",
        (input) => {
          (input["config"] as Record<string, unknown>)["ewmaLambda"] = "0.95";
        },
      ],
    ];
    for (const [name, edit] of edits) {
      const input = validInput();
      edit(input);
      const changed = computeOk(input);
      expect(changed.snapshot.contentAddress, name).not.toBe(base.snapshot.contentAddress);
    }
  });

  it("kills registry drift: every registered feature id appears in the addressed bytes", () => {
    const { snapshot, serialization } = computeOk(validInput());
    for (const entry of snapshot.features) {
      expect(serialization).toContain(`"id":"${entry.id}"`);
    }
  });
});
