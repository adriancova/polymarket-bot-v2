/**
 * WP-280 acceptance (safety): redaction covers every user-stream payload
 * (handoff §15: API keys, passphrases, signatures and private material never
 * reach a log).
 *
 * PROPERTY-STYLE. A seeded generator builds raw user-channel frames — order
 * events, trade events with maker legs, malformed events, unknown event
 * types, batches and non-JSON text — and plants freshly generated fake
 * secrets in every place one could hide: `owner`, `trade_owner`,
 * `order_owner`, each maker leg's `owner` (CLOB API keys), an `auth` object
 * (`apiKey`, `secret`, `passphrase`), unknown credential-named keys, nested
 * unknown objects, an enumerated field (as a non-token value) and free text.
 * Each frame is delivered through the manager, and every output is rendered
 * through every serialiser a log would use (`JSON.stringify`, `util.inspect`
 * with hidden properties at infinite depth, `util.format`, `String`). No fake
 * secret may appear. The same frames through {@link redactUserStreamPayload}
 * show none either, while keeping the public fields.
 *
 * NON-VACUOUS: (1) every raw frame DOES show its secrets to the detector;
 * (2) a deliberately leaky output (the raw frame attached) is caught on every
 * case; (3) WP-260's `redactForLog` alone does NOT hide `owner` — the reason
 * this module adds its own rule.
 */

import { format, inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACTED, redactForLog } from "../redaction.js";
import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import { isUserStreamSensitiveKey, redactUserStreamPayload } from "./redaction.js";
import { FIXTURE_MARKET, openUserStream } from "./testing/harness.js";

const CASES = 200;
const SEED = 0x280_2026;

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Case {
  readonly frame: string;
  /** Every planted secret: none may reach a manager output. */
  readonly secrets: readonly string[];
  /** Those under a credential-bearing KEY: none may survive `redactUserStreamPayload` either. */
  readonly credentials: readonly string[];
}

function generate(random: () => number, index: number): Case {
  const secrets: string[] = [];
  const credentials: string[] = [];
  /** A secret in a VALUE position (free text, an enumerated field): only structural redaction can hide it. */
  const secret = (label: string): string => {
    const hex = Array.from({ length: 24 }, () => Math.floor(random() * 16).toString(16)).join("");
    const value = `fake-${label}-${hex}-${String(index)}`;
    secrets.push(value);
    return value;
  };
  /** A secret under a credential-bearing key. */
  const credential = (label: string): string => {
    const value = secret(label);
    credentials.push(value);
    return value;
  };
  const uuidish = (): string => {
    const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join("");
    const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    secrets.push(value);
    credentials.push(value);
    return value;
  };
  /** A random free-text API-key-shaped value (not under a credential key). */
  const textUuid = (): string => {
    const value = uuidish();
    credentials.pop();
    return value;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const extras = (): Record<string, unknown> => ({
    api_secret: credential("api-secret"),
    passphrase: credential("passphrase"),
    auth: { apiKey: uuidish(), secret: credential("secret"), passphrase: credential("auth-passphrase") },
    meta: { x_owner: uuidish(), signature: credential("signature"), note: { authorization: credential("bearer") } },
  });
  const order = (): Record<string, unknown> => ({
    event_type: "order",
    type: pick(["PLACEMENT", "UPDATE", "CANCELLATION"]),
    id: "0xfeed0001",
    owner: uuidish(),
    order_owner: uuidish(),
    market: FIXTURE_MARKET,
    asset_id: "1075058827",
    side: pick(["BUY", "SELL"]),
    original_size: "100",
    size_matched: "40",
    price: "0.08",
    status: random() < 0.25 ? secret("status") : pick(["LIVE", "MATCHED", "CANCELED"]),
    timestamp: "1782753357257",
    ...(random() < 0.7 ? extras() : {}),
  });
  const trade = (): Record<string, unknown> => ({
    event_type: "trade",
    type: "TRADE",
    id: "trade-1",
    taker_order_id: "0xfeed0004",
    market: FIXTURE_MARKET,
    asset_id: "1075058827",
    side: "BUY",
    size: "40",
    fee_rate_bps: "0",
    price: "0.08",
    status: pick(["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED", "MATCHED_NOT_BROADCASTED"]),
    match_time: "1782753360",
    owner: uuidish(),
    trade_owner: uuidish(),
    maker_orders: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      order_id: "0xfeed0005",
      owner: uuidish(),
      maker_address: "0x0000000000000000000000000000000000000000",
      matched_amount: "40",
      price: "0.08",
      asset_id: "1075058827",
      side: "SELL",
      ...(random() < 0.5 ? { session_key: credential("session-key") } : {}),
    })),
    trader_side: pick(["TAKER", "MAKER"]),
    timestamp: "1782753360000",
    ...(random() < 0.7 ? extras() : {}),
  });
  const shape = pick(["order", "trade", "malformed-order", "malformed-trade", "unknown", "batch", "text"] as const);
  let frame: string;
  switch (shape) {
    case "order":
      frame = JSON.stringify(order());
      break;
    case "trade":
      frame = JSON.stringify(trade());
      break;
    case "malformed-order":
      frame = JSON.stringify({ ...order(), price: secret("price") });
      break;
    case "malformed-trade":
      frame = JSON.stringify({ ...trade(), size: secret("size") });
      break;
    case "unknown":
      frame = JSON.stringify({ event_type: secret("event"), ...extras() });
      break;
    case "batch":
      frame = JSON.stringify([order(), trade(), { event_type: "book", ...extras() }]);
      break;
    case "text":
      frame = `error: invalid credentials for ${textUuid()} / ${secret("free-text")}`;
      break;
  }
  return { frame, secrets, credentials };
}

