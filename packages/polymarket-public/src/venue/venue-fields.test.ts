/**
 * THE FIELD TABLES ARE DERIVED FROM THE SCHEMAS, NOT WRITTEN BESIDE THEM.
 *
 * `./wire-door.ts`'s D3 projection is driven by a `*_FIELDS` table per wire
 * shape. A table is a second statement of the schema, and a second statement
 * that nobody checks is how a door quietly starts emitting something the schema
 * does not describe — which is the failure mode `REC-1`'s gateway `.default()`
 * census was built against, and the pattern this file follows.
 *
 * Four properties are RE-DERIVED here from the schema objects themselves, so a
 * field added, removed, reordered, re-modified or re-typed without a matching
 * table row fails this suite rather than changing what the door emits:
 *
 * 1. the key LIST and its ORDER (`Object.keys(schema.shape)`) — order is
 *    load-bearing, because `zod` emits its output in declaration order and the
 *    door's projection has to be byte-identical to it;
 * 2. REQUIREDNESS (`shape[key].isOptional()`), which drives the door's
 *    D2-compensation presence re-statement;
 * 3. the two TRANSFORM rules, by node IDENTITY against the exported primitives
 *    (`VenueOptionalDecimalStringSchema`, `VenueSideSchema`) — the only two
 *    schemas on these payload families that change a value;
 * 4. the DIFFERENTIAL: over a matrix of every declared key against eight value
 *    forms, the door's answer and the raw schema's answer are compared value
 *    for value, own key for own key, at every depth. That is what proves the
 *    projection faithful without trusting either statement of it — and what
 *    catches a new NESTED field whose table row is missing, because an unknown
 *    key injected inside it would survive the door and not the schema.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MARKET_BEST_BID_ASK_EVENT_FIELDS,
  MARKET_BOOK_EVENT_FIELDS,
  MARKET_EVENT_MESSAGE_FIELDS,
  MARKET_LAST_TRADE_PRICE_EVENT_FIELDS,
  MARKET_PRICE_CHANGE_ENTRY_FIELDS,
  MARKET_PRICE_CHANGE_EVENT_FIELDS,
  MARKET_RESOLVED_EVENT_FIELDS,
  MARKET_TICK_SIZE_CHANGE_EVENT_FIELDS,
  MarketBestBidAskEventSchema,
  MarketBookEventSchema,
  MarketEventMessageSchema,
  MarketEventSchema,
  MarketLastTradePriceEventSchema,
  MarketPriceChangeEntrySchema,
  MarketPriceChangeEventSchema,
  MarketResolvedEventSchema,
  MarketTickSizeChangeEventSchema,
  NEW_MARKET_EVENT_FIELDS,
  NewMarketEventSchema,
  parseMarketEvent,
} from "./market-events.js";
import {
  VENUE_ORDER_BOOK_FIELDS,
  VenueOrderBookSchema,
  VenueOrderBooksSchema,
  parseVenueOrderBook,
  parseVenueOrderBooks,
} from "./order-book.js";
import {
  VENUE_BOOK_LEVEL_FIELDS,
  VenueBookLevelSchema,
  VenueOptionalDecimalStringSchema,
  VenueSideSchema,
} from "./primitives.js";
import type { WireField, WireFields } from "./wire-door.js";
import {
  BEST_BID_ASK_EVENT,
  BOOK_EVENT,
  EVENT_MESSAGE,
  LAST_TRADE_EVENT,
  MARKET_RESOLVED_EVENT,
  NEW_MARKET_EVENT,
  ORDER_BOOK,
  PRICE_CHANGE_ENTRY,
  PRICE_CHANGE_EVENT,
  TICK_SIZE_EVENT,
} from "./wire-fixtures.js";

/** The nine object schemas the door projects, each with its table. */
const TABLES: readonly {
  readonly name: string;
  readonly schema: { readonly shape: Readonly<Record<string, unknown>> };
  readonly fields: WireFields;
}[] = [
  { name: "MarketBookEventSchema", schema: MarketBookEventSchema, fields: MARKET_BOOK_EVENT_FIELDS },
  {
    name: "MarketPriceChangeEntrySchema",
    schema: MarketPriceChangeEntrySchema,
    fields: MARKET_PRICE_CHANGE_ENTRY_FIELDS,
  },
  {
    name: "MarketPriceChangeEventSchema",
    schema: MarketPriceChangeEventSchema,
    fields: MARKET_PRICE_CHANGE_EVENT_FIELDS,
  },
  {
    name: "MarketLastTradePriceEventSchema",
    schema: MarketLastTradePriceEventSchema,
    fields: MARKET_LAST_TRADE_PRICE_EVENT_FIELDS,
  },
  {
    name: "MarketTickSizeChangeEventSchema",
    schema: MarketTickSizeChangeEventSchema,
    fields: MARKET_TICK_SIZE_CHANGE_EVENT_FIELDS,
  },
  {
    name: "MarketBestBidAskEventSchema",
    schema: MarketBestBidAskEventSchema,
    fields: MARKET_BEST_BID_ASK_EVENT_FIELDS,
  },
  {
    name: "MarketEventMessageSchema",
    schema: MarketEventMessageSchema,
    fields: MARKET_EVENT_MESSAGE_FIELDS,
  },
  { name: "NewMarketEventSchema", schema: NewMarketEventSchema, fields: NEW_MARKET_EVENT_FIELDS },
  {
    name: "MarketResolvedEventSchema",
    schema: MarketResolvedEventSchema,
    fields: MARKET_RESOLVED_EVENT_FIELDS,
  },
  { name: "VenueBookLevelSchema", schema: VenueBookLevelSchema, fields: VENUE_BOOK_LEVEL_FIELDS },
  { name: "VenueOrderBookSchema", schema: VenueOrderBookSchema, fields: VENUE_ORDER_BOOK_FIELDS },
];

