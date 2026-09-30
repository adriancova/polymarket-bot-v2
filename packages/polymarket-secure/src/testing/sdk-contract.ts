/**
 * TEST-ONLY hooks into the pinned SDK for the contract suite
 * (`test/contract/polymarket-secure/**`). They exist so that suite can drive
 * sanitized venue fixtures through the REAL `@polymarket/client@0.11.0` code
 * without importing the SDK itself: only this package may (work-plan `WP-260`
 * acceptance 1; `dependency-direction.md` F6).
 *
 * Neither hook performs I/O on its own:
 *
 * - {@link parseOrderResponseWithPinnedSdk} runs the SDK's own
 *   `OrderResponseSchema` (from `@polymarket/bindings/clob`, the SDK's pinned
 *   dependency `0.11.0`) over a raw venue body. The pinned SDK root does not
 *   re-export the schema at runtime (its `.d.ts` claims it does), so the
 *   module is located from the SDK's own resolution root.
 * - {@link provokeSdkHttpRejection} makes one unauthenticated public-client
 *   request (`fetchMidpoint`). The CALLER must have installed the network
 *   tripwire with a fixture responder; with no responder the request is
 *   refused and the SDK reports a transport failure.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createPublicClient, UnexpectedResponseError } from "@polymarket/client";

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
