/**
 * WP-280 acceptance 1: "MATCHED/MINED/CONFIRMED/RETRYING/FAILED fixtures
 * parse" — and every other user-channel fixture too.
 *
 * The suite enumerates `test/fixtures/venue/user-ws/` itself. EVERY example of
 * EVERY file must have an expectation below; a new file or example without
 * one fails the suite (no fixture is silently skipped). Each example is:
 *
 * 1. normalized from its parsed payload and from its JSON text frame, with
 *    every identifier carried exactly and every amount exact;
 * 2. delivered as a frame through the subscription manager over a fake
 *    socket port, which must emit the normalized event, its OMS projection,
 *    and no reconciliation request for a fully applicable event;
 * 3. redacted: no output, and no `redactUserStreamPayload` copy (of the parsed
 *    payload or of its text frame), carries the fixtures' API-key owner
 *    placeholder.
 *
 * C-3: each trade-status lexeme of the REST fixture `orders/rest-trades.json`
 * is grafted onto a user-channel trade: the prefixed spellings of verified
 * statuses are recognised (ADR-002), and `TRADE_STATUS_MATCHED_NOT_BROADCASTED`
 * is surfaced as UNRECOGNIZED with its C-3 reason and requests reconciliation.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import {
  normalizeUserChannelFrame,
  normalizeUserChannelMessage,
  redactUserStreamPayload,
  USER_ORDER_STATUSES,
  USER_TRADE_STATUSES,
  ORDER_LIFECYCLE_TYPES,
  type UserChannelMessage,
  type UserStreamOutput,
} from "../../../packages/polymarket-secure/src/user-stream/index.js";
import { FIXTURE_MARKET, FIXTURE_OWNER, openUserStream } from "../../../packages/polymarket-secure/src/user-stream/testing/harness.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/venue/user-ws");
const REST_TRADES = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/venue/orders/rest-trades.json");

const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";
const id = (suffix: string): string => `0x${"0".repeat(56)}${suffix}`;

interface FixtureFile {
  readonly fixture: string;
  readonly examples: readonly { readonly name: string; readonly payload: Record<string, unknown> }[];
}

interface Expectation {
  /** The normalized message (subset). */
  readonly message: Record<string, unknown>;
  /** The OMS projection, exactly. */
  readonly oms: { readonly shortfalls: readonly string[] } & Readonly<Record<string, unknown>>;
}

const ORDER = (venueOrderId: string, lifecycle: string, status: string, side: string, originalSize: string, sizeMatched: string, price: string, ts: string): Expectation => ({
  message: {
    kind: "ORDER",
    event: {
      venueOrderId,
      market: FIXTURE_MARKET,
      assetId: ASSET,
      side,
      lifecycle: { kind: "KNOWN", value: lifecycle },
      status: { kind: "KNOWN", value: status },
      originalSize,
      sizeMatched,
      price,
      venueTimestamp: { wire: ts, iso: new Date(Number(ts)).toISOString() },
    },
  },
  oms: { observation: { venueOrderId, status }, shortfalls: [] },
});

const TAKER = id("feed0004");
const T1 = "00000000-0000-0000-0000-00000000t001";
const T2 = "00000000-0000-0000-0000-00000000t002";
const MAKER_LEG = id("feed0007");
const C0FFEE = `0x${"0".repeat(58)}c0ffee`;

const settlement = (venueTradeId: string, venueOrderId: string, status: string, transactionHash: string | null, ts: string) => ({
  venueTradeId,
  venueOrderId,
  status,
  transactionHash,
  observedAt: new Date(Number(ts)).toISOString(),
});

