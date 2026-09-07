/**
 * REGRESSION: a Binance frame's DECLARED keys must be its OWN
 * (`docs/contracts/schema-boundary.md` §3, the `binance-adapter` row —
 * corrected 2026-09-04 from CONTAINED to LIVE; ADR-020 §1 class 1).
 *
 * MEASURED AT BASE `5128d6c`, and this is the sharpest row in the audit: a
 * `trade` frame with `q` deleted is refused clean (`kind=MALFORMED`,
 * `reason=SCHEMA_MISMATCH`), and under a NON-ENUMERABLE inherited `q` it
 * decodes as `kind=TRADE` with `quantityRaw="999999"` and `unknownFields=[]`.
 * It then flows on: `normalizeTrade` emits `size:"999999"` and
 * `tradeIdentity` becomes `64000.25|999999|1700000000000|false`, so a
 * FABRICATED QUANTITY is both recorded as an economic field and used as the
 * trade's dedup identity.
 *
 * `looseObject` is not a defence and never was: "reads named fields explicitly"
 * is precisely the mechanism by which the injected value lands, and the empty
 * `unknownFields` is what makes it silent rather than what makes it safe.
 *
 * DEPLOYMENT READING: nothing on the wire can write `Object.prototype`; this
 * needs code already executing in the process. The row states the check is not
 * load-bearing against an attacker already inside the process, not that a venue
 * can turn it off. It matters because the recorder is unattended and the
 * corruption lands in the dataset.
 */

import { describe, expect, it } from "vitest";

import { decodeFrame } from "./frames.js";
import { normalizeTrade } from "./normalize.js";
import { tradeIdentity } from "./sequence.js";

const TRADE = {
  e: "trade",
  E: 1_700_000_000_000,
  s: "BTCUSDT",
  t: 42,
  p: "64000.25",
  q: "0.001",
  T: 1_700_000_000_000,
  m: false,
  M: true,
};

/** Every key the trade payload DECLARES. Each one is the same class. */
const DECLARED_TRADE_KEYS = ["e", "E", "s", "t", "p", "q", "T", "m"] as const;

/** A stand-in value of the right TYPE for each declared key. */
const INHERITED_VALUE: Readonly<Record<string, unknown>> = {
  e: "trade",
  E: 1_700_000_000_000,
  s: "BTCUSDT",
  t: 42,
  p: "999999",
  q: "999999",
  T: 1_700_000_000_000,
  m: false,
};

const BOOK_TICKER = {
  u: 400_900_217,
  s: "BNBUSDT",
  b: "25.35190000",
  B: "31.21000000",
  a: "25.36520000",
  A: "40.66000000",
};

function withoutKey(source: Record<string, unknown>, key: string): string {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return JSON.stringify(copy);
}

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
 * The ENUMERABLE variant of the same class.
 *
 * Review round 1, finding F1: a door that copied inherited ENUMERABLE keys
 * after its own-key loop passed every test this file carried, and the §3 row
 * fully reopened under an enumerable `Object.prototype.q = "888888"`. The
 * non-enumerable variant is the one to DESIGN against (`schema-boundary.md`
 * §2), but it is not the only one to TEST against.
 *
 * Every caller warms the schemas with an honest decode FIRST: enumerable
 * pollution present during a schema's first parse aborts its lazy build and
 * permanently poisons it (ADR-020 §1 class 7), which would make this file
 * measure the poisoning instead of the adoption.
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

