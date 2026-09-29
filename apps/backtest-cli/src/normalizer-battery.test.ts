/**
 * BT1-R4 — the schema-boundary §4 item 5 pollution battery for
 * `normalizedEnvelopeNormalizer`, RUN and PINNED (`BACKTEST-2`).
 *
 * `docs/contracts/schema-boundary.md` §4 item 5: "the bound: under its
 * pollution battery, permission never varies, a `SAFETY_CANCEL` is
 * byte-identical, and no throw escapes — refusal composition may vary", and
 * "A door that has not run a battery says so." `BACKTEST-1` shipped this door
 * with D1-D4 stated and no battery (its reviewer ran an 8-key one by hand).
 * This file is the battery, over 20 cases: EVERY frame of the committed
 * fixture (`test/replay-golden/backtest/static-bracket/frames.json`, read
 * only; 8 frames) plus ONE refused case for EACH of the door's 12 refusal
 * sites (the `{ ok: false, reason }` returns of `normalizer.ts`'s envelope
 * door, beside the one line that forwards `readRecordedNormalizedEnvelope`'s
 * own refusals). Each refused case is pinned to the site it reaches, by that
 * site's reason, and a source census pins that the cases reach EVERY site, so
 * a refusal branch added without a case fails this file (BT2-01, `BACKTEST-2`
 * r1: the r0 battery said "every refusal kind" over 7 of the 12). Eleven
 * cases are recorded frames with one thing wrong; the twelfth site, the
 * containment catch, exists for THROWS from the door's reads (the pollution
 * below reaches it), so its case is the one built with an accessor rather
 * than recorded bytes — a record whose read throws.
 *
 * The battery's dimensions:
 *
 * - KEYS: every key the recording and the envelope declare, the zod state
 *   keys `schema-boundary.md` §2 measured (`skipChecks`, `optin`, `optout`,
 *   `when`, `values`, `get`, `set`, `status`, `value`, `writable`, `_zod`),
 *   and the numeric-name family (`"0"`, `"1"`, `"-1"`);
 * - VARIANTS: a non-enumerable DATA property on `Object.prototype` whose value
 *   is a string a field could plausibly carry (an ISO instant), and a
 *   non-enumerable GET-ONLY accessor answering the same;
 * - THE BOUND, for every (key, variant, case): no throw escapes; permission
 *   never WIDENS (a case the clean run refuses is refused); and an envelope
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

/** What a refused case changes in the recorded frame, beside its payload. */
interface FrameOverrides {
  readonly source?: string;
  readonly receivedAt?: string;
  /** The payload TEXT, verbatim, for a payload no `JSON.stringify` produces. */
  readonly payloadUtf8?: string;
}

function recordOf(
  frames: FixtureFrames,
  index: number,
  envelope: unknown,
  overrides: FrameOverrides = {},
): ReplayRecord {
  const frame = frames.frames[index];
  if (frame === undefined) throw new Error(`no frame ${String(index)}`);
  const payloadUtf8 = overrides.payloadUtf8 ?? JSON.stringify(envelope);
  return {
    datasetRowOrdinal: index,
    segmentId: frames.segmentId,
    segmentRecordIndex: index,
    frameLineSha256: sha256Hex(new Uint8Array(Buffer.from(`line:${String(index)}`, "utf8"))),
    frame: {
      gatewayEpoch: frames.gatewayEpoch,
      ingestSeq: frame.ingestSeq,
      source: overrides.source ?? frame.source,
      endpoint: frame.endpoint,
      connectionId: frame.connectionId,
      subscriptionGeneration: frame.subscriptionGeneration,
      receivedAt: overrides.receivedAt ?? frame.receivedAt,
      receivedMonotonicNs: frame.receivedMonotonicNs,
      payloadUtf8,
      payloadSha256: sha256Hex(new Uint8Array(Buffer.from(payloadUtf8, "utf8"))),
    },
  };
}

/**
 * The containment site's case: a record whose `frame.source` read THROWS. The
 * catch exists for throws from the door's reads, which the pollution below
 * reaches; this case reaches it without pollution, so it is the one case built
 * with an accessor rather than from recorded bytes.
 */
