/**
 * Secrets and signatures are redacted (work-plan `WP-260` acceptance 2;
 * handoff §15; ADR-007 §11).
 *
 * PROPERTY-STYLE. A seeded generator builds hostile errors — every pinned SDK
 * error class plus plain, aggregate and non-Error throwables — whose message,
 * `cause` chain (up to four deep), own enumerable, non-enumerable,
 * symbol-keyed and accessor properties, fake L2 headers, request URL and
 * response body all carry freshly generated fake secrets and signatures. Each
 * one is thrown through EVERY mapping path: `mapVenueError` for every
 * operation, the placement and cancel outcome builders, every method of the
 * secure client (via a fake SDK that throws it), and client construction.
 * Every result is rendered through every serialiser a log or crash report
 * would use: `JSON.stringify`, `util.inspect` (hidden, getters, infinite
 * depth), `util.format` (`%s %o %O %j`), `String`, `.message`, `.stack`, the
 * `cause` chain, every own property name and symbol, `structuredClone`, and
 * this package's own `redactForLog`. No fake secret may appear in any of them.
 *
 * NON-VACUOUS, twice over: (1) for every generated case the RAW error, run
 * through the same detector, DOES show a secret (the detector can see); and
 * (2) a deliberately leaky mapper that forwards `message` and `cause` is
 * caught by the detector on every case.
 */

import { format, inspect } from "node:util";

import {
  CancelledSigningError,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
} from "@polymarket/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecureVenueError, type SecureOperation } from "./errors.js";
import { mapVenueError } from "./error-mapping.js";
import { cancelOutcomeFromError, placementOutcomeFromError } from "./outcomes.js";
import { REDACTED, isSensitiveKey, redactForLog } from "./redaction.js";
import { SignedOrderEnvelope } from "./signed-order.js";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  FAKE_SDK_CREDENTIALS,
  installNetworkTripwire,
  type FakeSdkScript,
  type NetworkTripwire,
} from "./testing/index.js";

const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
const CASES = 120;
const SEED = 0x260_2026;
/** L-R3-1: an explicit budget for the seeded property tests (≈0.2–2 s in isolation). */
const PROPERTY_TIMEOUT_MS = 60_000;

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Seeded generator (mulberry32): deterministic, so a failure reproduces.

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Generator {
  int(below: number): number;
  pick<T>(items: readonly T[]): T;
  chars(alphabet: string, length: number): string;
}

function generator(seed: number): Generator {
  const next = prng(seed);
  return {
    int: (below) => Math.floor(next() * below),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    chars: (alphabet, length) => Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""),
  };
}

const HEX = "0123456789abcdef";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface Secrets {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
  readonly signature: string;
  readonly privateKey: string;
  /** Lower-case snake-compatible: would pass a naive "looks like a code" filter. */
  readonly codeShaped: string;
  readonly all: readonly string[];
}

function makeSecrets(g: Generator): Secrets {
  const apiKey = `${g.chars(HEX, 8)}-${g.chars(HEX, 4)}-${g.chars(HEX, 4)}-${g.chars(HEX, 4)}-${g.chars(HEX, 12)}`;
  const secret = `${g.chars(B64, 40)}==`;
  const passphrase = g.chars(HEX, 64);
  const signature = `0x${g.chars(HEX, 130)}`;
  const privateKey = `0x${g.chars(HEX, 64)}`;
  const codeShaped = `k${g.chars(HEX, 39)}`;
  return { apiKey, secret, passphrase, signature, privateKey, codeShaped, all: [apiKey, secret, passphrase, signature, privateKey, codeShaped] };
}

/** Every secret, and a 16-character prefix of each (a truncated leak is still a leak). */
function needles(secrets: Secrets): string[] {
  return secrets.all.flatMap((secret) => [secret, secret.slice(0, 16)]);
}

function leaks(text: string, secrets: Secrets): string[] {
  return needles(secrets).filter((needle) => text.includes(needle));
}

function hostileHeaders(s: Secrets): Record<string, string> {
  return {
    POLY_ADDRESS: "0x7e57000000000000000000000000000000000260",
    POLY_SIGNATURE: s.signature,
    POLY_TIMESTAMP: "1767225600",
    POLY_API_KEY: s.apiKey,
    POLY_PASSPHRASE: s.passphrase,
  };
}

