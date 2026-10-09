/**
 * `TRDR-3` — the trader's health endpoint, without a socket: the env door,
 * the response bytes under the six inherited-`toJSON` contexts
 * (`docs/contracts/schema-boundary.md` §4 item 5, the SER sweep's route), and
 * the failure classifier against a hostile thrown value (the
 * `instanceof`-classifier mutant that survived every SER round until pinned).
 *
 * The socket-level behaviour — 200/405/404/413/500, `content-type`, the body
 * being exactly `healthResponseBody(snapshot)` — is pinned over real HTTP in
 * `test/integration/control-api/trader-health-http-source.test.ts` and through
 * the real composition root in
 * `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`.
 * A polluted window may not span socket I/O (an inherited `toJSON` installed
 * across a macrotask corrupts vitest's own worker IPC — `SER-3`), which is why
 * the battery here drives the exported encoding function rather than a server.
 */

import { describe, expect, it } from "vitest";

import { HealthState, RealizedPnlBook, type HealthSnapshot } from "../../../packages/trading-core/src/health.js";
import {
  TRADER_HEALTH_BOUNDS,
  TRADER_HEALTH_LOOPBACK_HOSTS,
  TRADER_HEALTH_PATH,
  classifyHealthFailure,
  healthResponseBody,
  readHealthServerEnv,
} from "../../../apps/trader/src/health-server.js";
import { renderDivergences, sweepInheritedToJson } from "../ledger/inherited-tojson.js";

function snapshotWithPnl(): HealthSnapshot {
  const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
  const book = new RealizedPnlBook();
  book.record({ instanceId: "sb-1", realizedPnl: "-1.2" });
  book.record({ instanceId: "sb-0", realizedPnl: "0.1000000000000000055511151231257827" });
  state.attachRealizedPnl(book);
  state.countRiskRefusal(["RISK_NO_NET_EDGE"], false);
  return state.snapshot({
    asOf: "2026-09-16T00:00:00Z",
    halts: [
      {
        scope: { kind: "MARKET", marketId: "market-1" },
        code: "BOOK_DESYNCHRONIZED",
        detail: "a book refused an update",
        at: "2026-09-16T00:00:00Z",
      },
    ],
    queues: [
      {
        name: "ingest",
        currentDepth: 0,
        maximumDepth: 1024,
        oldestMessageAgeMs: null,
        messagesDropped: 0,
        producerBlockedMs: 0,
        consumerLag: 0,
        accepted: 8,
        consumed: 8,
      },
    ],
    seams: {
      fills: { remembered: 3, maximumRemembered: 100_000, admitted: 3, refused: 0, evictions: 0 },
      reservations: { open: 0, taken: 3, released: 3, reservedCollateral: "0" },
      cancels: { pending: 0, requested: 1, confirmed: 1, rejected: 0, silenceExceeded: 0 },
      orderViews: { emitted: 10, repeats: 6, tracked: 3 },
      allocator: { open: 0, applied: 3, released: 3, reservedCollateral: "0", refusalsByCode: {} },
    },
  });
}

