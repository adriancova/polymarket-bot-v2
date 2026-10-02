/**
 * The configuration door: §15's loopback rule, the weak-credential refusals,
 * and the ADR-020 properties the door inherits.
 */

import { describe, expect, it } from "vitest";

import { LOOPBACK_HOSTS, MINIMUM_TOKEN_LENGTH, parseControlApiConfig } from "./config.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-0001";
const OTHER = "fake-paper-readonly-token-not-a-credential-0002";

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindHost: "127.0.0.1",
    bindPort: 0,
    maxRequestBodyBytes: 65_536,
    auditCapacity: 4096,
    auditSafetyReserve: 64,
    traderHealth: { kind: "none" },
    operators: [{ operatorId: "operator-a", token: TOKEN, grants: ["READ", "KILL_SWITCH"] }],
    ...overrides,
  };
}

const codes = (input: unknown): readonly string[] => {
  const result = parseControlApiConfig(input);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
};

describe("a valid configuration", () => {
  it("parses and returns the values it was given", () => {
    const result = parseControlApiConfig(document());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.bindHost).toBe("127.0.0.1");
    expect(result.config.auditCapacity).toBe(4096);
    expect(result.config.auditSafetyReserve).toBe(64);
    expect(result.config.traderHealth).toEqual({ kind: "none" });
    expect(result.config.operators[0]?.grants).toEqual(["READ", "KILL_SWITCH"]);
  });

  it("accepts an http trader-health source on loopback", () => {
    const result = parseControlApiConfig(
      document({ traderHealth: { kind: "http", url: "http://127.0.0.1:9464/health", timeoutMs: 2000 } }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("§15: no public network exposure", () => {
  it("names exactly three acceptable bind hosts", () => {
    expect([...LOOPBACK_HOSTS]).toEqual(["127.0.0.1", "::1", "localhost"]);
  });

  it.each(["0.0.0.0", "::", "10.0.0.5", "0x7f000001", "127.1", "::ffff:127.0.0.1"])(
    "REFUSES bindHost=%s",
    (host) => {
      expect(codes(document({ bindHost: host }))).toEqual(["CONTROL_CONFIG_NOT_LOOPBACK"]);
    },
  );

  it.each([
    "http://10.0.0.5:9464/health",
    "https://example.test/health",
    "http://evil.test/health",
    // A file: URL naming no real file (`CONTROL-1b` r3: acceptance 3 fails a
    // literal path that reaches an existing file it does not read as code).
    "file:///nonexistent/trader-health",
  ])("REFUSES a trader-health URL that is not loopback http (%s)", (url) => {
    expect(codes(document({ traderHealth: { kind: "http", url, timeoutMs: 1000 } }))).toEqual([
      "CONTROL_CONFIG_HEALTH_SOURCE_NOT_LOOPBACK",
    ]);
  });
});

describe("operator credentials", () => {
  it("REFUSES a token shorter than the minimum, without printing it", () => {
    const short = "abc";
    const result = parseControlApiConfig(
      document({ operators: [{ operatorId: "a", token: short, grants: ["READ"] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]?.code).toBe("CONTROL_CONFIG_WEAK_OPERATOR");
    expect(result.refusals[0]?.detail).toContain(String(MINIMUM_TOKEN_LENGTH));
    expect(result.refusals[0]?.detail).not.toContain(short);
  });

  it("REFUSES two operators sharing a token, without printing it", () => {
    const result = parseControlApiConfig(
      document({
        operators: [
          { operatorId: "a", token: TOKEN, grants: ["READ"] },
          { operatorId: "b", token: TOKEN, grants: ["READ"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "CONTROL_CONFIG_WEAK_OPERATOR",
    ]);
    expect(JSON.stringify(result.refusals)).not.toContain(TOKEN);
  });

  it("REFUSES a duplicated operator id — the audit log must say who acted", () => {
    const result = parseControlApiConfig(
      document({
        operators: [
          { operatorId: "a", token: TOKEN, grants: ["READ"] },
          { operatorId: "a", token: OTHER, grants: ["READ"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("REFUSES a configuration with no operators at all", () => {
    expect(codes(document({ operators: [] }))).toEqual(["CONTROL_CONFIG_INVALID"]);
  });

  it("REFUSES an operator with no grants — authenticating must grant nothing", () => {
    expect(codes(document({ operators: [{ operatorId: "a", token: TOKEN, grants: [] }] }))).toEqual([
      "CONTROL_CONFIG_INVALID",
    ]);
  });

  it("REFUSES an unknown grant name", () => {
    expect(
      codes(document({ operators: [{ operatorId: "a", token: TOKEN, grants: ["LIVE_MODE"] }] })),
    ).toEqual(["CONTROL_CONFIG_INVALID"]);
  });
});

describe("no bare defaults on anything safety-relevant", () => {
  it.each([
    "bindHost",
    "bindPort",
    "maxRequestBodyBytes",
    "auditCapacity",
    "auditSafetyReserve",
    "traderHealth",
    "operators",
  ])("REFUSES a document missing %s rather than defaulting it", (field) => {
    const incomplete = document();
    Reflect.deleteProperty(incomplete, field);
    expect(codes(incomplete)).toEqual(["CONTROL_CONFIG_INVALID"]);
  });

  it("REFUSES an unknown key: the configuration grammar is CLOSED", () => {
    expect(codes(document({ allowRealOrders: true }))).toEqual(["CONTROL_CONFIG_INVALID"]);
    expect(codes(document({ maxRunMode: "LIVE" }))).toEqual(["CONTROL_CONFIG_INVALID"]);
  });

  it("REFUSES an audit capacity of zero — an unauditable control plane does nothing", () => {
    expect(codes(document({ auditCapacity: 0 }))).toEqual(["CONTROL_CONFIG_INVALID"]);
  });
});

describe("CONTROL-1: the audit budget's safety reserve is required, and usable", () => {
  it.each([0, -1, 1.5, "64", null])(
    "REFUSES auditSafetyReserve=%s at the schema: a deployment cannot run without a reserve",
    (reserve) => {
      expect(codes(document({ auditSafetyReserve: reserve }))).toEqual(["CONTROL_CONFIG_INVALID"]);
    },
  );

  it.each([
    [4096, 2048],
    [4096, 4096],
    [3, 2],
    [2, 1],
  ])("REFUSES capacity %s with reserve %s: twice the reserve must leave an ordinary tier", (capacity, reserve) => {
    const result = parseControlApiConfig(document({ auditCapacity: capacity, auditSafetyReserve: reserve }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["CONTROL_CONFIG_AUDIT_BUDGET"]);
    expect(result.refusals[0]?.detail).toContain("twice the reserve must be below the capacity");
  });

  it.each([
    [4096, 2047],
    [3, 1],
  ])("ACCEPTS capacity %s with reserve %s, the smallest ordinary tier being one record", (capacity, reserve) => {
    expect(codes(document({ auditCapacity: capacity, auditSafetyReserve: reserve }))).toEqual([]);
  });

  it("does not adopt an INHERITED reserve (ADR-020: a required field is own data)", () => {
    const incomplete = document();
    Reflect.deleteProperty(incomplete, "auditSafetyReserve");
    Object.defineProperty(Object.prototype, "auditSafetyReserve", {
      value: 64,
      enumerable: false,
      configurable: true,
    });
    try {
      expect(codes(incomplete)).toEqual(["CONTROL_CONFIG_INVALID"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "auditSafetyReserve");
    }
  });
});

describe("the door's own properties", () => {
  it("REFUSES a non-document", () => {
    // A primitive IS plain data, so D1 admits it and the SCHEMA is what refuses
    // it — hence `INVALID` rather than `NOT_DATA`. The distinction matters: D1
    // answers "can this be read", not "is this the right shape".
    expect(codes(null)).toEqual(["CONTROL_CONFIG_INVALID"]);
    expect(codes("a string")).toEqual(["CONTROL_CONFIG_INVALID"]);
  });

  it("REFUSES a document that is not READABLE as data under CONTROL_CONFIG_NOT_DATA", () => {
    const withGetter = document();
    Object.defineProperty(withGetter, "bindHost", {
      get: () => "0.0.0.0",
      enumerable: true,
      configurable: true,
    });
    expect(codes(withGetter)).toEqual(["CONTROL_CONFIG_NOT_DATA"]);
    expect(codes(new Proxy(document(), {}))).toEqual(["CONTROL_CONFIG_NOT_DATA"]);
  });

  it("does not adopt an inherited required field", () => {
    const incomplete = document();
    Reflect.deleteProperty(incomplete, "bindHost");
    Object.defineProperty(Object.prototype, "bindHost", {
      value: "0.0.0.0",
      enumerable: false,
      configurable: true,
    });
    try {
      expect(codes(incomplete)).toEqual(["CONTROL_CONFIG_INVALID"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "bindHost");
    }
  });

  it("reports EVERY refusal, not the first", () => {
    const result = parseControlApiConfig(
      document({
        bindHost: "0.0.0.0",
        operators: [{ operatorId: "a", token: "short", grants: ["READ"] }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.code).sort()).toEqual([
      "CONTROL_CONFIG_NOT_LOOPBACK",
      "CONTROL_CONFIG_WEAK_OPERATOR",
    ]);
  });
});
