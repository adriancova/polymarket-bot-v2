/**
 * BT1-R4 — the schema-boundary §4 item 5 pollution battery for
 * `normalizedEnvelopeNormalizer`, RUN and PINNED (`BACKTEST-2`).
 *
 * `docs/contracts/schema-boundary.md` §4 item 5: "the bound: under its
 * pollution battery, permission never varies, a `SAFETY_CANCEL` is
 * byte-identical, and no throw escapes — refusal composition may vary", and
 * "A door that has not run a battery says so." `BACKTEST-1` shipped this door
 * with D1-D4 stated and no battery (its reviewer ran an 8-key one by hand).
 * This file is the battery, over EVERY frame of the committed fixture
 * (`test/replay-golden/backtest/static-bracket/frames.json`, read only) plus
 * refused frames of every refusal kind the door has:
 *
 * - KEYS: every key the recording and the envelope declare, the zod state
 *   keys `schema-boundary.md` §2 measured (`skipChecks`, `optin`, `optout`,
 *   `when`, `values`, `get`, `set`, `status`, `value`, `writable`, `_zod`),
 *   and the numeric-name family (`"0"`, `"1"`, `"-1"`);
 * - VARIANTS: a non-enumerable DATA property on `Object.prototype` whose value
 *   is a string a field could plausibly carry (an ISO instant), and a
 *   non-enumerable GET-ONLY accessor answering the same;
 * - THE BOUND, for every (key, variant, frame): no throw escapes; permission
 *   never WIDENS (a frame the clean run refuses is refused); and an envelope
 *   accepted under pollution is BYTE-IDENTICAL to the clean run's (own keys,
 *   in order, and every value), prototype-free and frozen (D4). A clean
 *   acceptance may turn into a refusal — availability, not permission, the
 *   §2 `values` row's distinction — and WHERE it does is pinned exactly, so a
 *   new fail-closed key fails this file by name.
 *
 * What the battery found on its first run, each fixed in `normalizer.ts` by
 * `BACKTEST-2`:
 *
 * 1. an inherited `venueTimestamp` was ADOPTED into every envelope whose
 *    recording carried none — the optional field was read off a plain object
 *    literal, so the prototype answered (the §2 "Adoption" class, at a D3
 *    read); the door now reads it as an own key with an explicit `undefined`;
 * 2. under an inherited `value`, `writable`, `_zod`, `get` or `set`, zod's
 *    refusal construction THREW out of `safeParse` for a payload its contract
 *    rejects (the §2 "Error construction" class) and escaped the door; the
 *    door now contains every throw into a refusal;
 * 3. under a get-only numeric name (`"0"`, `"1"`), `packages/simulation`'s
 *    strict-JSON parser threw a bare `TypeError` from `Array.push`
 *    (`strict-json.ts`) for any frame with an array, and its identity reader
 *    refused every other frame. The parser is outside this app's grant; the
 *    containment turns its throw into a refusal, so under those two keys the
 *    door fails CLOSED on every frame — the pinned availability set below.
 *
 * Pollution is installed, the door is run, and the pollution is REMOVED
 * before anything is asserted, so `expect` itself never runs polluted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReplayRecord, Sha256HexDigest } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { normalizedEnvelopeNormalizer } from "./normalizer.js";

const sha256Hex: Sha256HexDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const FIXTURE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "replay-golden",
  "backtest",
  "static-bracket",
);

interface FixtureFrames {
  readonly gatewayEpoch: string;
  readonly segmentId: string;
  readonly frames: readonly {
    readonly ingestSeq: string;
    readonly source: string;
    readonly endpoint: string;
    readonly connectionId: string;
    readonly subscriptionGeneration: number;
    readonly receivedAt: string;
    readonly receivedMonotonicNs: string;
    readonly envelope: Record<string, unknown>;
  }[];
}

function recordOf(frames: FixtureFrames, index: number, envelope: unknown): ReplayRecord {
  const frame = frames.frames[index];
  if (frame === undefined) throw new Error(`no frame ${String(index)}`);
  const payloadUtf8 = JSON.stringify(envelope);
  return {
    datasetRowOrdinal: index,
    segmentId: frames.segmentId,
    segmentRecordIndex: index,
    frameLineSha256: sha256Hex(new Uint8Array(Buffer.from(`line:${String(index)}`, "utf8"))),
    frame: {
      gatewayEpoch: frames.gatewayEpoch,
      ingestSeq: frame.ingestSeq,
      source: frame.source,
      endpoint: frame.endpoint,
      connectionId: frame.connectionId,
      subscriptionGeneration: frame.subscriptionGeneration,
      receivedAt: frame.receivedAt,
      receivedMonotonicNs: frame.receivedMonotonicNs,
      payloadUtf8,
      payloadSha256: sha256Hex(new Uint8Array(Buffer.from(payloadUtf8, "utf8"))),
    },
  };
}

/** Every frame of the committed fixture, and one refused frame per refusal kind. */
function cases(): readonly { readonly name: string; readonly record: ReplayRecord }[] {
  const frames = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "frames.json"), "utf8")) as FixtureFrames;
  const accepted = frames.frames.map((frame, index) => ({
    name: `fixture frame ${String(index)} (${String(frame.envelope["eventType"])})`,
    record: recordOf(frames, index, frame.envelope),
  }));
  const first = frames.frames[2]?.envelope ?? {};
  const refused = [
    { name: "refused: a payload its contract rejects", envelope: { ...first, payload: { bogus: true } } },
    { name: "refused: an unregistered contract", envelope: { ...first, eventType: "NoSuchEvent" } },
    { name: "refused: no payload", envelope: { eventType: first["eventType"], schemaVersion: 1, sourceChannel: "market" } },
    { name: "refused: no eventType", envelope: { ...first, eventType: "" } },
    { name: "refused: a non-integer schemaVersion", envelope: { ...first, schemaVersion: 1.5 } },
    { name: "refused: a non-string venueTimestamp", envelope: { ...first, venueTimestamp: 7 } },
    { name: "refused: not an object", envelope: ["an", "array"] },
  ].map((entry) => ({ name: entry.name, record: recordOf(frames, 2, entry.envelope) }));
  return [...accepted, ...refused];
}