/** Every example of every user-ws fixture file, keyed `<fixture>/<name>`. */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  "user-ws/order-lifecycle/placement-live": ORDER(id("feed0001"), "PLACEMENT", "LIVE", "BUY", "100", "0", "0.08", "1782753357257"),
  "user-ws/order-lifecycle/update-partially-matched": ORDER(id("feed0001"), "UPDATE", "MATCHED", "BUY", "100", "40", "0.08", "1782753360000"),
  "user-ws/order-lifecycle/placement-delayed": ORDER(id("feed0002"), "PLACEMENT", "DELAYED", "SELL", "50", "0", "0.09", "1782753361000"),
  "user-ws/order-lifecycle/placement-unmatched": ORDER(id("feed0003"), "PLACEMENT", "UNMATCHED", "SELL", "50", "0", "0.09", "1782753362000"),
  "user-ws/order-lifecycle/cancellation": ORDER(id("feed0001"), "CANCELLATION", "CANCELED", "BUY", "100", "40", "0.08", "1782753365000"),
  "user-ws/trade-settlement/matched": {
    message: {
      kind: "TRADE",
      event: {
        venueTradeId: T1,
        takerOrderId: TAKER,
        market: FIXTURE_MARKET,
        assetId: ASSET,
        side: "BUY",
        size: "40",
        price: "0.08",
        feeRateBps: "0",
        status: { kind: "KNOWN", value: "MATCHED" },
        matchedAt: { wire: "1782753360", iso: "2026-06-29T17:16:00.000Z" },
        transactionHash: null,
        traderSide: { kind: "KNOWN", value: "TAKER" },
        makerOrders: [{ venueOrderId: id("feed0005"), assetId: ASSET, side: "SELL", matchedAmount: "40", price: "0.08", feeRateBps: "0", account: "OWN" }],
      },
    },
    oms: {
      fills: [
        {
          venueTradeId: T1,
          venueOrderId: TAKER,
          shares: "40",
          price: "0.08",
          liquidityRole: "TAKER",
          feeAmount: "0",
          feeAssetId: null,
          matchedAt: "2026-06-29T17:16:00.000Z",
        },
      ],
      settlements: [settlement(T1, TAKER, "MATCHED", null, "1782753360000")],
      // The fixture's maker leg carries the same placeholder owner as the account: the
      // same-account case the projection never judges.
      shortfalls: ["OWN_MAKER_LEG_ON_TAKER_TRADE"],
    },
  },
  "user-ws/trade-settlement/mined": {
    message: { kind: "TRADE", event: { venueTradeId: T1, takerOrderId: TAKER, status: { kind: "KNOWN", value: "MINED" }, transactionHash: C0FFEE, matchedAt: null, feeRateBps: null } },
    oms: { fills: [], settlements: [settlement(T1, TAKER, "MINED", C0FFEE, "1782753362000")], shortfalls: ["OWN_MAKER_LEG_ON_TAKER_TRADE"] },
  },
  "user-ws/trade-settlement/confirmed-terminal": {
    message: { kind: "TRADE", event: { venueTradeId: T1, status: { kind: "KNOWN", value: "CONFIRMED" }, transactionHash: C0FFEE } },
    oms: { fills: [], settlements: [settlement(T1, TAKER, "CONFIRMED", C0FFEE, "1782753370000")], shortfalls: ["OWN_MAKER_LEG_ON_TAKER_TRADE"] },
  },
  "user-ws/trade-settlement/retrying": {
    message: {
      kind: "TRADE",
      event: { venueTradeId: T2, takerOrderId: id("feed0006"), side: "SELL", size: "10", price: "0.09", status: { kind: "KNOWN", value: "RETRYING" }, traderSide: { kind: "KNOWN", value: "MAKER" } },
    },
    oms: { fills: [], settlements: [settlement(T2, MAKER_LEG, "RETRYING", null, "1782753380000")], shortfalls: [] },
  },
  "user-ws/trade-settlement/failed-terminal": {
    message: { kind: "TRADE", event: { venueTradeId: T2, status: { kind: "KNOWN", value: "FAILED" }, traderSide: { kind: "KNOWN", value: "MAKER" } } },
    oms: { fills: [], settlements: [settlement(T2, MAKER_LEG, "FAILED", null, "1782753395000")], shortfalls: [] },
  },
};

async function loadFixtures(): Promise<FixtureFile[]> {
  const files = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8")) as FixtureFile));
}

const OPTIONS = { isAccountOwner: (owner: string) => owner === FIXTURE_OWNER };

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

