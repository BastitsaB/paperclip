import { describe, expect, it } from "vitest";
import { formatDayAwareTime } from "./timeAgo";

describe("formatDayAwareTime", () => {
  const options = { locale: "en-US", timeZone: "America/Chicago" } as const;
  // 2026-09-24T21:08:00Z is 4:08 PM in America/Chicago.
  const timestamp = "2026-09-24T21:08:00.000Z";

  it("shows a bare clock time for the reference day", () => {
    const now = "2026-09-24T23:00:00.000Z"; // 6:00 PM Chicago, same calendar day
    expect(formatDayAwareTime(timestamp, options, now)).toBe("4:08 PM");
  });

  it("compares the day in the display time zone, not UTC", () => {
    // 11:08 PM Chicago on the 24th is 04:08 UTC on the 25th — still "today"
    // in Chicago even though the UTC calendar day has already flipped.
    const lateNight = "2026-09-25T04:08:00.000Z";
    const now = "2026-09-24T23:00:00.000Z"; // 6:00 PM Chicago on the 24th
    expect(formatDayAwareTime(lateNight, options, now)).toBe("11:08 PM");
  });

  it("prefixes a short date once the entry is no longer from today", () => {
    const now = "2026-09-26T15:00:00.000Z"; // two days later
    expect(formatDayAwareTime(timestamp, options, now)).toBe("Sep 24, 4:08 PM");
  });

  it("adds the year only when it differs from the reference year", () => {
    const now = "2027-01-04T15:00:00.000Z";
    expect(formatDayAwareTime(timestamp, options, now)).toBe("Sep 24, 2026, 4:08 PM");
  });

  it("defaults `now` to the current time when omitted", () => {
    const justNow = new Date();
    expect(formatDayAwareTime(justNow)).not.toContain(",");
  });
});
