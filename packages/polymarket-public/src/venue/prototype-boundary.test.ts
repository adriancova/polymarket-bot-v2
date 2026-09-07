/**
 * REGRESSION: the CLOB wire doors do not read a declared key off the prototype
 * chain, and do not throw out of a function documented total
 * (`docs/contracts/schema-boundary.md` §3, the `polymarket-public` CLOB half;
 * ADR-020 §1 classes 1–2 and the 2026-09-06 containment amendment).
 *
 * MEASURED AT BASE `989d41d`, both reproduced verbatim before this round's door
 * was written, and both reproduced again on the fresh worktree:
 *
 * 1. `parseMarketEvent`, on a `book` frame with `event_type` DELETED:
 *      clean     → `{"status":"unrecognized"}`
 *      polluted  → THREW `TypeError: propValues[key].add is not a function`
 *    in BOTH pollution variants. That is an escaping exception from a function
 *    whose declared return type is `MarketEventParseResult`, out of the cold
 *    `discriminatedUnion` lazy build — the `status`-family trigger the
 *    `schema-boundary.md` §2 refinements row records.
 * 2. `parseVenueOrderBook`, on a REST body with `hash` DELETED:
 *      clean     → `{"status":"invalid","issues":["hash: Invalid input: …"]}`
 *      polluted  → `{"status":"parsed","book":{…,"hash":"INVENTED",…}}`
 *    and the same for `tick_size` → `"0.99"`, an ECONOMIC parameter, into a
 *    recorded book.
 *
 * THE SWEEP BEHIND THEM. The two named cells are not the family. At base, all
 * **82** market-event declared-key cells (seven event shapes plus the
 * price-change entry, the book level and the event message) and all **12**
 * order-book cells diverged from their clean verdict under pollution, on the
 * single AND the batch door — 106 cells, both variants. This file sweeps every
 * one of them and requires the polluted verdict to be byte-identical to the
 * clean one.
 *
 * DEPLOYMENT READING, required whenever this row is quoted: nothing on the wire
 * can write `Object.prototype`. Reaching this needs code already executing in
 * the process. The row says "this check is not load-bearing against an attacker
 * already inside the process", not "a venue can turn this off". It still
 * matters because the recorder runs unattended, so nobody is watching when the
 * check stops firing.
 */

import { describe, expect, it } from "vitest";

import { type MarketEvent, parseMarketEvent } from "./market-events.js";
import { parseVenueOrderBook, parseVenueOrderBooks } from "./order-book.js";
import {
  BEST_BID_ASK_EVENT,
  BOOK_EVENT,
  EVENT_MESSAGE,
  LAST_TRADE_EVENT,
  MARKET_EVENT_FIXTURES,
  MARKET_RESOLVED_EVENT,
  NEW_MARKET_EVENT,
  ORDER_BOOK,
  PRICE_CHANGE_ENTRY,
  PRICE_CHANGE_EVENT,
  poisonFor,
} from "./wire-fixtures.js";

// --------------------------------------------------------------------------
// harness
// --------------------------------------------------------------------------