describe("readHealthServerEnv — the door (TRDR-3)", () => {
  const safe = { MAX_RUN_MODE: "PAPER", RUN_MODE: "PAPER", ALLOW_REAL_ORDERS: "false" };

  it("both unset (or empty) is NO endpoint, stated as `listen: undefined`", () => {
    expect(readHealthServerEnv(safe)).toEqual({ ok: true, listen: undefined });
    expect(readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "", TRADER_HEALTH_PORT: "" })).toEqual({
      ok: true,
      listen: undefined,
    });
  });

  it("accepts exactly the three loopback names, and port 0 through 65535", () => {
    expect(TRADER_HEALTH_LOOPBACK_HOSTS).toEqual(["127.0.0.1", "::1", "localhost"]);
    for (const host of TRADER_HEALTH_LOOPBACK_HOSTS) {
      const accepted = readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: host, TRADER_HEALTH_PORT: "9470" });
      expect(accepted).toEqual({ ok: true, listen: { host, port: 9470 } });
    }
    expect(readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "127.0.0.1", TRADER_HEALTH_PORT: "0" })).toEqual({
      ok: true,
      listen: { host: "127.0.0.1", port: 0 },
    });
    expect(readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "::1", TRADER_HEALTH_PORT: "65535" })).toEqual({
      ok: true,
      listen: { host: "::1", port: 65_535 },
    });
    const listen = readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "localhost", TRADER_HEALTH_PORT: "1" });
    if (!listen.ok || listen.listen === undefined) throw new Error("refused");
    // D4: the answer is prototype-free and frozen.
    expect(Object.getPrototypeOf(listen.listen)).toBeNull();
    expect(Object.isFrozen(listen.listen)).toBe(true);
  });

  it("REFUSES every non-loopback bind BY NAME — 0.0.0.0, ::, a routable address, a hostname", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.1", "192.168.1.20", "trader.internal", "127.0.0.2", " 127.0.0.1"]) {
      const refused = readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: host, TRADER_HEALTH_PORT: "9470" });
      expect(refused.ok, host).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.code, host).toBe("TRADER_HEALTH_BIND_REFUSED");
      expect(refused.refusal.detail).toContain(`TRADER_HEALTH_BIND=${host} is not one of 127.0.0.1, ::1, localhost`);
      expect(refused.refusal.detail).toContain("terminator in front");
    }
  });

  it("REFUSES one variable without the other — a half-stated bind is not completed with a default", () => {
    const bindOnly = readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "127.0.0.1" });
    expect(bindOnly.ok).toBe(false);
    if (!bindOnly.ok) {
      expect(bindOnly.refusal.code).toBe("TRADER_HEALTH_ENV_INVALID");
      expect(bindOnly.refusal.detail).toContain("TRADER_HEALTH_PORT is unset while TRADER_HEALTH_BIND is set");
    }
    const portOnly = readHealthServerEnv({ ...safe, TRADER_HEALTH_PORT: "9470" });
    expect(portOnly.ok).toBe(false);
    if (!portOnly.ok) {
      expect(portOnly.refusal.code).toBe("TRADER_HEALTH_ENV_INVALID");
      expect(portOnly.refusal.detail).toContain("TRADER_HEALTH_BIND is unset while TRADER_HEALTH_PORT is set");
    }
  });

  it("REFUSES a port that is not a plain decimal integer in range", () => {
    for (const [port, code] of [
      ["65536", "TRADER_HEALTH_PORT_INVALID"],
      ["99999", "TRADER_HEALTH_PORT_INVALID"],
      ["-1", "TRADER_HEALTH_ENV_INVALID"],
      ["+80", "TRADER_HEALTH_ENV_INVALID"],
      ["080", "TRADER_HEALTH_ENV_INVALID"],
      ["8080.0", "TRADER_HEALTH_ENV_INVALID"],
      ["1e3", "TRADER_HEALTH_ENV_INVALID"],
      ["0x1F90", "TRADER_HEALTH_ENV_INVALID"],
      ["http", "TRADER_HEALTH_ENV_INVALID"],
      ["100000", "TRADER_HEALTH_ENV_INVALID"],
    ] as const) {
      const refused = readHealthServerEnv({ ...safe, TRADER_HEALTH_BIND: "127.0.0.1", TRADER_HEALTH_PORT: port });
      expect(refused.ok, port).toBe(false);
      if (!refused.ok) expect(refused.refusal.code, port).toBe(code);
    }
  });

  it("reads OWN data only: an inherited TRADER_HEALTH_BIND is not a bind", () => {
    const inherited = Object.create({ TRADER_HEALTH_BIND: "0.0.0.0", TRADER_HEALTH_PORT: "9470" }) as Record<
      string,
      string | undefined
    >;
    expect(readHealthServerEnv(inherited)).toEqual({ ok: true, listen: undefined });
  });

  it("is TOTAL: an environment whose read throws is a contained refusal", () => {
    const hostile = new Proxy({} as Record<string, string | undefined>, {
      has: () => {
        throw new Error("has trap");
      },
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor trap");
      },
    });
    const refused = readHealthServerEnv(hostile);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("TRADER_HEALTH_ENV_INVALID");
      expect(refused.refusal.detail).toContain("contained");
    }
  });
});

