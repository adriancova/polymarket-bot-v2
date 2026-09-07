/**
 * REGRESSION: the gateway's startup checks are decided by the configuration the
 * operator actually WROTE (`docs/contracts/schema-boundary.md` §3, the
 * `apps/data-gateway` row — LIVE ×2; ADR-020 §1 classes 1 and 3).
 *
 * MEASURED AT BASE `5128d6c`:
 *
 * 1. A GET-ONLY inherited `tickIntervalMs` defeats the schema's `.default()`:
 *    the default never lands as an own property, `config.tickIntervalMs` reads
 *    the accessor instead, and the `dataLossBoundMs` startup check — the one
 *    that keeps the WAL's published data-loss bound from being a false claim —
 *    silently passes on a configuration that must fail.
 * 2. An inherited `binance` block satisfies "at least one feed must be
 *    configured", so a gateway configured to record NOTHING starts.
 *
 * DEPLOYMENT READING: nothing on the wire can write `Object.prototype`. Both
 * rows need code already executing in the process; they say the checks are not
 * load-bearing against an attacker already inside it, not that an operator file
 * can turn them off. They matter because this is an unattended startup path.
 */

import { describe, expect, it } from "vitest";

import { readOwnConfig } from "./config-door.js";
import {
  DEFAULTED_BLOCKS,
  DEFAULTED_KEYS,
  DEFAULTED_ROOT_KEYS,
  GatewayConfigSchema,
  parseGatewayConfig,
} from "./config.js";
import { GatewayConfigurationError } from "./errors.js";

const MARKET = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: `0x${"ab".repeat(31)}`,
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
};

const BINANCE_FEED = {
  feedId: "binance-reference",
  symbols: ["BTCUSDT"],
  stalenessThresholdMs: 30_000,
};

const BASE = {
  streamName: "market-events",
  wal: { rootPath: "/wal" },
  markets: [MARKET],
  binance: BINANCE_FEED,
};

/** A configuration whose tick MUST fail: the fsync interval is 100 ms. */
const FAST_FSYNC = {
  ...BASE,
  wal: { rootPath: "/wal", fsyncIntervalMs: 100 },
};

/** A configuration with no feed at all. */
const NO_FEED = {
  streamName: "market-events",
  wal: { rootPath: "/wal" },
  markets: [],
};

function withInherited<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

/**
 * Enough of `zod`'s node layout to walk a schema's declared shape.
 *
 * Read in a CLEAN process, in a test, purely to derive a census — this is not a
 * runtime dependency on library internals.
 */
interface SchemaNode {
  readonly _zod?: {
    readonly def?: {
      readonly type?: string;
      readonly innerType?: SchemaNode;
      readonly shape?: Readonly<Record<string, SchemaNode>>;
    };
  };
}

/** Every `<block>.<key>` (or bare `<key>` at the root) the schema defaults. */
function defaultedKeysOf(node: SchemaNode, prefix: string): ReadonlySet<string> {
  const found = new Set<string>();
  const def = node._zod?.def;
  if (def === undefined) return found;
  if (def.shape !== undefined) {
    for (const [key, child] of Object.entries(def.shape)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (child._zod?.def?.type === "default") found.add(path);
      for (const nested of defaultedKeysOf(child, path)) found.add(nested);
    }
  }
  if (def.innerType !== undefined) {
    for (const nested of defaultedKeysOf(def.innerType, prefix)) found.add(nested);
  }
  return found;
}

/**
 * The ENUMERABLE variant of the same class (review round 1, finding F1).
 *
 * A door that copied inherited enumerable keys after its own-key loop passed
 * every test this file carried. Callers warm the schema with an honest parse
 * FIRST: enumerable pollution during a schema's first parse permanently poisons
 * it (ADR-020 §1 class 7).
 */
function withInheritedEnumerable<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

/** The measured shape of the defaults-defeated class: a GET-ONLY accessor. */
function withInheritedGetter<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    get: () => value,
    enumerable: false,
    configurable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}

