/**
 * `THROUGHPUT-1a` — the feature engine's performance paths answer EXACTLY
 * what the plain path answers: the prepared `reference` section
 * (`prepareReferenceInput`), the reused validation, model copy and digest
 * fragment behind it, the EWMA memos, and the book-serialization / book-feature
 * memos. Every comparison is on the snapshot's own bytes: the canonical
 * serialization and its content address, or the refusal.
 */

import { describe, expect, it } from "vitest";

import { prepareReferenceInput } from "./prepared-reference.js";
import { computeFeatureSnapshot } from "./snapshot.js";
import { fixtureInput } from "./testing/fixture.js";

type Input = Record<string, unknown>;

function withReference(input: Input, reference: unknown): Input {
  return { ...input, reference };
}

function withoutChainlink(input: Input): Input {
  const reference = { ...(input["reference"] as Record<string, unknown>) };
  delete reference["chainlink"];
  return { ...input, reference };
}

/** The observable answer: serialization and address on success, the refusal otherwise. */
function answer(input: unknown): unknown {
  const result = computeFeatureSnapshot(input);
  return result.ok
    ? { ok: true, serialization: result.serialization, address: result.snapshot.contentAddress }
    : { ok: false, refusal: result.refusal };
}

describe("prepareReferenceInput — a prepared section is the raw section, byte for byte", () => {
  it("answers a deep-frozen copy, and leaves the raw section untouched", () => {
    const raw = withoutChainlink(fixtureInput())["reference"] as Record<string, unknown>;
    const before = JSON.stringify(raw);
    const prepared = prepareReferenceInput(raw) as Record<string, unknown>;
    expect(prepared).not.toBe(raw);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared["binance"])).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(JSON.parse(before));
  });

  it("snapshots identically — first use, reuse, and after the raw path ran", () => {
    const input = withoutChainlink(fixtureInput());
    const prepared = prepareReferenceInput(input["reference"]);
    const expected = answer(input);
    expect((expected as { ok: boolean }).ok).toBe(true);
    for (let round = 0; round < 3; round += 1) {
      expect(answer(withReference(input, prepared))).toEqual(expected);
    }
    expect(answer(input)).toEqual(expected);
  });

  it("snapshots identically at every asOf, including one BEFORE the latest point (the refusal)", () => {
    const base = withoutChainlink(fixtureInput());
    const prepared = prepareReferenceInput(base["reference"]);
    for (const asOf of [
      "2026-09-03T12:00:00Z",
      "2026-09-03T11:59:59.800Z", // exactly the latest reference point: allowed
      "2026-09-03T11:59:59.799Z", // one ms before it: a future point, refused
      "2026-09-03T11:59:21Z",
      "2026-09-03T12:30:00Z",
    ]) {
      const input = { ...base, asOf };
      expect(answer(withReference(input, prepared)), asOf).toEqual(answer(input));
    }
  });

  it("a section with a chainlink part is prepared too, and still validated per call (its TWAP windows depend on asOf)", () => {
    const base = fixtureInput();
    const prepared = prepareReferenceInput(base["reference"]);
    for (const asOf of ["2026-09-03T12:00:00Z", "2026-09-03T11:59:29Z"]) {
      const input = { ...base, asOf };
      expect(answer(withReference(input, prepared)), asOf).toEqual(answer(input));
    }
  });

  it("returns a value that is not clean data UNCHANGED, so it is refused exactly as before", () => {
    const hostile = { binance: { get symbol() { return "BTCUSDT"; } } };
    expect(prepareReferenceInput(hostile)).toBe(hostile);
    const unknownKey = { binance: { symbol: "x", lastEventAt: "2026-09-03T11:59:59Z", trades: [], extra: 1 } };
    const preparedUnknown = prepareReferenceInput(unknownKey);
    const input = fixtureInput();
    expect(answer(withReference(input, preparedUnknown))).toEqual(answer(withReference(input, unknownKey)));
    expect((answer(withReference(input, unknownKey)) as { ok: boolean }).ok).toBe(false);
  });

  it("a prepared section is NOT taken for itself at another position (the materializer reads it as any value)", () => {
    const input = withoutChainlink(fixtureInput());
    const prepared = prepareReferenceInput(input["reference"]);
    // As the TRADES section it is just another (invalid) value — the same refusal as its raw copy.
    const raw = JSON.parse(JSON.stringify(input["reference"])) as unknown;
    expect(answer({ ...input, trades: prepared })).toEqual(answer({ ...input, trades: raw }));
  });
});

describe("the EWMA and book memos answer what a recomputation answers", () => {
  it("a sliding reference window: every step equals the plain path", () => {
    const base = withoutChainlink(fixtureInput());
    const reference = base["reference"] as { binance: { trades: { price: string; observedAt: string }[] } };
    const points = [...reference.binance.trades];
    const prices = ["100800", "100750", "100900", "100900", "100100", "101000"];
    for (let step = 0; step < prices.length; step += 1) {
      points.push({ price: prices[step] ?? "1", observedAt: `2026-09-03T11:59:59.${String(810 + step)}Z` });
      points.shift();
      const section = { ...reference, binance: { ...reference.binance, trades: [...points] } };
      const input = { ...base, reference: section };
      const plain = answer(input);
      expect(answer(withReference(input, prepareReferenceInput(section))), `step ${String(step)}`).toEqual(plain);
      // And the plain path again, now with every memo warm.
      expect(answer(input), `step ${String(step)} again`).toEqual(plain);
    }
  });

  it("the same book text with another configuration recomputes the book features", () => {
    const base = fixtureInput();
    const first = answer(base);
    const other = { ...base, config: { ...(base["config"] as Record<string, unknown>), depthLevels: [1, 3] } };
    const second = answer(other);
    expect(second).not.toEqual(first);
    // Fresh, un-memoized reference: a second process's answer to the same input.
    expect(answer(JSON.parse(JSON.stringify(other)) as unknown)).toEqual(second);
    expect(answer(base)).toEqual(first);
  });
});
