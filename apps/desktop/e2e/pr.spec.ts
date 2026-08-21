import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 * TC-0090. The PR chip with and without `gh`, through the running application.
 *
 * `AIBUILDOS_GH_BIN` (DC-0024) is the whole seam — the absent path (a binary that does not exist)
 * is the one CI actually lives on, since runners carry no authenticated `gh`; the present path rides
 * a stub script shebanged at the exact `node` running this suite (`process.execPath`, never
 * `/bin/sh`), the same idiom `pr.test.ts` already uses at the unit level.
 */
function seed(): { config: string; work: string } {
  const config = mkdtempSync(join(tmpdir(), "pr-config-"));
  const work = mkdtempSync(join(tmpdir(), "pr-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"));
  }
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "add",
    "-A",
  ]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "seed",
  ]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([{ id: "h", displayName: "Stub", command: "true", args: [] }]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );
  return { config, work };
}

/** A stub `gh` that logs one line per invocation (path baked into the script's own source, no env
 * plumbing needed) and prints canned `pr view --json` output. */
function writeGhStub(dir: string, logPath: string, json: string): string {
  const path = join(dir, "gh-stub");
  const script =
    'const fs = require("node:fs");\n' +
    `fs.appendFileSync(${JSON.stringify(logPath)}, "call\\n");\n` +
    `process.stdout.write(${JSON.stringify(json)});\n`;
  writeFileSync(path, `#!${process.execPath}\n${script}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function open(
  config: string,
  ghBin?: string,
): Promise<{ app: ElectronApplication; w: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      ...(ghBin !== undefined ? { AIBUILDOS_GH_BIN: ghBin } : {}),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  // The PR chip is fetched only from the git view's own first render (RQ-0034#AC-3) — never before.
  await w.getByTestId("rail-tab-git").click();
  return { app, w };
}

test("gh absent: the chip stays quiet, telling the user to install it, and nothing reports an error", async () => {
  const { config } = seed();

  const { app, w } = await open(config, join(config, "no-such-gh-binary"));

  await expect(w.getByTestId("pr-gh-missing")).toBeVisible({ timeout: 10000 });
  await expect(w.getByTestId("pr-gh-missing")).toContainText("cli.github.com");
  await expect(w.getByTestId("pr-gh-missing")).toContainText("gh auth login");
  await expect(w.getByTestId("pr-chip")).toHaveCount(0);

  await app.close();
});

test("gh present: the chip shows the PR's number, state and checks, and never polls", async () => {
  // The stub below is a POSIX shebang script, the same constraint pr.test.ts's own stub carries.
  test.skip(process.platform === "win32", "no POSIX shebang on Windows");

  const { config } = seed();
  const logPath = join(config, "gh-calls.log");
  const json = JSON.stringify({
    url: "https://github.com/acme/repo/pull/123",
    state: "OPEN",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      { name: "build", conclusion: "SUCCESS" },
      { name: "test", conclusion: "FAILURE" },
    ],
  });
  const ghBin = writeGhStub(config, logPath, json);

  const { app, w } = await open(config, ghBin);

  // AC-1: number (read from the URL — `gh` was never asked for one) and state, both on the chip.
  const chip = w.getByTestId("pr-chip");
  await expect(chip).toBeVisible({ timeout: 10000 });
  await expect(chip).toContainText("PR #123");
  await expect(chip).toContainText("open");
  await expect(chip).toContainText("mergeable");
  await expect(chip).toContainText("approved");
  await expect(chip).toContainText("1 passing, 1 failing");
  await expect(chip).toContainText("https://github.com/acme/repo/pull/123");

  // AC-3: exactly one call so far — the git view's own first render, nothing more.
  await expect
    .poll(() => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length)
    .toBe(1);

  // The refresh control asks again, on demand.
  await w.getByTestId("pr-refresh").click();
  await expect
    .poll(() => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length)
    .toBe(2);

  // AC-3: idle time with nothing pressed adds no further calls — no polling loop exists.
  await w.waitForTimeout(3000);
  expect(readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length).toBe(2);

  await app.close();
});