function unreadableRecordOf(frames: FixtureFrames, index: number, envelope: unknown): ReplayRecord {
  const readable = recordOf(frames, index, envelope);
  const frame = Object.defineProperty({ ...readable.frame }, "source", {
    enumerable: true,
    configurable: false,
    get(): string {
      throw new RangeError("this recorded frame cannot be read");
    },
  });
  return { ...readable, frame };
}

interface Case {
  readonly name: string;
  readonly record: ReplayRecord;
}

interface RefusedCase extends Case {
  /** A fragment of the reason ONE refusal site of the door produces: the site this case reaches. */
  readonly site: string;
}

function fixtureFrames(): FixtureFrames {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "frames.json"), "utf8")) as FixtureFrames;
}

/** Every frame of the committed fixture: each is accepted. */
function acceptedCases(): readonly Case[] {
  const frames = fixtureFrames();
  return frames.frames.map((frame, index) => ({
    name: `fixture frame ${String(index)} (${String(frame.envelope["eventType"])})`,
    record: recordOf(frames, index, frame.envelope),
  }));
}

/**
 * ONE refused case per refusal site of the door, in the order a frame meets
 * them (the containment catch, which wraps every read, first), each built
 * from fixture frame 2 (`MarketOpened`) with one thing wrong, and each naming
 * the reason fragment of the site it must reach.
 */
function refusedCases(): readonly RefusedCase[] {
  const frames = fixtureFrames();
  const first = frames.frames[2]?.envelope ?? {};
  const firstText = JSON.stringify(first);
  const withoutSourceChannel = Object.fromEntries(Object.entries(first).filter(([key]) => key !== "sourceChannel"));
  return [
    {
      name: "refused: a record whose read throws (the containment catch)",
      site: "reading the recorded envelope threw (RangeError)",
      record: unreadableRecordOf(frames, 2, first),
    },
    {
      name: "refused: a frame source outside the §7.1 vocabulary",
      site: "which is not one of the §7.1 event sources",
      record: recordOf(frames, 2, first, { source: "not-a-7.1-source" }),
    },
    {
      name: "refused: a payload that is not strict JSON (a duplicate key)",
      site: "the recorded payload is not strict JSON",
      record: recordOf(frames, 2, first, {
        payloadUtf8: `{"eventType":${JSON.stringify(first["eventType"])},${firstText.slice(1)}`,
      }),
    },
    {
      name: "refused: not an object",
      site: "a recorded normalized envelope is a JSON object",
      record: recordOf(frames, 2, ["an", "array"]),
    },
    {
      name: "refused: no eventType",
      site: "the recorded envelope names no eventType",
      record: recordOf(frames, 2, { ...first, eventType: "" }),
    },
    {
      name: "refused: a non-integer schemaVersion",
      site: "the recorded envelope's schemaVersion is not a positive integer",
      record: recordOf(frames, 2, { ...first, schemaVersion: 1.5 }),
    },
    {
      name: "refused: no sourceChannel",
      site: "the recorded envelope names no sourceChannel",
      record: recordOf(frames, 2, withoutSourceChannel),
    },
    {
      name: "refused: a non-string venueTimestamp",
      site: "the recorded envelope's venueTimestamp is not a string",
      record: recordOf(frames, 2, { ...first, venueTimestamp: 7 }),
    },
    {
      name: "refused: no payload",
      site: "the recorded envelope carries no payload",
      record: recordOf(frames, 2, { eventType: first["eventType"], schemaVersion: 1, sourceChannel: "market" }),
    },
    {
      name: "refused: an unregistered contract",
      site: "which is not a registered packages/domain event contract",
      record: recordOf(frames, 2, { ...first, eventType: "NoSuchEvent" }),
    },
    {
      name: "refused: a receivedAt no replay event id can be derived from",
      site: "receivedAt is not an instant a UUIDv7 timestamp field can carry",
      record: recordOf(frames, 2, first, { receivedAt: "not an instant" }),
    },
    {
      name: "refused: a payload its contract rejects",
      site: "envelope failed its frozen packages/domain contract",
      record: recordOf(frames, 2, { ...first, payload: { bogus: true } }),
    },
  ];
}

/** Every frame of the committed fixture, and one refused case per refusal site of the door. */
function cases(): readonly Case[] {
  return [...acceptedCases(), ...refusedCases()];
}