const DECLARED_KEYS = [
  // the recording's own keys
  "eventType",
  "schemaVersion",
  "sourceChannel",
  "venueTimestamp",
  "payload",
  // the envelope's keys
  "eventId",
  "source",
  "receivedAt",
  "receivedMonotonicNs",
  "gatewayEpoch",
  "ingestSeq",
  "connectionId",
  "subscriptionGeneration",
  "rawSegmentId",
  "rawRecordOffset",
  // the fixture's payload keys that are optional somewhere in the contracts
  "internalMarketId",
  "conditionId",
  "openedAt",
  "closingAt",
];
const LIBRARY_STATE_KEYS = [
  "skipChecks",
  "optin",
  "optout",
  "when",
  "values",
  "get",
  "set",
  "status",
  "value",
  "writable",
  "_zod",
];
const NUMERIC_NAMES = ["0", "1", "-1"];
const BATTERY_KEYS = [...DECLARED_KEYS, ...LIBRARY_STATE_KEYS, ...NUMERIC_NAMES];

/** A value a polluted field could plausibly carry: an ISO instant passes every string field's shape. */
const POLLUTION_VALUE = "2026-05-01T09:00:00.000Z";

type Variant = "data" | "accessor";

function pollute(key: string, variant: Variant): () => void {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.enumerable = false;
  descriptor.configurable = true;
  if (variant === "data") {
    descriptor.value = POLLUTION_VALUE;
    descriptor.writable = true;
  } else {
    descriptor.get = () => POLLUTION_VALUE;
  }
  Object.defineProperty(Object.prototype, key, descriptor);
  return () => {
    delete (Object.prototype as Record<string, unknown>)[key];
  };
}

