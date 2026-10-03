/**
 * Shared fixtures for the WP-300 inventory suites. Synthetic identifiers only;
 * no credential, key or real wallet address.
 */

import * as inventory from "../../../packages/inventory/src/index.js";
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

/**
 * WP-300c r1 (WP300C-J1): a request-token source for the manager's
 * `requestToken` dependency. The tokens are `<prefix>1`, `<prefix>2`, … in draw
 * order, so a test that needs to can name the exact id a request WILL carry
 * (`peek`) — a reconciler that knows the source in advance, which the token
 * contract forbids (production binds a CSPRNG). Suites that never name an id
 * ahead of time use it as an arbitrary source.
 */
export class RequestTokens {
  #drawn = 0;
  constructor(readonly prefix = "k") {}
  /** The source itself (pass as `requestToken`). */
  readonly next = (): string => {
    this.#drawn += 1;
    return `${this.prefix}${String(this.#drawn)}`;
  };
  /** The token the `ahead`-th draw from now will return (1: the next one). */
  peek(ahead = 1): string {
    return `${this.prefix}${String(this.#drawn + ahead)}`;
  }
  /** How many tokens were drawn. */
  get drawn(): number {
    return this.#drawn;
  }
}

/** A fresh request-token source (see {@link RequestTokens}). */
export function requestTokens(prefix?: string): () => string {
  return new RequestTokens(prefix).next;
}

/** The package's collision-free key format (guards.ts `compositeKey`), restated for tests. */
export function compositeKeyOf(...parts: readonly string[]): string {
  return parts.map((part) => `${String(part.length)}:${part};`).join("");
}

/** The parts of a key built by {@link compositeKeyOf} (null if it is not one). */
export function keyParts(key: string): string[] | null {
  const parts: string[] = [];
  let at = 0;
  while (at < key.length) {
    const colon = key.indexOf(":", at);
    if (colon < 0) return null;
    const length = Number(key.slice(at, colon));
    if (!Number.isInteger(length) || length < 0) return null;
    const end = colon + 1 + length;
    if (key[end] !== ";") return null;
    parts.push(key.slice(colon + 1, end));
    at = end + 1;
  }
  return parts;
}

/**
 * Whether the package under test puts a token in its request ids (WP-300c r1,
 * WP300C-J1): it exports `MAX_REQUEST_TOKEN_LENGTH` exactly when it does. The
 * pins that name an id ahead of time use it to name the id the package under
 * test WILL issue, so they run unchanged against an earlier tree (whose ids
 * carry no token) and show what that tree does.
 */
export const REQUEST_IDS_CARRY_TOKENS = typeof (inventory as Readonly<Record<string, unknown>>)["MAX_REQUEST_TOKEN_LENGTH"] === "number";

/**
 * The id the manager gives operation `operationId`'s `n`-th reconciliation
 * request when the draw for it returned `token` (the header's "REQUEST IDS"
 * format), restated so a test can name an id ahead of time. (Without tokens,
 * see {@link REQUEST_IDS_CARRY_TOKENS}, the id has no token part.)
 */
export function requestIdOf(operationId: string, n: number, token: string): string {
  return REQUEST_IDS_CARRY_TOKENS
    ? compositeKeyOf("wallet-op", operationId, "reconciliation", String(n), token)
    : compositeKeyOf("wallet-op", operationId, "reconciliation", String(n));
}

/** The ordinal `n` of a request id in the manager's format (null if it is not one). */
export function requestOrdinalOf(requestId: string): number | null {
  const parts = keyParts(requestId);
  if (parts === null || parts.length < 4 || parts[0] !== "wallet-op" || parts[2] !== "reconciliation") return null;
  const n = Number(parts[3]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * What a reconciler that knows the id FORMAT, but cannot know a token before
 * it is drawn, predicts for the request `ahead` after one it received: the same
 * id with the ordinal advanced — every other part, any token included,
 * unchanged. With predictable ids (no token) this IS the next id.
 */
export function predictedRequestId(received: string, ahead = 1): string {
  const parts = keyParts(received);
  const n = requestOrdinalOf(received);
  if (parts === null || n === null) throw new Error(`not a request id: ${received}`);
  parts[3] = String(n + ahead);
  return compositeKeyOf(...parts);
}