describe("healthResponseBody — own-data bytes (TRDR-3)", () => {
  it("is the clean-process JSON of the snapshot plus a newline, with the exact decimals untouched", () => {
    const snapshot = snapshotWithPnl();
    const body = healthResponseBody(snapshot);
    expect(body).toBe(`${JSON.stringify(snapshot)}\n`);
    expect(body).toContain('"realizedPnl":{"byInstance":{"sb-0":"0.1000000000000000055511151231257827","sb-1":"-1.2"},"account":"-1.0999999999999999944488848768742173"}');
    expect(TRADER_HEALTH_PATH).toBe("/health");
    expect(TRADER_HEALTH_BOUNDS.maxRequestBodyBytes).toBe(1024);
  });

  it("is INVARIANT under the six inherited-toJSON contexts, and the injected toJSON never runs (schema-boundary §4 item 5)", () => {
    const snapshot = snapshotWithPnl();
    const { clean, divergences } = sweepInheritedToJson([
      { name: "health response body", render: () => healthResponseBody(snapshot) },
      // A fresh snapshot INSIDE the window: the containers are built while
      // the prototype is polluted, and the bytes must still be the same.
      { name: "health response body (snapshot built inside the window)", render: () => healthResponseBody(snapshotWithPnl()) },
    ]);
    expect(renderDivergences(divergences)).toEqual([]);
    expect(clean.get("health response body")).toBe(`ok:${healthResponseBody(snapshot)}`);
  });

  it("the battery is not vacuous: native JSON.stringify of the same snapshot DOES diverge under the same contexts", () => {
    const snapshot = snapshotWithPnl();
    const { divergences } = sweepInheritedToJson([
      { name: "JSON.stringify", render: () => JSON.stringify(snapshot) },
    ]);
    // Object.prototype and Array.prototype contexts (4 of 6) hijack the bytes.
    expect(divergences.length).toBeGreaterThanOrEqual(4);
    expect(divergences.every((d) => d.calls > 0)).toBe(true);
  });
});

describe("classifyHealthFailure — the classifier (TRDR-3)", () => {
  it("reads the encoder's kind and path as OWN data", () => {
    class ForeignHalts extends Array<HealthSnapshot["halts"][number]> {}
    let thrown: unknown;
    try {
      healthResponseBody({ ...snapshotWithPnl(), halts: new ForeignHalts() });
    } catch (cause) {
      thrown = cause;
    }
    expect(classifyHealthFailure(thrown)).toBe("NON_PLAIN at value.halts");
  });

  it("does not use instanceof: a thrown value with an own kind/path but no Error prototype is classified", () => {
    const bare = Object.create(null) as Record<string, string>;
    bare["kind"] = "DEPTH";
    bare["path"] = "value.deep";
    expect(classifyHealthFailure(bare)).toBe("DEPTH at value.deep");
  });

  it("is TOTAL against a hostile thrown Proxy whose every trap throws (the SER classifier mutant)", () => {
    const hostile = new Proxy(new Error("hostile"), {
      getPrototypeOf: () => {
        throw new Error("getPrototypeOf trap");
      },
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor trap");
      },
      get: () => {
        throw new Error("get trap");
      },
      has: () => {
        throw new Error("has trap");
      },
    });
    // `instanceof` on this value THROWS — the mutant `cause instanceof NotPlainJson`
    // would escape the handler; the own-data read is contained.
    expect(() => hostile instanceof Error).toThrow("getPrototypeOf trap");
    expect(classifyHealthFailure(hostile)).toBe("unclassified");
    for (const value of [undefined, null, 42, "text", Symbol("s"), () => undefined, new Error("plain")]) {
      expect(classifyHealthFailure(value)).toBe("unclassified");
    }
  });

  it("bounds what it reflects of a thrown value", () => {
    const long = Object.create(null) as Record<string, string>;
    long["kind"] = "K".repeat(500);
    long["path"] = "p".repeat(5000);
    expect(classifyHealthFailure(long)).toBe(`${"K".repeat(64)} at ${"p".repeat(256)}`);
  });
});
