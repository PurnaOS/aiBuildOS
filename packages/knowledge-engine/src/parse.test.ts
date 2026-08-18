import { describe, expect, it } from "vitest";
import { hasFrontmatter, OkfParseError, parseOkfDocument } from "./parse.js";

const doc = ["---", "type: Decision", "id: DC-0001", "---", "", "# Body", ""].join("\n");

describe("parseOkfDocument", () => {
  it("splits frontmatter from body and records key lines", () => {
    const parsed = parseOkfDocument(doc);
    expect(parsed.frontmatter).toEqual({ type: "Decision", id: "DC-0001" });
    expect(parsed.body).toBe("\n# Body\n");
    expect(parsed.keyLines.get("id")).toBe(3);
  });

  it("reports CRLF rather than silently normalising it", () => {
    expect(() => parseOkfDocument(doc.replace(/\n/g, "\r\n"))).toThrow(OkfParseError);
  });

  it("requires an opening and a closing delimiter", () => {
    expect(() => parseOkfDocument("# no frontmatter\n")).toThrow(OkfParseError);
    expect(() => parseOkfDocument("---\ntype: Decision\n")).toThrow(OkfParseError);
  });

  it("recognises files that are not artifacts at all", () => {
    expect(hasFrontmatter("# Requirements\n")).toBe(false);
    expect(hasFrontmatter(doc)).toBe(true);
  });
});
