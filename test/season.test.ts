import { describe, expect, it } from "vitest";
import { dayStart, nextSeason, seasonAt, seasonByKey, seasonStart, timeLeft, FIRST_SEASON } from "../src/season.js";

const at = (iso: string) => new Date(iso);

describe("seasons", () => {
  it("run Monday 00:00 UTC to the next Monday 00:00 UTC", () => {
    const s = seasonAt(at("2026-09-22T13:00:00Z")); // a Tuesday
    expect(s.key).toBe("2026-09-21");
    expect(s.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(s.end.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("put the boundary instant in the new season, and the millisecond before in the old", () => {
    expect(seasonAt(at("2026-09-28T00:00:00.000Z")).key).toBe("2026-09-28");
    expect(seasonAt(at("2026-09-27T23:59:59.999Z")).key).toBe("2026-09-21");
  });

  it("count in UTC, whatever the local zone would say", () => {
    // Sunday 23:30 UTC is already Monday in Tokyo and still Sunday in New York.
    expect(seasonStart(at("2026-09-27T23:30:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    // A Sunday is the last day of its season, not the first of the next.
    expect(seasonAt(at("2026-09-20T12:00:00Z")).key).toBe("2026-09-14");
  });

  it("are numbered from the first season, and chain end to start", () => {
    expect(seasonByKey(FIRST_SEASON).number).toBe(1);
    const second = nextSeason(seasonByKey(FIRST_SEASON));
    expect(second.key).toBe("2026-09-28");
    expect(second.number).toBe(2);
    expect(second.start.getTime()).toBe(seasonByKey(FIRST_SEASON).end.getTime());
    // Across a month and a year.
    expect(seasonAt(at("2027-01-01T00:00:00Z")).key).toBe("2026-12-28");
  });

  it("refuse a key that is not a Monday", () => {
    expect(() => seasonByKey("2026-09-22")).toThrow(/not a season key/);
    expect(() => seasonByKey("next week")).toThrow(/not a season key/);
  });

  it("say how long is left, and never less than nothing", () => {
    const end = seasonByKey(FIRST_SEASON).end;
    expect(timeLeft(end, at("2026-09-27T23:00:00Z"))).toBe(60 * 60 * 1000);
    expect(timeLeft(end, at("2026-09-29T00:00:00Z"))).toBe(0);
  });

  it("start a day at 00:00 UTC", () => {
    expect(dayStart(at("2026-09-22T23:59:00Z")).toISOString()).toBe("2026-09-22T00:00:00.000Z");
  });
});
