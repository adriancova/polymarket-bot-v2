/**
 * `ROLLOVER-1` (ruling Q3): a window's schedule comes from its TITLE, read in
 * America/New_York; `eventStartTime`/`endDate` only locate and confirm it; a
 * title that does not convert to exactly one interval of the reviewed length
 * (the 2026-11-01 repeat, U-34) is refused.
 */

import { describe, expect, it } from "vitest";

import { deriveWindowSchedule, epochMsOfInstant } from "./series-window-schedule.js";

const SHAPE = { titlePrefix: "Bitcoin Up or Down - ", durationSeconds: 900 } as const;
const title = (range: string): string => `Bitcoin Up or Down - ${range}`;

describe("deriveWindowSchedule: the title is the authority", () => {
  it("converts every recorded EDT title to its observed interval (S-G02, S-G03, S-G04, S-G07)", () => {
    const recorded: readonly (readonly [string, string, string])[] = [
      ["October 4, 6:15PM-6:30PM ET", "2026-10-04T22:15:00Z", "2026-10-04T22:30:00Z"],
      ["October 4, 7:45PM-8:00PM ET", "2026-10-04T23:45:00Z", "2026-10-05T00:00:00Z"],
      ["October 4, 8:00PM-8:15PM ET", "2026-10-05T00:00:00Z", "2026-10-05T00:15:00Z"],
      ["August 6, 8:00PM-8:15PM ET", "2026-08-07T00:00:00Z", "2026-08-07T00:15:00Z"],
      ["August 7, 12:00PM-12:15PM ET", "2026-08-07T16:00:00Z", "2026-08-07T16:15:00Z"],
      ["August 1, 8:00AM-8:15AM ET", "2026-08-01T12:00:00Z", "2026-08-01T12:15:00Z"],
    ];
    for (const [range, open, close] of recorded) {
      const schedule = deriveWindowSchedule(title(range), SHAPE, open, close);
      expect(schedule.ok, range).toBe(true);
      if (schedule.ok) {
        expect(schedule.openAt).toBe(new Date(open).toISOString());
        expect(schedule.closeAt).toBe(new Date(close).toISOString());
        expect(schedule.closeEpochMs - schedule.openEpochMs).toBe(900_000);
      }
    }
  });

  it("converts an EST title by the zone's own rules (UTC-5 after 2026-11-01)", () => {
    const schedule = deriveWindowSchedule(title("November 15, 9:00AM-9:15AM ET"), SHAPE, "2026-11-15T14:00:00Z", "2026-11-15T14:15:00Z");
    expect(schedule.ok).toBe(true);
  });

  it("REFUSES the repeated hour when daylight saving time ends (U-34): one title, two UTC intervals", () => {
    // 1:00AM-1:15AM ET on 2026-11-01 is 05:00Z (EDT) AND 06:00Z (EST).
    for (const locator of ["2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z"]) {
      const close = new Date(Date.parse(locator) + 900_000).toISOString();
      const schedule = deriveWindowSchedule(title("November 1, 1:00AM-1:15AM ET"), SHAPE, locator, close);
      expect(schedule.ok, locator).toBe(false);
      if (!schedule.ok) {
        expect(schedule.ambiguous).toBe(true);
        expect(schedule.problems.join(" ")).toMatch(/converts to 2 UTC intervals/u);
      }
    }
    // 1:30 and 1:15 repeat as well.
    const repeated = deriveWindowSchedule(title("November 1, 1:30AM-1:45AM ET"), SHAPE, "2026-11-01T05:30:00Z", "2026-11-01T05:45:00Z");
    expect(repeated.ok).toBe(false);
  });

  it("the 05:45Z window of 2026-11-01 can only be admitted under a title that converts to it alone", () => {
    // 1:45AM-2:00AM ET converts to exactly one 900 s interval (06:45Z..07:00Z):
    // 2:00 AM occurs once. A window that opens at 05:45Z under that title is
    // therefore refused — its locators disagree with the title.
    const mislocated = deriveWindowSchedule(title("November 1, 1:45AM-2:00AM ET"), SHAPE, "2026-11-01T05:45:00Z", "2026-11-01T06:00:00Z");
    expect(mislocated.ok).toBe(false);
    if (!mislocated.ok) expect(mislocated.problems.join(" ")).toMatch(/disagree/u);
    const located = deriveWindowSchedule(title("November 1, 1:45AM-2:00AM ET"), SHAPE, "2026-11-01T06:45:00Z", "2026-11-01T07:00:00Z");
    expect(located.ok).toBe(true);
  });

  it("REFUSES a wall time the zone skips when daylight saving time starts (2026-03-08)", () => {
    const skipped = deriveWindowSchedule(title("March 8, 2:00AM-2:15AM ET"), SHAPE, "2026-03-08T07:00:00Z", "2026-03-08T07:15:00Z");
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.ambiguous).toBe(true);
  });

  it("reads an end at or before the start on the next day (crossing midnight)", () => {
    const schedule = deriveWindowSchedule(title("October 4, 11:45PM-12:00AM ET"), SHAPE, "2026-10-05T03:45:00Z", "2026-10-05T04:00:00Z");
    expect(schedule.ok).toBe(true);
  });

  it("REFUSES a title whose interval disagrees with the locators", () => {
    const schedule = deriveWindowSchedule(title("October 4, 6:15PM-6:30PM ET"), SHAPE, "2026-10-04T22:30:00Z", "2026-10-04T22:45:00Z");
    expect(schedule.ok).toBe(false);
    if (!schedule.ok) expect(schedule.ambiguous).toBe(false);
  });

  it("REFUSES a range of another length than the review's", () => {
    const fiveMinutes = deriveWindowSchedule(title("October 4, 6:15PM-6:20PM ET"), SHAPE, "2026-10-04T22:15:00Z", "2026-10-04T22:20:00Z");
    expect(fiveMinutes.ok).toBe(false);
  });

  it("REFUSES a missing title, another prefix, and every other spelling of the range", () => {
    const at = ["2026-10-04T22:15:00Z", "2026-10-04T22:30:00Z"] as const;
    for (const bad of [
      undefined,
      null,
      "",
      "Ethereum Up or Down - October 4, 6:15PM-6:30PM ET",
      title("October 4, 6:15PM-6:30PM EST"),
      title("October 4, 6:15 PM-6:30 PM ET"),
      title("Oct 4, 6:15PM-6:30PM ET"),
      title("October 4, 18:15-18:30 ET"),
      title("October 4, 6:15PM-6:30PM ET "),
      title("October 04, 6:15PM-6:30PM ET"),
      title("October 4, 06:15PM-06:30PM ET"),
      title("October 4, 6PM-6:15PM ET"),
      title("October 32, 6:15PM-6:30PM ET"),
    ]) {
      expect(deriveWindowSchedule(bad, SHAPE, at[0], at[1]).ok, String(bad)).toBe(false);
    }
  });

  it("REFUSES absent or malformed locators: the title has no year without one", () => {
    const range = title("October 4, 6:15PM-6:30PM ET");
    expect(deriveWindowSchedule(range, SHAPE, null, "2026-10-04T22:30:00Z").ok).toBe(false);
    expect(deriveWindowSchedule(range, SHAPE, "2026-10-04T22:15:00Z", "tomorrow").ok).toBe(false);
    expect(deriveWindowSchedule(range, SHAPE, "2026-10-04 22:15:00", "2026-10-04T22:30:00Z").ok).toBe(false);
  });

  it("refuses a date the calendar does not have", () => {
    expect(deriveWindowSchedule(title("February 30, 6:15PM-6:30PM ET"), SHAPE, "2027-03-02T23:15:00Z", "2027-03-02T23:30:00Z").ok).toBe(false);
  });

  it("reads ISO-8601 instants with an offset or Z only", () => {
    expect(epochMsOfInstant("2026-10-04T22:15:00Z")).toBe(Date.UTC(2026, 9, 4, 22, 15));
    expect(epochMsOfInstant("2026-10-04T18:15:00-04:00")).toBe(Date.UTC(2026, 9, 4, 22, 15));
    expect(epochMsOfInstant("2026-10-03T22:23:47.509856Z")).toBe(Date.UTC(2026, 9, 3, 22, 23, 47, 509));
    expect(epochMsOfInstant("2026-10-04T22:15:00")).toBeUndefined();
    expect(epochMsOfInstant("2026-10-04")).toBeUndefined();
  });
});
