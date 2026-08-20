import { describe, expect, it } from "vitest";
import { fileMenuTarget } from "./menus.js";

/** TC-0033. Which directory a right-click meant. */
describe("the file tree's context menu", () => {
  it("acts on a folder itself", () => {
    expect(fileMenuTarget("docs/requirements", true)).toBe("docs/requirements");
  });

  it("acts on the folder a file sits in, not on the file", () => {
    expect(fileMenuTarget("docs/requirements/rq-0001.md", false)).toBe("docs/requirements");
  });

  it("treats a file at the root as the project itself", () => {
    expect(fileMenuTarget("README.md", false)).toBe("");
  });

  it("treats the root folder as the project itself", () => {
    expect(fileMenuTarget("", true)).toBe("");
  });
});