function hostileCause(g: Generator, s: Secrets, depth: number): unknown {
  const shapes = [
    () => new Error(`inner failure secret=${s.secret}`),
    () => ({ request: { url: `https://clob.polymarket.com/order?key=${s.apiKey}`, headers: hostileHeaders(s) } }),
    () => ({ response: { body: JSON.stringify({ error: `bad ${s.passphrase}` }) }, config: { credentials: { secret: s.secret } } }),
    () => new AggregateError([new Error(s.privateKey), { signature: s.signature }], `aggregate ${s.apiKey}`),
    () => s.signature,
  ];
  const cause = g.pick(shapes)();
  if (depth > 1 && typeof cause === "object" && cause !== null) {
    Object.defineProperty(cause, "cause", { value: hostileCause(g, s, depth - 1), enumerable: g.int(2) === 0 });
  }
  return cause;
}

function hostileError(g: Generator, s: Secrets): unknown {
  const message = `failed: key=${s.apiKey} secret=${s.secret} passphrase=${s.passphrase} sig=${s.signature} (https://clob.polymarket.com/order?pk=${s.privateKey})`;
  const cause = hostileCause(g, s, 1 + g.int(4));
  const status = g.pick([400, 401, 403, 425, 429, 500, 503]);
  const code = g.pick([undefined, "post_only_mode", s.codeShaped, "cancel_only", s.secret]);
  const factories: (() => unknown)[] = [
    () => new RequestRejectedError(message, { cause, status, ...(code === undefined ? {} : { code }), retryAfter: g.int(100) }),
    () => new RateLimitError(message, { cause, retryAfter: g.int(100) }),
    () => new TransportError(message, { cause }),
    () => new TimeoutError(message, { cause }),
    () => new UnexpectedResponseError(message, { cause }),
    () => new UserInputError(message, { cause }),
    () => new SigningError(message, { cause }),
    () => new CancelledSigningError(message, { cause }),
    () => new Error(message, { cause }),
    () => new AggregateError([new Error(message)], message, { cause }),
    () => ({ message, cause, headers: hostileHeaders(s) }),
    () => message,
  ];
  const error = g.pick(factories)();
  if (typeof error === "object" && error !== null) {
    Object.assign(error, { headers: hostileHeaders(s), credentials: { key: s.apiKey, secret: s.secret, passphrase: s.passphrase } });
    Object.defineProperty(error, "hiddenSignature", { value: s.signature, enumerable: false });
    Object.defineProperty(error, Symbol("privateKey"), { value: s.privateKey, enumerable: g.int(2) === 0 });
    Object.defineProperty(error, "lazySecret", { get: () => s.secret, enumerable: true });
  }
  return error;
}

// ---------------------------------------------------------------------------
// Every serialiser a log line, crash report or telemetry export would use.

function causeChain(value: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = value;
  for (let i = 0; i < 16 && typeof current === "object" && current !== null; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "cause");
    if (descriptor === undefined) break;
    current = "value" in descriptor ? descriptor.value : "[accessor cause]";
    chain.push(current);
  }
  return chain;
}

function renderings(value: unknown): string[] {
  const out: string[] = [];
  const add = (render: () => string): void => {
    try {
      out.push(render());
    } catch (error) {
      out.push(`[render threw ${String((error as Error).name)}]`);
    }
  };
  add(() => JSON.stringify(value) ?? "undefined");
  add(() => inspect(value, { showHidden: true, depth: Infinity, getters: true }));
  add(() => inspect(value));
  add(() => format("%s %o %O %j", value, value, value, value));
  add(() => String(value));
  add(() => JSON.stringify(redactForLog(value)) ?? "undefined");
  if (typeof value === "object" && value !== null) {
    add(() => String((value as { message?: unknown }).message));
    add(() => String((value as { stack?: unknown }).stack));
    add(() => inspect(causeChain(value), { showHidden: true, depth: Infinity }));
    for (const key of Reflect.ownKeys(value)) {
      add(() => String(key));
      add(() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return inspect(descriptor, { showHidden: true, depth: Infinity, getters: true });
      });
    }
    add(() => inspect(structuredClone(value), { showHidden: true, depth: Infinity }));
  }
  return out;
}

function leaksIn(value: unknown, secrets: Secrets): string[] {
  return renderings(value).flatMap((text) => leaks(text, secrets));
}

const OPERATIONS: readonly SecureOperation[] = [
  "CREATE_CLIENT",
  "CREATE_LIMIT_ORDER",
  "POST_ORDER",
  "POST_ORDERS",
  "CANCEL_ORDER",
  "CANCEL_ORDERS",
  "CANCEL_MARKET_ORDERS",
  "CANCEL_ALL",
  "FETCH_ORDER",
  "CLOSE",
];

