/**
 * The OUTPUT side of the feature engine, driven against the recorded
 * cross-package schema risk (`WP-160-FU1`, closing `WP-160` R1-L3 and the
 * `GOV-2A` `docs/contracts/schema-boundary.md` §3 row for this package).
 *
 * The §9.5 storage helpers are what a decision row is built from —
 * `selectIndexedValues` supplies the indexed values and `snapshotReference`
 * the durable reference, and both are destined for PostgreSQL next to the
 * decision. Built as ordinary object literals they answered for names they do
 * not declare: an OK member has no own `reason`, an ABSENT member has no own
 * `value`, and a polluted `Object.prototype` supplied both (measured — see the
 * two `defeat` tests below, which FAIL against literal construction).
 *
 * The pollution here is deliberately NON-ENUMERABLE: it is invisible to
 * `Object.keys`, to `JSON.stringify` and to a `for…in` audit, so a consumer
 * that enumerates a row sees nothing while a consumer that reads a column by
 * name gets the fabricated value. The positive control below proves these
 * probes can see an adoption at all.
 *
 * Pollution hygiene (the `hostile-inputs.test.ts` rule): every observation is
 * captured as a PRIMITIVE inside the polluted region and asserted after
 * cleanup, because the assertion library itself is not pollution-proof.
 */

import { describe, expect, it } from "vitest";

import {
  computeFeatureSnapshot,
  selectIndexedValues,
  snapshotReference,
} from "../../../packages/features/src/index.js";
import type { FeatureSnapshot } from "../../../packages/features/src/index.js";
import { validInput } from "./fixtures.js";

/** A NON-ENUMERABLE inherited property: invisible to enumeration, live to a read. */
function withInheritedProperty<T>(name: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  try {
    return run();
  } finally {
    delete (Object.prototype as Record<string, unknown>)[name];
  }
}

function snapshotOf(input: Record<string, unknown>): FeatureSnapshot {
  const result = computeFeatureSnapshot(input);
  if (!result.ok) {
    throw new Error(`the fixture must compute; refused with ${result.refusal.code}`);
  }
  return result.snapshot;
}

/** A snapshot in which `lifecycle.time_to_close_ms` is ABSENT (no lifecycle input). */
function snapshotWithAbsentLifecycle(): FeatureSnapshot {
  const input = validInput();
  delete input["lifecycle"];
  return snapshotOf(input);
}