interface OptionalityProbe {
  readonly isOptional: () => boolean;
}

function shapeNode(
  table: (typeof TABLES)[number],
  key: string,
): OptionalityProbe & Record<string, unknown> {
  return table.schema.shape[key] as OptionalityProbe & Record<string, unknown>;
}

describe("every field table is re-derived from its schema", () => {
  it.each(TABLES.map((table) => [table.name, table] as const))(
    "%s: the key list and its ORDER match the schema shape",
    (_name, table) => {
      expect(table.fields.map((field: WireField) => field.key)).toEqual(
        Object.keys(table.schema.shape),
      );
    },
  );

  it.each(TABLES.map((table) => [table.name, table] as const))(
    "%s: requiredness matches `isOptional()` on every field",
    (_name, table) => {
      const derived = Object.keys(table.schema.shape).map(
        (key) => `${key}=${String(!shapeNode(table, key).isOptional())}`,
      );
      expect(table.fields.map((field) => `${field.key}=${String(field.required)}`)).toEqual(
        derived,
      );
    },
  );

  it.each(TABLES.map((table) => [table.name, table] as const))(
    "%s: the transform rules are exactly the two transforming primitives",
    (_name, table) => {
      for (const field of table.fields) {
        const node: unknown = table.schema.shape[field.key];
        expect(
          field.rule === "optional-decimal",
          `${field.key} rule vs VenueOptionalDecimalStringSchema identity`,
        ).toBe(node === VenueOptionalDecimalStringSchema);
        expect(field.rule === "side", `${field.key} rule vs VenueSideSchema identity`).toBe(
          node === VenueSideSchema,
        );
      }
    },
  );

  it("the one re-stated BOUND is the order book's hash, and nothing else", () => {
    const bounded = TABLES.flatMap((table) =>
      table.fields.filter((field) => field.nonEmpty === true).map((f) => `${table.name}.${f.key}`),
    );
    expect(bounded).toEqual(["VenueOrderBookSchema.hash"]);
    // …and it is re-derived: the only `.min()` on either payload family.
    expect(VenueOrderBookSchema.shape.hash.safeParse("").success).toBe(false);
    expect(VenueOrderBookSchema.shape.hash.safeParse("x").success).toBe(true);
  });

  it("every schema the door projects is covered by a table", () => {
    // The door routes by `event_type` into one member of the union, so the
    // union's own option list is the completeness statement for the market
    // half; the two REST shapes are named alongside it.
    const options = (MarketEventSchema as unknown as { _def: { options: readonly unknown[] } })._def
      .options;
    expect(options).toHaveLength(7);
    const covered = new Set(TABLES.map((table) => table.schema as unknown));
    for (const option of options) {
      expect(covered.has(option)).toBe(true);
    }
    expect(covered.has(VenueOrderBookSchema as unknown)).toBe(true);
    expect(covered.has(VenueBookLevelSchema as unknown)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// the differential: door vs raw schema, over the declared-key matrix
// --------------------------------------------------------------------------

/** Own-key ORDER preserving, prototype-agnostic: the VALUE of the answer. */
function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeValue(element)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Reflect.ownKeys(record)
    .map((key) =>
      typeof key === "symbol"
        ? `@@${key.toString()}`
        : `${JSON.stringify(key)}:${serializeValue(record[key])}`,
    )
    .join(",")}}`;
}

const ABSENT = Symbol("absent");
const NESTED_UNKNOWN = Symbol("nested-unknown-key");

const MUTATIONS: readonly (readonly [string, unknown])[] = [
  ["absent", ABSENT],
  ["null", null],
  ["empty-string", ""],
  ["number", 42],
  ["boolean", true],
  ["object", { nested: "x" }],
  ["array", ["x"]],
  ["nested-unknown-key", NESTED_UNKNOWN],
];

function mutate(source: Record<string, unknown>, key: string, mutation: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  if (mutation === ABSENT) {
    delete copy[key];
    return copy;
  }
  if (mutation === NESTED_UNKNOWN) {
    const value: unknown = copy[key];
    if (Array.isArray(value) && value[0] !== null && typeof value[0] === "object") {
      (value[0] as Record<string, unknown>)["__drift__"] = "x";
    } else if (value !== null && typeof value === "object") {
      (value as Record<string, unknown>)["__drift__"] = "x";
    } else {
      copy[key] = { __drift__: "x" };
    }
    return copy;
  }
  copy[key] = mutation;
  return copy;
}

const MODELLED_EVENT_TYPES = new Set([
  "book",
  "price_change",
  "last_trade_price",
  "tick_size_change",
  "best_bid_ask",
  "new_market",
  "market_resolved",
]);

/**
 * The BASE implementation of `parseMarketEvent`, transcribed from `989d41d`.
 *
 * This is the comparison the differential needs: not "what does the union say"
 * but "what did this function say before the door", including its routing
 * prelude. Keeping the prelude here is what makes the door's `unrecognized` and
 * `unknown-event-type` answers comparable at all.
 */
function rawMarketVerdict(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "unrecognized";
  }
  const eventType = (value as Record<string, unknown>)["event_type"];
  if (typeof eventType !== "string") {
    return "unrecognized";
  }
  if (!MODELLED_EVENT_TYPES.has(eventType)) {
    return "unknown-event-type";
  }
  const parsed = MarketEventSchema.safeParse(value);
  if (parsed.success) return `parsed ${serializeValue(parsed.data)}`;
  return `invalid ${serializeValue(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
  )}`;
}

function doorMarketVerdict(value: unknown): string {
  const parsed = parseMarketEvent(value);
  if (parsed.status === "parsed") return `parsed ${serializeValue(parsed.event)}`;
  if (parsed.status === "invalid") return `invalid ${serializeValue(parsed.issues)}`;
  return parsed.status;
}

function rawBookVerdict(value: unknown): string {
  const parsed = VenueOrderBookSchema.safeParse(value);
  if (parsed.success) return `parsed ${serializeValue(parsed.data)}`;
  return `invalid ${serializeValue(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
  )}`;
}

function doorBookVerdict(value: unknown): string {
  const parsed = parseVenueOrderBook(value);
  return parsed.status === "parsed"
    ? `parsed ${serializeValue(parsed.book)}`
    : `invalid ${serializeValue(parsed.issues)}`;
}

function rawBooksVerdict(value: unknown): string {
  const parsed = VenueOrderBooksSchema.safeParse([value]);
  if (parsed.success) return `parsed ${serializeValue(parsed.data)}`;
  return `invalid ${serializeValue(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
  )}`;
}

function doorBooksVerdict(value: unknown): string {
  const parsed = parseVenueOrderBooks([value]);
  return parsed.status === "parsed"
    ? `parsed ${serializeValue(parsed.books)}`
    : `invalid ${serializeValue(parsed.issues)}`;
}

const MARKET_SHAPES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["book", BOOK_EVENT],
  ["price_change", PRICE_CHANGE_EVENT],
  ["last_trade_price", LAST_TRADE_EVENT],
  ["tick_size_change", TICK_SIZE_EVENT],
  ["best_bid_ask", BEST_BID_ASK_EVENT],
  ["new_market", NEW_MARKET_EVENT],
  ["market_resolved", MARKET_RESOLVED_EVENT],
];

describe("the door answers exactly what the raw schema answered", () => {
  it.each(MARKET_SHAPES)(
    "%s: every declared key against every value form",
    (_name, honest) => {
      expect(doorMarketVerdict(honest)).toBe(rawMarketVerdict(honest));
      for (const key of Object.keys(honest)) {
        for (const [form, mutation] of MUTATIONS) {
          const value = mutate(honest, key, mutation);
          expect(doorMarketVerdict(value), `${key}/${form}`).toBe(rawMarketVerdict(value));
        }
      }
    },
  );

  it("nested shapes too: price-change entries, book levels, event messages", () => {
    const nested: readonly (readonly [string, Record<string, unknown>, (v: unknown) => unknown])[] =
      [
        [
          "price_change.entry",
          PRICE_CHANGE_ENTRY,
          (entry) => ({ ...PRICE_CHANGE_EVENT, price_changes: [entry] }),
        ],
        [
          "book.level",
          { price: "0.01", size: "1" },
          (level) => ({ ...BOOK_EVENT, bids: [level] }),
        ],
        [
          "event_message",
          EVENT_MESSAGE,
          (message) => ({ ...NEW_MARKET_EVENT, event_message: message }),
        ],
      ];
    for (const [label, honest, embed] of nested) {
      for (const key of Object.keys(honest)) {
        for (const [form, mutation] of MUTATIONS) {
          const value = embed(mutate(honest, key, mutation));
          expect(doorMarketVerdict(value), `${label}.${key}/${form}`).toBe(
            rawMarketVerdict(value),
          );
        }
      }
    }
  });

  it("the REST book, single and batched", () => {
    expect(doorBookVerdict(ORDER_BOOK)).toBe(rawBookVerdict(ORDER_BOOK));
    expect(doorBooksVerdict(ORDER_BOOK)).toBe(rawBooksVerdict(ORDER_BOOK));
    for (const key of Object.keys(ORDER_BOOK)) {
      for (const [form, mutation] of MUTATIONS) {
        const value = mutate(ORDER_BOOK, key, mutation);
        expect(doorBookVerdict(value), `book.${key}/${form}`).toBe(rawBookVerdict(value));
        expect(doorBooksVerdict(value), `books.${key}/${form}`).toBe(rawBooksVerdict(value));
      }
    }
    const level: Record<string, unknown> = { price: "0.01", size: "1" };
    for (const key of Object.keys(level)) {
      for (const [form, mutation] of MUTATIONS) {
        const value = { ...ORDER_BOOK, bids: [mutate(level, key, mutation)] };
        expect(doorBookVerdict(value), `level.${key}/${form}`).toBe(rawBookVerdict(value));
      }
    }
  });

  it("a value that is not an object answers as the raw schema does", () => {
    for (const value of ["x", 1, true, null, [], [1], { }]) {
      expect(doorBookVerdict(value)).toBe(rawBookVerdict(value));
    }
    for (const value of ["x", 1, true, null, [], [{ event_type: "book" }]]) {
      // The market door reports a non-record as `unrecognized`, which is what
      // the base function did before any schema ran.
      expect(parseMarketEvent(value).status).toBe("unrecognized");
    }
  });

  it("the two transforms are the schema's own, not an approximation", () => {
    // `side` upper-cases; the optional decimal collapses `""` to `null`.
    const lowered = parseMarketEvent({ ...LAST_TRADE_EVENT, side: "buy" });
    expect(
      lowered.status === "parsed" && lowered.event.event_type === "last_trade_price"
        ? lowered.event.side
        : lowered.status,
    ).toBe("BUY");
    const empties = parseVenueOrderBook({ ...ORDER_BOOK, last_trade_price: "" });
    expect(empties.status === "parsed" && empties.book.last_trade_price).toBeNull();
    // …and a REQUIRED decimal keeps `""`, because its schema does not transform.
    expect(empties.status === "parsed" && empties.book.tick_size).toBe(ORDER_BOOK["tick_size"]);
  });

  it("the zod pin this derivation rests on is the one ADR-020 §7 gates", () => {
    // A `zod` upgrade is a contract change: `isOptional()` and the declaration
    // order of `shape` are both library behaviour this file derives from.
    expect(z.string().nullish().isOptional()).toBe(true);
    expect(z.string().isOptional()).toBe(false);
    expect(Object.keys(z.object({ b: z.string(), a: z.string() }).shape)).toEqual(["b", "a"]);
  });
});
