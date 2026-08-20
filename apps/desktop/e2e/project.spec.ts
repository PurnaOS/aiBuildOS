import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * TC-0008. A project is created, listed, opened and closed from the launch page.
 *
 * Both config files are pointed at a temp directory so the run neither depends on nor disturbs the
 * developer's real userData. A harness is pre-written because the first-run attach dialog (TC-0004) is
 * modal and would otherwise cover the launch page.
 */
async function launch(config: string, chooses: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      // The scaffold's first commit needs an identity, and CI has none configured.
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

  // Wait for the window before reaching into the main process. Evaluating while Electron is still
  // starting races its readiness, and the call is lost with "resulting promise was garbage
  // collected" — intermittently, and more often the more the main bundle has to load.
  await app.firstWindow();

  /**
   * Replace the native directory picker for the duration of the run.
   *
   * Playwright cannot click an OS dialog, and the alternative — a test-only branch inside the
   * handler — would mean the real picker is never the code path production takes. Patching Electron's
   * own `dialog` object from the test keeps the handler honest.
   *
   * This works only because `ipc.ts` calls `dialog.showOpenDialog(...)` as a property access. A
   * destructured reference would still point at the real implementation and hang on a window nobody
   * can see.
   */
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, chooses);

  return app;
}

test("creates, lists, opens and closes a project, and survives a restart", async () => {
  const config = mkdtempSync(join(tmpdir(), "aibuildos-e2e-config-"));
  const workspace = mkdtempSync(join(tmpdir(), "aibuildos-e2e-work-"));
  const projectsFile = join(config, "projects.json");

  // One harness already attached, so the modal first-run prompt stays out of the way.
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([{ id: "stub", displayName: "Stub", command: "true", args: [] }]),
    "utf8",
  );

  try {
    const first = await launch(config, workspace);
    const window = await first.firstWindow();

    // An empty registry is an invitation, not an error (RQ-0002#AC-2).
    await expect(window.getByTestId("project-empty")).toBeVisible();
    await expect(window.getByTestId("project-new")).toBeVisible();
    await expect(window.getByTestId("project-add")).toBeVisible();

    // Create one, choosing the location through the (stubbed) native picker (RQ-0002#AC-6).
    await window.getByTestId("project-new").click();
    await window.getByTestId("project-choose-location").click();
    await expect(window.getByTestId("project-location")).toHaveText(workspace);
    await window.getByTestId("project-name").fill("demo");
    await window.getByTestId("project-create").click();

    // Creating opens it into the workspace: the record on the left, the conversation in the middle,
    // the files on the right. The branch and commit list that the old status page showed now live on
    // the Git tab of the right rail (ST-0011).
    await expect(window.getByTestId("workspace")).toBeVisible();
    await expect(window.getByTestId("record-rail")).toBeVisible();
    await expect(window.getByTestId("files-rail")).toBeVisible();
    await expect(window.getByTestId("tab-chat")).toBeVisible();
    // A freshly created project has a bundle whose only artifacts are the standard playbooks
    // (RQ-0013#AC-4): an empty backlog, not an empty record.
    await expect(window.getByTestId("record-open-PB-0001")).toBeVisible();
    await expect(window.getByTestId("record-empty")).toHaveCount(0);

    // Closing returns to the ledger without a restart (ST-0004#AC-6).
    await window.getByTestId("project-close").click();
    await expect(window.getByTestId("project-row")).toHaveCount(1);
    await expect(window.getByTestId("project-open")).toContainText("demo");
    await first.close();

    // Same registry file, second launch: the project is still listed (RQ-0002#AC-1).
    const second = await launch(config, workspace);
    const reopened = await second.firstWindow();

    await expect(reopened.getByTestId("project-row")).toHaveCount(1);
    await expect(reopened.getByTestId("project-open")).toContainText("demo");
    await second.close();

    // Move the folder out from under the registry (RQ-0002#AC-10).
    renameSync(join(workspace, "demo"), join(workspace, "moved"));

    const third = await launch(config, workspace);
    const afterMove = await third.firstWindow();

    await expect(afterMove.getByTestId("project-missing")).toBeVisible();
    await expect(afterMove.getByTestId("project-open")).toBeDisabled();

    // Forgetting it empties the list and leaves the moved directory alone (RQ-0002#AC-9).
    await afterMove.getByTestId("project-forget").click();
    await expect(afterMove.getByTestId("project-empty")).toBeVisible();
    await third.close();

    expect(JSON.parse(readFileSync(projectsFile, "utf8"))).toEqual([]);
    // Forgetting touches the registry and nothing else (RQ-0002#AC-9).
    expect(existsSync(join(workspace, "moved"))).toBe(true);
  } finally {
    rmSync(config, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
