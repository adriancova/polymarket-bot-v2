/**
 * TEST-ONLY hooks into the pinned SDK for the contract suite
 * (`test/contract/polymarket-secure/**`). They exist so that suite can drive
 * sanitized venue fixtures through the REAL `@polymarket/client@0.12.0` code
 * without importing the SDK itself: only this package may (work-plan `WP-260`
 * acceptance 1; `dependency-direction.md` F6).
 *
 * No hook performs I/O on its own. Every hook that reaches the SDK's HTTP
 * layer needs the CALLER to have installed the network tripwire with a
 * fixture responder; with no responder each request is refused and the SDK
 * reports a transport failure.
 *
 * - {@link parseOrderResponseWithPinnedSdk} runs the SDK's own
 *   `OrderResponseSchema` (from `@polymarket/bindings/clob`, the SDK's pinned
 *   dependency `0.12.0`) over a raw venue body. The pinned SDK root does not
 *   re-export the schema at runtime (its `.d.ts` claims it does), so the
 *   module is located from the SDK's own resolution root.
 * - {@link provokeSdkHttpRejection} makes one unauthenticated public-client
 *   request (`fetchMidpoint`).
 * - V2-5: {@link createPinnedSdkFactoryForContract} is an `SdkClientFactory`
 *   over the REAL `createSecureClient`, through the production binding
 *   `makeRealSdkClientFactory`, with FAKE L2 credentials
 *   ({@link FAKE_SDK_CREDENTIALS}) added, so the SDK never asks for an L1
 *   signature. Used with `createSecureVenueClientForTesting`, the whole
 *   boundary (run-mode gate, handle checks, venue client) runs over the real
 *   SDK code. The only signer it can be given is the test mock (the test
 *   factory refuses anything else), and the mock refuses every venue domain:
 *   no order is ever signed. {@link contractVenueResponder} answers the
 *   requests that construction and order preparation make.
 * - V2-5: {@link readBalanceAllowanceWithPinnedSdk} runs the SDK's
 *   `fetchBalanceAllowance` action (not a port member; the port has no
 *   balance read) on such a client, for the `CONDITIONAL-V2` pin (F-53).
 * - V2-5: {@link pinnedSdkAssetTypes} and {@link pinnedSdkErrorClassNames}
 *   read the SDK root's exports.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  AssetType,
  createPublicClient,
  createSecureClient,
  UnexpectedResponseError,
  UserInputError,
  type ApiKeyCreds,
} from "@polymarket/client";
import * as pinnedSdk from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";

import { makeRealSdkClientFactory, type SdkClientFactory, type SdkClientFactoryArguments, type SdkSecureClientPort } from "../sdk-port.js";
import { unsealSigner } from "../signer.js";
import { FAKE_SDK_CREDENTIALS } from "./fake-sdk.js";
import { createMockSignerHandle, MOCK_SIGNER_ADDRESS } from "./mock-signer.js";
import type { FetchResponder } from "./network-tripwire.js";

interface ZodLikeSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}

let cachedSchema: ZodLikeSchema | undefined;

async function orderResponseSchema(): Promise<ZodLikeSchema> {
  if (cachedSchema !== undefined) return cachedSchema;
  const sdkEntry = createRequire(import.meta.url).resolve("@polymarket/client");
  const bindingsClob = createRequire(sdkEntry).resolve("@polymarket/bindings/clob");
  const module = (await import(pathToFileURL(bindingsClob).href)) as { OrderResponseSchema?: ZodLikeSchema };
  if (module.OrderResponseSchema === undefined || typeof module.OrderResponseSchema.safeParse !== "function") {
    throw new Error("the pinned SDK bindings no longer export OrderResponseSchema");
  }
  cachedSchema = module.OrderResponseSchema;
  return cachedSchema;
}

/** The pinned SDK's parse of a raw `POST /order` response body. */
export async function parseOrderResponseWithPinnedSdk(
  raw: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const result = (await orderResponseSchema()).safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

/**
 * What the pinned SDK's `postOrder` would resolve or throw for a raw venue
 * body: the parsed `OrderResponse`, or — when the body does not match the
 * SDK's schema — the SDK's own `UnexpectedResponseError` (the SDK maps a
 * response-schema failure to that class).
 */
export async function answerAsPinnedSdk(raw: unknown): Promise<unknown> {
  const parsed = await parseOrderResponseWithPinnedSdk(raw);
  if (parsed.ok) return parsed.value;
  throw new UnexpectedResponseError("the response did not match the pinned SDK's OrderResponseSchema");
}

/**
 * Make one public SDK request and return what it throws (or `undefined` if
 * it resolves). The SDK's `ServiceClient` builds its `RequestRejectedError`
 * / `RateLimitError` from the status, headers and body the responder serves.
 */
export async function provokeSdkHttpRejection(): Promise<unknown> {
  try {
    await createPublicClient().fetchMidpoint({ assetId: "1" });
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// V2-5: the real SDK client behind the network tripwire.

/** The venue's CLOB origin, the only host {@link contractVenueResponder} answers. */
export const CONTRACT_CLOB_ORIGIN = "https://clob.polymarket.com";

/**
 * An `SdkClientFactory` over the REAL pinned SDK, for the contract suite.
 *
 * It is the production binding (`makeRealSdkClientFactory`), whose
 * `createSecureClient` call is wrapped to add the FAKE credentials. With
 * credentials the SDK skips the L1 signature (`clients.ts`
 * `beginAuthentication`: it reads `GET /auth/api-keys` and keeps the client
 * when the key is listed). Nothing else is added or changed: the signer,
 * wallet and listener are the ones the binding passes. Pass `wallet` equal to
 * the mock signer's address (an EOA account): without it the SDK derives a
 * Deposit Wallet and reads the chain, which the tripwire refuses.
 */
export function createPinnedSdkFactoryForContract(): SdkClientFactory {
  return makeRealSdkClientFactory((options) =>
    createSecureClient({
      signer: options.signer,
      ...(options.wallet === undefined ? {} : { wallet: options.wallet }),
      ...(options.onRateLimitUpdate === undefined ? {} : { onRateLimitUpdate: options.onRateLimitUpdate }),
      credentials: { ...FAKE_SDK_CREDENTIALS } as unknown as ApiKeyCreds,
    }),
  );
}

/**
 * {@link createPinnedSdkFactoryForContract}, recording every STRING property
 * the venue client reads on the SDK client (the `place*` pin). The client is
 * wrapped in a proxy whose getters run on the real client, and a function it
 * hands out is bound to the real client, so the SDK's own `this.…` reads
 * inside a method (`closeSubscriptions` reads `this.webSockets`) are not
 * mistaken for the caller's. `then` (read by promise resolution when the
 * factory returns) is not recorded.
 */
export function createRecordingPinnedSdkFactoryForContract(): {
  readonly factory: SdkClientFactory;
  readonly accessed: () => readonly string[];
} {
  const accessed: string[] = [];
  const real = createPinnedSdkFactoryForContract();
  const factory: SdkClientFactory = async (args: SdkClientFactoryArguments) => {
    const port = await real(args);
    return new Proxy(port, {
      get(target, property) {
        if (typeof property === "string" && property !== "then") accessed.push(property);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as SdkSecureClientPort;
  };
  return { factory, accessed: () => Object.freeze([...accessed]) };
}

/** One request {@link contractVenueResponder} saw. */
export interface ContractRequest {
  readonly method: string;
  /** The path below {@link CONTRACT_CLOB_ORIGIN}, e.g. `/order`. */
  readonly path: string;
  /** The query string without `?`, `""` when there is none. */
  readonly query: string;
}

/** A market the responder serves: its condition id and its raw `GET /clob-markets/{condition}` body. */
export interface ContractMarket {
  readonly conditionId: string;
  /** The venue's compact market body (`t` holds the `{t, o}` token pairs). */
  readonly clobMarket: Readonly<Record<string, unknown>>;
}

export interface ContractVenue {
  readonly responder: FetchResponder;
  /** Every request seen, in order. */
  readonly requests: () => readonly ContractRequest[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A fixture responder for the real SDK client. It answers, on
 * {@link CONTRACT_CLOB_ORIGIN} only:
 *
 * - `GET /auth/api-keys` with the fake key (client construction);
 * - `GET /markets-by-token/{id}` with the condition of the market that lists
 *   `id`, and `GET /clob-markets/{condition}` with that market's body (order
 *   preparation, `actions/orders/cache.ts`);
 * - anything else through `other`, which may answer, return a promise, throw
 *   (a network failure) or return `undefined` (refused by the tripwire).
 */
export function contractVenueResponder(options: {
  readonly markets: readonly ContractMarket[];
  readonly other?: (request: ContractRequest) => Response | Promise<Response> | undefined;
}): ContractVenue {
  const seen: ContractRequest[] = [];
  const conditionOf = new Map<string, string>();
  const bodyOf = new Map<string, Readonly<Record<string, unknown>>>();
  for (const market of options.markets) {
    bodyOf.set(market.conditionId, market.clobMarket);
    const tokens = market.clobMarket["t"];
    for (const token of Array.isArray(tokens) ? tokens : []) {
      const id: unknown = (token as Record<string, unknown>)["t"];
      if (typeof id === "string") conditionOf.set(id, market.conditionId);
    }
  }
  const responder: FetchResponder = (url, _init, method) => {
    if (!url.startsWith(`${CONTRACT_CLOB_ORIGIN}/`)) return undefined;
    const parsed = new URL(url);
    const request: ContractRequest = Object.freeze({ method, path: parsed.pathname, query: parsed.search.replace(/^\?/u, "") });
    seen.push(request);
    if (method === "GET" && request.path === "/auth/api-keys") return jsonResponse({ apiKeys: [FAKE_SDK_CREDENTIALS.key] });
    const byToken = /^\/markets-by-token\/([0-9]+)$/u.exec(request.path);
    if (method === "GET" && byToken?.[1] !== undefined) {
      const condition = conditionOf.get(byToken[1]);
      return condition === undefined ? undefined : jsonResponse({ condition_id: condition });
    }
    const market = /^\/clob-markets\/(0x[0-9a-fA-F]+)$/u.exec(request.path);
    if (method === "GET" && market?.[1] !== undefined) {
      const body = bodyOf.get(market[1]);
      return body === undefined ? undefined : jsonResponse(body);
    }
    return options.other?.(request);
  };
  return { responder, requests: () => Object.freeze([...seen]) };
}

/** What the SDK's `fetchBalanceAllowance` did. */
export type BalanceAllowanceReading = "RESOLVED" | "REFUSED_BEFORE_SENDING" | "FAILED";

/**
 * Run the pinned SDK's `fetchBalanceAllowance` for `assetType` and `assetId`
 * on a real SDK client built by {@link createPinnedSdkFactoryForContract}
 * with a fresh mock signer (an EOA account; no signature is involved: the
 * read is L2-authenticated with the fake credentials). The wire request is
 * observed by the caller's responder. `REFUSED_BEFORE_SENDING` is the SDK's
 * own input validation refusing the request (`UserInputError`), as 0.11.0
 * does for `CONDITIONAL-V2`.
 */
export async function readBalanceAllowanceWithPinnedSdk(request: {
  readonly assetType: string;
  readonly assetId: string;
}): Promise<BalanceAllowanceReading> {
  const sealed = unsealSigner(createMockSignerHandle().handle);
  if (sealed === undefined) throw new Error("the mock signer handle did not unseal");
  const client = await createPinnedSdkFactoryForContract()({ signer: sealed.signer, wallet: MOCK_SIGNER_ADDRESS });
  try {
    await fetchBalanceAllowance(client as unknown as Parameters<typeof fetchBalanceAllowance>[0], {
      assetType: request.assetType as AssetType,
      assetId: request.assetId,
    });
    return "RESOLVED";
  } catch (error) {
    return error instanceof UserInputError ? "REFUSED_BEFORE_SENDING" : "FAILED";
  } finally {
    await client.closeSubscriptions();
  }
}

/** The pinned SDK root's `AssetType` values (`CONDITIONAL-V2` is new in 0.12.0, F-53). */
export function pinnedSdkAssetTypes(): readonly string[] {
  return Object.freeze(Object.values(AssetType).map(String));
}

/** The names of every `Error` subclass the pinned SDK root exports at runtime. */
export function pinnedSdkErrorClassNames(): readonly string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(pinnedSdk)) {
    if (typeof value === "function" && (value as { prototype?: unknown }).prototype instanceof Error) names.push(name);
  }
  return Object.freeze(names.sort());
}
