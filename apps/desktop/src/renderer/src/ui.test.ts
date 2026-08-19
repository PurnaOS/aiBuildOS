import { describe, expect, it, vi } from "vitest";
import { middleTruncate, relativeTime } from "./ui.js";

/**
 * The two pure helpers behind the ledger. Both looked obviously right and one was not: labelling the
 * unit table with the unit being divided *from* rendered a week-old commit as "7 minutes ago".
 */
describe("relativeTime", () => {
  const at = (secondsAgo: number): string =>
    new Date(Date.UTC(2026, 7, 18, 12, 0, 0) - secondsAgo * 1000).toISOString();

  const frozen = <T>(run: () => T): T => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 18, 12, 0, 0)));
    try {
      return run();
    } finally {
      vi.useRealTimers();
    }
  };

  it("scales to the right unit", () => {
    frozen(() => {
      expect(relativeTime(at(30))).toMatch(/30 seconds/);
      expect(relativeTime(at(120))).toMatch(/2 minutes/);
      expect(relativeTime(at(2 * 60 * 60))).toMatch(/2 hours/);
      expect(relativeTime(at(24 * 60 * 60))).toMatch(/yesterday|1 day/);
      expect(relativeTime(at(7 * 24 * 60 * 60))).toMatch(/last week|1 week/);
      expect(relativeTime(at(365 * 24 * 60 * 60))).toMatch(/last year|1 year/);
    });
  });

  it("says so when a project has never been opened", () => {
    expect(relativeTime(null)).toBe("never opened");
    expect(relativeTime("not a date")).toBe("never opened");
  });
});

describe("middleTruncate", () => {
  it("leaves a short path alone", () => {
    expect(middleTruncate("/a/b")).toBe("/a/b");
  });

  it("keeps both ends, because the tail is what identifies a project", () => {
    const path = `/Users/someone/${"deep/".repeat(20)}my-project`;
    const short = middleTruncate(path, 30);

    expect(short.length).toBeLessThanOrEqual(30);
    expect(short.startsWith("/Users")).toBe(true);
    expect(short.endsWith("my-project")).toBe(true);
    expect(short).toContain("…");
  });
});