/**
 * The door's refusal sites, read from `normalizer.ts`'s SOURCE: every
 * `{ ok: false, reason: … }` from `function readRecordedNormalizedEnvelope(`
 * to the end of the file, which is the envelope door and nothing else (pinned
 * by the function names the region declares). Each entry is the text after
 * `reason:`.
 */
function doorRefusalSites(): { readonly functions: readonly string[]; readonly sites: readonly string[] } {
  const source = readFileSync(fileURLToPath(new URL("./normalizer.ts", import.meta.url)), "utf8");
  const start = source.indexOf("function readRecordedNormalizedEnvelope(");
  const region = start < 0 ? "" : source.slice(start);
  return {
    functions: [...region.matchAll(/^(?:export )?function (\w+)\(/gmu)].map((match) => match[1] ?? ""),
    sites: [...region.matchAll(/\{\s*ok: false,\s*reason:\s*(\S[^\n]*)/gu)].map((match) => (match[1] ?? "").trim()),
  };
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
  /** The refusal's reason, when the door refused. */
  readonly reason: string | undefined;
  readonly envelopes: readonly string[];
  readonly prototypeFree: boolean;
  readonly frozen: boolean;
}

function observe(record: ReplayRecord): Observation {
  const normalizer = normalizedEnvelopeNormalizer(sha256Hex);
  try {
    const outcome = normalizer.normalize(record);
    if (!outcome.ok) {
      return {
        threw: undefined,
        accepted: false,
        reason: outcome.reason,
        envelopes: [],
        prototypeFree: true,
        frozen: true,
      };
    }
    return {
      threw: undefined,
      accepted: true,
      reason: undefined,
      // Captured while polluted; compared once the pollution is gone.
      envelopes: outcome.envelopes.map((envelope) => canonical(envelope)),
      prototypeFree: outcome.envelopes.every((envelope) => Object.getPrototypeOf(envelope) === null),
      frozen: outcome.envelopes.every((envelope) => Object.isFrozen(envelope)),
    };
  } catch (error) {
    return {
      threw: error instanceof Error ? error.name : typeof error,
      accepted: undefined,
      reason: undefined,
      envelopes: [],
      prototypeFree: false,
      frozen: false,
    };
  }
}

describe("BT1-R4 — normalizedEnvelopeNormalizer's §4 item 5 pollution battery (run, and pinned)", () => {
  it("clean: every fixture frame is accepted, and every refused case is refused AT ITS OWN SITE — by that site's reason and no other's", () => {
    const accepted = acceptedCases().map((entry) => ({ name: entry.name, ...observe(entry.record) }));
    const refused = refusedCases();
    expect(accepted.map((entry) => [entry.name, entry.accepted])).toEqual(accepted.map((entry) => [entry.name, true]));
    expect(accepted.length).toBe(8);
    const sites = refused.map((entry) => entry.site);
    // BT2-01: one case per site — the fragments name twelve DIFFERENT sites.
    expect(new Set(sites).size).toBe(sites.length);
    const reached = refused.map((entry) => {
      const outcome = observe(entry.record);
      return {
        name: entry.name,
        accepted: outcome.accepted,
        threw: outcome.threw,
        sitesInReason: sites.filter((site) => outcome.reason?.includes(site) === true),
      };
    });
    expect(reached).toEqual(
      refused.map((entry) => ({ name: entry.name, accepted: false, threw: undefined, sitesInReason: [entry.site] })),
    );
    expect(cases().length).toBe(8 + 12);
  });

  it("BT2-01: the refused cases reach EVERY refusal site of the door — one case per `{ ok: false, reason }` in normalizer.ts's envelope door, beside its one forward of readRecordedNormalizedEnvelope's refusals", () => {
    const { functions, sites } = doorRefusalSites();
    // The census reads the envelope door and nothing else.
    expect(functions).toEqual([
      "readRecordedNormalizedEnvelope",
      "normalizedEnvelopeNormalizer",
      "normalizeRecordedEnvelope",
    ]);
    // The one site that is not a refusal of its own: it forwards the reader's.
    const forwards = sites.filter((site) => site.startsWith("read.reason"));
    expect(forwards).toEqual(["read.reason };"]);
    const own = sites.filter((site) => !site.startsWith("read.reason"));
    // A refusal branch added to the door without a refused case here fails
    // this line — "every refusal kind" is measured, not asserted.
    expect(own.length).toBe(refusedCases().length);
    expect(own.length).toBe(12);
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
