/**
 * Shared fixtures for the WP-300 inventory suites. Synthetic identifiers only;
 * no credential, key or real wallet address.
 */

import { AssetRegistry, InventoryBook } from "../../../packages/inventory/src/index.js";

export const ACCOUNT = "paper-account-1";
export const PUSD = "asset-pusd";
export const USDC_E = "asset-usdc-e";
export const CONDITION = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";
export const YES = "token-yes-1";
export const NO = "token-no-1";

/** Public, documented venue contract addresses (verified-2026-09-30 §W.8). */
export const CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_CTF_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

export function registry(options: { readonly withUsdcE?: boolean } = {}): AssetRegistry {
  const created = AssetRegistry.create(
    options.withUsdcE === false ? { pusdAssetId: PUSD } : { pusdAssetId: PUSD, usdcEAssetId: USDC_E },
  );
  if (!created.ok) throw new Error(created.refusal.message);
  const pair = created.value.registerOutcomePair({ conditionId: CONDITION, yesAssetId: YES, noAssetId: NO });
  if (!pair.ok) throw new Error(pair.refusal.message);
  return created.value;
}

/** A book seeded with the given actual balances for {@link ACCOUNT}. */
export function seededBook(
  balances: Readonly<Record<string, string>>,
  options: { readonly withUsdcE?: boolean } = {},
): InventoryBook {
  const book = new InventoryBook(registry(options));
  for (const [assetId, balance] of Object.entries(balances)) {
    const observed = book.observeActual({ accountRef: ACCOUNT, assetId, balance });
    if (!observed.ok) throw new Error(observed.refusal.message);
  }
  return book;
}

/** Deterministic PRNG (mulberry32) so property runs are reproducible from a seed. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

/** A small positive decimal with up to 2 fractional digits, as a canonical string. */
export function randomAmount(random: () => number, maxWhole: number): string {
  const cents = 1 + Math.floor(random() * maxWhole * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return String(whole);
  const fracText = String(frac).padStart(2, "0").replace(/0+$/, "");
  return `${whole}.${fracText}`;
}