describe("binance declared-key adoption is closed at the wire door", () => {
  it("honest traffic is unchanged: the documented trade still decodes", () => {
    const decoded = decodeFrame(JSON.stringify(TRADE));
    expect(decoded.kind).toBe("TRADE");
    if (decoded.kind !== "TRADE") throw new Error("unreachable");
    expect(decoded.quantityRaw).toBe("0.001");
    expect(decoded.priceRaw).toBe("64000.25");
    // `M` is documented ("Ignore"), so it is NOT drift and is not listed.
    expect(decoded.unknownFields).toEqual([]);
  });

  // `unknownFields` is a FEATURE (ADR-002 §7): a key the venue's documentation
  // does not describe is visible as data. Closing adoption must not drop it.
  it("unknownFields still records genuine venue drift", () => {
    const drifted = decodeFrame(JSON.stringify({ ...TRADE, X: 1, brandNew: "v2" }));
    expect(drifted.kind).toBe("TRADE");
    expect([...drifted.unknownFields].sort()).toEqual(["X", "brandNew"]);
  });

  it("a trade with `q` deleted is refused clean", () => {
    const decoded = decodeFrame(withoutKey(TRADE, "q"));
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") throw new Error("unreachable");
    expect(decoded.reason).toBe("SCHEMA_MISMATCH");
  });

  it("…and is STILL refused under a non-enumerable inherited `q`", () => {
    decodeFrame(JSON.stringify(TRADE)); // warm
    const decoded = withInherited("q", "999999", () => decodeFrame(withoutKey(TRADE, "q")));
    expect(decoded.kind).toBe("MALFORMED");
    if (decoded.kind !== "MALFORMED") throw new Error("unreachable");
    expect(decoded.reason).toBe("SCHEMA_MISMATCH");
  });

  it("no fabricated quantity can reach the normalized size or the dedup identity", () => {
    const decoded = withInherited("q", "999999", () => decodeFrame(withoutKey(TRADE, "q")));
    // The refusal is the point: there is no TRADE frame to normalize, so
    // `normalizeTrade` (size) and `tradeIdentity` (trade identity) are never
    // reached with a quantity the venue never sent.
    expect(decoded.kind).not.toBe("TRADE");

    // …and the honest frame still produces the honest size and identity.
    const honest = decodeFrame(JSON.stringify(TRADE));
    if (honest.kind !== "TRADE") throw new Error("unreachable");
    const normalized = normalizeTrade(honest, { timeUnit: "MILLISECOND" });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error("unreachable");
    expect(normalized.payload.size).toBe("0.001");
    expect(tradeIdentity(honest)).toBe("64000.25|0.001|1700000000000|false");
  });

  // EVERY declared key, not just `q`: the class is adoption, and the schema
  // declares eight.
  it("every declared trade key is refused when only the prototype supplies it", () => {
    const survivors: string[] = [];
    for (const key of DECLARED_TRADE_KEYS) {
      const raw = withoutKey(TRADE, key);
      // Clean: deleting a required key is refused.
      const clean = decodeFrame(raw);
      if (clean.kind === "TRADE") survivors.push(`${key} (clean)`);
      const polluted = withInherited(key, INHERITED_VALUE[key], () => decodeFrame(raw));
      if (polluted.kind === "TRADE") survivors.push(`${key} (inherited)`);
    }
    expect(survivors).toEqual([]);
  });

  // The package's other wire payload schemas are the same class.
  it("bookTicker, serverShutdown and the control shapes adopt nothing either", () => {
    const survivors: string[] = [];

    for (const key of ["u", "s", "b", "B", "a", "A"] as const) {
      const raw = withoutKey(BOOK_TICKER, key);
      const polluted = withInherited(key, BOOK_TICKER[key], () => decodeFrame(raw));
      if (polluted.kind === "BOOK_TICKER") survivors.push(`bookTicker.${key}`);
    }

    const shutdown = { e: "serverShutdown", E: 1_770_123_456_789 };
    const shutdownPolluted = withInherited("E", 1_770_123_456_789, () =>
      decodeFrame(withoutKey(shutdown, "E")),
    );
    if (shutdownPolluted.kind === "SERVER_SHUTDOWN") survivors.push("serverShutdown.E");

    const controlError = { code: 2, msg: "Invalid request: too many parameters" };
    const errorPolluted = withInherited("msg", "invented", () =>
      decodeFrame(withoutKey(controlError, "msg")),
    );
    if (errorPolluted.kind === "CONTROL_ERROR") survivors.push("controlError.msg");

    expect(survivors).toEqual([]);
  });

  // The combined-stream wrapper is a declared shape too, and it decides
  // PROVENANCE (`sourceChannel` in the WAL).
  it("the combined-stream wrapper cannot take `stream` from the prototype", () => {
    const wrapped = JSON.stringify({ data: TRADE });
    const polluted = withInherited("stream", "btcusdt@trade", () => decodeFrame(wrapped));
    // With no OWN `stream`, this is an unwrapped frame carrying an unknown
    // `data` key — never a wrapper whose channel was invented.
    expect(polluted.streamName).not.toBe("btcusdt@trade");
  });

  // D2-INDEPENDENCE, and this is the property the door has INSTEAD of an
  // arena (see `./wire-door.ts`). One inherited `skipChecks` turns every
  // `.min()`/`.max()` in every schema in the process into a no-op
  // (ADR-020 §1 class 4), so the wire schemas' own bounds stop firing. The
  // door restates them on its own reads, and those are not switchable off.
  it("the door's own bounds hold even with every `zod` format check disabled", () => {
    const survivors: string[] = [];
    for (const [key, value] of [
      ["q", ""],
      ["p", ""],
      ["s", ""],
      ["q", "x".repeat(65)],
    ] as const) {
      const raw = JSON.stringify({ ...TRADE, [key]: value });
      const decoded = withInherited("skipChecks", true, () => decodeFrame(raw));
      if (decoded.kind === "TRADE") survivors.push(`${key}=${value.slice(0, 8)}`);
    }
    expect(survivors).toEqual([]);
  });

  it("an honest frame under the same pollution decodes identically", () => {
    const raw = JSON.stringify(TRADE);
    const clean = decodeFrame(raw);
    const polluted = withInherited("q", "999999", () => decodeFrame(raw));
    expect(JSON.stringify(polluted)).toBe(JSON.stringify(clean));
  });

  // REVIEW ROUND 1, FINDING F1. The ENUMERABLE variant of the whole row: a
  // door that copied inherited enumerable keys after its own-key loop kept
  // every other test in this file green while `Object.prototype.q = "888888"`
  // put a fabricated quantity back into `quantityRaw`. Both variants are now
  // measured, on every declared key.
  it("an ENUMERABLE inherited declared key is not adopted either", () => {
    decodeFrame(JSON.stringify(TRADE)); // warm: enumerable pollution poisons cold lazies
    const survivors: string[] = [];
    for (const key of DECLARED_TRADE_KEYS) {
      const raw = withoutKey(TRADE, key);
      const decoded = withInheritedEnumerable(key, INHERITED_VALUE[key], () => decodeFrame(raw));
      if (decoded.kind === "TRADE") survivors.push(key);
    }
    expect(survivors).toEqual([]);

    // The §3 row's own shape, spelled out: the fabricated quantity never
    // becomes `quantityRaw`.
    const decoded = withInheritedEnumerable("q", "888888", () =>
      decodeFrame(withoutKey(TRADE, "q")),
    );
    expect(decoded.kind).toBe("MALFORMED");
    expect((decoded as { quantityRaw?: string }).quantityRaw).toBeUndefined();
  });

  it("an honest frame is unchanged by ENUMERABLE pollution, unknownFields included", () => {
    const raw = JSON.stringify(TRADE);
    const clean = decodeFrame(raw);
    const polluted = withInheritedEnumerable("q", "888888", () => decodeFrame(raw));
    expect(JSON.stringify(polluted)).toBe(JSON.stringify(clean));
    // An inherited enumerable key the venue never sent is not venue drift.
    const drift = withInheritedEnumerable("brandNew", "v2", () => decodeFrame(raw));
    expect(drift.unknownFields).toEqual([]);
  });

  // REVIEW ROUND 1, FINDING F2. The ADR-020 2026-09-06 amendment: a warm schema
  // still builds its issues lazily per refusal and that path reads through the
  // prototype chain. With `./wire-door.ts`'s containment deleted, an inherited
  // non-enumerable `_zod` makes this exact call THROW
  // `TypeError: Cannot read properties of undefined (reading 'has')`, and an
  // inherited `value` throws `TypeError: Invalid property descriptor…` —
  // turning a documented-total decoder into one that escapes. Both are pinned.
  it("a refusal that cannot be CONSTRUCTED is still a refusal, not a throw", () => {
    const raw = withoutKey(TRADE, "q");
    decodeFrame(JSON.stringify(TRADE)); // warm
    for (const key of ["_zod", "value"] as const) {
      const decoded = withInherited(key, {}, () => decodeFrame(raw));
      expect(decoded.kind, key).toBe("MALFORMED");
      if (decoded.kind !== "MALFORMED") throw new Error("unreachable");
      expect(decoded.reason, key).toBe("SCHEMA_MISMATCH");
      // The detail may VARY (ADR-020 §6: composition may vary, permission may
      // not); what may not vary is that a value came back at all.
      expect(typeof decoded.detail, key).toBe("string");
    }
  });

  // REVIEW ROUND 1, FINDING F7. D4: the door emits prototype-free, so a
  // consumer's `?? default` on an absent field cannot be answered by
  // `Object.prototype`.
  it("every emitted frame has a null prototype (D4)", () => {
    for (const raw of [
      JSON.stringify(TRADE),
      JSON.stringify(BOOK_TICKER),
      withoutKey(TRADE, "q"),
      JSON.stringify({ e: "serverShutdown", E: 1_770_123_456_789 }),
      JSON.stringify({ code: 2, msg: "Invalid request" }),
      JSON.stringify({ result: null, id: 1 }),
      JSON.stringify({ e: "somethingNew" }),
      "not json",
    ]) {
      const decoded = decodeFrame(raw);
      expect(Object.getPrototypeOf(decoded), `${decoded.kind}: ${raw.slice(0, 24)}`).toBeNull();
    }
    // …and an absent optional field reads as absent whatever the prototype says.
    const shutdown = decodeFrame(JSON.stringify({ e: "serverShutdown", E: 1 }));
    expect(withInherited("symbol", "INVENTED", () => (shutdown as { symbol?: string }).symbol))
      .toBeUndefined();
  });
});
