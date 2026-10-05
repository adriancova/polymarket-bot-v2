/**
 * WP-320 acceptance: "Ambiguous geoblock result blocks new live entries"
 * (handoff §6 invariant 18: a blocked, close-only, failed or ambiguous result
 * prevents new live entries; ADR-008 §7). The endpoint is NEVER called: every
 * answer comes from the venue fixture or a fake port.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readClosedOnly, readGeoblock, VenueEligibility } from "./eligibility.js";
import { FakeBodyPort, ManualClock, NOT_BLOCKED } from "./fakes.test-support.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = JSON.parse(readFileSync(path.join(REPO_ROOT, "test/fixtures/venue/geoblock/geoblock.json"), "utf8")) as {
  readonly examples: readonly { readonly name: string; readonly payload: unknown }[];
};

function example(name: string): unknown {
  const found = FIXTURE.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no fixture example ${name}`);
  return found.payload;
}

const MAX_AGE = 60_000;

async function eligibility(geoBody: unknown, closedBody: unknown = { closed_only: false }): Promise<{ clock: ManualClock; geo: FakeBodyPort; closed: FakeBodyPort; check: VenueEligibility }> {
  const clock = new ManualClock();
  const geo = new FakeBodyPort(geoBody);
  const closed = new FakeBodyPort(closedBody);
  const check = new VenueEligibility({ geoblock: geo, closedOnly: closed, clock, maxAgeMs: MAX_AGE });
  await check.refresh();
  return { clock, geo, closed, check };
}

describe("the documented geoblock answers (fixture `geoblock/geoblock`)", () => {
  it("not-blocked is ELIGIBLE; both blocked tiers are BLOCKED with the tier UNDETERMINED (the endpoint does not say which)", () => {
    expect(readGeoblock(example("not-blocked"))).toEqual({ kind: "ELIGIBLE", country: "AR", region: "" });
    expect(readGeoblock(example("blocked-regulatory-close-only"))).toEqual({ kind: "BLOCKED", tier: "UNDETERMINED", country: "US", region: "NY" });
    expect(readGeoblock(example("blocked-ofac"))).toEqual({ kind: "BLOCKED", tier: "UNDETERMINED", country: "KP", region: "" });
  });

  it("permits new entries only for not-blocked with the account not closed-only", async () => {
    expect((await eligibility(example("not-blocked"))).check.verdict()).toEqual({ newEntriesPermitted: true, reasons: [], geoblockTier: "NOT_BLOCKED" });
    expect((await eligibility(example("blocked-regulatory-close-only"))).check.verdict()).toEqual({
      newEntriesPermitted: false,
      reasons: ["GEOBLOCK_BLOCKED"],
      geoblockTier: "UNDETERMINED",
    });
    expect((await eligibility(example("blocked-ofac"))).check.verdict().newEntriesPermitted).toBe(false);
  });
});

describe("work-plan acceptance: an AMBIGUOUS geoblock result blocks new live entries", () => {
  for (const [name, body] of [
    ["a missing field", { blocked: false, ip: "192.0.2.10", country: "AR" }],
    ["an extra field (an undocumented tier flag)", { ...NOT_BLOCKED, closeOnly: false }],
    ["blocked as a string", { ...NOT_BLOCKED, blocked: "false" }],
    ["blocked as a number", { ...NOT_BLOCKED, blocked: 0 }],
    ["blocked null", { ...NOT_BLOCKED, blocked: null }],
    ["a lower-case country", { ...NOT_BLOCKED, country: "ar" }],
    ["a three-letter country", { ...NOT_BLOCKED, country: "ARG" }],
    ["an empty ip", { ...NOT_BLOCKED, ip: "" }],
    ["a control character in the region", { ...NOT_BLOCKED, region: "N\u0000Y" }],
    ["an accessor for blocked", Object.defineProperty({ ip: "192.0.2.10", country: "AR", region: "" }, "blocked", { get: () => false, enumerable: true })],
    ["a class instance", new (class Answer {
      blocked = false;
      ip = "192.0.2.10";
      country = "AR";
      region = "";
    })()],
    ["an array", [false]],
    ["a bare boolean", false],
    ["null", null],
    ["an HTML error page", "<html>blocked</html>"],
  ] as const) {
    it(`${name} is AMBIGUOUS and blocks new entries`, async () => {
      expect(readGeoblock(body).kind).toBe("AMBIGUOUS");
      const verdict = (await eligibility(body)).check.verdict();
      expect(verdict.newEntriesPermitted).toBe(false);
      expect(verdict.reasons.some((reason) => reason.startsWith("GEOBLOCK_AMBIGUOUS_"))).toBe(true);
    });
  }

  it("a hostile proxy never throws out of the reader", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(readGeoblock(hostile).kind).toBe("AMBIGUOUS");
  });
});

describe("failed, stale and close-only answers block new live entries", () => {
  it("a port that rejects is FAILED", async () => {
    const clock = new ManualClock();
    const geo = new FakeBodyPort(NOT_BLOCKED);
    geo.failing = true;
    const check = new VenueEligibility({ geoblock: geo, closedOnly: new FakeBodyPort({ closed_only: false }), clock, maxAgeMs: MAX_AGE });
    await check.refresh();
    expect(check.verdict().reasons).toEqual(["GEOBLOCK_FAILED"]);
  });

  it("the latest attempt decides: a failure after a success blocks at once", async () => {
    const { geo, check } = await eligibility(NOT_BLOCKED);
    expect(check.verdict().newEntriesPermitted).toBe(true);
    geo.failing = true;
    await check.refresh();
    expect(check.verdict()).toMatchObject({ newEntriesPermitted: false, reasons: ["GEOBLOCK_FAILED"] });
  });

  it("an answer older than the maximum age is STALE", async () => {
    const { clock, check } = await eligibility(NOT_BLOCKED);
    await clock.advance(MAX_AGE);
    expect(check.verdict().newEntriesPermitted).toBe(true);
    await clock.advance(1);
    expect(check.verdict().reasons).toEqual(["GEOBLOCK_STALE", "ACCOUNT_CLOSED_ONLY_STALE"]);
  });

  it("never checked is UNCHECKED", () => {
    const clock = new ManualClock();
    const check = new VenueEligibility({ geoblock: new FakeBodyPort(NOT_BLOCKED), closedOnly: new FakeBodyPort({ closed_only: false }), clock, maxAgeMs: MAX_AGE });
    expect(check.verdict().reasons).toEqual(["GEOBLOCK_UNCHECKED", "ACCOUNT_CLOSED_ONLY_UNCHECKED"]);
  });

  it("the account's closed-only mode (D-24) blocks new entries like the close-only tier; its answer is read exactly", async () => {
    expect((await eligibility(NOT_BLOCKED, { closed_only: true })).check.verdict().reasons).toEqual(["ACCOUNT_CLOSED_ONLY"]);
    for (const body of [{ closed_only: "false" }, { closed_only: false, extra: 1 }, {}, true, null]) {
      expect(readClosedOnly(body).kind).toBe("AMBIGUOUS");
      expect((await eligibility(NOT_BLOCKED, body)).check.verdict().newEntriesPermitted).toBe(false);
    }
    expect(readClosedOnly({ closed_only: false })).toEqual({ kind: "OPEN" });
  });
});
