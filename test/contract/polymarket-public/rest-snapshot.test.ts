/**
 * The REST snapshot path, driven by fixtures and an offline HTTP double.
 *
 * The fixture here is owned by this work package
 * (`./fixtures/clob-book-rest.json`) rather than by the frozen `WP-000`
 * catalogue, because `WP-000` froze no order-book REST examples. Its provenance
 * envelope follows the same rules: source URL, retrieval date, sanitized,
 * and a note recording exactly which published forms it freezes and why.
 *
 * No request leaves the process: the HTTP port is a stub.
 */

import {
  PublicBookSnapshotFetcher,
  parseVenueOrderBook,
  parseVenueOrderBooks,
} from "@polymarket-bot/polymarket-public";
import {
  staticMarketDirectory,
  stubHttpClient,
  type TestMarketDefinition,
} from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

import { loadLocalFixture } from "./fixtures.js";

const YES: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000001",
  conditionId: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  yesTokenId:
    "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  noTokenId:
    "7305630249804085635496399869905769372294302716159034447326228509068694952392",
};

const fixture = loadLocalFixture("fixtures/clob-book-rest.json");

function example(name: string): unknown {
  const found = fixture.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing fixture example ${name}`);
  return found.payload;
}

function fetcher(body: unknown) {
  const http = stubHttpClient(() => ({ status: 200, body: JSON.stringify(body) }));
  return {
    http,
    subject: new PublicBookSnapshotFetcher({
      http: http.client,
      directory: staticMarketDirectory({ known: [YES] }),
    }),
  };
}

describe("every order-book fixture parses", () => {
  it.each(
    fixture.examples
      .filter((entry) => entry.name !== "batch-books")
      .map((entry) => [entry.name, entry.payload] as const),
  )("%s parses as a single book", (_name, payload) => {
    expect(parseVenueOrderBook(payload).status).toBe("parsed");
  });

  it("the batch example parses as a list of books", () => {
    const parsed = parseVenueOrderBooks(example("batch-books"));
    expect(parsed.status).toBe("parsed");
    if (parsed.status === "parsed") expect(parsed.books).toHaveLength(2);
  });

  it("accepts both published hash forms, pinning neither", () => {
    expect(parseVenueOrderBook(example("single-book-40-char-hash")).status).toBe("parsed");
    expect(parseVenueOrderBook(example("single-book-64-char-hash")).status).toBe("parsed");
  });
});

describe("normalization into BookSnapshot", () => {
  it("reorders the venue's ascending bids and descending asks", async () => {
    // "Bids are ordered by ascending price and asks by descending price, so the
    // best bid and ask are the last entries" — the domain contract wants the
    // opposite, so the order is imposed rather than trusted.
    const { subject } = fetcher(example("single-book-40-char-hash"));
    const { events, problems } = await subject.fetchSnapshot(YES.yesTokenId);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({
      bids: [
        { price: "0.03", size: "208169.44" },
        { price: "0.02", size: "139963.89" },
        { price: "0.01", size: "2151131.59" },
      ],
      asks: [
        { price: "0.97", size: "4338.7" },
        { price: "0.98", size: "13229.55" },
        { price: "0.99", size: "218442.27" },
      ],
    });
  });

  it("records the REST channel on the provenance, so the surface is auditable", async () => {
    const { subject } = fetcher(example("single-book-40-char-hash"));
    const { events } = await subject.fetchSnapshot(YES.yesTokenId);
    expect(events[0]?.provenance).toMatchObject({
      source: "polymarket",
      sourceChannel: "polymarket:clob-book-rest",
    });
    expect(events[0]?.provenance).not.toHaveProperty("connectionId");
  });

  it("maps a null or empty optional to ABSENT and still produces a snapshot", async () => {
    const { subject } = fetcher(example("single-book-empty-optionals"));
    const { events, problems } = await subject.fetchSnapshot(YES.yesTokenId);
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toEqual({
      internalMarketId: YES.internalMarketId,
      tokenId: YES.yesTokenId,
      bids: [],
      asks: [],
    });
  });

  it("produces the same payload shape as the WebSocket book path", async () => {
    const { subject } = fetcher(example("single-book-40-char-hash"));
    const { events } = await subject.fetchSnapshot(YES.yesTokenId);
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      "asks",
      "bids",
      "internalMarketId",
      "tokenId",
      "venueBookHash",
    ]);
  });
});

describe("the batch endpoint", () => {
  it("sends the documented request body", async () => {
    const { http, subject } = fetcher(example("batch-books"));
    const { events, problems } = await subject.fetchSnapshots([YES.yesTokenId, YES.noTokenId]);

    expect(http.exchanges[0]?.request).toMatchObject({
      method: "POST",
      url: "https://clob.polymarket.com/books",
      jsonBody: [{ token_id: YES.yesTokenId }, { token_id: YES.noTokenId }],
    });
    expect(problems).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event.payload as { tokenId: string }).tokenId)).toEqual([
      YES.yesTokenId,
      YES.noTokenId,
    ]);
  });
});