describe("every user-ws fixture example parses into a normalized event (acceptance 1)", () => {
  it("every example of every file has an expectation, and every expectation an example", async () => {
    const keys = (await loadFixtures()).flatMap((file) => file.examples.map((example) => `${file.fixture}/${example.name}`));
    expect(keys.length).toBe(10);
    expect([...keys].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("each example normalizes, from its payload and from its JSON frame, to the expected event", async () => {
    for (const file of await loadFixtures()) {
      for (const example of file.examples) {
        const key = `${file.fixture}/${example.name}`;
        const expected = EXPECTED[key];
        if (expected === undefined) throw new Error(`no expectation for ${key}`);
        const message = normalizeUserChannelMessage(example.payload, OPTIONS);
        expect(message, key).toMatchObject(expected.message);
        expect(normalizeUserChannelFrame(JSON.stringify(example.payload), OPTIONS), key).toEqual([message]);
      }
    }
  });

  it("the fixtures cover all five trade statuses, all five order statuses and all three lifecycle types", async () => {
    const seen = { trade: new Set<string>(), order: new Set<string>(), lifecycle: new Set<string>() };
    for (const file of await loadFixtures()) {
      for (const example of file.examples) {
        const message: UserChannelMessage = normalizeUserChannelMessage(example.payload, OPTIONS);
        if (message.kind === "TRADE" && message.event.status.kind === "KNOWN") seen.trade.add(message.event.status.value);
        if (message.kind === "ORDER" && message.event.status.kind === "KNOWN") seen.order.add(message.event.status.value);
        if (message.kind === "ORDER" && message.event.lifecycle.kind === "KNOWN") seen.lifecycle.add(message.event.lifecycle.value);
      }
    }
    expect([...seen.trade].sort()).toEqual([...USER_TRADE_STATUSES].sort());
    expect([...seen.order].sort()).toEqual([...USER_ORDER_STATUSES].sort());
    expect([...seen.lifecycle].sort()).toEqual([...ORDER_LIFECYCLE_TYPES].sort());
  });

  it("through the subscription manager: each frame yields its event and exact OMS projection; shortfalls, and only they, request reconciliation", async () => {
    const h = openUserStream();
    h.subscribe();
    for (const file of await loadFixtures()) {
      for (const example of file.examples) {
        const key = `${file.fixture}/${example.name}`;
        const expected = EXPECTED[key];
        if (expected === undefined) throw new Error(`no expectation for ${key}`);
        const before = h.outputs.length;
        h.port.latest.deliver(JSON.stringify(example.payload));
        const produced: UserStreamOutput[] = h.outputs.slice(before);
        const event = produced[0];
        expect(event, key).toMatchObject({ ...expected.message, oms: expected.oms });
        const shortfalls = expected.oms.shortfalls;
        expect(produced.slice(1).map((output) => output.kind), key).toEqual(shortfalls.length > 0 ? ["RECONCILIATION_REQUESTED"] : []);
      }
    }
    expect(h.manager.state()).toBe("SUBSCRIBED");
  });

  it("no output and no redacted payload carries the fixtures' API-key owner placeholder", async () => {
    const h = openUserStream();
    h.subscribe();
    for (const file of await loadFixtures()) {
      for (const example of file.examples) {
        expect(JSON.stringify(example.payload)).toContain(FIXTURE_OWNER); // the detector can see it
        h.port.latest.deliver(JSON.stringify(example.payload));
        expect(JSON.stringify(redactUserStreamPayload(example.payload))).not.toContain(FIXTURE_OWNER);
        // r1 F-02: the raw TEXT frame too (a WebSocket payload is text).
        expect(String(redactUserStreamPayload(JSON.stringify(example.payload)))).not.toContain(FIXTURE_OWNER);
      }
    }
    expect(JSON.stringify(h.outputs)).not.toContain(FIXTURE_OWNER);
  });
});

describe("C-3 and the two status spellings, tied to the REST fixture", () => {
  it("prefixed verified statuses are recognised; TRADE_STATUS_MATCHED_NOT_BROADCASTED is UNRECOGNIZED (C-3) and requests reconciliation", async () => {
    const rest = JSON.parse(await readFile(REST_TRADES, "utf8")) as FixtureFile;
    const lexemes = rest.examples.map((example) => example.payload["status"] as string);
    expect(lexemes).toContain("TRADE_STATUS_MATCHED_NOT_BROADCASTED");
    const matched = (await loadFixtures()).flatMap((file) => file.examples).find((example) => example.name === "matched");
    if (matched === undefined) throw new Error("matched example missing");
    const h = openUserStream();
    h.subscribe();
    for (const status of lexemes) {
      const message = normalizeUserChannelMessage({ ...matched.payload, status }, OPTIONS);
      if (message.kind !== "TRADE") throw new Error(message.kind);
      if (status === "TRADE_STATUS_MATCHED_NOT_BROADCASTED") {
        expect(message.event.status).toEqual({ kind: "UNRECOGNIZED", lexeme: status, reason: "C3_REST_ONLY_STATUS_ON_STREAM" });
        const before = h.outputs.length;
        h.port.latest.deliver(JSON.stringify({ ...matched.payload, status }));
        const produced = h.outputs.slice(before);
        expect(produced[0]).toMatchObject({ kind: "TRADE", oms: { fills: [], settlements: [] } });
        expect(produced[1]).toMatchObject({ kind: "RECONCILIATION_REQUESTED", request: { cause: "EVENT_NOT_FULLY_APPLICABLE", venueTradeId: T1 } });
        expect((produced[1] as { request: { shortfalls: readonly string[] } }).request.shortfalls).toContain("TRADE_STATUS_C3");
      } else {
        expect(message.event.status).toEqual({ kind: "KNOWN", value: status.slice("TRADE_STATUS_".length) });
      }
    }
  });
});
