import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcBridge } from "@aibuildos/ipc";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * TC-0091, TC-0092, TC-0093, TC-0094 — the git side of RQ-0035 / DC-0025, against the running
 * application.
 *
 * `sprint:start`/`sprint:merge`/`sprint:discard` never touch `docs/` (minting the `Sprint` record
 * artifact is the renderer's own business through the ordinary guarded save — this channel's
 * contract comment says so), so the fixture is a bare repository, not the OKF template
 * `worktree.spec.ts` copies. Everything is driven straight through `window.aibuildos.invoke`, not
 * board clicks: the Work header's sprint controls (ST-0052#AC-3) land in a later slot, and an
 * invoke-driven spec is still the real IPC boundary for every backend acceptance criterion here.
 *
 * `build:start`'s handler does not yet forward the request's own optional `sprintId` through to
 * `startBuild` (`apps/desktop/src/main/ipc.ts`'s `"build:start"` case destructures
 * `{ projectId, storyId, harnessId }` only) — a one-line wiring gap this spec cannot reach around
 * for *starting* a sprint-scoped build. So the sprint-scoped story worktree below is fabricated
 * with raw git, exactly the shape `startBuild(..., sprintId)` produces (DC-0025's `--` binding);
 * `sprint:merge`'s `stories_live` guard and `build:merge`'s routing onto the sprint branch are then
 * exercised for real, through the real IPC boundary, same as everything else in this file.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));

function seed(): { config: string; work: string; worktrees: string } {
  const config = mkdtempSync(join(tmpdir(), "sprint-config-"));
  const work = mkdtempSync(join(tmpdir(), "sprint-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "sprint-worktrees-"));

  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  writeFileSync(join(work, "README.md"), "seed\n");
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  writeFileSync(join(config, "harnesses.json"), JSON.stringify([]));
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  return { config, work, worktrees };
}

async function open(
  config: string,
  worktrees: string,
): Promise<{ app: ElectronApplication; w: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      AIBUILDOS_WORKTREES_ROOT: worktrees,
    },
  });
  const w = await app.firstWindow();
  await expect(w.getByTestId("title")).toBeVisible();
  return { app, w };
}

/** `window.aibuildos.invoke`, from the page — the real preload bridge, not a main-process shortcut. */
function invoke<C extends string>(w: Page, channel: C, request: unknown): Promise<unknown> {
  return w.evaluate(
    ([ch, req]) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      return api.invoke(ch as never, req as never);
    },
    [channel, request] as const,
  );
}

test("sprint:start mints a branch and worktree checked out on it, and refuses sprint_exists on a second start", async () => {
  const { config, work, worktrees } = seed();
  const { app, w } = await open(config, worktrees);

  const first = await invoke(w, "sprint:start", { projectId: "p1", sprintId: "SP-0001" });
  expect(first).toEqual({ ok: true, branch: "aibuildos/sp-0001" });

  const second = await invoke(w, "sprint:start", { projectId: "p1", sprintId: "SP-0001" });
  expect(second).toEqual({ ok: false, code: "sprint_exists", message: expect.any(String) });

  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/sp-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toContain("aibuildos/sp-0001");
  expect(existsSync(join(worktrees, "p1", "SP-0001"))).toBe(true);

  await app.close();
});

test("sprint:merge refuses stories_live while a sprint-scoped story worktree survives, then lands --no-ff once the story merges", async () => {
  const { config, work, worktrees } = seed();
  const { app, w } = await open(config, worktrees);

  const started = await invoke(w, "sprint:start", { projectId: "p1", sprintId: "SP-0002" });
  expect(started).toMatchObject({ ok: true });
  const branch = (started as { ok: true; branch: string }).branch;

  // A sprint-scoped story worktree, fabricated with raw git (see the file header) — the `--`
  // binding DC-0025 settles, branched from the sprint branch rather than main's `HEAD`.
  const storyWtPath = join(worktrees, "story-st-0001");
  execFileSync("git", [
    "-C",
    work,
    "worktree",
    "add",
    "-b",
    "aibuildos/sp-0002--st-0001",
    storyWtPath,
    branch,
  ]);
  writeFileSync(join(storyWtPath, "feature.md"), "feature\n");
  execFileSync("git", ["-C", storyWtPath, "add", "-A"]);
  execFileSync("git", ["-C", storyWtPath, "commit", "-m", "checkpoint: ST-0001 turn 1", "--quiet"]);

  const refused = await invoke(w, "sprint:merge", { projectId: "p1", sprintId: "SP-0002" });
  expect(refused).toEqual({ ok: false, code: "stories_live", message: expect.any(String) });

  const mainHeadBefore = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // ST-0053#AC-2, through the real `build:merge` channel: the accept lands on the sprint branch's
  // own worktree, never on main.
  const merged = await invoke(w, "build:merge", { projectId: "p1", storyId: "ST-0001" });
  expect(merged).toEqual({ ok: true });
  expect(execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(
    mainHeadBefore,
  );
  expect(existsSync(join(worktrees, "p1", "SP-0002", "feature.md"))).toBe(true);
  expect(existsSync(storyWtPath)).toBe(false);

  // The guard lifts: finishing the sprint now merges --no-ff into main.
  const finished = await invoke(w, "sprint:merge", { projectId: "p1", sprintId: "SP-0002" });
  expect(finished).toEqual({ ok: true });
  expect(existsSync(join(work, "feature.md"))).toBe(true);
  expect(
    execFileSync("git", ["-C", work, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
  ).toBe("SP-0002: finish the sprint");
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", branch], { encoding: "utf8" }).trim(),
  ).toBe("");

  await app.close();
});

test("sprint:discard force-removes a sprint's worktree and branch when nothing is live", async () => {
  const { config, work, worktrees } = seed();
  const { app, w } = await open(config, worktrees);

  await invoke(w, "sprint:start", { projectId: "p1", sprintId: "SP-0003" });

  const discarded = await invoke(w, "sprint:discard", { projectId: "p1", sprintId: "SP-0003" });
  expect(discarded).toEqual({ ok: true });
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/sp-0003"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("");
  expect(existsSync(join(worktrees, "p1", "SP-0003"))).toBe(false);

  await app.close();
});
