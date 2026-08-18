import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHarnesses, removeHarness, saveHarness } from "./harnesses.js";

/** TC-0001. The store takes its path, so this runs on plain Node with no Electron in sight. */
describe("the harness store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-harness-"));
    file = join(dir, "nested", "harnesses.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a missing file as an empty list", () => {
    expect(loadHarnesses(file)).toEqual([]);
  });

  it("creates on save without an id, and reads back what it wrote", () => {
    const saved = saveHarness(file, {
      displayName: "Stub",
      command: "node",
      args: ["agent.ts"],
      cwd: "/tmp",
    });

    expect(saved.id).toBeTruthy();
    expect(loadHarnesses(file)).toEqual([saved]);
  });

  it("replaces in place when the id already exists", () => {
    const saved = saveHarness(file, { displayName: "Stub", command: "node", args: [] });
    saveHarness(file, { ...saved, command: "npx" });

    const harnesses = loadHarnesses(file);
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.command).toBe("npx");
  });

  it("keeps several harnesses and removes one by id", () => {
    const first = saveHarness(file, { displayName: "One", command: "a", args: [] });
    const second = saveHarness(file, { displayName: "Two", command: "b", args: [] });
    expect(loadHarnesses(file)).toHaveLength(2);

    removeHarness(file, first.id);
    expect(loadHarnesses(file)).toEqual([second]);
  });

  it("does not reuse the id of a removed harness", () => {
    const first = saveHarness(file, { displayName: "One", command: "a", args: [] });
    const second = saveHarness(file, { displayName: "Two", command: "b", args: [] });
    removeHarness(file, second.id);

    const third = saveHarness(file, { displayName: "Three", command: "c", args: [] });
    expect(third.id).not.toBe(second.id);
    expect(third.id).not.toBe(first.id);
  });

  it("reads a malformed file as an empty list rather than throwing", () => {
    saveHarness(file, { displayName: "One", command: "a", args: [] });
    writeFileSync(file, "not json at all", "utf8");

    expect(loadHarnesses(file)).toEqual([]);
  });
});
