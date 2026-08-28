/**
 * Register item R-2: the anchor table is executable, so transcription is not
 * silently load-bearing.
 *
 * See `./anchor-table.ts` for what each row records and why round 1 split the
 * SDK modifier, the REST modifier and this package's modifier into three
 * columns. This file turns every column into behaviour:
 *
 * - the LOCAL modifier is asserted against the real parser, so a mistranscribed
 *   modifier changes observable behaviour and fails;
 * - the SDK and REST modifiers are asserted as OBLIGATIONS on the local one —
 *   never stricter than the venue, never looser without a recorded, reasoned
 *   divergence naming the dimension it moves;
 * - every `value-form` divergence must carry a vector that the stricter source
 *   rejects and this parser accepts, so "deliberately looser" is a claim a test
 *   makes rather than a sentence in a table.
 */

import { describe, expect, it } from "vitest";

import * as packageSurface from "@polymarket-bot/polymarket-public";
import {
  MarketBestBidAskEventSchema,
  MarketBookEventSchema,
  MarketEventMessageSchema,
  MarketLastTradePriceEventSchema,
  MarketPriceChangeEntrySchema,
  MarketPriceChangeEventSchema,
  MarketResolvedEventSchema,
  MarketTickSizeChangeEventSchema,
  NewMarketEventSchema,
  parseMarketEvent,
  parseVenueOrderBook,
  VenueBookLevelSchema,
  VenueOrderBookSchema,
} from "@polymarket-bot/polymarket-public";

import {
  ALL_ANCHORS,
  MARKET_EVENT_ANCHORS,
  ORDER_BOOK_ANCHOR,
  SDK_REFERENCE_COMMIT,
  type FieldModifier,
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
  MarketEventMessageSchema,
  NewMarketEventSchema,
  MarketResolvedEventSchema,
  VenueBookLevelSchema,
  VenueOrderBookSchema,
};

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
  if (anchor.layer === "rest-book") {
    return parseVenueOrderBook(embedded).status === "parsed";
  }
  return parseMarketEvent(embedded).status === "parsed";
}

/**
 * How permissive a modifier is about the key being THERE.
 *
 * `optional-decimal` sits at the same presence rank as `nullish`: the empty
 * string it additionally accepts is a value-form question, and keeping the two
 * dimensions apart is the point of the round-1 rework.
 */
function presenceRank(modifier: FieldModifier): number {
  switch (modifier) {
    case "literal":
    case "required":
      return 0;
    case "nullish":
    case "nullish-array":
    case "optional-decimal":
      return 1;
  }
}

function acceptsEmptyString(modifier: FieldModifier): boolean {
  return modifier === "optional-decimal";
}

function divergences(
  field: SdkFieldAnchor,
  dimension: "presence" | "value-form",
  from?: "sdk" | "rest-openapi",
): readonly { readonly reason: string; readonly authority: string }[] {
  return (field.divergences ?? []).filter(
    (divergence) =>
      divergence.dimension === dimension && (from === undefined || divergence.from === from),
  );
}

const VECTORS: readonly {
  readonly anchor: SdkSchemaAnchor;
  readonly field: SdkFieldAnchor;
}[] = ALL_ANCHORS.flatMap((anchor) => anchor.fields.map((field) => ({ anchor, field })));