/** Own keys in order and every own value, recursively — the bytes the replay would serialize. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const keys = Object.getOwnPropertyNames(value);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

interface Observation {
  readonly threw: string | undefined;
  readonly accepted: boolean | undefined;
  readonly envelopes: readonly string[];
  readonly prototypeFree: boolean;
  readonly frozen: boolean;
}

function observe(record: ReplayRecord): Observation {
  const normalizer = normalizedEnvelopeNormalizer(sha256Hex);
  try {
    const outcome = normalizer.normalize(record);
    if (!outcome.ok) return { threw: undefined, accepted: false, envelopes: [], prototypeFree: true, frozen: true };
    return {
      threw: undefined,
      accepted: true,
      // Captured while polluted; compared once the pollution is gone.
      envelopes: outcome.envelopes.map((envelope) => canonical(envelope)),
      prototypeFree: outcome.envelopes.every((envelope) => Object.getPrototypeOf(envelope) === null),
      frozen: outcome.envelopes.every((envelope) => Object.isFrozen(envelope)),
    };
  } catch (error) {
    return {
      threw: error instanceof Error ? error.name : typeof error,
      accepted: undefined,
      envelopes: [],
      prototypeFree: false,
      frozen: false,
    };
  }
}

describe("BT1-R4 — normalizedEnvelopeNormalizer's §4 item 5 pollution battery (run, and pinned)", () => {
  it("clean: every fixture frame is accepted and every refused frame is refused", () => {
    const observed = cases().map((entry) => ({ name: entry.name, ...observe(entry.record) }));
    expect(observed.filter((entry) => entry.name.startsWith("fixture")).every((entry) => entry.accepted === true)).toBe(
      true,
    );
    expect(observed.filter((entry) => entry.name.startsWith("refused")).every((entry) => entry.accepted === false)).toBe(
      true,
    );
    expect(observed.length).toBe(15);
  });

  it(`under ${String(BATTERY_KEYS.length)} inherited keys × 2 variants: no throw escapes, permission never widens, every accepted envelope is byte-identical, prototype-free and frozen, and only the get-only numeric names fail closed`, () => {
    const all = cases();
    const clean = all.map((entry) => observe(entry.record));
    const deviations: string[] = [];
    const failedClosed = new Set<string>();
    const failedClosedFrames: string[] = [];
    let runs = 0;
    for (const key of BATTERY_KEYS) {
      for (const variant of ["data", "accessor"] as const) {
        // `map`, not `push`: `push` is a [[Set]], which an inherited getter-only
        // `"0"` refuses — `map` DEFINES each element, so the harness itself
        // does not trip over the pollution it installs.
        let polluted: readonly Observation[] = [];
        const cleanup = pollute(key, variant);
        try {
          polluted = all.map((entry) => observe(entry.record));
        } finally {
          cleanup();
        }
        all.forEach((entry, index) => {
          runs += 1;
          const before = clean[index];
          const after = polluted[index];
          const label = `${key} (${variant}) · ${entry.name}`;
          if (before === undefined || after === undefined) {
            deviations.push(`${label}: missing observation`);
            return;
          }
          if (after.threw !== undefined) deviations.push(`${label}: threw ${after.threw}`);
          if (before.accepted === false && after.accepted !== false) {
            deviations.push(`${label}: a refused frame was not refused (${String(after.accepted)})`);
          }
          if (before.accepted === true && after.accepted === false) {
            failedClosed.add(`${key} (${variant})`);
            failedClosedFrames.push(label);
          }
          if (after.accepted === true && after.envelopes.join("\n") !== before.envelopes.join("\n")) {
            deviations.push(`${label}: the accepted envelope's bytes changed`);
          }
          if (!after.prototypeFree || !after.frozen) deviations.push(`${label}: not prototype-free and frozen`);
        });
      }
    }
    // Non-vacuity: the battery ran every combination.
    expect(runs).toBe(BATTERY_KEYS.length * 2 * all.length);
    expect(deviations).toEqual([]);
    // Availability, pinned exactly: only the get-only numeric names fail
    // closed, and each of them on EVERY accepted fixture frame.
    expect([...failedClosed].sort()).toEqual(["0 (accessor)", "1 (accessor)"]);
    expect(failedClosedFrames.length).toBe(2 * 8);
  });
});