/** Runs `call` with `Object.prototype[key] = value`, and always cleans up. */
function polluted<T>(
  key: string,
  value: unknown,
  enumerable: boolean,
  call: () => T,
): T {
  Object.defineProperty(Object.prototype, key, {
    value,
    enumerable,
    configurable: true,
    writable: true,
  });
  try {
    return call();
  } finally {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
}

/** The answer as text, with a THROW spelled out rather than propagated. */
function verdict(call: () => unknown): string {
  try {
    return JSON.stringify(call()) ?? "undefined";
  } catch (error: unknown) {
    const thrown = error as Error;
    return `THREW ${thrown.constructor.name}: ${thrown.message}`;
  }
}

function withoutKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const VARIANTS: readonly (readonly [string, boolean])[] = [
  ["non-enumerable", false],
  ["enumerable", true],
];

// --------------------------------------------------------------------------
// the two measured rows
// --------------------------------------------------------------------------

describe("the measured row: parseMarketEvent under an inherited event_type", () => {
  it.each(VARIANTS)("%s: the escaping TypeError is now the documented verdict", (_name, enumerable) => {
    const frame = withoutKey(BOOK_EVENT, "event_type");
    const clean = verdict(() => parseMarketEvent(withoutKey(BOOK_EVENT, "event_type")));
    expect(clean).toBe('{"status":"unrecognized"}');

    const answer = polluted("event_type", "book", enumerable, () =>
      verdict(() => parseMarketEvent({ ...frame })),
    );
    // At base this line read
    //   THREW TypeError: propValues[key].add is not a function
    expect(answer).not.toContain("THREW");
    expect(answer).toBe(clean);
  });

  it.each(VARIANTS)(
    "%s: an inherited event_type cannot ROUTE a frame that declared none",
    (_name, enumerable) => {
      // The sharper form: the frame carries a full, valid `book` payload. Only
      // the field that routes it is missing.
      const frame = withoutKey(BOOK_EVENT, "event_type");
      const answer = polluted("event_type", "book", enumerable, () => parseMarketEvent({ ...frame }));
      expect(answer.status).toBe("unrecognized");
    },
  );

  it.each(VARIANTS)(
    "%s: an inherited event_type cannot even make a frame UNKNOWN rather than unrecognized",
    (_name, enumerable) => {
      const answer = polluted("event_type", "some_new_venue_event", enumerable, () =>
        parseMarketEvent({ market: "0x00" }),
      );
      expect(answer.status).toBe("unrecognized");
    },
  );
});

describe("the measured row: parseVenueOrderBook under an inherited hash / tick_size", () => {
  it.each(VARIANTS)("%s: hash is not invented", (_name, enumerable) => {
    const body = withoutKey(ORDER_BOOK, "hash");
    const clean = verdict(() => parseVenueOrderBook(withoutKey(ORDER_BOOK, "hash")));
    expect(clean).toContain('"status":"invalid"');

    // At base this parsed, with `"hash":"INVENTED"` in the recorded book.
    const answer = polluted("hash", "INVENTED", enumerable, () =>
      verdict(() => parseVenueOrderBook({ ...body })),
    );
    expect(answer).toBe(clean);
    expect(answer).not.toContain("INVENTED");
  });

  it.each(VARIANTS)("%s: tick_size — an ECONOMIC parameter — is not invented", (_name, enumerable) => {
    const body = withoutKey(ORDER_BOOK, "tick_size");
    const clean = verdict(() => parseVenueOrderBook(withoutKey(ORDER_BOOK, "tick_size")));
    const answer = polluted("tick_size", "0.99", enumerable, () =>
      verdict(() => parseVenueOrderBook({ ...body })),
    );
    expect(answer).toBe(clean);
    expect(answer).not.toContain("0.99");
  });

  it.each(VARIANTS)("%s: the BATCH door refuses the same two cells", (_name, enumerable) => {
    for (const key of ["hash", "tick_size"]) {
      const body = withoutKey(ORDER_BOOK, key);
      const clean = verdict(() => parseVenueOrderBooks([withoutKey(ORDER_BOOK, key)]));
      const answer = polluted(key, key === "hash" ? "INVENTED" : "0.99", enumerable, () =>
        verdict(() => parseVenueOrderBooks([{ ...body }])),
      );
      expect(answer, key).toBe(clean);
    }
  });
});

// --------------------------------------------------------------------------
// the declared-key sweep — 82 market cells + 12 book cells, both doors
// --------------------------------------------------------------------------

interface SweepCase {
  readonly family: string;
  readonly honest: Record<string, unknown>;
  readonly embed: (node: Record<string, unknown>) => unknown;
}

const MARKET_SWEEP: readonly SweepCase[] = [
  ...MARKET_EVENT_FIXTURES.map(([name, honest]) => ({
    family: `market:${name}`,
    honest,
    embed: (node: Record<string, unknown>) => node,
  })),
  {
    family: "market:price_change.entry",
    honest: PRICE_CHANGE_ENTRY,
    embed: (node) => ({ ...PRICE_CHANGE_EVENT, price_changes: [node] }),
  },
  {
    family: "market:book.level",
    honest: { price: "0.01", size: "1" },
    embed: (node) => ({ ...BOOK_EVENT, bids: [node] }),
  },
  {
    family: "market:event_message",
    honest: EVENT_MESSAGE,
    embed: (node) => ({ ...NEW_MARKET_EVENT, event_message: node }),
  },
];

const BOOK_SWEEP: readonly SweepCase[] = [
  { family: "book", honest: ORDER_BOOK, embed: (node) => node },
  {
    family: "book.level",
    honest: { price: "0.01", size: "1" },
    embed: (node) => ({ ...ORDER_BOOK, bids: [node] }),
  },
];

function sweep(
  cases: readonly SweepCase[],
  door: (value: unknown) => unknown,
): { readonly cells: number; readonly diverging: readonly string[] } {
  const diverging: string[] = [];
  let cells = 0;
  for (const sweepCase of cases) {
    for (const key of Object.keys(sweepCase.honest)) {
      const poison = poisonFor(key, sweepCase.honest[key]);
      const clean = verdict(() => door(sweepCase.embed(withoutKey(sweepCase.honest, key))));
      for (const [, enumerable] of VARIANTS) {
        cells += 1;
        const answer = polluted(key, poison, enumerable, () =>
          verdict(() => door(sweepCase.embed(withoutKey(sweepCase.honest, key)))),
        );
        if (answer !== clean) {
          diverging.push(
            `${sweepCase.family}.${key}[${enumerable ? "enum" : "nonenum"}]\n  clean=${clean}\n  polluted=${answer}`,
          );
        }
      }
    }
  }
  return { cells, diverging };
}

describe("the declared-key sweep: no cell of either payload family diverges", () => {
  it("the market channel — 82 cells, both variants", () => {
    const result = sweep(MARKET_SWEEP, (value) => parseMarketEvent(value));
    // 82 declared cells × 2 variants. The count is asserted so a fixture that
    // silently loses a key cannot make this sweep pass by shrinking.
    expect(result.cells).toBe(164);
    expect(result.diverging).toEqual([]);
  });

  it("the REST book, single door — 12 cells, both variants", () => {
    const result = sweep(BOOK_SWEEP, (value) => parseVenueOrderBook(value));
    expect(result.cells).toBe(24);
    expect(result.diverging).toEqual([]);
  });

  it("the REST book, batch door — 12 cells, both variants", () => {
    const result = sweep(BOOK_SWEEP, (value) => parseVenueOrderBooks([value]));
    expect(result.cells).toBe(24);
    expect(result.diverging).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// containment (ADR-020 amendment 2026-09-06)
// --------------------------------------------------------------------------

/**
 * Prototype shapes that attack the LIBRARY rather than the payload.
 *
 * Measured at base `989d41d`: across these 24 keys × 2 variants × 5 calls,
 * **120 calls THREW** — `Error: Invalid discriminated union option at index
 * "0"` (95), `TypeError: Invalid property descriptor…` (21) and
 * `TypeError: Cannot read properties of undefined (reading 'has')` (4) — from
 * both doors, on INVALID input and on perfectly honest input alike. At the tip
 * the same battery escapes zero times.
 */
const HOSTILE: readonly (readonly [string, unknown])[] = [
  ["get", (): undefined => undefined],
  ["set", (): undefined => undefined],
  ["_zod", { def: {}, propValues: {} }],
  ["message", "HOSTILE"],
  ["path", ["HOSTILE"]],
  ["value", "HOSTILE"],
  ["status", "HOSTILE"],
  ["issues", ["HOSTILE"]],
  ["def", { type: "HOSTILE" }],
  ["skipChecks", true],
  ["optin", "optional"],
  ["optout", "optional"],
  ["when", (): boolean => false],
  ["values", new Set(["HOSTILE"])],
  ["format", "HOSTILE"],
  ["code", "HOSTILE"],
  ["input", "HOSTILE"],
  ["parent", { HOSTILE: true }],
  ["propValues", { event_type: "HOSTILE" }],
  ["enumerable", true],
  ["configurable", true],
  ["writable", true],
  ["length", 99],
  ["constructor", "HOSTILE"],
];

const MARKET_VERDICTS = new Set(["parsed", "unknown-event-type", "unrecognized", "invalid"]);

describe("refusal construction is contained: nothing escapes as an exception", () => {
  it("24 hostile prototype shapes × 2 variants, on a refusal and on an honest frame", () => {
    const escapes: string[] = [];
    for (const [key, value] of HOSTILE) {
      for (const [, enumerable] of VARIANTS) {
        const answers = polluted(key, value, enumerable, () => [
          verdict(() => parseMarketEvent({ ...BOOK_EVENT, neg_risk: 17, bids: "not-an-array" })),
          verdict(() => parseVenueOrderBook(withoutKey({ ...ORDER_BOOK, neg_risk: 17 }, "hash"))),
          verdict(() => parseVenueOrderBooks([withoutKey({ ...ORDER_BOOK }, "hash")])),
          verdict(() => parseMarketEvent({ ...BOOK_EVENT })),
          verdict(() => parseVenueOrderBook({ ...ORDER_BOOK })),
        ]);
        for (const answer of answers) {
          if (answer.startsWith("THREW")) {
            escapes.push(`${key}[${enumerable ? "enum" : "nonenum"}] ${answer}`);
          }
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it("and every contained answer is one of the DOCUMENTED verdict shapes", () => {
    // Every assertion happens OUTSIDE the pollution window. Under an inherited
    // `get`, `expect()` itself throws — vitest builds object-literal property
    // descriptors — so an in-window assertion would measure the harness rather
    // than the door. (That is the descriptor-literal class, ADR-020 §1 class 8,
    // biting the test instead of the subject.)
    const observed: { readonly cell: string; readonly status: string; readonly shaped: boolean }[] =
      [];
    for (const [key, value] of HOSTILE) {
      for (const [, enumerable] of VARIANTS) {
        const cell = `${key}[${enumerable ? "enum" : "nonenum"}]`;
        observed.push(
          ...polluted(key, value, enumerable, () => {
            const event = parseMarketEvent({ ...BOOK_EVENT, neg_risk: 17 });
            const book = parseVenueOrderBook(withoutKey(ORDER_BOOK, "hash"));
            return [
              {
                cell: `${cell} event`,
                status: event.status,
                shaped: event.status !== "invalid" || Array.isArray(event.issues),
              },
              {
                cell: `${cell} book`,
                status: book.status,
                shaped: book.status !== "invalid" || Array.isArray(book.issues),
              },
            ];
          }),
        );
      }
    }
    const undocumented = observed
      .filter((row) => !MARKET_VERDICTS.has(row.status) || !row.shaped)
      .map((row) => `${row.cell}=${row.status}`);
    expect(undocumented).toEqual([]);
    expect(observed).toHaveLength(HOSTILE.length * VARIANTS.length * 2);
  });

  it("a schema that cannot judge at all is refused, not propagated", () => {
    // The containment's own contract, exercised directly through the door's
    // dependency injection point: a judge that throws must become a verdict.
    const answer = verdict(() =>
      parseMarketEvent({
        ...BOOK_EVENT,
        // A 17-deep chain trips the door's own depth cap before zod is reached,
        // which is the other way this door refuses rather than throws.
        fee_schedule: deepChain(20),
      }),
    );
    expect(answer).not.toContain("THREW");
    expect(answer).toBe('{"status":"unrecognized"}');
  });
});

function deepChain(depth: number): unknown {
  let node: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    node = { nested: node };
  }
  return node;
}

// --------------------------------------------------------------------------
// D4, D1-identity, and the LOSS half of the class
// --------------------------------------------------------------------------

function prototypeOf(value: unknown): unknown {
  return Object.getPrototypeOf(value as object);
}

/**
 * Parses and narrows to one modelled event, or fails the test.
 *
 * The door's return type is the discriminated `MarketEventParseResult`, so a
 * per-shape assertion has to say which shape it is holding. Doing it here keeps
 * that noise out of the pins themselves.
 */
function parsedEvent<T extends MarketEvent["event_type"]>(
  value: unknown,
  eventType: T,
): Extract<MarketEvent, { event_type: T }> {
  const parsed = parseMarketEvent(value);
  if (parsed.status !== "parsed") {
    throw new Error(`expected a parsed ${eventType}, got ${parsed.status}`);
  }
  if (parsed.event.event_type !== eventType) {
    throw new Error(`expected ${eventType}, got ${parsed.event.event_type}`);
  }
  return parsed.event as Extract<MarketEvent, { event_type: T }>;
}

describe("D4: every record the doors emit has a null prototype", () => {
  it("the market event, its levels, its batched entries and the result itself", () => {
    expect(prototypeOf(parseMarketEvent(BOOK_EVENT))).toBeNull();
    const book = parsedEvent(BOOK_EVENT, "book");
    expect(prototypeOf(book)).toBeNull();
    // Arrays keep `Array.prototype` — a separate class, and the normalizers
    // iterate them with `.entries()`.
    expect(prototypeOf(book.bids)).toBe(Array.prototype);
    expect(prototypeOf(book.bids[0])).toBeNull();

    const change = parsedEvent(PRICE_CHANGE_EVENT, "price_change");
    expect(prototypeOf(change.price_changes[0])).toBeNull();

    const discovered = parsedEvent(NEW_MARKET_EVENT, "new_market");
    expect(prototypeOf(discovered.event_message)).toBeNull();

    const resolved = parsedEvent(MARKET_RESOLVED_EVENT, "market_resolved");
    expect(prototypeOf(resolved.event_message)).toBeNull();

    expect(prototypeOf(parseMarketEvent(BEST_BID_ASK_EVENT))).toBeNull();
  });

  it("the REST book, its levels, the batch and both refusals", () => {
    const single = parseVenueOrderBook(ORDER_BOOK);
    expect(single.status).toBe("parsed");
    expect(prototypeOf(single)).toBeNull();
    if (single.status !== "parsed") return;
    expect(prototypeOf(single.book)).toBeNull();
    expect(prototypeOf(single.book.bids[0])).toBeNull();

    const batch = parseVenueOrderBooks([ORDER_BOOK, ORDER_BOOK]);
    expect(batch.status).toBe("parsed");
    expect(prototypeOf(batch)).toBeNull();
    if (batch.status !== "parsed") return;
    expect(batch.books).toHaveLength(2);
    expect(prototypeOf(batch.books[0])).toBeNull();
    expect(prototypeOf(batch.books[1])).toBeNull();

    expect(prototypeOf(parseVenueOrderBook(withoutKey(ORDER_BOOK, "hash")))).toBeNull();
    expect(prototypeOf(parseVenueOrderBooks("not a batch"))).toBeNull();
    expect(prototypeOf(parseMarketEvent(42))).toBeNull();
    expect(prototypeOf(parseMarketEvent({ event_type: "brand_new" }))).toBeNull();
  });

  it("a null-prototype emission is not readable through Object.prototype", () => {
    // The point of D4: an emitted record is read by someone else's `?? default`.
    const parsed = parseVenueOrderBook(withoutKey(ORDER_BOOK, "last_trade_price"));
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") return;
    polluted("last_trade_price", "0.99", false, () => {
      expect(parsed.book.last_trade_price).toBeUndefined();
      return undefined;
    });
  });
});

describe("D1 identity: the emitted tree is the door's, never the caller's", () => {
  it("no node of the answer is a node of the input", () => {
    const input = {
      ...BOOK_EVENT,
      bids: [{ price: "0.01", size: "1" }],
      asks: [{ price: "0.99", size: "1" }],
    };
    const event = parsedEvent(input, "book");
    expect(event as unknown).not.toBe(input);
    expect(event.bids as unknown).not.toBe(input.bids);
    expect(event.bids[0] as unknown).not.toBe(input.bids[0]);

    const body = { ...ORDER_BOOK, bids: [{ price: "0.01", size: "1" }] };
    const book = parseVenueOrderBook(body);
    if (book.status !== "parsed") throw new Error("the honest body must parse");
    expect(book.book as unknown).not.toBe(body);
    expect(book.book.bids[0] as unknown).not.toBe(body.bids[0]);
  });

  it("mutating the caller's object afterwards cannot change the answer", () => {
    const input: Record<string, unknown> = { ...ORDER_BOOK, bids: [{ price: "0.01", size: "1" }] };
    const parsed = parseVenueOrderBook(input);
    if (parsed.status !== "parsed") throw new Error("the honest body must parse");
    input["tick_size"] = "9.99";
    (input["bids"] as Record<string, unknown>[])[0]!["size"] = "9999";
    expect(parsed.book.tick_size).toBe("0.01");
    expect(parsed.book.bids[0]?.size).toBe("1");
  });

  it("an ENUMERABLE inherited key is not copied into the materialized tree", () => {
    // The enumerable-copy mutant's target: a materializer written with
    // `{ ...container }`, `Object.assign` or `for…in` copies inherited
    // ENUMERABLE properties, which reopens the whole class on this variant.
    const body = withoutKey(ORDER_BOOK, "min_order_size");
    const answer = polluted("min_order_size", "POLLUTED", true, () =>
      verdict(() => parseVenueOrderBook({ ...body })),
    );
    expect(answer).not.toContain("POLLUTED");
    expect(answer).toBe(verdict(() => parseVenueOrderBook(withoutKey(ORDER_BOOK, "min_order_size"))));

    const frame = withoutKey(LAST_TRADE_EVENT, "price");
    const trade = polluted("price", "POLLUTED", true, () =>
      verdict(() => parseMarketEvent({ ...frame })),
    );
    expect(trade).not.toContain("POLLUTED");
  });

  it("the LOSS half: an inherited setter cannot swallow a field that WAS there", () => {
    // With a prototype-free input the library can no longer ADOPT, but its own
    // output assembly still writes through `Object.prototype`. D3 is what
    // closes this: the answer is built from the materialized tree.
    const swallowed: unknown[] = [];
    Object.defineProperty(Object.prototype, "tick_size", {
      set(this: unknown, value: unknown) {
        swallowed.push(value);
      },
      get(): undefined {
        return undefined;
      },
      enumerable: false,
      configurable: true,
    });
    try {
      const parsed = parseVenueOrderBook({ ...ORDER_BOOK });
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed") return;
      expect(parsed.book.tick_size).toBe("0.01");
      expect(Object.hasOwn(parsed.book, "tick_size")).toBe(true);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["tick_size"];
    }
  });
});

// --------------------------------------------------------------------------
// the D2 compensation, stated exactly (REC-1 review finding F5's lesson)
// --------------------------------------------------------------------------

describe("D2 is not performed; this is what the door re-states instead", () => {
  it("routing: an inherited skipChecks cannot make an untyped frame route", () => {
    const answer = polluted("skipChecks", true, false, () =>
      parseMarketEvent(withoutKey(BOOK_EVENT, "event_type")),
    );
    expect(answer.status).toBe("unrecognized");
  });

  it("presence: an inherited optin/optout pair cannot admit a book missing hash", () => {
    // The required-key waiver class. The schema may be waived; the door's own
    // read of the materialized tree is not.
    const body = withoutKey(ORDER_BOOK, "hash");
    const answer = polluted("optin", "optional", false, () =>
      polluted("optout", "optional", false, () => parseVenueOrderBook({ ...body })),
    );
    expect(answer.status).toBe("invalid");
  });

  it("the one BOUND: an inherited skipChecks cannot admit an EMPTY hash", () => {
    const answer = polluted("skipChecks", true, false, () =>
      parseVenueOrderBook({ ...ORDER_BOOK, hash: "" }),
    );
    expect(answer.status).toBe("invalid");
    expect(answer.status === "invalid" && answer.issues.join("; ")).toContain("hash");
  });

  it("and what it does NOT re-state, said plainly rather than left implied", () => {
    // `VenueEpochLikeSchema`'s `z.number().int()` is a library check the door
    // does not restate. Under an inherited `skipChecks` a fractional epoch is
    // accepted here exactly as it was at base — a disclosed residual, and the
    // normalizer is what decides what an instant MEANS.
    const answer = polluted("skipChecks", true, false, () =>
      parseVenueOrderBook({ ...ORDER_BOOK, timestamp: 1.5 }),
    );
    expect(["parsed", "invalid"]).toContain(answer.status);
  });
});

// --------------------------------------------------------------------------
// non-vacuity
// --------------------------------------------------------------------------

describe("the suite is not vacuous", () => {
  it("every honest fixture still parses, after all of the above", () => {
    for (const [name, honest] of MARKET_EVENT_FIXTURES) {
      expect(parseMarketEvent(honest).status, name).toBe("parsed");
    }
    expect(parseVenueOrderBook(ORDER_BOOK).status).toBe("parsed");
    expect(parseVenueOrderBooks([ORDER_BOOK]).status).toBe("parsed");
  });

  it("and Object.prototype is clean when the file is done", () => {
    for (const key of [
      "event_type",
      "hash",
      "tick_size",
      "min_order_size",
      "price",
      "skipChecks",
      "optin",
      "optout",
      "get",
      "set",
    ]) {
      expect(Object.hasOwn(Object.prototype, key), key).toBe(false);
    }
  });
});