function renderings(value: unknown): string[] {
  return [
    JSON.stringify(value),
    inspect(value, { depth: Infinity, showHidden: true, getters: true }),
    format("%s %o %O %j", value, value, value, value),
    String(value),
  ];
}

function leaks(value: unknown, secrets: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of renderings(value)) for (const secret of secrets) if (text.includes(secret)) found.add(secret);
  return [...found];
}

describe("every user-stream payload is redacted", () => {
  it(
    "no output of the manager carries any planted secret, for every generated frame",
    () => {
      const random = mulberry32(SEED);
      const h = openUserStream();
      h.subscribe();
      let checked = 0;
      for (let index = 0; index < CASES; index += 1) {
        const generated = generate(random, index);
        // Control 1: the detector sees every secret in the raw frame.
        expect(generated.secrets.every((secret) => generated.frame.includes(secret))).toBe(true);
        const before = h.outputs.length;
        h.port.latest.deliver(generated.frame);
        const produced = h.outputs.slice(before);
        expect(produced.length).toBeGreaterThan(0);
        for (const output of produced) {
          expect(leaks(output, generated.secrets)).toEqual([]);
          // Control 2: a leaky output (the raw frame attached) is caught.
          expect(leaks({ ...output, raw: generated.frame }, generated.secrets).length).toBeGreaterThan(0);
          checked += 1;
        }
        expect(leaks(h.manager.pendingReconciliationRequests(), generated.secrets)).toEqual([]);
        expect(leaks(h.manager.diagnostics(), generated.secrets)).toEqual([]);
      }
      expect(checked).toBeGreaterThan(CASES);
    },
    60_000,
  );

  it(
    "redactUserStreamPayload hides every planted secret in every parsed frame, and keeps the public fields",
    () => {
      const random = mulberry32(SEED);
      let parsedFrames = 0;
      for (let index = 0; index < CASES; index += 1) {
        const generated = generate(random, index);
        let parsed: unknown;
        try {
          parsed = JSON.parse(generated.frame);
        } catch {
          continue;
        }
        parsedFrames += 1;
        const redacted = redactUserStreamPayload(parsed);
        expect(generated.credentials.length).toBeGreaterThan(0);
        expect(leaks(redacted, generated.credentials)).toEqual([]);
        // The public fields survive: every generated JSON frame carries `event_type`, and most the condition id.
        expect(JSON.stringify(redacted)).toContain('"event_type":');
        if (generated.frame.includes(FIXTURE_MARKET)) expect(JSON.stringify(redacted)).toContain(FIXTURE_MARKET);
      }
      expect(parsedFrames).toBeGreaterThan(CASES / 2);
    },
    60_000,
  );

  it("the subscription frame's credentials are redacted; its markets are kept", () => {
    const frame = { auth: { apiKey: "fake-api-key-1", secret: "fake-secret-1", passphrase: "fake-passphrase-1" }, type: "user", markets: [FIXTURE_MARKET] };
    const redacted = redactUserStreamPayload(frame);
    expect(redacted).toEqual({ auth: REDACTED, type: "user", markets: [FIXTURE_MARKET] });
    expect(leaks(redacted, ["fake-api-key-1", "fake-secret-1", "fake-passphrase-1"])).toEqual([]);
  });

  it("owner keys are redacted in every spelling, at every depth, and a `__proto__` key stays plain data", () => {
    expect(["owner", "trade_owner", "order_owner", "tradeOwner", "Order-Owner", "auth"].every(isUserStreamSensitiveKey)).toBe(true);
    expect(["id", "market", "asset_id", "maker_address", "authority"].some(isUserStreamSensitiveKey)).toBe(false);
    const redacted = redactUserStreamPayload(JSON.parse('{"__proto__": {"owner": "fake-owner-x"}, "deep": [{"a": {"b": {"owner": "fake-owner-y"}}}]}'));
    expect(leaks(redacted, ["fake-owner-x", "fake-owner-y"])).toEqual([]);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });

  it("CONTROL 3: WP-260's redactForLog alone does not hide an owner (this module's rule is needed)", () => {
    expect(JSON.stringify(redactForLog({ owner: "fake-owner-z" }))).toContain("fake-owner-z");
    expect(JSON.stringify(redactUserStreamPayload({ owner: "fake-owner-z" }))).not.toContain("fake-owner-z");
  });

  it("never throws on hostile input", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => redactUserStreamPayload(proxy)).not.toThrow();
    const cyclic: Record<string, unknown> = { owner: "fake-owner-c" };
    cyclic["self"] = cyclic;
    expect(leaks(redactUserStreamPayload(cyclic), ["fake-owner-c"])).toEqual([]);
  });
});
