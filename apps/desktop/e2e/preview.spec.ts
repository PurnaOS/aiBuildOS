import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
import type { WebContentsView } from "electron";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0071. The preview renders beside a story's review in a real `WebContentsView`, and closing the
 * review kills the server behind it — through the running application, the way `checks.spec.ts`
 * proves the checks surface.
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "Notes get written"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — Notes get written

## Acceptance criteria

- [AC-1] A note lands in notes.md.
`;

const TC = `---
type: TestCase
id: TC-0001
title: "Notes get written, verified"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — Notes get written, verified

## Steps

1. Check notes.md changed.
`;

/** Seeded straight at `review` — this suite is about the preview surface, not the build walk. */
const ST = `---
type: Story
id: ST-0001
title: "Write a note"
state: review
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — Write a note

A scripted slice.

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;

/** A free TCP port: bind a throwaway server, close it, template the number in — the same trick
 * `previews.test.ts` uses, and the same small race every port-based fixture here accepts. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error("could not allocate a port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

/** One `run` fence: a trivial server that writes its own pid to `pid` (cwd is the project root, so
 * a relative path finds it — the same way the test later proves it is gone) and answers on `port`. */
function runPlaybook(execPath: string, port: number): string {
  return `---
type: Playbook
id: PB-0005
title: "Run it"
state: active
owner: Test Person
provenance: agent
created: 2026-08-20
generated: { by: "claude-code", at: 2026-08-20T00:00:00Z }
---

# PB-0005 — Run it

\`\`\`run
"${execPath}" -e "require('fs').writeFileSync('pid', String(process.pid)); require('http').createServer((q,s)=>s.end('ok')).listen(${port})"
http://localhost:${port}
\`\`\`
`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function open(
  options: { run?: boolean } = {},
): Promise<{ app: ElectronApplication; w: Page; work: string; port: number }> {
  const config = mkdtempSync(join(tmpdir(), "preview-config-"));
  const work = mkdtempSync(join(tmpdir(), "preview-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), ST);

  const rqIndex = join(work, "docs/requirements/README.md");
  writeFileSync(
    rqIndex,
    `${readFileSync(rqIndex, "utf8")}| [RQ-0001](rq-0001.md) | Notes get written | ready | — |\n`,
  );
  const tcIndex = join(work, "docs/testing/README.md");
  writeFileSync(
    tcIndex,
    `${readFileSync(tcIndex, "utf8")}| [TC-0001](tc-0001.md) | Notes get written, verified | draft | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  const stIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    stIndex,
    `${readFileSync(stIndex, "utf8")}| [ST-0001](st-0001.md) | Write a note | ready | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );

  // The template ships every playbook with an unresolved `{{OWNER}}` token — `fillProject` fills it
  // in normally, and this fixture skips that, so it is filled in by hand (same as `checks.spec.ts`).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  const port = await freePort();
  // A fifth playbook carries the `run` fence, deliberately apart from PB-0004's checks — RQ-0025's
  // declaration lives in any active playbook, not only one titled for it.
  if (options.run !== false) {
    writeFileSync(
      join(work, "docs", "playbooks", "pb-0005.md"),
      runPlaybook(process.execPath, port),
    );
  }

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=echo"],
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
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w, work, port };
}

async function openReview(w: Page): Promise<void> {
  // RQ-0045#AC-1, AC-3: Work is its own pinned surface now, not a nested strip view.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
}

/** Every `WebContentsView` on the window's content view, by the URL it has loaded — the same shape
 * the task's own guidance names: children count and their `webContents` URL, read from main. */
async function previewUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return (win?.contentView.children ?? [])
      .filter((view): view is WebContentsView => "webContents" in view)
      .map((view) => view.webContents.getURL());
  });
}

test("the preview renders beside the review, and closing the review stops it", async () => {
  const { app, w, work, port } = await open({ run: true });
  await openReview(w);

  const toggle = w.getByTestId("preview-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(w.getByTestId("preview-pane")).toBeVisible();
  await expect(toggle).toHaveText("Stop", { timeout: 20000 });

  // The view is real: it sits on the window's content view and has loaded the declared URL.
  await expect
    .poll(() => previewUrls(app), { timeout: 15000 })
    .toEqual(expect.arrayContaining([expect.stringContaining(`localhost:${port}`)]));

  const pid = Number(readFileSync(join(work, "pid"), "utf8"));
  expect(isAlive(pid)).toBe(true);

  await w.getByTestId("tab-close-review:ST-0001").click();

  expect(await waitUntilDead(pid)).toBe(true);

  await app.close();
});

test("a project with no run fence offers no Preview", async () => {
  const { app, w } = await open({ run: false });
  await openReview(w);

  await expect(w.getByTestId("preview-toggle")).toHaveCount(0);

  await app.close();
});