describe("the gateway config door reads only what the operator wrote", () => {
  it("honest parsing is unchanged: defaults apply when a key is genuinely absent", () => {
    const config = parseGatewayConfig(BASE);
    expect(config.tickIntervalMs).toBe(1_000);
    expect(config.publisher.maxQueueDepth).toBe(1_024);
    expect(config.publisher.maxQueueBytes).toBe(8 * 1024 * 1024);
    expect(config.binance?.feedId).toBe("binance-reference");
    expect(config.binance?.stalenessCheckIntervalMs).toBe(5_000);
    expect(config.binance?.unauthorizedEventEscalationThreshold).toBe(3);
  });

  it("the data-loss-bound check fails on a slow tick, as it must", () => {
    expect(() => parseGatewayConfig(FAST_FSYNC)).toThrow(GatewayConfigurationError);
  });

  it("…and STILL fails under a get-only inherited `tickIntervalMs`", () => {
    parseGatewayConfig(BASE); // warm
    expect(() =>
      withInheritedGetter("tickIntervalMs", 50, () => parseGatewayConfig(FAST_FSYNC)),
    ).toThrow(GatewayConfigurationError);
  });

  it("a configuration with no feed is refused", () => {
    expect(() => parseGatewayConfig(NO_FEED)).toThrow(GatewayConfigurationError);
  });

  it("…and is STILL refused under an inherited `binance` block", () => {
    expect(() =>
      withInherited("binance", BINANCE_FEED, () => parseGatewayConfig(NO_FEED)),
    ).toThrow(GatewayConfigurationError);
  });

  // The REQUIRED keys are the same adoption class, and here the two halves of
  // the door are both load-bearing: without the prototype-free read the schema
  // would ACCEPT a configuration whose `streamName` exists only on
  // `Object.prototype`, and the door — which copies own keys only — would then
  // hand the gateway a configuration with no stream name at all. It refuses
  // instead.
  it("a required key supplied only from the prototype is refused, never started from", () => {
    const noStreamName = { wal: { rootPath: "/wal" }, markets: [MARKET], binance: BINANCE_FEED };
    expect(() => parseGatewayConfig(noStreamName)).toThrow(GatewayConfigurationError);
    expect(() =>
      withInherited("streamName", "market-events", () => parseGatewayConfig(noStreamName)),
    ).toThrow(GatewayConfigurationError);

    const noWal = { streamName: "market-events", markets: [MARKET], binance: BINANCE_FEED };
    expect(() =>
      withInherited("wal", { rootPath: "/wal" }, () => parseGatewayConfig(noWal)),
    ).toThrow(GatewayConfigurationError);

    const noMarkets = { streamName: "market-events", wal: { rootPath: "/wal" }, binance: BINANCE_FEED };
    expect(() => withInherited("markets", [], () => parseGatewayConfig(noMarkets))).toThrow(
      GatewayConfigurationError,
    );
  });

  // An own GETTER on the operator's own object is code, not configuration: it
  // can answer differently on a second read, and the schema and the door would
  // then disagree about what was configured.
  it("an own accessor property is refused without being invoked", () => {
    let reads = 0;
    const withGetter: Record<string, unknown> = { ...BASE };
    Object.defineProperty(withGetter, "tickIntervalMs", {
      get: () => {
        reads += 1;
        return 500;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => parseGatewayConfig(withGetter)).toThrow(GatewayConfigurationError);
    expect(reads).toBe(0);
  });

  // The same two classes on the config door's OTHER defaults and presence
  // checks — the audit the row asks for, not just the two measured cells.
  it("no other `.default()` can be defeated into silence", () => {
    const survivors: string[] = [];

    // Every defaulted key, with a get-only accessor supplying a value that is
    // NOT the default. Either the default still lands, or startup refuses.
    const defaulted: readonly (readonly [string, unknown, () => unknown])[] = [
      ["tickIntervalMs", 7, () => parseGatewayConfig(BASE).tickIntervalMs],
      ["maxQueueDepth", 7, () => parseGatewayConfig(BASE).publisher.maxQueueDepth],
      ["maxQueueBytes", 7, () => parseGatewayConfig(BASE).publisher.maxQueueBytes],
      ["feedId", "invented", () => parseGatewayConfig(BASE).binance?.feedId],
      [
        "stalenessCheckIntervalMs",
        7,
        () => parseGatewayConfig(BASE).binance?.stalenessCheckIntervalMs,
      ],
      [
        "unauthorizedEventEscalationThreshold",
        7,
        () => parseGatewayConfig(BASE).binance?.unauthorizedEventEscalationThreshold,
      ],
    ];
    const HONEST: Readonly<Record<string, unknown>> = {
      tickIntervalMs: 1_000,
      maxQueueDepth: 1_024,
      maxQueueBytes: 8 * 1024 * 1024,
      feedId: "binance-reference",
      stalenessCheckIntervalMs: 5_000,
      unauthorizedEventEscalationThreshold: 3,
    };

    for (const [key, planted, read] of defaulted) {
      let observed: unknown;
      try {
        observed = withInheritedGetter(key, planted, read);
      } catch {
        continue; // refused: fail closed is a correct answer
      }
      if (observed !== HONEST[key]) survivors.push(`${key} -> ${String(observed)}`);
    }

    expect(survivors).toEqual([]);
  });

  it("no presence check can be satisfied from the prototype", () => {
    const survivors: string[] = [];

    // §9.2: the Polymarket feed requires configured markets.
    const polymarketNoMarkets = {
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      polymarket: { feedId: "polymarket-market" },
    };
    try {
      withInherited("markets", [MARKET], () => parseGatewayConfig(polymarketNoMarkets));
      survivors.push("markets");
    } catch {
      /* refused, as it must be */
    }

    // The fsync interval the data-loss bound is computed against.
    try {
      const config = withInherited("fsyncIntervalMs", 100, () => parseGatewayConfig(BASE));
      if (config.wal.fsyncIntervalMs !== undefined) survivors.push("wal.fsyncIntervalMs");
    } catch {
      /* refused, as it must be */
    }

    // Each of the other three feed blocks, on the same "at least one feed"
    // check as `binance`.
    const inheritedFeeds: readonly (readonly [string, unknown])[] = [
      ["polymarket", { feedId: "polymarket-market" }],
      [
        "rtds",
        {
          feedId: "polymarket-rtds-twap",
          subscriptions: [{ windowSeconds: 60 }],
          plannedSymbols: ["btc/usd"],
        },
      ],
      ["coinbase", { feedId: "coinbase-reference", productIds: ["BTC-USD"] }],
    ];
    for (const [key, block] of inheritedFeeds) {
      try {
        withInherited(key, block, () => parseGatewayConfig(NO_FEED));
        survivors.push(key);
      } catch {
        /* refused, as it must be */
      }
    }

    expect(survivors).toEqual([]);
  });

  // THE CENSUS, MECHANICAL. The door applies the schema's `.default()`s
  // itself, so a `.default()` the door's table does not carry would be a
  // default silently lost under pollution. This derives the census from the
  // schema rather than restating it: adding a `.default()` fails here.
  it("the door's default table is exactly the set of `.default()`s the schema declares", () => {
    const declared = defaultedKeysOf(GatewayConfigSchema as unknown as SchemaNode, "");
    const covered = new Set<string>();
    for (const [key] of DEFAULTED_ROOT_KEYS) covered.add(key);
    for (const block of DEFAULTED_BLOCKS) covered.add(block);
    for (const [block, entries] of DEFAULTED_KEYS) {
      for (const [key] of entries) covered.add(`${block}.${key}`);
    }
    expect([...declared].sort()).toEqual([...covered].sort());
    // Non-vacuity: the walk really found the two measured cells.
    expect(declared.has("tickIntervalMs")).toBe(true);
    expect(declared.has("binance.feedId")).toBe(true);
  });

  // REVIEW ROUND 1, FINDING F1. The ENUMERABLE variant of both measured cells.
  // A door that copied inherited enumerable keys after its own-key loop kept
  // every other test in this file green while a gateway configured to record
  // NOTHING started and the data-loss-bound check went quiet again.
  it("neither cell reopens under ENUMERABLE inherited pollution", () => {
    parseGatewayConfig(BASE); // warm: enumerable pollution poisons cold lazies

    // Cell 1: the `.default()` that keeps `dataLossBoundMs` honest.
    expect(() =>
      withInheritedEnumerable("tickIntervalMs", 50, () => parseGatewayConfig(FAST_FSYNC)),
    ).toThrow(GatewayConfigurationError);

    // Cell 2: "at least one feed must be configured".
    for (const [key, block] of [
      ["binance", BINANCE_FEED],
      ["polymarket", { feedId: "polymarket-market" }],
      ["coinbase", { feedId: "coinbase-reference", productIds: ["BTC-USD"] }],
    ] as const) {
      expect(
        () => withInheritedEnumerable(key, block, () => parseGatewayConfig(NO_FEED)),
        key,
      ).toThrow(GatewayConfigurationError);
    }

    // …and a required key is still not adoptable in this variant either.
    const noStreamName = { wal: { rootPath: "/wal" }, markets: [MARKET], binance: BINANCE_FEED };
    expect(() =>
      withInheritedEnumerable("streamName", "market-events", () =>
        parseGatewayConfig(noStreamName),
      ),
    ).toThrow(GatewayConfigurationError);
  });

  // REVIEW ROUND 1, FINDING F1 — THE DOOR'S OWN CONTRACT, pinned directly.
  //
  // The end-to-end test above passes even against a door that copies inherited
  // enumerable keys, and the reason is worth recording rather than relying on:
  // `GatewayConfigSchema` is a `z.strictObject` at every level, and a root-level
  // key copied into `wal` / `markets[].parameters` / a feed block is an
  // `unrecognized_keys` issue there — so the enumerable variant is ACCIDENTALLY
  // fail-closed at this door, by a mechanism `schema-boundary.md` §1 explicitly
  // says is not a defence and which does not see the non-enumerable variant at
  // all. The materializer's own contract is therefore asserted directly: the
  // tree it produces owns exactly the keys the operator's value owned, at every
  // level, in both variants.
  it("the materializer copies own keys ONLY, in both pollution variants", () => {
    const input = { streamName: "market-events", wal: { rootPath: "/wal" }, markets: [] };
    const expected = ["streamName", "wal", "markets"];

    for (const install of [withInherited, withInheritedEnumerable]) {
      const variant = install === withInherited ? "non-enumerable" : "enumerable";
      const read = install("tickIntervalMs", 50, () =>
        install("binance", BINANCE_FEED, () => readOwnConfig(input)),
      );
      expect(read.ok, variant).toBe(true);
      if (!read.ok) throw new Error("unreachable");
      const tree = read.value as Record<string, unknown>;
      expect(Object.keys(tree).sort(), variant).toEqual([...expected].sort());
      expect(Object.hasOwn(tree, "tickIntervalMs"), variant).toBe(false);
      expect(Object.hasOwn(tree, "binance"), variant).toBe(false);
      expect(Object.getPrototypeOf(tree), variant).toBeNull();
      // …and the same one level down, where the nested strictObjects would
      // otherwise be doing the work.
      const wal = tree["wal"] as Record<string, unknown>;
      expect(Object.keys(wal), variant).toEqual(["rootPath"]);
      expect(Object.getPrototypeOf(wal), variant).toBeNull();
    }
  });

  // REVIEW ROUND 1, FINDING F2. ADR-020's 2026-09-06 amendment: a warm schema
  // still builds its issues lazily per refusal, and that path reads through the
  // prototype chain. With `./config-door.ts`'s containment deleted, an
  // inherited non-enumerable `_zod` turns an invalid configuration into a bare
  // `TypeError` instead of the typed startup failure an operator is told to
  // expect.
  it("a refusal that cannot be CONSTRUCTED is still a typed configuration error", () => {
    parseGatewayConfig(BASE); // warm
    const invalid = { ...BASE, streamName: "not a code string!" };
    for (const key of ["_zod", "value"] as const) {
      let thrown: unknown;
      try {
        withInherited(key, {}, () => parseGatewayConfig(invalid));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, key).toBeInstanceOf(GatewayConfigurationError);
    }
  });

  // D4: the configuration and every block inside it are emitted prototype-free,
  // so a later `config.rtds?.updateStalenessMs ?? fallback` cannot be answered
  // by `Object.prototype`.
  it("the emitted configuration has a null prototype at every level (D4)", () => {
    const config = parseGatewayConfig(BASE);
    expect(Object.getPrototypeOf(config)).toBeNull();
    expect(Object.getPrototypeOf(config.publisher)).toBeNull();
    expect(Object.getPrototypeOf(config.wal)).toBeNull();
    expect(Object.getPrototypeOf(config.binance)).toBeNull();
    expect(Object.getPrototypeOf(config.markets[0])).toBeNull();
    // …so an absent optional block reads as absent whatever the prototype says.
    expect(withInherited("rtds", { feedId: "invented" }, () => config.rtds)).toBeUndefined();
  });

  it("an honest configuration under the same pollution parses identically", () => {
    const clean = parseGatewayConfig(BASE);
    const polluted = withInherited("binance", { feedId: "other", symbols: [], stalenessThresholdMs: 1 }, () =>
      parseGatewayConfig(BASE),
    );
    expect(JSON.stringify(polluted)).toBe(JSON.stringify(clean));
  });
});
