/**
 * The Gamma market-state door and fetcher (`UNIV-4`, closeout blocker B10),
 * driven by the owned fixture `./fixtures/gamma-market-by-id.json` and an
 * offline HTTP double. No request leaves the process.
 *
 * What is pinned, by section:
 *
 * 1. Every fixture example is ADMITTED by the door, the six documented fields
 *    come out typed `boolean | null` (`gameStartTime`: `string | null`), and
 *    the documented readiness predicate answers per example.
 * 2. Fail-closed: an ABSENT `acceptingOrders` is `null` and not ready (the
 *    fields are nullable — absence is admitted, never refused); `closed: null`
 *    is not ready although the venue's literal JavaScript snippet would say
 *    ready; a non-boolean `active` is REFUSED; non-object bodies, unparsable
 *    JSON and a `Proxy` whose traps throw are refused WITHOUT a throw.
 * 3. Passthrough: an unknown top-level key is admitted and recorded (the
 *    venue adds properties between releases, D-19); nested values are not
 *    carried; the six documented keys are not duplicated into `recorded`;
 *    every emitted record has a null prototype and is frozen.
 * 4. `docs/contracts/schema-boundary.md` §4 item 5 — the pollution battery:
 *    under the six inherited-`toJSON` contexts and under an inherited
 *    `acceptingOrders: true` on `Object.prototype` (enumerable and
 *    non-enumerable), the door's verdict for a body WITHOUT an own
 *    `acceptingOrders` stays `null` / not ready, the verdict for a body WITH
 *    one is byte-identical to the clean verdict, no throw escapes, and the
 *    injected `toJSON` never runs on the door's path.
 * 5. The fetcher: the URL is `<base>/markets/<encoded id>`, the request is a
 *    GET with no body and no header field (the port cannot represent one),
 *    a transport failure and a non-2xx status are `PUBLIC_MARKET_STATE_UNAVAILABLE`
 *    from the whole-read layer, an undocumented body is
 *    `PUBLIC_MARKET_STATE_INVALID`, and the raw layer RETURNS a non-2xx so a
 *    recorder can journal it before judging it.
 * 6. Polymarket Protocol V2 (`V2-2`, plan row A14; acceptance 3): the V2
 *    `resolutionStatus` (`docs/venue/verified-2026-10-05.md` F-54, C-18) is
 *    recorded as the venue spells it and never interpreted. Readiness is the
 *    same with it, without it, and whatever its value. The documented V2
 *    example and the guide's resolution snippet are admitted; with no state
 *    field present they are not ready (fail closed, U-36).
 */

import {
  GAMMA_MARKET_DOCUMENTED_FIELDS,
  GammaMarketStateInvalidError,
  GammaMarketStateUnavailableError,
  fetchGammaMarket,
  gammaMarketUrl,
  isGammaMarketTradeReady,
  POLYMARKET_GAMMA_REST_BASE_URL,
  PublicMarketConfigurationError,
  readGammaMarket,
  readGammaMarketBody,
  requestGammaMarket,
  type GammaMarketState,
  type GammaMarketVerdict,
} from "@polymarket-bot/polymarket-public";
import { stubHttpClient } from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

import {
  TOJSON_CONTEXTS,
  withInheritedToJson,
} from "../../unit/ledger/inherited-tojson.js";
import { loadLocalFixture } from "./fixtures.js";

const fixture = loadLocalFixture("fixtures/gamma-market-by-id.json");

