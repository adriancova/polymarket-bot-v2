/**
 * THE COINBASE SUBSCRIBE/UNSUBSCRIBE FRAMES DO NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently):
 * `venue-facts.ts`'s `buildSubscribeFrame` / `buildUnsubscribeFrame` returned
 * `JSON.stringify(frame)` of a literal they build, and `JSON.stringify`
 * resolves `toJSON` through the prototype chain. Under an inherited
 * `Object.prototype.toJSON` every frame the connection manager sent on
 * connect and reconnect was the bare injected string; under `Array.prototype`
 * the `product_ids` array was — and the heartbeats frame, which carries no
 * array, SURVIVED, so the connection looked healthy (heartbeats acknowledged)
 * while `market_trades` and `ticker` were subscribed to nothing.
 *
 * Each `it` runs its scenario clean and under ALL SIX contexts and requires
 * the bytes the fake socket captured to be identical to the clean ones, the
 * decision (three frames written on open) unchanged, and the injected
 * `toJSON` invoked ZERO times — so it fails at the base commit and passes
 * once the builders encode from own data (`@polymarket-bot/risk/plain-json`).
 * Harness and protocol: `test/unit/ledger/inherited-tojson.ts`.
 */

import { describe, expect, it } from "vitest";

import { CoinbaseConnectionManager } from "../../../packages/coinbase-adapter/src/connection.js";
import { CoinbaseConfigurationError } from "../../../packages/coinbase-adapter/src/errors.js";
import {
  FakeCoinbaseSocketFactory,
  ManualMonotonicClock,
  ManualTimer,
  ManualWallClock,
} from "../../../packages/coinbase-adapter/src/testing/index.js";
import {
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  COINBASE_CHANNELS,
} from "../../../packages/coinbase-adapter/src/venue-facts.js";
import { renderDivergences, sweepInheritedToJson } from "../ledger/inherited-tojson.js";
import type { ToJsonScenario } from "../ledger/inherited-tojson.js";

const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;

/** Joins captured byte strings with a separator no JSON text contains unescaped. */
function joinBytes(sent: readonly string[]): string {
  return sent.join("");
}

/** Starts a manager against the fake socket factory, opens the socket, returns every frame sent. */
function framesOnOpen(): string {
  const factory = new FakeCoinbaseSocketFactory();
  const manager = new CoinbaseConnectionManager({
    feedId: "coinbase.reference",
    productIds: [...PRODUCTS],
    socketFactory: factory,
    timer: new ManualTimer(),
    wallClock: new ManualWallClock(),
    monotonicClock: new ManualMonotonicClock(),
    onOutput: () => undefined,
  });
  manager.start();
  factory.current.open();
  const sent = joinBytes(factory.current.sent);
  manager.stop();
  return sent;
}

describe("coinbase-adapter outbound frames under an inherited toJSON (SER-3)", () => {
  it("the builders return the clean-process bytes for every documented shape", () => {
    const scenarios: readonly ToJsonScenario[] = [
      { name: "subscribe/products", render: () => buildSubscribeFrame(COINBASE_CHANNELS.marketTrades, [...PRODUCTS]) },
      { name: "subscribe/heartbeats", render: () => buildSubscribeFrame(COINBASE_CHANNELS.heartbeats, []) },
      { name: "unsubscribe/products", render: () => buildUnsubscribeFrame(COINBASE_CHANNELS.ticker, ["BTC-USD"]) },
      { name: "unsubscribe/no-products", render: () => buildUnsubscribeFrame(COINBASE_CHANNELS.heartbeats, []) },
    ];
    const sweep = sweepInheritedToJson(scenarios);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    // Outside every window: the clean bytes ARE the documented literal forms.
    expect(sweep.clean.get("subscribe/products")).toBe(
      'ok:{"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD","ETH-USD"]}',
    );
    expect(sweep.clean.get("subscribe/heartbeats")).toBe('ok:{"type":"subscribe","channel":"heartbeats"}');
    expect(sweep.clean.get("unsubscribe/products")).toBe(
      'ok:{"type":"unsubscribe","channel":"ticker","product_ids":["BTC-USD"]}',
    );
    expect(sweep.clean.get("unsubscribe/no-products")).toBe('ok:{"type":"unsubscribe","channel":"heartbeats"}');
  });

  it("the manager writes the clean-process frames on open: heartbeats, then one per data channel", () => {
    const sweep = sweepInheritedToJson([{ name: "frames-on-open", render: framesOnOpen }]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("frames-on-open")).toBe(
      `ok:${joinBytes([
        '{"type":"subscribe","channel":"heartbeats"}',
        '{"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD","ETH-USD"]}',
        '{"type":"subscribe","channel":"ticker","product_ids":["BTC-USD","ETH-USD"]}',
      ])}`,
    );
  });
});

/**
 * THE ENCODER MAY NOT REFUSE WHERE BASE ENCODED — the `SER-2` review's HIGH,
 * audited for this package's two outbound sites.
 *
 * Producer traced rather than asserted: the only caller-supplied part of a
 * frame is `productIds`, held by `CoinbaseConnectionManager`'s options
 * (`src/connection.ts`, `#sendSubscriptions`) and supplied in the gateway from
 * the config door's `coinbase.productIds`
 * (`apps/data-gateway/src/config.ts:194`, `z.array(z.string().min(1)).min(1)`
 * over a materialized tree). A frame is therefore two levels deep with string
 * leaves for every input — depth is constant — and size is not a refusal cause
 * (`encodePlainJson` has no length bound, exactly as `JSON.stringify` has none).
 */
describe("the frame builders may not refuse where base encoded (SER-2 cross-round rule)", () => {
  it("a 10,000-product frame encodes byte-identically to the clean process", () => {
    const productIds = Array.from({ length: 10_000 }, (_, index) => `TOK${String(index)}-USD`);
    const frame = buildSubscribeFrame(COINBASE_CHANNELS.ticker, productIds);
    expect(frame).toBe(
      JSON.stringify({ type: "subscribe", channel: "ticker", product_ids: productIds }),
    );
    expect(frame.length).toBeGreaterThan(100_000);
  });
});

describe("a frame that is not plain JSON data is refused as COINBASE_CONFIGURATION, never built", () => {
  it("names the kind and the path of the offending value", () => {
    let caught: unknown;
    try {
      buildSubscribeFrame(COINBASE_CHANNELS.ticker, ["BTC-USD", 7n as unknown as string]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoinbaseConfigurationError);
    const error = caught as CoinbaseConfigurationError;
    expect(error.code).toBe("COINBASE_CONFIGURATION");
    expect(error.message).toBe("the subscribe frame is not plain JSON data and was not built");
    expect(error.details["kind"]).toBe("BIGINT");
    expect(error.details["path"]).toBe("value.product_ids[1]");

    expect(() => buildUnsubscribeFrame(COINBASE_CHANNELS.ticker, [(() => "x") as unknown as string])).toThrow(
      CoinbaseConfigurationError,
    );
  });
});
