import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
 * TC-0099/TC-0100 (ST-0056). A terminal opened from the dock runs a real shell — typed input
 * reaches it and its output renders in the xterm view — and closing the project leaves no pty
 * behind (RQ-0038#AC-1, AC-2, AC-6).
 *
 * Named `shell.spec.ts`, not `terminal.spec.ts` — that file already belongs to TC-0084's streamed
 * tool-call output, an unrelated surface. Isolation mirrors `worktree.spec.ts`: a temp config dir
 * for `projects.json`/`harnesses.json`/`settings.json`, and `AIBUILDOS_WORKTREES_ROOT` pointed at a
 * temp dir even though this spec never builds one, so a stray run cannot touch a real machine's
 * `userData`.
 *
 * The marker is typed with a quote splitting it in two: `echo MARK"ER"_E2E`. A pty in canonical
 * mode locally echoes exactly what was typed — quote characters included — so the echoed line
 * itself never contains the contiguous string `MARKER_E2E`; only the shell's own unquoted output,
 * printed after Enter actually reaches a running shell, does. A dead terminal that merely echoed
 * keystrokes back would fail this assertion; a real one passes it. POSIX-specific quoting, so this
 * is skipped on win32.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "shell-config-"));
  const work = mkdtempSync(join(tmpdir(), "shell-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "shell-worktrees-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  // Never started — this spec opens no session — but `AttachHarnessDialog` blocks the whole app
  // behind a modal the instant `harness:list` comes back empty, so one has to exist.
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      { id: "h", displayName: "Stub", command: process.execPath, args: ["--version"] },
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
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      AIBUILDOS_WORKTREES_ROOT: worktrees,
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w, work };
}

async function terminalCount(w: Page, projectId: string): Promise<number> {
  const result = await w.evaluate(async (id) => {
    const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
    return await api.invoke("terminal:list", { projectId: id });
  }, projectId);
  return result.terminals.length;
}

test("a terminal opened from the dock runs a real shell, and closing the project kills it", async () => {
  test.skip(process.platform === "win32", "the marker command below relies on POSIX shell quoting");

  const { app, w } = await open();

  // The dock starts collapsed (a 28px strip) — expand it before anything inside it is reachable.
  await w.getByTestId("dock-toggle").click();
  await w.getByTestId("dock-expanded").waitFor();

  await w.getByTestId("terminal-new").click();
  const view = w.getByTestId("terminal-view");
  await expect(view).toBeVisible({ timeout: 10000 });
  expect(await terminalCount(w, "p1")).toBe(1);

  // AC-1/AC-2: a real PTY, not a styled transcript — typed input reaches the shell, and only the
  // shell's own (unquoted) output can produce the contiguous marker.
  await view.click();
  await w.keyboard.type('echo MARK"ER"_E2E');
  await w.keyboard.press("Enter");
  await expect(view).toContainText("MARKER_E2E", { timeout: 10000 });

  // The row's own close control kills the pty directly — not only the project-wide sweep below.
  await w.getByTestId("terminal-close-t1").click();
  await expect(w.getByTestId("terminal-row-t1")).toHaveCount(0);
  await expect(w.getByTestId("terminal-view")).toHaveCount(0);
  expect(await terminalCount(w, "p1")).toBe(0);

  // AC-4/AC-6: a second terminal, then closing the project — not this row's own control — leaves
  // no shell process running either.
  await w.getByTestId("terminal-new").click();
  await expect(w.getByTestId("terminal-view")).toBeVisible({ timeout: 10000 });
  expect(await terminalCount(w, "p1")).toBe(1);

  await w.getByTestId("project-close").click();
  await expect.poll(() => terminalCount(w, "p1"), { timeout: 10000 }).toBe(0);

  await app.close();
});