function example(name: string): unknown {
  const found = fixture.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing fixture example ${name}`);
  return found.payload;
}

/** The readiness the documented predicate answers for each example, stated once. */
const EXPECTED_READINESS: Readonly<Record<string, boolean>> = {
  "trade-ready": true,
  "not-yet-accepting-orders": false,
  closed: false,
  archived: false,
  "all-state-fields-null": false,
  "state-fields-absent": false,
  "restricted-but-trade-ready": true,
  "sports-with-game-start-time": true,
  "extra-undocumented-keys": true,
  "v2-documented-example": false,
  "v2-resolution-snippet": false,
  "v2-trade-ready-resolution-active": true,
};

function admitted(value: unknown): GammaMarketState {
  const verdict = readGammaMarket(value);
  if (verdict.status !== "ok") {
    throw new Error(`expected the door to admit the value: ${verdict.issues.join("; ")}`);
  }
  return verdict.state;
}

/** A comparable string of a verdict that never calls `JSON.stringify` (the harness protocol). */
function renderVerdict(verdict: GammaMarketVerdict): string {
  if (verdict.status === "invalid") {
    return `invalid:${verdict.issues.join("|")}`;
  }
  const state = verdict.state;
  const recorded = Object.keys(state.recorded)
    .sort()
    .map((key) => `${key}=${String(state.recorded[key])}`)
    .join(",");
  return (
    `ok:active=${String(state.active)};closed=${String(state.closed)};archived=${String(state.archived)};` +
    `acceptingOrders=${String(state.acceptingOrders)};restricted=${String(state.restricted)};` +
    `gameStartTime=${String(state.gameStartTime)};ready=${String(isGammaMarketTradeReady(state))};` +
    `recorded=[${recorded}]`
  );
}

describe("1. every fixture example is admitted, typed, and answers the documented predicate", () => {
  it("the documented field table is the six fields the venue documents, typed as documented", () => {
    expect(GAMMA_MARKET_DOCUMENTED_FIELDS.map((field) => `${field.key}:${field.type}`)).toEqual([
      "active:boolean",
      "closed:boolean",
      "acceptingOrders:boolean",
      "restricted:boolean",
      "archived:boolean",
      "gameStartTime:string",
    ]);
  });

  it("the fixture names every example the readiness table names, and nothing else", () => {
    expect(fixture.examples.map((entry) => entry.name).sort()).toEqual(
      Object.keys(EXPECTED_READINESS).sort(),
    );
    expect(fixture.retrieved).toBe("2026-09-16");
    expect(fixture.sanitized).toBe(true);
    expect(fixture.source).toBe(
      "https://docs.polymarket.com/api-reference/markets/get-market-by-id.md",
    );
  });

  it.each(fixture.examples.map((entry) => [entry.name, entry.payload] as const))(
    "%s is admitted with every documented field typed boolean | null",
    (name, payload) => {
      const state = admitted(payload);
      for (const { key, type } of GAMMA_MARKET_DOCUMENTED_FIELDS) {
        const value = state[key];
        expect(value === null || typeof value === type, key).toBe(true);
      }
      expect(isGammaMarketTradeReady(state), name).toBe(EXPECTED_READINESS[name]);
    },
  );

  it("the trade-ready example is the documented predicate's TRUE cell, field by field", () => {
    const state = admitted(example("trade-ready"));
    expect(state.active).toBe(true);
    expect(state.closed).toBe(false);
    expect(state.acceptingOrders).toBe(true);
    expect(state.restricted).toBe(false);
    expect(state.archived).toBe(false);
    expect(state.gameStartTime).toBeNull();
  });

  it("`restricted` is recorded, not acted on: a restricted market with an open book is ready", () => {
    const state = admitted(example("restricted-but-trade-ready"));
    expect(state.restricted).toBe(true);
    expect(isGammaMarketTradeReady(state)).toBe(true);
  });

  it("`gameStartTime` is carried verbatim as a string", () => {
    expect(admitted(example("sports-with-game-start-time")).gameStartTime).toBe(
      "2026-10-01T18:00:00Z",
    );
  });

  it("a body read as UTF-8 text goes through the same door", () => {
    const verdict = readGammaMarketBody(JSON.stringify(example("trade-ready")));
    expect(verdict.status).toBe("ok");
  });
});

describe("2. fail-closed", () => {
  it("an ABSENT acceptingOrders is admitted as null, and the predicate is FALSE", () => {
    const body = { ...(example("trade-ready") as Record<string, unknown>) };
    delete body["acceptingOrders"];
    const state = admitted(body);
    expect(state.acceptingOrders).toBeNull();
    expect(state.active).toBe(true);
    expect(state.closed).toBe(false);
    expect(isGammaMarketTradeReady(state)).toBe(false);
  });

  it("every documented field absent (the fixture's state-fields-absent) is null, not refused", () => {
    const state = admitted(example("state-fields-absent"));
    for (const { key } of GAMMA_MARKET_DOCUMENTED_FIELDS) {
      expect(state[key], key).toBeNull();
    }
    expect(isGammaMarketTradeReady(state)).toBe(false);
  });

  it("closed: null is NOT ready, although the venue's literal snippet would say it is", () => {
    const body: Record<string, unknown> = {
      ...(example("trade-ready") as Record<string, unknown>),
      closed: null,
    };
    const state = admitted(body);
    // The literal documented expression, evaluated as JavaScript on this body:
    const literal = Boolean(body["active"] && !body["closed"] && body["acceptingOrders"]);
    expect(literal).toBe(true);
    // The door is stricter, by design and by header.
    expect(isGammaMarketTradeReady(state)).toBe(false);
  });

  it.each([
    ["the string 'true'", "true"],
    ["the number 1", 1],
    ["an object", { value: true }],
    ["an array", [true]],
  ])("a non-boolean active (%s) is REFUSED", (_label, value) => {
    const body = { ...(example("trade-ready") as Record<string, unknown>), active: value };
    const verdict = readGammaMarket(body);
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.issues.some((issue) => issue.startsWith("active:"))).toBe(true);
    }
  });

  it("a non-boolean closed / acceptingOrders / restricted / archived is refused too", () => {
    for (const field of ["closed", "acceptingOrders", "restricted", "archived"] as const) {
      const body = { ...(example("trade-ready") as Record<string, unknown>), [field]: "no" };
      expect(readGammaMarket(body).status, field).toBe("invalid");
    }
  });

  it("a non-string gameStartTime is refused", () => {
    const body = { ...(example("trade-ready") as Record<string, unknown>), gameStartTime: 1_760_000_000 };
    expect(readGammaMarket(body).status).toBe("invalid");
  });

  it.each([
    ["an array", [example("trade-ready")]],
    ["null", null],
    ["a string", "active"],
    ["a number", 1],
    ["undefined", undefined],
  ])("a non-object body (%s) is refused, not thrown", (_label, value) => {
    const verdict = readGammaMarket(value);
    expect(verdict.status).toBe("invalid");
  });

  it("unparsable JSON is refused, not thrown", () => {
    const verdict = readGammaMarketBody("{ not json");
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.issues[0]).toContain("not JSON");
    }
  });

  it("a Proxy whose traps THROW is refused, and the throw does not escape (the instanceof-classifier mutant)", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile getPrototypeOf");
        },
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor");
        },
      },
    );
    let verdict: GammaMarketVerdict | undefined;
    expect(() => {
      verdict = readGammaMarket(hostile);
    }).not.toThrow();
    expect(verdict?.status).toBe("invalid");

    // The same hostility one level down, on a documented field's container.
    const nested = { ...(example("trade-ready") as Record<string, unknown>), events: hostile };
    expect(() => {
      verdict = readGammaMarket(nested);
    }).not.toThrow();
    expect(verdict?.status).toBe("invalid");
  });

  it("an accessor property on a documented field is refused without being invoked", () => {
    let reads = 0;
    const body = { ...(example("trade-ready") as Record<string, unknown>) };
    Object.defineProperty(body, "acceptingOrders", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return true;
      },
    });
    expect(readGammaMarket(body).status).toBe("invalid");
    expect(reads).toBe(0);
  });
});

describe("3. top-level passthrough and the recorded scalars", () => {
  it("an unknown top-level key is admitted and lands in `recorded`", () => {
    const state = admitted(example("extra-undocumented-keys"));
    expect(state.recorded["version"]).toBe("v2");
    expect(state.recorded["comboStatus"]).toBe("enabled");
    expect(state.recorded["umaResolutionStatus"]).toBeNull();
    expect(isGammaMarketTradeReady(state)).toBe(true);
  });

  it("the name-only documented properties are recorded as the venue spelled them", () => {
    const state = admitted(example("closed"));
    expect(state.recorded["closedTime"]).toBe("2026-09-15T00:03:12Z");
    expect(state.recorded["endDate"]).toBe("2026-09-15T00:00:00Z");
    expect(state.recorded["enableOrderBook"]).toBe(true);
    expect(state.recorded["negRisk"]).toBe(false);
  });

  it("the six documented keys are not duplicated into `recorded`", () => {
    const state = admitted(example("trade-ready"));
    for (const { key } of GAMMA_MARKET_DOCUMENTED_FIELDS) {
      expect(Object.hasOwn(state.recorded, key), key).toBe(false);
    }
  });

  it("nested values are not carried: they live in the journaled raw body", () => {
    const body = {
      ...(example("trade-ready") as Record<string, unknown>),
      clobTokenIds: ["1", "2"],
      events: [{ id: "e1" }],
      feeSchedule: { rate: "0.01" },
    };
    const state = admitted(body);
    expect(Object.hasOwn(state.recorded, "clobTokenIds")).toBe(false);
    expect(Object.hasOwn(state.recorded, "events")).toBe(false);
    expect(Object.hasOwn(state.recorded, "feeSchedule")).toBe(false);
    expect(state.recorded["conditionId"]).toBe(
      (example("trade-ready") as Record<string, unknown>)["conditionId"],
    );
  });

  it("every emitted record has a null prototype and is frozen (D4)", () => {
    const verdict = readGammaMarket(example("trade-ready"));
    expect(Object.getPrototypeOf(verdict)).toBeNull();
    expect(Object.isFrozen(verdict)).toBe(true);
    if (verdict.status !== "ok") throw new Error("unreachable");
    expect(Object.getPrototypeOf(verdict.state)).toBeNull();
    expect(Object.isFrozen(verdict.state)).toBe(true);
    expect(Object.getPrototypeOf(verdict.state.recorded)).toBeNull();
    expect(Object.isFrozen(verdict.state.recorded)).toBe(true);
    const refused = readGammaMarket(null);
    expect(Object.getPrototypeOf(refused)).toBeNull();
    expect(Object.isFrozen(refused)).toBe(true);
  });

  it("the input is not the output: the door's records are its own", () => {
    const body = example("trade-ready") as Record<string, unknown>;
    const state = admitted(body);
    expect(state.recorded).not.toBe(body);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });
});

describe("4. schema-boundary §4 item 5 — the pollution battery", () => {
  const withOwnAccepting = example("trade-ready") as Record<string, unknown>;
  const withoutOwnAccepting = ((): Record<string, unknown> => {
    const copy = { ...withOwnAccepting };
    delete copy["acceptingOrders"];
    return copy;
  })();

  function withInheritedAcceptingOrders<T>(enumerable: boolean, run: () => T): T {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "acceptingOrders");
    if (enumerable) {
      (Object.prototype as { acceptingOrders?: unknown }).acceptingOrders = true;
    } else {
      const descriptor = Object.create(null) as PropertyDescriptor;
      descriptor.value = true;
      descriptor.enumerable = false;
      descriptor.writable = true;
      descriptor.configurable = true;
      Object.defineProperty(Object.prototype, "acceptingOrders", descriptor);
    }
    try {
      return run();
    } finally {
      Reflect.deleteProperty(Object.prototype, "acceptingOrders");
      if (previous !== undefined) {
        Object.defineProperty(Object.prototype, "acceptingOrders", previous);
      }
    }
  }

  const cleanWith = renderVerdict(readGammaMarket(withOwnAccepting));
  const cleanWithout = renderVerdict(readGammaMarket(withoutOwnAccepting));

  it("the clean verdicts are the expected ones (non-vacuity)", () => {
    expect(cleanWith).toContain("acceptingOrders=true;");
    expect(cleanWith).toContain("ready=true;");
    expect(cleanWithout).toContain("acceptingOrders=null;");
    expect(cleanWithout).toContain("ready=false;");
  });

  it.each([true, false])(
    "an inherited acceptingOrders: true on Object.prototype (enumerable=%s) is never read: absent stays null",
    (enumerable) => {
      readGammaMarket(withOwnAccepting); // warm
      const polluted = withInheritedAcceptingOrders(enumerable, () => ({
        withOwn: renderVerdict(readGammaMarket(withOwnAccepting)),
        withoutOwn: renderVerdict(readGammaMarket(withoutOwnAccepting)),
        fromText: renderVerdict(readGammaMarketBody(JSON.stringify(withoutOwnAccepting))),
      }));
      expect(polluted.withOwn).toBe(cleanWith);
      expect(polluted.withoutOwn).toBe(cleanWithout);
      expect(polluted.fromText).toBe(cleanWithout);
    },
  );

  it.each(TOJSON_CONTEXTS.map((context) => [context.name, context] as const))(
    "under an inherited toJSON (%s) the verdicts are byte-identical, nothing throws, and the hook never runs",
    (_name, context) => {
      const run = withInheritedToJson(context, () => ({
        withOwn: renderVerdict(readGammaMarket(withOwnAccepting)),
        withoutOwn: renderVerdict(readGammaMarket(withoutOwnAccepting)),
        refused: renderVerdict(readGammaMarket({ ...withOwnAccepting, active: "yes" })),
      }));
      expect(run.result.withOwn).toBe(cleanWith);
      expect(run.result.withoutOwn).toBe(cleanWithout);
      expect(run.result.refused.startsWith("invalid:active:")).toBe(true);
      expect(run.calls).toBe(0);
    },
  );

  it("both pollutions at once, in every toJSON context: the bound holds", () => {
    for (const context of TOJSON_CONTEXTS) {
      for (const enumerable of [true, false]) {
        const run = withInheritedToJson(context, () =>
          withInheritedAcceptingOrders(enumerable, () =>
            renderVerdict(readGammaMarket(withoutOwnAccepting)),
          ),
        );
        expect(run.result, `${context.name}/enumerable=${String(enumerable)}`).toBe(cleanWithout);
        expect(run.calls).toBe(0);
      }
    }
  });
});

describe("5. the fetcher", () => {
  it("builds `<base>/markets/<encoded id>` from the documented origin by default", () => {
    expect(gammaMarketUrl("900001")).toBe(`${POLYMARKET_GAMMA_REST_BASE_URL}/markets/900001`);
    expect(gammaMarketUrl("a/b c", "http://127.0.0.1:1/")).toBe(
      "http://127.0.0.1:1/markets/a%2Fb%20c",
    );
    expect(() => gammaMarketUrl("")).toThrow(PublicMarketConfigurationError);
    expect(() => gammaMarketUrl("1", "/")).toThrow(PublicMarketConfigurationError);
  });

  it("issues a GET with no body; the port has no header field, so none can be sent", async () => {
    const http = stubHttpClient(() => ({ status: 200, body: JSON.stringify(example("trade-ready")) }));
    const read = await fetchGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" });
    expect(read.url).toBe("http://stub/markets/900001");
    expect(isGammaMarketTradeReady(read.state)).toBe(true);
    expect(http.exchanges).toHaveLength(1);
    const request = http.exchanges[0]?.request;
    expect(request?.method).toBe("GET");
    expect(request?.jsonBody).toBeUndefined();
    expect(Object.keys(request ?? {}).sort()).toEqual(["method", "url"]);
  });

  it("a transport failure is PUBLIC_MARKET_STATE_UNAVAILABLE with the cause attached", async () => {
    const http = stubHttpClient(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      requestGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" }),
    ).rejects.toBeInstanceOf(GammaMarketStateUnavailableError);
    await expect(
      fetchGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" }),
    ).rejects.toMatchObject({ code: "PUBLIC_MARKET_STATE_UNAVAILABLE" });
  });

  it("the raw layer RETURNS a non-2xx with its body; the whole-read layer throws on it", async () => {
    const http = stubHttpClient(() => ({ status: 503, body: '{"error":"maintenance"}' }));
    const raw = await requestGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" });
    expect(raw.status).toBe(503);
    expect(raw.bodyUtf8).toBe('{"error":"maintenance"}');
    await expect(
      fetchGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" }),
    ).rejects.toMatchObject({ code: "PUBLIC_MARKET_STATE_UNAVAILABLE", details: { status: 503 } });
  });

  it("an undocumented body is PUBLIC_MARKET_STATE_INVALID with the door's issues", async () => {
    const http = stubHttpClient(() => ({ status: 200, body: '{"active":"true"}' }));
    await expect(
      fetchGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" }),
    ).rejects.toBeInstanceOf(GammaMarketStateInvalidError);
    const notJson = stubHttpClient(() => ({ status: 200, body: "<html>" }));
    await expect(
      fetchGammaMarket({ http: notJson.client, marketId: "900001", baseUrl: "http://stub" }),
    ).rejects.toMatchObject({ code: "PUBLIC_MARKET_STATE_INVALID" });
  });

  it("exactly one request per call, never a retry", async () => {
    const http = stubHttpClient(() => ({ status: 500, body: "" }));
    await requestGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" });
    await fetchGammaMarket({ http: http.client, marketId: "900001", baseUrl: "http://stub" }).catch(
      () => undefined,
    );
    expect(http.exchanges).toHaveLength(2);
  });
});

describe("6. Protocol V2: resolutionStatus is recorded, never interpreted (A14; F-54, C-18)", () => {
  const V2_BODY = example("v2-trade-ready-resolution-active") as Record<string, unknown>;

  /** Everything the door derives from a body, apart from the recorded scalars. */
  function interpreted(state: GammaMarketState): string {
    return (
      `active=${String(state.active)};closed=${String(state.closed)};archived=${String(state.archived)};` +
      `acceptingOrders=${String(state.acceptingOrders)};restricted=${String(state.restricted)};` +
      `gameStartTime=${String(state.gameStartTime)};ready=${String(isGammaMarketTradeReady(state))}`
    );
  }

  function withoutResolutionStatus(): Record<string, unknown> {
    const copy = { ...V2_BODY };
    delete copy["resolutionStatus"];
    return copy;
  }

  it("the synthetic V2 body is the trade-ready example plus the V2 fields, and nothing else", () => {
    const base = example("trade-ready") as Record<string, unknown>;
    const added = Object.keys(V2_BODY).filter((key) => !Object.hasOwn(base, key)).sort();
    expect(added).toEqual(["clobTokenIds", "positionIds", "resolutionStatus", "version"]);
    for (const { key } of GAMMA_MARKET_DOCUMENTED_FIELDS) expect(V2_BODY[key], key).toEqual(base[key]);
  });

  it("records resolutionStatus and version exactly as the venue spelled them", () => {
    const state = admitted(V2_BODY);
    expect(state.recorded["resolutionStatus"]).toBe("active");
    expect(state.recorded["version"]).toBe("v2");
    expect(state.recorded["clobTokenIds"]).toBeNull();
  });

  it.each([
    ["inactive"],
    ["active"],
    ["resolved"],
    // A value the guide does not list (F-54) is recorded too: the door records, it does not judge.
    ["disputed"],
    [""],
    [null],
  ] as const)("resolutionStatus %j is recorded and moves nothing the door derives", (value) => {
    const state = admitted({ ...V2_BODY, resolutionStatus: value });
    expect(Object.hasOwn(state.recorded, "resolutionStatus")).toBe(true);
    expect(state.recorded["resolutionStatus"]).toBe(value);
    expect(interpreted(state)).toBe(interpreted(admitted(withoutResolutionStatus())));
    expect(isGammaMarketTradeReady(state)).toBe(true);
  });

  it("a 'resolved' status does not make an open order book unready: lifecycle reads the three documented fields only", () => {
    const resolved = admitted({ ...V2_BODY, resolutionStatus: "resolved" });
    expect(isGammaMarketTradeReady(resolved)).toBe(true);
    // ...and an 'active' status does not make a closed market ready.
    const closed = admitted({ ...V2_BODY, closed: true, acceptingOrders: false, resolutionStatus: "active" });
    expect(isGammaMarketTradeReady(closed)).toBe(false);
  });

  it("without resolutionStatus the verdict is the same apart from the recorded key", () => {
    const withIt = admitted(V2_BODY);
    const withoutIt = admitted(withoutResolutionStatus());
    expect(interpreted(withIt)).toBe(interpreted(withoutIt));
    expect(Object.keys(withIt.recorded).filter((key) => !Object.hasOwn(withoutIt.recorded, key))).toEqual([
      "resolutionStatus",
    ]);
  });

  it("the documented V2 example is admitted; positionIds, an array, is not carried; with no state field it is not ready (U-36)", () => {
    const state = admitted(example("v2-documented-example"));
    expect(state.recorded["version"]).toBe("v2");
    expect(state.recorded["clobTokenIds"]).toBeNull();
    expect(Object.hasOwn(state.recorded, "positionIds")).toBe(false);
    for (const { key } of GAMMA_MARKET_DOCUMENTED_FIELDS) expect(state[key], key).toBeNull();
    expect(isGammaMarketTradeReady(state)).toBe(false);
  });

  it("the guide's resolution snippet is admitted and recorded, and asserts no readiness", () => {
    const state = admitted(example("v2-resolution-snippet"));
    expect(state.recorded["resolutionStatus"]).toBe("resolved");
    expect(state.recorded["version"]).toBe("v2");
    expect(isGammaMarketTradeReady(state)).toBe(false);
  });

  it("a resolutionStatus that is not a scalar is not carried, like every nested value: the raw body is journaled", () => {
    const state = admitted({ ...V2_BODY, resolutionStatus: { status: "resolved" } });
    expect(Object.hasOwn(state.recorded, "resolutionStatus")).toBe(false);
    expect(isGammaMarketTradeReady(state)).toBe(true);
  });

  it("the documented field table is unchanged: V2 adds no interpreted field", () => {
    expect(GAMMA_MARKET_DOCUMENTED_FIELDS.map((field) => field.key)).not.toContain("resolutionStatus");
    expect(GAMMA_MARKET_DOCUMENTED_FIELDS).toHaveLength(6);
  });
});
