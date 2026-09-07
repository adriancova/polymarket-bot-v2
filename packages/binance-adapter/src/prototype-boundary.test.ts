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
});