function read(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

/**
 * `String()` on a null-prototype record throws ("Cannot convert object to
 * primitive value"), so record-valued observations are described by their own
 * keys instead. Still a primitive, as the pollution-hygiene rule requires.
 */
function describeRead(value: unknown, key: string): string {
  const member = read(value, key);
  if (member !== null && typeof member === "object") return `<record:${Object.keys(member).join("+")}>`;
  return String(member);
}

describe("selectIndexedValues emits members that cannot adopt an inherited name", () => {
  it("positive control: an ordinary object literal DOES adopt the inherited name", () => {
    // If this control ever stops adopting, the two defeat tests below prove
    // nothing and must be re-derived rather than trusted.
    const observed = withInheritedProperty("reason", "ADOPTED_REASON", () => {
      const literal = { id: "control", version: 1, status: "OK", value: "0.5" };
      return String(read(literal, "reason"));
    });
    expect(observed).toBe("ADOPTED_REASON");
  });

  it("defeat 1: an inherited `reason` reaches NEITHER selected OK member", () => {
    const snapshot = snapshotOf(validInput());
    const selected = selectIndexedValues(snapshot, ["polymarket.midpoint", "polymarket.spread"]);
    const observed = withInheritedProperty("reason", "ADOPTED_REASON", () =>
      selected.map((member) => String(read(member, "reason"))).join(","),
    );
    expect(selected.map((member) => member.id)).toEqual(["polymarket.midpoint", "polymarket.spread"]);
    expect(observed).toBe("undefined,undefined");
  });

  it("defeat 2: an ABSENT selected member gains NO `value` from the prototype", () => {
    const selected = selectIndexedValues(snapshotWithAbsentLifecycle(), ["lifecycle.time_to_close_ms"]);
    const observed = withInheritedProperty("value", "ADOPTED_VALUE", () =>
      [
        String(read(selected[0], "status")),
        String(read(selected[0], "reason")),
        String(read(selected[0], "value")),
      ].join("|"),
    );
    expect(selected).toHaveLength(1);
    expect(observed).toBe("ABSENT|INPUT_MISSING|undefined");
  });

  it("no member answers for ANY name it does not declare", () => {
    const selected = selectIndexedValues(snapshotWithAbsentLifecycle(), [
      "polymarket.best_bid",
      "lifecycle.time_to_close_ms",
    ]);
    const probed = ["reason", "value", "detail", "category", "status", "id", "version", "contentAddress"];
    const observed = probed
      .map((name) =>
        withInheritedProperty(name, `ADOPTED_${name}`, () =>
          selected.map((member) => describeRead(member, name)).join(","),
        ),
      )
      .join(" ");
    // Selection is in SNAPSHOT order, so the ABSENT lifecycle member is first.
    expect(observed).toBe(
      [
        "INPUT_MISSING,undefined", // reason: own on the ABSENT member only
        "undefined,<record:price+size>", // value: own on the OK member only
        "undefined,undefined", // detail: never an indexed-value key
        "undefined,undefined", // category: a snapshot-entry key, NOT an indexed-value key
        "ABSENT,OK",
        "lifecycle.time_to_close_ms,polymarket.best_bid",
        "1,1",
        "undefined,undefined", // contentAddress lives on the reference, not here
      ].join(" "),
    );
  });

  it("every member is prototype-free, frozen, and carries exactly its declared keys", () => {
    const selected = selectIndexedValues(snapshotWithAbsentLifecycle(), [
      "polymarket.best_bid",
      "lifecycle.time_to_close_ms",
    ]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected.map((member) => Object.getPrototypeOf(member) as unknown)).toEqual([null, null]);
    expect(selected.map((member) => Object.isFrozen(member))).toEqual([true, true]);
    expect(selected.map((member) => Object.keys(member))).toEqual([
      ["id", "version", "status", "reason"],
      ["id", "version", "status", "value"],
    ]);
    // A nested `value` is a record; it is emitted through the same machinery.
    const nested = read(selected[1], "value");
    expect(Object.getPrototypeOf(nested as object) as unknown).toBe(null);
    expect(Object.isFrozen(nested as object)).toBe(true);
  });

  it("the honest-path selection is byte-identical to the literal-built one", () => {
    const selected = selectIndexedValues(snapshotWithAbsentLifecycle(), [
      "polymarket.best_bid",
      "polymarket.midpoint",
      "polymarket.spread",
      "lifecycle.time_to_close_ms",
      "unknown.id",
    ]);
    // Snapshot order, unknown ids dropped, values exactly as computed. This
    // string is the pre-`WP-160-FU1` output verbatim.
    expect(JSON.stringify(selected)).toBe(
      '[{"id":"lifecycle.time_to_close_ms","version":1,"status":"ABSENT","reason":"INPUT_MISSING"},' +
        '{"id":"polymarket.best_bid","version":1,"status":"OK","value":{"price":"0.48","size":"100"}},' +
        '{"id":"polymarket.midpoint","version":1,"status":"OK","value":"0.5"},' +
        '{"id":"polymarket.spread","version":1,"status":"OK","value":"0.04"}]',
    );
  });
});

describe("snapshotReference emits the same way (the other half of the §9.5 storage pair)", () => {
  it("answers for no name it does not declare, and stays frozen", () => {
    const snapshot = snapshotOf(validInput());
    const reference = snapshotReference(snapshot);
    const observed = ["value", "reason", "refusal", "snapshot", "features"]
      .map((name) => withInheritedProperty(name, `ADOPTED_${name}`, () => String(read(reference, name))))
      .join(",");
    expect(observed).toBe("undefined,undefined,undefined,undefined,undefined");
    expect(Object.getPrototypeOf(reference) as unknown).toBe(null);
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("carries exactly the declared reference fields, unchanged", () => {
    const snapshot = snapshotOf(validInput());
    const reference = snapshotReference(snapshot);
    expect(Object.keys(reference)).toEqual([
      "contentAddress",
      "format",
      "featureSet",
      "internalMarketId",
      "tokenId",
      "asOf",
      "triggerGatewayEpoch",
      "triggerIngestSeq",
    ]);
    expect(JSON.stringify(reference)).toBe(
      JSON.stringify({
        contentAddress: snapshot.contentAddress,
        format: "polymarket-bot/feature-snapshot/v1",
        featureSet: "polymarket-bot/features/v1",
        internalMarketId: snapshot.subject.internalMarketId,
        tokenId: snapshot.subject.tokenId,
        asOf: snapshot.asOf,
        triggerGatewayEpoch: snapshot.trigger.gatewayEpoch,
        triggerIngestSeq: snapshot.trigger.ingestSeq,
      }),
    );
  });
});
