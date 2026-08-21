import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));

/**
 * TC-0086, TC-0088. The sync header against a bare origin created beside the temp project — a plain
 * directory standing in for a real remote, so the user's actual credential chain (DC-0023) is never
 * in play and CI needs none.
 *
 * One fixture, one growing story: publish an unpublished branch, watch a local commit move the ahead
 * count with nothing pressed (RQ-0033#AC-4 — the watcher's own path, the same one `refresh.spec.ts`
 * and `watch.spec.ts` already exercise for the other rails), push it back to even, then pull in a
 * second clone's commit fast-forward.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

async function open(): Promise<{
  app: ElectronApplication;
  w: Page;
  work: string;
  origin: string;
}> {
  const config = mkdtempSync(join(tmpdir(), "sync-config-"));
  const work = mkdtempSync(join(tmpdir(), "sync-work-"));
  const origin = mkdtempSync(join(tmpdir(), "sync-origin-"));

  // `-b main` on both: `init.defaultBranch` is a per-machine setting, and this spec's own
  // assertions name the branch — pinned here rather than left to whatever the CI box defaults to.
  execFileSync("git", ["-C", origin, "init", "--quiet", "--bare", "-b", "main"]);
  execFileSync("git", ["-C", work, "init", "--quiet", "-b", "main"]);
  git(work, "config", "user.name", "Test Person");
  git(work, "config", "user.email", "test@example.com");
  // Signing off, the same reason commit.spec.ts turns it off: a repo-local identity is not enough
  // if signing is on globally and nothing here is present to satisfy it.
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", origin);

  cpSync(template, join(work, "docs"), { recursive: true });
  // A raw template copy leaves `owner: {{OWNER}}` in the seed playbooks (watch.spec.ts's pattern).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"));
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "seed");

  // A harness on file so the first-run attach dialog never sits over the launch page
  // (watch.spec.ts's note) — nothing here ever starts a session.
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([{ id: "h", displayName: "Stub", command: "true", args: [] }]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  await w.getByTestId("rail-tab-git").click();

  return { app, w, work, origin };
}

test("push publishes an unpublished branch, a local commit moves the header unasked, and pull brings in a clone's commit", async () => {
  const { app, w, work, origin } = await open();

  // TC-0088 step 1 / RQ-0033#AC-1: the header names the branch and offers both actions before
  // anything is pressed. RQ-0033#AC-3 on screen: a branch with a remote but no upstream still
  // reads "not published" — never "↑0 ↓0".
  await expect(w.getByTestId("sync-branch")).toContainText("main");
  await expect(w.getByTestId("sync-counts")).toHaveText("not published");
  await expect(w.getByTestId("sync-push")).toBeVisible();
  await expect(w.getByTestId("sync-pull")).toBeVisible();

  // AC-1/AC-6: nothing has touched the origin on its own — it is still empty at this point.
  expect(git(origin, "for-each-ref", "refs/heads")).toBe("");

  // AC-3: pushing an unpublished branch retries with `-u` and publishes it in the same press.
  await w.getByTestId("sync-push").click();
  await expect(w.getByTestId("sync-counts")).toHaveText("↑0 ↓0", { timeout: 10000 });
  expect(git(origin, "log", "-1", "--format=%s")).toBe("seed");

  // TC-0088 step 2 / RQ-0033#AC-4: a commit made *outside* the app — the watcher's own path, no
  // button pressed — moves the ahead count.
  writeFileSync(join(work, "notes.md"), "written by hand\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "a local commit");
  await expect(w.getByTestId("sync-counts")).toHaveText("↑1 ↓0", { timeout: 10000 });

  // TC-0088 step 3: pushing again returns the header to even.
  await w.getByTestId("sync-push").click();
  await expect(w.getByTestId("sync-counts")).toHaveText("↑0 ↓0", { timeout: 10000 });
  expect(git(origin, "log", "-1", "--format=%s")).toBe("a local commit");

  // TC-0086 step 4: a second clone advances the origin from outside `work` entirely.
  const clone = mkdtempSync(join(tmpdir(), "sync-clone-"));
  git(clone, "clone", "--quiet", origin, ".");
  git(clone, "config", "user.name", "Other Person");
  git(clone, "config", "user.email", "other@example.com");
  git(clone, "config", "commit.gpgsign", "false");
  writeFileSync(join(clone, "from-clone.md"), "hello from the clone\n");
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "from the clone");
  git(clone, "push", "--quiet");

  // Pull is fast-forward only (AC-2): the new commit lands, and the git surfaces — the header's
  // counts and the history list — reflect it with nothing further pressed after this one press.
  await w.getByTestId("sync-pull").click();
  await expect.poll(() => existsSync(join(work, "from-clone.md")), { timeout: 10000 }).toBe(true);
  await expect(w.getByTestId("sync-counts")).toHaveText("↑0 ↓0", { timeout: 10000 });
  await expect(w.getByTestId("files-rail")).toContainText("from the clone");

  await app.close();
});
