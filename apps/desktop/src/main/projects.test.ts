import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject, loadProjects, markOpened, removeProject } from "./projects.js";

/**
 * TC-0005. The registry persists, dedupes by path, and refuses to overwrite a file it cannot read.
 *
 * Runs on Node with a temp directory and no Electron: the store takes its file path as a parameter,
 * which is the whole reason it can be tested at all.
 */
describe("the project registry", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-projects-"));
    file = join(dir, "nested", "projects.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is empty when the file does not exist", () => {
    expect(loadProjects(file)).toEqual([]);
  });

  it("adds a project and reads it back across a reload", () => {
    const path = join(dir, "alpha");
    mkdirSync(path);

    const added = addProject(file, { name: "alpha", path });

    expect(added.id).not.toBe("");
    expect(added.lastOpened).toBeNull();
    expect(loadProjects(file)).toEqual([added]);
  });

  it("returns the existing project when the same path is added again (RQ-0002#AC-12)", () => {
    const path = join(dir, "alpha");
    mkdirSync(path);

    const first = addProject(file, { name: "alpha", path });
    const again = addProject(file, { name: "a different name", path });

    expect(again).toEqual(first);
    expect(loadProjects(file)).toHaveLength(1);
  });

  it("treats a trailing separator as the same path", () => {
    const path = join(dir, "alpha");
    mkdirSync(path);

    const first = addProject(file, { name: "alpha", path });
    const again = addProject(file, { name: "alpha", path: `${path}/` });

    expect(again.id).toBe(first.id);
    expect(loadProjects(file)).toHaveLength(1);
  });

  it("keeps distinct paths apart", () => {
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));

    addProject(file, { name: "alpha", path: join(dir, "alpha") });
    addProject(file, { name: "beta", path: join(dir, "beta") });

    expect(loadProjects(file)).toHaveLength(2);
  });

  it("stamps only the project that was opened", () => {
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));
    const alpha = addProject(file, { name: "alpha", path: join(dir, "alpha") });
    const beta = addProject(file, { name: "beta", path: join(dir, "beta") });

    const at = "2026-08-18T10:00:00.000Z";
    const opened = markOpened(file, alpha.id, at);

    expect(opened).toEqual({ ...alpha, lastOpened: at });
    expect(loadProjects(file).find((p) => p.id === beta.id)).toEqual(beta);
  });

  it("reports an unknown id rather than inventing a project", () => {
    mkdirSync(join(dir, "alpha"));
    addProject(file, { name: "alpha", path: join(dir, "alpha") });

    expect(markOpened(file, "nope", "2026-08-18T10:00:00.000Z")).toBeUndefined();
  });

  it("forgets a project without touching its directory (RQ-0002#AC-9)", () => {
    const path = join(dir, "alpha");
    mkdirSync(path);
    writeFileSync(join(path, "keep.txt"), "still here", "utf8");
    mkdirSync(join(dir, "beta"));

    const alpha = addProject(file, { name: "alpha", path });
    const beta = addProject(file, { name: "beta", path: join(dir, "beta") });

    removeProject(file, alpha.id);

    expect(loadProjects(file)).toEqual([beta]);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("still here");
  });

  it("reads a corrupt file as empty but refuses to write over it", () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, "not json at all", "utf8");

    expect(loadProjects(file)).toEqual([]);

    // Reading it as empty and then saving would erase every project in it — silently, because the app
    // looks like a fresh install right up until the write lands.
    expect(() => addProject(file, { name: "alpha", path: join(dir, "alpha") })).toThrow(
      /not valid project configuration/,
    );
    expect(readFileSync(file, "utf8")).toBe("not json at all");
  });
});
