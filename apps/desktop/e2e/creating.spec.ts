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
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0030. A file and an artifact are started from the workspace.
 *
 * What this proves that TC-0029 cannot is that the types on offer come from the project in front of
 * the user rather than from this repository's own vocabulary, and that a refusal is a refusal —
 * nothing half-written left behind.
 */
async function open(options: { bundle?: boolean; identity?: boolean } = {}): Promise<{
  app: ElectronApplication;
  w: Page;
  work: string;
}> {
  const config = mkdtempSync(join(tmpdir(), "create-config-"));
  const work = mkdtempSync(join(tmpdir(), "create-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  if (options.identity !== false) {
    execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
    execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  }
  if (options.bundle !== false) cpSync(template, join(work, "docs"), { recursive: true });

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub],
      },
    ]),
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
      // A repository with no identity means no identity in *any* scope — `git config user.name`
      // reads the global and system files too, and this machine has one.
      ...(options.identity === false
        ? { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
        : {}),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w, work };
}

test("starts a file at a path the user gives", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("new-file").click();
  await w.getByTestId("new-file-path").fill("src/thing.ts");
  await w.getByTestId("new-file-create").click();

  expect(readFileSync(join(work, "src/thing.ts"), "utf8")).toBe("");
  // In the tree without a reload, and open in the centre.
  await expect(w.getByTestId("file-row").filter({ hasText: "src" }).first()).toBeVisible();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  await app.close();
});

test("refuses a path that is taken, or that climbs out of the project", async () => {
  const { app, w, work } = await open();
  writeFileSync(join(work, "taken.md"), "mine\n");

  await w.getByTestId("new-file").click();
  await w.getByTestId("new-file-path").fill("taken.md");
  await w.getByTestId("new-file-create").click();
  await expect(w.getByTestId("new-file-problem")).toBeVisible();
  // Refused means nothing of anyone's was touched.
  expect(readFileSync(join(work, "taken.md"), "utf8")).toBe("mine\n");

  await w.getByTestId("new-file-path").fill("../escaped.md");
  await w.getByTestId("new-file-create").click();
  await expect(w.getByTestId("new-file-problem")).toBeVisible();
  expect(existsSync(join(work, "../escaped.md"))).toBe(false);

  await app.close();
});

test("mints an artifact of a type the project's own profile declares", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("new-artifact").click();

  // The project's vocabulary, and not an abstract type: nothing can be a WorkItem directly.
  const offered = await w.getByTestId("new-artifact-type").locator("option").allTextContents();
  expect(offered.join(" ")).toContain("Requirement · RQ");
  expect(offered.join(" ")).toContain("TestCase · TC");
  expect(offered.join(" ")).not.toContain("WorkItem");

  await w.getByTestId("new-artifact-type").selectOption("Requirement");
  await w.getByTestId("new-artifact-title").fill("The first thing this product must do");
  await w.getByTestId("new-artifact-create").click();
  // Open in the centre, and in the rail, without either being asked for again.
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  await expect(w.getByTestId("artifact-title")).toHaveValue("The first thing this product must do");
  await expect(w.getByTestId("record-open-RQ-0001")).toBeVisible();

  // Written as its type says, numbered from the bundle, and listed in its index.
  const source = readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8");
  expect(source).toContain("type: Requirement");
  expect(source).toContain("id: RQ-0001");
  expect(source).toContain('title: "The first thing this product must do"');
  expect(source).toContain("state: draft");
  expect(source).toContain("owner: Test Person");
  expect(source).toContain("provenance: human");
  expect(source).toContain("kind: functional");
  expect(source).toContain("## Acceptance criteria");
  expect(readFileSync(join(work, "docs/requirements/README.md"), "utf8")).toContain(
    "| [RQ-0001](rq-0001.md) | The first thing this product must do | draft |",
  );

  await app.close();
});

test("says a project with no profile cannot mint artifacts", async () => {
  const { app, w } = await open({ bundle: false });

  await w.getByTestId("new-artifact").click();
  await expect(w.getByTestId("new-artifact-unavailable")).toBeVisible();
  await expect(w.getByTestId("new-artifact-type")).toHaveCount(0);

  await app.close();
});

test("refuses to mint without an identity to put in `owner`", async () => {
  const { app, w, work } = await open({ identity: false });

  await w.getByTestId("new-artifact").click();
  await w.getByTestId("new-artifact-title").fill("Nobody's requirement");
  await w.getByTestId("new-artifact-create").click();

  await expect(w.getByTestId("new-artifact-problem")).toContainText("user.name");
  expect(existsSync(join(work, "docs/requirements/rq-0001.md"))).toBe(false);

  await app.close();
});