const NAMED_VECTORS = VECTORS.map(
  ({ anchor, field }) => [`${anchor.schema}.${field.field}`, anchor, field] as const,
);

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

  it("every REST modifier cites the official spec and its retrieval date", () => {
    for (const field of ORDER_BOOK_ANCHOR.fields) {
      expect(field.restModifier, `${ORDER_BOOK_ANCHOR.schema}.${field.field}`).toBeDefined();
      expect(field.restCitation ?? "", field.field).toContain("docs.polymarket.com");
      expect(field.restCitation ?? "", field.field).toContain("retrieved 2026-08-27");
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
      MARKET_EVENT_ANCHORS.filter((anchor) => anchor.layer === "market-event").map(
        (anchor) => anchor.localSchema,
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

  it("anchors every object schema the package EXPORTS, nested ones included", () => {
    // Round-1 finding M1(a): `VenueBookLevelSchema` and
    // `MarketEventMessageSchema` were exported and load-bearing — every book
    // level and every lifecycle event's parent metadata goes through them — and
    // neither appeared in the table. Enumerating the package surface is what
    // makes that impossible to repeat: a new exported object schema fails here
    // until it is anchored.
    const exported = Object.entries(packageSurface as Record<string, unknown>)
      .filter(([name, value]) => {
        if (!name.endsWith("Schema")) return false;
        if (typeof value !== "object" || value === null) return false;
        const shape = (value as { shape?: unknown }).shape;
        return typeof shape === "object" && shape !== null;
      })
      .map(([name]) => name)
      .sort();
    const anchoredNames = new Set(ALL_ANCHORS.map((anchor) => anchor.localSchema));
    const unanchored = exported.filter((name) => !anchoredNames.has(name));
    expect(unanchored, `unanchored exported object schemas: ${unanchored.join(", ")}`).toEqual([]);
    // ...and the table is not padded with schemas the package does not export.
    expect([...anchoredNames].sort()).toEqual(exported);
  });
});

describe("behaviour of the LOCAL modifier", () => {
  it.each(ALL_ANCHORS.map((anchor) => [anchor.schema, anchor] as const))(
    "%s: the minimal object built from the recorded samples parses",
    (_name, anchor) => {
      expect(parses(anchor, minimalObject(anchor))).toBe(true);
    },
  );

  it.each(NAMED_VECTORS)(
    "%s: behaves exactly as the modifier this package declares",
    (_name, anchor, field) => {
      switch (field.localModifier) {
        case "literal":
          // The discriminator must be present and exact; a different value is a
          // different event, not a malformed one.
          expect(parses(anchor, withField(anchor, field.field, "definitely-not-an-event"))).toBe(
            false,
          );
          expect(parses(anchor, withoutField(anchor, field.field))).toBe(false);
          return;
        case "required":
          // Omitting it must fail: a parser that tolerated a missing required
          // field would silently normalize a document the venue never sent.
          expect(parses(anchor, withoutField(anchor, field.field))).toBe(false);
          expect(parses(anchor, withField(anchor, field.field, null))).toBe(false);
          expect(parses(anchor, withField(anchor, field.field, field.sample))).toBe(true);
          return;
        case "nullish":
        case "nullish-array":
          // ADR-002 §7: accept `null` wherever the SDK declares `.nullish()`.
          expect(parses(anchor, withField(anchor, field.field, null))).toBe(true);
          expect(parses(anchor, withoutField(anchor, field.field))).toBe(true);
          return;
        case "optional-decimal":
          // Plus the wire empty string, which the SDK treats as an accepted
          // value rather than a malformed one.
          expect(parses(anchor, withField(anchor, field.field, ""))).toBe(true);
          expect(parses(anchor, withField(anchor, field.field, null))).toBe(true);
          expect(parses(anchor, withoutField(anchor, field.field))).toBe(true);
          return;
      }
    },
  );
});

describe("obligations the SDK and the REST spec impose on the local modifier", () => {
  it.each(NAMED_VECTORS)(
    "%s: this parser is never STRICTER than the SDK about presence",
    (_name, anchor, field) => {
      // An adapter stricter than the venue drops real traffic.
      expect(presenceRank(field.localModifier)).toBeGreaterThanOrEqual(
        presenceRank(field.sdkModifier),
      );
      if (presenceRank(field.sdkModifier) > 0) {
        expect(parses(anchor, withField(anchor, field.field, null))).toBe(true);
        expect(parses(anchor, withoutField(anchor, field.field))).toBe(true);
      }
      if (acceptsEmptyString(field.sdkModifier)) {
        expect(parses(anchor, withField(anchor, field.field, ""))).toBe(true);
      }
    },
  );

  it.each(NAMED_VECTORS)(
    "%s: any LOOSENING of presence names its source and its reason",
    (_name, _anchor, field) => {
      // This is the check the first version could not make: it recorded the
      // local modifier in the SDK's column, so a required field turned optional
      // read as agreement.
      if (presenceRank(field.localModifier) > presenceRank(field.sdkModifier)) {
        expect(
          divergences(field, "presence", "sdk").length,
          `${field.field} is looser than the SDK about presence with no recorded reason`,
        ).toBeGreaterThan(0);
      }
      if (
        field.restModifier !== undefined &&
        presenceRank(field.localModifier) > presenceRank(field.restModifier)
      ) {
        expect(
          divergences(field, "presence", "rest-openapi").length,
          `${field.field} is looser than the official REST spec about presence with no recorded reason`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(NAMED_VECTORS)(
    "%s: accepting the wire empty string where the source does not is a VALUE-form divergence",
    (_name, _anchor, field) => {
      if (acceptsEmptyString(field.localModifier) && !acceptsEmptyString(field.sdkModifier)) {
        expect(
          divergences(field, "value-form").length,
          `${field.field} accepts "" where the SDK does not, with no recorded reason`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("every field the official REST spec requires is required here, or has a reason", () => {
    // The heart of M1(c): four fields the OpenAPI and the SDK both declare
    // required used to parse when omitted, justified by a WebSocket event's
    // looser shape — which is not evidence about the REST wire contract.
    const looser = ORDER_BOOK_ANCHOR.fields.filter(
      (field) =>
        field.restModifier === "required" && presenceRank(field.localModifier) > presenceRank("required"),
    );
    expect(looser.map((field) => field.field).sort()).toEqual([
      "last_trade_price",
      "timestamp",
    ]);
    for (const field of looser) {
      const reasons = divergences(field, "presence", "rest-openapi");
      expect(reasons.length, field.field).toBeGreaterThan(0);
      for (const reason of reasons) {
        // The reason must be about ABSENCE, and must name first-party evidence.
        expect(reason.authority, field.field).toContain("SDK");
        expect(reason.reason.length, field.field).toBeGreaterThan(40);
      }
    }
  });
});

describe("recorded divergences are executable", () => {
  it.each(NAMED_VECTORS)(
    "%s: every value-form divergence carries a vector the source rejects",
    (_name, anchor, field) => {
      const valueForm = divergences(field, "value-form");
      if (valueForm.length === 0) {
        expect(
          field.localOnlyValues ?? [],
          `${field.field} carries local-only vectors with no recorded value-form reason`,
        ).toEqual([]);
        return;
      }
      expect(
        field.localOnlyValues ?? [],
        `${field.field} records a value-form divergence with nothing to prove it`,
      ).not.toEqual([]);
      for (const value of field.localOnlyValues ?? []) {
        expect(
          parses(anchor, withField(anchor, field.field, value)),
          `${field.field} should accept ${JSON.stringify(value)}`,
        ).toBe(true);
      }
    },
  );

  it("every recorded divergence names a dimension, a source, a reason and an authority", () => {
    for (const { anchor, field } of VECTORS) {
      for (const divergence of field.divergences ?? []) {
        const label = `${anchor.schema}.${field.field}`;
        expect(["presence", "value-form"], label).toContain(divergence.dimension);
        expect(["sdk", "rest-openapi"], label).toContain(divergence.from);
        expect(divergence.reason.length, label).toBeGreaterThan(40);
        expect(divergence.authority.length, label).toBeGreaterThan(10);
      }
    }
  });

  it("the REST book's divergences are exactly the ones the header documents", () => {
    const byDimension = ORDER_BOOK_ANCHOR.fields.flatMap((field) =>
      (field.divergences ?? []).map((divergence) => `${field.field}:${divergence.dimension}`),
    );
    expect(byDimension.sort()).toEqual([
      "hash:value-form",
      "last_trade_price:presence",
      "last_trade_price:value-form",
      "market:value-form",
      "tick_size:value-form",
      "timestamp:presence",
      "timestamp:value-form",
    ]);
  });
});

describe("the restored REST requiredness, at the real entry point", () => {
  const BODY: Record<string, unknown> = {
    market: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
    asset_id:
      "107505882767731489358349912513945399560393482969656700824895970500493757150417",
    timestamp: "1782753357257",
    hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    bids: [{ price: "0.01", size: "1" }],
    asks: [{ price: "0.99", size: "1" }],
    min_order_size: "5",
    tick_size: "0.01",
    neg_risk: false,
    last_trade_price: "0.090",
  };

  it.each(["min_order_size", "tick_size", "neg_risk", "hash"])(
    "rejects a book whose %s is missing or null",
    (field) => {
      // The exact probe that failed in round 1: each of these parsed happily
      // when omitted AND when null, although the official OpenAPI lists all
      // four under `required` and the SDK requires them too.
      const omitted = { ...BODY };
      delete omitted[field];
      expect(parseVenueOrderBook(omitted).status).toBe("invalid");
      expect(parseVenueOrderBook({ ...BODY, [field]: null }).status).toBe("invalid");
    },
  );

  it("rejects an empty hash and a non-boolean neg_risk", () => {
    expect(parseVenueOrderBook({ ...BODY, hash: "" }).status).toBe("invalid");
    expect(parseVenueOrderBook({ ...BODY, neg_risk: "" }).status).toBe("invalid");
  });

  it("accepts the wire empty string for a required DECIMAL, exactly as the SDK does", () => {
    // `DecimalStringSchema` is `z.string().transform(...)`, so the SDK accepts
    // `""` here too, and ADR-002 §7 forbids being stricter than the SDK at the
    // wire layer. The empty string is a spelling of absence, not a zero: it
    // survives parsing and collapses to ABSENT in `normalizeVenueDecimal`.
    // Neither field reaches a domain payload from this package today.
    expect(parseVenueOrderBook({ ...BODY, min_order_size: "" }).status).toBe("parsed");
    expect(parseVenueOrderBook({ ...BODY, tick_size: "" }).status).toBe("parsed");
    expect(packageSurface.normalizeVenueDecimal("")).toEqual({ status: "absent" });
  });

  it("still accepts a book with no timestamp and no last trade price", () => {
    const withoutOptionals = { ...BODY, timestamp: null, last_trade_price: "" };
    expect(parseVenueOrderBook(withoutOptionals).status).toBe("parsed");
  });

  it("uses the same level schema on the REST path as on the WebSocket path", () => {
    // The nested anchor is driven through the WebSocket book event, so this is
    // what ties the same rule to the REST body.
    expect(parseVenueOrderBook({ ...BODY, bids: [{ size: "1" }] }).status).toBe("invalid");
    expect(parseVenueOrderBook({ ...BODY, asks: [{ price: "0.99" }] }).status).toBe("invalid");
  });
});
