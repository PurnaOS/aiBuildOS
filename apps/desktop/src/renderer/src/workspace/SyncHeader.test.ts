import { describe, expect, test } from "vitest";
import { formatSync, prNumber, summarizeChecks } from "./SyncHeader.js";

/**
 * The three pure mappings `SyncHeader.tsx` renders from (RQ-0033#AC-3, RQ-0034#AC-1): no network, no
 * DOM, just the formatting a coordinator would otherwise have to trust by eye.
 */
describe("formatSync (RQ-0033#AC-3)", () => {
  test("both counts null — no upstream — reads as 'not published', never '↑0 ↓0'", () => {
    expect(formatSync(null, null)).toBe("not published");
  });

  test("either count null still reads as 'not published'", () => {
    expect(formatSync(0, null)).toBe("not published");
    expect(formatSync(null, 0)).toBe("not published");
  });

  test("in sync renders both counts, zero included — 0 is a fact, not something to hide", () => {
    expect(formatSync(0, 0)).toBe("↑0 ↓0");
  });

  test("ahead and behind both render together", () => {
    expect(formatSync(2, 0)).toBe("↑2 ↓0");
    expect(formatSync(0, 3)).toBe("↑0 ↓3");
    expect(formatSync(2, 1)).toBe("↑2 ↓1");
  });
});

describe("summarizeChecks", () => {
  test("no checks at all is null, not '0 passing'", () => {
    expect(summarizeChecks([])).toBeNull();
  });

  test("counts passing and failing, case-insensitively (check-run vs legacy status shapes)", () => {
    expect(
      summarizeChecks([
        { name: "a", status: "SUCCESS" },
        { name: "b", status: "success" },
        { name: "c", status: "FAILURE" },
      ]),
    ).toBe("2 passing, 1 failing");
  });

  test("neither passing nor failing lands in 'pending'", () => {
    expect(summarizeChecks([{ name: "a", status: "PENDING" }])).toBe("1 pending");
  });

  test("a mix of all three orders passing, failing, pending", () => {
    expect(
      summarizeChecks([
        { name: "a", status: "SUCCESS" },
        { name: "b", status: "ERROR" },
        { name: "c", status: "unknown" },
      ]),
    ).toBe("1 passing, 1 failing, 1 pending");
  });
});

describe("prNumber", () => {
  test("reads the number out of a PR URL", () => {
    expect(prNumber("https://github.com/acme/repo/pull/123")).toBe("123");
  });

  test("a URL with no /pull/ segment is null, not a crash", () => {
    expect(prNumber("https://github.com/acme/repo")).toBeNull();
  });
});
