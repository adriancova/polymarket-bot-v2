/**
 * THE FRAME BUILDERS ACCEPT A CALLER'S ARRAY SUBCLASS (`SER-3` review round 1,
 * the M2 sweep).
 *
 * THE CLASS OF DEFECT the reviewer found in `polymarket-public`'s RTDS frame
 * builder: an outbound container built with `Array.prototype.map` PRESERVES THE
 * SPECIES of the caller's array (ECMA-262 `ArraySpeciesCreate`), and since
 * `SER-3` these frames are serialized by the own-data encoder, which refuses a
 * container whose prototype is neither `Array.prototype` nor `null`
 * (`NON_PLAIN`). An `Array` SUBCLASS of ordinary product-id strings satisfies
 * `readonly string[]` with no cast, so such a builder would refuse a
 * subscription `JSON.stringify` sent — an acceptance regression on a public
 * API.
 *
 * `venue-facts.ts` rebuilds `product_ids` with an ARRAY-LITERAL SPREAD, which
 * is an ordinary array whatever the argument's species is, and the frame itself
 * is an object literal. So the sweep found nothing to fix here — and this file
 * is what keeps that true: it fails if either spelling is ever replaced by a
 * species-preserving `map`/`slice`/`filter` (checked by mutation, not merely
 * asserted; see the work-package handoff). The expectation is always BASE'S
 * BYTES: `JSON.stringify` of the documented literal, in this clean process.
 *
 * No inherited `toJSON` is installed here — that is `./inherited-tojson.test.ts`'s
 * subject. This file is about the container TYPE a caller supplies.
 */

import { describe, expect, it } from "vitest";

import { CoinbaseConnectionManager } from "../../../packages/coinbase-adapter/src/connection.js";
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

/** The reviewer's fixture shape, for the ids every builder here takes. */
class ProductIds extends Array<string> {}

describe("the coinbase frame builders do not carry a caller's array type into the bytes", () => {
  it("a subscribe frame built from an Array SUBCLASS is base's frame, byte for byte", () => {
    const productIds = new ProductIds("BTC-USD", "ETH-USD");
    // Non-vacuity: the fixture really is a foreign container.
    expect(Array.isArray(productIds)).toBe(true);
    expect(Object.getPrototypeOf(productIds)).not.toBe(Array.prototype);

    expect(buildSubscribeFrame(COINBASE_CHANNELS.marketTrades, productIds)).toBe(
      '{"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD","ETH-USD"]}',
    );
    expect(buildUnsubscribeFrame(COINBASE_CHANNELS.ticker, productIds)).toBe(
      '{"type":"unsubscribe","channel":"ticker","product_ids":["BTC-USD","ETH-USD"]}',
    );
    // And identical to the ordinary-array answer, which is base's bytes.
    expect(buildSubscribeFrame(COINBASE_CHANNELS.ticker, productIds)).toBe(
      buildSubscribeFrame(COINBASE_CHANNELS.ticker, ["BTC-USD", "ETH-USD"]),
    );
  });

  it("an empty subclass takes the no-products branch, exactly as an empty array does", () => {
    expect(buildSubscribeFrame(COINBASE_CHANNELS.heartbeats, new ProductIds())).toBe(
      '{"type":"subscribe","channel":"heartbeats"}',
    );
  });

  it("the connection manager subscribes normally when its options carry a subclass", () => {
    // `CoinbaseConnectionOptions.productIds` is `readonly string[]`: the
    // subclass is accepted with no cast, and the manager hands it straight to
    // the builder (`connection.ts:455`).
    const factory = new FakeCoinbaseSocketFactory();
    const manager = new CoinbaseConnectionManager({
      feedId: "coinbase.reference",
      productIds: new ProductIds("BTC-USD"),
      socketFactory: factory,
      timer: new ManualTimer(),
      wallClock: new ManualWallClock(),
      monotonicClock: new ManualMonotonicClock(),
      onOutput: () => undefined,
    });
    manager.start();
    factory.current.open();
    const sent = [...factory.current.sent];
    manager.stop();
    expect(sent).toEqual([
      '{"type":"subscribe","channel":"heartbeats"}',
      '{"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD"]}',
      '{"type":"subscribe","channel":"ticker","product_ids":["BTC-USD"]}',
    ]);
  });
});