// ---------------------------------------------------------------------------

describe("property: no fake secret survives any mapping path or serialiser", () => {
  // L-R3-1: partitioned by operation (the same SEED regenerates the same
  // CASES hostile errors for each operation, so coverage is unchanged:
  // CASES × OPERATIONS × 4 results in total) and given an explicit budget,
  // so a loaded root run cannot time it out at the 5 s default.
  it.each(OPERATIONS)(`direct mapping paths, operation %s (${CASES} seeded cases)`, (operation) => {
    const g = generator(SEED);
    let checked = 0;
    for (let n = 0; n < CASES; n += 1) {
      const secrets = makeSecrets(g);
      const error = hostileError(g, secrets);
      // Positive control: the detector sees the raw error's secrets.
      expect(leaksIn(error, secrets).length).toBeGreaterThan(0);
      const mapped = mapVenueError(error, operation);
      expect(mapped).toBeInstanceOf(SecureVenueError);
      expect(mapped.cause).toBeUndefined();
      for (const result of [mapped, placementOutcomeFromError(mapped), cancelOutcomeFromError(mapped), mapped.toData()]) {
        expect(leaksIn(result, secrets)).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(CASES * 4);
  }, PROPERTY_TIMEOUT_MS);

  it(`every client method, and construction (${CASES} seeded cases)`, async () => {
    const g = generator(SEED ^ 0xffff);
    for (let n = 0; n < CASES; n += 1) {
      const secrets = makeSecrets(g);
      const error = hostileError(g, secrets);
      const thrower = (): never => {
        throw error;
      };
      const script: FakeSdkScript = {
        createLimitOrder: thrower,
        postOrder: thrower,
        postOrders: thrower,
        cancelOrder: thrower,
        cancelOrders: thrower,
        cancelMarketOrders: thrower,
        cancelAll: thrower,
        fetchOrder: thrower,
        closeSubscriptions: thrower,
      };
      const { handle } = createMockSignerHandle();
      const client = await createSecureVenueClientForTesting(
        { runModeContext: LIVE_SHAPED_CONTEXT, signer: handle },
        createFakeSdkFactory(script).factory,
      );
      // A real envelope to post, signed by the mock through the default fake SDK.
      const signer = await createSecureVenueClientForTesting(
        { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
        createFakeSdkFactory().factory,
      );
      const signed = await signer.createLimitOrder({ assetId: "1", side: "BUY", price: "0.52", size: "10" });
      if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");

      const results: unknown[] = [
        await client.createLimitOrder({ assetId: "1", side: "SELL", price: "0.5", size: "1" }),
        await client.postOrder(signed.order),
        await client.postOrders([signed.order, signed.order]),
        await client.cancelOrder("0xabc"),
        await client.cancelOrders(["0xabc", "0xdef"]),
        await client.cancelMarketOrders({ market: `0x${"1".repeat(64)}` }),
        await client.cancelAll(),
        await client.fetchOrder("0xabc"),
        await client.close(),
      ];
      try {
        await createSecureVenueClientForTesting(
          { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
          createFakeSdkFactory({ factoryThrows: error }).factory,
        );
        expect.unreachable("construction must fail");
      } catch (constructionError) {
        results.push(constructionError);
      }
      for (const result of results) expect(leaksIn(result, secrets)).toEqual([]);
      expect(leaksIn(client, secrets)).toEqual([]);
    }
  }, PROPERTY_TIMEOUT_MS);

  it("NON-VACUOUS: a leaky mapper that forwards message and cause is caught on every case", () => {
    const g = generator(SEED);
    const leakyMapper = (error: unknown): unknown => ({
      kind: "UNKNOWN",
      message: String((error as { message?: unknown } | undefined)?.message ?? error),
      cause: error,
    });
    for (let n = 0; n < CASES; n += 1) {
      const secrets = makeSecrets(g);
      const error = hostileError(g, secrets);
      expect(leaksIn(leakyMapper(error), secrets).length).toBeGreaterThan(0);
    }
  }, PROPERTY_TIMEOUT_MS);
});

describe("the secure client, envelopes and snapshots never render held secrets", () => {
  it("util.inspect / JSON of the client do not reveal the SDK client's L2 credentials", async () => {
    const client = await createSecureVenueClientForTesting(
      { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
      createFakeSdkFactory().factory,
    );
    for (const text of renderings(client)) {
      for (const value of Object.values(FAKE_SDK_CREDENTIALS)) expect(text).not.toContain(value);
    }
    expect(Reflect.ownKeys(client)).toEqual(["identity"]);
  });

  it("a signed envelope renders its identity, never its signature", async () => {
    const client = await createSecureVenueClientForTesting(
      { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
      createFakeSdkFactory().factory,
    );
    const signed = await client.createLimitOrder({ assetId: "12345", side: "BUY", price: "0.52", size: "10" });
    if (signed.kind !== "SIGNED") throw new Error("fixture signing failed");
    const signature = String(signed.order.revealPayloadForEncryptedPersistence()["signature"]);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/u);
    // The mock's `r` is 32 zero bytes (never a valid signature), so the
    // distinctive part of the signature is `s`: bytes 33…64.
    const distinctive = signature.slice(66, 98);
    expect(distinctive).not.toMatch(/^0+$/u);
    for (const text of renderings(signed)) expect(text).not.toContain(distinctive);
    for (const text of renderings(signed.order)) expect(text).not.toContain(distinctive);
    expect(Reflect.ownKeys(signed.order)).toEqual(["identity"]);
    // The persisted payload round-trips to an equal identity (ADR-007 §2 step 9).
    const again = SignedOrderEnvelope.fromPersistedPayload({ ...signed.order.revealPayloadForEncryptedPersistence() });
    expect(again?.identity).toEqual(signed.order.identity);
  });

  it("an order snapshot drops the order's owner (the owning API key)", async () => {
    const client = await createSecureVenueClientForTesting(
      { runModeContext: LIVE_SHAPED_CONTEXT, signer: createMockSignerHandle().handle },
      createFakeSdkFactory().factory,
    );
    const outcome = await client.fetchOrder("0xabc");
    expect(outcome.kind).toBe("FOUND");
    for (const text of renderings(outcome)) expect(text).not.toContain(FAKE_SDK_CREDENTIALS.key);
  });
});

describe("redactForLog", () => {
  it("redacts every sensitive key, at any depth, in objects, arrays and maps", () => {
    const input = {
      level: "info",
      tokenId: "123",
      assetId: "456",
      headers: new Map([
        ["POLY_API_KEY", "k1"],
        ["poly-passphrase", "p1"],
        ["content-type", "application/json"],
      ]),
      nested: [{ apiKey: "k2", privateKey: "pk", Signature: "s", signedOrder: { salt: "1" }, mnemonic: "m", seed: "x" }],
      authorization: "Bearer t",
      builderCode: "public",
      POLYMARKET_BUILDER_SECRET: "bs",
    };
    expect(redactForLog(input)).toEqual({
      level: "info",
      tokenId: "123",
      assetId: "456",
      headers: { POLY_API_KEY: REDACTED, "poly-passphrase": REDACTED, "content-type": "application/json" },
      nested: [{ apiKey: REDACTED, privateKey: REDACTED, Signature: REDACTED, signedOrder: REDACTED, mnemonic: REDACTED, seed: REDACTED }],
      authorization: REDACTED,
      builderCode: "public",
      POLYMARKET_BUILDER_SECRET: REDACTED,
    });
  });

  it("never invokes a getter, drops Error text, survives cycles and bounds depth", () => {
    let invoked = false;
    const cyclic: Record<string, unknown> = {
      error: new TransportError("secret text"),
    };
    Object.defineProperty(cyclic, "computed", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "x";
      },
    });
    cyclic["self"] = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i += 1) {
      const next: Record<string, unknown> = {};
      deep["next"] = next;
      deep = next;
    }
    const out = redactForLog({ cyclic, root, big: 10n ** 30n }) as Record<string, unknown>;
    expect(invoked).toBe(false);
    expect(JSON.stringify(out)).not.toContain("secret text");
    expect((out["cyclic"] as Record<string, unknown>)["error"]).toEqual({ name: "TransportError" });
    expect((out["cyclic"] as Record<string, unknown>)["computed"]).toBe("[accessor]");
    expect((out["cyclic"] as Record<string, unknown>)["self"]).toBe("[circular]");
    expect(JSON.stringify(out)).toContain("[depth]");
    expect(out["big"]).toBe("1000000000000000000000000000000");
  });

  it("isSensitiveKey: sensitive names are flagged; public identifiers are not", () => {
    for (const key of ["secret", "POLY_PASSPHRASE", "apiKey", "api_key", "x-api-key", "privateKey", "POLY_SIGNATURE", "credentials", "POLY_ADDRESS", "POLY_TIMESTAMP"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ["tokenId", "token_id", "assetId", "orderId", "price", "size", "status", "market"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});
