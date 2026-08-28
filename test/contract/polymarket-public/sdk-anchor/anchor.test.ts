/**
 * Register item R-2: the anchor table is executable, so transcription is not
 * silently load-bearing.
 *
 * See `./anchor-table.ts` for what the table records and why. This file turns
 * every row into behaviour.
 */

import { describe, expect, it } from "vitest";

import {
  MarketBestBidAskEventSchema,
  MarketBookEventSchema,
  MarketLastTradePriceEventSchema,
  MarketPriceChangeEntrySchema,
  MarketPriceChangeEventSchema,
  MarketResolvedEventSchema,
  MarketTickSizeChangeEventSchema,
  NewMarketEventSchema,
  parseMarketEvent,
  parseVenueOrderBook,
  VenueOrderBookSchema,
} from "@polymarket-bot/polymarket-public";

import {
  MARKET_EVENT_ANCHORS,
  ORDER_BOOK_ANCHOR,
  SDK_REFERENCE_COMMIT,
  type SdkFieldAnchor,
  type SdkSchemaAnchor,
} from "./anchor-table.js";

/**
 * The zod surface this file needs, described structurally.
 *
 * The contract tree sits outside every workspace package, so it cannot resolve
 * `zod` itself; naming the one member it uses keeps the suite dependency-free.
 */
interface ShapedSchema {
  readonly shape: Readonly<Record<string, unknown>>;
}

/** Maps an anchor's `localSchema` name to the schema it must describe. */
const LOCAL_SCHEMAS: Record<string, ShapedSchema> = {
  MarketBookEventSchema,
  MarketPriceChangeEventSchema,
  MarketPriceChangeEntrySchema,
  MarketLastTradePriceEventSchema,
  MarketTickSizeChangeEventSchema,
  MarketBestBidAskEventSchema,
  NewMarketEventSchema,
  MarketResolvedEventSchema,
  VenueOrderBookSchema,
};

const ALL_ANCHORS: readonly SdkSchemaAnchor[] = [...MARKET_EVENT_ANCHORS, ORDER_BOOK_ANCHOR];

function minimalObject(anchor: SdkSchemaAnchor): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const field of anchor.fields) {
    object[field.field] = field.sample;
  }
  return object;
}

function withField(
  anchor: SdkSchemaAnchor,
  field: string,
  value: unknown,
): Record<string, unknown> {
  return { ...minimalObject(anchor), [field]: value };
}

function withoutField(anchor: SdkSchemaAnchor, field: string): Record<string, unknown> {
  const object = minimalObject(anchor);
  delete object[field];
  return object;
}

/** Parses through the package's real entry point for the anchor's layer. */
function parses(anchor: SdkSchemaAnchor, object: Record<string, unknown>): boolean {
  const embedded = anchor.embed(object);
  if (anchor.localSchema === "VenueOrderBookSchema") {
    return parseVenueOrderBook(embedded).status === "parsed";
  }
  return parseMarketEvent(embedded).status === "parsed";
}

describe("citations", () => {
  it("every anchor and every field cites the pinned SDK commit", () => {
    // A mutable `blob/main` link could be invalidated by a later SDK change
    // without anything here failing, which is exactly the drift R-2 is about.
    for (const anchor of ALL_ANCHORS) {
      expect(anchor.citation, anchor.schema).toContain(SDK_REFERENCE_COMMIT);
      expect(anchor.citation, anchor.schema).not.toContain("/blob/main/");
      for (const field of anchor.fields) {
        expect(field.citation, `${anchor.schema}.${field.field}`).toContain(SDK_REFERENCE_COMMIT);
      }
    }
  });

  it("pins the reference commit the venue report froze", () => {
    expect(SDK_REFERENCE_COMMIT).toBe("7fdbed42484b5d279c71aa36d3757d18968260da");
  });
});

describe("completeness", () => {
  it.each(ALL_ANCHORS.map((anchor) => [anchor.schema, anchor] as const))(
    "%s: the anchor table and the package schema describe the same field set",
    (_name, anchor) => {
      const schema = LOCAL_SCHEMAS[anchor.localSchema];
      expect(schema, `no local schema named ${anchor.localSchema}`).toBeDefined();
      const schemaKeys = Object.keys(schema?.shape ?? {}).sort();
      const anchorKeys = anchor.fields.map((field) => field.field).sort();
      expect(anchorKeys).toEqual(schemaKeys);
    },
  );

  it.each(ALL_ANCHORS.map((anchor) => [anchor.schema, anchor] as const))(
    "%s: the field count still matches the SDK source that was read",
    (_name, anchor) => {
      // Adding a field to the schema and the table without re-reading the SDK
      // changes this count, which forces the re-read to be recorded.
      expect(anchor.fields).toHaveLength(anchor.sdkFieldCount);
    },
  );

  it("anchors every market-channel event the adapter models", () => {
    const anchored = new Set(
      MARKET_EVENT_ANCHORS.map((anchor) => anchor.localSchema).filter((name) =>
        name.endsWith("EventSchema"),
      ),
    );
    expect(anchored).toEqual(
      new Set([
        "MarketBookEventSchema",
        "MarketPriceChangeEventSchema",
        "MarketLastTradePriceEventSchema",
        "MarketTickSizeChangeEventSchema",
        "MarketBestBidAskEventSchema",
        "NewMarketEventSchema",
        "MarketResolvedEventSchema",
      ]),
    );
  });
});

describe("behaviour", () => {
  it.each(ALL_ANCHORS.map((anchor) => [anchor.schema, anchor] as const))(
    "%s: the minimal event built from the SDK's own samples parses",
    (_name, anchor) => {
      expect(parses(anchor, minimalObject(anchor))).toBe(true);
    },
  );

  const vectors: readonly {
    readonly anchor: SdkSchemaAnchor;
    readonly field: SdkFieldAnchor;
  }[] = ALL_ANCHORS.flatMap((anchor) => anchor.fields.map((field) => ({ anchor, field })));

  it.each(
    vectors.map(({ anchor, field }) => [`${anchor.schema}.${field.field}`, anchor, field] as const),
  )("%s: behaves exactly as the SDK modifier declares", (_name, anchor, field) => {
    switch (field.modifier) {
      case "literal":
        // The discriminator must be present and exact; a different value is a
        // different event, not a malformed one.
        expect(parses(anchor, withField(anchor, field.field, "definitely-not-an-event"))).toBe(
          false,
        );
        return;
      case "required":
        // Omitting it must fail: a parser that tolerated a missing required
        // field would silently normalize an event the venue never sent.
        expect(parses(anchor, withoutField(anchor, field.field))).toBe(false);
        expect(parses(anchor, withField(anchor, field.field, field.sample))).toBe(true);
        return;
      case "nullish":
      case "nullish-array":
        // ADR-002 §7: accept `null` wherever the SDK declares `.nullish()`.
        expect(parses(anchor, withField(anchor, field.field, null))).toBe(true);
        expect(parses(anchor, withoutField(anchor, field.field))).toBe(true);
        return;
      case "optional-decimal":
        // Plus the wire empty string, which the SDK treats as an accepted value
        // rather than a malformed one.
        expect(parses(anchor, withField(anchor, field.field, ""))).toBe(true);
        expect(parses(anchor, withField(anchor, field.field, null))).toBe(true);
        expect(parses(anchor, withoutField(anchor, field.field))).toBe(true);
        return;
    }
  });
});

describe("recorded divergences from the SDK", () => {
  it("records a reason for every field where this package is deliberately looser", () => {
    const diverging = ORDER_BOOK_ANCHOR.fields.filter(
      (field) => field.sdkDivergence !== undefined,
    );
    // Four, and each names why: the hash form, the condition-id byte length,
    // the float tick size, and the two fields the WebSocket book event already
    // marks optional.
    expect(diverging.map((field) => field.field).sort()).toEqual([
      "hash",
      "market",
      "min_order_size",
      "neg_risk",
      "tick_size",
    ]);
    for (const field of diverging) {
      expect(field.sdkDivergence?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
